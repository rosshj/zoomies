import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { createScene } from "./scene.js";
import { Track } from "./track.js";
import { Kart } from "./kart.js";
import { Input } from "./input.js";
import { HairballManager } from "./hairball.js";
import { HUD, ordinal } from "./hud.js";
import { buildWorld } from "./scenery.js";
import { EffectsManager } from "./effects.js";

// The boost meter lives on each kart (kart.boostMeter) so the player and AI
// share identical charge and recharge timing.

const TOTAL_LAPS = 3;

const { renderer, scene, camera } = createScene();
// The main camera sees everything; the rear-view camera stays on layer 0, so
// scenery on layer 1 is skipped in the mirror. Grass is on layer 2 (also out of
// the outline pre-pass, which would otherwise outline every blade).
camera.layers.enable(1);
camera.layers.enable(2);

// --- Post-processing: bloom + filmic output + MSAA ---
const _sz = renderer.getDrawingBufferSize(new THREE.Vector2());
const _composerTarget = new THREE.WebGLRenderTarget(_sz.x, _sz.y, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, _composerTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(_sz.x, _sz.y), 0.6, 0.5, 0.82);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// --- Cartoon outline pass (Phase 2) ---
// A normal-buffer pre-pass detects silhouette/crease edges; this pass draws a
// dark line there. High quality only (it costs a second scene render).
const normalMat = new THREE.MeshNormalMaterial();
const normalTarget = new THREE.WebGLRenderTarget(_sz.x, _sz.y);
// A depth texture, written by the same pre-pass, lets us key outlines off real
// depth discontinuities (object silhouettes) rather than every normal wiggle —
// which is what kept the lines from showing through geometry and scribbling all
// over distant foliage.
normalTarget.depthTexture = new THREE.DepthTexture(_sz.x, _sz.y);
let outlineProps = true; // include the dense roadside props in the outline pass
let outlineScale = 1; // normal-buffer resolution scale
const outlinePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: normalTarget.texture },
    tDepth: { value: normalTarget.depthTexture },
    uTexel: { value: new THREE.Vector2(1 / _sz.x, 1 / _sz.y) },
    uThickness: { value: 1.2 },
    uDepthThresh: { value: 0.025 }, // depth jump, as a fraction of distance
    uNormalThresh: { value: 0.55 }, // only strong creases
    cameraNear: { value: camera.near },
    cameraFar: { value: camera.far },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tNormal; uniform sampler2D tDepth;
    uniform vec2 uTexel; uniform float uThickness;
    uniform float uDepthThresh; uniform float uNormalThresh;
    uniform float cameraNear; uniform float cameraFar;
    varying vec2 vUv;
    // View-space distance from the non-linear depth buffer.
    float linDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x;
      float ndc = z * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) /
             (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
    }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 o = uTexel * uThickness;

      // --- Silhouette edges: big depth jumps between neighbours ---
      float dc = linDepth(vUv);
      float dr = linDepth(vUv + vec2(o.x, 0.0));
      float dl = linDepth(vUv - vec2(o.x, 0.0));
      float du = linDepth(vUv + vec2(0.0, o.y));
      float dd = linDepth(vUv - vec2(0.0, o.y));
      float depthDiff = abs(dc - dr) + abs(dc - dl) + abs(dc - du) + abs(dc - dd);
      // Threshold scales with distance, so a faraway building doesn't scribble
      // and a near kart still gets a crisp line.
      float depthEdge = step(uDepthThresh * dc, depthDiff);

      // --- Crease edges: strong normal changes, only on nearby geometry ---
      vec3 n  = texture2D(tNormal, vUv).rgb;
      vec3 nr = texture2D(tNormal, vUv + vec2(o.x, 0.0)).rgb;
      vec3 nl = texture2D(tNormal, vUv - vec2(o.x, 0.0)).rgb;
      vec3 nu = texture2D(tNormal, vUv + vec2(0.0, o.y)).rgb;
      vec3 nd = texture2D(tNormal, vUv - vec2(0.0, o.y)).rgb;
      float ne = distance(n, nr) + distance(n, nl) + distance(n, nu) + distance(n, nd);
      float near = 1.0 - smoothstep(70.0, 150.0, dc); // fade creases out with distance
      float normalEdge = step(uNormalThresh, ne) * near;

      float edge = max(depthEdge, normalEdge);
      gl_FragColor = vec4(mix(c, vec3(0.04, 0.04, 0.06), edge), 1.0);
    }`,
});
composer.addPass(outlinePass);
// ShaderPass clones the uniforms (cloning the textures too) — repoint tNormal /
// tDepth at the live buffers so the edge detector actually reads them.
outlinePass.uniforms.tNormal.value = normalTarget.texture;
outlinePass.uniforms.tDepth.value = normalTarget.depthTexture;

// Color grade (saturation + contrast + vignette) and chromatic aberration.
// Kept on at all quality levels (cheap) so colors stay vivid; only the bloom is
// gated by quality.
const fxPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uAberr: { value: 0 },
    uVignette: { value: 0.4 },
    uSat: { value: 1.3 },
    uContrast: { value: 1.07 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAberr; uniform float uVignette;
    uniform float uSat; uniform float uContrast; varying vec2 vUv;
    void main(){
      vec2 d = vUv - 0.5;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + d * uAberr).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - d * uAberr).b;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, uSat);          // saturation
      col = (col - 0.5) * uContrast + 0.5;     // contrast
      float vig = smoothstep(0.92, 0.34, length(d));
      col *= mix(1.0, vig, uVignette);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
});
composer.addPass(fxPass);

const track = new Track();
track.totalLaps = TOTAL_LAPS;
track.raceTime = 0;
scene.add(track.group);

const world = buildWorld(scene, track);

// --- Cel shading: convert lit (standard) materials to banded toon shading ---
function makeToonGradient() {
  const steps = new Uint8Array([85, 180, 255]); // 3 bands; shadow defined but not muddy
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const TOON_GRADIENT = makeToonGradient();
function toToon(m) {
  if (!m || !m.isMeshStandardMaterial || (m.userData && m.userData.skipToon)) return m;
  return new THREE.MeshToonMaterial({
    color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
    map: m.map || null,
    gradientMap: TOON_GRADIENT,
    vertexColors: m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity,
    side: m.side,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: m.emissiveMap || null,
    emissiveIntensity: m.emissiveIntensity,
    bumpMap: m.bumpMap || null,
    bumpScale: m.bumpScale,
  });
}
function toonify(root) {
  root.traverse((o) => {
    if (!o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(toToon) : toToon(o.material);
  });
}
toonify(scene);

// --- Rear-view mirror ---
// Render a backward-facing camera into a target, then blit it (flipped, like a
// real mirror) into a small framed box at the top-center of the screen.
const rearCamera = new THREE.PerspectiveCamera(74, 2.5, 0.5, 1200);
const rearRT = new THREE.WebGLRenderTarget(640, 256);
rearRT.texture.colorSpace = THREE.SRGBColorSpace; // match the main view's colors
const mirrorScene = new THREE.Scene();
const mirrorCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mirrorQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: rearRT.texture, depthTest: false, depthWrite: false })
);
mirrorQuad.scale.x = -1; // horizontal flip => proper mirror
mirrorScene.add(mirrorQuad);
const mirrorFrame = document.getElementById("mirror-frame");
let mirrorRect = { x: 0, y: 0, w: 1, h: 1 };

// Steering indicator + recalibrate button
const steerDot = document.getElementById("steer-dot");
document.getElementById("calibrate").addEventListener("click", () => input.calibrate());

const input = new Input();
const hairballs = new HairballManager(scene);
const effects = new EffectsManager(scene);
const hud = new HUD();

// Boost (fart) meter UI reflects the player kart's own meter.
const boostBtn = document.getElementById("btn-boost");
const boostFill = document.getElementById("boost-fill");
function updateBoostUI() {
  const m = player ? player.boostMeter : 0;
  boostFill.style.height = `${Math.round(m * 100)}%`;
  boostBtn.classList.toggle("disabled", m < 1); // only fire when full
}

// --- Karts: 1 player + 5 AI rivals ---
const ROSTER = [
  { name: "You", color: 0xe53935, catColor: 0xf0a830, isPlayer: true, skill: 1.0 },
  { name: "Mittens", color: 0x1e88e5, catColor: 0x9e9e9e, skill: 1.03 },
  { name: "Whiskers", color: 0x43a047, catColor: 0x3e2723, skill: 1.05 },
  { name: "Pumpkin", color: 0xfb8c00, catColor: 0xffffff, skill: 1.0 },
  { name: "Shadow", color: 0x8e24aa, catColor: 0x212121, skill: 1.06 },
  { name: "Biscuit", color: 0xfdd835, catColor: 0xd7a86e, skill: 1.02 },
];

let karts = [];
let player = null;

function buildKarts() {
  for (const k of karts) scene.remove(k.group);
  karts = [];
  ROSTER.forEach((cfg, i) => {
    const kart = new Kart(cfg);
    const slot = track.gridSlot(i);
    kart.placeAt(slot.position, slot.heading, track);
    kart._aiShootTimer = 1 + Math.random() * 3;
    toonify(kart.group); // cel-shade the kart + cat
    scene.add(kart.group);
    karts.push(kart);
    if (cfg.isPlayer) player = kart;
  });
}

// --- Game state ---
const State = { MENU: 0, COUNTDOWN: 1, RACING: 2, FINISHED: 3, PAUSED: 4 };
let state = State.MENU;
let countdown = 0;
let raceTime = 0;
let countdownCalibrated = false;

// --- Stage / orientation ---
// We render at the true viewport size (no CSS rotation — that caused cutoff and
// gaps on iOS) and show a "rotate to landscape" prompt when held in portrait.
const stage = document.getElementById("stage");
const rotateEl = document.getElementById("rotate");
const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
let stageState = { iw: 1, ih: 1, W: 1, H: 1, rot: 0 };

function layoutStage() {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  const rawAngle =
    (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  const a = ((rawAngle % 360) + 360) % 360;
  const portrait = ih > iw;

  // Lock to landscape: when the viewport is portrait, counter-rotate the stage
  // so the game always presents in landscape. Children are position:absolute so
  // they rotate/fill with the stage (Safari mis-handles position:fixed here).
  const rot = portrait ? (a === 180 ? 270 : 90) : 0;
  const W = Math.max(iw, ih);
  const H = Math.min(iw, ih);
  stageState = { iw, ih, W, H, rot };
  rotateEl.classList.add("hidden"); // forced landscape — never prompt

  stage.style.width = W + "px";
  stage.style.height = H + "px";
  stage.style.left = "50%";
  stage.style.top = "50%";
  stage.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;

  // Remap the physical safe-area insets into the rotated stage's frame so the
  // HUD avoids the notch / home bar on the correct visual edges.
  const vi = readViewportInsets();
  let st, sr, sb, sl;
  if (rot === 90) [st, sr, sb, sl] = [vi.right, vi.bottom, vi.left, vi.top];
  else if (rot === 270) [st, sr, sb, sl] = [vi.left, vi.top, vi.right, vi.bottom];
  else [st, sr, sb, sl] = [vi.top, vi.right, vi.bottom, vi.left];
  stage.style.setProperty("--safe-top", `${st}px`);
  stage.style.setProperty("--safe-right", `${sr}px`);
  stage.style.setProperty("--safe-bottom", `${sb}px`);
  stage.style.setProperty("--safe-left", `${sl}px`);

  renderer.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(W, H);
  const dpr = renderer.getPixelRatio();
  const nw = Math.round(W * dpr * outlineScale);
  const nh = Math.round(H * dpr * outlineScale);
  normalTarget.setSize(nw, nh);
  outlinePass.uniforms.uTexel.value.set(1 / nw, 1 / nh);

  // Mirror box: top-center (small), kept clear of the top safe inset.
  const mw = Math.min(150, W * 0.17);
  const mh = mw * 0.4;
  const mleft = (W - mw) / 2;
  const mtop = Math.max(8, st + 4);
  const B = 3; // must match the #mirror-frame border width in CSS
  mirrorRect = { x: mleft + B, y: H - mtop - mh + B, w: mw - 2 * B, h: mh - 2 * B };
  if (mirrorFrame) {
    mirrorFrame.style.width = `${mw}px`;
    mirrorFrame.style.height = `${mh}px`;
    mirrorFrame.style.left = `${mleft}px`;
    mirrorFrame.style.top = `${mtop}px`;
  }
}

// Reads the live safe-area-inset-* values (in px) via a hidden probe element.
let _safeProbe = null;
function readViewportInsets() {
  if (!_safeProbe) {
    _safeProbe = document.createElement("div");
    _safeProbe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
      "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
    document.body.appendChild(_safeProbe);
  }
  const s = getComputedStyle(_safeProbe);
  return {
    top: parseFloat(s.paddingTop) || 0,
    right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0,
    left: parseFloat(s.paddingLeft) || 0,
  };
}

let mirrorTick = 0;
function renderMirror() {
  // Re-render the rear view every other frame (still blit every frame, so no
  // flicker) to keep the second scene render affordable on phones.
  if (mirrorTick++ % 2 === 0) {
    const fwd = new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
    rearCamera.position
      .copy(player.position)
      .addScaledVector(fwd, 1.5)
      .add(new THREE.Vector3(0, 4.5, 0));
    rearCamera.lookAt(
      new THREE.Vector3().copy(player.position).addScaledVector(fwd, -25).setY(player.position.y + 3)
    );

    renderer.autoClear = true;
    renderer.setRenderTarget(rearRT);
    renderer.render(scene, rearCamera);
    renderer.setRenderTarget(null);
  }

  // Blit the (flipped) mirror texture into just the mirror box.
  renderer.autoClear = false;
  renderer.setViewport(mirrorRect.x, mirrorRect.y, mirrorRect.w, mirrorRect.h);
  renderer.setScissor(mirrorRect.x, mirrorRect.y, mirrorRect.w, mirrorRect.h);
  renderer.setScissorTest(true);
  renderer.render(mirrorScene, mirrorCam);
  renderer.setScissorTest(false);
  renderer.autoClear = true;
  renderer.setViewport(0, 0, stageState.W, stageState.H);
}

// Render the main view (through the post-processing composer), then overlay the
// raw rear-view mirror while playing.
function renderFrame() {
  if (outlinePass.enabled) {
    camera.layers.disable(2); // never outline grass blades
    if (!outlineProps) camera.layers.disable(1); // skip dense props on Low
    scene.overrideMaterial = normalMat;
    renderer.setRenderTarget(normalTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    camera.layers.enable(2);
    if (!outlineProps) camera.layers.enable(1);
  }
  composer.render();
  if (player && state !== State.MENU) renderMirror();
}

// Inverse of the stage transform: viewport point -> stage-local point.
function stageToLocal(clientX, clientY) {
  const { iw, ih, W, H, rot } = stageState;
  const dx = clientX - iw / 2;
  const dy = clientY - ih / 2;
  const r = (-rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: dx * cos - dy * sin + W / 2, y: dx * sin + dy * cos + H / 2 };
}

input.setStageMapper(stageToLocal);
window.addEventListener("resize", layoutStage);
window.addEventListener("orientationchange", layoutStage);
layoutStage();

// --- Hit feedback (shake + white flash) ---
const flashEl = document.getElementById("flash");
function triggerHit() {
  shakeMag = 1.6;
  if (flashEl) {
    flashEl.classList.remove("on");
    void flashEl.offsetWidth; // restart the CSS flash
    flashEl.classList.add("on");
  }
}

// --- Graphics quality toggle (heavy effects off on Low) ---
let quality = isTouch ? "low" : "high";
const qualityBtn = document.getElementById("quality-btn");
function applyQuality(q) {
  quality = q;
  const high = q === "high";
  bloomPass.enabled = high; // bloom (the expensive part) only on High
  // Outlines stay on for both; on Low they render at reduced res and skip the
  // dense roadside props to keep the 2nd scene pass cheap.
  outlineProps = high;
  outlineScale = high ? 1 : 0.6;
  // fxPass (colour grade) stays on at all levels so colours stay vivid.
  if (world.grass) world.grass.visible = high;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1.25));
  if (qualityBtn) qualityBtn.textContent = `Graphics: ${high ? "High" : "Low"}`;
  layoutStage();
}
if (qualityBtn)
  qualityBtn.addEventListener("click", () => applyQuality(quality === "high" ? "low" : "high"));
applyQuality(quality);

// On Android, also try a real orientation lock (best-effort; iOS ignores it).
function lockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } catch (e) {
    /* unsupported */
  }
}
function enterFullscreenLandscape() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  try {
    if (req) {
      Promise.resolve(req.call(el)).then(lockLandscape, lockLandscape);
    } else {
      lockLandscape();
    }
  } catch (e) {
    lockLandscape();
  }
}

// --- Pause wiring ---
const pauseOverlay = document.getElementById("pause-overlay");
function pauseGame() {
  if (state !== State.RACING) return;
  state = State.PAUSED;
  pauseOverlay.classList.remove("hidden");
}
function resumeGame() {
  if (state !== State.PAUSED) return;
  pauseOverlay.classList.add("hidden");
  state = State.RACING;
}
function toMenu() {
  pauseOverlay.classList.add("hidden");
  document.getElementById("hud").classList.add("hidden");
  document.getElementById("menu").classList.remove("hidden");
  state = State.MENU;
}
document.getElementById("btn-pause").addEventListener("click", pauseGame);
document.getElementById("resume-btn").addEventListener("click", resumeGame);
document.getElementById("menu-btn").addEventListener("click", toMenu);

// Tilt indicator (hidden by default; toggle in the pause menu).
const steerBar = document.getElementById("steer-bar");
const indicatorBtn = document.getElementById("indicator-btn");
let showIndicator = false;
function applyIndicator() {
  if (steerBar) steerBar.style.display = showIndicator ? "block" : "none";
  if (indicatorBtn) indicatorBtn.textContent = `Tilt indicator: ${showIndicator ? "On" : "Off"}`;
}
if (indicatorBtn)
  indicatorBtn.addEventListener("click", () => {
    showIndicator = !showIndicator;
    applyIndicator();
  });
applyIndicator();
window.addEventListener("keydown", (e) => {
  if (e.code === "Escape" || e.code === "KeyP") {
    if (state === State.RACING) pauseGame();
    else if (state === State.PAUSED) resumeGame();
  }
});

// --- Menu wiring ---
document.getElementById("start-btn").addEventListener("click", startRace);
document.getElementById("restart-btn").addEventListener("click", startRace);

function startRace() {
  // These need the user-gesture from the click, so fire them synchronously.
  enterFullscreenLandscape();
  input.enableMotion();
  input.calibrate();
  input.jumpHeld = false; // clear any held state from a previous run
  input.shielding = false;

  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");

  buildKarts();
  updateBoostUI(); // karts start with an empty boost meter
  raceTime = 0;
  track.raceTime = 0;
  countdown = 3.999;
  countdownCalibrated = false;
  state = State.COUNTDOWN;
}

// --- Camera follow ---
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
let shakeMag = 0;
function updateCamera(dt, snap = false) {
  const fwd = new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
  const desired = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(fwd, -13)
    .add(new THREE.Vector3(0, 7 + player.y * 0.5, 0));
  const look = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(fwd, 6)
    .add(new THREE.Vector3(0, 1.5 + player.y, 0));

  const lerp = snap ? 1 : 1 - Math.pow(0.001, dt);
  camPos.lerp(desired, lerp);
  camTarget.lerp(look, lerp);

  // FOV kick when boosting for a sense of speed.
  const targetFov = 62 + (player.boosting ? 7 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
  camera.updateProjectionMatrix();

  // Screen shake (decays).
  shakeMag *= 1 - Math.min(1, 6 * dt);
  camera.position.copy(camPos);
  if (shakeMag > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeMag;
    camera.position.y += (Math.random() - 0.5) * shakeMag;
  }
  camera.lookAt(camTarget);
}

// --- Kart-vs-kart bumper collisions ---
// Heavier karts (the player) shove lighter ones aside and barely slow down, so
// you can push your way through traffic. Impulses go into each kart's decaying
// `knock` velocity for a springy bumper-car feel.
function resolveCollisions() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const min = 4.4;
      if (distSq <= 0.0001 || distSq >= min * min) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = min - dist;

      const ima = 1 / a.mass;
      const imb = 1 / b.mass;
      const inv = ima + imb;
      const sa = ima / inv; // a's share of the push (lighter moves more)
      const sb = imb / inv;

      // Separate so they don't overlap.
      a.position.x -= nx * overlap * sa;
      a.position.z -= nz * overlap * sa;
      b.position.x += nx * overlap * sb;
      b.position.z += nz * overlap * sb;

      // Bumper impulse scaled by how fast they're moving.
      const power = 10 + (Math.abs(a.speed) + Math.abs(b.speed)) * 0.4;
      a.knock.x -= nx * power * sa;
      a.knock.z -= nz * power * sa;
      b.knock.x += nx * power * sb;
      b.knock.z += nz * power * sb;

      // Only a tiny speed scrub — you keep your momentum through contact.
      a.speed *= 0.99;
      b.speed *= 0.99;
    }
  }
}

// --- Placement ---
function updatePlacement() {
  const order = [...karts].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.totalProgress - a.totalProgress;
  });
  order.forEach((k, idx) => (k.place = idx + 1));
}

// --- AI actions: catch-up, shooting + fart boosts ---
function aiActions(dt) {
  for (const k of karts) {
    if (k.isPlayer) continue;

    // Rubber-band: trailing karts run a little faster, leaders a little slower,
    // to keep the pack competitive.
    const gap = player.totalProgress - k.totalProgress;
    k.maxSpeed = k.baseMaxSpeed * (1 + Math.max(-0.06, Math.min(0.16, gap * 0.12)));

    if (k.boosting) effects.trickle(k);
    if (k.finished || k.spinTimer > 0) continue;

    // Fire a fart boost only when the meter is full (same as the player), and
    // preferably on a straight.
    if (k.boostMeter >= 1 && Math.abs(k.steerInput) < 0.45 && k.speed > 8 && !k.boosting) {
      if (k.fartBoost()) {
        k.boostMeter = 0;
        effects.fartBurst(k);
      }
    }

    // Fire more often, with a slightly wider/longer reach.
    k._aiShootTimer -= dt;
    if (k._aiShootTimer > 0) continue;
    k._aiShootTimer = 1.4 + Math.random() * 2.6;
    const fwd = new THREE.Vector3(Math.sin(k.heading), 0, Math.cos(k.heading));
    for (const other of karts) {
      if (other === k || other.finished) continue;
      const to = new THREE.Vector3().subVectors(other.position, k.position);
      const dist = to.length();
      if (dist > 3 && dist < 44 && to.normalize().dot(fwd) > 0.82) {
        hairballs.spawn(k);
        break;
      }
    }
  }
}

// --- Results ---
function showResults() {
  state = State.FINISHED;
  updatePlacement();
  const order = [...karts].sort((a, b) => a.place - b.place);
  const list = document.getElementById("results-list");
  list.innerHTML = "";
  order.forEach((k) => {
    const li = document.createElement("li");
    const time = k.finished ? ` — ${formatClock(k.finishTime)}` : " — DNF";
    li.textContent = `${ordinal(k.place)}  ${k.name}${time}`;
    if (k.isPlayer) li.className = "you";
    list.appendChild(li);
  });
  document.getElementById("results-title").textContent =
    player.place === 1 ? "🏆 You Win!" : `🏁 ${ordinal(player.place)} Place`;
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("results").classList.remove("hidden");
}

function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// --- Main loop ---
let last = performance.now();
let prevPlayerLap = -1;
let prevPlayerSpin = 0;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05); // clamp big frame gaps

  world.update(now / 1000); // drift the balloons

  if (state === State.PAUSED) {
    renderFrame(); // hold the frozen frame behind the overlay
    return;
  }

  if (state === State.COUNTDOWN) {
    countdown -= dt;
    updateCamera(dt, camPos.lengthSq() === 0);
    const n = Math.ceil(countdown - 1);
    hud.showToast(n > 0 ? `${n}` : "GO!");
    // Re-zero steering near the end of the countdown, once the player has
    // settled into their driving grip.
    if (n === 1 && !countdownCalibrated) {
      input.calibrate();
      countdownCalibrated = true;
    }
    if (countdown <= 0) {
      state = State.RACING;
    }
    renderFrame();
    return;
  }

  if (state === State.RACING) {
    raceTime += dt;
    track.raceTime = raceTime;

    // Player controls
    input.update(dt);
    player.steerInput = input.steer;
    player.throttleInput = input.throttle;
    player.shielding = input.shielding;
    player.driftHeld = input.jumpHeld;
    steerDot.style.transform = `translateX(${input.steer * 80}px)`;
    if (input.consumeJump()) player.jump();
    if (input.consumeShoot() && player.shootCooldown <= 0) {
      hairballs.spawn(player);
      player.shootCooldown = 0.6;
    }
    if (input.consumeBoost() && player.boostMeter >= 1) {
      if (player.fartBoost()) {
        player.boostMeter = 0; // fully deplete on use
        effects.fartBurst(player);
      }
    }
    updateBoostUI();

    // Rainbow boost trail + drift sparks/skids for the player.
    if (player.boosting) effects.trickle(player);
    if (player.drifting) {
      effects.driftSparks(player);
      effects.skid(player);
    }
    // Chromatic aberration ramps up with the boost.
    const aberrTarget = player.boosting ? 0.008 : 0;
    fxPass.uniforms.uAberr.value += (aberrTarget - fxPass.uniforms.uAberr.value) * Math.min(1, dt * 6);

    // AI
    for (const k of karts) if (!k.isPlayer) k.driveAI(track);
    aiActions(dt);

    // Step physics
    for (const k of karts) k.update(dt, track);
    resolveCollisions();
    hairballs.update(dt, karts);
    // Sparks where a kart scraped a railing; skid marks while spinning out.
    for (const k of karts) {
      if (k.wallHit) {
        effects.wallSparks(k);
        k.wallHit = false;
      }
      if (k.spinTimer > 0) effects.skid(k);
    }
    effects.update(dt);
    updatePlacement();

    // Screen shake + flash when the player gets spun out.
    if (player.spinTimer > 0 && prevPlayerSpin <= 0) triggerHit();
    prevPlayerSpin = player.spinTimer;

    // Lap toast for the player
    if (player.lap !== prevPlayerLap && player.lap >= 1 && !player.finished) {
      const lapNum = player.displayLap(TOTAL_LAPS);
      if (lapNum >= 2) hud.showToast(`Lap ${lapNum}/${TOTAL_LAPS}`);
    }
    prevPlayerLap = player.lap;

    // HUD
    hud.update({
      lapNum: player.displayLap(TOTAL_LAPS),
      totalLaps: TOTAL_LAPS,
      place: player.place,
      totalKarts: karts.length,
      speedKmh: Math.abs(player.speed) * 3.0,
      time: raceTime,
    });

    updateCamera(dt);

    // End the race shortly after the player finishes.
    if (player.finished) {
      hud.showToast("FINISH!");
      setTimeout(showResults, 1500);
      state = State.FINISHED; // freeze input; karts keep coasting in loop below
    }
  }

  if (state === State.FINISHED) {
    // Let karts coast to a stop and keep the camera alive.
    for (const k of karts) k.update(dt, track);
    effects.update(dt);
    updateCamera(dt);
  }

  renderFrame();
}

requestAnimationFrame(loop);
