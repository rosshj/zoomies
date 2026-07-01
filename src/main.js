import * as THREE from "three";
// WebGPU post-processing (M4): TSL node graph via PostProcessing, replacing the
// legacy EffectComposer chain.
import { pass, mix, vec3, float, smoothstep, luminance, saturation, viewportUV, uniform, color as tslColor, normalView, positionViewDirection, Fn, Loop, If, rtt, mrt, output, metalness } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { createScene, moodForTimeOfDay } from "./scene.js";
import { initGpuParticles } from "./gpuparticles.js";
import { installCrashGuard, watchGpu, consumeLastCrash } from "./crashguard.js";
installCrashGuard(); // capture errors/rejections from the very start (survives a reload)
import { Weather } from "./weather.js";
import { Track, previewLoopPoints } from "./track.js";
import { Kart, setSunShadow } from "./kart.js";
import { setLightLevel, CAT_PATTERNS, CAT_ACCESSORIES } from "./models.js";
import { initProps } from "./props.js";
import { Input } from "./input.js";
import { HairballManager, TRI_FAN } from "./hairball.js";
import { HUD, ordinal } from "./hud.js";
import { buildWorld, biomeWeatherAt, biomeRoadStyle, biomeDustColor } from "./scenery.js";
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

// Garage: the player picks a cat (fur colour) and kart (body colour) before the
// race. Named presets so it reads like a character-select; the saved selection is
// stored as indices into these arrays (clamped on load) and reused for solo, the
// multiplayer broadcast identity, and to keep the AI off the player's colours.
// Each cat is a colour + an explicit markings pattern, so the seven read as
// distinct breeds rather than recolours: tabby (banded), tuxedo (white bib +
// socks + tail-tip), mitted (small white socks/bib), solid (plain coat), point
// (darker ears/muzzle/paws/tail). createCat falls back to deriving a pattern
// from the colour when none is given (recoloured AI / multiplayer cats).
// Nine distinct breeds, each a different markings template (not just a recolour
// of the same one): see createCat for how each pattern is drawn.
const CAT_PRESETS = [
  { name: "Marmalade", fur: 0xf0a830, pattern: "spotted" }, // ginger spotted tabby
  { name: "Smokey", fur: 0x8c9298, pattern: "solid" }, // plush solid grey (Russian Blue)
  { name: "Shadow", fur: 0x2a2a2a, pattern: "tuxedo" }, // black & white tuxedo
  { name: "Snow", fur: 0xfbfbfb, pattern: "snowshoe" }, // white + seal mask/points
  { name: "Whiskey", fur: 0xc8966a, pattern: "tabby" }, // classic brown mackerel tabby
  { name: "Nelson", fur: 0x4a3328, pattern: "mitted" }, // brown, white chest + socks
  { name: "Pickle", fur: 0xf3dcb6, pattern: "point" }, // seal-point Siamese
  { name: "Patches", fur: 0xf5ead6, pattern: "calico" }, // tricolour calico (cream + ginger + black), collar & bell
  { name: "Pepper", fur: 0x9aa2a8, pattern: "tabby" }, // cool silver mackerel tabby
  { name: "Cocoa", fur: 0x5a3b2a, pattern: "tortie" }, // mottled tortoiseshell (ginger + black, no white)
];
// Each kart: a colour, a body silhouette (style 0=GP / 1=roadster / 2=buggy /
// 3=finned speedster), and a racing number stamped on the side roundels.
const KART_PRESETS = [
  { name: "Ember", color: 0xe53935, style: 0, number: 5 },
  { name: "Lagoon", color: 0x1e88e5, style: 1, number: 7 },
  { name: "Clover", color: 0x43a047, style: 2, number: 3 },
  { name: "Tangerine", color: 0xfb8c00, style: 0, number: 9 },
  { name: "Grape", color: 0x8e24aa, style: 1, number: 4 },
  { name: "Sunbeam", color: 0xfdd835, style: 2, number: 1 },
  { name: "Teal", color: 0x00897b, style: 0, number: 8 },
  { name: "Comet", color: 0x26c6da, style: 3, number: 2 }, // jet-age finned speedster
  { name: "Nova", color: 0xec407a, style: 3, number: 6 },
];
// A "Custom" slot sits one past the last preset in each stepper; landing on it
// reveals the creator (colour / pattern / accessory / name) and the look is read
// from garageConfig.customCat / .customKart instead of the preset arrays.
const CUSTOM_CAT_IDX = CAT_PRESETS.length;
const CUSTOM_KART_IDX = KART_PRESETS.length;
const KART_STYLE_COUNT = 4; // GP / roadster / buggy / finned (see createKartModel STYLES)
const DEFAULT_CUSTOM_CAT = { name: "My Cat", fur: 0xf0a830, pattern: "spotted", accessory: "cap" };
const DEFAULT_CUSTOM_KART = { name: "My Kart", color: 0xe53935, style: 0, number: 0 };
const GARAGE_KEY = "zoomies-garage-v1";
const _clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
const _clampColor = (v, dflt) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : dflt);
const _clampName = (v, dflt) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 14) : dflt);
function sanitizeCustomCat(c) {
  c = c && typeof c === "object" ? c : {};
  return {
    name: _clampName(c.name, DEFAULT_CUSTOM_CAT.name),
    fur: _clampColor(c.fur, DEFAULT_CUSTOM_CAT.fur),
    pattern: CAT_PATTERNS.includes(c.pattern) ? c.pattern : DEFAULT_CUSTOM_CAT.pattern,
    accessory: CAT_ACCESSORIES.includes(c.accessory) ? c.accessory : DEFAULT_CUSTOM_CAT.accessory,
  };
}
function sanitizeCustomKart(k) {
  k = k && typeof k === "object" ? k : {};
  return {
    name: _clampName(k.name, DEFAULT_CUSTOM_KART.name),
    color: _clampColor(k.color, DEFAULT_CUSTOM_KART.color),
    style: _clampInt(k.style, 0, KART_STYLE_COUNT - 1, DEFAULT_CUSTOM_KART.style),
    number: _clampInt(k.number, 0, 99, DEFAULT_CUSTOM_KART.number),
  };
}
function loadGarageConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(GARAGE_KEY));
    if (c && typeof c === "object") {
      return {
        cat: clampIdx(c.cat, CAT_PRESETS.length + 1), // +1: the Custom slot is valid
        kart: clampIdx(c.kart, KART_PRESETS.length + 1),
        customCat: sanitizeCustomCat(c.customCat),
        customKart: sanitizeCustomKart(c.customKart),
      };
    }
  } catch {
    /* ignore */
  }
  // Marmalade in the Ember kart (the original "You"), with sensible custom defaults.
  return { cat: 0, kart: 0, customCat: sanitizeCustomCat(), customKart: sanitizeCustomKart() };
}
function clampIdx(v, n) {
  v = Number.isInteger(v) ? v : 0;
  return v < 0 ? 0 : v >= n ? 0 : v;
}
function saveGarageConfig(c) {
  try {
    localStorage.setItem(GARAGE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
// Resolve a garage config (live or draft) to the concrete cat / kart look,
// transparently handling the Custom slot.
function catSpec(cfg) {
  if (cfg.cat === CUSTOM_CAT_IDX) {
    const c = cfg.customCat || DEFAULT_CUSTOM_CAT;
    return { name: c.name, fur: c.fur, pattern: c.pattern, accessory: c.accessory };
  }
  const p = CAT_PRESETS[cfg.cat] || CAT_PRESETS[0];
  return { name: p.name, fur: p.fur, pattern: p.pattern, accessory: undefined };
}
function kartSpec(cfg) {
  if (cfg.kart === CUSTOM_KART_IDX) {
    const k = cfg.customKart || DEFAULT_CUSTOM_KART;
    return { name: k.name, color: k.color, style: k.style, number: k.number };
  }
  return KART_PRESETS[cfg.kart] || KART_PRESETS[0];
}
const garageConfig = loadGarageConfig();
// The chosen look as concrete colours + a display name (the cat's name).
function playerLook() {
  const cat = catSpec(garageConfig);
  const kart = kartSpec(garageConfig);
  return { catColor: cat.fur, catPattern: cat.pattern, catAccessory: cat.accessory, color: kart.color, kartStyle: kart.style, kartNumber: kart.number, name: cat.name };
}

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

// AI difficulty. The hand-tuned field IS "hard"; easy/medium dial the AI down
// across a few knobs (top speed, rubber-band catch-up, how often they shoot, how
// well they shield, and how far they'll detour for catnip). Persisted so it sticks.
const AI_DIFFICULTY = {
  easy: { label: "Easy", speed: 0.82, rubber: 0.35, shoot: 0.5, shield: 0.5, catnip: 0.4 },
  medium: { label: "Medium", speed: 0.92, rubber: 0.7, shoot: 0.8, shield: 0.8, catnip: 0.75 },
  hard: { label: "Hard", speed: 1.0, rubber: 1.0, shoot: 1.0, shield: 1.0, catnip: 1.0 },
};
const DIFF_ORDER = ["easy", "medium", "hard"];
const DIFF_KEY = "zoomies-difficulty";
let DIFFICULTY = "hard"; // default = the current tuned field
try { const _d = localStorage.getItem(DIFF_KEY); if (_d && AI_DIFFICULTY[_d]) DIFFICULTY = _d; } catch {}

const { renderer, scene, camera, sun, applyMood, ready: rendererReady, skyMesh, starField } = createScene();
// Drive renderer.info ourselves so the FPS overlay's draw-call count is the whole
// frame's total (the post-processing graph does many sub-renders; autoReset would
// wipe the count between them and leave only the last pass).
renderer.info.autoReset = false;
let _rendererReady = false; // flips true once WebGPURenderer.init() resolves
// Light the world for this race's time of day up front, so the menu's live
// backdrop already shows midday / sunset / night.
const MOOD = moodForTimeOfDay(TIME_OF_DAY);
applyMood(MOOD);
// Aim the karts' projected contact shadows along this race's sun (long at sunset).
setSunShadow(MOOD.sunDir);
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
const _GN = 8, _gDensity = 0.92, _gDecay = 0.9, _gThreshold = 0.67; // 22 -> 14 -> 10 -> 8 samples: facing the sun is the worst frame-rate hit (this loop runs per-pixel only then); longer step + tighter decay + jitter keep the shaft length
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
// Colour grade applied to whichever composite (high or low) we feed it, so both
// quality tiers look consistent — Low just composites fewer passes into the base.
function gradeOutput(base) {
  let c = base;
  c = saturation(c, _uSat);
  c = c.sub(0.5).mul(_uContrast).add(0.5); // contrast around mid-grey
  // Lift the darkest areas so shadows don't crush to near-black.
  c = c.add(_uShadowLift.mul(c.clamp(0, 1).oneMinus()));
  const lum = luminance(c.clamp(0, 1));
  // Cinematic split-tone: cool shadows, warm highlights.
  c = c.mul(mix(vec3(0.96, 0.99, 1.06), vec3(1.08, 1.02, 0.92), smoothstep(0.15, 0.85, lum)));
  const d = viewportUV.sub(0.5);
  const vig = smoothstep(0.92, 0.34, d.length());
  c = c.mul(mix(float(1), vig, _uVignette));
  return c;
}
// High: scene + SSR water reflections + god-ray shafts + bloom. Low: scene +
// bloom only — drops SSR ("the heaviest effect") and the per-pixel god-ray pass,
// which is the big GPU/memory win on weak devices (see applyQuality()).
const _highOutput = gradeOutput(_sceneTex.add(_ssrTex).add(_shaftTex).add(_bloomNode));
const _lowOutput = gradeOutput(_sceneTex.add(_bloomNode));
postProcessing.outputNode = _highOutput;
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


// Knockable roadside props (crates/barrels/leaf piles) plus floating POWER-UP
// BOXES on the racing line. Best-effort: if it fails to build, `props` stays null
// and the game is fine. Grounded crates just tumble; only the floating boxes hold
// a power-up — driving through one rolls a position-weighted item (see grantItem).
let props = null;
initProps(scene, track, {
  seed: WORLD_SEED,
  size: trackConfig.mode === "custom" ? trackConfig.size ?? 0.5 : 0.5,
  heightAt: world.heightAt, // so leaf piles sit on the real ground, not the road-curve height
  onItem: (kart, pos) => grantItem(kart),
}).then((p) => {
  props = p;
});

const BOX_COOLDOWN = 3; // s — a kart can't vacuum up boxes back-to-back

// Power-up box pickup. The roll is POSITION-WEIGHTED to keep races tight: the
// leader mostly gets a defensive shield (which doesn't extend a lead in distance),
// while trailing karts get catch-up speed (catnip) and offence (tri-furball). The
// three weights interpolate by race position and always sum to 1. Returns false if
// the box shouldn't be consumed (kart on cooldown), so it stays floating.
function grantItem(kart) {
  if (timeTrial) return false; // no power-ups in a solo time trial
  // Multiplayer rivals are render-only ghosts; their real power-up is granted on
  // THEIR client. Let the box sink here, but don't apply gameplay effects to a
  // ghost (a phantom shield would wrongly block our shots).
  if (kart.isRemote) return true;
  if (kart.boxCooldown > 0) return false; // still cooling down — leave the box
  kart.boxCooldown = BOX_COOLDOWN;

  const n = Math.max(2, _fieldCount);
  const f = Math.min(1, Math.max(0, ((kart.place || 1) - 1) / (n - 1))); // 0 leader .. 1 last
  const wShield = 0.65 - 0.5 * f; // 0.65 (leader) .. 0.15 (last)
  const wTri = 0.25 + 0.15 * f;   // 0.25 (leader) .. 0.40 (last)
  // catnip takes the remainder: 0.10 (leader) .. 0.45 (last)

  effects.tootBurst(kart, 2, false); // a sparkly grab poof
  audio.boost(kart === player ? null : kart.position);
  const r = Math.random();
  if (r < wShield) {
    kart.giveShield(15);
    if (kart === player) hud.showToast("🛡️ Shield — 15s!");
  } else if (r < wShield + wTri) {
    kart.giveTriShots(3);
    if (kart === player) hud.showToast("🐾 Tri-furball ×3!");
  } else {
    kart.giveCatnip();
    if (kart === player) hud.showToast("🌿 Catnip boost!");
  }
  return true;
}

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
// Sized to the AI roster (6) so every kart in a normal race gets its own beam with
// ZERO spare lights — a budget of 8 left 2 spotlights always allocated but unused,
// and every dynamic light costs per-pixel even at zero intensity. Larger MP lobbies
// fall back to bulbs beyond the budget (the per-frame assignment handles that).
const HEADLIGHT_BUDGET = 6; // = ROSTER size; was 8 (2 wasted always-on lights at night)
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
// Cache the toon conversion per source material (WeakMap → auto-freed when the
// source material is GC'd between races). With the merged kart/cat meshes a few
// constant materials (chrome, tyre, dark…) are shared across every racer, so
// caching collapses them to a single toon material / render pipeline instead of
// one per occurrence.
const _toonCache = new WeakMap();
function toToon(m) {
  if (!m || !m.isMeshStandardMaterial || (m.userData && m.userData.skipToon)) return m;
  if (_toonCache.has(m)) return _toonCache.get(m);
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
  if ((ud.backlight || ud.rim || ud.paint) && matte) {
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
    if (ud.paint) {
      // A soft, banded "toy gloss" highlight on kart paint: a single crisp
      // specular bloom toward the sun. Toon-banded (smoothstep) so it reads as a
      // shaped glint, not a smooth Phong lobe; kept gentle so it never blows out.
      const lightDir = uSunViewNode.negate().normalize();
      const half = lightDir.add(positionViewDirection).normalize();
      const spec = normalView.dot(half).max(0).pow(26);
      const glint = smoothstep(0.32, 0.58, spec);
      // mostly white so the shine reads on any body colour, warmed by the sun
      // tint; kept low so the paint is a soft satin, not glossy.
      const paintTerm = tslColor(0xffffff).mul(0.22).add(uSunColNode.mul(0.6)).mul(glint);
      term = term ? term.add(paintTerm) : paintTerm;
    }
    t.emissiveNode = term;
    _toonCache.set(m, t);
    return t;
  }
  // Everything else: stock toon (auto-converted to a node material by WebGPU,
  // keeping the gradient banding and any dynamic emissiveIntensity).
  const stock = new THREE.MeshToonMaterial(params);
  _toonCache.set(m, stock);
  return stock;
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
const _dustCol = new THREE.Color(); // reused each frame for the biome-tinted kart dust
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

// First palette colour not already taken (the garage palettes are bigger than the
// field, so there's always a free one).
function _pickUnused(palette, used) {
  for (const c of palette) if (!used.has(c)) return c;
  return palette[0];
}
// The per-race roster: the player (slot 0) wears the garage selection; the AI keep
// their names/skills but get nudged off the player's kart + cat colours so the
// player stands out. Multiplayer / time-trial fields are the player alone.
function raceRoster() {
  const look = playerLook();
  const playerCfg = { ...ROSTER[0], color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, kartStyle: look.kartStyle, kartNumber: look.kartNumber };
  if (MP.enabled || timeTrial) return [playerCfg];
  const usedKart = new Set([look.color]);
  const usedCat = new Set([look.catColor]);
  const ai = ROSTER.slice(1).map((cfg, i) => {
    let { color, catColor } = cfg;
    if (usedKart.has(color)) color = _pickUnused(KART_PRESETS.map((k) => k.color), usedKart);
    usedKart.add(color);
    if (usedCat.has(catColor)) catColor = _pickUnused(CAT_PRESETS.map((c) => c.fur), usedCat);
    usedCat.add(catColor);
    // Spread body styles + give each rival its own number so the field varies.
    return { ...cfg, color, catColor, kartStyle: i % 3, kartNumber: 11 + i * 6 };
  });
  return [playerCfg, ...ai];
}

function buildKarts() {
  for (const k of karts) scene.remove(k.group);
  karts = [];
  _hlRamp = 0.18; // headlights start dim and ramp up once racing, to avoid a grid blowout
  rimShaders.length = 0; // drop last race's kart shaders before rebuilding
  // Player wears the garage pick; AI avoid clashing with it. Multiplayer is
  // humans-only and time trial is solo, so both are just the player's kart.
  const roster = raceRoster();
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
  const diff = AI_DIFFICULTY[DIFFICULTY] || AI_DIFFICULTY.hard;
  roster.forEach((cfg, i) => {
    const kart = new Kart(cfg);
    // Scale the AI down for the chosen difficulty (hard = no change). Slower top
    // speed + weaker rubber-band, set on baseMaxSpeed so the per-frame catch-up
    // (aiActions) scales from it; the rest of the knobs live on kart.diff.
    if (!cfg.isPlayer) {
      kart.diff = diff;
      kart.baseMaxSpeed *= diff.speed;
      kart.maxSpeed = kart.baseMaxSpeed;
      kart.shieldSkill *= diff.shield;
    }
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

// --- Multiplayer ----------------------------------------------------------
// Opt-in: only active when the URL has ?mp=1 (and a transport key is set).
// Remote players appear as karts driven by interpolated network snapshots; they
// glide alongside AND collide with single-player-parity bumps (resolved locally,
// self-authoritatively) and share placement. The room is the world seed, so a
// link like ?seed=ABC123&mp=1 puts everyone in the same world and lobby.
// Am I the HOST (the player who created this room), not just whoever drew the
// lowest random id? Persisted by hosted-seed so a refresh keeps hostship while a
// joiner / invite-link opener (different seed) is correctly a guest.
let _amHost = false;
try { _amHost = sessionStorage.getItem("mp-host-seed") === WORLD_SEED; } catch { /* ignore */ }

// Broadcast the player's garage selection so rivals see the cat + kart they chose
// (display name = the cat's name), plus whether I'm the room's host.
function makeMpIdentity() {
  const look = playerLook();
  return { name: look.name, color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, kartStyle: look.kartStyle, kartNumber: look.kartNumber, host: _amHost };
}

// Up to 6 players share a race (you + 5 others). The grid, headlight pool and
// placement all scale to this; a late 7th joiner is kept out of the rendered field.
const MAX_PLAYERS = 6;
const MP = {
  enabled: false, net: null, remotes: new Map(),
  parked: new Map(), // id -> { r, since } — soft-despawned ghosts held for revival
  sendAcc: 0, hudAcc: 0, hud: null,
  // (adaptive interpolation delay lives in _interpDelay, below)
  inLobby: false, startAt: 0, connState: null,
};
let _interpDelay = INTERP_DELAY; // adaptive: eased toward a target from the live ping
// Total humans currently in the room (me + rendered remotes).
function mpPlayerCount() {
  return 1 + MP.remotes.size;
}

// The same sorted id order assigns starting-grid slots so players don't stack up.
function mpOrderedIds() {
  const ids = [MP.net && MP.net.id, ...MP.remotes.keys()].filter(Boolean);
  ids.sort();
  return ids;
}
// The host is simply the player who CREATED the room (clicked Host Game) — not
// whoever drew the lowest id. `_amHost` is authoritative for me; the same flag
// rides in every identity so I can tag the host (👑) in the player list. No
// lowest-id election (that was the bug), so a guest never transiently sees Start.
// (If the host leaves, the room just can't launch — host migration is a separate
// feature.)
function mpHostId() {
  if (_amHost && MP.net && MP.net.id) return MP.net.id;
  for (const r of MP.remotes.values()) if (r.host) return r.id;
  return null;
}
function mpIsHost() {
  return !!(MP.enabled && _amHost);
}
function mpGridSlot() {
  const i = MP.net ? mpOrderedIds().indexOf(MP.net.id) : 0;
  return Math.max(0, i);
}

// Soft-despawn grace: a peer whose presence flaps (a mobile reconnect) is "parked"
// hidden for this long and REVIVED on rejoin, instead of being destroyed and
// rebuilt. The old destroy/recreate churned a fresh Kart every blip — and
// dispose() only removes from the scene (it can't free the cat's shared materials
// safely), so that churn leaked GPU memory until the tab crashed. Parked ghosts
// live OUTSIDE MP.remotes, so peer counts / placement / rendering see only the
// active field, unchanged.
const REMOTE_GRACE_MS = 12000;

function mpSpawn(identity) {
  if (MP.remotes.has(identity.id)) return;
  // Revive a parked ghost (peer flapped and returned) — reuse the Kart and its
  // interpolation buffer instead of churning a new one.
  const parked = MP.parked.get(identity.id);
  if (parked) {
    MP.parked.delete(identity.id);
    parked.r.host = !!identity.host;
    parked.r.group.visible = true;
    MP.remotes.set(identity.id, parked.r);
    return;
  }
  // Cap the rendered field at MAX_PLAYERS (you + MAX_PLAYERS-1 remotes). Beyond
  // that the grid/headlight pool run out, so extra joiners aren't drawn into the
  // race. (Realistically a friends' room is ≤6; a true server-side cap would need
  // room logic Ably's client-side presence doesn't provide.)
  if (MP.remotes.size >= MAX_PLAYERS - 1) return;
  const r = new RemoteKart(identity);
  r.host = !!identity.host; // remember who the room's host is (for the 👑 + Start)
  decorateKartGroup(r.group);
  scene.add(r.group);
  MP.remotes.set(identity.id, r);
}
// `force` tears the ghost down immediately (leaving multiplayer); otherwise it's a
// soft despawn — parked for possible revival within the grace window, then reaped
// by the sweeper in updateMultiplayer.
function mpDespawn(id, force = false) {
  const r = MP.remotes.get(id) || (MP.parked.get(id) && MP.parked.get(id).r);
  if (!r) return;
  MP.remotes.delete(id);
  if (force) {
    MP.parked.delete(id);
    r.dispose(scene);
    return;
  }
  if (r.group) r.group.visible = false;
  MP.parked.set(id, { r, since: performance.now() });
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
  MP.connState = "connecting";
  setMpStatus("connecting");
  const transportP = ablyKey
    ? createAblyTransport({ key: ablyKey, room: WORLD_SEED, onState: setMpStatus })
    : createPartyTransport({ host, room: WORLD_SEED });
  transportP
    .then((transport) => {
      const net = new Net(transport, makeMpIdentity());
      MP.net = net;
      net.on("peer", (identity) => {
        mpSpawn(identity);
        setMpStatus("connected"); // refresh the "N friends here" count immediately
        if (MP.inLobby) renderLobby();
      });
      net.on("peerleave", (id) => {
        mpDespawn(id);
        setMpStatus("connected");
        if (MP.inLobby) renderLobby();
      });
      // Once our own connection is acknowledged, fill in the lobby (it may have
      // been opened before the socket finished connecting).
      net.on("open", () => {
        setMpStatus("connected");
        if (MP.inLobby) renderLobby();
      });
      net.on("close", () => setMpStatus(MP.connState === "failed" ? "failed" : "closed"));
      net.on("state", (id, pose) => {
        const r = MP.remotes.get(id);
        if (r) r.pushState(pose);
      });
      net.on("start", (at) => beginSyncedRace(at));
      net.on("shoot", (s) => {
        const pos = new THREE.Vector3(s.px, s.py, s.pz);
        const dir = new THREE.Vector3(s.dx, s.dy, s.dz);
        if (s.t) {
          // Tri-furball: fan into three, matching the shooter's local spread.
          const up = new THREE.Vector3(0, 1, 0);
          for (const a of TRI_FAN) hairballs.spawnAt(pos, dir.clone().applyAxisAngle(up, a), s.c || 0);
        } else {
          hairballs.spawnAt(pos, dir, s.c || 0);
        }
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
      // Keep MP.enabled so the lobby/menu can SHOW the failure instead of silently
      // reverting to solo (a dead button is exactly what reads as "doesn't work").
      const code = err && err.code;
      const msg =
        code === "NO_KEY" ? "Multiplayer isn't configured (no key)" :
        code === "SDK_LOAD" ? "Couldn't load multiplayer (check your connection)" :
        code === "AUTH" ? "Multiplayer key rejected — it may be expired" :
        code === "TIMEOUT" ? "Couldn't reach the server — check your connection" :
        (err && err.message) || "Multiplayer failed to connect";
      MP.connState = "failed";
      setMpStatus("failed", msg);
    });
}

// Friendly multiplayer connection status, shown in BOTH the bottom-left readout
// and the lobby, so a player always knows whether they're actually connected
// (silent failure was the main reason MP "looked broken"). Ably drives this live.
function setMpStatus(state, reason) {
  MP.connState = state;
  const label =
    state === "connected" ? "Connected" :
    state === "connecting" ? "Connecting…" :
    state === "disconnected" ? "Reconnecting…" :
    state === "suspended" ? "Connection lost — retrying…" :
    state === "failed" ? (reason || "Connection failed") :
    state === "closed" ? "Disconnected" :
    "…";
  if (MP.hud) {
    const live = state === "connected";
    MP.hud.textContent = live
      ? `MP · peers ${MP.remotes.size} · ping ${MP.net ? Math.round(MP.net.clock.rtt) : "—"}ms · live`
      : `MP · ${label}`;
    MP.hud.style.color = state === "failed" ? "#ff9a8a" : "#cdf";
  }
  // Connected? show the peer count so a host SEES friends arrive (the clearest
  // possible "it's working" signal). Otherwise show the friendly state label.
  const peers = MP.remotes.size;
  const detail = state === "connected"
    ? (peers > 0 ? `Connected · ${peers} ${peers === 1 ? "friend" : "friends"} here` : "Connected · waiting for friends…")
    : label;
  for (const id of ["lobby-status", "mp-menu-status"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = detail;
    el.classList.toggle("error", state === "failed");
    el.classList.toggle("ok", state === "connected");
  }
  if (state === "failed" && reason && typeof hud !== "undefined" && hud) hud.showToast?.(reason);
}

// Broadcast my pose (~18 Hz) and interpolate every ghost kart. Runs every frame
// while connected, in any game state, so remote karts glide continuously.
function updateMultiplayer(dt) {
  if (!MP.enabled || !MP.net) return;
  const net = MP.net;
  if (net.connected && player) {
    MP.sendAcc += dt;
    // ~16 Hz. Interpolation (with the 200ms delay) reconstructs smooth motion from
    // this, and the lower rate roughly halves the per-channel message load vs the
    // old 25 Hz — easing the relay so a busy room is less likely to drop/throttle
    // a player's updates (which froze their kart on everyone else's screen).
    if (MP.sendAcc >= 1 / 16) {
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
  // Adapt the interpolation delay to the live connection: cover roughly one-way
  // latency (half the round-trip) plus a jitter margin, so a laggy link buffers
  // more (smoother, fewer dead-reckon snaps) and a snappy link buffers less (more
  // responsive). Eased slowly so the render time never lurches.
  const rttMs = net.clock && Number.isFinite(net.clock.rtt) ? net.clock.rtt : 0;
  const targetDelay = Math.max(180, Math.min(280, rttMs * 0.5 + 150));
  _interpDelay += (targetDelay - _interpDelay) * Math.min(1, dt * 0.5); // ~2s time-constant
  const rt = net.now() - _interpDelay; // render remote karts slightly in the past
  for (const r of MP.remotes.values()) r.update(rt, dt);
  // Reap parked ghosts whose grace has elapsed (peer really left, not a flap).
  if (MP.parked.size) {
    const nowMs = performance.now();
    for (const [id, p] of MP.parked) {
      if (nowMs - p.since > REMOTE_GRACE_MS) { p.r.dispose(scene); MP.parked.delete(id); }
    }
  }

  MP.hudAcc += dt;
  if (MP.hudAcc >= 0.5 && MP.hud) {
    MP.hudAcc = 0;
    // Refresh the readout through the shared status formatter so peers/ping update
    // while connected and the live connection state shows otherwise.
    setMpStatus(net.connected ? "connected" : MP.connState || "connecting");
  }
}

initMultiplayer();

// --- Game state ---
const State = { MENU: 0, COUNTDOWN: 1, RACING: 2, FINISHED: 3, PAUSED: 4 };
let state = State.MENU;
let countdown = 0;
let raceTime = 0;
let _furballsArmed = false; // becomes true once the opening furball grace ends
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
let ttBest = null; // personal-best lap time (s), loaded when a time trial starts
const ttBestEl = document.getElementById("tt-best");
const ttDeltaEl = document.getElementById("tt-delta");
const timerEl = document.getElementById("timer");
// Ghost replay: while a time trial runs we record the player's path; on a new best
// lap it's saved (per track) and replayed next time as a translucent ghost kart so
// you race your own PB. ttRecord is the flat [t,x,y,z,heading,…] log of THIS lap;
// ttGhost is the loaded best lap being replayed.
// v2: time trials no longer have power-ups, so any v1 ghost/PB recorded with them
// is invalid — bumping the key drops the old saves and starts these clean.
const TT_GHOST_KEY = "zoomies-ttghost-v2";
let ttRecord = null; // flat array being recorded this lap (null outside time trial)
let _lastGhostSample = -1;
let ttGhost = null; // { samples, n, cursor } currently being replayed
let _ghostGroup = null; // the translucent ghost kart in the scene

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
  // During the opening furball grace, nobody can fire — so don't flash a
  // misleading "BEHIND!" threat warning.
  if (player && !player.finished && raceTime >= SHOOT_OPENING_LOCKOUT) {
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
  // Skybox follow: keep the sky + star domes centred on the camera so they sit at a
  // constant depth (their radius) inside the far plane. Anchored to the world origin
  // they'd swing out past the 2050 far plane as the player drives, getting clipped
  // in a disc around the view centre — that clip let scene.background show through as
  // a pale "orb" on the horizon that tracked the kart.
  if (skyMesh) skyMesh.position.copy(camera.position);
  if (starField) starField.position.copy(camera.position);
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
  renderer.info.reset(); // count draw calls across the whole frame (autoReset is off)
  updateAtmosphere();
  composer.render();
  if (player && state !== State.MENU) {
    drawMinimap();
  }
}

// One-time pipeline warm-up. During a race the camera only faces forward, so the
// scenery behind/beside you is never drawn and its GPU pipelines never compile —
// then a spin-out whips the camera across all of it at once, compiling many in one
// frame = a hitch. Here we render the surrounding scenery from a full turn of
// angles up front (every pipeline variant in the world is around the start town),
// using the NORMAL render path (compileAsync corrupted the WebGPU post-processing
// state, so we don't use it). All renders happen in one tick and the caller draws
// the correct view immediately after, so nothing flashes on screen.
let _prewarmed = false;
function prewarmPipelines() {
  if (_prewarmed || !player) return;
  _prewarmed = true;
  const savedPos = camera.position.clone();
  const savedQuat = camera.quaternion.clone();
  const c = player.position;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    camera.position.set(c.x, c.y + 3, c.z);
    camera.lookAt(c.x + Math.cos(a) * 40, c.y + 2, c.z + Math.sin(a) * 40);
    camera.updateMatrixWorld();
    renderFrame();
  }
  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  camera.updateMatrixWorld();
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
let gpuParticles = null; // GPU ambient motes — created async once the renderer is ready
const QUALITY_KEY = "zoomies-quality";
let quality = "high";
try { if (localStorage.getItem(QUALITY_KEY) === "low") quality = "low"; } catch {}
let renderScale = 1; // dynamic-resolution multiplier on the base pixel ratio (see updateDRS)
function baseDpr() {
  // Low caps the device-pixel-ratio harder — resolution is the biggest lever on
  // both fill cost and render-target memory (which is what tips weak GPUs over).
  return Math.min(window.devicePixelRatio, quality === "high" ? 2 : 1.25);
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
const DRS_MIN = 0.45; // give the scaler more room on the heaviest night scenes (many lights + snow are fill-bound)
let _frameMs = 16.7;
let _drsCooldown = 0;

// --- Performance watchdog ---
// Last-resort net BEFORE a crash: if frames stay long even after dynamic-resolution
// scaling has bottomed out (the device genuinely can't cope at High), auto-drop to
// Low quality, which sheds SSR/god-rays/particles and lowers the render-target
// memory — the kind of sustained pressure that precedes an out-of-memory blank.
// Disabled with ?nowd=1 so the headless perf harness measures the chosen tier.
const _watchdogOn = !new URLSearchParams(location.search).has("nowd");
let _wdAccum = 0;
function perfWatchdog(dt) {
  if (!_watchdogOn || quality !== "high") return; // already on Low → nothing more to shed
  // Only when DRS has already bottomed out AND frames are still very long (~25 fps).
  if (_frameMs > 40 && renderScale <= DRS_MIN + 0.02) {
    _wdAccum += dt;
    if (_wdAccum >= 4) {
      _wdAccum = 0;
      applyQuality("low"); // persists, so a struggling device stays Low next launch
      hud.showToast?.("Graphics lowered for a smoother race");
    }
  } else {
    _wdAccum = Math.max(0, _wdAccum - dt * 0.6); // recover slowly from brief spikes
  }
}

function updateDRS(rawMs, dt) {
  _frameMs += (Math.min(rawMs, 60) - _frameMs) * 0.18; // smoothed frame interval (a touch quicker to react)
  perfWatchdog(dt);
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
// Low quality strips the expensive effects to keep weak devices stable (and is
// what the performance watchdog flips to before a device crashes):
//   • post-FX graph drops SSR + god-rays (the heaviest passes),
//   • god-ray render target stops updating,
//   • GPU ambient motes hidden (skips their compute), grass hidden,
//   • lower pixel-ratio cap (applied via layoutStage → baseDpr).
function applyQuality(q, persist = true) {
  quality = q;
  const high = q === "high";
  if (persist) { try { localStorage.setItem(QUALITY_KEY, q); } catch {} }
  bloomPass.enabled = true; // marquee glow on both tiers
  postProcessing.outputNode = high ? _highOutput : _lowOutput;
  postProcessing.needsUpdate = true; // recompile the node graph for the new composite
  _shaftTex.autoUpdate = high; // don't re-render the god-ray target when it's unused
  if (world.grass) world.grass.visible = high;
  if (gpuParticles) gpuParticles.setVisible(high);
  renderScale = 1; // reset DRS on a manual quality change
  qualityLowBtn?.classList.toggle("is-active", !high);
  qualityHighBtn?.classList.toggle("is-active", high);
  layoutStage(); // applies the resolution
}
qualityLowBtn?.addEventListener("click", () => applyQuality("low"));
qualityHighBtn?.addEventListener("click", () => applyQuality("high"));
applyQuality(quality, false); // honour the persisted choice without re-writing it

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

// Difficulty selector: cycles Easy -> Medium -> Hard (the tuned field). Applied
// to the AI at race build (buildKarts) + per-frame in aiActions.
const diffBtn = document.getElementById("difficulty-btn");
function applyDiffBtn() {
  if (diffBtn) diffBtn.textContent = `Difficulty: ${AI_DIFFICULTY[DIFFICULTY].label}`;
}
if (diffBtn)
  diffBtn.addEventListener("click", () => {
    DIFFICULTY = DIFF_ORDER[(DIFF_ORDER.indexOf(DIFFICULTY) + 1) % DIFF_ORDER.length];
    try { localStorage.setItem(DIFF_KEY, DIFFICULTY); } catch {}
    applyDiffBtn();
  });
applyDiffBtn();

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

// --- Compatibility mode (renderer backend) ---
// The renderer backend is picked once at startup (gpu.js reads this same flag), so
// an installed PWA can't switch it via a URL param — this in-app toggle is the only
// way in. ON forces the stable WebGL2 backend (what the crash guard auto-selects
// after a WebGPU device loss); OFF lets it use WebGPU. Changing it restarts the app.
const WEBGL_PREF_KEY = "zoomies-prefer-webgl";
const compatToggle = document.getElementById("set-compat-toggle");
function readCompat() {
  try { return localStorage.getItem(WEBGL_PREF_KEY) === "1"; } catch { return false; }
}
function applyCompatUI() {
  const on = readCompat();
  if (compatToggle) {
    compatToggle.textContent = on ? "On" : "Off";
    compatToggle.classList.toggle("off", !on);
  }
}
compatToggle?.addEventListener("click", () => {
  const on = !readCompat();
  try {
    if (on) localStorage.setItem(WEBGL_PREF_KEY, "1");
    else localStorage.removeItem(WEBGL_PREF_KEY);
  } catch { /* ignore */ }
  applyCompatUI();
  // The backend is chosen at load, so restart to apply. Drop any ?webgl/?webgpu so
  // the localStorage flag is the single source of truth on the next load.
  const u = new URL(location.href);
  u.searchParams.delete("webgl");
  u.searchParams.delete("webgpu");
  location.replace(u.toString());
});
applyCompatUI();

// "Advanced" expander hides the debug toggles (FPS counter, Tilt debug) so the
// settings menu stays tidy for normal players.
const advToggle = document.getElementById("adv-toggle");
const advSettings = document.getElementById("adv-settings");
advToggle?.addEventListener("click", () => {
  const open = advSettings.classList.toggle("hidden") === false;
  advToggle.textContent = open ? "Advanced ▾" : "Advanced ▸";
  advToggle.setAttribute("aria-expanded", String(open));
  // The revealed rows + Back button can fall below the fold on a short landscape
  // screen — scroll the settings overlay down so they're not stranded off-screen.
  if (open) {
    const ov = document.getElementById("settings");
    setTimeout(() => { if (ov) ov.scrollTo({ top: ov.scrollHeight, behavior: "smooth" }); }, 60);
  }
});

// --- Tilt debug readout (opt-in via Settings; persisted) ---
// A diagnostic to chase down the steering sensitivity: it prints the live device
// pitch (forward/back tilt), the in-plane gravity magnitude (which shrinks as the
// phone tilts flat and is what makes atan2 steering over-sensitive), the raw roll
// and the smoothed steer. Read it while finding the tilt that feels right so we
// can normalise against it and lock the feel in. Does NOT change steering yet.
const TILT_KEY = "zoomies-tiltdebug";
const tiltEl = document.getElementById("tilt-counter");
const tiltToggle = document.getElementById("set-tilt-toggle");
let showTilt = false;
try { showTilt = localStorage.getItem(TILT_KEY) === "1"; } catch {}
function applyTiltSetting() {
  if (tiltEl) tiltEl.classList.toggle("hidden", !showTilt);
  if (tiltToggle) {
    tiltToggle.textContent = showTilt ? "On" : "Off";
    tiltToggle.classList.toggle("off", !showTilt);
  }
}
tiltToggle?.addEventListener("click", () => {
  showTilt = !showTilt;
  try { localStorage.setItem(TILT_KEY, showTilt ? "1" : "0"); } catch {}
  applyTiltSetting();
});
applyTiltSetting();
let _tiltAccum = 0;
function updateTiltCounter(dt) {
  if (!showTilt || !tiltEl) return;
  _tiltAccum += dt;
  if (_tiltAccum < 0.1) return; // ~10 Hz
  _tiltAccum = 0;
  const t = input.debugTilt();
  tiltEl.textContent = t
    ? `pitch ${t.pitch.toFixed(0)}° · mag ${t.mag.toFixed(1)} · roll ${t.roll.toFixed(0)}° · steer ${t.steer.toFixed(2)}`
    : "tilt: no motion";
}

// Refresh the readout a few times a second from the smoothed frame interval the
// DRS already tracks (_frameMs). Also reports the live backend (WGPU vs WGL2 — so
// you can confirm which one is actually running) and the draw-call count, which
// tells us whether a slow frame is draw-call-bound (geometry) or fill-bound.
let _fpsAccum = 0;
function updateFpsCounter(dt) {
  if (!showFps || !fpsEl) return;
  _fpsAccum += dt;
  if (_fpsAccum < 0.2) return; // ~5 Hz so the number is readable, not a blur
  _fpsAccum = 0;
  const fps = Math.round(1000 / Math.max(1, _frameMs));
  const backend = renderer?.backend?.isWebGPUBackend ? "WGPU" : "WGL2";
  const dc = renderer?.info?.render?.drawCalls ?? 0;
  fpsEl.textContent = `${fps} FPS · ${backend} · ${dc}dc`;
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

// iOS WebGPU can hit a GPU device-loss under memory pressure, and multiplayer
// piles two extra ghost karts + the realtime client onto an already heavy scene —
// which is exactly when iOS guests were getting reloaded to the menu mid-race
// (the crash-guard catching the device loss). So while in a multiplayer race on
// iOS, force the memory-lean Low profile (no SSR / god-ray targets, capped pixel
// ratio). NON-persisted, so single-player and the saved preference are untouched;
// restored when leaving multiplayer.
let _mpForcedLow = false;
function applyMpQuality() {
  const wantLow = _isIOS && MP.enabled;
  if (wantLow && quality === "high") {
    _mpForcedLow = true;
    applyQuality("low", false);
    hud.showToast?.("Graphics set to Low for smoother multiplayer");
  } else if (!wantLow && _mpForcedLow) {
    _mpForcedLow = false;
    let saved = "high";
    try { if (localStorage.getItem(QUALITY_KEY) === "low") saved = "low"; } catch {}
    applyQuality(saved, false);
  }
}
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
const ALL_BIOMES = ["meadow", "forest", "alpine", "autumn", "desert", "blossom", "savanna", "tundra"];
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

// --- Garage: pick your cat + kart, with a live 3D preview ------------------
// The selection just rides in garageConfig; the player kart reads it at race start
// (raceRoster/buildKarts) so no reload is needed. While the garage is open the menu
// loop renders an orbiting preview kart instead of the cinematic (see the loop).
const garageEl = document.getElementById("garage");
let _garageDraft = null; // { cat, kart } in-progress; committed to garageConfig on Done
let _garageOpen = false;
let _garagePreview = null; // the preview kart's group in the scene
let _garagePreviewKart = null; // the preview Kart instance (for the idle blink)
const _garageAnchor = new THREE.Vector3();
const _garageLook = new THREE.Vector3();

function _disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) m.dispose?.();
  });
}
function _clearGaragePreview() {
  if (!_garagePreview) return;
  scene.remove(_garagePreview);
  _disposeGroup(_garagePreview);
  _garagePreview = null;
  _garagePreviewKart = null;
}
// Rebuild the preview kart from the current draft (cheap enough for a click, not a
// per-frame op). Reuses the real Kart + the rim/toon treatment so it matches racing.
function buildGaragePreview() {
  _clearGaragePreview();
  const cat = catSpec(_garageDraft);
  const kart = kartSpec(_garageDraft);
  const pk = new Kart({ color: kart.color, catColor: cat.fur, catPattern: cat.pattern, catAccessory: cat.accessory, kartStyle: kart.style, kartNumber: kart.number, name: cat.name, isPlayer: false, skill: 1 });
  pk.placeAt(_garageAnchor, Math.PI * 0.85, track); // park on the grid slot, ¾ angle
  pk.group.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
  });
  toonify(pk.group);
  scene.add(pk.group);
  _garagePreview = pk.group;
  _garagePreviewKart = pk;
}

// --- Custom creator -------------------------------------------------------
// Curated fur tones (real cat colours) and bold kart liveries the swatch grids
// offer. Custom picks aren't limited to these — they just seed quick choices.
const CAT_FUR_SWATCHES = [0xf0a830, 0xc8966a, 0x8c9298, 0x2a2a2a, 0xfbfbfb, 0xf3dcb6, 0x4a3328, 0x9aa2a8, 0x5a3b2a, 0xd9b38c, 0xe8e2d6, 0x6b4a2f];
const KART_COLOR_SWATCHES = [0xe53935, 0x1e88e5, 0x43a047, 0xfb8c00, 0x8e24aa, 0xfdd835, 0x00897b, 0x26c6da, 0xec407a, 0x5e35b1, 0x16181d, 0xeeeeee];
const KART_STYLE_NAMES = ["GP", "Roadster", "Buggy", "Finned"];
const CUSTOM_CAT_NAMES = ["Biscuit", "Mochi", "Pumpkin", "Waffles", "Bandit", "Noodle", "Mittens", "Gizmo", "Tofu", "Pixel"];
const CUSTOM_KART_NAMES = ["Bolt", "Zephyr", "Rascal", "Turbo", "Pounce", "Dash", "Rocket", "Maverick", "Blaze", "Whirl"];
const _hex6 = (v) => "#" + (v >>> 0).toString(16).padStart(6, "0");
const _cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const _pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Build a row of colour swatch buttons once; clicks set the draft colour.
function _buildSwatchGrid(gridId, palette, onPick) {
  const grid = document.getElementById(gridId);
  if (!grid || grid.childElementCount) return;
  for (const c of palette) {
    const b = document.createElement("button");
    b.className = "swatch-dot";
    b.style.background = _hex6(c);
    b.dataset.color = c;
    b.setAttribute("aria-label", "Colour " + _hex6(c));
    b.addEventListener("click", () => onPick(c));
    grid.appendChild(b);
  }
}
function _markSelectedSwatch(gridId, color) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  for (const b of grid.children) b.classList.toggle("selected", Number(b.dataset.color) === color);
}

// Refresh the creator panels: show the one whose stepper is on the Custom slot,
// and mirror the draft's custom values into its controls.
function syncCreators() {
  const catCustom = _garageDraft.cat === CUSTOM_CAT_IDX;
  const kartCustom = _garageDraft.kart === CUSTOM_KART_IDX;
  document.getElementById("cat-custom").classList.toggle("hidden", !catCustom);
  document.getElementById("kart-custom").classList.toggle("hidden", !kartCustom);
  if (catCustom) {
    const c = _garageDraft.customCat;
    document.getElementById("cat-pat-name").textContent = _cap(c.pattern);
    document.getElementById("cat-acc-name").textContent = _cap(c.accessory);
    const ni = document.getElementById("cat-custom-name");
    if (ni.value !== c.name) ni.value = c.name;
    _markSelectedSwatch("cat-color-grid", c.fur);
  }
  if (kartCustom) {
    const k = _garageDraft.customKart;
    document.getElementById("kart-style-name").textContent = KART_STYLE_NAMES[k.style] || "GP";
    document.getElementById("kart-num-name").textContent = String(k.number);
    const ni = document.getElementById("kart-custom-name");
    if (ni.value !== k.name) ni.value = k.name;
    _markSelectedSwatch("kart-color-grid", k.color);
  }
}
function syncGarageUI() {
  const cat = catSpec(_garageDraft);
  const kart = kartSpec(_garageDraft);
  document.getElementById("cat-name").textContent = cat.name;
  document.getElementById("kart-name").textContent = kart.name;
  document.getElementById("cat-swatch").style.background = _hex6(cat.fur);
  document.getElementById("kart-swatch").style.background = _hex6(kart.color);
  syncCreators();
}
function openGaragePanel() {
  _garageDraft = {
    cat: garageConfig.cat,
    kart: garageConfig.kart,
    customCat: { ...garageConfig.customCat },
    customKart: { ...garageConfig.customKart },
  };
  const slot = track.gridSlot(0); // a flat start-grid spot with scenery behind it
  _garageAnchor.copy(slot.position);
  syncGarageUI();
  buildGaragePreview();
  // Kill any in-progress menu cross-dissolve: its frozen snapshot (#menu-xfade)
  // would otherwise hang over the live preview as a doubled "ghost" of the level.
  if (menuXfade) menuXfade.style.opacity = 0;
  _menuPhase = "hold";
  _menuShotT = 0;
  _garageOpen = true;
  openSubScreen(garageEl);
}
function closeGarage() {
  _garageOpen = false;
  _clearGaragePreview();
  closeSubScreen(garageEl);
}
function stepGarage(which, dir) {
  // +1 slot: one past the last preset is the Custom slot.
  const n = (which === "cat" ? CAT_PRESETS.length : KART_PRESETS.length) + 1;
  _garageDraft[which] = (_garageDraft[which] + dir + n) % n;
  syncGarageUI();
  buildGaragePreview();
}
// Mutate the draft's custom cat/kart, then refresh UI + preview. `rebuild=false`
// skips the (model-irrelevant) preview rebuild for pure name edits.
function editCustomCat(patch, rebuild = true) {
  Object.assign(_garageDraft.customCat, patch);
  syncGarageUI();
  if (rebuild) buildGaragePreview();
}
function editCustomKart(patch, rebuild = true) {
  Object.assign(_garageDraft.customKart, patch);
  syncGarageUI();
  if (rebuild) buildGaragePreview();
}
function stepCustom(which, list, dir) {
  if (which === "pattern" || which === "accessory") {
    const i = list.indexOf(_garageDraft.customCat[which]);
    editCustomCat({ [which]: list[(i + dir + list.length) % list.length] });
  }
}
// Slowly orbit the camera around the parked preview kart. The control card is
// docked to the left half of the (landscape) screen, so frame the kart in the
// open RIGHT half: orbit a touch further back (smaller kart) and pan the aim to
// the left, which slides the kart rightward on screen.
const _garageRight = new THREE.Vector3();
function renderGarage(timeSec, dt = 0.016) {
  if (!_garagePreview) return;
  _garagePreviewKart?.idleBlink(dt); // the parked cat blinks now and then
  const p = _garagePreview.position;
  const ang = timeSec * 0.5;
  const r = 9.6; // well back so the whole kart reads small and never clips
  camera.position.set(p.x + Math.sin(ang) * r, p.y + 3.1, p.z + Math.cos(ang) * r);
  if (camera.fov !== 38) { camera.fov = 38; camera.updateProjectionMatrix(); }
  _garageLook.set(p.x, p.y + 1.25, p.z);
  camera.lookAt(_garageLook);
  // Pan the aim left along the camera's screen-right axis so the kart sits in
  // the open right half (the card covers the left). Re-aim after the shift.
  _garageRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _garageLook.addScaledVector(_garageRight, -3.6);
  camera.lookAt(_garageLook);
  renderFrame();
}

document.getElementById("open-garage")?.addEventListener("click", openGaragePanel);
document.getElementById("cat-prev")?.addEventListener("click", () => stepGarage("cat", -1));
document.getElementById("cat-next")?.addEventListener("click", () => stepGarage("cat", 1));
document.getElementById("kart-prev")?.addEventListener("click", () => stepGarage("kart", -1));
document.getElementById("kart-next")?.addEventListener("click", () => stepGarage("kart", 1));

// Custom-cat creator controls.
_buildSwatchGrid("cat-color-grid", CAT_FUR_SWATCHES, (c) => editCustomCat({ fur: c }));
document.getElementById("cat-pat-prev")?.addEventListener("click", () => stepCustom("pattern", CAT_PATTERNS, -1));
document.getElementById("cat-pat-next")?.addEventListener("click", () => stepCustom("pattern", CAT_PATTERNS, 1));
document.getElementById("cat-acc-prev")?.addEventListener("click", () => stepCustom("accessory", CAT_ACCESSORIES, -1));
document.getElementById("cat-acc-next")?.addEventListener("click", () => stepCustom("accessory", CAT_ACCESSORIES, 1));
document.getElementById("cat-custom-name")?.addEventListener("input", (e) => editCustomCat({ name: e.target.value.slice(0, 14) }, false));
document.getElementById("cat-randomize")?.addEventListener("click", () => editCustomCat({
  fur: _pick(CAT_FUR_SWATCHES), pattern: _pick(CAT_PATTERNS), accessory: _pick(CAT_ACCESSORIES), name: _pick(CUSTOM_CAT_NAMES),
}));

// Custom-kart creator controls.
_buildSwatchGrid("kart-color-grid", KART_COLOR_SWATCHES, (c) => editCustomKart({ color: c }));
document.getElementById("kart-style-prev")?.addEventListener("click", () => editCustomKart({ style: (_garageDraft.customKart.style + KART_STYLE_COUNT - 1) % KART_STYLE_COUNT }));
document.getElementById("kart-style-next")?.addEventListener("click", () => editCustomKart({ style: (_garageDraft.customKart.style + 1) % KART_STYLE_COUNT }));
document.getElementById("kart-num-prev")?.addEventListener("click", () => editCustomKart({ number: (_garageDraft.customKart.number + 99) % 100 }));
document.getElementById("kart-num-next")?.addEventListener("click", () => editCustomKart({ number: (_garageDraft.customKart.number + 1) % 100 }));
document.getElementById("kart-custom-name")?.addEventListener("input", (e) => editCustomKart({ name: e.target.value.slice(0, 14) }, false));
document.getElementById("kart-randomize")?.addEventListener("click", () => editCustomKart({
  color: _pick(KART_COLOR_SWATCHES), style: Math.floor(Math.random() * KART_STYLE_COUNT), number: Math.floor(Math.random() * 100), name: _pick(CUSTOM_KART_NAMES),
}));

document.getElementById("garage-apply")?.addEventListener("click", () => {
  garageConfig.cat = _garageDraft.cat;
  garageConfig.kart = _garageDraft.kart;
  garageConfig.customCat = sanitizeCustomCat(_garageDraft.customCat);
  garageConfig.customKart = sanitizeCustomKart(_garageDraft.customKart);
  saveGarageConfig(garageConfig);
  closeGarage();
});
document.getElementById("garage-back")?.addEventListener("click", closeGarage);

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
// Time trial is solo-only; updateModeBtn() hides it in multiplayer. Always attach
// the handler (even if we loaded straight into MP) so it works after a Solo switch.
const timeTrialBtn = document.getElementById("time-trial-btn");
timeTrialBtn?.addEventListener("click", startTimeTrial);

// Solo / Multiplayer mode. Only offered when an Ably key is configured. Picking
// Multiplayer reveals the HOST / JOIN choices (it does NOT connect yet):
//   • Host Game → connect to your own room and drop into the lobby with a share code.
//   • Join → reload into a friend's room by code and land in their lobby.
const modeToggle = document.getElementById("mode-toggle");
const modeSoloBtn = document.getElementById("mode-solo");
const modeMpBtn = document.getElementById("mode-mp");
const mpCodeInput = document.getElementById("mp-code");
let _mpUIMode = false; // showing the multiplayer host/join panel (separate from "connected")
function updateModeBtn() {
  modeSoloBtn?.classList.toggle("is-active", !_mpUIMode);
  modeMpBtn?.classList.toggle("is-active", _mpUIMode);
  document.getElementById("mp-actions")?.classList.toggle("hidden", !_mpUIMode);
  // In multiplayer the lobby is where you launch a race, so hide the solo buttons.
  document.getElementById("start-btn")?.classList.toggle("hidden", _mpUIMode);
  if (timeTrialBtn) timeTrialBtn.classList.toggle("hidden", _mpUIMode);
}

// Host: connect to my own room (= my world seed) and go straight into the lobby.
// The click is the user gesture beginRace needs for fullscreen + motion permission.
function hostGame() {
  if (!MP.enabled) enterMultiplayer();
  beginRace(); // gesture setup + (MP.enabled) enterLobby
}
// Join by code: a friend's code IS their world seed, so reload into that world
// with multiplayer on and auto-open the lobby. enableMotion() here grabs iOS
// motion permission inside the gesture so it survives the reload.
function joinGame() {
  const code = (mpCodeInput?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) { mpCodeInput?.focus(); return; }
  if (code === WORLD_SEED && MP.enabled) { beginRace(); return; } // already in this room
  audio.unlock();
  try { input.enableMotion(); } catch {}
  // I'm joining someone else's room → I'm a guest, not the host (clear any prior
  // hosted-seed so a refresh in this tab doesn't wrongly crown me).
  try { sessionStorage.setItem("mp-host-seed", ""); } catch {}
  const u = new URL(location.href);
  u.searchParams.set("seed", code);
  u.searchParams.set("mp", "1");
  location.href = u.toString(); // reload into the host's world; ?mp=1 auto-opens the lobby
}
// Open the multiplayer lobby once the menu wiring is ready (deferred so it wins
// over the default-visible menu on the initial frame).
function autoOpenLobby() {
  if (_installGate) return; // an un-installed touch device must install first
  enterLobby();
}
function enterMultiplayer() {
  _mpUIMode = true;
  _amHost = true; // I'm creating this room → I'm the host (survives a refresh below)
  try { sessionStorage.setItem("mp-host-seed", WORLD_SEED); } catch { /* ignore */ }
  audio.unlock();
  const u = new URL(location.href);
  u.searchParams.set("mp", "1");
  u.searchParams.set("seed", WORLD_SEED);
  history.replaceState(null, "", u);
  initMultiplayer(); // connects (async) in the background
  updateModeBtn();
}
function exitMultiplayer() {
  if (MP.net) {
    try { MP.net.close(); } catch { /* ignore */ }
    MP.net = null;
  }
  for (const id of [...MP.remotes.keys()]) mpDespawn(id, true);
  for (const [, p] of MP.parked) p.r.dispose(scene); // drop any parked ghosts too
  MP.parked.clear();
  MP.enabled = false;
  applyMpQuality(); // restore the pre-multiplayer graphics setting (iOS Low override)
  MP.inLobby = false;
  MP.startAt = 0;
  if (MP.hud) { MP.hud.remove(); MP.hud = null; }
  _mpUIMode = false;
  const u = new URL(location.href);
  u.searchParams.delete("mp");
  history.replaceState(null, "", u);
  updateModeBtn();
  toMenu();
}
if (modeToggle && resolveAblyKey()) {
  modeToggle.classList.remove("hidden");
  modeSoloBtn?.addEventListener("click", () => {
    if (MP.enabled) exitMultiplayer();
    else { _mpUIMode = false; updateModeBtn(); }
  });
  modeMpBtn?.addEventListener("click", () => { _mpUIMode = true; updateModeBtn(); });
  document.getElementById("mp-host-btn")?.addEventListener("click", hostGame);
  document.getElementById("mp-join-btn")?.addEventListener("click", joinGame);
  mpCodeInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(); });
  // Anyone landing with ?mp=1 — a join reload, an invite link, or a host refresh —
  // is here to play together, so drop straight into the lobby (no flag needed).
  if (new URLSearchParams(location.search).has("mp")) {
    _mpUIMode = true;
    setTimeout(autoOpenLobby, 60);
  }
  updateModeBtn();
}

// A canonical invite URL for the current room (origin + path + ?seed=…&mp=1),
// independent of whatever junk is on location.href right now.
function inviteURL() {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("seed", WORLD_SEED);
  u.searchParams.set("mp", "1");
  return u.toString();
}

// Native share (phones) where available, else copy to clipboard. Wired to both the
// menu and lobby invite buttons; the share buttons reveal themselves only when the
// Web Share API exists.
async function shareInvite() {
  const url = inviteURL();
  const data = { title: "Zoomies GP", text: `Join my race! Room code ${WORLD_SEED}`, url };
  try {
    if (navigator.share) { await navigator.share(data); return true; }
  } catch {
    /* user cancelled or share failed — fall through to copy */
  }
  try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
  return false;
}
function wireCopyButton(btn, label) {
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteURL());
      btn.textContent = "✓ Link copied!";
    } catch {
      btn.textContent = "⚠ Copy failed — copy the URL";
    }
    setTimeout(() => (btn.textContent = label), 1800);
  });
}
wireCopyButton(document.getElementById("lobby-copy"), "📋 Copy invite link");
{
  const btn = document.getElementById("lobby-share");
  if (btn && navigator.share) {
    btn.classList.remove("hidden");
    btn.addEventListener("click", async () => {
      const ok = await shareInvite();
      if (!ok) { btn.textContent = "✓ Link copied!"; setTimeout(() => (btn.textContent = "📤 Share invite"), 1800); }
    });
  }
}
// Joiner's pre-race gesture: re-grab fullscreen + tilt (the join reload drops the
// host's gesture). Optional — the race still runs without it (touch controls).
document.getElementById("lobby-ready")?.addEventListener("click", () => {
  audio.unlock();
  try { enterFullscreenLandscape(); input.enableMotion(); input.calibrate(); } catch { /* ignore */ }
  const b = document.getElementById("lobby-ready");
  if (b) { b.textContent = "✓ Tilt ready"; b.disabled = true; }
});

function startRace() {
  timeTrial = false;
  setTimeTrialHud(false);
  beginRace();
}
function startTimeTrial() {
  timeTrial = true;
  ttBest = loadTimeTrial()[0]?.time ?? null; // the lap to chase
  setTimeTrialHud(true);
  beginRace();
}
// Show/hide the time-trial PB target + delta, and reset their state for a new run.
function setTimeTrialHud(on) {
  for (const el of [ttBestEl, ttDeltaEl]) el?.classList.toggle("hidden", !on);
  if (ttBestEl) ttBestEl.textContent = on ? (ttBest != null ? `PB ${formatLap(ttBest)}` : "PB — (set one!)") : "";
  if (ttDeltaEl) { ttDeltaEl.textContent = ""; ttDeltaEl.className = "hidden"; }
  if (timerEl) timerEl.classList.remove("ahead", "behind");
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
  setupGhost(); // build/replay the ghost (time trial) or tear any leftover one down
  updateBoostUI(); // karts start with an empty boost meter
  applyMpQuality(); // iOS: force Low in multiplayer (GPU device-loss safety), else restore
  // Power-up boxes are a competitive item — off in time trial (a solo run against
  // the clock has no rivals to use them on, and they'd pollute the ghost lap).
  props?.setItemsEnabled?.(!timeTrial);
  raceTime = 0;
  _furballsArmed = false;
  hud.setShootLock(0); // clear any leftover charge banner from a previous race
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
  // Always show the room code (it's this client's world seed) even before the
  // connection finishes, so a freshly-arrived joiner sees it immediately.
  const codeEl = document.getElementById("lobby-code");
  if (codeEl) codeEl.textContent = WORLD_SEED;
  if (!MP.enabled || !MP.net) return; // the player list / count need a live connection
  const countEl = document.getElementById("lobby-count");
  if (countEl) countEl.textContent = `${Math.min(mpPlayerCount(), MAX_PLAYERS)} / ${MAX_PLAYERS} players`;
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
  const host = mpIsHost();
  const startBtn = document.getElementById("lobby-start");
  const waiting = document.getElementById("lobby-waiting");
  const ready = document.getElementById("lobby-ready");
  if (startBtn) startBtn.style.display = host ? "" : "none"; // only the host launches
  if (waiting) waiting.style.display = host ? "none" : "";   // others wait for the host
  if (ready) ready.style.display = host ? "none" : "";       // joiner: enable tilt first
}

// A joiner reaches the lobby via a reload, which loses the motion listener AND (on
// iOS) the permission grant — and the host can start the race remotely before they
// tap the explicit "Enable tilt controls" button. So arm tilt on their FIRST touch
// anywhere in the lobby (a real user gesture, which iOS requires for the motion
// prompt). Runs once; the explicit button still works too.
let _guestTiltHooked = false;
function armGuestTiltOnGesture() {
  if (_guestTiltHooked) return;
  _guestTiltHooked = true;
  const arm = () => {
    try { input.enableMotion(); input.calibrate(); } catch { /* ignore */ }
    const b = document.getElementById("lobby-ready");
    if (b) { b.textContent = "✓ Tilt ready"; b.disabled = true; }
  };
  window.addEventListener("pointerdown", arm, { once: true, capture: true });
}

function enterLobby() {
  MP.inLobby = true;
  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("lobby").classList.remove("hidden");
  renderLobby();
  if (!mpIsHost()) armGuestTiltOnGesture(); // joiner: first touch enables tilt steering
}

// Line the countdown up to the shared-clock instant `at` so every client hits
// GO at the same moment. Triggered locally on the host and via the network on
// everyone else; the state guard makes a double-trigger harmless.
function beginSyncedRace(at) {
  if (state === State.COUNTDOWN || state === State.RACING) return;
  // A guest reloaded into the host's world to join, which dropped the devicemotion
  // listener — re-arm it so tilt steering works (gas/brake use the touch slider, so
  // they kept working even when this was missed). Idempotent + no-op for the host.
  try { input.enableMotion(); } catch { /* ignore */ }
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

  // FOV kick when boosting for a sense of speed; catnip widens it a touch more for
  // a rush — but only a touch, so the road stays readable and easy to drive.
  const targetFov = 62 + (player.boosting ? 7 : 0) + (player.catnipBoosting ? 4 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
  camera.updateProjectionMatrix();

  // Screen shake (decays). Catnip keeps a faint constant rumble going (minor, so
  // it reads as raw speed without fighting your steering).
  shakeMag *= 1 - Math.min(1, 6 * dt);
  if (player.catnipBoosting) shakeMag = Math.max(shakeMag, 0.14);
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
// Shared kart-vs-kart collision constants, used by BOTH single-player and the
// multiplayer remote-kart path so the two can never drift out of parity.
const KART_COLLIDE_MIN = 4.4; // contact diameter
function kartBumpPower(aSpeed, bSpeed) {
  // Bumper impulse, scaled by how fast the pair is moving.
  return 10 + (Math.abs(aSpeed) + Math.abs(bSpeed)) * 0.4;
}

function resolveCollisions() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const min = KART_COLLIDE_MIN;
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
      const power = kartBumpPower(a.speed, b.speed);
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
  const min = KART_COLLIDE_MIN;
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

    // The masses match single-player (you're 1.35, the ghost is 1.0 — same as
    // you-vs-AI), so the shares below are EXACTLY what resolveCollisions() uses.
    const ima = 1 / player.mass;
    const img = 1 / g.mass;
    const inv = ima + img;
    const sp = ima / inv; // player's share
    const sg = img / inv; // ghost's share

    // Position: the player still takes the WHOLE separation (the ghost can't move
    // authoritatively, and clearing the overlap in one frame keeps repeated
    // contact from flinging the ghost). This is a position detail, not the carom.
    player.position.x -= nx * overlap;
    player.position.z -= nz * overlap;

    // Carom: the player's knock is now the SAME mass-share bumper impulse as
    // single-player (no amplification), so ramming a rival online feels exactly
    // like ramming an AI. This knock moves the player's real position, which
    // propagates over the network — the other client independently resolves the
    // mirror contact against its ghost of us, so both sides feel a bump with no
    // referee (they needn't match exactly).
    const power = kartBumpPower(player.speed, g.speed);
    player.knock.x -= nx * power * sp;
    player.knock.z -= nz * power * sp;
    player.speed *= 0.99; // same tiny scrub as single-player

    // Cosmetic-only nudge on the ghost (instant local feedback) at the ghost's
    // mass share — the authoritative slide arrives over the network shortly after.
    r.bump(nx, nz, power * sg);

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
  _fieldCount = field.length; // size of the field, for position-weighted item rolls
}
let _fieldCount = 1;

const SHOOT_CHARGE_TIME = 0.7; // seconds of hold for a full-power shot
const SHOOT_RECHARGE = 1.2; // min seconds between shots (no spamming)
// Longer grace at the green light so the race doesn't open with everyone pelting
// each other on the start line — first hairball isn't ready until this elapses.
// Opening grace: furballs are "charging" for the first stretch of a race, so the
// start is decided by driving (and creating a gap) rather than an instant hairball
// brawl off the line. Firing is gated by the cooldown; the HUD shows the countdown.
const SHOOT_OPENING_LOCKOUT = 15;

// Fire a hairball if allowed (recharge done, not spun out), and start the
// recharge. Shared by the player and the AI so the rules are identical.
function fireHairball(kart, charge = 0) {
  if (kart.shootCooldown > 0 || kart.spinTimer > 0 || kart.finished) return false;
  const wasTri = kart.triShots > 0; // capture before spawn() consumes the charge
  hairballs.spawn(kart, charge);
  audio.shoot(kart === player ? null : kart.position);
  kart.shootCooldown = SHOOT_RECHARGE;
  // Tell other players about the shot so they can see the projectile fly (and fan
  // it into three on their side when it was a tri-furball).
  if (MP.enabled && MP.net && kart === player) {
    const m = kart.muzzle();
    MP.net.sendShoot(m.pos, m.dir, charge, wasTri);
  }
  return true;
}

// --- AI actions: catch-up, shooting, boosts, shields, anti-clumping ---
const _aiFwd = new THREE.Vector3();
const _aiTo = new THREE.Vector3();
function aiActions(dt) {
  // Even launch: for the first beat off the line every AI floors it (like the
  // player holding full throttle) and we skip the anti-clumping throttle cut. The
  // starting grid is intentionally packed, so anti-clumping used to brake the
  // whole field at GO — which is exactly why the AI felt sluggish off the line.
  const launching = raceTime < 1.3;
  for (const k of karts) {
    if (k.isPlayer) continue;

    // Rubber-band: trailing karts run a little faster, leaders a little slower,
    // to keep the pack competitive.
    const gap = player.totalProgress - k.totalProgress;
    // Catch up strongly when behind, but barely ease off when leading, so the
    // front-runners stay competitive instead of waiting for the player.
    const _rb = k.diff ? k.diff.rubber : 1; // easier modes catch up less
    k.maxSpeed = k.baseMaxSpeed * (1 + Math.max(-0.02, Math.min(0.16, gap * 0.12)) * _rb);

    if (k.boosting) effects.trickle(k, k.catnipBoosting);
    if (k.finished || k.spinTimer > 0) {
      k.shielding = false;
      continue;
    }

    _aiFwd.set(Math.sin(k.heading), 0, Math.cos(k.heading));

    if (launching) {
      k.throttleInput = 1; // full launch, no anti-clump braking on the packed grid
    } else {
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
    }

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
      k._aiShootTimer = (1.0 + Math.random() * 2.2) / (k.diff ? k.diff.shoot : 1); // easier = longer gaps
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
const TT_KEY = "zoomies-timetrial-v2"; // v2: reset — TT lap times pre-date the no-power-ups change
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

// --- Time-trial ghost replay ---------------------------------------------------
// The ghost is keyed by track identity (seed for generated maps, "classic"
// otherwise) so a stored best lap only ever replays on the track it was set on —
// no ghost driving through the scenery of a different map.
function ttTrackKey() {
  return trackConfig.mode === "custom" ? "c:" + (trackConfig.seed || "") : "classic";
}
function loadGhostData() {
  try {
    const g = JSON.parse(localStorage.getItem(TT_GHOST_KEY));
    if (g && g.key === ttTrackKey() && Array.isArray(g.samples) && g.samples.length >= 10) return g.samples;
  } catch {
    /* ignore */
  }
  return null;
}
function saveGhostData(samples) {
  try {
    localStorage.setItem(TT_GHOST_KEY, JSON.stringify({ key: ttTrackKey(), samples }));
  } catch {
    /* storage may be unavailable; the ghost is best-effort */
  }
}
function clearGhost() {
  if (_ghostGroup) {
    scene.remove(_ghostGroup);
    _disposeGroup(_ghostGroup);
    _ghostGroup = null;
  }
  ttGhost = null;
}
// Build the translucent ghost kart (player's chosen look) for the loaded best lap,
// or tear any existing one down. Called from prepareRace for both modes.
function setupGhost() {
  clearGhost();
  ttRecord = timeTrial ? [] : null; // start recording this lap (time trial only)
  _lastGhostSample = -1;
  if (!timeTrial) return;
  const samples = loadGhostData();
  if (!samples) return;
  const look = playerLook();
  const gk = new Kart({ color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, kartStyle: look.kartStyle, kartNumber: look.kartNumber, name: "Ghost", isPlayer: false, skill: 1 });
  const group = gk.group;
  // One flat, translucent cyan material over the whole kart reads cleanly as a
  // ghost (unlit so it renders consistently regardless of time-of-day).
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.32, depthWrite: false, fog: true });
  if (gk.groundShadow) gk.groundShadow.visible = false; // a cyan shadow disc would look wrong
  group.traverse((o) => {
    if (o.isMesh && o !== gk.shadowQuad) { o.material = ghostMat; o.castShadow = false; o.renderOrder = 3; }
  });
  group.visible = false; // shown once the timed lap starts
  scene.add(group);
  _ghostGroup = group;
  ttGhost = { samples, n: (samples.length / 5) | 0, cursor: 0 };
}
// Place the ghost at its recorded pose for `elapsed` seconds into the lap, lerping
// between the two bracketing samples (shortest-angle for heading). Hidden before
// the lap starts and after the ghost's own lap has ended.
function updateGhost(elapsed) {
  if (!ttGhost || !_ghostGroup) return;
  const s = ttGhost.samples, n = ttGhost.n;
  const lastT = s[(n - 1) * 5];
  if (elapsed <= 0 || elapsed > lastT + 0.4) { _ghostGroup.visible = false; return; }
  let i = ttGhost.cursor;
  if (s[i * 5] > elapsed) i = 0; // lap reset — rewind the cursor
  while (i < n - 1 && s[(i + 1) * 5] <= elapsed) i++;
  ttGhost.cursor = i;
  const j = Math.min(i + 1, n - 1);
  const t0 = s[i * 5], t1 = s[j * 5];
  const f = t1 > t0 ? (elapsed - t0) / (t1 - t0) : 0;
  const x = s[i * 5 + 1] + (s[j * 5 + 1] - s[i * 5 + 1]) * f;
  const y = s[i * 5 + 2] + (s[j * 5 + 2] - s[i * 5 + 2]) * f;
  const z = s[i * 5 + 3] + (s[j * 5 + 3] - s[i * 5 + 3]) * f;
  let dh = s[j * 5 + 4] - s[i * 5 + 4];
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  _ghostGroup.position.set(x, y, z);
  _ghostGroup.rotation.y = s[i * 5 + 4] + dh * f;
  _ghostGroup.visible = true;
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
  updateTiltCounter(dt); // opt-in on-screen tilt diagnostics
  world.update(now / 1000, dt, player ? player.position : null); // balloons, critters, fireflies, pigeons
  if (gpuParticles) gpuParticles.update(dt, camera.position); // step the GPU compute motes (follows the camera)

  if (state === State.PAUSED) {
    renderFrame(); // hold the frozen frame behind the overlay
    return;
  }

  weather.update(dt, camera.position); // rain/snow follows the player
  if (world.groundLeaves) world.groundLeaves.update(karts, camera.position, dt); // kick up leaves in the karts' wake
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
    if (_garageOpen) {
      // Garage sub-screen: orbit the camera around the parked preview kart so the
      // player can inspect their chosen cat + kart in 3D.
      renderGarage(now / 1000, dt);
      return;
    }
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
    prewarmPipelines(); // one-time (during the first countdown): warm scenery pipelines so a spin-out doesn't compile-hitch
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
    const _catnipBurnout = player.catnipBoosting && _sp > 10 && !player.airborne;
    if (player.drifting) {
      effects.driftSparks(player);
      effects.skid(player);
    } else if (_hardTurn || _catnipBurnout) {
      // Also lay rubber when cornering hard at speed (not only while drifting),
      // so tight turns leave marks — and catnip's raw torque scorches the road
      // even on the straights. (_hardTurn already gates on steer + speed.)
      effects.skid(player);
    }

    // Dust kicked off the track, tinted to the local ground. A thick plume while
    // sliding/cornering hard, a faint veil while just driving at speed — only when
    // the kart is actually on the ground (no dust mid-jump). One color sample/frame.
    if (!player.airborne && _sp > 6) {
      biomeDustColor(player.position.x, player.position.z, _dustCol);
      let amt = _drift ? 1.0 : _hardTurn ? 0.75 : Math.min(0.35, (_sp - 6) / 90);
      if (player.catnipBoosting) amt = Math.max(amt, 0.8); // catnip throws up a thick plume
      if (amt > 0.02) effects.dust(player, _dustCol, amt);
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
    // Hand them the floating power-up box positions so they go for them: leaders
    // only when one's nearly on their line, trailing karts detour further for a
    // catch-up item (see driveAI).
    const boxTargets = props ? props.boxTargets() : null;
    for (const k of karts) if (!k.isPlayer || k.finished) k.driveAI(track, dt, boxTargets);
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
      // Dust for the rest of the field, but ONLY for karts near the camera and
      // only when they're sliding — so distant traffic and the shared particle
      // budget stay protected (the player's own dust is handled above).
      if (k !== player && !k.airborne && (k.drifting || k.spinTimer > 0) &&
          k.position.distanceToSquared(camera.position) < 70 * 70) {
        biomeDustColor(k.position.x, k.position.z, _dustCol);
        effects.dust(k, _dustCol, 0.5);
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

    // Time-trial ghost: record this lap's path (~16 Hz, rounded to keep it small)
    // and replay the stored best lap as the translucent ghost kart.
    if (timeTrial && ttLapStart >= 0) {
      const elapsed = raceTime - ttLapStart;
      if (ttRecord && elapsed - _lastGhostSample >= 0.06) {
        _lastGhostSample = elapsed;
        const gp = player.group.position;
        ttRecord.push(+elapsed.toFixed(3), +gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2), +player.heading.toFixed(3));
      }
      updateGhost(elapsed);
    }

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
    hud.setPowerups(player.shieldTimer, player.triShots, player.catnipTimer);

    // Opening furball grace: count down the charge, then announce "armed". Skipped
    // in time trial (there's no one to shoot).
    const shootLockLeft = timeTrial ? 0 : SHOOT_OPENING_LOCKOUT - raceTime;
    hud.setShootLock(shootLockLeft);
    if (!timeTrial && !_furballsArmed && shootLockLeft <= 0) {
      _furballsArmed = true;
      hud.showToast("🐾 Furballs armed!");
    }

    // Time-trial: race the clock against your personal best. While the timed lap
    // runs, the timer + delta go GREEN as long as you're still under your PB time
    // and flip RED the moment you've spent longer than it — instant "on pace?"
    // feedback with no stored splits needed.
    if (timeTrial && ttLapStart >= 0 && ttBest != null) {
      const diff = raceTime - ttLapStart - ttBest;
      const ahead = diff < 0;
      if (ttDeltaEl) {
        ttDeltaEl.classList.remove("hidden");
        ttDeltaEl.textContent = (ahead ? "−" : "+") + Math.abs(diff).toFixed(2);
        ttDeltaEl.classList.toggle("ahead", ahead);
        ttDeltaEl.classList.toggle("behind", !ahead);
      }
      timerEl?.classList.toggle("ahead", ahead);
      timerEl?.classList.toggle("behind", !ahead);
    }

    updateCamera(dt);

    // Hand off to the victory lap once the player finishes; show results after a
    // celebratory beat (camera orbits the kart, fireworks pop) rather than instantly.
    if (player.finished) {
      audio.finish();
      audio.setSkid(false);
      if (timeTrial) {
        const lapTime = player.finishTime - (ttLapStart >= 0 ? ttLapStart : 0);
        _ttResult = recordTimeTrial(lapTime);
        // New best lap → save this run's path as the ghost to chase next time.
        if (ttRecord && ttRecord.length >= 10 && _ttResult.top[0] === _ttResult.entry) saveGhostData(ttRecord);
        if (_ghostGroup) _ghostGroup.visible = false;
        hud.showToast(_ttResult.top[0] === _ttResult.entry ? "🏁 NEW BEST!" : "LAP DONE!");
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
rendererReady
  .then(() => {
    _rendererReady = true;
    watchGpu(renderer); // recover from a GPU device/context loss instead of hard-crashing
    // Ambient GPU compute motes: warm dust by day, cool sparkles at night.
    const night = TIME_OF_DAY === "night";
    initGpuParticles(scene, renderer, {
      count: 450, // sweet spot: 650 read as "too many", 280 as "none" — this is the sparse-but-present middle
      tint: night ? 0xbcd0ff : TIME_OF_DAY === "sunset" ? 0xffd9a0 : 0xfff0c8,
      // A touch more opaque so the (now fewer) specks actually catch the light.
      opacity: night ? 0.5 : TIME_OF_DAY === "sunset" ? 0.3 : 0.22,
      size: night ? 0.52 : 0.42,
    }).then((p) => { gpuParticles = p; if (p && quality !== "high") p.setVisible(false); });
  })
  .catch((err) => console.error("[zoomies] renderer init failed:", err))
  .finally(() => requestAnimationFrame(loop));

// If the previous load ended in a crash, tell the player (and log the detail so we
// can diagnose). When the crash guard downgraded us to the WebGL2 backend, say so.
{
  const crash = consumeLastCrash();
  if (crash) {
    console.warn("[zoomies] recovered from a crash:", crash);
    const onWebGLNow = new URLSearchParams(location.search).has("webgl");
    const msg = crash.type && crash.type.indexOf("webgpu") === 0
      ? onWebGLNow
        ? "Recovered from a graphics glitch — switched to Compatibility mode for stability."
        : "Recovered from a graphics glitch."
      : "Recovered after an unexpected restart.";
    showRecoveryNote(msg);
  }
}
function showRecoveryNote(text) {
  try {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;left:50%;top:max(10px,env(safe-area-inset-top));transform:translateX(-50%);" +
      "z-index:99999;max-width:90%;background:rgba(20,26,40,.92);color:#cfe0ff;" +
      "border:1px solid rgba(255,179,0,.5);border-radius:10px;padding:8px 14px;" +
      "font:13px/1.3 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:center";
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 9000);
  } catch {
    /* ignore */
  }
}

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
