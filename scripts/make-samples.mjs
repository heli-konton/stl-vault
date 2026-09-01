// Generates a few sample ASCII STL files so the vault has content on first run.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "stls");

function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const len = Math.hypot(...n) || 1;
  return n.map((x) => x / len);
}

function stl(name, tris) {
  let out = `solid ${name}\n`;
  for (const [a, b, c] of tris) {
    const n = normal(a, b, c);
    out += `  facet normal ${n.map((x) => x.toFixed(6)).join(" ")}\n`;
    out += "    outer loop\n";
    for (const p of [a, b, c]) out += `      vertex ${p.map((x) => x.toFixed(6)).join(" ")}\n`;
    out += "    endloop\n  endfacet\n";
  }
  out += `endsolid ${name}\n`;
  return out;
}

function cube(s = 20) {
  const h = s / 2;
  const v = (x, y, z) => [x * h, y * h, z * h];
  const F = [
    [[1, 1, 1], [1, -1, 1], [-1, -1, 1], [-1, 1, 1]],
    [[-1, 1, -1], [-1, -1, -1], [1, -1, -1], [1, 1, -1]],
    [[1, 1, -1], [1, 1, 1], [-1, 1, 1], [-1, 1, -1]],
    [[-1, -1, -1], [-1, -1, 1], [1, -1, 1], [1, -1, -1]],
    [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]],
    [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]],
  ];
  const tris = [];
  for (const [a, b, c, d] of F) {
    tris.push([v(...a), v(...b), v(...c)], [v(...a), v(...c), v(...d)]);
  }
  return tris;
}

function pyramid(s = 22, h = 26) {
  const p = s / 2;
  const base = [[-p, 0, -p], [p, 0, -p], [p, 0, p], [-p, 0, p]];
  const apex = [0, h, 0];
  const tris = [
    [base[0], base[2], base[1]],
    [base[0], base[3], base[2]],
  ];
  for (let i = 0; i < 4; i += 1) tris.push([base[i], base[(i + 1) % 4], apex]);
  return tris;
}

function icosahedron(r = 14) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(...p);
    return p.map((x) => (x / l) * r);
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return faces.map((f) => f.map((i) => verts[i]));
}

function gear(r = 16, teeth = 9, thick = 8) {
  // simple 2D gear outline extruded: alternating outer/inner radii
  const pts = [];
  const steps = teeth * 2;
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.78;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const tris = [];
  const z0 = -thick / 2;
  const z1 = thick / 2;
  for (let i = 0; i < steps; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % steps];
    tris.push([[0, 0, z0], [x2, y2, z0], [x1, y1, z0]]);
    tris.push([[0, 0, z1], [x1, y1, z1], [x2, y2, z1]]);
    tris.push([[x1, y1, z0], [x2, y2, z0], [x2, y2, z1]]);
    tris.push([[x1, y1, z0], [x2, y2, z1], [x1, y1, z1]]);
  }
  return tris;
}

const samples = [
  ["cube.stl", "cube", cube()],
  ["pyramid.stl", "pyramid", pyramid()],
  ["icosahedron.stl", "icosahedron", icosahedron()],
  ["functional/gears/9t-gear.stl", "gear9", gear()],
  ["functional/brackets/cube-bracket.stl", "bracket", cube(14)],
  ["minis/pyramid-mini.stl", "pyramidmini", pyramid(12, 15)],
];

for (const [rel, name, tris] of samples) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, stl(name, tris));
  console.log("wrote", rel);
}
