# STL Vault

A self-hosted STL file manager that behaves like Finder — except the icons
are **live 3D renders** of your models. Hover a file and it pops out big
enough to actually see it. Double-click for a full orbit viewer.

Built to replace a disappointing off-the-shelf STL manager: no database, no
accounts, no sync daemon. **The filesystem is the truth** — folders on disk
are folders in the UI, so you can also organize with `mv` and the UI just
follows along.

## Features

- **3D thumbnails as file icons** — rendered in-browser once, cached
  server-side as PNGs (`.thumbs/`, keyed by path+size+mtime, so edits
  invalidate correctly). First visit renders lazily; after that, instant.
- **Hover pop-out** — park the cursor on a file for ~300ms and a 440px
  auto-rotating preview floats next to it.
- **Quick-Look modal** — double-click for the big viewer: orbit, zoom, pan.
- **Finder rules** — folder tree sidebar, breadcrumbs, drag files (or whole
  folders) onto folders, drag onto the content background for the current
  folder, rename, trash (moves to `.trash/`, never unlinks).
- **OS drag-to-upload** — drop `.stl` files from Finder/Explorer anywhere in
  the window; they land in the folder you're looking at. Upload button too.
- **Filter box** for big folders.

## Run it

```bash
npm install
STLS_ROOT=/path/to/your/stls npm start
# → http://localhost:4173
```

Defaults to `./stls` if `STLS_ROOT` is unset. Sample models included; delete
them and point it at your real library.

## Deploy on the Proxmox box (LXC)

Copy the folder to the LXC, then:

```bash
cp deploy/stl-vault.service /etc/systemd/system/
# edit WorkingDirectory / Environment=STLS_ROOT in the unit
systemctl daemon-reload
systemctl enable --now stl-vault
```

Put `STLS_ROOT` on your bulk storage mount (the same dataset your current
manager uses — you can run both side by side while you evaluate, they're
just reading files). Reverse-proxy it behind your usual nginx/Traefik host
when you're happy, then decommission the old one.

## Verified before shipping

Headless Chromium against a live server: grid render, thumbnail generation +
server cache, cached thumbs on reload, hover pop-out, orbit modal,
drag-to-folder (verified on disk), sidebar navigation, breadcrumbs, mkdir,
OS-drop upload (verified on disk), zero JS errors. Screenshots in `shots/`.

## Stack

Express + multer server (`server/index.js`), dependency-free SPA client,
Three.js (vendored, no CDN — works offline on the LAN) for STLLoader /
rendering / OrbitControls.

## Sensible next steps (not built yet)

- Multiple selection + bulk move/delete
- Slicer hand-off (open in PrusaSlicer/OrcaSlicer via URL or file assoc)
- Print metadata (filament estimates via a slicer CLI)
- Recursive search across folders
- Auth, if you ever expose it beyond the LAN (don't, without it)
