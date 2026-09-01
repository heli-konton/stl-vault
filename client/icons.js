/* ============================================================
   STL Vault — line icons (Atrium)
   Replaces every emoji in the UI. Plain ES module, no deps.
   Each export is an SVG string ready for innerHTML.
   Usage:  import { ICON } from "./icons.js";
           el.innerHTML = ICON.folder();
           el.innerHTML = ICON.cube(46);           // custom size
           el.innerHTML = ICON.trash(14,"#e88f89"); // custom colour
   ============================================================ */

const svg = (paths, size = 15, stroke = "currentColor", width = 1.6) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">` +
  paths.map((d) => `<path d="${d}"/>`).join("") +
  `</svg>`;

const P = {
  archive: ["M4 6.5h16v3H4z", "M5.5 9.5v9h13v-9", "M10 13h4"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h3.2l1.7 2.1H18.5a2 2 0 0 1 2 2v7.9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"],
  folderPlus: ["M3.5 7.5a2 2 0 0 1 2-2h3.2l1.7 2.1H18.5a2 2 0 0 1 2 2v7.9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z", "M12 11.5v4", "M10 13.5h4"],
  cube: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  file: ["M6.5 3.5h7L18 8v12.5H6.5z", "M13.5 3.5V8H18"],
  layers: ["M12 4l8 4-8 4-8-4z", "M4 12l8 4 8-4", "M4 16l8 4 8-4"],
  link: ["M9.8 14.2l4.4-4.4", "M11.2 7.4l1.7-1.7a3.6 3.6 0 0 1 5.1 5.1L16.3 12.5", "M12.8 16.6l-1.7 1.7a3.6 3.6 0 0 1-5.1-5.1L7.7 11.5"],
  upload: ["M12 16V5", "m8 8.6 4-4 4 4", "M4.5 19h15"],
  download: ["M12 4.5v11", "m8 11.4 4 4 4-4", "M4.5 19h15"],
  trash: ["M5 7.5h14", "M9.5 7.5V5.8h5v1.7", "M7 7.5l.7 11.2h8.6L17 7.5"],
  pencil: ["M4 19.5l4-1L18 8.5l-3-3L5 15.5z"],
  move: ["M4 12h13", "m13 8 4 4-4 4", "M20 5v14"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  grid: ["M4.5 4.5h5.5v5.5H4.5z", "M14 4.5h5.5v5.5H14z", "M4.5 14h5.5v5.5H4.5z", "M14 14h5.5v5.5H14z"],
  list: ["M4 7h16", "M4 12h16", "M4 17h16"],
  warn: ["M12 4.5 21 19.5H3z", "M12 10v4", "M12 16.9v.1"],
  chevron: ["M9.5 6l6 6-6 6"],
  plus: ["M12 5.5v13", "M5.5 12h13"],
  search: ["M11 4.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2z", "m16 16 4.2 4.2"]
};

export const ICON = Object.fromEntries(
  Object.entries(P).map(([k, paths]) => [
    k,
    (size, stroke, width) => svg(paths, size, stroke, width)
  ])
);

/* Emoji → icon map, for reference while patching:
   🗄 🗂  library root ....... ICON.archive
   📚     library ............ ICON.archive
   📁     folder ............. ICON.folder
   📄     model / file ....... ICON.cube  (rendered model) / ICON.file (no render yet)
   🍰     open in slicer ..... ICON.layers
   🔗     import link ........ ICON.link
   ⇪      upload ............. ICON.upload
   🔲     icon view .......... ICON.grid
   ☰      list view .......... ICON.list
   🚚     move to ............ ICON.move
   🗑      trash .............. ICON.trash
   ✏️     rename ............. ICON.pencil
   ✓      selected ........... ICON.check
   ✕      clear / close ...... ICON.close
   ⚠️     render error ....... ICON.warn
   ▸      tree twisty ........ ICON.chevron
   +      add ................ ICON.plus
*/
