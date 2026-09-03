const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

function freshServer(root) {
  const serverPath = path.resolve(__dirname, '../server/index.js');
  const libsPath = path.resolve(__dirname, '../libraries.json');
  process.env.STLS_ROOT = root;
  delete require.cache[serverPath];
  delete require.cache[libsPath];
  return require(serverPath);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, pathname) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('thumbnail key uses stable mtime seconds while legacy covers rounded-ms keys', () => {
  const root = '/tmp/root';
  const a = freshServer(fs.mkdtempSync(path.join(os.tmpdir(), 'stlvault-')));
  assert.equal(a.thumbKey('folder/model.stl', 123, 1234567.1), a.thumbKey('folder/model.stl', 123, 1234999.9));
  assert.notEqual(a.thumbKey('folder/model.stl', 123, 1234567.1), a.legacyThumbKey('folder/model.stl', 123, 1234567.1));
  assert.equal(a.thumbPath(root, 'folder/model.stl', 123, 1234567.1), path.join(root, '.thumbs', `${a.thumbKey('folder/model.stl', 123, 1234567.1)}.png`));
});

test('GET /api/thumb serves PNGs from .thumbs dot-directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stlvault-'));
  fs.mkdirSync(path.join(root, '.thumbs'), { recursive: true });
  const model = path.join(root, 'cube.stl');
  fs.writeFileSync(model, 'solid cube\nendsolid cube\n');
  const st = fs.statSync(model);
  const mod = freshServer(root);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(256)]);
  fs.writeFileSync(mod.thumbPath(root, 'cube.stl', st.size, st.mtimeMs), png);
  const server = await listen(mod.app);
  try {
    const res = await request(server, '/api/thumb?path=cube.stl');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, png.length);
    assert.match(res.headers['cache-control'], /immutable/);
  } finally {
    server.close();
  }
});

test('GET /api/thumb 404 responses are not cached', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stlvault-'));
  fs.writeFileSync(path.join(root, 'missing-thumb.stl'), 'solid x\nendsolid x\n');
  const mod = freshServer(root);
  const server = await listen(mod.app);
  try {
    const res = await request(server, '/api/thumb?path=missing-thumb.stl');
    assert.equal(res.status, 404);
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    server.close();
  }
});
