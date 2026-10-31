# STL Vault

A self-hosted STL/3MF file manager that behaves like Finder — except the icons
are **live 3D renders** of your models. Hover a file and it pops out big enough
to actually see it. Double-click for a full orbit viewer.

STL Vault is filesystem-backed: folders on disk are folders in the UI. Model
files stay in your configured library roots; app configuration and generated
thumbnail cache live in a separate state directory.

## Features

- **3D thumbnails as file icons** — rendered in-browser once, cached server-side
  as PNGs under `STL_VAULT_STATE_DIR/thumbs/`, keyed by library/path/size/mtime.
- **Hover pop-out** — park the cursor on a file and a large auto-rotating preview
  floats next to it.
- **Quick-Look modal** — double-click for the big viewer: orbit, zoom, pan.
- **Finder rules** — folder tree sidebar, breadcrumbs, drag files or folders onto
  folders, rename, trash, and cross-library moves.
- **OS drag-to-upload** — drop `.stl` or `.3mf` files from Finder/Explorer
  anywhere in the window.
- **Optional token authentication** — when `STL_VAULT_TOKEN` is set, every API
  request, model download, thumbnail read, upload, and thumbnail-save request
  requires an authenticated session cookie. The token is submitted only in the
  login body and is never placed in URLs.

## Run it locally

```bash
npm install
STLS_ROOT=/path/to/your/stls \
STL_VAULT_STATE_DIR=/tmp/stl-vault-state \
STL_VAULT_TOKEN='choose-a-long-random-token' \
npm start
# → http://localhost:4173
```

If `STL_VAULT_TOKEN` is unset or empty, authentication is disabled. That is only
appropriate for trusted local development or a tightly isolated LAN.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP listen port. |
| `STLS_ROOT` | `./stls` | Default model library root. |
| `STL_VAULT_STATE_DIR` | `./var` or systemd `/var/lib/stl-vault` | Mutable app state: `libraries.json` and generated thumbnails. |
| `STL_VAULT_TOKEN` | unset | Enables token login/session auth when set. Use a long random value. |

`libraries.json` is stored in the state directory, not under `/opt/stl-vault`, so
application code can be deployed read-only.

## Deploy with systemd on the LXC

Create a fixed service account and give it explicit write access to the model
library root:

```bash
useradd --system --home /var/lib/stl-vault --shell /usr/sbin/nologin stl-vault
mkdir -p /opt/stl-vault /srv/models /etc/stl-vault
chown -R stl-vault:stl-vault /srv/models
chmod 2775 /srv/models
```

If the model library is shared with Samba or other tools, use a shared group
instead of making `stl-vault` the only owner:

```bash
usermod -aG manyfold stl-vault
chgrp -R manyfold /srv/models
chmod -R g+rwX /srv/models
find /srv/models -type d -exec chmod g+s {} +
```

Put secrets and local paths in `/etc/stl-vault/stl-vault.env`:

```bash
PORT=4173
STLS_ROOT=/srv/models
STL_VAULT_STATE_DIR=/var/lib/stl-vault
STL_VAULT_TOKEN=replace-with-a-long-random-token
```

Install and start the unit:

```bash
cp deploy/stl-vault.service /etc/systemd/system/stl-vault.service
systemctl daemon-reload
systemctl enable --now stl-vault
systemctl status stl-vault
```

The provided unit uses:

- `StateDirectory=stl-vault` for `/var/lib/stl-vault` ownership/creation.
- `ReadOnlyPaths=/opt/stl-vault` so code is read-only at runtime.
- `ReadWritePaths=/var/lib/stl-vault /srv/models` for the state dir and model
  library.
- A fixed `stl-vault` user instead of `DynamicUser=yes`, because model libraries
  need stable, documented ownership across restarts and other file-sharing tools.

## Security notes

- Do not expose STL Vault publicly without `STL_VAULT_TOKEN` and an HTTPS reverse
  proxy.
- Tokens are not accepted in query strings. Authenticate via the login form;
  the server returns an `HttpOnly; SameSite=Lax` session cookie.
- Symlinked folders/files are allowed only when their real path remains inside
  the configured library root. Links resolving outside the root are hidden from
  tree/listing APIs and cannot be served, moved, renamed, uploaded into, or
  deleted through the app.

## Tests and checks

```bash
npm test
npm run check
```

The test suite uses temporary directories only; it does not touch real model
libraries.

## Stack

Express + multer server (`server/index.js`), dependency-free SPA client,
Three.js (vendored, no CDN) for STLLoader / 3MFLoader / rendering /
OrbitControls.
