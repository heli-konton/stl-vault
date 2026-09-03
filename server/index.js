// STL Vault — self-hosted 3D model manager (STL & 3MF).
// Filesystem-backed: folders on disk are folders in the UI. No database.

const express = require("express");
const compression = require("compression");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const PORT = process.env.PORT || 4173;
const LIBRARIES_FILE = path.join(__dirname, "..", "libraries.json");

function loadLibraries() {
  const defaultRoot = path.resolve(process.env.STLS_ROOT || path.join(__dirname, "..", "stls"));
  let list = [{ id: "default", name: "Main Library", path: defaultRoot }];
  if (!process.env.STLS_ROOT && fs.existsSync(LIBRARIES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LIBRARIES_FILE, "utf8"));
      if (Array.isArray(data) && data.length > 0) list = data;
    } catch {}
  }
  for (const lib of list) {
    const root = path.resolve(lib.path);
    const thumbs = path.join(root, ".thumbs");
    const trash = path.join(root, ".trash");
    for (const d of [root, thumbs, trash]) fs.mkdirSync(d, { recursive: true });
  }
  return list;
}

function saveLibraries(list) {
  fs.writeFileSync(LIBRARIES_FILE, JSON.stringify(list, null, 2));
}

function getLib(libId) {
  const libs = loadLibraries();
  return libs.find((l) => l.id === libId) || libs[0];
}

function safeRel(rel, libId) {
  const lib = getLib(libId);
  const root = path.resolve(lib.path);
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return { abs, root, rel: path.relative(root, abs).split(path.sep).join("/"), lib };
}

const isHidden = (name) => name.startsWith(".");
const is3DFile = (name) => /\.(stl|3mf)$/i.test(name);

function folderEntry(abs, root, withPreview = false) {
  const st = fs.statSync(abs);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const entry = {
    kind: "folder",
    name: path.basename(abs),
    path: rel,
    mtime: st.mtimeMs,
  };
  if (withPreview) entry.preview = findFolderPreview(abs, root);
  return entry;
}

function findFolderPreview(abs, root) {
  const queue = [{ abs, depth: 0 }];
  let inspected = 0;

  while (queue.length && inspected < 160) {
    const cur = queue.shift();
    let names = [];
    try {
      names = fs.readdirSync(cur.abs).filter((name) => !isHidden(name)).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }

    for (const name of names) {
      if (!/\.3mf$/i.test(name)) continue;
      const child = path.join(cur.abs, name);
      inspected++;
      try {
        if (fs.statSync(child).isFile()) return fileEntry(child, root);
      } catch { /* skip unreadable preview candidates */ }
    }

    if (cur.depth >= 3) continue;
    for (const name of names) {
      const child = path.join(cur.abs, name);
      inspected++;
      try {
        if (fs.statSync(child).isDirectory()) queue.push({ abs: child, depth: cur.depth + 1 });
      } catch { /* skip unreadable preview candidates */ }
    }
  }

  return null;
}

function hasThumb(tp) {
  try {
    return fs.existsSync(tp) && fs.statSync(tp).size > 100;
  } catch {
    return false;
  }
}

function thumbKey(rel, size, mtime) {
  // NAS/FUSE mounts can report jittery sub-ms mtimes. Seconds are stable
  // enough for thumbnail invalidation and prevent cache misses on revisits.
  const mtimeSeconds = Math.floor(Number(mtime || 0) / 1000);
  return crypto.createHash("sha1").update(`${rel}:${size}:${mtimeSeconds}`).digest("hex");
}

function legacyThumbKey(rel, size, mtime) {
  return crypto.createHash("sha1").update(`${rel}:${size}:${Math.round(mtime)}`).digest("hex");
}

function thumbPath(root, rel, size, mtime) {
  return path.join(root, ".thumbs", `${thumbKey(rel, size, mtime)}.png`);
}

function legacyThumbPath(root, rel, size, mtime) {
  return path.join(root, ".thumbs", `${legacyThumbKey(rel, size, mtime)}.png`);
}

function existingThumbPath(root, rel, size, mtime) {
  const current = thumbPath(root, rel, size, mtime);
  if (hasThumb(current)) return current;
  const legacy = legacyThumbPath(root, rel, size, mtime);
  if (hasThumb(legacy)) return legacy;
  return current;
}

function inspect3MF(abs, tp) {
  let slicerMeta = null;
  try {
    const zip = new AdmZip(abs);
    const entries = zip.getEntries();

    if (!hasThumb(tp)) {
      let thumbEntry = entries.find((e) =>
        e.entryName.startsWith("Auxiliaries/.thumbnails/") ||
        e.entryName.startsWith("Metadata/plate_") ||
        e.entryName === "Metadata/thumbnail.png"
      );
      if (!thumbEntry) {
        thumbEntry = entries.find((e) => e.entryName.endsWith(".png") || e.entryName.endsWith(".jpg"));
      }
      if (thumbEntry) {
        fs.writeFileSync(tp, thumbEntry.getData());
      }
    }

    const configEntry = entries.find((e) =>
      e.entryName === "Metadata/project_settings.config" ||
      e.entryName === "Metadata/slice_info.config"
    );
    if (configEntry) {
      const text = configEntry.getData().toString("utf8");
      if (text.startsWith("{")) {
        const json = JSON.parse(text);
        slicerMeta = {
          layerHeight: json.layer_height ? parseFloat(json.layer_height) : null,
          nozzle: Array.isArray(json.nozzle_diameter) ? json.nozzle_diameter[0] : json.nozzle_diameter,
          filamentType: Array.isArray(json.filament_type) ? [...new Set(json.filament_type)].join("/") : json.filament_type,
          printerModel: json.printer_model || null,
        };
      }
    }
  } catch { /* skip corrupted 3mf inspection */ }
  return slicerMeta;
}

function fileEntry(abs, root) {
  const st = fs.statSync(abs);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const tp = existingThumbPath(root, rel, st.size, st.mtimeMs);
  const ext = path.extname(abs).toLowerCase().replace(".", "");

  let slicerMeta = null;
  if (ext === "3mf") {
    slicerMeta = inspect3MF(abs, tp);
  }

  return {
    kind: ext === "3mf" ? "3mf" : "stl",
    name: path.basename(abs),
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    thumb: hasThumb(tp),
    slicerMeta,
  };
}

function listDir(abs, root) {
  const out = { folders: [], files: [] };
  for (const name of fs.readdirSync(abs)) {
    if (isHidden(name)) continue;
    const child = path.join(abs, name);
    let st;
    try {
      st = fs.statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.folders.push(folderEntry(child, root, true));
    else if (is3DFile(name)) out.files.push(fileEntry(child, root));
  }
  out.folders.sort((a, b) => a.name.localeCompare(b.name));
  out.files.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const app = express();
app.use(compression());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "..", "client")));
app.use("/vendor/three", express.static(path.join(__dirname, "..", "node_modules", "three"), { maxAge: "7d" }));

// -- Libraries API -----------------------------------------------------------

app.get("/api/libraries", (req, res) => {
  res.json(loadLibraries());
});

app.post("/api/libraries", (req, res) => {
  const name = String(req.body.name || "").trim();
  const libPath = String(req.body.path || "").trim();
  if (!name || !libPath) return res.status(400).json({ error: "Name and path required" });
  const absPath = path.resolve(libPath);
  for (const d of [absPath, path.join(absPath, ".thumbs"), path.join(absPath, ".trash")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const libs = loadLibraries();
  const id = "lib-" + crypto.randomBytes(4).toString("hex");
  const newLib = { id, name, path: absPath };
  libs.push(newLib);
  saveLibraries(libs);
  res.json(newLib);
});

app.delete("/api/libraries/:id", (req, res) => {
  const libs = loadLibraries();
  if (libs.length <= 1) return res.status(400).json({ error: "Cannot remove the primary library" });
  const filtered = libs.filter((l) => l.id !== req.params.id);
  saveLibraries(filtered);
  res.json({ ok: true });
});

// -- Model API ---------------------------------------------------------------

app.get("/api/tree", (req, res) => {
  const lib = getLib(req.query.lib);
  const root = path.resolve(lib.path);
  function walk(abs, depth) {
    if (depth > 8) return null;
    const node = folderEntry(abs, root);
    node.children = [];
    for (const name of fs.readdirSync(abs)) {
      if (isHidden(name)) continue;
      const child = path.join(abs, name);
      try {
        if (fs.statSync(child).isDirectory()) {
          const sub = walk(child, depth + 1);
          if (sub) node.children.push(sub);
        }
      } catch { /* skip */ }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    return node;
  }
  const tree = walk(root, 0);
  if (tree) tree.name = lib.name;
  res.json(tree);
});

app.get("/api/files", (req, res) => {
  const info = safeRel(req.query.path || "", req.query.lib);
  if (!info || !fs.existsSync(info.abs) || !fs.statSync(info.abs).isDirectory()) {
    return res.status(400).json({ error: "not a folder" });
  }
  res.json(listDir(info.abs, info.root));
});

app.get("/api/file", (req, res) => {
  const info = safeRel(req.query.path || "", req.query.lib);
  if (!info || !fs.existsSync(info.abs) || !is3DFile(info.abs)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(info.abs);
});

app.get("/api/thumb", (req, res) => {
  const info = safeRel(req.query.path || "", req.query.lib);
  if (!info || !fs.existsSync(info.abs)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).end();
  }
  const st = fs.statSync(info.abs);
  const tp = existingThumbPath(info.root, info.rel, st.size, st.mtimeMs);
  if (!hasThumb(tp)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).end();
  }
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.sendFile(tp, { dotfiles: "allow" });
});

app.post("/api/thumb", (req, res) => {
  const info = safeRel(req.body.path || "", req.body.lib);
  const dataUrl = String(req.body.png || "");
  if (!info || !fs.existsSync(info.abs)) return res.status(400).json({ error: "bad path" });
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "bad png" });
  const st = fs.statSync(info.abs);
  fs.writeFileSync(thumbPath(info.root, info.rel, st.size, st.mtimeMs), Buffer.from(m[1], "base64"));
  res.json({ ok: true });
});

// -- Import from Link API ----------------------------------------------------

app.post("/api/import-link", async (req, res) => {
  const info = safeRel(req.body.path || "", req.body.lib);
  const inputUrl = String(req.body.url || "").trim();
  if (!info || !inputUrl) return res.status(400).json({ error: "URL required" });

  let downloadUrl = "";
  let folderName = "";

  if (inputUrl.includes("thingiverse.com/thing:")) {
    const thingId = inputUrl.split("thing:")[1].split("/")[0].split("?")[0];
    folderName = `Thingiverse_Thing_${thingId}`;
    downloadUrl = `https://www.thingiverse.com/thing:${thingId}/zip`;
  } else if (inputUrl.includes("printables.com/model/")) {
    const modelId = inputUrl.split("model/")[1].split("-")[0].split("/")[0];
    folderName = `Printables_Model_${modelId}`;
    downloadUrl = `https://www.printables.com/model/${modelId}/download`;
  } else if (inputUrl.includes("makerworld.com")) {
    const parts = inputUrl.split("/models/");
    const modelId = parts[1] ? parts[1].split("#")[0].split("?")[0].split("/")[0] : "model";
    folderName = `MakerWorld_Model_${modelId}`;
    downloadUrl = inputUrl;
  } else {
    folderName = `Import_${Date.now()}`;
    downloadUrl = inputUrl;
  }

  const targetFolder = path.join(info.abs, folderName);
  fs.mkdirSync(targetFolder, { recursive: true });

  try {
    const response = await fetch(downloadUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from model site`);
    const buffer = Buffer.from(await response.arrayBuffer());

    let importedCount = 0;
    if (downloadUrl.endsWith(".zip") || buffer.slice(0, 4).toString("hex") === "504b0304") {
      const zip = new AdmZip(buffer);
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory && is3DFile(entry.entryName)) {
          const fileName = path.basename(entry.entryName).replace(/[^\w.\- ]+/g, "_");
          fs.writeFileSync(path.join(targetFolder, fileName), entry.getData());
          importedCount++;
        }
      }
    } else {
      const fileName = `${folderName}.3mf`;
      fs.writeFileSync(path.join(targetFolder, fileName), buffer);
      importedCount = 1;
    }

    res.json({ ok: true, folder: folderName, count: importedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const info = safeRel(req.query.path || "", req.query.lib);
      cb(null, info ? info.abs : getLib(req.query.lib).path);
    },
    filename: (req, file, cb) => cb(null, path.basename(file.originalname).replace(/[^\w.\- ]+/g, "_")),
  }),
  fileFilter: (req, file, cb) => cb(null, is3DFile(file.originalname)),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.post("/api/upload", upload.array("files", 30), (req, res) => {
  res.json({ ok: true, count: (req.files || []).length });
});

app.post("/api/mkdir", (req, res) => {
  const info = safeRel(req.body.path || "", req.body.lib);
  const name = String(req.body.name || "").trim().replace(/[\\/]/g, "");
  if (!info || !name) return res.status(400).json({ error: "bad folder name" });
  const abs = path.join(info.abs, name);
  if (fs.existsSync(abs)) return res.status(409).json({ error: "already exists" });
  fs.mkdirSync(abs);
  res.json({ ok: true });
});

app.post("/api/move", (req, res) => {
  const fromInfo = safeRel(req.body.from || "", req.body.fromLib || req.body.lib);
  const toInfo = safeRel(req.body.to || "", req.body.toLib || req.body.lib);
  if (!fromInfo || !toInfo || !fs.existsSync(fromInfo.abs) || !fs.statSync(toInfo.abs).isDirectory()) {
    return res.status(400).json({ error: "bad move target" });
  }
  if (toInfo.abs.startsWith(fromInfo.abs + path.sep)) {
    return res.status(400).json({ error: "cannot move a folder into itself" });
  }
  const dest = path.join(toInfo.abs, path.basename(fromInfo.abs));
  if (fs.existsSync(dest)) return res.status(409).json({ error: "name exists at destination" });

  try {
    fs.renameSync(fromInfo.abs, dest);
  } catch (err) {
    if (err.code === "EXDEV") {
      fs.cpSync(fromInfo.abs, dest, { recursive: true });
      fs.rmSync(fromInfo.abs, { recursive: true, force: true });
    } else {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ ok: true });
});

app.post("/api/rename", (req, res) => {
  const info = safeRel(req.body.path || "", req.body.lib);
  const name = String(req.body.name || "").trim().replace(/[\\/]/g, "");
  if (!info || !name || !fs.existsSync(info.abs)) return res.status(400).json({ error: "bad rename" });
  const dest = path.join(path.dirname(info.abs), name);
  if (fs.existsSync(dest)) return res.status(409).json({ error: "name exists" });
  fs.renameSync(info.abs, dest);
  res.json({ ok: true });
});

app.post("/api/delete", (req, res) => {
  const info = safeRel(req.body.path || "", req.body.lib);
  if (!info || info.abs === info.root || !fs.existsSync(info.abs)) return res.status(400).json({ error: "bad delete" });
  const dest = path.join(info.root, ".trash", `${Date.now()}-${path.basename(info.abs)}`);
  fs.renameSync(info.abs, dest);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`STL Vault listening on http://localhost:${PORT}`);
    const libs = loadLibraries();
    console.log(`Configured libraries: ${libs.map((l) => `${l.name} (${l.path})`).join(", ")}`);
  });
}

module.exports = { app, thumbKey, legacyThumbKey, thumbPath, legacyThumbPath, existingThumbPath, inspect3MF, hasThumb };
