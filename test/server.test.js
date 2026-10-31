const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { createApp } = require("../server/index.js");

function tmpFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stl-vault-test-"));
  const root = path.join(dir, "models");
  const state = path.join(dir, "state");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(root, "cube.stl"), "solid cube\nendsolid cube\n");
  fs.mkdirSync(path.join(root, "folder"));
  fs.writeFileSync(path.join(root, "folder", "part.3mf"), "PK\x03\x04fake");
  return { dir, root, state };
}

async function withServer(opts, fn) {
  const app = createApp(opts);
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function req(base, url, opts = {}) {
  return fetch(base + url, opts);
}

async function login(base, token) {
  const res = await req(base, "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /stl_vault_session=/);
  assert.doesNotMatch(cookie, new RegExp(token));
  return cookie.split(";")[0];
}

test("token disabled keeps API usable without a session", async () => {
  const f = tmpFixture();
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    const res = await req(base, "/api/files?lib=default&path=");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).files[0].name, "cube.stl");
  });
});

test("token enabled protects API, model, thumbnail-save, and upload requests", async () => {
  const f = tmpFixture();
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "secret" }, async (base) => {
    assert.equal((await req(base, "/api/files?lib=default&path=")).status, 401);
    assert.equal((await req(base, "/api/file?lib=default&path=cube.stl")).status, 401);
    assert.equal((await req(base, "/api/thumb?lib=default&path=cube.stl")).status, 401);
    assert.equal((await req(base, "/api/thumb", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

    const fd = new FormData();
    fd.set("files", new Blob(["solid uploaded\nendsolid uploaded\n"]), "uploaded.stl");
    assert.equal((await req(base, "/api/upload?lib=default&path=", { method: "POST", body: fd })).status, 401);
  });
});

test("login creates an httpOnly session cookie and does not accept token in URLs", async () => {
  const f = tmpFixture();
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "secret" }, async (base) => {
    assert.equal((await req(base, "/api/files?lib=default&path=&token=secret")).status, 401);
    const cookie = await login(base, "secret");
    const res = await req(base, "/api/files?lib=default&path=", { headers: { cookie } });
    assert.equal(res.status, 200);
  });
});

test("client app contains login UI handling for authenticated deployments", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "client", "app.js"), "utf8");
  assert.match(app, /showLogin/);
  assert.match(app, /Unauthorized/);
  assert.match(app, /credentials: "same-origin"/);
});

test("symlinks resolving outside the library are not enumerated or served", async () => {
  const f = tmpFixture();
  const outside = path.join(f.dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.stl"), "solid secret\nendsolid secret\n");
  fs.symlinkSync(outside, path.join(f.root, "outside-link"), "dir");

  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    const listing = await (await req(base, "/api/files?lib=default&path=")).json();
    assert.equal(listing.folders.some((x) => x.name === "outside-link"), false);
    assert.equal((await req(base, "/api/files?lib=default&path=outside-link")).status, 400);
    assert.equal((await req(base, "/api/file?lib=default&path=outside-link/secret.stl")).status, 404);
  });
});

test("symlinks resolving inside the library are preserved", async () => {
  const f = tmpFixture();
  fs.symlinkSync(path.join(f.root, "folder"), path.join(f.root, "inside-link"), "dir");
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    const listing = await (await req(base, "/api/files?lib=default&path=")).json();
    assert.equal(listing.folders.some((x) => x.name === "inside-link"), true);
  });
});

test("duplicate uploads are rejected safely", async () => {
  const f = tmpFixture();
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    const fd = new FormData();
    fd.set("files", new Blob(["solid dup\nendsolid dup\n"]), "cube.stl");
    const res = await req(base, "/api/upload?lib=default&path=", { method: "POST", body: fd });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already exists/i);
  });
});

test("rename, move, delete, and cross-library moves reject unsafe targets and preserve data", async () => {
  const f = tmpFixture();
  const second = path.join(f.dir, "second");
  fs.mkdirSync(second);
  const libsFile = path.join(f.state, "libraries.json");
  fs.writeFileSync(libsFile, JSON.stringify([
    { id: "default", name: "Main Library", path: f.root },
    { id: "second", name: "Second", path: second },
  ]));

  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    assert.equal((await req(base, "/api/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lib: "default", path: "cube.stl", name: "../bad.stl" }) })).status, 400);
    assert.equal((await req(base, "/api/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromLib: "default", from: "folder", toLib: "default", to: "folder/sub" }) })).status, 400);

    const move = await req(base, "/api/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromLib: "default", from: "cube.stl", toLib: "second", to: "" }) });
    assert.equal(move.status, 200);
    assert.equal(fs.existsSync(path.join(second, "cube.stl")), true);

    const del = await req(base, "/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lib: "second", path: "cube.stl" }) });
    assert.equal(del.status, 200);
    assert.equal(fs.readdirSync(path.join(second, ".trash")).some((n) => n.endsWith("cube.stl")), true);
  });
});

test("library persistence failures return a clear 500 instead of pretending success", async () => {
  const f = tmpFixture();
  const blocker = path.join(f.state, "libraries.json");
  fs.mkdirSync(blocker);
  await withServer({ stlsRoot: f.root, stateDir: f.state, authToken: "" }, async (base) => {
    const res = await req(base, "/api/libraries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Broken", path: f.root }),
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /persist/i);
  });
});
