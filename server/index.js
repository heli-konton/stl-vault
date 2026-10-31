// STL Vault — self-hosted 3D model manager (STL & 3MF).
// Filesystem-backed: folders on disk are folders in the UI. No database.

const express = require("express");
const compression = require("compression");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const DEFAULT_PORT = process.env.PORT || 4173;
const DEFAULT_STATE_DIR = process.env.STL_VAULT_STATE_DIR || process.env.STATE_DIRECTORY || path.join(__dirname, "..", "var");
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const SAFE_NAME = /^[^/\\]+$/;

const isHidden = (name) => name.startsWith(".");
const is3DFile = (name) => /\.(stl|3mf)$/i.test(name);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeSlashes(rel) {
  return String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function statePath(stateDir, name) {
  return path.join(stateDir, name);
}

function createRuntime(options = {}) {
  const stateDir = path.resolve(options.stateDir || DEFAULT_STATE_DIR);
  const librariesFile = options.librariesFile || statePath(stateDir, "libraries.json");
  const thumbsDir = options.thumbsDir || statePath(stateDir, "thumbs");
  const sessions = new Map();
  const authToken = options.authToken !== undefined ? String(options.authToken || "") : String(process.env.STL_VAULT_TOKEN || "");
  const authEnabled = authToken.length > 0;

  ensureDir(stateDir);
  ensureDir(thumbsDir);

  function defaultRoot() {
    return path.resolve(options.stlsRoot || process.env.STLS_ROOT || path.join(__dirname, "..", "stls"));
  }

  function persistLibraries(list) {
    try {
      ensureDir(path.dirname(librariesFile));
      fs.writeFileSync(librariesFile, JSON.stringify(list, null, 2));
    } catch (err) {
      const e = new Error(`Could not persist libraries configuration: ${err.message}`);
      e.status = 500;
      throw e;
    }
  }

  function loadLibraries() {
    let list = [{ id: "default", name: "Main Library", path: defaultRoot() }];
    if (fs.existsSync(librariesFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(librariesFile, "utf8"));
        if (Array.isArray(data) && data.length > 0) list = data;
      } catch (err) {
        const e = new Error(`Could not persist/read libraries configuration: ${err.message}`);
        e.status = 500;
        throw e;
      }
    }

    for (const lib of list) {
      lib.path = path.resolve(lib.path);
      ensureDir(lib.path);
      ensureDir(path.join(lib.path, ".trash"));
      lib.realPath = fs.realpathSync.native(lib.path);
    }
    return list;
  }

  function getLib(libId) {
    const libs = loadLibraries();
    return libs.find((l) => l.id === libId) || libs[0];
  }

  function containsPath(rootReal, childReal) {
    return childReal === rootReal || childReal.startsWith(rootReal + path.sep);
  }

  function resolveExisting(rel, libId) {
    const lib = getLib(libId);
    const clean = normalizeSlashes(rel);
    const lexicalAbs = path.resolve(lib.path, clean);
    if (lexicalAbs !== lib.path && !lexicalAbs.startsWith(lib.path + path.sep)) return null;
    if (!fs.existsSync(lexicalAbs)) return null;
    const realAbs = fs.realpathSync.native(lexicalAbs);
    if (!containsPath(lib.realPath, realAbs)) return null;
    const relPath = path.relative(lib.realPath, realAbs).split(path.sep).join("/");
    return { abs: lexicalAbs, realAbs, root: lib.path, rootReal: lib.realPath, rel: relPath, lib };
  }

  function resolveDirectory(rel, libId) {
    const info = resolveExisting(rel, libId);
    if (!info) return null;
    let st;
    try { st = fs.statSync(info.realAbs); } catch { return null; }
    if (!st.isDirectory()) return null;
    return info;
  }

  function resolveCreatableInDirectory(dirInfo, name) {
    const raw = String(name || "").trim().replace(/[\x00]/g, "");
    if (!raw || raw === "." || raw === ".." || !SAFE_NAME.test(raw)) return null;
    const clean = path.basename(raw);
    if (!clean || clean === "." || clean === ".." || !SAFE_NAME.test(clean)) return null;
    const abs = path.join(dirInfo.realAbs, clean);
    const lexical = path.resolve(abs);
    if (!lexical.startsWith(dirInfo.rootReal + path.sep)) return null;
    return { name: clean, abs: lexical };
  }

  function entryFromPath(abs, rootReal, withPreview = false) {
    const st = fs.statSync(abs);
    const rel = path.relative(rootReal, fs.realpathSync.native(abs)).split(path.sep).join("/");
    if (st.isDirectory()) {
      const entry = { kind: "folder", name: path.basename(abs), path: rel, mtime: st.mtimeMs };
      if (withPreview) entry.preview = findFolderPreview(abs, rootReal);
      return entry;
    }
    return fileEntry(abs, rootReal);
  }

  function hasThumb(tp) {
    try { return fs.existsSync(tp) && fs.statSync(tp).size > 100; } catch { return false; }
  }

  function thumbKey(rootReal, rel, size, mtime) {
    const mtimeSeconds = Math.floor(Number(mtime || 0) / 1000);
    return crypto.createHash("sha1").update(`${rootReal}:${rel}:${size}:${mtimeSeconds}`).digest("hex");
  }

  function legacyThumbKey(rootReal, rel, size, mtime) {
    return crypto.createHash("sha1").update(`${rootReal}:${rel}:${size}:${Math.round(mtime)}`).digest("hex");
  }

  function thumbPath(rootReal, rel, size, mtime) {
    return path.join(thumbsDir, `${thumbKey(rootReal, rel, size, mtime)}.png`);
  }

  function legacyThumbPath(rootReal, rel, size, mtime) {
    return path.join(thumbsDir, `${legacyThumbKey(rootReal, rel, size, mtime)}.png`);
  }

  function existingThumbPath(rootReal, rel, size, mtime) {
    const current = thumbPath(rootReal, rel, size, mtime);
    if (hasThumb(current)) return current;
    const legacy = legacyThumbPath(rootReal, rel, size, mtime);
    if (hasThumb(legacy)) return legacy;
    return null;
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
        if (!thumbEntry) thumbEntry = entries.find((e) => e.entryName.endsWith(".png") || e.entryName.endsWith(".jpg"));
        if (thumbEntry) fs.writeFileSync(tp, thumbEntry.getData());
      }
      const configEntry = entries.find((e) => e.entryName === "Metadata/project_settings.config" || e.entryName === "Metadata/slice_info.config");
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

  function fileEntry(abs, rootReal) {
    const realAbs = fs.realpathSync.native(abs);
    const st = fs.statSync(realAbs);
    const rel = path.relative(rootReal, realAbs).split(path.sep).join("/");
    const tp = existingThumbPath(rootReal, rel, st.size, st.mtimeMs);
    const ext = path.extname(realAbs).toLowerCase().replace(".", "");
    const slicerMeta = null;
    return {
      kind: ext === "3mf" ? "3mf" : "stl",
      name: path.basename(realAbs),
      path: rel,
      size: st.size,
      mtime: st.mtimeMs,
      mtimeVersion: `${st.size}-${Math.floor(st.mtimeMs / 1000)}`,
      thumb: !!tp,
      slicerMeta,
    };
  }

  function safeDirChildren(abs, rootReal) {
    const names = fs.readdirSync(abs).filter((name) => !isHidden(name)).sort((a, b) => a.localeCompare(b));
    const out = [];
    for (const name of names) {
      const child = path.join(abs, name);
      try {
        const real = fs.realpathSync.native(child);
        if (!containsPath(rootReal, real)) continue;
        out.push({ name, abs: child, real });
      } catch { /* skip broken links/unreadable entries */ }
    }
    return out;
  }

  function findFolderPreview(abs, rootReal) {
    const queue = [{ abs, depth: 0 }];
    let inspected = 0;
    while (queue.length && inspected < 160) {
      const cur = queue.shift();
      let children = [];
      try { children = safeDirChildren(cur.abs, rootReal); } catch { continue; }
      for (const child of children) {
        inspected++;
        try {
          if (/\.3mf$/i.test(child.name) && fs.statSync(child.real).isFile()) return fileEntry(child.real, rootReal);
        } catch { /* skip */ }
      }
      if (cur.depth >= 3) continue;
      for (const child of children) {
        inspected++;
        try { if (fs.statSync(child.real).isDirectory()) queue.push({ abs: child.real, depth: cur.depth + 1 }); } catch { /* skip */ }
      }
    }
    return null;
  }

  function listDir(abs, rootReal) {
    const out = { folders: [], files: [] };
    for (const child of safeDirChildren(abs, rootReal)) {
      let st;
      try { st = fs.statSync(child.real); } catch { continue; }
      if (st.isDirectory()) {
        const rel = path.relative(rootReal, child.abs).split(path.sep).join("/");
        out.folders.push({ kind: "folder", name: child.name, path: rel, mtime: st.mtimeMs, preview: null });
      } else if (is3DFile(child.name)) out.files.push(fileEntry(child.real, rootReal));
    }
    out.folders.sort((a, b) => a.name.localeCompare(b.name));
    out.files.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function createSession() {
    const id = crypto.randomBytes(32).toString("base64url");
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
  }

  function validSession(req) {
    if (!authEnabled) return true;
    const id = parseCookies(req.headers.cookie).stl_vault_session;
    if (!id) return false;
    const expires = sessions.get(id);
    if (!expires || expires < Date.now()) {
      sessions.delete(id);
      return false;
    }
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    return true;
  }

  function requireAuth(req, res, next) {
    if (validSession(req)) return next();
    res.status(401).json({ error: "Authentication required" });
  }

  return {
    stateDir,
    librariesFile,
    thumbsDir,
    authEnabled,
    loadLibraries,
    persistLibraries,
    getLib,
    resolveExisting,
    resolveDirectory,
    resolveCreatableInDirectory,
    listDir,
    fileEntry,
    thumbKey,
    legacyThumbKey,
    thumbPath,
    legacyThumbPath,
    existingThumbPath,
    findFolderPreview,
    createSession,
    requireAuth,
    validSession,
    verifyToken: (token) => authEnabled && safeEqual(token, authToken),
  };
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createApp(options = {}) {
  const runtime = createRuntime(options);
  const app = express();

  app.locals.runtime = runtime;
  app.use(compression());
  app.use(express.json({ limit: "8mb" }));
  app.use(express.static(path.join(__dirname, "..", "client")));
  app.use("/vendor/three", express.static(path.join(__dirname, "..", "node_modules", "three"), { maxAge: "7d" }));

  app.get("/api/session", (req, res) => {
    res.json({ authEnabled: runtime.authEnabled, authenticated: runtime.validSession(req) });
  });

  app.post("/api/session", (req, res) => {
    if (!runtime.authEnabled) return res.json({ ok: true, authEnabled: false });
    if (!runtime.verifyToken(req.body?.token || "")) return res.status(401).json({ error: "Invalid token" });
    const id = runtime.createSession();
    res.setHeader("Set-Cookie", `stl_vault_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    res.json({ ok: true, authEnabled: true });
  });

  app.use("/api", (req, res, next) => {
    if (req.path === "/session") return next();
    return runtime.requireAuth(req, res, next);
  });

  app.get("/api/libraries", (req, res) => {
    res.json(runtime.loadLibraries().map(({ realPath, ...lib }) => lib));
  });

  app.post("/api/libraries", (req, res, next) => {
    try {
      const name = String(req.body.name || "").trim();
      const libPath = String(req.body.path || "").trim();
      if (!name || !libPath) return res.status(400).json({ error: "Name and path required" });
      const absPath = path.resolve(libPath);
      ensureDir(absPath);
      ensureDir(path.join(absPath, ".trash"));
      const libs = runtime.loadLibraries();
      const id = "lib-" + crypto.randomBytes(4).toString("hex");
      const newLib = { id, name, path: absPath };
      runtime.persistLibraries([...libs.map(({ realPath, ...l }) => l), newLib]);
      res.json(newLib);
    } catch (err) { next(err); }
  });

  app.delete("/api/libraries/:id", (req, res, next) => {
    try {
      const libs = runtime.loadLibraries();
      if (libs.length <= 1) return res.status(400).json({ error: "Cannot remove the primary library" });
      runtime.persistLibraries(libs.filter((l) => l.id !== req.params.id).map(({ realPath, ...l }) => l));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/tree", (req, res) => {
    const lib = runtime.getLib(req.query.lib);
    function walk(abs, depth) {
      if (depth > 8) return null;
      const realAbs = fs.realpathSync.native(abs);
      const node = {
        kind: "folder",
        name: path.basename(realAbs),
        path: path.relative(lib.realPath, realAbs).split(path.sep).join("/"),
        mtime: fs.statSync(realAbs).mtimeMs,
      };
      node.children = [];
      for (const child of fs.readdirSync(abs).filter((n) => !isHidden(n)).sort((a, b) => a.localeCompare(b))) {
        const childAbs = path.join(abs, child);
        try {
          const real = fs.realpathSync.native(childAbs);
          if (!real.startsWith(lib.realPath + path.sep) && real !== lib.realPath) continue;
          if (fs.statSync(real).isDirectory()) {
            const sub = walk(real, depth + 1);
            if (sub) node.children.push(sub);
          }
        } catch { /* skip */ }
      }
      return node;
    }
    const tree = walk(lib.realPath, 0);
    if (tree) tree.name = lib.name;
    res.json(tree);
  });

  app.get("/api/files", (req, res) => {
    const info = runtime.resolveDirectory(req.query.path || "", req.query.lib);
    if (!info) return res.status(400).json({ error: "not a folder" });
    res.json(runtime.listDir(info.realAbs, info.rootReal));
  });

  app.get("/api/folder-preview", (req, res) => {
    const info = runtime.resolveDirectory(req.query.path || "", req.query.lib);
    if (!info) return res.status(400).json({ error: "not a folder" });
    res.json({ preview: runtime.findFolderPreview(info.realAbs, info.rootReal) });
  });

  app.get("/api/file", (req, res) => {
    const info = runtime.resolveExisting(req.query.path || "", req.query.lib);
    if (!info) return res.status(404).end();
    let st;
    try { st = fs.statSync(info.realAbs); } catch { return res.status(404).end(); }
    if (!st.isFile() || !is3DFile(info.realAbs)) return res.status(404).end();
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(info.realAbs);
  });

  app.get("/api/thumb", (req, res) => {
    const info = runtime.resolveExisting(req.query.path || "", req.query.lib);
    if (!info) return res.status(404).end();
    const st = fs.statSync(info.realAbs);
    let tp = runtime.existingThumbPath(info.rootReal, info.rel, st.size, st.mtimeMs);
    if (!tp && /\.3mf$/i.test(info.realAbs)) {
      const current = runtime.thumbPath(info.rootReal, info.rel, st.size, st.mtimeMs);
      inspect3MF(info.realAbs, current);
      tp = runtime.existingThumbPath(info.rootReal, info.rel, st.size, st.mtimeMs);
    }
    if (!tp) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).end();
    }
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.sendFile(tp);
  });

  app.post("/api/thumb", (req, res) => {
    const info = runtime.resolveExisting(req.body.path || "", req.body.lib);
    const dataUrl = String(req.body.png || "");
    if (!info || !fs.existsSync(info.realAbs)) return res.status(400).json({ error: "bad path" });
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "bad png" });
    const st = fs.statSync(info.realAbs);
    fs.writeFileSync(runtime.thumbPath(info.rootReal, info.rel, st.size, st.mtimeMs), Buffer.from(m[1], "base64"));
    res.json({ ok: true });
  });

  app.post("/api/import-link", asyncRoute(async (req, res) => {
    const info = runtime.resolveDirectory(req.body.path || "", req.body.lib);
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
    const target = resolveTargetFolder(runtime, info, folderName);
    const response = await fetch(downloadUrl, { headers: { "User-Agent": "Mozilla/5.0 STL Vault" } });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} from model site`), { status: 500 });
    const buffer = Buffer.from(await response.arrayBuffer());
    ensureDir(target.abs);
    let importedCount = 0;
    if (downloadUrl.endsWith(".zip") || buffer.slice(0, 4).toString("hex") === "504b0304") {
      const zip = new AdmZip(buffer);
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory && is3DFile(entry.entryName)) {
          const candidate = resolveUploadTarget(target.abs, path.basename(entry.entryName));
          if (!candidate) continue;
          if (fs.existsSync(candidate)) continue;
          fs.writeFileSync(candidate, entry.getData());
          importedCount++;
        }
      }
    } else {
      const candidate = resolveUploadTarget(target.abs, `${folderName}.3mf`);
      fs.writeFileSync(candidate, buffer);
      importedCount = 1;
    }
    res.json({ ok: true, folder: folderName, count: importedCount });
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const info = runtime.resolveDirectory(req.query.path || "", req.query.lib);
        if (!info) return cb(new Error("bad upload target"));
        cb(null, info.realAbs);
      },
      filename: (req, file, cb) => {
        const info = runtime.resolveDirectory(req.query.path || "", req.query.lib);
        const dest = info ? resolveUploadTarget(info.realAbs, file.originalname) : null;
        if (!dest) return cb(new Error("bad filename"));
        if (fs.existsSync(dest)) {
          const err = new Error("file already exists");
          err.status = 409;
          return cb(err);
        }
        cb(null, path.basename(dest));
      },
    }),
    fileFilter: (req, file, cb) => cb(null, is3DFile(file.originalname)),
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  app.post("/api/upload", upload.array("files", 30), (req, res) => {
    res.json({ ok: true, count: (req.files || []).length });
  });

  app.post("/api/mkdir", (req, res) => {
    const info = runtime.resolveDirectory(req.body.path || "", req.body.lib);
    const target = info && runtime.resolveCreatableInDirectory(info, req.body.name);
    if (!info || !target) return res.status(400).json({ error: "bad folder name" });
    if (fs.existsSync(target.abs)) return res.status(409).json({ error: "already exists" });
    fs.mkdirSync(target.abs);
    res.json({ ok: true });
  });

  app.post("/api/move", (req, res) => {
    const fromInfo = runtime.resolveExisting(req.body.from || "", req.body.fromLib || req.body.lib);
    const toInfo = runtime.resolveDirectory(req.body.to || "", req.body.toLib || req.body.lib);
    if (!fromInfo || !toInfo) return res.status(400).json({ error: "bad move target" });
    const fromStat = fs.statSync(fromInfo.realAbs);
    if (fromStat.isDirectory() && containsPath(fromInfo.realAbs, toInfo.realAbs)) {
      return res.status(400).json({ error: "cannot move a folder into itself" });
    }
    const dest = path.join(toInfo.realAbs, path.basename(fromInfo.realAbs));
    if (fs.existsSync(dest)) return res.status(409).json({ error: "name exists at destination" });
    try {
      fs.renameSync(fromInfo.realAbs, dest);
    } catch (err) {
      if (err.code === "EXDEV") {
        fs.cpSync(fromInfo.realAbs, dest, { recursive: true, errorOnExist: true });
        fs.rmSync(fromInfo.realAbs, { recursive: true, force: true });
      } else throw err;
    }
    res.json({ ok: true });
  });

  app.post("/api/rename", (req, res) => {
    const info = runtime.resolveExisting(req.body.path || "", req.body.lib);
    if (!info || info.realAbs === info.rootReal) return res.status(400).json({ error: "bad rename" });
    const parentInfo = runtime.resolveDirectory(path.dirname(info.rel) === "." ? "" : path.dirname(info.rel), req.body.lib);
    const target = parentInfo && runtime.resolveCreatableInDirectory(parentInfo, req.body.name);
    if (!target) return res.status(400).json({ error: "bad rename" });
    if (fs.existsSync(target.abs)) return res.status(409).json({ error: "name exists" });
    fs.renameSync(info.realAbs, target.abs);
    res.json({ ok: true });
  });

  app.post("/api/delete", (req, res) => {
    const info = runtime.resolveExisting(req.body.path || "", req.body.lib);
    if (!info || info.realAbs === info.rootReal) return res.status(400).json({ error: "bad delete" });
    const trashDir = path.join(info.rootReal, ".trash");
    ensureDir(trashDir);
    const dest = path.join(trashDir, `${Date.now()}-${path.basename(info.realAbs)}`);
    fs.renameSync(info.realAbs, dest);
    res.json({ ok: true });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.status === 409 ? err.message : (err.message || "server error") });
  });

  return app;
}

function resolveUploadTarget(dir, originalName) {
  const clean = path.basename(String(originalName || "").replace(/[^\w.\- ()]+/g, "_")).trim();
  if (!clean || !is3DFile(clean)) return null;
  return path.join(dir, clean);
}

function resolveTargetFolder(runtime, info, folderName) {
  const target = runtime.resolveCreatableInDirectory(info, folderName.replace(/[^\w.\- ()]+/g, "_"));
  if (!target) {
    const err = new Error("bad import folder");
    err.status = 400;
    throw err;
  }
  if (fs.existsSync(target.abs)) {
    const err = new Error("import folder already exists");
    err.status = 409;
    throw err;
  }
  return target;
}

if (require.main === module) {
  const app = createApp();
  app.listen(DEFAULT_PORT, () => {
    const runtime = app.locals.runtime;
    console.log(`STL Vault listening on http://localhost:${DEFAULT_PORT}`);
    console.log(`State directory: ${runtime.stateDir}`);
    console.log(`Authentication: ${runtime.authEnabled ? "enabled" : "disabled"}`);
    const libs = runtime.loadLibraries();
    console.log(`Configured libraries: ${libs.map((l) => `${l.name} (${l.path})`).join(", ")}`);
  });
}

module.exports = { createApp, createRuntime };
