// app.js — STL Vault file manager: libraries, tree, grid, list view, breadcrumbs,
// Finder/Explorer drag & drop, slicer integration, 3MF metadata, import from link, context menus, uploads.

import { attachHoverPreview, openModalViewer, renderThumbPng, saveThumb } from "/viewer3d.js";

const state = {
  activeLib: "default",
  libraries: [],
  path: "", // current folder, "" = library root
  tree: null,
  entries: { folders: [], files: [] },
  filter: "",
  viewMode: localStorage.getItem("stl_vault_view_mode") || "grid", // 'grid' or 'list'
  sortCol: "name", // 'name', 'kind', 'size', 'mtime'
  sortAsc: true,
  slicer: localStorage.getItem("stl_vault_slicer") || "orcaslicer",
  selectedItem: null,
};

const contentEl = document.getElementById("content");
const treeEl = document.getElementById("tree");
const libListEl = document.getElementById("libList");
const crumbsEl = document.getElementById("crumbs");
const ctxMenuEl = document.getElementById("ctxMenu");
const viewGridBtn = document.getElementById("viewGridBtn");
const viewListBtn = document.getElementById("viewListBtn");
const slicerSelect = document.getElementById("slicerSelect");

// IntersectionObserver for Lazy Loading Thumbnails
const thumbObserver = new IntersectionObserver(
  (entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target;
        observer.unobserve(el);
        const file = el._stlFile;
        const isRow = el._isRow;
        if (file) {
          if (isRow) fillRowThumbNow(el, file);
          else fillThumbNow(el, file);
        }
      }
    });
  },
  { root: contentEl, rootMargin: "200px 0px" }
);

const api = {
  libraries: () => fetch("/api/libraries").then((r) => r.json()),
  addLibrary: (name, path) => post("/api/libraries", { name, path }),
  deleteLibrary: (id) => fetch(`/api/libraries/${id}`, { method: "DELETE" }).then((r) => r.json()),
  tree: (lib) => fetch(`/api/tree?lib=${encodeURIComponent(lib)}`).then((r) => r.json()),
  files: (lib, path) => fetch(`/api/files?path=${encodeURIComponent(path)}&lib=${encodeURIComponent(lib)}`).then((r) => r.json()),
  mkdir: (lib, path, name) => post("/api/mkdir", { lib, path, name }),
  move: (fromLib, fromPath, toLib, toPath) => post("/api/move", { fromLib, from: fromPath, toLib, to: toPath }),
  rename: (lib, path, name) => post("/api/rename", { lib, path, name }),
  del: (lib, path) => post("/api/delete", { lib, path }),
};

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status}`);
    return data;
  });
}

function fmtSize(bytes) {
  if (!bytes) return "--";
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtDate(mtime) {
  if (!mtime) return "--";
  const d = new Date(mtime);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
         " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* ------------------------------------------------------------- slicer bridge */

function getSlicerName(key) {
  const names = {
    orcaslicer: "OrcaSlicer",
    anycubic: "Anycubic Next",
    elegoo: "Elegoo Slicer",
    prusaslicer: "PrusaSlicer",
    bambustudio: "Bambu Studio",
  };
  return names[key] || "Slicer";
}

function openInSlicer(file, libId = state.activeLib) {
  const fileUrl = `${window.location.protocol}//${window.location.host}/api/file?path=${encodeURIComponent(file.path)}&lib=${encodeURIComponent(libId)}`;
  let uri = "";
  switch (state.slicer) {
    case "orcaslicer":
      uri = `orcaslicer://open?file=${encodeURIComponent(fileUrl)}`;
      break;
    case "anycubic":
      uri = `anycubicslicernext://open?file=${encodeURIComponent(fileUrl)}`;
      break;
    case "elegoo":
      uri = `elegooslicer://open?file=${encodeURIComponent(fileUrl)}`;
      break;
    case "prusaslicer":
      uri = `prusaslicer://open?file=${encodeURIComponent(fileUrl)}`;
      break;
    case "bambustudio":
      uri = `bambustudio://open?file=${encodeURIComponent(fileUrl)}`;
      break;
    default:
      uri = fileUrl;
  }
  window.location.href = uri;
}

window.stlVaultOpenInSlicer = openInSlicer;

if (slicerSelect) {
  slicerSelect.value = state.slicer;
  slicerSelect.addEventListener("change", (e) => {
    state.slicer = e.target.value;
    localStorage.setItem("stl_vault_slicer", state.slicer);
    renderContent();
  });
}

document.getElementById("importLinkBtn").addEventListener("click", async () => {
  const url = prompt("Paste model link (MakerWorld, Printables, or Thingiverse):");
  if (!url) return;
  try {
    const res = await post("/api/import-link", { url, lib: state.activeLib, path: state.path });
    alert(`Imported ${res.count || 0} model file(s) into folder “${res.folder}”!`);
    refresh();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

/* ------------------------------------------------------------------ boot */

async function refresh() {
  state.libraries = await api.libraries();
  if (!state.libraries.some((l) => l.id === state.activeLib)) {
    state.activeLib = state.libraries[0]?.id || "default";
  }
  state.tree = await api.tree(state.activeLib);
  try {
    state.entries = await api.files(state.activeLib, state.path);
  } catch (err) {
    state.path = "";
    state.entries = await api.files(state.activeLib, "");
  }
  renderLibraries();
  renderTree();
  renderCrumbs();
  renderViewToggle();
  renderContent();
}

function navigate(path) {
  state.path = path;
  state.selectedItem = null;
  refresh().catch((e) => alert(e.message));
}

function switchLibrary(libId) {
  state.activeLib = libId;
  state.path = "";
  state.selectedItem = null;
  refresh().catch((e) => alert(e.message));
}

function renderViewToggle() {
  if (state.viewMode === "grid") {
    viewGridBtn.classList.add("active");
    viewListBtn.classList.remove("active");
  } else {
    viewListBtn.classList.add("active");
    viewGridBtn.classList.remove("active");
  }
}

viewGridBtn.addEventListener("click", () => {
  state.viewMode = "grid";
  localStorage.setItem("stl_vault_view_mode", "grid");
  renderViewToggle();
  renderContent();
});

viewListBtn.addEventListener("click", () => {
  state.viewMode = "list";
  localStorage.setItem("stl_vault_view_mode", "list");
  renderViewToggle();
  renderContent();
});

/* -------------------------------------------------------------- libraries */

function renderLibraries() {
  libListEl.innerHTML = "";
  state.libraries.forEach((lib) => {
    const btn = document.createElement("button");
    btn.className = "lib-item" + (lib.id === state.activeLib ? " active" : "");
    btn.innerHTML = `<span>📚 ${lib.name}</span>`;
    btn.addEventListener("click", () => switchLibrary(lib.id));
    makeDropTarget(btn, lib.id, "");
    libListEl.appendChild(btn);
  });
}

document.getElementById("addLibBtn").addEventListener("click", async () => {
  const name = prompt("Library name (e.g. Archive):");
  if (!name) return;
  const path = prompt("Library directory path on server (e.g. /mnt/storage/archive):");
  if (!path) return;
  try {
    const newLib = await api.addLibrary(name, path);
    switchLibrary(newLib.id);
  } catch (err) {
    alert(err.message);
  }
});

/* ------------------------------------------------------------------ tree */

function renderTree() {
  treeEl.innerHTML = "";
  if (!state.tree) return;
  treeEl.appendChild(renderTreeNode(state.tree, true));
}

function renderTreeNode(node, isRoot = false) {
  const wrap = document.createElement("div");
  const btn = document.createElement("button");
  btn.className = "tree-item" + (node.path === state.path || (isRoot && state.path === "") ? " current" : "");
  btn.innerHTML = `<span class="tw">${node.children?.length ? "▸" : ""}</span><span>${isRoot ? "🗄" : "📁"}</span><span>${isRoot ? (getCurLib()?.name || "Library") : node.name}</span>`;
  btn.addEventListener("click", () => {
    const kids = wrap.querySelector(".tree-kids");
    if (kids && node.path === state.path) kids.classList.toggle("open");
    navigate(isRoot ? "" : node.path);
  });
  makeDropTarget(btn, state.activeLib, isRoot ? "" : node.path);
  if (!isRoot) {
    attachContextMenu(btn, node, true);
  }
  wrap.appendChild(btn);

  if (node.children?.length) {
    const kids = document.createElement("div");
    kids.className = "tree-kids open";
    node.children.forEach((c) => kids.appendChild(renderTreeNode(c)));
    wrap.appendChild(kids);
  }
  return wrap;
}

function getCurLib() {
  return state.libraries.find((l) => l.id === state.activeLib);
}

/* -------------------------------------------------------------- breadcrumbs */

function renderCrumbs() {
  crumbsEl.innerHTML = "";
  const parts = state.path ? state.path.split("/") : [];
  const curLib = getCurLib();
  const rootBtn = document.createElement("button");
  rootBtn.innerHTML = `<span>🗄</span><span>${curLib ? curLib.name : "Library"}</span>`;
  rootBtn.addEventListener("click", () => navigate(""));
  makeDropTarget(rootBtn, state.activeLib, "");
  crumbsEl.appendChild(rootBtn);

  parts.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    crumbsEl.appendChild(sep);

    const b = document.createElement("button");
    const targetPath = parts.slice(0, i + 1).join("/");
    b.textContent = part;
    b.addEventListener("click", () => navigate(targetPath));
    makeDropTarget(b, state.activeLib, targetPath);
    crumbsEl.appendChild(b);
  });
}

/* ---------------------------------------------------------------- content */

function renderContent() {
  contentEl.innerHTML = "";
  const q = state.filter.toLowerCase();

  let folders = state.entries.folders.filter((f) => !q || f.name.toLowerCase().includes(q));
  let files = state.entries.files.filter((f) => !q || f.name.toLowerCase().includes(q));

  // Sort
  const sc = state.sortCol;
  const asc = state.sortAsc ? 1 : -1;
  const cmp = (a, b, key) => {
    let va = a[key] ?? "";
    let vb = b[key] ?? "";
    if (typeof va === "string") return va.localeCompare(vb) * asc;
    return (va > vb ? 1 : va < vb ? -1 : 0) * asc;
  };

  folders.sort((a, b) => cmp(a, b, sc === "kind" || sc === "size" ? "name" : sc));
  files.sort((a, b) => cmp(a, b, sc));

  if (!folders.length && !files.length) {
    contentEl.innerHTML = `<div class="empty">${q ? "nothing matches the filter" : "empty folder<br>drag .stl or .3mf files / folders anywhere to upload"}</div>`;
    return;
  }

  if (state.viewMode === "grid") {
    const gridDiv = document.createElement("div");
    gridDiv.className = "grid";
    gridDiv.id = "grid";
    folders.forEach((f) => gridDiv.appendChild(renderFolderCard(f)));
    files.forEach((f) => gridDiv.appendChild(renderModelCard(f)));
    contentEl.appendChild(gridDiv);
  } else {
    contentEl.appendChild(renderListView(folders, files));
  }

  makeDropTarget(contentEl, state.activeLib, state.path);
}

function cardActions(entry, isFolder) {
  const box = document.createElement("div");
  box.className = "cactions";

  if (!isFolder) {
    const sliceBtn = document.createElement("button");
    sliceBtn.className = "slice-btn";
    sliceBtn.textContent = "🍰";
    sliceBtn.title = `Open in ${getSlicerName(state.slicer)}`;
    sliceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openInSlicer(entry, state.activeLib);
    });
    box.appendChild(sliceBtn);
  }

  const rn = document.createElement("button");
  rn.textContent = "✏️";
  rn.title = "rename";
  rn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = prompt(`Rename “${entry.name}” to:`, entry.name);
    if (!name || name === entry.name) return;
    await api.rename(state.activeLib, entry.path, name);
    refresh();
  });

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "🗑";
  del.title = "move to trash";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Move “${entry.name}” to trash?`)) return;
    await api.del(state.activeLib, entry.path);
    refresh();
  });

  box.append(rn, del);
  return box;
}

/* ------------------------------------------------------------- icon grid */

function renderFolderCard(folder) {
  const el = document.createElement("div");
  el.className = "card" + (state.selectedItem?.path === folder.path ? " selected" : "");
  el.innerHTML = `<div class="thumb"><span class="big-ico">📁</span></div>
    <div class="cname" title="${folder.name}">${folder.name}</div>
    <div class="cmeta">folder</div>`;
  el.appendChild(cardActions(folder, true));

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectItem(folder, el);
  });
  el.addEventListener("dblclick", () => navigate(folder.path));

  makeDraggable(el, folder, true);
  makeDropTarget(el, state.activeLib, folder.path);
  attachContextMenu(el, folder, true);
  return el;
}

function renderModelCard(file) {
  const el = document.createElement("div");
  el.className = "card" + (state.selectedItem?.path === file.path ? " selected" : "");
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  el.appendChild(thumb);
  const badge = file.kind === "3mf" ? " <span style='color:var(--teal)'>[3MF]</span>" : "";

  let slicerBadge = "";
  if (file.slicerMeta) {
    const parts = [];
    if (file.slicerMeta.printerModel) parts.push(file.slicerMeta.printerModel);
    if (file.slicerMeta.nozzle) parts.push(`${file.slicerMeta.nozzle}mm`);
    if (file.slicerMeta.filamentType) parts.push(file.slicerMeta.filamentType);
    if (parts.length) {
      slicerBadge = `<div style="font-family:var(--mono);font-size:8px;color:var(--teal);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px" title="${parts.join(' · ')}">🖨 ${parts.join(' · ')}</div>`;
    }
  }

  el.insertAdjacentHTML(
    "beforeend",
    `<div class="cname" title="${file.name}">${file.name}</div><div class="cmeta">${fmtSize(file.size)}${badge}</div>${slicerBadge}`
  );
  el.appendChild(cardActions(file, false));

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectItem(file, el);
  });
  el.addEventListener("dblclick", () => openModalViewer(file, state.activeLib));

  attachHoverPreview(el, file, state.activeLib);
  makeDraggable(el, file, false);
  attachContextMenu(el, file, false);

  // Lazy Thumbnail Observer
  thumb._stlFile = file;
  thumb._isRow = false;
  thumbObserver.observe(thumb);
  return el;
}

/* ------------------------------------------------------------- list view */

function renderListView(folders, files) {
  const table = document.createElement("table");
  table.className = "list-view";

  const thead = document.createElement("thead");
  const headers = [
    { key: "name", label: "Name" },
    { key: "kind", label: "Kind" },
    { key: "size", label: "Size" },
    { key: "mtime", label: "Date Modified" },
  ];

  let headerHTML = "<tr>";
  headers.forEach((h) => {
    const isCur = state.sortCol === h.key;
    const sortIco = isCur ? (state.sortAsc ? " ▲" : " ▼") : "";
    headerHTML += `<th data-col="${h.key}">${h.label}<span class="sort-ico">${sortIco}</span></th>`;
  });
  headerHTML += "<th style='width:90px'></th></tr>";
  thead.innerHTML = headerHTML;

  thead.querySelectorAll("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.getAttribute("data-col");
      if (state.sortCol === col) state.sortAsc = !state.sortAsc;
      else {
        state.sortCol = col;
        state.sortAsc = true;
      }
      renderContent();
    });
  });

  const tbody = document.createElement("tbody");

  folders.forEach((folder) => {
    const tr = document.createElement("tr");
    tr.className = "list-row" + (state.selectedItem?.path === folder.path ? " selected" : "");
    tr.innerHTML = `
      <td class="name-col">
        <div class="row-ico"><span>📁</span></div>
        <span title="${folder.name}">${folder.name}</span>
      </td>
      <td>Folder</td>
      <td>--</td>
      <td>${fmtDate(folder.mtime)}</td>
      <td>
        <div class="row-actions"></div>
      </td>
    `;
    tr.querySelector(".row-actions").appendChild(cardActions(folder, true));

    tr.addEventListener("click", (e) => {
      e.stopPropagation();
      selectItem(folder, tr);
    });
    tr.addEventListener("dblclick", () => navigate(folder.path));

    makeDraggable(tr, folder, true);
    makeDropTarget(tr, state.activeLib, folder.path);
    attachContextMenu(tr, folder, true);
    tbody.appendChild(tr);
  });

  files.forEach((file) => {
    const tr = document.createElement("tr");
    tr.className = "list-row" + (state.selectedItem?.path === file.path ? " selected" : "");
    let kindLabel = file.kind === "3mf" ? "3MF Model" : "STL Model";
    if (file.slicerMeta && file.slicerMeta.printerModel) {
      kindLabel += ` (${file.slicerMeta.printerModel})`;
    }
    const icoBox = document.createElement("div");
    icoBox.className = "row-ico";

    tr.innerHTML = `
      <td class="name-col">
        <span class="row-ico-cell"></span>
        <span title="${file.name}">${file.name}</span>
      </td>
      <td>${kindLabel}</td>
      <td>${fmtSize(file.size)}</td>
      <td>${fmtDate(file.mtime)}</td>
      <td>
        <div class="row-actions"></div>
      </td>
    `;

    tr.querySelector(".row-ico-cell").replaceWith(icoBox);
    tr.querySelector(".row-actions").appendChild(cardActions(file, false));

    tr.addEventListener("click", (e) => {
      e.stopPropagation();
      selectItem(file, tr);
    });
    tr.addEventListener("dblclick", () => openModalViewer(file, state.activeLib));

    attachHoverPreview(tr, file, state.activeLib);
    makeDraggable(tr, file, false);
    attachContextMenu(tr, file, false);

    // Lazy Thumbnail Observer
    icoBox._stlFile = file;
    icoBox._isRow = true;
    thumbObserver.observe(icoBox);
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  return table;
}

function fillRowThumbNow(host, file) {
  if (file.thumb) {
    const img = document.createElement("img");
    img.src = `/api/thumb?path=${encodeURIComponent(file.path)}&lib=${encodeURIComponent(state.activeLib)}`;
    img.alt = file.name;
    img.onerror = () => {
      file.thumb = false;
      host.innerHTML = "<span>📄</span>";
    };
    host.appendChild(img);
    return;
  }
  host.innerHTML = "<span>📄</span>";
}

function fillThumbNow(host, file) {
  if (file.thumb) {
    const img = document.createElement("img");
    img.src = `/api/thumb?path=${encodeURIComponent(file.path)}&lib=${encodeURIComponent(state.activeLib)}`;
    img.alt = file.name;
    img.onerror = () => {
      file.thumb = false;
      host.innerHTML = "";
      fillThumbNow(host, file);
    };
    host.appendChild(img);
    return;
  }

  if (file.size && file.size > 30 * 1024 * 1024) {
    const badge = document.createElement("div");
    badge.className = "rendering";
    badge.style.animation = "none";
    badge.style.color = "var(--ink-dim)";
    badge.textContent = file.kind === "3mf" ? "📦 [3MF]" : "📦 [STL]";
    host.appendChild(badge);
    return;
  }

  const shimmer = document.createElement("div");
  shimmer.className = "rendering";
  shimmer.textContent = "RENDERING…";
  host.appendChild(shimmer);
  thumbQueue.push({ host, file, libId: state.activeLib, shimmer });
  pumpThumbQueue();
}

function selectItem(item, el) {
  document.querySelectorAll(".card.selected, .list-row.selected").forEach((e) => e.classList.remove("selected"));
  state.selectedItem = item;
  el.classList.add("selected");
}

/* ------------------------------------------------------------- drag & drop */

function makeDraggable(el, item, isFolder) {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(
      "application/x-stl-item",
      JSON.stringify({ lib: state.activeLib, path: item.path, name: item.name, isFolder })
    );
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
}

function makeDropTarget(el, targetLibId, targetFolderPath) {
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-stl-item")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drop-target");
    const raw = e.dataTransfer.getData("application/x-stl-item");
    if (!raw) return;
    const item = JSON.parse(raw);
    if (item.lib === targetLibId && item.path === targetFolderPath) return;
    try {
      await api.move(item.lib, item.path, targetLibId, targetFolderPath);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* -------------------------------------------------------- OS file/folder uploads */

const dropzone = document.getElementById("dropzone");
let dzDepth = 0;

window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dzDepth += 1;
  dropzone.classList.add("show");
});

window.addEventListener("dragleave", () => {
  dzDepth = Math.max(0, dzDepth - 1);
  if (dzDepth === 0) dropzone.classList.remove("show");
});

window.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
});

window.addEventListener("drop", async (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dzDepth = 0;
  dropzone.classList.remove("show");

  const items = e.dataTransfer.items;
  if (items && items.length) {
    const fileEntries = [];
    const queue = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) queue.push({ entry, relPath: "" });
    }

    if (queue.length > 0) {
      while (queue.length > 0) {
        const { entry, relPath } = queue.shift();
        if (entry.isFile) {
          if (/\.(stl|3mf)$/i.test(entry.name)) {
            const file = await getFileFromEntry(entry);
            if (file) fileEntries.push({ file, relPath });
          }
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const entries = await readAllDirectoryEntries(dirReader);
          const subRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          entries.forEach((child) => queue.push({ entry: child, relPath: subRel }));
        }
      }
      if (fileEntries.length) {
        await uploadFileEntries(fileEntries);
        return;
      }
    }
  }

  // Fallback for standard files
  const files = [...e.dataTransfer.files].filter((f) => /\.(stl|3mf)$/i.test(f.name));
  if (files.length) {
    await uploadFiles(files);
  }
});

function getFileFromEntry(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readAllDirectoryEntries(dirReader) {
  const entries = [];
  return new Promise((resolve) => {
    function read() {
      dirReader.readEntries((results) => {
        if (!results.length) resolve(entries);
        else {
          entries.push(...results);
          read();
        }
      }, () => resolve(entries));
    }
    read();
  });
}

async function uploadFileEntries(fileEntries) {
  const grouped = {};
  fileEntries.forEach(({ file, relPath }) => {
    const targetPath = state.path ? (relPath ? `${state.path}/${relPath}` : state.path) : relPath;
    if (!grouped[targetPath]) grouped[targetPath] = [];
    grouped[targetPath].push(file);
  });

  for (const [targetPath, files] of Object.entries(grouped)) {
    if (targetPath) {
      const parts = targetPath.split("/");
      let curr = "";
      for (const part of parts) {
        if (!part) continue;
        const parent = curr;
        curr = curr ? `${curr}/${part}` : part;
        try {
          await api.mkdir(state.activeLib, parent, part);
        } catch { /* folder might already exist */ }
      }
    }

    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    await fetch(`/api/upload?path=${encodeURIComponent(targetPath)}&lib=${encodeURIComponent(state.activeLib)}`, {
      method: "POST",
      body: form,
    });
  }
  refresh();
}

async function uploadFiles(files) {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  await fetch(`/api/upload?path=${encodeURIComponent(state.path)}&lib=${encodeURIComponent(state.activeLib)}`, {
    method: "POST",
    body: form,
  });
  refresh();
}

document.getElementById("uploadBtn").addEventListener("click", () => document.getElementById("uploadInput").click());
document.getElementById("uploadInput").addEventListener("change", async (e) => {
  if (e.target.files.length) await uploadFiles([...e.target.files]);
  e.target.value = "";
});

/* -------------------------------------------------------- context menu */

function attachContextMenu(targetEl, entry, isFolder = false) {
  targetEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, entry, isFolder);
  });
}

function hideContextMenu() {
  ctxMenuEl.classList.remove("show");
  ctxMenuEl.innerHTML = "";
}

window.addEventListener("click", hideContextMenu);
window.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});

function showContextMenu(x, y, entry, isFolder) {
  hideContextMenu();
  ctxMenuEl.innerHTML = "";

  const title = document.createElement("div");
  title.style.cssText =
    "padding:4px 8px;font-weight:600;color:var(--accent);font-size:10px;border-bottom:1px solid var(--hairline);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  title.textContent = `${isFolder ? "📁" : "📄"} ${entry.name}`;
  ctxMenuEl.appendChild(title);

  if (!isFolder) {
    const openSlicerItem = document.createElement("div");
    openSlicerItem.className = "ctx-item";
    openSlicerItem.innerHTML = `<span>🍰 Open in ${getSlicerName(state.slicer)}</span>`;
    openSlicerItem.addEventListener("click", () => {
      hideContextMenu();
      openInSlicer(entry, state.activeLib);
    });
    ctxMenuEl.appendChild(openSlicerItem);
  }

  const renameItem = document.createElement("div");
  renameItem.className = "ctx-item";
  renameItem.innerHTML = `<span>✏️ Rename</span>`;
  renameItem.addEventListener("click", async () => {
    hideContextMenu();
    const name = prompt(`Rename “${entry.name}” to:`, entry.name);
    if (!name || name === entry.name) return;
    await api.rename(state.activeLib, entry.path, name);
    refresh();
  });
  ctxMenuEl.appendChild(renameItem);

  const moveLibItem = document.createElement("div");
  moveLibItem.className = "ctx-item";

  const otherLibs = state.libraries.filter((l) => l.id !== state.activeLib);
  if (otherLibs.length > 0) {
    moveLibItem.innerHTML = `<span>🚚 Move to Library</span><span>▸</span>`;
    const subMenu = document.createElement("div");
    subMenu.className = "ctx-sub";
    otherLibs.forEach((lib) => {
      const targetLibItem = document.createElement("div");
      targetLibItem.className = "ctx-item";
      targetLibItem.innerHTML = `<span>📚 ${lib.name}</span>`;
      targetLibItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        hideContextMenu();
        try {
          await api.move(state.activeLib, entry.path, lib.id, "");
          refresh();
        } catch (err) {
          alert(err.message);
        }
      });
      subMenu.appendChild(targetLibItem);
    });
    moveLibItem.appendChild(subMenu);
  } else {
    moveLibItem.innerHTML = `<span style="color:var(--ink-faint)">🚚 Move to Library (none)</span>`;
    moveLibItem.style.cursor = "default";
  }
  ctxMenuEl.appendChild(moveLibItem);

  const delItem = document.createElement("div");
  delItem.className = "ctx-item del";
  delItem.innerHTML = `<span>🗑 Move to Trash</span>`;
  delItem.addEventListener("click", async () => {
    hideContextMenu();
    if (!confirm(`Move “${entry.name}” to trash?`)) return;
    await api.del(state.activeLib, entry.path);
    refresh();
  });
  ctxMenuEl.appendChild(delItem);

  ctxMenuEl.style.display = "flex";
  const bounds = ctxMenuEl.getBoundingClientRect();
  let posX = Math.min(x, window.innerWidth - bounds.width - 10);
  let posY = Math.min(y, window.innerHeight - bounds.height - 10);
  ctxMenuEl.style.left = `${Math.max(5, posX)}px`;
  ctxMenuEl.style.top = `${Math.max(5, posY)}px`;
  ctxMenuEl.classList.add("show");
}

/* -------------------------------------------------- thumbnails (cached) */

const thumbQueue = [];
let thumbActive = 0;

async function pumpThumbQueue() {
  if (thumbActive >= 1) return;
  const job = thumbQueue.shift();
  if (!job) return;
  thumbActive += 1;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), 6000)
  );

  try {
    const png = await Promise.race([renderThumbPng(job.file.path, job.libId), timeoutPromise]);
    const img = document.createElement("img");
    img.src = png;
    img.alt = job.file.name;
    img.onerror = () => {
      job.host.innerHTML = `<div class="rendering" style="color:var(--fail)">⚠️ image error</div>`;
    };
    job.shimmer.remove();
    job.host.appendChild(img);
    saveThumb(job.file.path, job.libId, png);
  } catch {
    if (job.shimmer) {
      job.shimmer.style.animation = "none";
      job.shimmer.style.color = "var(--ink-faint)";
      job.shimmer.textContent = job.file.kind === "3mf" ? "📦 [3MF]" : "📦 [STL]";
    }
  } finally {
    thumbActive -= 1;
    pumpThumbQueue();
  }
}

/* ------------------------------------------------------------------ misc */

document.getElementById("newFolderBtn").addEventListener("click", async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    await api.mkdir(state.activeLib, state.path, name);
    refresh();
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById("search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderContent();
});

refresh().catch((e) => alert(e.message));
