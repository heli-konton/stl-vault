#!/usr/bin/env node
// Seed STL Vault thumbnails that can be harvested server-side.
// Today that means embedded PNG/JPG previews inside .3mf archives.

const fs = require('fs');
const path = require('path');
const { thumbPath, existingThumbPath, inspect3MF, hasThumb } = require('../server/index.js');

const LIBRARIES_FILE = path.join(__dirname, '..', 'libraries.json');

function loadLibraries() {
  const defaultRoot = path.resolve(process.env.STLS_ROOT || path.join(__dirname, '..', 'stls'));
  if (fs.existsSync(LIBRARIES_FILE)) {
    const data = JSON.parse(fs.readFileSync(LIBRARIES_FILE, 'utf8'));
    if (Array.isArray(data) && data.length) return data;
  }
  return [{ id: 'default', name: 'Main Library', path: defaultRoot }];
}

function* walk(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === '.thumbs' || name === '.trash' || name === 'lost+found') continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) yield* walk(abs);
    else if (/\.3mf$/i.test(name)) yield { abs, st };
  }
}

let scanned = 0;
let existing = 0;
let harvested = 0;
let failed = 0;

for (const lib of loadLibraries()) {
  const root = path.resolve(lib.path);
  fs.mkdirSync(path.join(root, '.thumbs'), { recursive: true });
  for (const file of walk(root)) {
    scanned += 1;
    const rel = path.relative(root, file.abs).split(path.sep).join('/');
    const before = existingThumbPath(root, rel, file.st.size, file.st.mtimeMs);
    if (hasThumb(before)) { existing += 1; continue; }
    const target = thumbPath(root, rel, file.st.size, file.st.mtimeMs);
    try {
      inspect3MF(file.abs, target);
      if (hasThumb(target)) harvested += 1;
    } catch {
      failed += 1;
    }
  }
}

console.log(JSON.stringify({ scanned, existing, harvested, failed }, null, 2));
