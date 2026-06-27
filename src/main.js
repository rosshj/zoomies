import * as THREE from "three";
// WebGPU post-processing (M4): TSL node graph via PostProcessing, replacing the
// legacy EffectComposer chain.
import { pass, mix, vec3, float, smoothstep, luminance, saturation, viewportUV, uniform, color as tslColor, normalView, positionViewDirection, Fn, Loop, If, rtt, mrt, output, metalness } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { createScene, moodForTimeOfDay } from "./scene.js";
import { initGpuParticles } from "./gpuparticles.js";
import { Weather } from "./weather.js";
import { Track, previewLoopPoints } from "./track.js";
import { Kart } from "./kart.js";
import { setLightLevel } from "./models.js";
import { initProps } from "./props.js";
import { Input } from "./input.js";
import { HairballManager } from "./hairball.js";
import { HUD, ordinal } from "./hud.js";
import { buildWorld, biomeWeatherAt, biomeRoadStyle } from "./scenery.js";
import { EffectsManager } from "./effects.js";
import { setSeed, getSeed, randomSeed, makeRng } from "./rng.js";
import { Net } from "./net/net.js";
import { createPartyTransport } from "./net/partysocket.js";
import { createAblyTransport } from "./net/ably.js";
import { resolveHost, resolveAblyKey } from "./net/config.js";
import { RemoteKart, FLAG, INTERP_DELAY } from "./remotekart.js";
import { audio } from "./audio.js";

// World seed. A `?seed=CODE` in the URL reproduces an exact track + landscape
// (the basis for multiplayer: everyone in a lobby builds from the same seed).
// We deliberately do NOT write a freshly-minted seed back into the URL: doing so
// let an installed PWA capture that seed as its launch URL and then reuse it
// forever (you'd be stuck on one old code/world). Multiplayer sets ?seed itself
// when hosting or joining, so sharing still works; solo just mints a fresh code.
// Track recipe (procedural generation knobs), persisted locally. mode "classic"
// = the hand-authored circuit; mode "custom" = a generated loop from the knobs,
// with its own stored seed so it reproduces across reloads until you reroll.
const TRACK_KEY = "zoomies-track-v1";
function loadTrackConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(TRACK_KEY));
    if (c && typeof c === "object" && c.mode) return c;
  } catch {
    /* ignore */
  }
  return { mode: "classic" };
}
function saveTrackConfig(c) {
  try {
    localStorage.setItem(TRACK_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
const trackConfig = loadTrackConfig();

const _seedParam = new URLSearchParams(location.search).get("seed");
const WORLD_SEED = (
  (trackConfig.mode === "custom" && trackConfig.seed) ||
  _seedParam ||
  randomSeed()
).toUpperCase();
setSeed(WORLD_SEED);
console.log(`[zoomies] world seed: ${getSeed()} · track: ${trackConfig.mode}`);

// Time of day for this world. "random" (and the default) rolls one per seed via
// an ISOLATED stream so it's identical for everyone on a seed (multiplayer) yet
// never disturbs the shared world-build stream that shapes the track. The world
// and its lighting are built for this once, so the menu already shows it.
const TODS = ["midday", "sunset", "night"];
function resolveTimeOfDay(cfg) {
  const forced = new URLSearchParams(location.search).get("tod"); // debug/test override
  if (forced && TODS.includes(forced)) return forced;
  const t = cfg.timeOfDay || "midday";
  if (t === "midday" || t === "sunset" || t === "night") return t;
  return TODS[Math.floor(makeRng(WORLD_SEED + "|tod")() * TODS.length)]; // "random"
}
const TIME_OF_DAY = resolveTimeOfDay(trackConfig);
// How lit the world is: night fully, sunset at a warm dusk level, midday off. Used
// to bring lamps/string lights/headlights on (dimmer) at sunset too.
const LIGHT_LEVEL = TIME_OF_DAY === "night" ? 1 : TIME_OF_DAY === "sunset" ? 0.55 : 0;
setLightLevel(LIGHT_LEVEL); // karts' headlight bulbs glow (and underglow at night)

// Background music. ONE looping track drives both the menu and the race, under a
// single name so moving menu<->race never swaps audio elements (that swap left a
// gap / a rejected play() — "music sometimes didn't start"). Night worlds get
// their own moodier track.
const MUSIC_TRACK =
  TIME_OF_DAY === "night" ? "./assets/music/zoomieslevel1.mp3" : "./assets/music/zoomies.mp3";
audio.registerMusic("bg", MUSIC_TRACK);

// The boost meter lives on each kart (kart.boostMeter) so the player and AI
// share identical charge and recharge timing.

let TOTAL_LAPS = 3; // race length (1-5), chosen on the main menu

const { renderer, scene, camera, sun, applyMood, ready: rendererReady } = createScene();
let _rendererReady = false; // flips true once WebGPURenderer.init() resolves
// Light the world for this race's time of day up front, so the menu's live
// backdrop already shows midday / sunset / night.
const MOOD = moodForTimeOfDay(TIME_OF_DAY);
applyMood(MOOD);
const weather = new Weather(scene);
let moodSat = MOOD.sat; // this race's base saturation (rain desaturates from it)
let moodExposure = MOOD.exposure; // this race's base exposure (rain darkens from it)
// The main camera sees everything; the rear-view camera stays on layer 0, so
// scenery on layer 1 and grass on layer 2 are skipped in the mirror.
camera.layers.enable(1);
camera.layers.enable(2);

// --- Post-processing (M4/M4b WebGPU): TSL node graph ---
// PostProcessing runs a node graph instead of the legacy EffectComposer. The graph
// is: scene pass -> + god-ray shafts -> + bloom -> saturation -> contrast ->
// warm/cool split-tone -> vignette. (Lens-flare + radial-blur/aberration are still
// deferred stubs.) bloomPass exposes strength/threshold as getter/setters onto the
// bloom node's uniforms so the existing snow-blend modulation keeps working.
const postProcessing = new THREE.PostProcessing(renderer);
const _scenePass = pass(scene, camera);
// MRT: also render view normals + metalness so screen-space reflections (SSR) can
// reflect the scene on metallic surfaces (the lakes — see scenery water material).
_scenePass.setMRT(mrt({ output, normal: normalView, metalness }));
const _sceneTex = _scenePass.getTextureNode("output");
const _sceneNormal = _scenePass.getTextureNode("normal");
const _sceneMetal = _scenePass.getTextureNode("metalness");
const _sceneDepthTex = _scenePass.getTextureNode("depth");
const _bloomNode = bloom(_sceneTex, 0.32, 0.5, 0.9); // strength 0.45->0.32, threshold 0.85->0.9: less midday wash
// Screen-space reflections — optimized: half internal resolution, a modest reflect
// distance, only on metallic pixels (water). The reflection texture is added over
// the scene. This is the heaviest effect; gate/tune if it costs too much.
const _ssrPass = ssr(_sceneTex, _sceneDepthTex, _sceneNormal, _sceneMetal, camera);
_ssrPass.resolutionScale = 0.5; // half-res SSR (already the node default)
_ssrPass.maxDistance.value = 44; // 60 -> 44: shorter rays = fewer march steps (the heaviest effect); water reflections still read at lake scale
_ssrPass.thickness.value = 0.4;
_ssrPass.opacity.value = 0.85;
const _ssrTex = _ssrPass.getTextureNode();
// Grade: the scene was reading washed out (esp. midday), so push saturation +
// contrast and pull the shadow-lift back to a sliver — punchier without crushing.
const _uSat = uniform(MOOD.sat * 1.14);
const _uContrast = uniform(MOOD.contrast * 1.07);
const _uVignette = uniform(0.12); // eased — corners were reading too dark
// Shadow-lift is time-of-day aware: midday wants almost none (it was washing out),
// but sunset/night read too dark in the shadowed areas, so lift their darks more.
// Night/sunset brightness now comes mostly from exposure + ambient (see MOODS), so
// keep the shadow-lift modest here — too much lift greyed the blacks (washed out).
const _shadowLiftTOD = TIME_OF_DAY === "night" ? 0.045 : TIME_OF_DAY === "sunset" ? 0.04 : 0.02;
const _uShadowLift = uniform(_shadowLiftTOD);
// (Depth-of-field removed for frame rate — it was a per-frame 16-tap blur plus a
// full-screen copy. The look held up fine without it.)
// God-ray uniforms (driven each frame by updateAtmosphere via godrayPass.uniforms).
const _uGSun = uniform(new THREE.Vector2(0.5, 0.7));
const _uGVis = uniform(0);
const _uGColor = uniform(new THREE.Color(0xffe6b0));
const _uGWeight = uniform(MOOD.rayWeight ?? 1.05);
// Screen-space god-rays: a radial blur of the bright sky toward the sun's screen
// position. NOTE (perf): unlike the old WebGL pass (skipped when the sun was
// hidden), this runs every frame — uVis just scales the result to 0. Accepted for
// now; revisit if it costs too much on the WebGL2 fallback backend.
const _GN = 10, _gDensity = 0.92, _gDecay = 0.9, _gThreshold = 0.67; // 22 -> 14 -> 10 samples: facing the sun was the worst frame-rate hit (this loop runs per-pixel only then); longer step + tighter decay keep the shaft length
// Returns JUST the additive shaft contribution (not the scene), so it can be
// rendered at HALF resolution and added back to the full-res scene — god-rays are
// soft/low-frequency, so half-res is ~4x cheaper and nearly indistinguishable.
const _godrayShafts = Fn(() => {
  const add = vec3(0).toVar();
  // PERF: only run the sample loop when the sun is actually visible. uVis is a
  // uniform (same for every pixel), so this branch is coherent — the GPU skips the
  // whole loop with no divergence cost. Makes god-rays FREE at night / facing away.
  If(_uGVis.greaterThan(0.001), () => {
    const delta = viewportUV.sub(_uGSun).mul(_gDensity / _GN);
    // jitter the start so the low sample count reads as fine noise, not banded spokes
    const jitter = viewportUV.x.mul(12.9898).add(viewportUV.y.mul(78.233)).sin().mul(43758.5453).fract();
    const coord = viewportUV.sub(delta.mul(jitter)).toVar();
    const illum = float(1).toVar();
    const accum = vec3(0).toVar();
    Loop(_GN, () => {
      coord.subAssign(delta);
      // Clamp the sampled scene to LDR first. The old WebGL pass ran on the
      // tone-mapped image; here the scene pass is raw HDR (the sun is 2-3x bright),
      // so without this the shafts blow out into "crazy rays".
      const s = _sceneTex.uv(coord.clamp(0, 1)).rgb.clamp(0, 1);
      const l = s.r.max(s.g).max(s.b).sub(_gThreshold).max(0);
      accum.addAssign(s.mul(l).mul(illum));
      illum.mulAssign(_gDecay);
    });
    const raw = accum.mul(_uGWeight.div(_GN)).mul(_uGColor).mul(_uGVis);
    // Soft saturation toward a cap (no hard clamp edge) so the glow rolls off smoothly.
    const cap = vec3(0.6);
    add.assign(cap.mul(float(1).sub(raw.div(cap).negate().exp())));
  });
  return add; // shafts only
});
// Render the shafts to a half-resolution target (cheap), then composite over the
// full-res scene. autoUpdate re-renders them each frame; the If-gate keeps it a
// cheap black fill when the sun isn't visible.
const _shaftTex = rtt(_godrayShafts());
_shaftTex.pixelRatio = 0.42; // 0.5 -> 0.42: shafts are soft/low-frequency, so a slightly lower-res target trims the sun-facing cost further with no visible change
{
  let c = _sceneTex.add(_ssrTex).add(_shaftTex).add(_bloomNode); // scene + SSR reflections + shafts + bloom
  c = saturation(c, _uSat);
  c = c.sub(0.5).mul(_uContrast).add(0.5); // contrast around mid-grey
  // Lift the darkest areas so shadows don't crush to near-black (adds most to the
  // darks, ~nothing to the highlights).
  c = c.add(_uShadowLift.mul(c.clamp(0, 1).oneMinus()));
  const lum = luminance(c.clamp(0, 1));
  // Cinematic split-tone: cool shadows, warm highlights. (Cool softened so it
  // doesn't darken the shadows as much.)
  c = c.mul(mix(vec3(0.96, 0.99, 1.06), vec3(1.08, 1.02, 0.92), smoothstep(0.15, 0.85, lum)));
  const d = viewportUV.sub(0.5);
  const vig = smoothstep(0.92, 0.34, d.length());
  c = c.mul(mix(float(1), vig, _uVignette));
  postProcessing.outputNode = c;
}
// composer shim: renderFrame() calls composer.render(); drive the node graph.
const composer = {
  render() { postProcessing.render(); },
  setSize() {},
  setPixelRatio() {},
  addPass() {},
};
const bloomPass = {
  enabled: true,
  setSize() {},
  get strength() { return _bloomNode.strength.value; },
  set strength(v) { _bloomNode.strength.value = v; },
  get threshold() { return _bloomNode.threshold.value; },
  set threshold(v) { _bloomNode.threshold.value = v; },
};
const BLOOM_STRENGTH = bloomPass.strength; // base values; eased down on bright snow
const BLOOM_THRESHOLD = bloomPass.threshold;
let _snowBlend = 0; // 0..1, smoothed, how deep into the white snow section we are
let _lightning = 0; // current lightning-flash intensity (decays each frame)
let _lightningNext = 6 + Math.random() * 10; // seconds until the next strike (while raining)
// godrayPass: the uniform fields are now the LIVE god-ray nodes, so the existing
// updateAtmosphere/prepareRace writes (uSun/uVis/uColor/uWeight) drive the shafts.
// (enabled is a harmless no-op — uVis=0 already zeroes the contribution.)
const _passStub = (uniforms) => ({ enabled: false, setSize() {}, uniforms });
const godrayPass = { enabled: true, setSize() {}, uniforms: {
  uSun: _uGSun, uVis: _uGVis, uColor: _uGColor, uWeight: _uGWeight,
} };
const flarePass = _passStub({ uVis: { value: 0 } });
const fxPass = _passStub({
  uAberr: { value: 0 },
  uRadial: { value: 0 },
  uVignette: _uVignette,
  uSat: _uSat,
  uContrast: _uContrast,
});

const track = new Track(trackConfig.mode === "custom" ? trackConfig : null);
track.totalLaps = TOTAL_LAPS;
track.raceTime = 0;
scene.add(track.group);

const world = buildWorld(scene, track, { timeOfDay: TIME_OF_DAY });

// Knockable roadside props (crates/barrels/leaf piles). Best-effort: if it fails
// to build, `props` stays null and the game is fine. Smashing a green CATNIP crate
// grants that kart an 8s hands-free green boost.
let props = null;
initProps(scene, track, {
  seed: WORLD_SEED,
  size: trackConfig.mode === "custom" ? trackConfig.size ?? 0.5 : 0.5,
  onCatnip: (kart, pos) => {
    kart.giveCatnip();
    effects.tootBurst(kart, 2, true); // green smash poof
    audio.boost(kart === player ? null : kart.position);
    if (kart === player) hud.showToast("🌿 Catnip!");
  },
}).then((p) => {
  props = p;
});

// Kart headlights (night/dusk only): REAL shadowless spotlights aimed forward and
// down, so they actually illuminate the road and any props ahead — the lit pool a
// spotlight casts IS the beam, conforming to the surface with no decal to clip the
// track. PERF: rather than one light per kart (every lit pixel in a forward
// renderer pays for every light, and dynamic-resolution scaling can't reduce the
// light COUNT — only the pixel count), we keep a small FIXED pool of beams and
// reassign them each frame to the player + the nearest karts. Every other kart
// still shows its glowing headlight bulbs (those are emissive, free), it just
// doesn't cast a road pool — which you almost never notice from the chase cam.
// A constant light count also means the material shaders compile once and never
// re-link mid-race. `_hlRamp` eases 0->1 once the lights go green so the packed
// starting grid's overlapping beams don't blow out the screen.
// WebGPU headroom: the budget now covers the WHOLE field so every kart keeps its
// OWN beam at night — not just the nearest 3. Reassigning a small pool to the
// nearest karts each frame made beams visibly jump/flicker between karts as they
// jockeyed for position. The per-frame assignment still maps the nearest karts to
// the pool, so any extras beyond the budget (large MP lobbies) fall back to bulbs.
const HEADLIGHT_BUDGET = 8; // was 3 (player + 2 nearest); now every kart in a normal field gets a beam
const _hlBase = 68 * LIGHT_LEVEL; // full intensity (dimmer at dusk, full at night)
const _hlPool = []; // { light, target } reused across karts
const _hlCands = []; // per-frame scratch: karts eligible for a beam, nearest first
let _hlRamp = 1;
function buildHeadlightPool() {
  if (LIGHT_LEVEL <= 0 || _hlPool.length) return; // daytime needs none
  for (let i = 0; i < HEADLIGHT_BUDGET; i++) {
    const target = new THREE.Object3D();
    scene.add(target);
    // Range 75->58 and a slightly tighter cone: at the packed start grid all the
    // beams overlap and pile up lit fragments (the worst night frame-rate hit), so a
    // shorter throw cuts that overdraw while still lighting the road ahead.
    const spot = new THREE.SpotLight(0xfff2d6, 0, 58, 0.6, 0.55, 1.3);
    spot.castShadow = false;
    spot.target = target;
    scene.add(spot);
    _hlPool.push({ light: spot, target });
  }
}
buildHeadlightPool();

// A warm point light at the player's exhaust that flares while boosting, so a
// boost actually throws coloured light on the road and nearby props. Player-only
// (one event-driven light) to keep the night light count in check.
let _boostLight = null;
function attachBoostLight(playerKart) {
  if (!playerKart || !playerKart.group) return;
  _boostLight = new THREE.PointLight(0xff8a2e, 0, 26, 1.6);
  _boostLight.position.set(0, 0.7, -2.7);
  _boostLight.castShadow = false;
  playerKart.group.add(_boostLight);
}

// Minimap: a static top-down outline of the track with a coloured dot per kart.
let minimap = setupMinimap();

// --- Cel shading: convert lit (standard) materials to banded toon shading ---
function makeToonGradient() {
  // 4 soft bands with a lifted floor and a gentle highlight rolloff — a softer,
  // matte "toy" cel rather than a hard 3-step terminator.
  const steps = new Uint8Array([145, 195, 228, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const TOON_GRADIENT = makeToonGradient();
// Sun-driven rim/backlight share two uniform nodes, updated once per frame in
// updateAtmosphere: the view-space sun-travel direction and the (mood sun colour ×
// glow) tint. (Legacy per-shader arrays kept but unused on WebGPU.)
const backlitShaders = [];
const rimShaders = [];
const uSunViewNode = uniform(new THREE.Vector3(0, 0, 1));
const uSunColNode = uniform(new THREE.Color(0x000000));
function toToon(m) {
  if (!m || !m.isMeshStandardMaterial || (m.userData && m.userData.skipToon)) return m;
  const params = {
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
  };
  const ud = m.userData || {};
  // Sun-driven add-ons (foliage backlight, hero rim) are added via emissiveNode,
  // which REPLACES the material's emissive — so only apply them to MATTE materials
  // (black emissive). Materials with a live emissive (brake lights, headlight
  // bulbs, glowing pads) keep stock toon so their dynamic emissiveIntensity works.
  const matte = !params.emissive || params.emissive.getHex() === 0;
  if ((ud.backlight || ud.rim) && matte) {
    const t = new THREE.MeshToonNodeMaterial(params);
    let term = null;
    if (ud.backlight) {
      // glows warm where you look toward the sun through the foliage.
      const backlit = positionViewDirection.negate().dot(uSunViewNode).max(0).pow(3);
      term = uSunColNode.mul(backlit);
    }
    if (ud.rim) {
      // a warm sun rim on the silhouette so the hero pops off the scene.
      const ndv = normalView.dot(positionViewDirection).max(0);
      const rimF = float(1).sub(ndv).pow(2.5).mul(normalView.dot(uSunViewNode.negate()).max(0));
      const rimTerm = uSunColNode.mul(rimF.mul(1.6));
      term = term ? term.add(rimTerm) : rimTerm;
    }
    t.emissiveNode = term;
    return t;
  }
  // Everything else: stock toon (auto-converted to a node material by WebGPU,
  // keeping the gradient banding and any dynamic emissiveIntensity).
  return new THREE.MeshToonMaterial(params);
}
function toonify(root) {
  root.traverse((o) => {
    if (!o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(toToon) : toToon(o.material);
  });
}
toonify(scene);

// --- Rear threat indicator ---
// (Replaces the old rear-view mirror, which cost a full second render of the whole
// scene every other frame — the biggest single draw-call hit, worst on big maps.
// A HUD warning when a kart can hairball you from behind is near-free and clearer
// on a phone.) Lights amber when a pursuer has you in firing range/cone, and
// pulses red when one is locked on AND ready to fire.
const rearThreatEl = document.getElementById("rear-threat");
let _threatState = "none"; // "none" | "warn" | "lock"

// Steering indicator + recalibrate button
const steerDot = document.getElementById("steer-dot");
document.getElementById("calibrate").addEventListener("click", () => input.calibrate());

const input = new Input();
const hairballs = new HairballManager(scene);
const effects = new EffectsManager(scene);
const hud = new HUD();

// Boost (toot) meter UI reflects the player kart's own meter.
const boostBtn = document.getElementById("btn-boost");
const boostFill = document.getElementById("boost-fill");
const shootBtn = document.getElementById("btn-shoot");
function updateBoostUI() {
  const m = player ? player.boostMeter : 0;
  boostFill.style.height = `${Math.round(m * 100)}%`;
  boostBtn.classList.toggle("disabled", m < 1); // only fire when full
  // Dim the shoot button while it's recharging (or locked out after a hit).
  if (shootBtn) shootBtn.classList.toggle("disabled", !!player && player.shootCooldown > 0);
}

// --- Karts: 1 player + 5 AI rivals ---
const ROSTER = [
  { name: "You", color: 0xe53935, catColor: 0xf0a830, isPlayer: true, skill: 1.0 },
  { name: "Mittens", color: 0x1e88e5, catColor: 0x9e9e9e, skill: 1.07 },
  { name: "Whiskers", color: 0x43a047, catColor: 0x3e2723, skill: 1.09 },
  { name: "Pumpkin", color: 0xfb8c00, catColor: 0xffffff, skill: 1.05 },
  { name: "Shadow", color: 0x8e24aa, catColor: 0x212121, skill: 1.11 },
  { name: "Biscuit", color: 0xfdd835, catColor: 0xd7a86e, skill: 1.06 },
];

let karts = [];
let player = null;

function buildKarts() {
  for (const k of karts) scene.remove(k.group);
  karts = [];
  _hlRamp = 0.18; // headlights start dim and ramp up once racing, to avoid a grid blowout
  rimShaders.length = 0; // drop last race's kart shaders before rebuilding
  // Multiplayer is humans-only: drop the AI field (remote players fill the grid
  // as real participants). Solo play keeps the full roster of AI rivals.
  // Multiplayer and time trial are solo fields (just your kart); a normal race
  // brings the full AI roster.
  const roster = MP.enabled || timeTrial ? ROSTER.slice(0, 1) : ROSTER;
  // Solo: shuffle the starting-grid slots so the player doesn't always launch
  // from the same spot. It's one level for now, so a random grid position each
  // race adds variety. (Per-race Math.random, not the seeded world RNG.)
  const slots = roster.map((_, i) => i);
  if (!MP.enabled) {
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
  }
  roster.forEach((cfg, i) => {
    const kart = new Kart(cfg);
    const slotIndex = MP.enabled && cfg.isPlayer ? mpGridSlot() : slots[i];
    const slot = track.gridSlot(slotIndex);
    kart.placeAt(slot.position, slot.heading, track);
    kart._aiShootTimer = 1 + Math.random() * 3;
    // Flag the kart/cat materials for a sun rim light so the hero pops off the
    // background (applied during the toon conversion).
    kart.group.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
    });
    toonify(kart.group); // cel-shade the kart + cat
    scene.add(kart.group);
    karts.push(kart);
    if (cfg.isPlayer) player = kart;
  });
  _boostLight = null;
  attachBoostLight(player); // player's exhaust glow while boosting
}

// Cel-shade a kart group the same way buildKarts does (rim light + toon bands),
// so remote players' karts match the look of the local field.
function decorateKartGroup(group) {
  group.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
  });
  toonify(group);
  // Remote karts share the same pooled headlight beams (assigned by proximity each
  // frame in the loop) — no per-kart light to attach.
}

// --- Multiplayer (Phase 2: "ghost race") ---------------------------------
// Opt-in: only active when a PartyKit host is configured AND the URL has ?mp=1.
// Remote players appear as render-only "ghost" karts driven by interpolated
// network snapshots — they glide alongside but DON'T collide or affect the race
// (they're deliberately kept out of `karts[]`). The room is the world seed, so
// a link like ?seed=ABC123&mp=1 puts everyone in the same world and lobby.
const MP_NAMES = ["Tigger", "Salem", "Felix", "Luna", "Smokey", "Oreo", "Ziggy", "Mochi", "Pixel", "Binx"];
const MP_SKINS = [
  { color: 0x1e88e5, catColor: 0x9e9e9e },
  { color: 0x43a047, catColor: 0x3e2723 },
  { color: 0xfb8c00, catColor: 0xffffff },
  { color: 0x8e24aa, catColor: 0x212121 },
  { color: 0xfdd835, catColor: 0xd7a86e },
  { color: 0x00897b, catColor: 0xffe0b2 },
];
function makeMpIdentity() {
  const n = MP_NAMES[Math.floor(Math.random() * MP_NAMES.length)];
  const s = MP_SKINS[Math.floor(Math.random() * MP_SKINS.length)];
  return { name: n, color: s.color, catColor: s.catColor };
}

const MP = {
  enabled: false, net: null, remotes: new Map(),
  sendAcc: 0, hudAcc: 0, hud: null,
  inLobby: false, startAt: 0,
};

// Host election: the lowest connection id is host. Every client derives this
// from the same member set, so they all agree with no negotiation. The same
// sorted order also assigns starting-grid slots, so players don't stack up.
function mpOrderedIds() {
  const ids = [MP.net && MP.net.id, ...MP.remotes.keys()].filter(Boolean);
  ids.sort();
  return ids;
}
function mpHostId() {
  const ids = mpOrderedIds();
  return ids.length ? ids[0] : null;
}
function mpIsHost() {
  return !!(MP.net && MP.net.id && mpHostId() === MP.net.id);
}
function mpGridSlot() {
  const i = MP.net ? mpOrderedIds().indexOf(MP.net.id) : 0;
  return Math.max(0, i);
}

function mpSpawn(identity) {
  if (MP.remotes.has(identity.id)) return;
  const r = new RemoteKart(identity);
  decorateKartGroup(r.group);
  scene.add(r.group);
  MP.remotes.set(identity.id, r);
}
function mpDespawn(id) {
  const r = MP.remotes.get(id);
  if (r) {
    r.dispose(scene);
    MP.remotes.delete(id);
  }
}

function mpDebugHud() {
  const el = document.createElement("div");
  el.id = "mp-debug";
  el.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:9999;font:11px/1.4 monospace;" +
    "color:#cdf;background:rgba(10,16,32,.6);padding:3px 7px;border-radius:6px;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

function initMultiplayer() {
  const ablyKey = resolveAblyKey();
  const host = resolveHost();
  if ((!ablyKey && !host) || !new URLSearchParams(location.search).has("mp")) return;
  if (MP.enabled) return; // already connected (idempotent for runtime toggling)
  MP.enabled = true;
  MP.hud = mpDebugHud();
  MP.hud.textContent = "MP · connecting…";
  const transportP = ablyKey
    ? createAblyTransport({ key: ablyKey, room: WORLD_SEED })
    : createPartyTransport({ host, room: WORLD_SEED });
  transportP
    .then((transport) => {
      const net = new Net(transport, makeMpIdentity());
      MP.net = net;
      net.on("peer", (identity) => {
        mpSpawn(identity);
        if (MP.inLobby) renderLobby();
      });
      net.on("peerleave", (id) => {
        mpDespawn(id);
        if (MP.inLobby) renderLobby();
      });
      // Once our own connection is acknowledged, fill in the lobby (it may have
      // been opened before the socket finished connecting).
      net.on("open", () => {
        if (MP.inLobby) renderLobby();
      });
      net.on("state", (id, pose) => {
        const r = MP.remotes.get(id);
        if (r) r.pushState(pose);
      });
      net.on("start", (at) => beginSyncedRace(at));
      net.on("shoot", (s) => {
        hairballs.spawnAt(
          new THREE.Vector3(s.px, s.py, s.pz),
          new THREE.Vector3(s.dx, s.dy, s.dz),
          s.c || 0
        );
      });
      net.on("hit", (h) => {
        // Only the targeted client reacts; the victim's own shield gets last say.
        if (h.target !== net.id || !player || state !== State.RACING) return;
        if (player.shielding) return;
        const dir = new THREE.Vector3(h.hx, 0, h.hz);
        player.spinOut(dir.lengthSq() > 0.0001 ? dir : null);
      });
      net.on("finish", (id, ft, fc) => {
        const r = MP.remotes.get(id);
        if (r) {
          r.finished = true;
          r.finishTime = ft;
          r.finishClock = fc || 0;
        }
        // If the results screen is already up, slot the late finisher in live.
        if (state === State.FINISHED) renderResults();
      });
      net.connect();
    })
    .catch((err) => {
      console.warn("[zoomies] multiplayer failed to start:", err);
      MP.enabled = false;
      if (MP.hud) MP.hud.textContent = "MP · failed";
    });
}

// Broadcast my pose (~18 Hz) and interpolate every ghost kart. Runs every frame
// while connected, in any game state, so remote karts glide continuously.
function updateMultiplayer(dt) {
  if (!MP.enabled || !MP.net) return;
  const net = MP.net;
  if (net.connected && player) {
    MP.sendAcc += dt;
    if (MP.sendAcc >= 1 / 25) {
      MP.sendAcc = 0;
      let f = 0;
      if (player.drifting) f |= FLAG.DRIFT;
      if (player.boosting) f |= FLAG.BOOST;
      if (player.shielding) f |= FLAG.SHIELD;
      if (player.airborne || player.y > 0.01) f |= FLAG.AIRBORNE;
      net.sendState({
        x: player.position.x,
        y: player.groundY + player.y,
        z: player.position.z,
        h: player.heading,
        p: player.slopePitch,
        s: player.speed,
        f,
        pr: player.totalProgress,
      });
    }
  }
  const rt = net.now() - INTERP_DELAY; // render remote karts slightly in the past
  for (const r of MP.remotes.values()) r.update(rt, dt);

  MP.hudAcc += dt;
  if (MP.hudAcc >= 0.5 && MP.hud) {
    MP.hudAcc = 0;
    MP.hud.textContent = `MP · peers ${MP.remotes.size} · ping ${Math.round(net.clock.rtt)}ms · ${
      net.connected ? "live" : "…"
    }`;
  }
}

initMultiplayer();

// --- Game state ---
const State = { MENU: 0, COUNTDOWN: 1, RACING: 2, FINISHED: 3, PAUSED: 4 };
let state = State.MENU;
let countdown = 0;
let raceTime = 0;
let countdownCalibrated = false;
let prevCountN = 99; // last countdown number that beeped (3/2/1/GO)
// Finish celebration: fireworks from the arch when the leader crosses the line,
// and a slow camera orbit around the player's kart during its victory lap.
let _fireworksDone = false; // leader's finish fireworks fired once per race
let _fwTimer = 0; // remaining celebration time (keeps launching bursts)
let _fwNext = 0; // countdown to the next burst
let _finishCamAngle = 0; // victory orbit angle once the player finishes
// Time-trial mode: solo, single timed lap, local best-times leaderboard.
let timeTrial = false;
let ttLapStart = -1; // raceTime when the timed lap began (first start-line crossing)
let _ttResult = null; // { top, entry } from the latest recorded run, for the results screen

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

  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  applyResolution();
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

// Scan for a kart that could hairball the player from behind and drive the HUD
// warning. A pursuer is a threat when it has the player inside its firing cone and
// range (mirrors the AI fire test in aiActions) — i.e. it's behind you, aimed at
// you. "lock" (it can fire right now) pulses red; "warn" (in range, not yet ready
// or not yet dead-on) is amber. Pure CPU math over karts already in memory.
const _rtFwd = new THREE.Vector3();
const _rtTo = new THREE.Vector3();
function updateRearThreat() {
  if (!rearThreatEl) return;
  let state = "none";
  if (player && !player.finished) {
    const contenders = MP.enabled ? [...karts, ...[...MP.remotes.values()].map((r) => r.kart)] : karts;
    for (const k of contenders) {
      if (!k || k === player || k.finished || k.spinTimer > 0) continue;
      _rtFwd.set(Math.sin(k.heading), 0, Math.cos(k.heading));
      _rtTo.subVectors(player.position, k.position);
      const dist = _rtTo.length();
      if (dist < 3 || dist > 50) continue; // out of hairball reach
      const aim = _rtTo.normalize().dot(_rtFwd); // 1 = pointing straight at the player
      if (aim < 0.78) continue; // not aimed at you
      // Ready + dead-on + in solid range = imminent; otherwise just a warning.
      const ready = (k.shootCooldown ?? 0) <= 0.25;
      if (ready && aim > 0.86 && dist < 46) { state = "lock"; break; }
      state = "warn"; // keep scanning in case another kart is a full lock
    }
  }
  if (state !== _threatState) {
    _threatState = state;
    rearThreatEl.classList.toggle("show", state !== "none");
    rearThreatEl.classList.toggle("lock", state === "lock");
  }
}

// Update the god-ray pass: project the sun to screen and fade it out when it's
// hidden by the weather or behind the camera.
let sunVisibleMood = MOOD.rays ?? MOOD.sunVisible;
const _sunDir = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _sunScreen = new THREE.Vector3();
const _ss = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const _sunViewVec = new THREE.Vector3();
const _shUp = new THREE.Vector3(0, 1, 0);
const _shRight = new THREE.Vector3();
const _shUpL = new THREE.Vector3();
function updateAtmosphere() {
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  // Direction toward the sun (invariant to the follow offset below).
  _sunDir.copy(sun.position).sub(sun.target.position).normalize();

  // Keep the tight shadow frustum centred on the player so its crisp shadows
  // are always where they show. Snap the centre to shadow-map texels (in the
  // light's own view basis) so the now-tighter, crisper shadows don't swim or
  // shimmer as the player moves. Light + target move together, preserving the
  // sun direction.
  if (player) {
    const cam = sun.shadow.camera;
    const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
    _shRight.crossVectors(_shUp, _sunDir).normalize();
    _shUpL.crossVectors(_sunDir, _shRight).normalize();
    const p = player.position;
    const dr = Math.round(p.dot(_shRight) / texel) * texel;
    const du = Math.round(p.dot(_shUpL) / texel) * texel;
    const df = p.dot(_sunDir);
    sun.target.position
      .set(0, 0, 0)
      .addScaledVector(_shRight, dr)
      .addScaledVector(_shUpL, du)
      .addScaledVector(_sunDir, df);
    sun.position.copy(sun.target.position).addScaledVector(_sunDir, 320);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const facing = _sunDir.dot(_camFwd);
  let vis = 0;
  if (sunVisibleMood && facing > 0.02) {
    _sunScreen.copy(_sunDir).multiplyScalar(3000).add(camera.position).project(camera);
    godrayPass.uniforms.uSun.value.set(_sunScreen.x * 0.5 + 0.5, _sunScreen.y * 0.5 + 0.5);
    const off = Math.max(Math.abs(_sunScreen.x), Math.abs(_sunScreen.y));
    vis = _ss(0.02, 0.45, facing) * (1 - _ss(1.0, 2.4, off));
  }
  // Rain clouds the sun: fade the shafts/flare/backlight as it picks up.
  const clear = 1 - 0.7 * weather.rainAmount;
  vis *= clear;
  godrayPass.uniforms.uVis.value = vis;
  flarePass.uniforms.uVis.value = vis;
  // PERF: both are full-screen shader passes that output the frame unchanged when
  // the sun isn't visible (night, or facing away) — skip them entirely then. Saves
  // two full-frame passes every night frame. fxPass stays last, so the
  // render-to-screen pass is unaffected.
  godrayPass.enabled = vis > 0.001;
  flarePass.enabled = vis > 0.001;

  // View-space light-travel direction + mood sun colour, shared by the backlit
  // tree foliage and the hero rim (the foliage/rim TSL emissive reads these nodes).
  _sunViewVec.copy(_sunDir).multiplyScalar(-1).transformDirection(camera.matrixWorldInverse);
  const sunGlow = (sunVisibleMood ? 0.5 : 0) * clear;
  uSunViewNode.value.copy(_sunViewVec);
  uSunColNode.value.copy(godrayPass.uniforms.uColor.value).multiplyScalar(sunGlow * 0.7);
  // Grass keeps its own (still-GLSL, M5) backlight shader when present.
  const gsh = world.grass && world.grass.material.userData.shader;
  if (gsh && gsh.uniforms.uSunView) {
    gsh.uniforms.uSunView.value.copy(_sunViewVec);
    gsh.uniforms.uSunCol.value.copy(godrayPass.uniforms.uColor.value).multiplyScalar(sunGlow);
  }
  // Puddles now animate via the TSL `time` node (no per-frame uniform write needed;
  // node materials drop the dummy .uniforms after they compile).
}

// Render the main view (through the post-processing composer), then overlay the
// minimap while playing.
function renderFrame() {
  if (!_rendererReady) return; // WebGPURenderer must finish init() before first render
  updateAtmosphere();
  composer.render();
  if (player && state !== State.MENU) {
    drawMinimap();
  }
}

// --- Minimap ---
// Fit the track's world XZ bounds into the canvas (preserving aspect, padded),
// bake the centreline into a Path2D once, then each frame stroke that outline
// and plot a dot per kart coloured to match its body.
function setupMinimap() {
  const canvas = document.getElementById("minimap");
  if (!canvas || !track._pts || !track._pts.length) return null;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const pad = 12;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of track._pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oz = (H - (maxZ - minZ) * scale) / 2 - minZ * scale;
  const toX = (x) => ox + x * scale;
  const toY = (z) => oz + z * scale;
  const path = new Path2D();
  track._pts.forEach((p, i) => (i === 0 ? path.moveTo(toX(p.x), toY(p.z)) : path.lineTo(toX(p.x), toY(p.z))));
  path.closePath();
  return { ctx, toX, toY, W, H, path };
}

// Paint a top-down outline of a loop (array of {x,z}) into a 2D canvas, fitting
// its world bounds with padding and preserving aspect. Used by the track-menu
// preview and the main-menu map so you can see the shape before you race.
function paintTrackMap(canvas, controlPoints) {
  if (!canvas || !controlPoints || !controlPoints.length) return;
  // Smooth the control points into the same closed Catmull-Rom the road is built
  // from, so the preview matches the shape you'll actually drive (not a polygon).
  const curve = new THREE.CatmullRomCurve3(controlPoints, true, "catmullrom", 0.5);
  const points = [];
  for (let i = 0; i < 300; i++) points.push(curve.getPointAt(i / 300));
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const pad = 16;
  ctx.clearRect(0, 0, W, H);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oz = (H - (maxZ - minZ) * scale) / 2 - minZ * scale;
  const toX = (x) => ox + x * scale;
  const toY = (z) => oz + z * scale;
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p.x), toY(p.z)) : ctx.lineTo(toX(p.x), toY(p.z))));
  ctx.closePath();
  ctx.lineJoin = "round";
  // Soft dark roadbed under a bright centreline so it reads as a track.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = "#ffd24a";
  ctx.lineWidth = 3.5;
  ctx.stroke();
  // Start dot at the first control point.
  ctx.beginPath();
  ctx.arc(toX(points[0].x), toY(points[0].z), 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
}

function drawMinimap() {
  if (!minimap) return;
  const { ctx, toX, toY, W, H, path } = minimap;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.stroke(path);
  for (const e of raceField()) {
    const k = e.kart || e; // remote wrappers hold their kart
    if (!k.position) continue;
    const isPlayer = !!k.isPlayer;
    ctx.beginPath();
    ctx.arc(toX(k.position.x), toY(k.position.z), isPlayer ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#" + ((k.color ?? 0xffffff) >>> 0).toString(16).padStart(6, "0");
    ctx.fill();
    if (isPlayer) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }
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

// Render resolution (declared before the first layoutStage call below).
// Default everything to High now that dynamic resolution scaling protects the
// frame rate — it renders at full retina and only scales back if a device can't
// keep up, so we get the high-quality look without risking stutter.
let quality = "high";
let renderScale = 1; // dynamic-resolution multiplier on the base pixel ratio (see updateDRS)
function baseDpr() {
  return Math.min(window.devicePixelRatio, quality === "high" ? 2 : 1.5);
}
function applyResolution() {
  const pr = Math.max(0.5, baseDpr() * renderScale);
  renderer.setPixelRatio(pr);
  renderer.setSize(stageState.W, stageState.H);
  composer.setPixelRatio(pr);
  composer.setSize(stageState.W, stageState.H);
  // Run bloom at half resolution — it's heavily blurred anyway, so it looks the
  // same for ~a quarter of the cost. (composer.setSize set it to full; override.)
  const bw = Math.max(1, Math.round(stageState.W * pr * 0.5));
  const bh = Math.max(1, Math.round(stageState.H * pr * 0.5));
  bloomPass.setSize(bw, bh);
}

window.addEventListener("resize", layoutStage);
window.addEventListener("orientationchange", layoutStage);
layoutStage();

// --- Hit feedback (shake + white flash) ---
const flashEl = document.getElementById("flash");
function triggerHit() {
  shakeMag = 1.6;
  audio.hit();
  audio.skidBurst(null, 0.9); // tires screech as you slew round
  if (flashEl) {
    flashEl.classList.remove("on");
    void flashEl.offsetWidth; // restart the CSS flash
    flashEl.classList.add("on");
  }
}

// --- Dynamic resolution scaling ---
// Render the 3D at a variable internal resolution to hold a steady frame rate:
// drop it when frames run long, probe it back up when there's headroom. The CSS
// size (and HUD) stay full-res; only the drawing buffer scales.
const DRS_MIN = 0.5; // was 0.55 — give the scaler a bit more room for the worst spikes (facing the sun, big maps)
let _frameMs = 16.7;
let _drsCooldown = 0;
function updateDRS(rawMs, dt) {
  _frameMs += (Math.min(rawMs, 60) - _frameMs) * 0.18; // smoothed frame interval (a touch quicker to react)
  _drsCooldown -= dt;
  if (_drsCooldown > 0) return;
  if (_frameMs > 18.6 && renderScale > DRS_MIN) {
    // Step proportional to how far over budget we are: a big spike (turning to
    // face the sun, cresting a hill on a big map) drops resolution HARD in one
    // move instead of crawling down 0.1 at a time over a couple of seconds.
    const over = _frameMs / 18.6;
    const step = over > 1.7 ? 0.25 : over > 1.3 ? 0.16 : 0.08;
    renderScale = Math.max(DRS_MIN, renderScale - step);
    applyResolution();
    _drsCooldown = 0.35;
  } else if (_frameMs < 17.4 && renderScale < 1) {
    renderScale = Math.min(1, renderScale + 0.06); // headroom -> recover resolution gently
    applyResolution();
    _drsCooldown = 1.4;
  }
}
const qualityLowBtn = document.getElementById("set-quality-low");
const qualityHighBtn = document.getElementById("set-quality-high");
function applyQuality(q) {
  quality = q;
  const high = q === "high";
  bloomPass.enabled = true; // marquee glow on both tiers
  if (world.grass) world.grass.visible = high;
  renderScale = 1; // reset DRS on a manual quality change
  qualityLowBtn?.classList.toggle("is-active", !high);
  qualityHighBtn?.classList.toggle("is-active", high);
  layoutStage(); // applies the resolution
}
qualityLowBtn?.addEventListener("click", () => applyQuality("low"));
qualityHighBtn?.addEventListener("click", () => applyQuality("high"));
applyQuality(quality);

// Lap-count selector: cycles 1..5 (default 3). Applied to the track at race start.
const lapsBtn = document.getElementById("laps-btn");
function applyLapsBtn() {
  if (lapsBtn) lapsBtn.textContent = `Laps: ${TOTAL_LAPS}`;
}
if (lapsBtn)
  lapsBtn.addEventListener("click", () => {
    TOTAL_LAPS = (TOTAL_LAPS % 5) + 1;
    applyLapsBtn();
  });
applyLapsBtn();

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
  audio.stopEngine();
  audio.setSkid(false);
  pauseOverlay.classList.remove("hidden");
}
function resumeGame() {
  if (state !== State.PAUSED) return;
  pauseOverlay.classList.add("hidden");
  audio.startEngine();
  state = State.RACING;
}
// True while a single-player race is "parked" in the background (you opened the
// main menu mid-race). The race state/karts are kept intact so you can resume
// instead of losing your progress. Multiplayer races aren't parkable.
let _raceParked = false;
function refreshResumeBtn() {
  const b = document.getElementById("resume-race-btn");
  if (b) b.classList.toggle("hidden", !_raceParked);
}
function toMenu() {
  // Opening the menu mid-race parks it (so START is a fresh race but you can also
  // Resume). Reaching the menu from results/lobby clears any parked race.
  _raceParked = (state === State.PAUSED || state === State.RACING) && !!player && !player.finished && !MP.enabled;
  pauseOverlay.classList.add("hidden");
  document.getElementById("hud").classList.add("hidden");
  document.getElementById("lobby").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("menu").classList.remove("hidden");
  audio.stopEngine();
  audio.setSkid(false);
  audio.playMusic("bg");
  MP.inLobby = false;
  MP.startAt = 0;
  state = State.MENU;
  refreshResumeBtn();
}
// Resume a parked race: drop back into it exactly where it was (paused), so the
// player can read the scene before unpausing.
function resumeParkedRace() {
  if (!_raceParked) return;
  document.getElementById("menu").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  updateCamera(0.016, true); // snap the chase camera back onto the kart
  state = State.PAUSED;
  pauseOverlay.classList.remove("hidden");
}
document.getElementById("btn-pause").addEventListener("pointerdown", (e) => {
  e.preventDefault(); // fire even while a finger is on the throttle/steering
  pauseGame();
});
document.getElementById("resume-btn").addEventListener("click", resumeGame);
document.getElementById("menu-btn").addEventListener("click", toMenu);
document.getElementById("resume-race-btn")?.addEventListener("click", resumeParkedRace);

// Pause automatically when the app is backgrounded (tab hidden / app switched
// away / screen locked). The race freezes; when you come back the pause overlay
// is showing, so you resume on your own terms. If the app is fully closed
// (swiped away), there's nothing to do — it just ends.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === State.RACING) pauseGame();
});
// Every menu can get back to the main screen: lobby and results both offer it.
document.getElementById("lobby-back")?.addEventListener("click", toMenu);
document.getElementById("results-menu-btn")?.addEventListener("click", toMenu);

// --- Settings screen (graphics + sound), opened from the menu and pause ---
const settingsOverlay = document.getElementById("settings");
const musicToggle = document.getElementById("set-music-toggle");
const musicVol = document.getElementById("set-music-vol");
const sfxToggle = document.getElementById("set-sfx-toggle");
const sfxVol = document.getElementById("set-sfx-vol");

// Reflect the current audio settings onto the controls.
function refreshAudioUI() {
  if (musicToggle) {
    musicToggle.textContent = audio.musicOn ? "On" : "Off";
    musicToggle.classList.toggle("off", !audio.musicOn);
  }
  if (sfxToggle) {
    sfxToggle.textContent = audio.sfxOn ? "On" : "Off";
    sfxToggle.classList.toggle("off", !audio.sfxOn);
  }
  if (musicVol) {
    musicVol.value = Math.round(audio.musicVol * 100);
    musicVol.disabled = !audio.musicOn;
  }
  if (sfxVol) {
    sfxVol.value = Math.round(audio.sfxVol * 100);
    sfxVol.disabled = !audio.sfxOn;
  }
}

// Sub-screens (Settings, How to Play) REPLACE whichever menu-level screen is up
// rather than stacking over it: hide the current one, remember it, restore on
// back. That keeps only one card over the live 3D world.
let _overlayReturn = null;
function openSubScreen(el) {
  _overlayReturn = null;
  for (const id of ["menu", "pause-overlay"]) {
    const o = document.getElementById(id);
    if (o && !o.classList.contains("hidden")) {
      _overlayReturn = o;
      o.classList.add("hidden");
      break;
    }
  }
  el.classList.remove("hidden");
}
function closeSubScreen(el) {
  el.classList.add("hidden");
  if (_overlayReturn) {
    _overlayReturn.classList.remove("hidden");
    _overlayReturn = null;
  }
}

function openSettings() {
  audio.unlock(); // the opening tap is a valid gesture to start audio
  refreshAudioUI();
  openSubScreen(settingsOverlay);
}
function closeSettings() {
  closeSubScreen(settingsOverlay);
}
document.getElementById("open-settings")?.addEventListener("click", openSettings);
document.getElementById("open-settings-pause")?.addEventListener("click", openSettings);
document.getElementById("settings-back")?.addEventListener("click", closeSettings);

// --- FPS counter (opt-in via Settings; persisted) ---
const FPS_KEY = "zoomies-fps";
const fpsEl = document.getElementById("fps-counter");
const fpsToggle = document.getElementById("set-fps-toggle");
let showFps = false;
try { showFps = localStorage.getItem(FPS_KEY) === "1"; } catch {}
function applyFpsSetting() {
  if (fpsEl) fpsEl.classList.toggle("hidden", !showFps);
  if (fpsToggle) {
    fpsToggle.textContent = showFps ? "On" : "Off";
    fpsToggle.classList.toggle("off", !showFps);
  }
}
fpsToggle?.addEventListener("click", () => {
  showFps = !showFps;
  try { localStorage.setItem(FPS_KEY, showFps ? "1" : "0"); } catch {}
  applyFpsSetting();
});
applyFpsSetting();

// Refresh the readout a few times a second from the smoothed frame interval the
// DRS already tracks (_frameMs). Colour-coded so a costly tweak is obvious.
let _fpsAccum = 0;
function updateFpsCounter(dt) {
  if (!showFps || !fpsEl) return;
  _fpsAccum += dt;
  if (_fpsAccum < 0.2) return; // ~5 Hz so the number is readable, not a blur
  _fpsAccum = 0;
  const fps = Math.round(1000 / Math.max(1, _frameMs));
  fpsEl.textContent = `${fps} FPS`;
  fpsEl.classList.toggle("warn", fps < 50 && fps >= 35);
  fpsEl.classList.toggle("bad", fps < 35);
}

// --- How to Play sub-menu (replaces the main menu) ---
const howtoOverlay = document.getElementById("howto");
document.getElementById("howto-btn")?.addEventListener("click", () => openSubScreen(howtoOverlay));
document.getElementById("howto-back")?.addEventListener("click", () => closeSubScreen(howtoOverlay));

// --- Add to Home Screen ---
// Chromium fires `beforeinstallprompt`, which we stash and replay from the
// button to show the native install dialog. iOS has no such API, so there the
// button opens step-by-step instructions for the Share-sheet flow. The button
// hides itself once the app is installed (running standalone).
const installBtn = document.getElementById("install-btn");
const installHelp = document.getElementById("install-help");
const installGo = document.getElementById("install-help-go"); // native install (in overlay)
const installBack = document.getElementById("install-help-back");
const installGateNote = document.getElementById("install-gate-note");
const _isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const _isStandalone =
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;
const _isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
let _deferredInstall = null;
let _installGate = false; // mandatory-install mode (touch device, not installed)

function refreshInstallUI() {
  const canNative = !!_deferredInstall;
  // Menu button: useful only when not gated, not installed, and there's an action.
  const showBtn = !_installGate && !_isStandalone && (canNative || _isIOS);
  installBtn?.classList.toggle("hidden", !showBtn);
  // Native install button inside the overlay appears whenever the browser offers it.
  installGo?.classList.toggle("hidden", !canNative);
}
async function triggerNativeInstall() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
  try {
    await _deferredInstall.userChoice;
  } catch {
    /* dismissed */
  }
  _deferredInstall = null;
  refreshInstallUI();
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // keep our UI in charge instead of the mini-infobar
  _deferredInstall = e;
  refreshInstallUI();
});
window.addEventListener("appinstalled", () => {
  _deferredInstall = null;
  installBtn?.classList.add("hidden");
});
installBtn?.addEventListener("click", () => {
  if (_deferredInstall) triggerNativeInstall();
  else openSubScreen(installHelp); // iOS: Share-sheet instructions
});
installGo?.addEventListener("click", triggerNativeInstall);
installBack?.addEventListener("click", () => closeSubScreen(installHelp));

// Mandatory install on touch devices: the bar/flip/multiplayer-link issues only
// behave in a standalone (home-screen) app, so block in-browser play on phones
// and tablets until installed. Desktop keeps playing in the tab (none of those
// issues apply there). The install screen floats over the live scene like the
// other menus, with no way to dismiss it.
if (_isTouch && !_isStandalone) {
  _installGate = true;
  installGateNote?.classList.remove("hidden");
  installBack?.classList.add("hidden");
  openSubScreen(installHelp);
}
refreshInstallUI();

// --- Track generator panel ---
// Edits a draft recipe; "Apply" persists it and reloads to rebuild the world
// from the new track (rebuilding scenery + track in place is a later upgrade).
const trackPanel = document.getElementById("track-panel");
const ALL_BIOMES = ["meadow", "forest", "alpine", "autumn", "desert"];
// Biomes are laid out as angular wedges around the track. A small/tight loop only
// sweeps through a few of those wedges, so picking 5 biomes on a tiny map left some
// never visited (the reported "not all biomes show" bug). Cap the count to what a
// map of a given size can actually display, and surface the cap in the UI.
function maxBiomesForSize(size) {
  if (size < 0.25) return 2;
  if (size < 0.5) return 3;
  if (size < 0.75) return 4;
  return ALL_BIOMES.length; // big maps can show them all
}
let _trackDraft = null;
function syncTrackPanel() {
  if (!_trackDraft) return;
  const custom = _trackDraft.mode === "custom";
  document.getElementById("track-classic")?.classList.toggle("is-active", !custom);
  document.getElementById("track-custom")?.classList.toggle("is-active", custom);
  const knobs = document.getElementById("track-knobs");
  if (knobs) knobs.style.display = custom ? "" : "none";
  const reroll = document.getElementById("track-new"); // lives in the map box now
  if (reroll) reroll.style.display = custom ? "" : "none";
  const set = (id, v) => {
    const pct = Math.round(v * 100);
    const el = document.getElementById(id);
    if (el) el.value = pct;
    const val = document.getElementById(id + "-val");
    if (val) val.textContent = pct;
  };
  set("track-curvy", _trackDraft.curviness);
  set("track-hilly", _trackDraft.hilliness);
  set("track-hills", _trackDraft.hills);
  set("track-size", _trackDraft.size);
  // Enforce the size-driven biome cap: if the draft holds more than the current
  // size allows (e.g. the user shrank the map after picking 5), trim the extras
  // off the end, keeping the earliest-picked ones.
  const maxBiomes = maxBiomesForSize(_trackDraft.size ?? 0.5);
  if (_trackDraft.biomes.length > maxBiomes) _trackDraft.biomes = _trackDraft.biomes.slice(0, maxBiomes);
  const atCap = _trackDraft.biomes.length >= maxBiomes;
  const hint = document.getElementById("biome-max-hint");
  if (hint) hint.textContent = maxBiomes >= ALL_BIOMES.length ? "(all available)" : `(pick up to ${maxBiomes} — bigger map = more)`;
  trackPanel?.querySelectorAll("#track-biomes .biome-chip").forEach((chip) => {
    const on = _trackDraft.biomes.includes(chip.dataset.biome);
    chip.classList.toggle("on", on);
    // Grey out the chips you can't add once you're at the cap (selected ones stay
    // interactive so you can deselect to free a slot).
    chip.classList.toggle("locked", !on && atCap);
  });
  const tod = _trackDraft.timeOfDay || "midday";
  trackPanel?.querySelectorAll("#track-tod .biome-chip").forEach((chip) => {
    chip.classList.toggle("on", chip.dataset.tod === tod);
  });
  scheduleTrackPreview();
}

// Regenerating the loop runs the validate-and-retry generator, which can take a
// few ms, so coalesce slider drags to one redraw per animation frame.
let _previewPending = false;
function scheduleTrackPreview() {
  if (_previewPending || !_trackDraft) return;
  _previewPending = true;
  requestAnimationFrame(() => {
    _previewPending = false;
    if (!_trackDraft) return;
    paintTrackMap(document.getElementById("track-preview"), previewLoopPoints(_trackDraft));
  });
}
function openTrackPanel() {
  _trackDraft = {
    mode: trackConfig.mode || "classic",
    size: trackConfig.size ?? 0.5,
    curviness: trackConfig.curviness ?? 0.5,
    hilliness: trackConfig.hilliness ?? 0.5,
    hills: trackConfig.hills ?? 0.5,
    biomes:
      Array.isArray(trackConfig.biomes) && trackConfig.biomes.length
        ? [...trackConfig.biomes]
        : [...ALL_BIOMES],
    seed: trackConfig.seed || randomSeed(),
    timeOfDay: trackConfig.timeOfDay || "midday",
  };
  syncTrackPanel();
  openSubScreen(trackPanel);
}
// Time-of-day picker (single-select: midday / sunset / night / random).
document.getElementById("track-tod")?.querySelectorAll(".biome-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    _trackDraft.timeOfDay = chip.dataset.tod;
    syncTrackPanel();
  });
});
document.getElementById("open-track")?.addEventListener("click", openTrackPanel);

// Main-menu map: a thumbnail of the track you're about to race, doubling as a
// shortcut into the track editor.
function refreshMenuMap() {
  paintTrackMap(document.getElementById("menu-map"), previewLoopPoints(trackConfig));
  const label = document.getElementById("menu-map-label");
  if (label) {
    label.textContent =
      trackConfig.mode === "custom" ? `Generated · ${trackConfig.seed || "—"}` : "Classic circuit";
  }
}
document.getElementById("menu-map-btn")?.addEventListener("click", openTrackPanel);
refreshMenuMap();
document.getElementById("track-back")?.addEventListener("click", () => closeSubScreen(trackPanel));
document.getElementById("track-classic")?.addEventListener("click", () => {
  _trackDraft.mode = "classic";
  syncTrackPanel();
});
document.getElementById("track-custom")?.addEventListener("click", () => {
  _trackDraft.mode = "custom";
  syncTrackPanel();
});
const setTrackVal = (id, v) => {
  const val = document.getElementById(id + "-val");
  if (val) val.textContent = v;
};
document.getElementById("track-curvy")?.addEventListener("input", (e) => {
  _trackDraft.curviness = e.target.value / 100;
  setTrackVal("track-curvy", e.target.value);
  scheduleTrackPreview();
});
document.getElementById("track-hilly")?.addEventListener("input", (e) => {
  _trackDraft.hilliness = e.target.value / 100;
  setTrackVal("track-hilly", e.target.value);
  scheduleTrackPreview();
});
document.getElementById("track-hills")?.addEventListener("input", (e) => {
  _trackDraft.hills = e.target.value / 100;
  setTrackVal("track-hills", e.target.value);
  scheduleTrackPreview();
});
document.getElementById("track-size")?.addEventListener("input", (e) => {
  _trackDraft.size = e.target.value / 100;
  setTrackVal("track-size", e.target.value);
  // Re-apply the biome cap and refresh the hint/locked chips as the map resizes.
  syncTrackPanel();
});
document.getElementById("track-new")?.addEventListener("click", (e) => {
  _trackDraft.seed = randomSeed();
  scheduleTrackPreview();
  const btn = e.currentTarget;
  btn.textContent = "🎲 New shape ✓";
  setTimeout(() => (btn.textContent = "🎲 Reroll shape"), 1100);
});
trackPanel?.querySelectorAll(".biome-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const b = chip.dataset.biome;
    const i = _trackDraft.biomes.indexOf(b);
    if (i >= 0) {
      if (_trackDraft.biomes.length > 1) _trackDraft.biomes.splice(i, 1); // keep at least one
    } else {
      // Honour the size-driven cap: at the limit, adding a biome rolls the
      // oldest selection out so the newest pick takes effect (rather than the
      // click silently doing nothing).
      const max = maxBiomesForSize(_trackDraft.size ?? 0.5);
      if (_trackDraft.biomes.length >= max) _trackDraft.biomes.shift();
      _trackDraft.biomes.push(b);
    }
    syncTrackPanel();
  });
});
document.getElementById("track-apply")?.addEventListener("click", () => {
  if (_trackDraft.mode === "custom" && !_trackDraft.seed) _trackDraft.seed = randomSeed();
  saveTrackConfig(_trackDraft);
  location.reload(); // rebuild the world from the new recipe
});

musicToggle?.addEventListener("click", () => {
  audio.unlock();
  audio.setMusicOn(!audio.musicOn);
  refreshAudioUI();
});
sfxToggle?.addEventListener("click", () => {
  audio.unlock();
  audio.setSfxOn(!audio.sfxOn);
  refreshAudioUI();
});
musicVol?.addEventListener("input", () => {
  audio.unlock();
  audio.setMusicVolume(musicVol.value / 100);
});
sfxVol?.addEventListener("input", () => {
  audio.unlock();
  audio.setSfxVolume(sfxVol.value / 100);
});
// Play a sample tick when the SFX slider is released so the new level is audible.
sfxVol?.addEventListener("change", () => audio.uiClick());
refreshAudioUI();

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
// "Race again" repeats whichever mode you were just in.
document.getElementById("restart-btn").addEventListener("click", () => (timeTrial ? startTimeTrial() : startRace()));
// Time trial is solo-only; hide it in multiplayer.
const timeTrialBtn = document.getElementById("time-trial-btn");
if (timeTrialBtn) {
  if (MP.enabled) timeTrialBtn.classList.add("hidden");
  else timeTrialBtn.addEventListener("click", startTimeTrial);
}

// Solo / Multiplayer toggle. Only offered when an Ably key is configured.
// Switches mode at RUNTIME (no page reload, so no jarring flash): entering
// connects and drops you straight into the lobby; leaving tears the connection
// down and returns to the menu. The ?mp flag is kept in sync via replaceState so
// the invite link stays shareable and a refresh lands in the same mode.
const modeToggle = document.getElementById("mode-toggle");
const modeSoloBtn = document.getElementById("mode-solo");
const modeMpBtn = document.getElementById("mode-mp");
const mpJoin = document.getElementById("mp-join");
const mpMyCode = document.getElementById("mp-mycode");
const mpCodeInput = document.getElementById("mp-code");
function updateModeBtn() {
  modeSoloBtn?.classList.toggle("is-active", !MP.enabled);
  modeMpBtn?.classList.toggle("is-active", MP.enabled);
  // Show the join field in Multiplayer mode; surface this client's room code.
  mpJoin?.classList.toggle("hidden", !MP.enabled);
  if (mpMyCode) mpMyCode.textContent = WORLD_SEED;
}
// Join a friend's lobby by code: their code IS the world seed + room, so we
// reload into that world with multiplayer on. In a PWA this navigation stays in
// the installed app (no Safari hop), which is why a typed code beats a link.
function joinByCode() {
  const code = (mpCodeInput?.value || "").trim().toUpperCase();
  if (!code || code === WORLD_SEED) return;
  const u = new URL(location.href);
  u.searchParams.set("seed", code);
  u.searchParams.set("mp", "1");
  location.href = u.toString();
}
document.getElementById("mp-join-btn")?.addEventListener("click", joinByCode);
mpCodeInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinByCode();
});
function enterMultiplayer() {
  audio.unlock();
  const u = new URL(location.href);
  u.searchParams.set("mp", "1");
  u.searchParams.set("seed", WORLD_SEED);
  history.replaceState(null, "", u);
  initMultiplayer(); // connects (async) in the background while we stay on the menu
  updateModeBtn();
  // Stay on the main menu — START then takes you to the lobby (beginRace handles
  // the fullscreen/motion gesture setup there, as in solo).
}
function exitMultiplayer() {
  if (MP.net) {
    try {
      MP.net.close();
    } catch {
      /* ignore */
    }
    MP.net = null;
  }
  for (const id of [...MP.remotes.keys()]) mpDespawn(id);
  MP.enabled = false;
  MP.inLobby = false;
  MP.startAt = 0;
  if (MP.hud) {
    MP.hud.remove();
    MP.hud = null;
  }
  const u = new URL(location.href);
  u.searchParams.delete("mp");
  history.replaceState(null, "", u);
  updateModeBtn();
  toMenu();
}
if (modeToggle && resolveAblyKey()) {
  modeToggle.classList.remove("hidden");
  updateModeBtn();
  modeSoloBtn?.addEventListener("click", () => {
    if (MP.enabled) exitMultiplayer();
  });
  modeMpBtn?.addEventListener("click", () => {
    if (!MP.enabled) enterMultiplayer();
  });
}

// Lobby: copy the invite link (already carries ?seed=…&mp=1) to the clipboard.
const lobbyCopyBtn = document.getElementById("lobby-copy");
if (lobbyCopyBtn) {
  lobbyCopyBtn.addEventListener("click", async () => {
    const label = "📋 Copy invite link";
    try {
      await navigator.clipboard.writeText(location.href);
      lobbyCopyBtn.textContent = "✓ Link copied!";
    } catch {
      lobbyCopyBtn.textContent = "⚠ Copy failed — copy the URL";
    }
    setTimeout(() => (lobbyCopyBtn.textContent = label), 1800);
  });
}

function startRace() {
  timeTrial = false;
  beginRace();
}
function startTimeTrial() {
  timeTrial = true;
  beginRace();
}
function beginRace() {
  // These need the user-gesture from the click, so fire them synchronously.
  audio.unlock(); // browsers only allow audio to start from a gesture
  audio.uiClick();
  enterFullscreenLandscape();
  input.enableMotion();
  input.calibrate();
  input.jumpHeld = false; // clear any held state from a previous run
  input.shielding = false;

  // In multiplayer the START button takes you to the lobby; the race itself
  // begins when the host starts it, synchronized across everyone. (Doing the
  // gesture-only setup above here means the countdown can later be triggered
  // over the network without needing another tap on iOS.)
  if (MP.enabled) {
    enterLobby();
    return;
  }

  prepareRace();
  countdown = 3.999;
  countdownCalibrated = false;
  prevCountN = 99;
  state = State.COUNTDOWN;
}

// Everything to spin up a race that does NOT need a user gesture — so it can run
// both from the local START click and from a network-triggered synchronized start.
function prepareRace() {
  _raceParked = false; // starting fresh; nothing parked to resume
  refreshResumeBtn();
  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("lobby").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");

  // This world's time of day (midday/sunset/night), fixed per seed and already
  // applied at load. Precipitation is separate — dictated by the biome you drive
  // through (see the loop).
  const mood = MOOD;
  applyMood(mood);
  weather.setWeather("none");
  moodSat = mood.sat;
  fxPass.uniforms.uSat.value = mood.sat;
  fxPass.uniforms.uContrast.value = mood.contrast;
  // God-rays / lens-flare / warm backlight only for the daytime sun, not the moon.
  sunVisibleMood = mood.rays ?? mood.sunVisible;
  moodExposure = mood.exposure;
  godrayPass.uniforms.uColor.value.set(mood.sunColor);
  godrayPass.uniforms.uWeight.value = mood.rayWeight ?? 1.05;
  hud.showToast(mood.name);

  track.totalLaps = timeTrial ? 1 : TOTAL_LAPS; // time trial is a single timed lap
  buildKarts();
  updateBoostUI(); // karts start with an empty boost meter
  raceTime = 0;
  track.raceTime = 0;
  prevPlayerLap = -1; // so the time-trial lap-start crossing is detected cleanly
  ttLapStart = -1;
  _ttResult = null;
  _fireworksDone = false;
  _fwTimer = 0;
  _fwNext = 0;
  _finishCamAngle = 0;
  camPos.set(0, 0, 0); // force the countdown camera to snap from the menu orbit
  // Clear any in-progress menu cross-dissolve.
  if (menuXfade) menuXfade.style.opacity = 0;
  _menuPhase = "hold";
  _menuShotT = 0;
  // Clear any finish/progress state carried over from a previous race on the
  // remote ghosts (they persist across races; only local karts are rebuilt).
  if (MP.enabled) {
    for (const r of MP.remotes.values()) {
      r.finished = false;
      r.finishTime = 0;
      r.finishClock = 0;
      r.totalProgress = -1;
    }
  }
}

// --- Multiplayer lobby ---
function renderLobby() {
  if (!MP.enabled || !MP.net) return;
  const codeEl = document.getElementById("lobby-code");
  if (codeEl) codeEl.textContent = WORLD_SEED;
  const list = document.getElementById("lobby-players");
  if (list) {
    list.innerHTML = "";
    const host = mpHostId();
    const rows = [
      { id: MP.net.id, name: "You", you: true },
      ...[...MP.remotes.values()].map((r) => ({ id: r.id, name: r.name })),
    ];
    for (const row of rows) {
      const li = document.createElement("li");
      li.textContent = (row.id === host ? "👑 " : "🐱 ") + row.name;
      if (row.you) li.className = "you";
      list.appendChild(li);
    }
  }
  const startBtn = document.getElementById("lobby-start");
  const waiting = document.getElementById("lobby-waiting");
  if (startBtn) startBtn.style.display = mpIsHost() ? "" : "none";
  if (waiting) waiting.style.display = mpIsHost() ? "none" : "";
}

function enterLobby() {
  MP.inLobby = true;
  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("lobby").classList.remove("hidden");
  renderLobby();
}

// Line the countdown up to the shared-clock instant `at` so every client hits
// GO at the same moment. Triggered locally on the host and via the network on
// everyone else; the state guard makes a double-trigger harmless.
function beginSyncedRace(at) {
  if (state === State.COUNTDOWN || state === State.RACING) return;
  input.jumpHeld = false;
  input.shielding = false;
  MP.inLobby = false;
  MP.startAt = at;
  prepareRace();
  countdown = Math.max(0.3, (at - MP.net.now()) / 1000);
  countdownCalibrated = false;
  prevCountN = 99;
  state = State.COUNTDOWN;
}

const COUNTDOWN_LEAD_MS = 4000;
const lobbyStartBtn = document.getElementById("lobby-start");
if (lobbyStartBtn) {
  lobbyStartBtn.addEventListener("click", () => {
    if (!MP.enabled || !MP.net || !mpIsHost()) return;
    const at = MP.net.now() + COUNTDOWN_LEAD_MS;
    MP.net.sendStart(at);
    beginSyncedRace(at);
  });
}

// --- Camera follow ---
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
let shakeMag = 0;
// Boost pads: a short speed kick (and its rainbow trail) when a kart drives over
// a chevron pad, with a per-kart cooldown so it fires once per pass.
function applyBoostPads(dt) {
  const pads = track.boostPads;
  if (!pads) return;
  for (const k of karts) {
    k._padCd = (k._padCd || 0) - dt;
    if (k.finished || k.spinTimer > 0 || k._padCd > 0 || k.speed < 4) continue;
    for (const pad of pads) {
      const dx = k.position.x - pad.x;
      const dz = k.position.z - pad.z;
      if (dx * dx + dz * dz < pad.r * pad.r) {
        k.applyBoost(1.4, 0.8);
        k._padCd = 1.2;
        break;
      }
    }
  }
}

// Finish fireworks: burst from the arch when the leader first crosses the line,
// then keep launching a few more for a short celebration.
function updateFireworks(dt) {
  // Fire the instant the leader is actually AT the line — gating on proximity to
  // the arch (not just the finished flag) so a flag that flips a touch early
  // (e.g. a networked ghost still gliding in) can't set them off beforehand.
  if (!_fireworksDone && track.archApex) {
    const winner = raceField().find((k) => k.finished);
    if (winner) {
      const dx = winner.position.x - track.archApex.x;
      const dz = winner.position.z - track.archApex.z;
      if (dx * dx + dz * dz < 12 * 12) {
        _fireworksDone = true;
        _fwTimer = 8;
        _fwNext = 0;
      }
    }
  }
  if (_fwTimer > 0 && track.archApex) {
    _fwTimer -= dt;
    _fwNext -= dt;
    if (_fwNext <= 0) {
      _fwNext = 0.22 + Math.random() * 0.28;
      const o = track.archApex
        .clone()
        .add(new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 3, (Math.random() - 0.5) * 2));
      effects.fireworkBurst(o);
    }
  }
}

// Cinematic menu background: slowly orbit a spot, then cross-fade to a vantage
// FURTHER along the track, touring the whole map behind the menu. Shots are
// picked greedily so each one jumps a good distance down the loop (preferring a
// biome change), making consecutive scenes look clearly different.
const _menuShots = (() => {
  const shots = [];
  const MIN_GAP = 0.15; // jump at least this fraction of the loop between shots
  const FORCE_GAP = 0.34; // ...but always take one after this far, even same biome
  let lastT = -1;
  let lastKind = null;
  for (let i = 0; i < 160 && shots.length < 6; i++) {
    const t = i / 160;
    const p = track.getPointAt(t);
    const kind = biomeRoadStyle(p.x, p.z).kind;
    if (shots.length === 0) {
      shots.push(t);
      lastT = t;
      lastKind = kind;
      continue;
    }
    const gap = t - lastT;
    if ((gap >= MIN_GAP && kind !== lastKind) || gap >= FORCE_GAP) {
      shots.push(t);
      lastT = t;
      lastKind = kind;
    }
  }
  if (shots.length < 2) return [0.1, 0.35, 0.6, 0.85]; // fallback variety
  return shots;
})();
const SHOT_HOLD = 6.5; // seconds orbiting one biome
const SHOT_FADE = 1.5; // seconds for the cross-dissolve
const _menuAnchor = new THREE.Vector3(); // current/incoming biome
const _menuAnchorPrev = new THREE.Vector3(); // outgoing biome (during a dissolve)
const _menuLook = new THREE.Vector3();
const menuXfade = document.getElementById("menu-xfade");
const menuXfadeCtx = menuXfade ? menuXfade.getContext("2d") : null;
let _menuShot = 0;
let _menuPhase = "hold"; // "hold" | "fading"
let _menuShotT = 0; // time orbiting the current biome
let _menuFadeT = 0; // elapsed cross-dissolve
let _menuPrevTime = -1;
function _setMenuAnchor(i) {
  _menuAnchor.copy(track.getPointAt(_menuShots[i % _menuShots.length]));
}

// Advance the menu-tour clock and phase (timing only — rendering is separate so
// the dissolve can render BOTH biomes live).
function updateMenuCamera(timeSec) {
  if (_menuPrevTime < 0) _setMenuAnchor(_menuShot);
  let dt = timeSec - _menuPrevTime;
  _menuPrevTime = timeSec;
  if (dt < 0 || dt > 0.5) dt = 0; // first frame / tab was backgrounded

  if (_menuPhase === "hold") {
    _menuShotT += dt;
    if (_menuShotT >= SHOT_HOLD) {
      // Begin a dissolve: remember the outgoing biome, move to the next one.
      _menuAnchorPrev.copy(_menuAnchor);
      _menuShot = (_menuShot + 1) % _menuShots.length;
      _setMenuAnchor(_menuShot);
      _menuPhase = "fading";
      _menuFadeT = 0;
    }
  } else {
    _menuFadeT += dt;
    if (_menuFadeT >= SHOT_FADE) {
      _menuPhase = "hold";
      _menuShotT = 0;
      if (menuXfade) menuXfade.style.opacity = 0;
    }
  }
}

// Orbit the camera around an anchor and aim slightly above the road.
function _orbitMenuCam(anchor, ang) {
  camera.position.set(anchor.x + Math.cos(ang) * 34, anchor.y + 16, anchor.z + Math.sin(ang) * 34);
  _menuLook.set(anchor.x, anchor.y + 2.5, anchor.z);
  camera.lookAt(_menuLook);
  if (camera.fov !== 58) {
    camera.fov = 58;
    camera.updateProjectionMatrix();
  }
}

// Render the menu background. While dissolving, render the OUTGOING biome (live)
// into the overlay and fade it out over the INCOMING biome (live) — a true
// cross-fade with both sides still moving, no freeze and no dip to black.
function renderMenuBackground(timeSec) {
  const ang = timeSec * 0.07; // gentle drift
  if (_menuPhase === "fading") {
    const k = Math.min(1, _menuFadeT / SHOT_FADE);
    // Outgoing biome -> capture into the overlay (fading out).
    _orbitMenuCam(_menuAnchorPrev, ang);
    renderFrame();
    if (menuXfadeCtx) {
      const gl = renderer.domElement;
      if (menuXfade.width !== gl.width || menuXfade.height !== gl.height) {
        menuXfade.width = gl.width;
        menuXfade.height = gl.height;
      }
      try {
        menuXfadeCtx.drawImage(gl, 0, 0, menuXfade.width, menuXfade.height);
        menuXfade.style.opacity = (1 - k).toFixed(3);
      } catch (e) {
        /* capture failed (rare) — the incoming render still shows */
      }
    }
    // Incoming biome -> the displayed frame.
    _orbitMenuCam(_menuAnchor, ang);
    renderFrame();
  } else {
    _orbitMenuCam(_menuAnchor, ang);
    renderFrame();
  }
}

function updateCamera(dt, snap = false) {
  // Victory lap: take control and orbit slowly around the kart as it cruises.
  if (player.finished) {
    _finishCamAngle += dt * 0.45;
    const r = 12;
    const desired = new THREE.Vector3(
      player.position.x + Math.sin(_finishCamAngle) * r,
      player.position.y + 6,
      player.position.z + Math.cos(_finishCamAngle) * r
    );
    const look = new THREE.Vector3(player.position.x, player.position.y + 1.5, player.position.z);
    const lerp = snap ? 1 : 1 - Math.pow(0.02, dt);
    camPos.lerp(desired, lerp);
    camTarget.lerp(look, lerp);
    camera.fov += (62 - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
    camera.position.copy(camPos);
    camera.lookAt(camTarget);
    return;
  }

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

  // Keep the camera above the track surface beneath it: on a steep descent the
  // spot behind the kart is up-slope (higher ground), which could otherwise leave
  // the camera buried under the road. Sample the road height there and lift if low.
  const camGroundY = track.groundInfo(camPos.x, camPos.z).y;
  if (camPos.y < camGroundY + 3) camPos.y = camGroundY + 3;

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
      // Thud on contact (debounced inside audio.bump). Heard from the player's
      // seat if they're involved, otherwise positioned at the impact.
      const involvesPlayer = a === player || b === player;
      audio.bump(involvesPlayer ? null : a.position, Math.min(1, power / 40));

      // Only a tiny speed scrub — you keep your momentum through contact.
      a.speed *= 0.99;
      b.speed *= 0.99;

      // Catnip ram: a kart boosting on catnip bowls over a rival on contact (like
      // a hairball hit), unless the rival is shielding. The catnip kart keeps going.
      if (a.catnipBoosting && !b.catnipBoosting && !b.shielding && b.spinTimer <= 0) {
        b.spinOut(new THREE.Vector3(nx, 0, nz));
      } else if (b.catnipBoosting && !a.catnipBoosting && !a.shielding && a.spinTimer <= 0) {
        a.spinOut(new THREE.Vector3(-nx, 0, -nz));
      }
    }
  }
}

// Multiplayer: bump against remote ghost karts. We only ever move OUR OWN player
// out of the overlap — the ghost's pose is network-driven, so nudging it would
// just fight interpolation and jitter. The other client resolves the mirror
// collision against our ghost, so both sides agree without any referee.
function resolveRemoteCollisions() {
  if (!MP.enabled || !player) return;
  const min = 4.4;
  for (const [rid, r] of MP.remotes) {
    if (!r._ready) continue; // no real pose yet — don't collide at the origin
    const g = r.kart;
    const dx = g.position.x - player.position.x;
    const dz = g.position.z - player.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= 0.0001 || distSq >= min * min) continue;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const nz = dz / dist;
    const overlap = min - dist;

    // Fully separate the player from the ghost (the ghost can't move
    // authoritatively, so the player takes the whole correction). Resolving the
    // overlap in one frame stops impulses piling up over multiple frames of
    // contact — that pile-up was flinging ghosts off the track.
    player.position.x -= nx * overlap;
    player.position.z -= nz * overlap;

    // The player's knock is the AUTHORITATIVE reaction: it moves the player's
    // real position (wall-contained, gradual decay), which propagates over the
    // network and is exactly what the other client sees this kart do.
    const ima = 1 / player.mass;
    const img = 1 / g.mass;
    const inv = ima + img;
    const sp = ima / inv; // player's share
    const sg = img / inv; // ghost's share

    const power = 10 + (Math.abs(player.speed) + Math.abs(g.speed)) * 0.4;
    player.knock.x -= nx * power * sp * 1.8;
    player.knock.z -= nz * power * sp * 1.8;
    player.speed *= 0.99;

    // Small, brief local nudge on the ghost for instant feedback only — sized to
    // roughly match the real slide that lands over the network ~250ms later, so
    // the handoff is seamless and the ghost never flies off.
    r.bump(nx, nz, power * sg * 0.8);

    // Catnip ram across the network: tell the rival to spin out (their client
    // honours their own shield). Debounced so contact doesn't spam hits.
    if (player.catnipBoosting && MP.net) {
      const now = performance.now();
      if (!r._lastRam || now - r._lastRam > 1200) {
        r._lastRam = now;
        MP.net.sendHit(rid, { x: nx, z: nz });
      }
    }
  }
}

// --- Placement ---
// In multiplayer, remote ghost karts join the field as real participants: each
// broadcasts its totalProgress, so a "2nd / 4" agrees across every screen.
function updatePlacement() {
  const field = [...karts];
  if (MP.enabled) for (const r of MP.remotes.values()) field.push(r);
  field.sort((a, b) => {
    if (a.finished && b.finished) {
      // Rank by the shared-clock finish instant when both have one (multiplayer);
      // fall back to elapsed time for AI / solo where every clock is local.
      if (a.finishClock && b.finishClock) return a.finishClock - b.finishClock;
      return a.finishTime - b.finishTime;
    }
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.totalProgress - a.totalProgress;
  });
  field.forEach((k, idx) => (k.place = idx + 1));
}

const SHOOT_CHARGE_TIME = 0.7; // seconds of hold for a full-power shot
const SHOOT_RECHARGE = 1.2; // min seconds between shots (no spamming)
// Longer grace at the green light so the race doesn't open with everyone pelting
// each other on the start line — first hairball isn't ready until this elapses.
const SHOOT_OPENING_LOCKOUT = SHOOT_RECHARGE * 2;

// Fire a hairball if allowed (recharge done, not spun out), and start the
// recharge. Shared by the player and the AI so the rules are identical.
function fireHairball(kart, charge = 0) {
  if (kart.shootCooldown > 0 || kart.spinTimer > 0 || kart.finished) return false;
  hairballs.spawn(kart, charge);
  audio.shoot(kart === player ? null : kart.position);
  kart.shootCooldown = SHOOT_RECHARGE;
  // Tell other players about the shot so they can see the projectile fly.
  if (MP.enabled && MP.net && kart === player) {
    const m = kart.muzzle();
    MP.net.sendShoot(m.pos, m.dir, charge);
  }
  return true;
}

// --- AI actions: catch-up, shooting, boosts, shields, anti-clumping ---
const _aiFwd = new THREE.Vector3();
const _aiTo = new THREE.Vector3();
function aiActions(dt) {
  for (const k of karts) {
    if (k.isPlayer) continue;

    // Rubber-band: trailing karts run a little faster, leaders a little slower,
    // to keep the pack competitive.
    const gap = player.totalProgress - k.totalProgress;
    // Catch up strongly when behind, but barely ease off when leading, so the
    // front-runners stay competitive instead of waiting for the player.
    k.maxSpeed = k.baseMaxSpeed * (1 + Math.max(-0.02, Math.min(0.16, gap * 0.12)));

    if (k.boosting) effects.trickle(k, k.catnipBoosting);
    if (k.finished || k.spinTimer > 0) {
      k.shielding = false;
      continue;
    }

    _aiFwd.set(Math.sin(k.heading), 0, Math.cos(k.heading));

    // --- Anti-clumping: ease off and steer aside when right behind another
    // kart, so the pack doesn't pile into tight corners in a single knot. ---
    let nearestAhead = Infinity;
    for (const other of karts) {
      if (other === k || other.finished) continue;
      _aiTo.subVectors(other.position, k.position);
      const d = _aiTo.length();
      if (d > 0.001 && d < 16 && _aiTo.dot(_aiFwd) / d > 0.6) {
        if (d < nearestAhead) nearestAhead = d;
        // Steer away from the side the other kart is on (heading-relative angle).
        let a = Math.atan2(_aiTo.x, _aiTo.z) - k.heading;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        const away = Math.abs(a) < 0.05 ? (k.laneBias >= 0 ? 1 : -1) : -Math.sign(a);
        k.steerInput = Math.max(-1, Math.min(1, k.steerInput + away * 0.35));
      }
    }
    if (nearestAhead < 16) k.throttleInput *= 0.55 + 0.45 * (nearestAhead / 16);

    // --- Shield: raise it when a hairball is bearing down — but imperfectly, so
    // it doesn't feel like shooting just flips their shield on. Each new threat
    // gets a reaction roll (they might not bother) and a reaction delay (fast or
    // charged shots can beat it). ---
    let threat = false;
    for (const b of hairballs.balls) {
      if (b.owner === k) continue;
      const dx = k.position.x - b.mesh.position.x;
      const dz = k.position.z - b.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 24) {
        const vlen = Math.hypot(b.vel.x, b.vel.z) || 1;
        if ((dx * b.vel.x + dz * b.vel.z) / (d * vlen) > 0.55) {
          threat = true;
          break;
        }
      }
    }
    if (threat && !k._threatPrev) {
      k._shieldTry = Math.random() < k.shieldSkill; // sometimes they just don't react
      k._shieldDelay = 0.18 + Math.random() * 0.32; // human-ish reaction time
    }
    if (threat) k._shieldDelay -= dt;
    k.shielding = threat && k._shieldTry && k._shieldDelay <= 0;
    k._threatPrev = threat;

    // --- Toot boost when full, on a straightish stretch (not mid-shield). ---
    if (k.boostMeter >= 1 && !threat && Math.abs(k.steerInput) < 0.45 && k.speed > 8 && !k.boosting) {
      if (k.tootBoost()) {
        k.boostMeter = 0;
        effects.tootBurst(k);
        audio.toot(k.position);
      }
    }

    // --- Shoot at a kart ahead, gated by the same recharge as the player. ---
    k._aiShootTimer -= dt;
    if (k.shootCooldown <= 0 && k._aiShootTimer <= 0) {
      k._aiShootTimer = 1.0 + Math.random() * 2.2;
      for (const other of karts) {
        if (other === k || other.finished) continue;
        _aiTo.subVectors(other.position, k.position);
        const dist = _aiTo.length();
        if (dist > 3 && dist < 46 && _aiTo.normalize().dot(_aiFwd) > 0.8) {
          fireHairball(k, Math.random() < 0.4 ? 0.8 : 0); // sometimes a charged shot
          break;
        }
      }
    }
  }
}

// --- Results ---
// The full race field for placement/results: local karts plus, in multiplayer,
// every remote ghost as a real participant.
function raceField() {
  const f = [...karts];
  if (MP.enabled) for (const r of MP.remotes.values()) f.push(r);
  return f;
}

function showResults() {
  state = State.FINISHED;
  renderResults();
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("results").classList.remove("hidden");
}

// Built separately so it can re-render when a remote player finishes after the
// results screen is already up (their time slots into the standings live).
function renderResults() {
  if (timeTrial) {
    renderTimeTrialResults();
    return;
  }
  updatePlacement();
  const order = raceField().sort((a, b) => a.place - b.place);
  const list = document.getElementById("results-list");
  list.innerHTML = "";
  order.forEach((k) => {
    const li = document.createElement("li");
    const time = k.finished
      ? ` — ${formatClock(k.finishTime)}`
      : MP.enabled ? " — racing…" : " — DNF";
    li.textContent = `${ordinal(k.place)}  ${k.name}${time}`;
    if (k === player) li.className = "you";
    list.appendChild(li);
  });
  document.getElementById("results-title").textContent =
    player.place === 1 ? "🏆 You Win!" : `🏁 ${ordinal(player.place)} Place`;
}

function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// --- Time trial: local best-lap leaderboard (localStorage; swap for a DB later) ---
const TT_KEY = "zoomies-timetrial-v1";
function loadTimeTrial() {
  try {
    const v = JSON.parse(localStorage.getItem(TT_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function recordTimeTrial(time) {
  const list = loadTimeTrial();
  const entry = { time, date: Date.now() };
  list.push(entry);
  list.sort((a, b) => a.time - b.time);
  const top = list.slice(0, 10);
  try {
    localStorage.setItem(TT_KEY, JSON.stringify(top));
  } catch {
    /* storage may be unavailable (private mode); leaderboard is best-effort */
  }
  return { top, entry };
}
// Lap time as M:SS.dd (or SS.dds under a minute).
function formatLap(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)}s`;
}
function renderTimeTrialResults() {
  const yourTime = _ttResult ? _ttResult.entry.time : null;
  const top = _ttResult ? _ttResult.top : loadTimeTrial();
  const best = top.length ? top[0].time : null;
  document.getElementById("results-title").textContent =
    yourTime != null && best != null && yourTime <= best ? "⏱ New Best Lap!" : "⏱ Time Trial";
  const list = document.getElementById("results-list");
  list.innerHTML = "";
  if (yourTime != null) {
    const me = document.createElement("li");
    me.className = "you";
    me.textContent = `Your lap: ${formatLap(yourTime)}`;
    list.appendChild(me);
  }
  if (!top.length) {
    const li = document.createElement("li");
    li.textContent = "No times yet — set one!";
    list.appendChild(li);
  }
  top.forEach((e, i) => {
    const li = document.createElement("li");
    const isYou = _ttResult && e === _ttResult.entry;
    li.textContent = `${i + 1}.  ${formatLap(e.time)}`;
    if (isYou) li.className = "you";
    list.appendChild(li);
  });
}

// --- Main loop ---
let last = performance.now();
let prevPlayerLap = -1;
let prevPlayerSpin = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const rawMs = now - last; // real frame interval (for resolution scaling)
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05); // clamp big frame gaps

  updateDRS(rawMs, dt); // hold the frame rate by scaling render resolution
  updateFpsCounter(dt); // opt-in on-screen FPS readout
  world.update(now / 1000, dt, player ? player.position : null); // balloons, critters, fireflies, pigeons
  if (gpuParticles) gpuParticles.update(dt, camera.position); // step the GPU compute motes (follows the camera)

  if (state === State.PAUSED) {
    renderFrame(); // hold the frozen frame behind the overlay
    return;
  }

  weather.update(dt, camera.position); // rain/snow follows the player
  updateRearThreat(); // HUD warning when a kart can hairball you from behind

  // Assign the small headlight-beam pool to the player + the nearest karts each
  // frame (others keep just their glowing bulbs), and ramp the beams up once the
  // race is underway so the packed starting grid doesn't blow out the screen.
  if (_hlPool.length) {
    if (state === State.RACING) _hlRamp += (1 - _hlRamp) * Math.min(1, dt * 0.32);
    _hlCands.length = 0;
    for (const k of karts) if (k && k.position) _hlCands.push(k);
    if (MP.enabled) for (const r of MP.remotes.values()) if (r.kart && r.kart.position) _hlCands.push(r.kart);
    const cx = camera.position.x, cz = camera.position.z;
    // Player always keeps a beam; the rest are ranked by distance to the camera.
    _hlCands.sort((a, b) => {
      if (a === player) return -1;
      if (b === player) return 1;
      const da = (a.position.x - cx) ** 2 + (a.position.z - cz) ** 2;
      const db = (b.position.x - cx) ** 2 + (b.position.z - cz) ** 2;
      return da - db;
    });
    const lit = _hlBase * _hlRamp;
    for (let i = 0; i < _hlPool.length; i++) {
      const slot = _hlPool[i];
      const k = _hlCands[i];
      if (!k) { slot.light.intensity = 0; continue; } // fewer karts than beams
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const p = k.position;
      slot.light.position.set(p.x + fx * 2.9, p.y + 0.7, p.z + fz * 2.9); // at the headlights
      slot.target.position.set(p.x + fx * 18, p.y - 3.5, p.z + fz * 18); // forward + down
      slot.target.updateMatrixWorld();
      slot.light.intensity = lit;
    }
  }

  // Boost light flares up while the player boosts (eased so it pulses on/off);
  // it glows green for a catnip boost, warm orange otherwise.
  if (_boostLight) {
    const tgt = player && player.boosting ? 34 : 0;
    _boostLight.intensity += (tgt - _boostLight.intensity) * Math.min(1, dt * 12);
    _boostLight.color.set(player && player.catnipBoosting ? 0x6fe040 : 0xff8a2e);
  }

  // Step the knockable props and let the karts shove the ones they touch.
  if (props) {
    props.update(
      dt,
      raceField().map((e) => {
        const k = e.kart || e;
        return k && k.position ? { x: k.position.x, z: k.position.z, kart: k } : null;
      })
    );
  }

  // Swing the festive string lights as karts pass under them.
  if (world.stringLights) {
    world.stringLights.update(
      dt,
      raceField().map((e) => {
        const k = e.kart || e;
        if (!k || !k.position) return null;
        return { x: k.position.x, z: k.position.z, dx: Math.sin(k.heading), dz: Math.cos(k.heading), speed: Math.abs(k.speed || 0) };
      })
    );
  }
  updateMultiplayer(dt); // broadcast my pose + interpolate ghost karts

  if (state === State.MENU) {
    // Cinematic: slowly orbit the camera over the track so the menu floats above
    // the real world (the menu/how-to overlays are glassy and let it show through).
    updateMenuCamera(now / 1000); // advance tour timing/phase
    renderMenuBackground(now / 1000); // single render, or dual-render cross-dissolve
    return;
  }

  if (state === State.COUNTDOWN) {
    // In multiplayer, drive the countdown straight off the shared clock so every
    // client reaches GO at the same instant regardless of local frame timing.
    if (MP.enabled && MP.startAt) countdown = (MP.startAt - MP.net.now()) / 1000;
    else countdown -= dt;
    updateCamera(dt, camPos.lengthSq() === 0);
    const n = Math.ceil(countdown - 1);
    hud.showToast(n > 0 ? `${n}` : "GO!");
    // A beep on each 3/2/1 and a higher GO! chirp, as the number changes.
    if (n !== prevCountN && n <= 3) {
      audio.countdownBeep(Math.max(0, n));
      prevCountN = n;
    }
    // Re-zero steering near the end of the countdown, once the player has
    // settled into their driving grip.
    if (n === 1 && !countdownCalibrated) {
      input.calibrate();
      countdownCalibrated = true;
    }
    if (countdown <= 0) {
      state = State.RACING;
      MP.startAt = 0;
      audio.startEngine(); // engines fire up on the green light
      audio.playMusic("bg");
      // Hold everyone's first shot for an opening grace period.
      for (const k of karts) k.shootCooldown = Math.max(k.shootCooldown, SHOOT_OPENING_LOCKOUT);
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
    // Hold the shoot button to charge a faster/further shot; fire on release.
    if (input.shootHeld && player.shootCooldown <= 0)
      player.shootCharge = Math.min(player.shootCharge + dt / SHOOT_CHARGE_TIME, 1);
    if (input.consumeShootRelease()) {
      fireHairball(player, player.shootCharge);
      player.shootCharge = 0;
    }
    if (input.consumeBoost() && player.boostMeter >= 1) {
      if (player.tootBoost()) {
        player.boostMeter = 0; // fully deplete on use
        effects.tootBurst(player);
        audio.toot();
      }
    }
    updateBoostUI();

    // Audio: keep the listener on the player, drive the engine pitch with speed,
    // and screech the tires while drifting.
    audio.setListener(
      player.position.x,
      player.position.z,
      Math.sin(player.heading),
      Math.cos(player.heading)
    );
    audio.setEngine(Math.min(1, Math.abs(player.speed) / player.maxSpeed), player.boosting);
    // Tires screech while drifting (full) and chatter through hard turns at speed
    // (lighter), so cornering has grip feedback even without a drift.
    const _sp = Math.abs(player.speed);
    const _drift = player.drifting && _sp > 8;
    const _hardTurn = !player.drifting && Math.abs(player.steerInput) > 0.62 && _sp > 24;
    audio.setSkid(_drift || _hardTurn, _drift ? 1 : 0.45);

    // Rainbow boost trail + drift sparks/skids for the player.
    if (player.boosting) effects.trickle(player, player.catnipBoosting);
    if (player.drifting) {
      effects.driftSparks(player);
      effects.skid(player);
    }
    // Chromatic aberration ramps up with the boost.
    const aberrTarget = player.boosting ? 0.008 : 0;
    fxPass.uniforms.uAberr.value += (aberrTarget - fxPass.uniforms.uAberr.value) * Math.min(1, dt * 6);
    // Radial (zoom) motion blur: kept very subtle and only near top speed, with
    // NO extra kick while boosting — boosting is frequent, so that kick smeared
    // the screen most of the time. The FOV punch on boost already sells speed.
    // Smoothed so it eases in/out, never snaps.
    const spd = Math.abs(player.speed);
    const radialTarget = Math.min(1, Math.max(0, (spd - 34) / 40)) * 0.006;
    fxPass.uniforms.uRadial.value += (radialTarget - fxPass.uniforms.uRadial.value) * Math.min(1, dt * 4);

    // AI
    // AI drivers — plus any kart that's finished, so it auto-pilots its victory lap.
    // Hand them the live catnip crate positions so they detour to grab the power-up.
    const catnipTargets = props ? props.catnipTargets() : null;
    for (const k of karts) if (!k.isPlayer || k.finished) k.driveAI(track, dt, catnipTargets);
    aiActions(dt);

    // Step physics
    for (const k of karts) k.update(dt, track);
    applyBoostPads(dt);
    resolveCollisions();
    resolveRemoteCollisions(); // bump against remote ghost karts (multiplayer)
    hairballs.update(
      dt,
      karts,
      MP.enabled ? MP.remotes : null,
      MP.enabled
        ? (id, dir) => {
            if (!MP.net) return;
            MP.net.sendHit(id, dir);
            // Instant local feedback: jolt the ghost in the hairball's direction
            // so the hit reads immediately, bridging the round-trip until the
            // victim's real spin-out streams back over the network.
            const r = MP.remotes.get(id);
            if (r) r.bump(dir.x, dir.z, 15);
          }
        : null
    );
    // Sparks where a kart scraped a railing; skid marks while spinning out;
    // a charge-coloured cloud puff when a drift boost is released.
    for (const k of karts) {
      if (k.wallHit) {
        effects.wallSparks(k);
        audio.scrape(k === player ? null : k.position);
        k.wallHit = false;
      }
      if (k.spinTimer > 0) effects.skid(k);
      // Drift sparks + skid marks for the rest of the field too (the player is
      // handled above), so the whole pack throws sparks through the corners —
      // especially eye-catching at night with the bloom.
      if (k.drifting && k !== player && Math.abs(k.speed) > 8) {
        effects.driftSparks(k);
        effects.skid(k);
      }
      // "Bonk" the moment a kart is freshly spun out (player handled by triggerHit).
      if (k.spinTimer > 0 && (k._prevSpin || 0) <= 0 && k !== player) {
        audio.hit(k.position);
        audio.skidBurst(k.position, 0.8);
      }
      k._prevSpin = k.spinTimer;
      if (k.boostPuff >= 0) {
        effects.tootBurst(k, k.boostPuff);
        audio.boost(k === player ? null : k.position);
        k.boostPuff = -1;
      }
    }
    updateFireworks(dt);
    effects.update(dt);
    updatePlacement();

    // Weather follows the BIOME (snow in alpine, rain in the wet forest), not
    // altitude — so a procedural track's hills don't sprinkle snow into warm
    // biomes. The Weather class crossfades smoothly as you cross between them.
    const where = biomeWeatherAt(player.position.x, player.position.z);
    weather.setWeather(where);
    // Sell the rain: ease saturation/exposure down a touch as it picks up.
    const wet = weather.rainAmount;
    // Kick up a splash when driving through a puddle while it's raining.
    if (track.puddles && wet > 0.2 && Math.abs(player.speed) > 6) {
      player._puddleCd = (player._puddleCd || 0) - dt;
      if (player._puddleCd <= 0) {
        for (const pd of track.puddles) {
          const dx = player.position.x - pd.x;
          const dz = player.position.z - pd.z;
          if (dx * dx + dz * dz < pd.r * pd.r) {
            effects.splash(player.position);
            audio.splash();
            player._puddleCd = 0.14;
            break;
          }
        }
      }
    }
    fxPass.uniforms.uSat.value = moodSat * (1 - 0.22 * wet);
    // The near-white snow section sails past the bloom threshold and blows the
    // whole frame out. Ease bloom down + raise its threshold + pull exposure
    // back in proportion to how deep into the snow we are (smoothed, not snapped).
    _snowBlend += ((where === "snow" ? 1 : 0) - _snowBlend) * Math.min(1, dt * 1.2);
    bloomPass.strength = BLOOM_STRENGTH * (1 - 0.55 * _snowBlend);
    bloomPass.threshold = BLOOM_THRESHOLD + 0.1 * _snowBlend;
    // Lightning: in proper rain, fire an occasional whole-scene flash (just a
    // brief exposure punch — no real light — with a flicker so it reads as a
    // double strike). Self-restoring since exposure is recomputed each frame.
    if (wet > 0.4) {
      _lightningNext -= dt;
      if (_lightningNext <= 0) {
        _lightning = 1;
        _lightningNext = 5 + Math.random() * 13;
      }
    }
    _lightning = Math.max(0, _lightning - dt * 3.2);
    const flash = _lightning > 0 ? Math.max(0, 0.45 + 0.55 * Math.sin(_lightning * 42)) * _lightning : 0;
    renderer.toneMappingExposure = moodExposure * (1 - 0.1 * wet - 0.12 * _snowBlend) * (1 + flash * 1.5);

    // Screen shake + flash when the player gets spun out.
    if (player.spinTimer > 0 && prevPlayerSpin <= 0) triggerHit();
    prevPlayerSpin = player.spinTimer;

    const laps = track.totalLaps;
    // Time trial: start the lap clock the moment we first cross the start line.
    if (timeTrial && prevPlayerLap < 0 && player.lap >= 0) ttLapStart = raceTime;

    // Lap toast for the player (normal races only)
    if (!timeTrial && player.lap !== prevPlayerLap && player.lap >= 1 && !player.finished) {
      const lapNum = player.displayLap(laps);
      if (lapNum >= 2) {
        hud.showToast(`Lap ${lapNum}/${laps}`);
        audio.lap();
      }
    }
    prevPlayerLap = player.lap;

    // HUD
    hud.update({
      lapNum: player.displayLap(laps),
      totalLaps: laps,
      place: player.place,
      totalKarts: karts.length + (MP.enabled ? MP.remotes.size : 0),
      speedKmh: Math.abs(player.speed) * 3.0,
      time: timeTrial && ttLapStart >= 0 ? raceTime - ttLapStart : raceTime,
    });

    updateCamera(dt);

    // Hand off to the victory lap once the player finishes; show results after a
    // celebratory beat (camera orbits the kart, fireworks pop) rather than instantly.
    if (player.finished) {
      audio.finish();
      audio.setSkid(false);
      if (timeTrial) {
        const lapTime = player.finishTime - (ttLapStart >= 0 ? ttLapStart : 0);
        _ttResult = recordTimeTrial(lapTime);
        hud.showToast("LAP DONE!");
        setTimeout(showResults, 4000);
      } else {
        hud.showToast("FINISH!");
        if (MP.enabled && MP.net) {
          // Stamp the finish on the shared clock so every client ranks it the
          // same way (local elapsed time drifts apart over a long race).
          player.finishClock = MP.net.now();
          MP.net.sendFinish(player.finishTime, player.finishClock);
        }
        setTimeout(showResults, 13000);
      }
      state = State.FINISHED; // freeze player input; kart auto-pilots its victory lap
    }
  }

  if (state === State.FINISHED) {
    // Victory lap: every kart auto-pilots around the circuit and the camera orbits
    // the player's kart; fireworks keep popping from the arch.
    for (const k of karts) k.driveAI(track, dt);
    for (const k of karts) k.update(dt, track);
    resolveCollisions();
    updateFireworks(dt);
    effects.update(dt);
    updateCamera(dt);
  }

  renderFrame();
}

// WebGPURenderer initialises asynchronously — only start the render loop once the
// backend is ready (renderFrame() also guards on this flag for any earlier calls).
let gpuParticles = null;
rendererReady
  .then(() => {
    _rendererReady = true;
    // Ambient GPU compute motes: warm dust by day, cool sparkles at night.
    const night = TIME_OF_DAY === "night";
    initGpuParticles(scene, renderer, {
      count: 450, // sweet spot: 650 read as "too many", 280 as "none" — this is the sparse-but-present middle
      tint: night ? 0xbcd0ff : TIME_OF_DAY === "sunset" ? 0xffd9a0 : 0xfff0c8,
      // A touch more opaque so the (now fewer) specks actually catch the light.
      opacity: night ? 0.5 : TIME_OF_DAY === "sunset" ? 0.3 : 0.22,
      size: night ? 0.52 : 0.42,
    }).then((p) => { gpuParticles = p; });
  })
  .catch((err) => console.error("[zoomies] renderer init failed:", err))
  .finally(() => requestAnimationFrame(loop));

// Browsers block audio until a user gesture, so the menu can't autoplay music on
// load. Start it (fading in) on the player's FIRST interaction of any kind —
// tapping anywhere, not just a button. Capture phase so nothing swallows it.
function startMenuMusicOnce() {
  audio.unlock();
  if (!audio.ready) return; // gesture didn't unlock yet; wait for the next one
  audio.playMusic("bg"); // one continuous track for menu + race; safe to call any state
  // Keep listening until the track is actually playing (the first gesture's
  // play() can be rejected on iOS) — or the player has muted music. Only then
  // stop watching for gestures.
  if (audio.musicPlaying || !audio.musicOn) {
    for (const ev of ["pointerdown", "touchstart", "mousedown", "keydown"]) {
      window.removeEventListener(ev, startMenuMusicOnce, true);
    }
  }
}
for (const ev of ["pointerdown", "touchstart", "mousedown", "keydown"]) {
  window.addEventListener(ev, startMenuMusicOnce, true);
}

// Installed as a home-screen PWA? Some platforms (e.g. Android) let an installed
// app autoplay audio with no gesture, so try to start the menu music right away.
// iOS still requires a tap even in standalone — the first-interaction starter
// above remains the fallback, and playMusic retries a rejected play().
const _isStandalonePWA =
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;
if (_isStandalonePWA) {
  audio.unlock();
  audio.playMusic("bg");
}
