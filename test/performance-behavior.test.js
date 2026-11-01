const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, createRuntime } = require('../server/index.js');

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-vault-perf-'));
  const root = path.join(dir, 'models');
  const state = path.join(dir, 'state');
  fs.mkdirSync(root, { recursive: true });
  return { dir, root, state };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function req(server, pathname) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

test('/api/files does not synchronously inspect 3mf metadata or recurse for folder previews', async () => {
  const { root, state } = tempRoot();
  fs.mkdirSync(path.join(root, 'folder', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'folder', 'nested', 'deep.3mf'), Buffer.from('not a zip'));
  fs.writeFileSync(path.join(root, 'top.3mf'), Buffer.from('not a zip'));

  const app = createApp({ stlsRoot: root, stateDir: state });
  const server = await listen(app);
  try {
    const res = await req(server, '/api/files?lib=default&path=');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.files.find((f) => f.name === 'top.3mf').slicerMeta, null);
    assert.equal(body.files.find((f) => f.name === 'top.3mf').thumb, false);
    assert.equal(body.folders.find((f) => f.name === 'folder').preview, null);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('folder previews are available through a lazy one-folder endpoint', async () => {
  const { root, state } = tempRoot();
  fs.mkdirSync(path.join(root, 'folder', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'folder', 'nested', 'deep.3mf'), Buffer.from('not a zip'));

  const app = createApp({ stlsRoot: root, stateDir: state });
  const server = await listen(app);
  try {
    const res = await req(server, '/api/folder-preview?lib=default&path=folder');
    assert.equal(res.status, 200);
    assert.equal(res.json().preview.path, 'folder/nested/deep.3mf');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('thumbnail paths use stable mtime seconds and can fallback-read legacy rounded-ms entries', () => {
  const { root, state } = tempRoot();
  const runtime = createRuntime({ stlsRoot: root, stateDir: state });
  const stableA = runtime.thumbPath(root, 'cube.stl', 123, 1234567.1);
  const stableB = runtime.thumbPath(root, 'cube.stl', 123, 1234999.9);
  const legacy = runtime.legacyThumbPath(root, 'cube.stl', 123, 1234567.1);
  assert.equal(stableA, stableB);
  assert.notEqual(stableA, legacy);

  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(256)]));
  assert.equal(runtime.existingThumbPath(root, 'cube.stl', 123, 1234567.1), legacy);
});

test('client code cancels stale navigation and validates thumbnail saves', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'client', 'app.js'), 'utf8');
  const viewerJs = fs.readFileSync(path.join(__dirname, '..', 'client', 'viewer3d.js'), 'utf8');
  assert.match(appJs, /AbortController/);
  assert.match(appJs, /clearThumbJobs/);
  assert.match(appJs, /treeLoadedForLib/);
  assert.match(appJs, /versionedThumbUrl/);
  assert.match(appJs, /file\.kind === "3mf"/);
  assert.match(appJs, /renderUnavailableThumb/);
  assert.match(viewerJs, /saveThumb[\s\S]*if \(!res\.ok\)/);
  assert.match(viewerJs, /setPaused/);
  assert.match(viewerJs, /material\?\.dispose/);
});
