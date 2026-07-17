// Asset viewer (viewer.html) — a dev tool for inspecting the game's procedural
// assets one at a time. It imports the SAME modules the game runs (models,
// scenery, props), so every mesh here is byte-for-byte what ships in a race —
// the point is to study an asset up close and decide how to improve its look.
//
// Deliberately independent of main.js: no game state, no HUD, no platform seam.
// Rendering is plain lights + MeshStandardMaterial (the game additionally
// applies a toon conversion at race setup, so in-game shading is a touch more
// stylised than here — silhouettes, proportions and palettes are identical).
import * as THREE from "three";
import {
  createCat,
  createKartModel,
  updateCatRig,
  makeNumberTexture,
  CAT_PATTERNS,
  CAT_ACCESSORIES,
  ACCESSORY_LABELS,
  disposeGroup,
} from "./models.js";
import { assetCatalog } from "./scenery.js";
import { makeCrateProp, makeBarrelProp } from "./props.js";
import { toToon, uSunViewNode, uSunColNode } from "./toon.js";

// ---------------------------------------------------------------------------
// Catalog: cats (one per coat pattern, on a fur tone that shows it off),
// accessories (on a plain cat so the accessory is the star), the four kart
// bodies, the knockable props, and everything scenery.js exposes.
// ---------------------------------------------------------------------------
const CAT_FUR = {
  tabby: 0xf0a830, spotted: 0xc8966a, solid: 0x8c9298, tuxedo: 0x2a2a2a,
  snowshoe: 0xf3dcb6, mitted: 0x9aa2a8, point: 0xe8e2d6, calico: 0xfbfbfb, tortie: 0x6b4a2f,
};
const KART_STYLES = ["GP", "Roadster", "Buggy", "Finned"];
const KART_COLORS = [0xe53935, 0x1e88e5, 0x43a047, 0xfdd835];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A cat with its live rig: idle sway + blinking, exactly what updateCatRig
// does at a standstill in-game. The rig is dt-driven, so the driver diffs the
// scrub time (scrubbing backwards holds the pose — the rig can't run in
// reverse, and a held frame is still useful for inspection).
function animatedCat(fur, opts) {
  const cat = createCat(fur, opts);
  const rig = cat.userData.rig;
  let last = 0;
  return {
    object: cat,
    animate: (t) => {
      const dt = Math.max(0, Math.min(0.05, t - last));
      last = t;
      if (dt > 0) updateCatRig(rig, dt, 0, 0, false, false, true);
    },
    duration: 8, // long enough to catch a blink or two
  };
}

const entries = [];
for (const p of CAT_PATTERNS)
  entries.push({ group: "Cats", name: `Cat — ${cap(p)}`, build: () => animatedCat(CAT_FUR[p] ?? 0xf0a830, { pattern: p }) });
for (const a of CAT_ACCESSORIES) {
  if (a === "none") continue;
  entries.push({
    group: "Cat accessories",
    name: ACCESSORY_LABELS[a] || cap(a),
    build: () => animatedCat(0xf0a830, { pattern: "solid", accessory: a }),
  });
}
// A kart with rolling wheels + the front axle sweeping through its steering
// range (the same transforms Kart.update applies from live inputs).
function animatedKart(color, opts) {
  const { group, wheels } = createKartModel(color, opts);
  return {
    object: group,
    animate: (t) => {
      for (let j = 0; j < wheels.length; j++) {
        const w = wheels[j];
        w.rotation.order = "YXZ";
        w.rotation.y = j < 2 ? Math.sin(t * 0.9) * 0.4 : 0;
        w.rotation.x = t * 6;
      }
    },
    duration: Math.PI * 2 / 0.9, // one full steering sweep
  };
}
KART_STYLES.forEach((n, i) =>
  entries.push({ group: "Karts", name: `Kart — ${n}`, build: () => animatedKart(KART_COLORS[i], { style: i, number: i + 1 }) })
);
entries.push({ group: "Props", name: "Crate", build: () => makeCrateProp().mesh });
entries.push({ group: "Props", name: "Barrel", build: () => makeBarrelProp().mesh });
entries.push(...assetCatalog());

// ---------------------------------------------------------------------------
// Renderer / scene (studio setup: hemisphere sky + key + soft fill, ground disc)
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGPURenderer({
  antialias: true,
  forceWebGL: params.has("webgl") || !navigator.gpu,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
await renderer.init();

const main = document.getElementById("main");
main.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2338);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);

// ?plain=1 — hide all UI chrome (sidebar, buttons, info) so screenshot tours
// capture nothing but the asset.
if (params.has("plain")) document.body.classList.add("plain");

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x54493a, 1.1));
const key = new THREE.DirectionalLight(0xfff2dd, 2.4);
key.position.set(6, 10, 7);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9db4e6, 0.7);
fill.position.set(-7, 4, -6);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x27334f, roughness: 1 })
);
ground.position.y = -0.01; // just below the asset's base so coplanar bottoms don't z-fight
scene.add(ground);

// Studio background colour: repaints the sky AND tints the ground disc a
// slightly darker shade of the same colour so the asset sits on a matching
// floor (great for catalog shots on a contrasting backdrop). Reachable from
// the 🎨 picker, a ?bg=RRGGBB param, and window.__viewer.setBackground().
const bgInput = document.getElementById("bg-color");
function setBackground(css) {
  scene.background.set(css);
  ground.material.color.copy(scene.background).multiplyScalar(0.8);
  if (bgInput) bgInput.value = "#" + scene.background.getHexString();
}
bgInput?.addEventListener("input", () => setBackground(bgInput.value));
if (params.get("bg")) setBackground("#" + params.get("bg").replace(/^#/, ""));

function resize() {
  const w = main.clientWidth, h = main.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
// Orbit rig: spherical camera around the framed asset. One finger/mouse drag
// spins (yaw + a clamped tilt), pinch or wheel dollies.
// ---------------------------------------------------------------------------
const orbit = { target: new THREE.Vector3(), radius: 10, minR: 1, maxR: 100, theta: 0.7, phi: 1.12 };
const pointers = new Map(); // active pointerId → {x, y}
let pinchDist = 0;

const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1) {
    orbit.theta -= dx * 0.006;
    orbit.phi = Math.max(0.12, Math.min(Math.PI - 0.12, orbit.phi - dy * 0.005));
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) orbit.radius = clampR(orbit.radius * (pinchDist / d));
    pinchDist = d;
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); pinchDist = 0; };
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  orbit.radius = clampR(orbit.radius * (1 + e.deltaY * 0.0012));
}, { passive: false });
const clampR = (r) => Math.max(orbit.minR, Math.min(orbit.maxR, r));

// --- "Game look": the exact cel-shading conversion the game applies at boot
// (src/toon.js) vs the raw studio materials. Originals are stashed per mesh so
// the toggle swaps back and forth without rebuilding; the toon twins come from
// toon.js's shared cache, exactly like in-game.
const lookBtn = document.getElementById("look-btn");
let gameLook = false;
function applyLook() {
  if (!current) return;
  current.traverse((o) => {
    if (!o.material) return;
    if (gameLook) {
      if (!o.userData._rawMat) o.userData._rawMat = o.material;
      const raw = o.userData._rawMat;
      o.material = Array.isArray(raw) ? raw.map(toToon) : toToon(raw);
    } else if (o.userData._rawMat) {
      o.material = o.userData._rawMat;
    }
  });
}
// Restore raw materials so disposal sees what the builder created (the toon
// twins live in toon.js's cache keyed by the raw material — dropping the raw
// frees both).
function restoreRawMaterials(root) {
  root.traverse((o) => {
    if (o.userData._rawMat) o.material = o.userData._rawMat;
  });
}
function setGameLook(on) {
  gameLook = !!on;
  lookBtn.classList.toggle("on", gameLook);
  // A warm midday-ish sun tint for the rim/backlight/paint-glint terms (the
  // game feeds these from the live mood each frame).
  uSunColNode.value.set(gameLook ? 0xffe6b0 : 0x000000);
  if (gameLook) uSunColNode.value.multiplyScalar(0.6);
  applyLook();
}
lookBtn.addEventListener("click", () => setGameLook(!gameLook));

// ---------------------------------------------------------------------------
// Asset selection: build fresh, sit it on the ground plane, frame the camera
// on its bounding sphere, size the ground disc to it, report mesh/tri counts.
// ---------------------------------------------------------------------------
const infoEl = document.getElementById("info");
const animBar = document.getElementById("anim-bar");
const animPlayBtn = document.getElementById("anim-play");
const animScrub = document.getElementById("anim-scrub");
let current = null;
// Animation transport state: assets that move in-game expose animate(t) over
// one loop of `animDur` seconds; the bar plays/loops it and the scrubber sets
// t directly.
let curAnim = null;
let animDur = 0;
let animT = 0;
let animPlaying = true;
let scrubbing = false;

function refreshAnimPlayBtn() {
  animPlayBtn.textContent = animPlaying ? "⏸" : "▶";
  animPlayBtn.setAttribute("aria-label", animPlaying ? "Pause animation" : "Play animation");
}
animPlayBtn.addEventListener("click", () => {
  animPlaying = !animPlaying;
  refreshAnimPlayBtn();
});
animScrub.addEventListener("input", () => {
  animT = parseFloat(animScrub.value) || 0;
});
animScrub.addEventListener("pointerdown", () => { scrubbing = true; });
window.addEventListener("pointerup", () => { scrubbing = false; });

function show(entry) {
  let res;
  try {
    res = entry.build();
  } catch (err) {
    console.error("[viewer] build failed:", entry.name, err);
    infoEl.textContent = `${entry.name} — failed to build: ${err.message}`;
    return;
  }
  present(entry.name, res);
}
// Swap the stage to an already-built result ({object, animate, duration} or a
// bare Object3D): dispose the old asset, sit the new one on the floor, frame
// the camera on its bounding sphere. Also the entry point for showPreset().
function present(name, res) {
  if (current) {
    scene.remove(current);
    restoreRawMaterials(current); // dispose what the builder created, not the toon twins
    // GLB clones borrow the template's geometry/materials — disposing them
    // would gut the template for every later visit.
    if (!current.userData.keepResources) disposeGroup(current); // shared (cached) materials are skipped
    current = null;
  }
  const obj = res.isObject3D ? res : res.object;
  curAnim = res.isObject3D ? null : res.animate ?? null;
  animDur = (!res.isObject3D && res.duration) || Math.PI * 2;
  animT = 0;
  animPlaying = true;
  refreshAnimPlayBtn();
  animBar.classList.toggle("hidden", !curAnim);
  animScrub.max = animDur.toFixed(3);
  animScrub.value = "0";
  curAnim?.(0); // measure/frame the posed asset
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box.min.y; // feet on the floor
  box.translate(new THREE.Vector3(0, -box.min.y, 0));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(0.6, size.length() / 2);

  orbit.target.copy(center);
  orbit.radius = r * 2.3;
  orbit.minR = r * 0.4;
  orbit.maxR = r * 8;
  ground.scale.setScalar(Math.max(3, r * 1.9));

  scene.add(obj);
  current = obj;
  if (gameLook) applyLook();

  let meshes = 0, tris = 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const verts = g.index ? g.index.count : g.attributes.position?.count || 0;
    tris += Math.round((verts / 3) * (o.isInstancedMesh ? o.count : 1));
  });
  const fmt = (v) => (Math.round(v * 10) / 10).toString();
  infoEl.textContent = `${name} · ${meshes} mesh${meshes === 1 ? "" : "es"} · ${tris.toLocaleString()} tris · ${fmt(size.x)}×${fmt(size.y)}×${fmt(size.z)}`;
}

// ---------------------------------------------------------------------------
// Sidebar list: grouped buttons + text filter. Selecting also closes the
// drawer on phones (where the sidebar overlays the canvas).
// ---------------------------------------------------------------------------
const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const side = document.getElementById("side");
document.getElementById("side-toggle").addEventListener("click", () => side.classList.toggle("open"));
let selectedBtn = null;

function renderList(filter = "") {
  const q = filter.trim().toLowerCase();
  listEl.replaceChildren();
  let group = null;
  for (const entry of entries) {
    if (q && !`${entry.group} ${entry.name}`.toLowerCase().includes(q)) continue;
    if (entry.group !== group) {
      group = entry.group;
      const h = document.createElement("h3");
      h.textContent = group;
      listEl.appendChild(h);
    }
    const b = document.createElement("button");
    b.textContent = entry.name;
    b.addEventListener("click", () => {
      selectedBtn?.classList.remove("selected");
      b.classList.add("selected");
      selectedBtn = b;
      side.classList.remove("open");
      show(entry);
    });
    entry._btn = b;
    listEl.appendChild(b);
  }
}
searchEl.addEventListener("input", () => renderList(searchEl.value));
renderList();

// Open on the first cat so the page never starts empty.
entries[0]?._btn?.click();

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let last = performance.now();
const _sunTravel = new THREE.Vector3();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (gameLook) {
    // Keep the toon rim/backlight sun in view space, like updateAtmosphere
    // does in-game: the key light stands in for the sun.
    _sunTravel.copy(key.position).normalize().negate().transformDirection(camera.matrixWorldInverse);
    uSunViewNode.value.copy(_sunTravel);
  }
  if (curAnim) {
    if (animPlaying && !scrubbing) {
      animT = (animT + dt) % animDur;
      animScrub.value = animT.toFixed(3);
    }
    curAnim(animT);
  }
  const sp = Math.sin(orbit.phi);
  camera.position.set(
    orbit.target.x + orbit.radius * sp * Math.sin(orbit.theta),
    orbit.target.y + orbit.radius * Math.cos(orbit.phi),
    orbit.target.z + orbit.radius * sp * Math.cos(orbit.theta)
  );
  camera.lookAt(orbit.target);
  renderer.render(scene, camera);
});

// Debug hook — headless screenshot tours (tools/catalog-shots.mjs) drive the
// stage through this: show an arbitrary garage preset, recolour the backdrop,
// switch on the game's cel shading, and freeze the animation at a chosen pose.
window.__viewer = {
  orbit, camera, scene,
  setBackground, setGameLook,
  // {kind:"cat", fur, pattern, accessory?} | {kind:"kart", color, style, number}
  showPreset(spec) {
    if (spec.kind === "cat") present(spec.name || "Cat", animatedCat(spec.fur, { pattern: spec.pattern, accessory: spec.accessory }));
    else present(spec.name || "Kart", animatedKart(spec.color, { style: spec.style, number: spec.number }));
  },
  freeze(t = 0) { animPlaying = false; animT = t; curAnim?.(t); refreshAnimPlayBtn(); },
};
console.log(`[zoomies] asset viewer: ${entries.length} assets · ${renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2"}`);
