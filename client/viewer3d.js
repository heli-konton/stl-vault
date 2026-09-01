// viewer3d.js — STL & 3MF loading, offscreen thumbnail rendering, and live previews.

import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const stlLoader = new STLLoader();
const threeMFLoader = new ThreeMFLoader();

// LRU Capped Geometry Cache (Max 8 items in RAM/GPU)
const MAX_CACHE_SIZE = 8;
const geometryCache = new Map(); // "libId:path" -> { promise, geo }

function parse3MF(buf) {
  const group = threeMFLoader.parse(buf);
  const geometries = [];
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      let geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld);
      if (geo.index) {
        geo = geo.toNonIndexed();
      }
      if (geo.attributes.position && geo.attributes.position.count > 0) {
        geometries.push(geo);
      }
    }
  });
  if (geometries.length === 0) throw new Error("No 3D meshes found in 3MF file");
  if (geometries.length === 1) return geometries[0];
  const mergeFn = BufferGeometryUtils.mergeGeometries || BufferGeometryUtils.mergeBufferGeometries;
  const merged = mergeFn ? mergeFn(geometries, false) : geometries[0];
  return merged || geometries[0];
}

function loadGeometry(path, libId = "") {
  const key = `${libId}:${path}`;

  if (geometryCache.has(key)) {
    const entry = geometryCache.get(key);
    // Refresh LRU order
    geometryCache.delete(key);
    geometryCache.set(key, entry);
    return entry.promise;
  }

  // Evict oldest if cache limit reached
  if (geometryCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = geometryCache.keys().next().value;
    const oldest = geometryCache.get(oldestKey);
    if (oldest && oldest.geo) {
      try { oldest.geo.dispose(); } catch {}
    }
    geometryCache.delete(oldestKey);
  }

  const promise = fetch(`/api/file?path=${encodeURIComponent(path)}&lib=${encodeURIComponent(libId)}`)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const is3mf = /\.3mf$/i.test(path);
      const geo = is3mf ? parse3MF(buf) : stlLoader.parse(buf);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (bb) {
        const center = new THREE.Vector3();
        bb.getCenter(center);
        if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
          geo.translate(-center.x, -center.y, -center.z);
        }
      }
      geo.computeBoundingSphere();
      const radius = geo.boundingSphere?.radius;
      const scale = radius && Number.isFinite(radius) && radius > 0 ? 1 / radius : 1;
      geo.scale(scale, scale, scale);
      geo.computeVertexNormals();

      // Store resolved geometry reference for disposal
      const cached = geometryCache.get(key);
      if (cached) cached.geo = geo;
      return geo;
    });

  geometryCache.set(key, { promise, geo: null });
  promise.catch(() => geometryCache.delete(key));
  return promise;
}

function studioMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x8fb6d9, roughness: 0.42, metalness: 0.25 });
}

function addStudioLights(scene) {
  scene.add(new THREE.HemisphereLight(0xd9ecff, 0x1a2230, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 3.5, 2.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fd8ff, 0.9);
  rim.position.set(-2.4, 1.2, -2.6);
  scene.add(rim);
}

// -- offscreen thumbnail factory --------------------------------------------

let thumbRenderer = null;
function getThumbRenderer() {
  if (!thumbRenderer) {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 240;
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(240, 240, false);
  }
  return thumbRenderer;
}

/** Render one model to a transparent PNG data URL. */
export async function renderThumbPng(path, libId = "") {
  const geo = await loadGeometry(path, libId);
  const renderer = getThumbRenderer();
  const scene = new THREE.Scene();
  addStudioLights(scene);
  const mesh = new THREE.Mesh(geo, studioMaterial());
  mesh.rotation.set(-0.42, 0.62, 0);
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  camera.position.set(0, 0.55, 2.9);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  const png = renderer.domElement.toDataURL("image/png");
  mesh.geometry = null;
  if (!png || !png.startsWith("data:image/png;base64,") || png.length < 200) {
    throw new Error("Invalid PNG output");
  }
  return png;
}

/** Ask the server to store a rendered thumbnail. */
export function saveThumb(path, libId, png) {
  return fetch("/api/thumb", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, lib: libId, png }),
  }).catch(() => {});
}

// -- live viewers ------------------------------------------------------------

function makeViewer(container, interactive) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  addStudioLights(scene);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
  camera.position.set(0, 0.6, 3.1);
  camera.lookAt(0, 0, 0);

  function resize() {
    const w = container.clientWidth || (interactive ? 800 : 440);
    const h = container.clientHeight || (interactive ? 600 : 340);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  resize();

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);

  let controls = null;
  if (interactive) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 8;
  }

  const state = { mesh: null, autoRotate: !interactive, raf: 0, disposed: false };

  function frame() {
    if (state.disposed) return;
    if (state.mesh && state.autoRotate) state.mesh.rotation.y += 0.008;
    if (controls) controls.update();
    renderer.render(scene, camera);
    state.raf = requestAnimationFrame(frame);
  }

  return {
    async show(path, libId = "") {
      resize();
      const geo = await loadGeometry(path, libId);
      if (state.disposed) return;
      if (state.mesh) scene.remove(state.mesh);
      state.mesh = new THREE.Mesh(geo, studioMaterial());
      state.mesh.rotation.set(-0.35, 0.5, 0);
      scene.add(state.mesh);
      resize();
      if (!state.raf) frame();
    },
    dispose() {
      state.disposed = true;
      cancelAnimationFrame(state.raf);
      resizeObserver.disconnect();
      controls?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// -- hover pop-out -------------------------------------------------------------

const popview = document.getElementById("popview");
const popCanvasHost = document.getElementById("pviewCanvas");
const popMeta = document.getElementById("pviewMeta");
let popViewer = null;
let popTimer = null;
let popHideTimer = null;

export function attachHoverPreview(cardEl, file, libId = "") {
  // Skip auto hover popout for huge files > 35 MB to keep scrolling fast
  if (file.size && file.size > 35 * 1024 * 1024) return;

  cardEl.addEventListener("mouseenter", () => {
    clearTimeout(popHideTimer);
    popTimer = setTimeout(() => showPop(cardEl, file, libId), 400);
  });
  cardEl.addEventListener("mouseleave", () => {
    clearTimeout(popTimer);
    popHideTimer = setTimeout(hidePop, 140);
  });
}

function showPop(cardEl, file, libId = "") {
  if (!popViewer) popViewer = makeViewer(popCanvasHost, false);
  popMeta.innerHTML = `<b>${file.name}</b><span>${fmtSize(file.size)}</span>`;
  const r = cardEl.getBoundingClientRect();
  let x = r.right + 14;
  if (x + 452 > window.innerWidth) x = r.left - 452;
  if (x < 8) x = window.innerWidth - 452;
  let y = Math.min(Math.max(8, r.top - 40), window.innerHeight - 400);
  popview.style.left = `${x}px`;
  popview.style.top = `${y}px`;
  popview.classList.add("show");
  popViewer.show(file.path, libId);
}

function hidePop() {
  popview.classList.remove("show");
}

// -- pinned modal viewer -------------------------------------------------------

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const modalTitle = document.getElementById("modalTitle");
let modalViewer = null;

export function openModalViewer(file, libId = "") {
  hidePop();
  modalTitle.textContent = file.name;
  modal.classList.add("open");
  if (modalViewer) {
    modalViewer.dispose();
    modalViewer = null;
  }
  const oldCanvas = modalBody.querySelector("canvas");
  if (oldCanvas) oldCanvas.remove();

  modalViewer = makeViewer(modalBody, true);
  modalViewer.show(file.path, libId);
}

export function closeModalViewer() {
  modal.classList.remove("open");
  if (modalViewer) {
    modalViewer.dispose();
    modalViewer = null;
  }
}

document.getElementById("modalClose").addEventListener("click", closeModalViewer);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModalViewer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModalViewer();
});

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
