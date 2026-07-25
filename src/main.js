import * as THREE from "three";
// WebGPU post-processing (M4): TSL node graph via PostProcessing, replacing the
// legacy EffectComposer chain.
import { pass, mix, vec3, float, smoothstep, luminance, saturation, viewportUV, uniform, color as tslColor, normalView, positionViewDirection, Fn, Loop, If, rtt } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { createScene, moodForTimeOfDay } from "./scene.js";
import { initGpuParticles } from "./gpuparticles.js";
import { installCrashGuard, watchGpu, consumeLastCrash } from "./crashguard.js";
installCrashGuard(); // capture errors/rejections from the very start (survives a reload)
import { Weather } from "./weather.js";
import { Track, previewLoopPoints } from "./track.js";
import { featureGlyphs, trackTitle, FEATURE_CHIP_KINDS, featureCameraClamp } from "./features.js";
import { getPlatform, isNativePlatform } from "./platform/index.js";
import { Kart, setSunShadow } from "./kart.js";
import { toonify, uSunViewNode, uSunColNode } from "./toon.js";
import { setLightLevel, disposeGroup as _disposeGroup, createKartModel, createCat, CAT_PATTERNS, CAT_ACCESSORIES, ACCESSORY_COLORS, ACCESSORY_LABELS } from "./models.js";
import { initProps } from "./props.js";
import { Input } from "./input.js";
import { HairballManager, TRI_FAN } from "./hairball.js";
import { ItemManager } from "./items.js";
import { HUD, ordinal } from "./hud.js";
import { buildWorld, biomeWeatherAt, biomeNameAt, biomeRoadStyle, biomeDustColor } from "./scenery.js";
import { EffectsManager } from "./effects.js";
import { setSeed, getSeed, randomSeed, makeRng } from "./rng.js";
import { MpSession, MAX_PLAYERS, KART_COLLIDE_MIN, kartBumpPower } from "./net/session.js";
import { createPartyTransport } from "./net/partysocket.js";
import { createAblyTransport } from "./net/ably.js";
import { createWebRTCTransport } from "./net/webrtc.js";
import { resolveHost, resolveAblyKey, resolveRefereeUrl, resolveRefereeRoom } from "./net/config.js";
import { RemoteKart, FLAG } from "./remotekart.js";
import { NetRecorder, recorderEnabled } from "./net/recorder.js";
import { RefereeClient } from "./net/refereeclient.js";
import { encodeWorld, decodeWorld, sameWorld, worldSig } from "./net/worldcfg.js";
import {
  migrateProfile, isUnlocked, buyUnlock, catalogEntry, CATALOG, racePayout, checkAchievements, claimAchievement,
  ACHIEVEMENTS, CUPS, cupById, cupPoints, cupStandings, awardCup, dailySeedFor,
  encodeProfileToken, decodeProfileToken,
} from "./progress.js";
import { audio } from "./audio.js";
// Menu UI cues — fourteen tiny Web-Audio-synthesized interaction sounds
// (vendored, MIT). bind() delegates the data-cuelume-* attributes; uiCue()
// fires outcome moments; enablement follows the SFX setting.
import { bind as bindUiCues, play as uiCue, setEnabled as setUiCuesEnabled } from "cuelume";

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
let trackConfig = loadTrackConfig(); // `let`: in multiplayer this is replaced by the host's world (below)

// Garage: the player picks a cat (fur colour) and kart (body colour) before the
// race. Named presets so it reads like a character-select; the saved selection is
// stored as indices into these arrays (clamped on load) and reused for solo, the
// multiplayer broadcast identity, and to keep the AI off the player's colours.
// Each cat is a colour + an explicit markings pattern, so the seven read as
// distinct breeds rather than recolours: tabby (banded), tuxedo (white bib +
// socks + tail-tip), mitted (small white socks/bib), solid (plain coat), point
// (darker ears/muzzle/paws/tail). createCat falls back to deriving a pattern
// from the colour when none is given (recoloured AI / multiplayer cats).
// Garage presets live in src/presets.js (pure data) so the catalog-screenshot
// tool can import them without booting the game.
import { CAT_PRESETS, KART_PRESETS, DEFAULT_CUSTOM_CAT, DEFAULT_CUSTOM_KART } from "./presets.js";
// A "Custom" slot sits one past the last preset in each stepper; landing on it
// reveals the creator (colour / pattern / accessory / name) and the look is read
// from garageConfig.customCat / .customKart instead of the preset arrays.
const CUSTOM_CAT_IDX = CAT_PRESETS.length;
const CUSTOM_KART_IDX = KART_PRESETS.length;
const KART_STYLE_COUNT = 7; // GP / roadster / buggy / finned / moto / minivan / cage (see createKartModel STYLES)
// Styles the custom creator currently offers — moto (4) and minivan (5) are
// parked for now (the model code stays; they'll come back later).
const CREATOR_KART_STYLES = [0, 1, 2, 3, 6]; // GP, Roadster, Buggy, Finned, Cage (Moto/Minivan stay scenery)
const GARAGE_KEY = "zoomies-garage-v1";
const _clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
const _clampColor = (v, dflt) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : dflt);
const _clampName = (v, dflt) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 14) : dflt);
// Every accessory is wearable in the creator — the wardrobe is part of what
// the Custom Cat creator purchase buys, not a second layer of unlocks.
function sanitizeCustomCat(c) {
  c = c && typeof c === "object" ? c : {};
  return {
    name: _clampName(c.name, DEFAULT_CUSTOM_CAT.name),
    fur: _clampColor(c.fur, DEFAULT_CUSTOM_CAT.fur),
    pattern: CAT_PATTERNS.includes(c.pattern) ? c.pattern : DEFAULT_CUSTOM_CAT.pattern,
    accessory: CAT_ACCESSORIES.includes(c.accessory) ? c.accessory : DEFAULT_CUSTOM_CAT.accessory,
    // null means "use the accessory's natural default colour"; otherwise a valid hex int.
    accessoryColor: _clampColor(c.accessoryColor, null),
  };
}
function sanitizeCustomKart(k) {
  k = k && typeof k === "object" ? k : {};
  let style = _clampInt(k.style, 0, KART_STYLE_COUNT - 1, DEFAULT_CUSTOM_KART.style);
  if (!CREATOR_KART_STYLES.includes(style)) style = DEFAULT_CUSTOM_KART.style; // scenery-only styles fall back
  return {
    name: _clampName(k.name, DEFAULT_CUSTOM_KART.name),
    color: _clampColor(k.color, DEFAULT_CUSTOM_KART.color),
    style,
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
    return { name: c.name, fur: c.fur, pattern: c.pattern, accessory: c.accessory, accessoryColor: c.accessoryColor };
  }
  const p = CAT_PRESETS[cfg.cat] || CAT_PRESETS[0];
  // Preset cats may override their pattern's default accessory (presets.js).
  return { name: p.name, fur: p.fur, pattern: p.pattern, accessory: p.accessory, accessoryColor: undefined };
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
  return { catColor: cat.fur, catPattern: cat.pattern, catAccessory: cat.accessory, catAccessoryColor: cat.accessoryColor, color: kart.color, kartStyle: kart.style, kartNumber: kart.number, name: cat.name };
}

const _qs = new URLSearchParams(location.search);
const _seedParam = _qs.get("seed");
// Multiplayer world sync: the WHOLE map (track config + laps + seed) must come from
// the HOST, not each device's own saved settings — otherwise two players in the same
// room build DIFFERENT tracks (the "connected but on different maps" bug). The invite
// link carries `?w=` (the host's encoded world), and a code-joiner adopts it via a
// reload once connected (see maybeAdoptHostWorld). Single-player / hosting take
// neither branch below, so their world resolution is byte-for-byte unchanged.
const _sharedWorld = decodeWorld(_qs.get("w"));
let _mpLaps = null; // host's lap count when the world came from `?w=` (overrides local)
// Am I acting as the room HOST? enterMultiplayer stores its seed here; joinGame
// clears it to "". This is the right host/joiner distinguisher for the guard below:
// a JOINER's saved custom track must not hijack the host's seed/room, but a HOST
// keeps their own custom map — and it must NOT be wrongly reverted when "apply custom
// track" (or a plain refresh) reloads with `?mp&seed` still in the URL. (That over-
// broad revert was the "custom track goes back to default" bug.)
let _mpHostSeed = "";
try { _mpHostSeed = sessionStorage.getItem("mp-host-seed") || ""; } catch { /* ignore */ }
if (_sharedWorld) {
  trackConfig = _sharedWorld.cfg; // build EXACTLY the host's map
  if (_sharedWorld.laps >= 1 && _sharedWorld.laps <= 5) _mpLaps = _sharedWorld.laps;
} else if (_qs.has("mp") && _seedParam && trackConfig.mode === "custom" && !_mpHostSeed) {
  // A JOINER (not the host) with a saved custom track: start neutral (classic) from
  // the seed so it can't hijack the host's room; the adopt-reload pulls the host's
  // real world once we connect.
  trackConfig = { mode: "classic" };
}
// Normalize the stored seed to the same casing the world stream uses: the
// isolated plan streams (biome wedges, summit, crossover) key off cfg.seed,
// and a hand-edited/URL-shared lowercase seed would otherwise plan against a
// different string than the uppercased shared stream builds with.
if (trackConfig.mode === "custom" && trackConfig.seed) trackConfig.seed = String(trackConfig.seed).toUpperCase();
const WORLD_SEED = (
  (_sharedWorld && _sharedWorld.seed) ||
  (trackConfig.mode === "custom" && trackConfig.seed) ||
  _seedParam ||
  randomSeed()
).toUpperCase();
setSeed(WORLD_SEED);
console.log(`[zoomies] world seed: ${getSeed()} · track: ${trackConfig.mode}`);

// --- Player progression (treats / unlocks / cups / daily) -------------------
// The pure economy lives in src/progress.js; this block owns storage + the boot
// state for cup/daily runs. See docs/gameplay-backlog.md for the design.
const PROFILE_KEY = "zoomies-profile-v1";
function loadProfile() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(PROFILE_KEY)); } catch { /* ignore */ }
  return migrateProfile(raw);
}
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* ignore */ }
}
const profile = loadProfile();
// Grandfather: never confiscate. Whatever the player already had selected when
// progression shipped stays theirs — auto-unlock the saved garage picks.
{
  const ids = [];
  ids.push(garageConfig.cat === CUSTOM_CAT_IDX ? "custom.cat" : `cat.${garageConfig.cat}`);
  ids.push(garageConfig.kart === CUSTOM_KART_IDX ? "custom.kart" : `kart.${garageConfig.kart}`);
  let changed = false;
  for (const id of ids) if (!profile.unlocked.includes(id)) { profile.unlocked.push(id); changed = true; }
  if (changed) saveProfile();
}

// Dev mode: ?dev=1 (or the 7-tap on the Settings title) turns on a Developer card
// in Settings + a console API. Persisted until explicitly disabled there.
const DEV_KEY = "zoomies-dev";
let devMode = false;
try { devMode = _qs.has("dev") || localStorage.getItem(DEV_KEY) === "1"; } catch { /* ignore */ }
try { if (devMode) localStorage.setItem(DEV_KEY, "1"); } catch { /* ignore */ }

// Cup run state (a cup is a reload chain — each race is a different seed, and the
// world is built from the seed at load). Active only while the URL's ?cup= matches.
const CUP_KEY = "zoomies-cup-v1";
let _cupState = null;
try { _cupState = JSON.parse(sessionStorage.getItem(CUP_KEY)); } catch { /* ignore */ }
const _cupParam = _qs.get("cup");
if (!_cupState || !_cupParam || _cupState.id !== _cupParam || !cupById(_cupState.id)) _cupState = null;
const _activeCup = _cupState ? cupById(_cupState.id) : null;

// Daily challenge: today's shared seed (local date — "the day" as the player sees it).
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const _dailyActive = _qs.has("daily") && _seedParam === dailySeedFor(todayStr());

// Menu-map cup cycling state (declared early — applyModeUI touches these at boot).
let _mapCycleTimer = null;
let _mapCycleIdx = 0;

// Per-race moment counters (reset in prepareRace, folded into the profile's
// career stats when the race pays out). null outside a race so hooks can guard.
let _raceStats = null;
let _racePaid = false; // the payout runs once per race, on the first showResults

// Why did this boot happen? Every intentional in-app reload (track apply,
// backend switch, multiplayer join, crash recovery) tags its cause in
// sessionStorage just before reloading; we report and clear it here. A boot
// with nav=reload and NO cause means something outside the app restarted the
// page — e.g. iOS killing the web content process under memory pressure and
// the shell reloading it — which is otherwise invisible in the logs.
const RELOAD_CAUSE_KEY = "zoomies-reload-cause";
function markReload(cause) {
  try { sessionStorage.setItem(RELOAD_CAUSE_KEY, cause); } catch { /* ignore */ }
}
{
  let _cause = "";
  try {
    _cause = sessionStorage.getItem(RELOAD_CAUSE_KEY) || "";
    if (_cause) sessionStorage.removeItem(RELOAD_CAUSE_KEY);
  } catch { /* ignore */ }
  const _nav = performance.getEntriesByType?.("navigation")?.[0]?.type || "?";
  const _build = document.querySelector('meta[name="zoomies-build"]')?.content || "unknown";
  console.log(`[zoomies] boot: nav=${_nav}${_cause ? ` · cause=${_cause}` : ""} · build=${_build}`);
}

// Boot timeline stamps (ms since navigation start), logged once from the
// render loop's first frames — quantifies the "long pause before the menu":
// script parse+eval vs world build vs renderer init vs first-frame compiles.
const _boot = { eval: performance.now(), world: 0, renderer: 0, frames: 0 };

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
// Debug hook (console / headless tooling): inspect the live scene graph and
// renderer counters without instrumenting a build.
window.__zoomies = { scene, camera, renderer }; // world/track/karts attached below once built
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
let moodContrast = MOOD.contrast; // this race's base contrast (biome grade scales it)
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
// No MRT: the scene renders a single colour attachment (+ depth for the god
// rays). Normals + metalness used to be rendered too, feeding a half-res SSR
// pass — but its only consumers were the lakes and puddles, both of which face
// UP, so at driving angles the reflected bank slid off-screen and the march
// collapsed into blocky miss-patches (the reported "gaps in the lake"). Both
// surfaces now bake a fresnel sky tint into their colour instead (see
// makeWaterMaterial / _buildPuddles), which reads just as reflective — so SSR,
// its ray march, and two full-screen MRT attachments are gone. On mobile the
// MRT bandwidth alone was a meaningful slice of the frame.
const _sceneTex = _scenePass.getTextureNode("output");
const _sceneDepthTex = _scenePass.getTextureNode("depth");
const _bloomNode = bloom(_sceneTex, 0.32, 0.5, 0.9); // strength 0.45->0.32, threshold 0.85->0.9: less midday wash
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
      const s = _sceneTex.sample(coord.clamp(0, 1)).rgb.clamp(0, 1); // r185: texture nodes sample via .sample(), not .uv()
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
// Render the shafts to a LOW-RES target (0.42× the drawing buffer, ~18% of the
// pixels) and composite over the full-res scene — shafts are soft/low-frequency,
// so the downsample is invisible. The target is sized EXPLICITLY in
// applyResolution(): with RTTNode's autoSize (no explicit size), updateBefore
// overwrites .pixelRatio with the renderer's every frame, so the old
// `_shaftTex.pixelRatio = 0.42` was silently ignored and the shafts rendered at
// FULL resolution — the main facing-the-sun frame cost. Updates are also driven
// manually at half rate (see updateAtmosphere) instead of every frame.
const _shaftTex = rtt(_godrayShafts());
_shaftTex.autoUpdate = false;
let _shaftFlip = false; // half-rate refresh parity
let _shaftLive = true;  // whether the target still needs a final black fill
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
// High: scene + god-ray shafts + bloom. Low: scene + bloom only — drops the
// per-pixel god-ray pass, the big GPU/memory win on weak devices (see
// applyQuality()).
const _highOutput = gradeOutput(_sceneTex.add(_shaftTex).add(_bloomNode));
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
// Per-biome colour grade: a SUBTLE atmosphere shift as you drive between
// biomes, so each one reads different beyond its props — desert bakes a touch
// warmer/brighter, alpine goes cool and crisp, the forest closes in darker and
// greener, the city reads flat and contrasty. Multipliers on top of the mood's
// saturation/exposure/contrast, crossfaded over ~1.5s at the borders.
const BIOME_GRADE = {
  meadow:  { sat: 1.0,  exp: 1.0,  con: 1.0 },
  desert:  { sat: 1.06, exp: 1.05, con: 1.0 },
  savanna: { sat: 1.05, exp: 1.03, con: 1.0 },
  beach:   { sat: 1.06, exp: 1.04, con: 0.99 },
  alpine:  { sat: 0.93, exp: 1.05, con: 1.03 },
  tundra:  { sat: 0.92, exp: 1.03, con: 1.03 },
  forest:  { sat: 1.05, exp: 0.93, con: 1.03 },
  autumn:  { sat: 1.1,  exp: 1.0,  con: 1.0 },
  blossom: { sat: 1.07, exp: 1.02, con: 0.99 },
  city:    { sat: 0.96, exp: 1.0,  con: 1.05 },
};
let _bgSat = 1, _bgExp = 1, _bgCon = 1; // smoothed live multipliers
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
window.__zoomies.world = world; // debug hook (headless probes sample heightAt/lakes)
const items = new ItemManager(scene, track); // yarn balls + milk puddles
Object.assign(window.__zoomies, { world, track, items }); // items: headless item-behavior probes
_boot.world = performance.now();


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
  window.__zoomies.props = p; // debug hook (headless probes target live box positions)
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
  if (kart === player && _raceStats) _raceStats.boxes++;

  const n = Math.max(2, _fieldCount);
  const f = Math.min(1, Math.max(0, ((kart.place || 1) - 1) / (n - 1))); // 0 leader .. 1 last

  effects.tootBurst(kart, 2, false); // a sparkly grab poof
  audio.boost(kart === player ? null : kart.position);
  // Position-shaped roll: each item lands where it's USEFUL. The leader defends
  // (shield + milk trap — yarn/tri/laser need a target ahead, which they don't
  // have); the mid-pack gets the targeted-offense knife fight (laser + yarn); the
  // back gets rescue (catnip + hearts). Every kart rolls locally; remotes short-
  // circuit at the top of this function, and the resulting spawn replicates.
  const w = rollWeights(f);
  const r = Math.random();
  let acc = 0, pick = ITEM_ROLL.length - 1;
  for (let i = 0; i < ITEM_ROLL.length; i++) { acc += w[i]; if (r < acc) { pick = i; break; } }
  switch (ITEM_ROLL[pick].name) {
    case "shield":
      kart.giveShield(15);
      if (kart === player) hud.showToast("🛡️ Shield — 15s of protection!");
      break;
    case "milk":
      kart.giveMilk();
      if (kart === player) hud.showToast("🥛 Milk bottle — drop it behind you!");
      break;
    case "yarn":
      kart.giveYarn();
      if (kart === player) hud.showToast("🧶 Yarn ball — next shot homes!");
      break;
    case "tri":
      kart.giveTriShots(3);
      if (kart === player) hud.showToast("🐾 Tri-furball ×3!");
      break;
    case "life":
      kart.giveLife();
      if (kart === player) hud.showToast("😻 Extra life — your next wipeout is forgiven!");
      break;
    case "laser":
      kart.giveLaser();
      if (kart === player) hud.showToast("🔴 Laser pointer — zap the kart ahead!");
      break;
    default:
      kart.giveCatnip();
      if (kart === player) hud.showToast("🌿 Catnip boost!");
      break;
  }
  return true;
}

// Per-item roll weights anchored at FRONT (f=0), MID (f=0.5) and BACK (f=1),
// interpolated linearly between anchors — each anchor column sums to 1, so any
// interpolated row does too. Design: the leader DEFENDS (shield/milk), the
// mid-pack BRAWLS (laser/yarn strongest where a target is always just ahead),
// the back gets RESCUED (catnip half their rolls, hearts steady).
const ITEM_ROLL = [
  { name: "shield", w: [0.30, 0.06, 0.00] },
  { name: "milk",   w: [0.34, 0.17, 0.06] },
  { name: "yarn",   w: [0.06, 0.19, 0.10] },
  { name: "tri",    w: [0.08, 0.15, 0.10] },
  { name: "life",   w: [0.16, 0.16, 0.15] },
  { name: "laser",  w: [0.06, 0.21, 0.09] },
  { name: "catnip", w: [0.00, 0.06, 0.50] },
];
function rollWeights(f) {
  const a = f < 0.5 ? 0 : 1;
  const t = f < 0.5 ? f / 0.5 : (f - 0.5) / 0.5;
  const w = ITEM_ROLL.map((it) => it.w[a] + (it.w[a + 1] - it.w[a]) * t);
  // Catnip stays STRICTLY off near the front (it out-runs everything and grants
  // invincibility) — zero it inside the front band and renormalize the rest.
  if (f < 0.3) {
    const cat = w[w.length - 1];
    if (cat > 0) {
      w[w.length - 1] = 0;
      const s = 1 / (1 - cat);
      for (let i = 0; i < w.length - 1; i++) w[i] *= s;
    }
  }
  return w;
}
window.__zoomies.grantItem = grantItem; // debug hook (headless probes verify the roll distribution)

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
// Hoisted beam-ranking comparator (camera XZ via module vars, no per-frame closure).
let _hlCx = 0, _hlCz = 0;
function _hlCmp(a, b) {
  if (a === player) return -1;
  if (b === player) return 1;
  const da = (a.position.x - _hlCx) ** 2 + (a.position.z - _hlCz) ** 2;
  const db = (b.position.x - _hlCx) ** 2 + (b.position.z - _hlCz) ** 2;
  return da - db;
}
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
//
// Created ONCE here — in the scene before the boot draw-everything pass — and
// REPARENTED to each race's player kart. It used to be recreated per race,
// which changed the scene's light configuration between boot and racing: that
// invalidated every lit pipeline the boot warm pass had compiled, so scenery
// recompiled piece-by-piece as it first entered view during the opening
// stretch of the race (the reported "stalls at the start"). With the light
// permanent (idle at zero intensity), the boot-compiled pipelines stay valid.
const _boostLight = new THREE.PointLight(0xff8a2e, 0, 26, 1.6);
_boostLight.position.set(0, 0.7, -2.7);
_boostLight.castShadow = false;
scene.add(_boostLight);
function attachBoostLight(playerKart) {
  if (!playerKart || !playerKart.group) return;
  _boostLight.position.set(0, 0.7, -2.7);
  playerKart.group.add(_boostLight); // add() re-parents from the previous kart
}

// Minimap: a static top-down outline of the track with a coloured dot per kart.
let minimap = setupMinimap();

// --- Cel shading: convert lit (standard) materials to banded toon shading ---
// The conversion lives in toon.js (shared with the asset viewer's "game look"
// toggle, so the viewer previews exactly what ships).
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
let _steerDotLast = Infinity; // last written steer value (guards the style write)
document.getElementById("calibrate").addEventListener("click", () => input.calibrate());

const input = new Input();
const hairballs = new HairballManager(scene);
const effects = new EffectsManager(scene);
// Scratch for the countdown effect warm-up (see startRace).
const _warmPos = new THREE.Vector3();
const _warmDir = new THREE.Vector3(0, -1, 0);
const _dustCol = new THREE.Color(); // reused each frame for the biome-tinted kart dust
const hud = new HUD();
const _hudOpts = { lapNum: 0, totalLaps: 0, place: 0, totalKarts: 0, speedKmh: 0, time: 0 }; // reused hud.update arg

// Boost (toot) meter UI reflects the player kart's own meter.
const boostBtn = document.getElementById("btn-boost");
const boostFill = document.getElementById("boost-fill");
const shootBtn = document.getElementById("btn-shoot");
const milkBtn = document.getElementById("btn-milk");
const yarnWarnEl = document.getElementById("yarn-warn");
let _boostPctLast = -1;
let _boostDisLast = null;
let _draftLast = null;
let _overLast = null;
let _shootDisLast = null;
let _yarnArmedLast = null;
let _milkOnLast = null;
let _yarnWarnLast = null;
function updateBoostUI() {
  const m = player ? player.boostMeter : 0;
  // Change-gated DOM writes: this runs every racing frame and the values move in
  // whole-percent steps at most.
  const pct = Math.round(Math.min(1, m) * 100); // bar fills to full; overcharge shows as a glow, not a taller bar
  if (pct !== _boostPctLast) {
    _boostPctLast = pct;
    boostFill.style.height = `${pct}%`;
  }
  const dis = m < 1;
  if (dis !== _boostDisLast) {
    _boostDisLast = dis;
    boostBtn.classList.toggle("disabled", dis); // only fire when full
  }
  // Overcharged (drafted past full): a gold pulse so the beefier toot is legible.
  const over = m > 1.02;
  if (over !== _overLast) {
    _overLast = over;
    boostBtn.classList.toggle("overcharged", over);
  }
  // Glow the meter while a draft is charging it faster, so the speedup is legible
  // on the HUD, not just out on the track. (Suppressed once overcharged — that has
  // its own, stronger cue.)
  const drafting = !!player && player.slipstream > 0.15 && m < 1;
  if (drafting !== _draftLast) {
    _draftLast = drafting;
    boostBtn.classList.toggle("drafting", drafting);
  }
  // Milk bottle button only exists while a bottle is held; the shoot button
  // shows the yarn while one is armed (it takes over the next shot).
  const yarnArmed = !!player && player.yarnShots > 0;
  if (yarnArmed !== _yarnArmedLast) {
    _yarnArmedLast = yarnArmed;
    if (shootBtn) shootBtn.textContent = yarnArmed ? "\u{1F9F6}" : "\u{1F43E}";
  }
  const milkOn = !!player && player.milkBottles > 0;
  if (milkOn !== _milkOnLast) {
    _milkOnLast = milkOn;
    milkBtn?.classList.toggle("hidden", !milkOn);
  }
  // Dim the shoot button while it's recharging (or locked out after a hit).
  const sd = !!player && player.shootCooldown > 0;
  if (shootBtn && sd !== _shootDisLast) {
    _shootDisLast = sd;
    shootBtn.classList.toggle("disabled", sd);
  }
}

// --- Slipstreaming (drafting) ---
// Tuck into the wake just behind another kart and your toot-boost meter charges
// faster (each kart's `slipstream` 0..1 is consumed in Kart.update). Pure position
// math over the live field, so it covers the player, the AI, and — with zero new
// netcode — remote ghosts (their pose already streams in; we detect their draft
// locally to drive the wind fx). Strength ramps with how close + how centred you
// are in the wake. Only a trailing kart has a wake to sit in, so it's a natural
// catch-up mechanic; popping the boost pulls you out — "draft, then pass".
const DRAFT_MIN = 3.0;    // u: nearer than this you're basically touching — no draft (don't reward ramming)
const DRAFT_MAX = 13;     // u: how far back the wake still helps (widened — the draft was too fiddly to catch)
const DRAFT_LANE = 3.4;   // u: half-width of the wake at the leader; fans out with distance (a cone)
const DRAFT_ALIGN = 0.5;  // min cos(heading delta): must travel roughly the same way (~60°)
const DRAFT_MINSPEED = 8; // u/s: both karts must actually be moving
function updateSlipstream(field) {
  for (const k of field) { k.slipstream = 0; k._drafted = 0; }
  for (const k of field) {
    if (k.finished || k.spinTimer > 0 || Math.abs(k.speed) < DRAFT_MINSPEED) continue;
    let best = 0, bestT = null;
    for (const t of field) {
      if (t === k || Math.abs(t.speed) < DRAFT_MINSPEED) continue;
      const tfx = Math.sin(t.heading), tfz = Math.cos(t.heading);
      // Same direction of travel? (guards head-on / crossing strands on loop maps)
      if (Math.sin(k.heading) * tfx + Math.cos(k.heading) * tfz < DRAFT_ALIGN) continue;
      const dx = k.position.x - t.position.x, dz = k.position.z - t.position.z;
      const behind = -(dx * tfx + dz * tfz); // + = I'm behind the leader, in its wake
      if (behind < DRAFT_MIN || behind > DRAFT_MAX) continue;
      const lateral = Math.abs(dx * tfz - dz * tfx); // sideways offset from the leader's line
      const lane = DRAFT_LANE + behind * 0.12;       // wake widens behind
      if (lateral > lane) continue;
      const distF = 0.35 + 0.65 * ((DRAFT_MAX - behind) / (DRAFT_MAX - DRAFT_MIN)); // closer = stronger
      const s = distF * (1 - lateral / lane);        // centred = stronger
      if (s > best) { best = s; bestT = t; }
    }
    k.slipstream = best;
    if (bestT) bestT._drafted = Math.max(bestT._drafted, best); // for the leader's wake fx
  }
}

// --- Laser pointer (item) ---
// A front-mounted laser, instant-on for a few seconds when rolled (like catnip —
// no extra button). While active it locks the kart just AHEAD in a short, narrow
// cone and "zaps" it: the victim's cat fixates on the dot and their steering
// jitters (kart.zapTimer — fightable), unless they raise the shield (which blocks
// the zap at the cost of the shield's top-speed penalty — the receiver's trade).
//
// Multiplayer costs NOTHING new on the wire: the laser state rides the existing
// pose FLAG bits, and every client derives the rest locally — a remote's beam is
// drawn from its flagged pose, and "am I being zapped" is computed victim-side
// from the same lock test. Small cross-client disagreements are cosmetic-only.
const LASER_RANGE = 22;  // u: max lock distance (short — you must close in to zap)
const LASER_NEAR = 1.5;  // u: closer than this is bumper contact, not a beam
const _laserBeams = new Map(); // emitter kart -> beam mesh (lazily created)
const _laserMat = new THREE.MeshBasicMaterial({
  color: 0xff2a2a, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
function laserTargetOf(shooter, field) {
  const fwx = Math.sin(shooter.heading), fwz = Math.cos(shooter.heading);
  let best = null, bestAhead = LASER_RANGE;
  for (const t of field) {
    if (t === shooter || t.finished) continue;
    const dx = t.position.x - shooter.position.x, dz = t.position.z - shooter.position.z;
    const ahead = dx * fwx + dz * fwz;
    if (ahead < LASER_NEAR || ahead > bestAhead) continue;
    if (Math.abs((t.position.y || 0) - (shooter.position.y || 0)) > 7) continue; // same strand
    if (Math.abs(dx * fwz - dz * fwx) > 2.6 + ahead * 0.14) continue; // narrow cone
    bestAhead = ahead; best = t;
  }
  return best;
}
function updateLasers(field) {
  // Hide every beam first; active emitters re-show theirs below. Prune beams whose
  // kart left the scene (a disposed multiplayer ghost).
  for (const [k, beam] of _laserBeams) {
    beam.visible = false;
    if (k.group && !k.group.parent) { scene.remove(beam); beam.geometry.dispose(); _laserBeams.delete(k); }
  }
  for (const k of field) {
    if (!(k.laserTimer > 0) || k.finished || k.spinTimer > 0) continue;
    const t = laserTargetOf(k, field);
    if (!t) continue;
    // Zap: only apply physics to LOCAL karts (player + AI). A remote ghost's owner
    // computes its own zap from OUR flagged pose on their client.
    if (!t.isRemote && !t.shielding) {
      const wasZapped = t.zapTimer > 0;
      t.zapTimer = Math.max(t.zapTimer, 0.4); // lingers briefly after the beam breaks
      if (t === player && !wasZapped) hud.showToast("🔴 Laser! Shake it or shield!");
      if (k === player && !wasZapped && _raceStats) _raceStats.zaps++; // my dot landed
    }
    // Beam visual: a thin additive red bar from the shooter's nose to the target.
    let beam = _laserBeams.get(k);
    if (!beam) {
      beam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1), _laserMat);
      beam.renderOrder = 5;
      _laserBeams.set(k, beam);
      scene.add(beam);
    }
    const sy = k.position.y + (k.y || 0) + 1.1, ty = t.position.y + (t.y || 0) + 1.0;
    _laserFrom.set(k.position.x + Math.sin(k.heading) * 2.2, sy, k.position.z + Math.cos(k.heading) * 2.2);
    _laserTo.set(t.position.x, ty, t.position.z);
    beam.position.copy(_laserFrom).add(_laserTo).multiplyScalar(0.5);
    beam.lookAt(_laserTo);
    beam.scale.set(1, 1, Math.max(0.1, _laserFrom.distanceTo(_laserTo)));
    beam.visible = true;
  }
}
const _laserFrom = new THREE.Vector3();
const _laserTo = new THREE.Vector3();

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
  const playerCfg = { ...ROSTER[0], color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, catAccessoryColor: look.catAccessoryColor, kartStyle: look.kartStyle, kartNumber: look.kartNumber };
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

// Per-race seeded RNG for the SIM path (grid shuffle, AI lane/shield, spinouts),
// so a given world seed replays identically. Re-forked each race in buildKarts.
let _simRng = Math.random;

function buildKarts() {
  // Tear down last race's karts properly: freeing the merged geometries + the
  // per-kart materials (shared ones are skipped) releases their GPU buffers
  // instead of leaking them each rebuild.
  for (const k of karts) {
    scene.remove(k.group);
    _disposeGroup(k.group);
  }
  karts = [];
  _simRng = makeRng(WORLD_SEED + "|sim"); // fresh seeded stream for this race
  _hlRamp = 0.18; // headlights start dim and ramp up once racing, to avoid a grid blowout
  // Player wears the garage pick; AI avoid clashing with it. Multiplayer is
  // humans-only and time trial is solo, so both are just the player's kart.
  const roster = raceRoster();
  // Solo: shuffle the starting-grid slots so the player doesn't always launch
  // from the same spot. It's one level for now, so a random grid position each
  // race adds variety. (Per-race Math.random, not the seeded world RNG.)
  const slots = roster.map((_, i) => i);
  if (!MP.enabled) {
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(_simRng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
  }
  const diff = AI_DIFFICULTY[DIFFICULTY] || AI_DIFFICULTY.hard;
  roster.forEach((cfg, i) => {
    const kart = new Kart({ ...cfg, rng: _simRng });
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
  attachBoostLight(player); // reparent the persistent exhaust glow to the new player kart
  window.__zoomies.karts = karts;
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

// This client's authoritative world: the exact map every player in the room must
// build. `trackConfig` is already the host's config when we joined via `?w=`.
function currentWorld() {
  return { cfg: trackConfig, laps: TOTAL_LAPS, seed: WORLD_SEED };
}

// A short, human-comparable fingerprint of a world (track type + a 4-char hash of
// the full config). Shown in the lobby under the room code so two phones can
// eyeball whether they built the SAME map — if these differ, world sync didn't
// take. Pure function of {cfg, laps, seed}, so identical worlds → identical tag.
function worldFingerprint(world) {
  if (!world || !world.cfg) return "";
  const mode = world.cfg.mode === "custom" ? "Custom" : "Classic";
  const sig = worldSig(world);
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0;
  const laps = world.laps || TOTAL_LAPS;
  return `${mode} · ${laps} lap${laps > 1 ? "s" : ""} · #${h.toString(36).toUpperCase().slice(-4)}`;
}

// Broadcast the player's garage selection so rivals see the cat + kart they chose
// (display name = the cat's name), plus whether I'm the room's host. The HOST also
// advertises its world so a joiner who arrived by typed code (no `?w=`) can adopt
// the host's exact map (maybeAdoptHostWorld).
function makeMpIdentity() {
  const look = playerLook();
  const id = { name: look.name, color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, catAccessoryColor: look.catAccessoryColor, kartStyle: look.kartStyle, kartNumber: look.kartNumber, host: _amHost };
  // EVERY client advertises its world (not just the current host): a guest who
  // is later promoted to host — someone who joined via an ?mp=1 link and then hit
  // Start — never re-sends its hello, so if the world only rode the host flag its
  // map could never be adopted. Advertising it always means peers already hold it
  // when the host-claim arrives, so a code-joiner adopts the right map either way.
  id.world = currentWorld();
  return id;
}

// A joiner who arrived by typed room code (no `?w=` in the URL) may have built a
// different map than the host. Once the host's world arrives in its hello, reload
// into the host's EXACT world so both build the same track. Guarded so it can never
// loop: only fires when I'm not the host and my world genuinely differs, and is
// capped per join attempt (after a successful adopt, currentWorld() matches → no
// further reload; the counter is the belt-and-suspenders).
let _worldAdoptTried = false;
function maybeAdoptHostWorld() {
  if (_amHost || _worldAdoptTried || !MP.enabled) return;
  // Arrived via an invite link (`?w=`)? Then I already built the host's authoritative
  // world at load — never reload. (The adopt-reload only exists for typed-code joins,
  // which have no world at load.)
  if (_sharedWorld) return;
  // Only ever adopt (reload) from the menu/lobby — NEVER once a race is starting or
  // underway. A late roster event (a presence blip, the host re-announcing) must not
  // reload a client mid-countdown/mid-race and drop it out of the start.
  if (state === State.COUNTDOWN || state === State.RACING || state === State.FINISHED) return;
  let hostWorld = null;
  for (const r of MP.remotes.values()) if (r.host && r.world) { hostWorld = r.world; break; }
  if (!hostWorld || sameWorld(hostWorld, currentWorld())) return; // no host yet, or already matching
  // Loop guard, keyed on WHICH world we adopt (not a blind counter). Adopting a
  // given host world reloads us into a build that matches it, so we should never
  // need to adopt that same world twice — if we already tried this exact one and
  // still don't match, something's off; bail rather than reload-loop. This can
  // never get permanently stuck the way a saturating counter could (a fresh/
  // different host world is always still adoptable): the sig is the host's world,
  // and after a successful adopt currentWorld() equals it so we return above.
  const wantSig = worldSig(hostWorld);
  let triedSig = "";
  try { triedSig = sessionStorage.getItem("mp-adopt-sig") || ""; } catch { /* ignore */ }
  if (triedSig === wantSig) {
    console.warn(`[world] already tried to adopt ${worldFingerprint(hostWorld)} but still on ${worldFingerprint(currentWorld())} — not reloading again`);
    return;
  }
  console.log(`[world] adopting host map ${worldFingerprint(hostWorld)} (was ${worldFingerprint(currentWorld())})`);
  _worldAdoptTried = true;
  try { sessionStorage.setItem("mp-adopt-sig", wantSig); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.set("w", encodeWorld(hostWorld));
  if (hostWorld.seed) u.searchParams.set("seed", String(hostWorld.seed));
  u.searchParams.set("mp", "1");
  markReload("mp-adopt");
  location.href = u.toString();
}

// Scratch vectors for incoming shoot messages (spawnAt copies its args).
const UP_Y = new THREE.Vector3(0, 1, 0);
const _mpShotPos = new THREE.Vector3();
const _mpShotDir = new THREE.Vector3();
const _mpShotFan = new THREE.Vector3();

// The multiplayer session (src/net/session.js) owns the netcode: connection,
// remote roster, parked ghosts, the 16 Hz send loop and the adaptive interp
// delay. Everything game/DOM-shaped is injected here; the hooks fire at event
// time, so they can safely reference functions and state declared later in
// this module.
const MP = new MpSession({
  createRemote: (identity) => {
    const r = new RemoteKart(identity);
    decorateKartGroup(r.group);
    scene.add(r.group);
    return r;
  },
  disposeRemote: (r) => r.dispose(scene),
  hasLocalPlayer: () => !!player,
  getPose: () => {
    let f = 0;
    if (player.drifting) f |= FLAG.DRIFT;
    if (player.boosting) f |= FLAG.BOOST;
    if (player.shielding) f |= FLAG.SHIELD;
    if (player.airborne || player.y > 0.01) f |= FLAG.AIRBORNE;
    if (player.wallHitPulse > 0) f |= FLAG.WALL; // scraping a railing → rivals see the sparks too
    if (player.laserTimer > 0) f |= FLAG.LASER; // firing the laser → rivals draw my beam + zap themselves (latch, not the 1-frame wallHit — the send runs before physics sets it)
    return {
      x: player.position.x,
      y: player.groundY + player.y,
      z: player.position.z,
      h: player.heading,
      p: player.slopePitch,
      s: player.speed,
      f,
      pr: player.totalProgress,
    };
  },
  amHost: () => _amHost,
  hooks: {
    // Roster changed (peer joined/left) or our own connection opened: refresh
    // the "N friends here" count immediately, and the lobby if it's showing.
    onRoster: () => {
      if (MP.inLobby) uiCue("ready"); // connection opened / a friend arrived
      setMpStatus("connected");
      maybeAdoptHostWorld(); // a code-joiner rebuilds into the host's map once it learns it
      // If I'm the host and a race is already counting down, re-send the start so a
      // peer that just (re)joined syncs into it instead of being stranded in the
      // lobby. sendStart is idempotent (beginSyncedRace ignores it once counting).
      if (_amHost && MP.net && MP.startAt && state === State.COUNTDOWN) MP.net.sendStart(MP.startAt);
      if (MP.inLobby) renderLobby();
    },
    // Lost a host tiebreak (another client claimed host with a lower id): step
    // down so the room keeps exactly one host.
    onHostYield: () => {
      _amHost = false;
      try { sessionStorage.setItem("mp-host-seed", ""); } catch { /* ignore */ }
      if (MP.inLobby) renderLobby();
    },
    onConnClosed: () => setMpStatus(MP.connState === "failed" ? "failed" : "closed"),
    onStart: (at) => beginSyncedRace(at),
    onShoot: (s) => {
      // spawnAt copies both vectors, so these scratch temps are safe to reuse
      // across messages.
      _mpShotPos.set(s.px, s.py, s.pz);
      _mpShotDir.set(s.dx, s.dy, s.dz);
      if (s.t) {
        // Tri-furball: fan into three, matching the shooter's local spread.
        for (const a of TRI_FAN) hairballs.spawnAt(_mpShotPos, _mpShotFan.copy(_mpShotDir).applyAxisAngle(UP_Y, a), s.c || 0);
      } else {
        hairballs.spawnAt(_mpShotPos, _mpShotDir, s.c || 0);
      }
    },
    onHit: (h) => {
      // The session already checked the hit targets me; the victim's own shield
      // (or catnip invincibility) gets last say.
      if (!player || state !== State.RACING) return;
      // When a referee is live, its lag-compensated verdict is authoritative — let
      // it decide the spin so both screens agree, instead of applying twice.
      if (_ref && _ref.ready) return;
      if (player.shielding || player.catnipBoosting) return; // catnip = invincible
      const dir = new THREE.Vector3(h.hx, 0, h.hz);
      player.spinOut(dir.lengthSq() > 0.0001 ? dir : null);
    },
    // A remote player dropped milk: replicate the puddle (victim-authoritative —
    // our own player trips it locally via items.update, so no hit event). Carry the
    // dropper's id so if we trip on it we can let them gloat (onMilkGloat).
    onMilk: (m) => { items.spawnMilkAt({ x: m.x, z: m.z, r: m.r, ownerId: m.owner }); },
    // A rival spun out on MY milk (they told me): look back and laugh.
    onMilkGloat: () => { if (player) player.gloat(); if (_raceStats) _raceStats.milkTrips++; },
    // A remote player launched a yarn ball: render a cosmetic ghost that homes on
    // OUR copy of the target (our own player if we're the mark, else our ghost of
    // them). The hit stays shooter-authoritative and arrives via onHit.
    onYarn: (y) => {
      const tgt = y.target
        ? (y.target === MP.net.id ? player : (MP.remotes.get(y.target)?.kart ?? null))
        : null;
      items.spawnYarnGhost({ t: y.t, lat: y.lat, speed: y.speed, life: y.life, target: tgt });
    },
    onRemoteFinish: () => {
      // If the results screen is already up, slot the late finisher in live.
      if (state === State.FINISHED) renderResults();
    },
    onStatusTick: () => {
      if (!MP.hud) return;
      // Refresh the readout through the shared status formatter so peers/ping
      // update while connected and the live connection state shows otherwise.
      setMpStatus(MP.net && MP.net.connected ? "connected" : MP.connState || "connecting");
    },
    // Dev-only: capture arriving poses so a real cellular session can be replayed
    // through the netsim harness. Off unless ?rec=1 / the persisted pref is set.
    onNet: (net) => {
      if (!recorderEnabled()) return;
      _netRecorder = new NetRecorder().attach(net);
      if (MP.hud) attachRecBtn(MP.hud);
    },
  },
});

// The recorder + its export chip live outside the session (they're dev UI/DOM).
let _netRecorder = null;
function attachRecBtn(hud) {
  if (hud.querySelector(".rec-btn")) return;
  const btn = document.createElement("span");
  btn.className = "rec-btn";
  btn.textContent = " REC ⬇";
  // The HUD is pointer-events:none so it never eats taps; re-enable just the chip.
  btn.style.cssText = "pointer-events:auto;cursor:pointer;color:#ff9a8a";
  btn.addEventListener("click", () => {
    const ok = _netRecorder && _netRecorder.export();
    btn.textContent = ok ? ` SAVED (${_netRecorder.count})` : " no data yet";
    setTimeout(() => { btn.textContent = " REC ⬇"; }, 1500);
  });
  hud.appendChild(btn);
}

// === Optional race referee (Stage 4; Cloudflare Durable Object) ===============
// Off unless a referee URL is configured (?ref=wss://… or config.REFEREE_URL) —
// with none, `_ref` stays null and every guard below is skipped, so the game is
// byte-for-byte its current self. When it IS configured it runs ALONGSIDE the P2P
// channel: it streams a light lag-comp feed + forwards hit/finish claims, and the
// server's verdicts become authoritative — but ONLY while the socket is actually
// open (`_ref.ready`). A missing/unreachable Worker falls straight back to the
// existing peer-to-peer behaviour, so it can never leave the game worse off.
// Deploy + usage: workers/referee/DEPLOY.md.
let _ref = null;
let _refTried = false;
function maybeStartReferee() {
  if (_ref || _refTried) return;
  if (!(MP.enabled && MP.net && MP.net.id)) return; // wait for our shared id
  _refTried = true;
  if (!refereeEnabled()) return; // no server configured, or turned off in Settings
  _ref = new RefereeClient({
    url: resolveRefereeUrl(),
    room: resolveRefereeRoom(),
    id: MP.net.id,
    name: makeMpIdentity().name || "",
    debug: new URLSearchParams(location.search).has("refdebug"), // ?refdebug=1 → console logs
    // Authoritative verdict: I was struck. Same last-say rules as the P2P path.
    onHit: (target, by, dir) => { if (target === MP.net.id) applyRefVictimSpin(dir); },
    // A finish was ranked by the referee's clock — refresh results if they're up.
    onFinish: () => { if (state === State.FINISHED) renderResults(); },
  });
  _ref.connect();
}
function applyRefVictimSpin(dir) {
  if (!player || state !== State.RACING) return;
  if (player.shielding || player.catnipBoosting) return; // shield/catnip = invincible
  const v = new THREE.Vector3(dir ? dir.x : 0, 0, dir ? dir.z : 0);
  player.spinOut(v.lengthSq() > 0.0001 ? v : null);
}
// A lightweight pose for the referee's lag-comp buffer — it only reads SHIELD (to
// rewind shield state to fire-time) plus position + progress.
function refPose() {
  let f = 0;
  if (player.shielding) f |= FLAG.SHIELD;
  return { t: MP.net.now(), x: player.position.x, z: player.position.z, f, pr: player.totalProgress };
}

// Thin wrappers so the many existing call sites read as before.
function mpPlayerCount() { return MP.playerCount(); }
function mpOrderedIds() { return MP.orderedIds(); }
function mpHostId() { return MP.hostId(); }
function mpIsHost() {
  return !!(MP.enabled && _amHost);
}
function mpGridSlot() { return MP.gridSlot(); }

function mpDebugHud() {
  const el = document.createElement("div");
  el.id = "mp-debug";
  el.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:9999;font:11px/1.4 monospace;" +
    "color:#cdf;background:rgba(10,16,32,.6);padding:3px 7px;border-radius:6px;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

// Peer-to-peer is now the DEFAULT transport (direct hop vs Ably's cloud relay);
// a NAT-blocked peer falls back to Ably automatically, so default-on is safe. You
// can opt OUT (?rtc=0, or Settings → Advanced) to force the Ably relay. The pref
// is tri-state so an explicit choice overrides the default either way.
const RTC_KEY = "zoomies-rtc";
function readRtcPref() {
  try { const v = localStorage.getItem(RTC_KEY); return v === null ? null : (v === "1" ? "on" : "off"); }
  catch { return null; }
}
function rtcEnabled() {
  const q = new URLSearchParams(location.search);
  if (q.get("rtc") === "0") return false;   // explicit link opt-out
  if (q.has("rtc")) return true;            // ?rtc / ?rtc=1 forces on (old links still work)
  return readRtcPref() !== "off";           // unset or "on" → enabled (default)
}

// The optional referee (Stage 4b) follows the SAME shape as the P2P toggle, because
// the phone app can't be switched by a URL: the installed PWA launches with no query
// string and the native app loads capacitor://localhost with an empty location.search
// (see workers/referee/DEPLOY.md). So the referee URL is BAKED into config
// (REFEREE_URL / resolveRefereeUrl) like the Ably key, and this pref is the on/off
// switch. Default ON whenever a URL is configured, unless explicitly turned off.
const REFEREE_KEY = "zoomies-referee";
function readRefereePref() {
  try { const v = localStorage.getItem(REFEREE_KEY); return v === null ? null : (v === "1" ? "on" : "off"); }
  catch { return null; }
}
function refereeEnabled() {
  if (!resolveRefereeUrl()) return false; // no server configured → never on
  return readRefereePref() !== "off";     // unset or "on" → enabled (default)
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
  // ?rtc=1 selects the peer-to-peer transport (pose stream goes P2P over WebRTC;
  // Ably still handles signalling / presence / clock / events). Needs an Ably key
  // for the signalling backbone. Falls back to plain Ably without it.
  const useRtc = ablyKey && rtcEnabled();
  const transportP = useRtc
    ? createWebRTCTransport({ key: ablyKey, room: WORLD_SEED, onState: setMpStatus })
    : ablyKey
      ? createAblyTransport({ key: ablyKey, room: WORLD_SEED, onState: setMpStatus })
      : createPartyTransport({ host, room: WORLD_SEED });
  // The session wires the Net handlers (routing game/DOM reactions back through
  // the hooks defined at construction) and connects once the transport resolves.
  MP.begin(transportP, makeMpIdentity)
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
    // On the P2P transport, always show N/peers direct links so it's obvious
    // whether it upgraded past the Ably fallback: "p2p 1/1" = direct, "p2p 0/1"
    // = still relaying (peer not on P2P, or the network blocked a direct link).
    const rtc = MP.net && MP.net.transport && typeof MP.net.transport.p2pCount === "function";
    const p2pStr = rtc ? ` · p2p ${MP.net.transport.p2pCount()}/${MP.remotes.size}` : "";
    MP.hud.textContent = live
      ? `MP · peers ${MP.remotes.size} · ping ${MP.net ? Math.round(MP.net.clock.rtt) : "—"}ms${p2pStr} · live`
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

// Broadcast my pose (~16 Hz) and interpolate every ghost kart. Runs every frame
// while connected, in any game state, so remote karts glide continuously. The
// real work (send loop, adaptive interp delay, ghost updates, parked reaper)
// lives in MpSession.update — headless, so the netsim harness measures the
// exact code that ships.
function updateMultiplayer(dt) {
  MP.update(dt);
  // Optional referee: connect once we have our shared id, then stream a throttled
  // lag-comp feed while racing. Both are no-ops when no referee is configured.
  maybeStartReferee();
  if (_ref && _ref.ready && player && state === State.RACING) _ref.sendState(refPose());
}

initMultiplayer();

// --- Game state ---
const State = { MENU: 0, COUNTDOWN: 1, RACING: 2, FINISHED: 3, PAUSED: 4, FLYVIEW: 5 };
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
let _fwSide = 0; // which mortar pot fired last (bursts alternate left/right)
const _fwPos = new THREE.Vector3(); // scratch for burst origins (burst copies it)
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
  // Styling hook for the rotated state: touch-action pans are gated in PHYSICAL
  // screen axes, so the menus' scroll permissions must widen while rotated
  // (see the #stage.rotated rules in styles.css).
  stage.classList.toggle("rotated", rot !== 0);

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
    // Returns true when k is a full lock (stop scanning); mutates `state`.
    const check = (k) => {
      if (!k || k === player || k.finished || k.spinTimer > 0) return false;
      _rtFwd.set(Math.sin(k.heading), 0, Math.cos(k.heading));
      _rtTo.subVectors(player.position, k.position);
      const dist = _rtTo.length();
      if (dist < 3 || dist > 50) return false; // out of hairball reach
      const aim = _rtTo.normalize().dot(_rtFwd); // 1 = pointing straight at the player
      if (aim < 0.78) return false; // not aimed at you
      // Ready + dead-on + in solid range = imminent; otherwise just a warning.
      const ready = (k.shootCooldown ?? 0) <= 0.25;
      if (ready && aim > 0.86 && dist < 46) { state = "lock"; return true; }
      state = "warn"; // keep scanning in case another kart is a full lock
      return false;
    };
    let locked = false;
    for (const k of karts) if (check(k)) { locked = true; break; }
    if (!locked && MP.enabled) for (const r of MP.remotes.values()) if (check(r.kart)) break;
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
const _sunDir = new THREE.Vector3(); // stable CACHED sun direction (see updateAtmosphere)
const _sunDirRaw = new THREE.Vector3();
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
// _shTargetExp remembers where fitSunShadow last put the sun target, so an
// external re-anchor (applyMood resets it to the origin) is detected and the
// frustum refitted. NaN guarantees the first frame fits.
const _shTargetExp = new THREE.Vector3(NaN, 0, 0);
const _shCorner = new THREE.Vector3();

// Fit the sun's shadow camera around the WHOLE world (track bounds + the
// scenery strip + head-room for hills/buildings), projected into the light's
// basis, and queue a single shadow-map render. Called once per world/mood.
function fitSunShadow() {
  const cam = sun.shadow.camera;
  // World bounds from the track's sampled points (they carry the hills' y).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const q of track._pts || []) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    if (q.z < minZ) minZ = q.z; if (q.z > maxZ) maxZ = q.z;
  }
  if (!Number.isFinite(minX)) { minX = minZ = -400; maxX = maxZ = 400; minY = 0; maxY = 0; }
  const M = 80; // roadside scenery strip (towns/trees sit within this of the track)
  minX -= M; maxX += M; minZ -= M; maxZ += M;
  minY -= 12; maxY += 45; // below bridges/dips + above buildings/treetops
  // Project the world box's 8 corners into the light basis and fit the ortho
  // bounds exactly around them.
  _shRight.crossVectors(_shUp, _sunDir).normalize();
  _shUpL.crossVectors(_sunDir, _shRight).normalize();
  let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity, f1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    _shCorner.set(i & 1 ? maxX : minX, i & 2 ? maxY : minY, i & 4 ? maxZ : minZ);
    const r = _shCorner.dot(_shRight), u = _shCorner.dot(_shUpL), f = _shCorner.dot(_sunDir);
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (f < f0) f0 = f; if (f > f1) f1 = f;
  }
  sun.target.position
    .set(0, 0, 0)
    .addScaledVector(_shRight, (r0 + r1) / 2)
    .addScaledVector(_shUpL, (u0 + u1) / 2)
    .addScaledVector(_sunDir, (f0 + f1) / 2);
  const halfF = (f1 - f0) / 2;
  sun.position.copy(sun.target.position).addScaledVector(_sunDir, halfF + 60);
  cam.left = -(r1 - r0) / 2;
  cam.right = (r1 - r0) / 2;
  cam.bottom = -(u1 - u0) / 2;
  cam.top = (u1 - u0) / 2;
  cam.near = 40;
  cam.far = halfF * 2 + 100;
  cam.updateProjectionMatrix();
  _shTargetExp.copy(sun.target.position);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
  sun.shadow.needsUpdate = true;
}
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
  // Direction toward the sun. Derived from the light/target positions but
  // CACHED: the shadow fit below repositions both ends using this very
  // direction, and re-deriving through normalize() every frame lets FP rounding
  // random-walk the value. Only accept a genuinely new direction (a mood
  // change, ~degrees), never sub-noise drift.
  _sunDirRaw.copy(sun.position).sub(sun.target.position).normalize();
  const sunDirChanged = _sunDirRaw.distanceToSquared(_sunDir) > 1e-8;
  if (sunDirChanged) _sunDir.copy(_sunDirRaw);

  // Fixed, world-sized shadow frustum, fitted + rendered ONCE per world/mood.
  // A follow frustum — however cleverly snapped or stepped — has a MOVING
  // BOUNDARY, and at sunset the long building/fence shadows crossing it visibly
  // popped in and lurched at every re-centre. Every mapped caster is static
  // scenery (karts use projected quads), so the frustum is instead fitted to
  // the whole track once: the camera and depth map never change during play —
  // nothing can pop, jump, or shimmer, and the shadow pass costs ~zero frames.
  // The trade-off is texel density (the map covers the world, not 170u), which
  // the soft toon look absorbs. Refit triggers: first frame, a mood change
  // (new sun direction), or anything else re-anchoring the target (applyMood
  // resets it to the origin).
  if (sunDirChanged || !sun.target.position.equals(_shTargetExp)) fitSunShadow();

  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const facing = _sunDir.dot(_camFwd);
  // Camera-to-sun angle for the FPS debug readout (0° = looking dead at the sun).
  _sunFaceDeg = Math.acos(Math.max(-1, Math.min(1, facing))) * (180 / Math.PI);
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
  godrayPass.uniforms.uVis.value = vis; // (flarePass is a dead stub — no write)
  // Refresh the shaft target every OTHER frame while the sun shows (soft, low-
  // frequency content — half rate is invisible but halves the worst facing-the-
  // sun cost). Once the sun goes hidden, one last refresh writes the gated black
  // fill and updates stop entirely.
  _shaftFlip = !_shaftFlip;
  if (vis > 0.001) {
    if (_shaftFlip) _shaftTex.textureNeedsUpdate = true;
    _shaftLive = true;
  } else if (_shaftLive) {
    _shaftTex.textureNeedsUpdate = true;
    _shaftLive = false;
  }
  // PERF: both are full-screen shader passes that output the frame unchanged when
  // the sun isn't visible (night, or facing away) — skip them entirely then. Saves
  // two full-frame passes every night frame. fxPass stays last, so the
  // render-to-screen pass is unaffected.
  godrayPass.enabled = vis > 0.001;

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
  let _t = performance.now();
  updateAtmosphere();
  _seg.atmos += performance.now() - _t;
  _t = performance.now();
  composer.render();
  _seg.render += performance.now() - _t;
  if (player && state !== State.MENU) {
    // The minimap is a tiny overview — ~20fps is plenty, and it holds its last draw
    // on the 2D canvas between refreshes, so throttling it sheds per-frame CPU with
    // no visible change.
    _t = performance.now();
    if (_t - _lastMiniDraw >= 50) {
      _lastMiniDraw = _t;
      drawMinimap();
      _seg.minimap += performance.now() - _t;
    }
  }
  // First real frame is on screen — fade out the boot loading screen to reveal it.
  if (!_loadHidden) { _loadHidden = true; hideLoadingScreen(); }
}
let _loadHidden = false;
function hideLoadingScreen() {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.add("done"); // CSS opacity transition
  setTimeout(() => el.remove(), 550);
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
function paintTrackMap(canvas, controlPoints, glyphs = null) {
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
  // Set-piece glyphs at their spots along the loop (menu map only — the
  // editor's draft preview can't know them without building the world).
  if (glyphs && glyphs.length) {
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const g of glyphs) {
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 4;
      ctx.fillText(g.glyph, toX(g.x), toY(g.z));
      ctx.shadowBlur = 0;
    }
  }
}

// The minimap redraws at ~20 Hz, not every frame — dots crawling across a
// 150px map can't show 60 Hz motion, and each redraw is a full canvas clear +
// stroke + per-kart arcs. Glyphs are cached per track (they never move) and each
// kart's CSS colour string is built once, not re-formatted per draw.
let _miniNext = 0;
let _miniGlyphs = null;
function _miniDot(ctx, toX, toY, k) {
  if (!k || !k.position) return;
  const isPlayer = !!k.isPlayer;
  ctx.beginPath();
  ctx.arc(toX(k.position.x), toY(k.position.z), isPlayer ? 5 : 3.5, 0, Math.PI * 2);
  if (k._miniCol === undefined) k._miniCol = "#" + ((k.color ?? 0xffffff) >>> 0).toString(16).padStart(6, "0");
  ctx.fillStyle = k._miniCol;
  ctx.fill();
  if (isPlayer) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
}
function drawMinimap() {
  if (!minimap) return;
  const now = performance.now();
  if (now < _miniNext) return;
  _miniNext = now + 50; // ~20 Hz
  const { ctx, toX, toY, W, H, path } = minimap;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.stroke(path);
  // Set-piece markers so you can see the bridge/tunnel/canyon coming up.
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (!_miniGlyphs) _miniGlyphs = featureGlyphs(track.features);
  for (const g of _miniGlyphs) ctx.fillText(g.glyph, toX(g.x), toY(g.z));
  for (const k of karts) _miniDot(ctx, toX, toY, k);
  if (MP.enabled) for (const r of MP.remotes.values()) _miniDot(ctx, toX, toY, r.kart);
  // Live yarn balls crawl the map from launch — the EARLY information channel
  // (the hard "!" ping only lands in the last second).
  if (items.yarns.length) {
    ctx.fillStyle = "#ffd54f";
    for (const y of items.yarns) {
      ctx.beginPath();
      ctx.arc(toX(y.mesh.position.x), toY(y.mesh.position.z), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Catnip runners get a pulsing halo: everyone can see the surge coming (and
  // knows not to waste a shot on an invincible kart).
  const _cnPulse = 6 + Math.sin(now * 0.014) * 2;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#7CFC66";
  for (const k of karts) {
    if (!k.catnipBoosting || !k.position) continue;
    ctx.beginPath();
    ctx.arc(toX(k.position.x), toY(k.position.z), _cnPulse, 0, Math.PI * 2);
    ctx.stroke();
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
// Three graphics tiers (best device for each in parens):
//   low    — reduced effects + lower resolution + 60fps      (older phones)
//   medium — full effects + resolution + 60fps cap            (newer phones)  ← default
//   high   — full effects + UNCAPPED frame rate (up to 120)   (laptops/desktops)
// medium and high look IDENTICAL; high only unlocks the frame rate (the 60fps cap
// keeps phones cool — see the loop). low is the only tier that dials the visuals back.
const QUALITY_KEY = "zoomies-quality";        // legacy low/high pref — read once to migrate
const QUALITY_KEY_V2 = "zoomies-quality-v2";  // low | medium | high
let quality = "medium"; // full graphics + 60fps: cool AND smooth, the safe default everywhere
try {
  const v2 = localStorage.getItem(QUALITY_KEY_V2);
  if (v2 === "low" || v2 === "medium" || v2 === "high") quality = v2;
  // Migrate an old explicit "Low"; a legacy "high" maps to medium (same look, still
  // capped) so no phone silently jumps to battery-hungry 120fps — you opt into that.
  else if (localStorage.getItem(QUALITY_KEY) === "low") quality = "low";
} catch {}
let renderScale = 1; // dynamic-resolution multiplier on the base pixel ratio (see updateDRS)
function baseDpr() {
  // Low caps the device-pixel-ratio harder — resolution is the biggest lever on
  // both fill cost and render-target memory (which is what tips weak GPUs over).
  return Math.min(window.devicePixelRatio, quality === "low" ? 1.25 : 2); // medium+high = full res
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
  // God-ray shaft target: explicit size (0.42× the drawing buffer) so RTTNode's
  // autoSize path — which stomps .pixelRatio back to the renderer's every frame —
  // never runs. See the note at _shaftTex's creation.
  _shaftTex.pixelRatio = 1;
  _shaftTex.setSize(
    Math.max(1, Math.round(stageState.W * pr * 0.42)),
    Math.max(1, Math.round(stageState.H * pr * 0.42))
  );
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
// Low quality, which sheds god-rays/particles and lowers the render-target
// memory — the kind of sustained pressure that precedes an out-of-memory blank.
// Disabled with ?nowd=1 so the headless perf harness measures the chosen tier.
const _watchdogOn = !new URLSearchParams(location.search).has("nowd");
let _wdAccum = 0;
function perfWatchdog(dt) {
  if (!_watchdogOn || quality === "low") return; // already at the leanest tier — nothing more to shed
  // Only when DRS has already bottomed out AND frames are still long (~30 fps).
  // 40ms (25 fps) never fired in practice: real dips hover in the 25-45 fps
  // band — heavy sunset scenes and a thermally throttling phone both land
  // there — which is exactly when shedding the High-tier effects helps most.
  if (_frameMs > 33 && renderScale <= DRS_MIN + 0.02) {
    _wdAccum += dt;
    if (_wdAccum >= 5) {
      _wdAccum = 0;
      // Step DOWN one tier (session-only, no persist — next launch starts fresh on
      // the saved tier): high → medium first caps the frame rate (halves the frame
      // count) before medium → low sheds the effects.
      applyQuality(quality === "high" ? "medium" : "low", false);
      hud.showToast?.(quality === "low" ? "Graphics lowered for a smoother race" : "Frame rate capped for a smoother race");
    }
  } else {
    _wdAccum = Math.max(0, _wdAccum - dt * 0.6); // recover slowly from brief spikes
  }
}

let _drsOverT = 0; // how long we've been continuously over budget
// Fixed resolution rungs. Every scale change reallocates the WHOLE post chain
// (scene target, bloom mip pyramid, god-ray target) — a hitch each time — and
// on iOS/WebGPU the backend leaks target textures per reallocation (a race of
// ±0.06 yo-yoing climbed renderer.info textures from ~50 to 1100 and dragged
// the whole session down). So changes must be RARE and CHUNKY: a handful of
// rungs, sustained evidence before moving, long cooldowns. A visible res pop
// on a rung change is a far better deal than a resize storm.
const DRS_RUNGS = [1, 0.8, 0.62, DRS_MIN];
let _drsRung = 0; // index into DRS_RUNGS
let _drsUnderT = 0; // how long we've had comfortable headroom (for recovery)

function updateDRS(rawMs, dt) {
  _frameMs += (Math.min(rawMs, 60) - _frameMs) * 0.18; // smoothed frame interval (a touch quicker to react)
  perfWatchdog(dt);
  // While the race veil is up, frames are hidden AND full of one-off turbulence
  // (kart build GC, the 12-angle pipeline prewarm). Acting on that junk dropped
  // a resolution rung during the countdown — a realloc hitch at the start plus
  // a needlessly blurry opening stretch. Freeze rung decisions until it's down.
  if (_veilActive) {
    _drsOverT = 0;
    _drsUnderT = 0;
    _drsCooldown = Math.max(_drsCooldown, 0.5); // and give the first live frames a beat
    return;
  }
  _drsCooldown -= dt;
  if (_drsCooldown > 0) return;
  if (_frameMs > 18.6 && _drsRung < DRS_RUNGS.length - 1) {
    // Only step down after the budget has been blown for a SUSTAINED beat. A
    // transient spike — a jump's brief draw-call burst, a first-use shader
    // compile — recovers on its own.
    _drsUnderT = 0;
    _drsOverT += dt;
    if (_drsOverT < 0.5) return;
    _drsOverT = 0;
    // Genuinely sustained overload drops two rungs in one move.
    _drsRung = Math.min(DRS_RUNGS.length - 1, _drsRung + (_frameMs / 18.6 > 1.5 ? 2 : 1));
    renderScale = DRS_RUNGS[_drsRung];
    applyResolution();
    _drsCooldown = 1.0;
  } else {
    _drsOverT = 0;
    // Recover a rung only after SUSTAINED comfortable headroom — not on the
    // first good window — and with a long cooldown, so the scaler can't
    // oscillate between rungs (each swing is a realloc + hitch). Threshold
    // sits just above the 60Hz vsync floor (~16.7ms): a capped-at-60 device
    // CAN reach it (16.0 was unreachable — the scale ratcheted down and
    // stayed blurry for the rest of the session).
    if (_frameMs < 17.2 && _drsRung > 0) {
      _drsUnderT += dt;
      // 2s sustained + 2s cooldown ≈ up to ~15s from the bottom rung back to
      // full res after a heavy stretch (a sunset race start read as "blurry
      // for 30 seconds" at the previous 3+3 pacing) while still far too slow
      // to oscillate against the 0.5s down-trigger.
      if (_drsUnderT < 2.0) return;
      _drsUnderT = 0;
      _drsRung--;
      renderScale = DRS_RUNGS[_drsRung];
      applyResolution();
      _drsCooldown = 2.0;
    } else if (_frameMs >= 17.2) {
      _drsUnderT = 0;
    }
  }
}
const qualityLowBtn = document.getElementById("set-quality-low");
const qualityHighBtn = document.getElementById("set-quality-high");
// Low quality strips the expensive effects to keep weak devices stable (and is
// what the performance watchdog flips to before a device crashes):
//   • post-FX graph drops the god rays (the heaviest pass),
//   • god-ray render target stops updating,
//   • GPU ambient motes hidden (skips their compute), grass hidden,
//   • lower pixel-ratio cap (applied via layoutStage → baseDpr).
const qualityMedBtn = document.getElementById("set-quality-medium");
function applyQuality(q, persist = true) {
  quality = q;
  const fullFx = q !== "low"; // medium + high get the full effect stack; only low dials it back
  if (persist) { try { localStorage.setItem(QUALITY_KEY_V2, q); } catch {} }
  bloomPass.enabled = true; // marquee glow on every tier
  postProcessing.outputNode = fullFx ? _highOutput : _lowOutput;
  postProcessing.needsUpdate = true; // recompile the node graph for the new composite
  _shaftTex.autoUpdate = fullFx; // don't re-render the god-ray target when it's unused
  if (world.grass) world.grass.visible = fullFx;
  if (gpuParticles) gpuParticles.setVisible(fullFx);
  renderScale = 1; // reset DRS on a manual quality change
  _drsRung = 0; // keep the rung index in sync (updateDRS owns both)
  qualityLowBtn?.classList.toggle("is-active", q === "low");
  qualityMedBtn?.classList.toggle("is-active", q === "medium");
  qualityHighBtn?.classList.toggle("is-active", q === "high");
  layoutStage(); // applies the resolution (frame-rate cap is read live in the loop)
}
qualityLowBtn?.addEventListener("click", () => { _mpWantsHigh = false; applyQuality("low"); });
qualityMedBtn?.addEventListener("click", () => {
  if (MP.enabled) { _mpWantsHigh = true; _mpForcedLow = false; } // opt out of MP's forced-Low this session
  applyQuality("medium");
});
qualityHighBtn?.addEventListener("click", () => {
  if (MP.enabled) { _mpWantsHigh = true; _mpForcedLow = false; }
  applyQuality("high");
});
applyQuality(quality, false); // honour the persisted choice without re-writing it

// Lap count + difficulty live on the Game Mode screen as segmented rows (inside
// the Grand Prix card), replacing the old cycle-tap buttons. Laps persist like
// difficulty does. Applied at race build (buildKarts) + per-frame in aiActions.
const LAPS_KEY = "zoomies-laps";
if (_mpLaps) {
  TOTAL_LAPS = _mpLaps; // multiplayer: use the host's lap count, not this device's saved one
} else {
  try {
    const _l = parseInt(localStorage.getItem(LAPS_KEY), 10);
    if (_l >= 1 && _l <= 5) TOTAL_LAPS = _l;
  } catch {}
}
function refreshRaceOptSegs() {
  document.querySelectorAll("#laps-seg .seg-btn").forEach((b) =>
    b.classList.toggle("is-active", Number(b.dataset.laps) === TOTAL_LAPS));
  document.querySelectorAll("#diff-seg .seg-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.diff === DIFFICULTY));
}
document.querySelectorAll("#laps-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    TOTAL_LAPS = Number(b.dataset.laps);
    try { localStorage.setItem(LAPS_KEY, String(TOTAL_LAPS)); } catch {}
    refreshRaceOptSegs();
  }));
document.querySelectorAll("#diff-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    DIFFICULTY = b.dataset.diff;
    try { localStorage.setItem(DIFF_KEY, DIFFICULTY); } catch {}
    refreshRaceOptSegs();
  }));

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

// --- Track viewer (fly camera) ---------------------------------------------
// A dev/inspection mode entered from the pause menu (revealed by the Advanced
// "Track viewer" setting): the race stays frozen while the camera flies free
// over the world. Touch: one-finger drag looks around, pinch moves along the
// view direction, two-finger drag strafes and rises/descends. Desktop: mouse
// drag looks, wheel moves, WASD + E/Q (Shift = faster) fly.
const flyCatch = document.getElementById("fly-catch");
const flyExitBtn = document.getElementById("fly-exit");
const flyHint = document.getElementById("fly-hint");
const _fly = {
  yaw: 0, pitch: 0,
  pointers: new Map(), // active pointerId → last stage-local {x, y}
  keys: new Set(),
  fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
  // Two-finger baseline (centroid / separation / finger-pair angle). The whole
  // gesture is decomposed against these in ONE place per event, so pan, pinch
  // and twist compose instead of fighting (the old code let each finger apply
  // its own half-pan AND re-applied the pinch per event — zooming lurched).
  cx: 0, cy: 0, dist: 0, ang: 0,
  // Ground anchor under the pinch centroid, solved once per gesture: pan maps
  // finger pixels to world units 1:1 at this depth (the map sticks to your
  // fingers), pinch zooms toward it, twist orbits around it.
  focal: new THREE.Vector3(), focalDist: 80, focalRay: new THREE.Vector3(),
  // Release inertia: look (rad/s) and pan (world units/s), damped per frame.
  lookVX: 0, lookVY: 0, panV: new THREE.Vector3(),
  tPrev: 0, // last gesture event timeStamp (ms) for velocity estimates
};
function _flyBasis() {
  const cp = Math.cos(_fly.pitch);
  _fly.fwd.set(Math.sin(_fly.yaw) * cp, Math.sin(_fly.pitch), Math.cos(_fly.yaw) * cp);
  _fly.right.crossVectors(_fly.fwd, UP_Y).normalize(); // screen-right in world space
}
// Movement scales with height above the terrain, so skimming the road is
// precise and surveying from high up covers ground quickly.
function _flySpeedScale() {
  const g = track?.groundInfo?.(camera.position.x, camera.position.z)?.y ?? 0;
  return Math.min(8, Math.max(0.5, (camera.position.y - g) * 0.06 + 0.4));
}
function _flyClamp() {
  const p = camera.position;
  const r = Math.hypot(p.x, p.z);
  if (r > 1500) { p.x *= 1500 / r; p.z *= 1500 / r; } // stay over the world
  const g = track?.groundInfo?.(p.x, p.z)?.y ?? 0;
  p.y = Math.min(600, Math.max(g + 1.2, p.y));
}
function enterFlyView() {
  if (state !== State.PAUSED) return;
  state = State.FLYVIEW;
  pauseOverlay.classList.add("hidden");
  document.getElementById("hud").classList.add("hidden");
  for (const el of [flyCatch, flyExitBtn, flyHint]) el?.classList.remove("hidden");
  flyHint?.classList.remove("faded");
  setTimeout(() => flyHint?.classList.add("faded"), 4000);
  // Take off from the current chase-camera pose, looking the same way.
  const dir = camera.getWorldDirection(new THREE.Vector3());
  _fly.yaw = Math.atan2(dir.x, dir.z);
  _fly.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  _fly.pointers.clear();
  _fly.keys.clear();
  _fly.lookVX = _fly.lookVY = 0;
  _fly.panV.set(0, 0, 0);
}
function exitFlyView() {
  if (state !== State.FLYVIEW) return;
  hideFlyUI();
  document.getElementById("hud").classList.remove("hidden");
  updateCamera(0.016, true); // snap the chase camera back onto the kart
  state = State.PAUSED;
  pauseOverlay.classList.remove("hidden");
}
function hideFlyUI() {
  for (const el of [flyCatch, flyExitBtn, flyHint]) el?.classList.add("hidden");
  _fly.pointers.clear();
  _fly.keys.clear();
}
flyExitBtn?.addEventListener("click", exitFlyView);
document.getElementById("trackview-btn")?.addEventListener("click", enterFlyView);

// All gesture positions go through stageToLocal: on phones the stage is
// ROTATED for the landscape lock, so raw clientX/Y deltas had swapped or
// mirrored axes in portrait — the biggest "mobile feels wrong" bug here.
const _flyPt = (e) => stageToLocal(e.clientX, e.clientY);
// Current two-finger state: centroid, separation, and finger-pair angle.
function _flyTwoState() {
  const [a, b] = [..._fly.pointers.values()];
  return {
    cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
    dist: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)), // floor: churning tiny pinches can't explode the ratio
    ang: Math.atan2(b.y - a.y, b.x - a.x),
  };
}
// World-space ray through a stage point. Refresh the camera's matrixWorld
// first: gesture events land BETWEEN frames, and once this event (or an
// earlier one this frame) has moved the camera, unprojecting through the
// stale matrix produces a direction dominated by that movement — this was
// the pinch-zoom "kick". Used at gesture start and for the wheel; live pinch
// zoom steers by the tracked anchor instead (see the move handler).
function _flyStageRay(sx, sy, out) {
  camera.updateMatrixWorld();
  return out
    .set((sx / stageState.W) * 2 - 1, -(sy / stageState.H) * 2 + 1, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize();
}
// Anchor the gesture: march the centroid ray to the terrain (coarse steps —
// it's a gesture anchor, not a collision). Solved ONCE per two-finger gesture,
// so the ~50 terrain samples never run per move event. Sky shots (no hit) get
// a fixed mid-distance anchor, which keeps pan/zoom speeds sane.
function _flySolveFocal(sx, sy) {
  const r = _flyStageRay(sx, sy, _fly.focalRay);
  let dist = 0;
  for (let t = 6; t <= 520; t += t < 120 ? 6 : 16) {
    const x = camera.position.x + r.x * t, y = camera.position.y + r.y * t, z = camera.position.z + r.z * t;
    if (y <= (world?.heightAt?.(x, z) ?? 0)) { dist = t; break; }
  }
  _fly.focalDist = Math.min(500, Math.max(4, dist || 160));
  _fly.focal.copy(camera.position).addScaledVector(r, _fly.focalDist);
}
function _flyRebaseTwo(ts) {
  Object.assign(_fly, _flyTwoState());
  _flySolveFocal(_fly.cx, _fly.cy);
  _fly.tPrev = ts;
}
flyCatch?.addEventListener("pointerdown", (e) => {
  // Capture can throw for a pointer that's already gone (fast cancel races,
  // synthetic events) — losing capture just means a finger that slides off
  // the layer stops tracking, never a broken gesture.
  try { flyCatch.setPointerCapture(e.pointerId); } catch { /* keep going */ }
  const q = _flyPt(e);
  _fly.pointers.set(e.pointerId, { x: q.x, y: q.y });
  // A fresh touch grabs the world: any glide-out stops dead (map-app feel).
  _fly.lookVX = _fly.lookVY = 0;
  _fly.panV.set(0, 0, 0);
  _fly.tPrev = e.timeStamp;
  if (_fly.pointers.size === 2) _flyRebaseTwo(e.timeStamp);
});
flyCatch?.addEventListener("pointermove", (e) => {
  const p = _fly.pointers.get(e.pointerId);
  if (!p || state !== State.FLYVIEW) return;
  const q = _flyPt(e);
  const dx = q.x - p.x, dy = q.y - p.y;
  p.x = q.x; p.y = q.y;
  const dtEv = Math.min(0.05, Math.max(0.004, (e.timeStamp - _fly.tPrev) / 1000));
  _flyBasis();
  if (_fly.pointers.size === 1) {
    // Look: drag right looks right, drag up looks up — with a release flick.
    const dyaw = -dx * 0.0042, dpitch = -dy * 0.0032;
    _fly.yaw += dyaw;
    _fly.pitch = Math.max(-1.35, Math.min(1.35, _fly.pitch + dpitch));
    _fly.lookVX = _fly.lookVX * 0.6 + (dyaw / dtEv) * 0.4;
    _fly.lookVY = _fly.lookVY * 0.6 + (dpitch / dtEv) * 0.4;
    _fly.tPrev = e.timeStamp;
  } else if (_fly.pointers.size === 2) {
    // Decompose the PAIR once: pan from the centroid, zoom from the
    // separation, rotation from the finger-pair angle — all anchored to the
    // ground point solved at gesture start.
    const s = _flyTwoState();
    const startX = camera.position.x, startY = camera.position.y, startZ = camera.position.z;
    // Pan: world units per stage pixel at the anchor depth, so the terrain
    // under your fingers tracks them 1:1 (drag right → the world comes with
    // you). 0.6018 = 2·tan(62°/2 · vertical fov).
    const pxToWorld = (1.2036 * _fly.focalDist) / stageState.H;
    _fly.up.crossVectors(_fly.right, _fly.fwd); // screen-up in world space
    camera.position.addScaledVector(_fly.right, -(s.cx - _fly.cx) * pxToWorld);
    camera.position.addScaledVector(_fly.up, (s.cy - _fly.cy) * pxToWorld);
    _fly.focal.addScaledVector(_fly.right, -(s.cx - _fly.cx) * pxToWorld);
    _fly.focal.addScaledVector(_fly.up, (s.cy - _fly.cy) * pxToWorld);
    // Pinch: zoom toward/away from the anchor itself (not the view centre),
    // exactly cancelling the separation ratio — spread 2× and the ground
    // around the pinch reads 2× bigger. The zoom axis is the LIVE camera→
    // anchor vector (the pan above drags the anchor with it, so the axis is
    // always consistent — no unprojection through between-frame matrices).
    // The applied step derives from the CLAMPED distance, so at the floor the
    // camera stops dead at the anchor instead of tunnelling into the ground.
    const ratio = Math.min(1.6, Math.max(0.6, s.dist / _fly.dist)); // event-burst spike guard
    const newFocalDist = Math.min(900, Math.max(3, _fly.focalDist / ratio));
    const zoomStep = _fly.focalDist - newFocalDist;
    if (zoomStep !== 0) {
      _fly.focalRay.copy(_fly.focal).sub(camera.position).normalize();
      camera.position.addScaledVector(_fly.focalRay, zoomStep);
      _fly.focalDist = newFocalDist;
    }
    // Twist: rotate the MAP under your fingers — yaw the view and orbit the
    // camera about the anchor by the same angle, so the anchor stays put on
    // screen. (Stage y is down, so a visually-CCW twist is a negative delta.)
    let da = s.ang - _fly.ang;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const th = -da, c = Math.cos(th), sn = Math.sin(th);
    const ox = camera.position.x - _fly.focal.x, oz = camera.position.z - _fly.focal.z;
    camera.position.x = _fly.focal.x + ox * c + oz * sn;
    camera.position.z = _fly.focal.z - ox * sn + oz * c;
    _fly.yaw += th;
    _flyClamp();
    // Pan glide velocity from how the camera actually moved this event.
    _fly.panV.x = _fly.panV.x * 0.6 + ((camera.position.x - startX) / dtEv) * 0.4;
    _fly.panV.y = _fly.panV.y * 0.6 + ((camera.position.y - startY) / dtEv) * 0.4;
    _fly.panV.z = _fly.panV.z * 0.6 + ((camera.position.z - startZ) / dtEv) * 0.4;
    _fly.cx = s.cx; _fly.cy = s.cy; _fly.dist = s.dist; _fly.ang = s.ang;
    _fly.tPrev = e.timeStamp;
  }
});
const _flyEndPointer = (e) => {
  const wasTwo = _fly.pointers.size === 2;
  _fly.pointers.delete(e.pointerId);
  if (wasTwo && _fly.pointers.size === 1) {
    // Pinch → single finger: the survivor becomes a fresh LOOK gesture; a
    // stale pan-glide from the pinch would yank the camera out from under it.
    _fly.panV.set(0, 0, 0);
    _fly.lookVX = _fly.lookVY = 0;
    _fly.tPrev = e.timeStamp;
  } else if (_fly.pointers.size === 2) {
    // 3+ fingers (a resting palm) dropping back to two: fresh baselines, or
    // the pair state from before the extra finger landed makes the view jump.
    _flyRebaseTwo(e.timeStamp);
  }
  // Last finger up: leave lookV/panV as-is — updateFlyCamera glides them out.
};
flyCatch?.addEventListener("pointerup", _flyEndPointer);
flyCatch?.addEventListener("pointercancel", _flyEndPointer);
flyCatch?.addEventListener("wheel", (e) => {
  if (state !== State.FLYVIEW) return;
  e.preventDefault();
  // Zoom along the ray under the CURSOR (map-style), not the view centre.
  const q = stageToLocal(e.clientX, e.clientY);
  camera.position.addScaledVector(
    _flyStageRay(q.x, q.y, _fly.focalRay),
    -e.deltaY * 0.05 * _flySpeedScale()
  );
  _flyClamp();
}, { passive: false });
window.addEventListener("keydown", (e) => { if (state === State.FLYVIEW) _fly.keys.add(e.code); });
window.addEventListener("keyup", (e) => { _fly.keys.delete(e.code); });

// Per-frame flight (keyboard movement + aiming). Touch moves the camera in the
// event handlers above; this applies held keys, glides out any release
// momentum, and points the camera.
function updateFlyCamera(dt) {
  // Touch inertia: after the last finger lifts, the look flick and the pan
  // carry on and ease out (exponential damp ≈ a map app's glide). Grabbing
  // the screen again zeroes these instantly (see pointerdown).
  if (_fly.pointers.size === 0) {
    // Sanity caps: a wild flick glides briskly, it doesn't launch the camera.
    _fly.lookVX = Math.max(-3, Math.min(3, _fly.lookVX));
    _fly.lookVY = Math.max(-3, Math.min(3, _fly.lookVY));
    if (_fly.panV.lengthSq() > 320 * 320) _fly.panV.setLength(320);
    const speed = Math.abs(_fly.lookVX) + Math.abs(_fly.lookVY) + _fly.panV.length();
    if (speed > 0.01) {
      _fly.yaw += _fly.lookVX * dt;
      _fly.pitch = Math.max(-1.35, Math.min(1.35, _fly.pitch + _fly.lookVY * dt));
      camera.position.addScaledVector(_fly.panV, dt);
      _flyClamp();
      const damp = Math.exp(-3.6 * dt);
      _fly.lookVX *= damp;
      _fly.lookVY *= damp;
      _fly.panV.multiplyScalar(damp);
    }
  }
  _flyBasis();
  const K = _fly.keys;
  const boost = K.has("ShiftLeft") || K.has("ShiftRight") ? 3 : 1;
  const move = 55 * boost * _flySpeedScale() * dt;
  if (K.has("KeyW")) camera.position.addScaledVector(_fly.fwd, move);
  if (K.has("KeyS")) camera.position.addScaledVector(_fly.fwd, -move);
  if (K.has("KeyA")) camera.position.addScaledVector(_fly.right, -move);
  if (K.has("KeyD")) camera.position.addScaledVector(_fly.right, move);
  if (K.has("KeyE") || K.has("Space")) camera.position.y += move;
  if (K.has("KeyQ")) camera.position.y -= move;
  const turn = 1.6 * dt;
  if (K.has("ArrowLeft")) _fly.yaw += turn;
  if (K.has("ArrowRight")) _fly.yaw -= turn;
  if (K.has("ArrowUp")) _fly.pitch = Math.min(1.35, _fly.pitch + turn * 0.7);
  if (K.has("ArrowDown")) _fly.pitch = Math.max(-1.35, _fly.pitch - turn * 0.7);
  _flyClamp();
  _flyBasis();
  camera.lookAt(
    camera.position.x + _fly.fwd.x,
    camera.position.y + _fly.fwd.y,
    camera.position.z + _fly.fwd.z
  );
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
  hideFlyUI(); // safety: never leave the fly-cam chrome up over the menu
  _raceParked = (state === State.PAUSED || state === State.RACING) && !!player && !player.finished && !MP.enabled;
  pauseOverlay.classList.add("hidden");
  document.getElementById("hud").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("menu").classList.remove("hidden");
  flowGo("title", -1, true); // land on the flow's front door, no slide
  audio.stopEngine();
  audio.setSkid(false);
  audio.playMusic("bg");
  MP.inLobby = false;
  MP.startAt = 0;
  state = State.MENU;
  hideRaceVeil(); // safety: never leave the race cover up over the menu
  refreshResumeBtn();
  // Leaving to the menu abandons an in-progress cup / daily run: clear the run
  // state and strip its URL params so START begins an ordinary race.
  clearCupRun();
  try {
    const u = new URL(location.href);
    if (u.searchParams.has("cup") || u.searchParams.has("daily")) {
      u.searchParams.delete("cup");
      u.searchParams.delete("daily");
      history.replaceState(null, "", u);
    }
  } catch { /* ignore */ }
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
// (The lobby's Back arrow goes through the flow's shared back handling.)
// Badges block the exit: leaving the results for the menu detours through the
// claim interstitial whenever any badge is still unclaimed (it no-ops straight
// to the menu when there's nothing to claim).
document.getElementById("results-menu-btn")?.addEventListener("click", () => showClaimScreen(toMenu));

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
  // One sheet at a time: opening a new one dismisses whichever is up (e.g.
  // the chrome gear tapped while the Cat-alog is open) instead of stacking.
  for (const id of CHROME_SCREENS) {
    const o = document.getElementById(id);
    if (o && o !== el && !o.classList.contains("hidden")) o.classList.add("hidden");
  }
  // Note: when neither the menu nor the pause screen is visible (e.g. the
  // settings gear opened over the garage), KEEP the stored return target —
  // clearing it would strand the player on an empty backdrop once the
  // underlying screen closes.
  for (const id of ["menu", "pause-overlay"]) {
    const o = document.getElementById(id);
    if (o && !o.classList.contains("hidden")) {
      _overlayReturn = o;
      o.classList.add("hidden");
      break;
    }
  }
  el.classList.remove("hidden");
  uiCue("bloom"); // reveal
}
function closeSubScreen(el) {
  el.classList.add("hidden");
  if (_overlayReturn) {
    _overlayReturn.classList.remove("hidden");
    _overlayReturn = null;
  }
  uiCue("droplet"); // dismiss
}

// Annotate the static menu DOM for cuelume: every overlay button gets the
// tactile press/release pair + a desktop hover tick; segmented buttons get the
// mechanical toggle instead. Dynamic elements (prize tiles, claim cards) speak
// through imperative outcome cues, so they need no attributes.
function cueifyButton(el) {
  if (el.classList.contains("seg-btn")) { el.dataset.cuelumeToggle = ""; return; }
  el.dataset.cuelumePress = "";
  el.dataset.cuelumeRelease = "";
  el.dataset.cuelumeHover = "tick";
}
function wireMenuCues() {
  for (const el of document.querySelectorAll(".overlay button, #menu button")) cueifyButton(el);
  bindUiCues();
  setUiCuesEnabled(audio.sfxOn);
}
wireMenuCues();

// --- Persistent menu chrome: 🐟 balance + ⚙ gear over every sub-screen. ---
// Visible whenever a menu sub-screen is up (the hub keeps its own buttons for
// now); hidden during racing and the results/claim flow. A MutationObserver
// watches the screens' class flips, so no open/close path needs to know about
// the chrome.
const CHROME_SCREENS = ["catalog", "track-panel", "settings", "howto", "install-help"];
const menuChrome = document.getElementById("menu-chrome");
function refreshMenuChrome() {
  if (!menuChrome) return;
  const sheetOpen = CHROME_SCREENS.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
  // Ride over every flow step past the title (the title keeps its own extras
  // row) — but stand down while a sheet is up: its header owns the top bar
  // (just the ✕, plus the Cat-alog's own balance chip).
  const menuEl = document.getElementById("menu");
  const flowOpen = menuEl && !menuEl.classList.contains("hidden") && menuEl.dataset.step !== "title";
  menuChrome.classList.toggle("hidden", sheetOpen || !flowOpen);
  const n = document.getElementById("chrome-treats-n");
  if (n) n.textContent = String(profile.treats);
}
{
  const mo = new MutationObserver(refreshMenuChrome);
  for (const id of CHROME_SCREENS.concat("menu")) {
    const el = document.getElementById(id);
    if (el) mo.observe(el, { attributes: true, attributeFilter: ["class", "data-step"] });
  }
}
document.getElementById("chrome-gear")?.addEventListener("click", () => {
  if (!settingsOverlay.classList.contains("hidden")) return; // already showing
  openSettings();
});
document.getElementById("chrome-treats")?.addEventListener("click", () => {
  const cat = document.getElementById("catalog");
  if (!cat || !cat.classList.contains("hidden")) return; // already showing
  // In the lobby the chip is display-only (jumping screens mid-connection
  // would abandon the room).
  if (MP.inLobby) return;
  renderCatalog();
  openSubScreen(cat);
});

// Esc closes the topmost menu sub-screen through its own non-destructive exit
// (the same button a tap would use), one screen per press. Ordered by stacking:
// settings/help float over catalog, which floats over the config panels.
const ESC_EXITS = [
  ["settings", "settings-back"], ["howto", "howto-back"], ["install-help", "install-help-back"],
  ["catalog", "catalog-back"], ["track-panel", "track-back"],
];
function escCloseTopScreen() {
  for (const [scr, btn] of ESC_EXITS) {
    const el = document.getElementById(scr);
    if (el && !el.classList.contains("hidden")) {
      document.getElementById(btn)?.click();
      return true;
    }
  }
  return false;
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

// --- Track viewer setting (Advanced; persisted) ---
// Gates the pause menu's TRACK VIEWER button (see enterFlyView above).
const TRACKVIEW_KEY = "zoomies-trackview";
const trackviewToggle = document.getElementById("set-trackview-toggle");
let trackviewOn = false;
try { trackviewOn = localStorage.getItem(TRACKVIEW_KEY) === "1"; } catch {}
function applyTrackviewSetting() {
  document.getElementById("trackview-btn")?.classList.toggle("hidden", !trackviewOn);
  if (trackviewToggle) {
    trackviewToggle.textContent = trackviewOn ? "On" : "Off";
    trackviewToggle.classList.toggle("off", !trackviewOn);
  }
}
trackviewToggle?.addEventListener("click", () => {
  trackviewOn = !trackviewOn;
  try { localStorage.setItem(TRACKVIEW_KEY, trackviewOn ? "1" : "0"); } catch {}
  applyTrackviewSetting();
});
applyTrackviewSetting();

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
  markReload("backend-switch");
  const u = new URL(location.href);
  u.searchParams.delete("webgl");
  u.searchParams.delete("webgpu");
  location.replace(u.toString());
});
applyCompatUI();

// Peer-to-peer multiplayer toggle UI (the flag helpers live up near initMultiplayer,
// which reads them at connect time).
const rtcToggle = document.getElementById("set-rtc-toggle");
function applyRtcUI() {
  const on = rtcEnabled();
  if (rtcToggle) {
    rtcToggle.textContent = on ? "On" : "Off";
    rtcToggle.classList.toggle("off", !on);
  }
}
rtcToggle?.addEventListener("click", () => {
  // Persist an EXPLICIT choice ("1"/"0") so it overrides the default-on either way.
  const on = !rtcEnabled();
  try { localStorage.setItem(RTC_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  applyRtcUI();
});
applyRtcUI();

// Referee toggle (Stage 4b) — same shape as the P2P toggle. When no referee URL is
// configured it reads a disabled "Not set" so it's clear you must deploy + bake the
// URL into config first (workers/referee/DEPLOY.md).
const refereeToggle = document.getElementById("set-referee-toggle");
function applyRefereeUI() {
  if (!refereeToggle) return;
  const hasUrl = !!resolveRefereeUrl();
  const on = refereeEnabled();
  refereeToggle.textContent = !hasUrl ? "Not set" : on ? "On" : "Off";
  refereeToggle.classList.toggle("off", !on);
  refereeToggle.disabled = !hasUrl;
}
refereeToggle?.addEventListener("click", () => {
  if (!resolveRefereeUrl()) return; // nothing to enable until a server is configured
  const on = !refereeEnabled();
  try { localStorage.setItem(REFEREE_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  applyRefereeUI();
});
applyRefereeUI();

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
    const body = document.querySelector("#settings .flow-body");
    setTimeout(() => { if (body) body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }); }, 60);
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
let _sunFaceDeg = 0; // camera-to-sun angle (set each frame in updateAtmosphere)
function updateFpsCounter(dt) {
  if (!showFps || !fpsEl) return;
  _fpsAccum += dt;
  if (_fpsAccum < 0.2) return; // ~5 Hz so the number is readable, not a blur
  _fpsAccum = 0;
  const fps = Math.round(1000 / Math.max(1, _frameMs));
  const backend = renderer?.backend?.isWebGPUBackend ? "WGPU" : "WGL2";
  const dc = renderer?.info?.render?.drawCalls ?? 0;
  // sun N° — angle between the camera's view direction and the sun (0° = staring
  // straight into it). For correlating frame dips with view direction: if dips
  // track a low angle, the cost is the sun-facing path (god rays / glow / bloom);
  // if they track a specific WORLD direction regardless of the sun, it's geometry
  // (draw calls — watch dc) in that part of the map.
  // NNx = dynamic-resolution scale (1.0 = full res; at 0.45 the scaler has
  // bottomed out) + quality tier H/L. Together they say what a dip means: a dip
  // at 1.0x is a transient the scaler hasn't reacted to; a dip AT 0.45x means
  // pixel scaling can't help (vertex/CPU-bound — or the phone is thermally
  // throttling, which looks exactly like this after minutes of sustained load).
  const rs = renderScale.toFixed(2).replace(/0$/, "");
  fpsEl.textContent = `${fps} FPS · ${backend} · ${dc}dc · sun ${Math.round(_sunFaceDeg)}° · ${rs}x ${quality[0].toUpperCase()}`;
  fpsEl.classList.toggle("warn", fps < 50 && fps >= 35);
  fpsEl.classList.toggle("bad", fps < 35);
}

// --- Periodic perf summary (console) ---
// One compact line every 5 s so a device session (Xcode console, Safari remote
// inspector) leaves an analyzable frame-time record without the on-screen
// counter — which can't be read mid-race while both hands are steering.
// Percentiles come from raw per-frame intervals: the smoothed _frameMs hides
// exactly the dips that matter. "58 avg · 1% low 31" means "smooth but hitching
// about once a second" — a shape the average alone conceals.
const _perfFrames = [];
let _perfElapsed = 0;
// Track when visibility last changed: a >500ms frame right after returning
// from the background is a resume gap (ignore); anywhere else it's a genuine
// freeze the player felt, and it must be REPORTED, not silently dropped.
let _lastVisChange = 0;
document.addEventListener("visibilitychange", () => { _lastVisChange = performance.now(); });
// When the last GO fired. The residual "first race of the session" hitch lands
// in the first seconds of racing and is shorter than the normal FREEZE bar, so
// frames in a short window after GO report at a much lower threshold.
let _goAt = 0;
// GPU object-creation counters for freeze attribution (patched over the WebGPU
// device once the renderer is up; stays 0 on the WebGL2 fallback).
let _gpuCreates = 0;
let _gpuCreatesLast = 0;
// Per-frame segment timers: which part of the frame ate the time. Read by the
// FREEZE report at the TOP of the next loop pass (they describe the frame that
// rawMs measured), then reset for the new pass. renderFrame segments
// accumulate — menu dissolves render twice per pass.
const _seg = { render: 0, atmos: 0, minimap: 0, world: 0 };

// Draw-everything warm pass. iOS compiles Metal shaders lazily at each
// pipeline's FIRST DRAW (creation at boot returns immediately) — so every part
// of the world froze the game ~0.5-1.5s the first time it entered the camera's
// view (menu shots panning, racing into new areas): FREEZE lines showed 0
// pipeline creates. For the first frames after renderer init, disable frustum
// culling so EVERY object draws and takes its compile hit while the splash
// still covers the screen.
let _warmAllFrames = 0;
const _warmAllTouched = [];
let _warmAllDone = null; // runs once when the pass retires
function beginWarmAll(frames, done = null) {
  _warmAllFrames = Math.max(_warmAllFrames, frames);
  if (done) _warmAllDone = done;
}
function warmAllStep() {
  if (_warmAllFrames <= 0) return;
  if (_warmAllTouched.length === 0) {
    scene.traverse((o) => {
      if ((o.isMesh || o.isPoints || o.isLine) && o.frustumCulled && o.visible) {
        o.frustumCulled = false;
        _warmAllTouched.push(o);
      }
    });
  }
  if (--_warmAllFrames === 0) {
    for (const o of _warmAllTouched) o.frustumCulled = true;
    _warmAllTouched.length = 0;
    const done = _warmAllDone;
    _warmAllDone = null;
    done?.();
  }
}

// Build a throwaway kart from the SAVED garage pick, park it far underground,
// draw it for a few frames, then dispose. Compiles the kart/cat/toon pipeline
// family off-screen; browsing to a different pattern/accessory still compiles
// that variant on click, but the reported first-open pause uses the saved pick.
let _kartWarm = null;
function warmGarageKart() {
  if (_kartWarm || state === State.RACING) return;
  try {
    const cat = catSpec(garageConfig);
    const kart = kartSpec(garageConfig);
    const wk = new Kart({ color: kart.color, catColor: cat.fur, catPattern: cat.pattern, catAccessory: cat.accessory, catAccessoryColor: cat.accessoryColor, kartStyle: kart.style, kartNumber: kart.number, name: "warm", isPlayer: false, skill: 1 });
    wk.group.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
      if (o.isMesh) o.frustumCulled = false;
    });
    // Draw the (normally hidden) boost flames too, at a speck of a scale: their
    // additive pipeline otherwise compiles at the FIRST boost — which is usually
    // the first drift release seconds after GO, i.e. a mid-race hitch.
    if (wk.flames) {
      wk.flames.visible = true;
      wk.flames.scale.setScalar(0.001);
    }
    toonify(wk.group);
    wk.group.position.set(0, -60, 0);
    scene.add(wk.group);
    _kartWarm = { group: wk.group, frames: 3 };
  } catch { /* warm-up only — never let it break the menu */ }
}
function warmKartStep() {
  if (!_kartWarm) return;
  if (--_kartWarm.frames <= 0) {
    scene.remove(_kartWarm.group);
    _disposeGroup(_kartWarm.group); // shared (cached) materials are skipped by disposeGroup
    _kartWarm = null;
    warmRosterGeometries(); // then pre-bake the AI roster while the menu idles
  }
}

// Pre-bake the AI roster's merged geometries + shared materials/coat textures at
// menu idle (one kart per tick, so the menu never hitches). The merge cache is
// keyed by style/pattern, so the first race's buildKarts becomes cache hits
// instead of six cold merges — the biggest slice of the old START-tap stall.
// Everything cached is flagged shared and survives the throwaway disposal.
let _rosterWarmed = false;
function warmRosterGeometries() {
  if (_rosterWarmed) return;
  _rosterWarmed = true;
  const roster = raceRoster().filter((c) => !c.isPlayer);
  let i = 0;
  const step = () => {
    if (i >= roster.length || state !== State.MENU) return;
    const cfg = roster[i++];
    try {
      const { group } = createKartModel(cfg.color, { style: cfg.kartStyle, number: cfg.kartNumber });
      const cat = createCat(cfg.catColor, { pattern: cfg.catPattern });
      _disposeGroup(group);
      _disposeGroup(cat);
    } catch { /* warm-up only */ }
    setTimeout(step, 150);
  };
  setTimeout(step, 400);
}
function logPerfSummary(rawMs) {
  // Right after GO, report at a much lower bar: the felt "stall at the start
  // of the first race" is a sub-250ms frame the normal threshold never logs.
  const sinceGo = _goAt ? performance.now() - _goAt : Infinity;
  if (rawMs > (sinceGo < 6000 ? 100 : 250)) {
    // Background gaps: the app-state/visibility timestamp is the primary
    // signal, but iOS can run the gap frame BEFORE delivering those events on
    // return — so also treat a huge gap with no compile activity as a resume,
    // not a freeze (a real >3s stall without shader creates has never occurred
    // outside backgrounding).
    const fromBackground =
      performance.now() - _lastVisChange < 1500 ||
      (rawMs > 3000 && _gpuCreates - _gpuCreatesLast < 3);
    if (!fromBackground) {
      const phase = state === State.RACING ? "race" : state === State.PAUSED ? "pause" : "menu";
      // Attribution: how many GPU pipeline/shader objects were created since
      // the last report (see the device patch at renderer init), plus live
      // geometry/texture counts. A freeze with creates>0 is shader compilation;
      // creates=0 with a texture jump is an upload; neither points at GC/CPU.
      const creates = _gpuCreates - _gpuCreatesLast;
      _gpuCreatesLast = _gpuCreates;
      const mem = renderer?.info?.memory;
      const other = Math.max(0, rawMs - _seg.render - _seg.atmos - _seg.minimap - _seg.world);
      console.warn(
        `[zoomies] FREEZE: one frame took ${Math.round(rawMs)}ms (${phase}, ${renderer?.backend?.isWebGPUBackend ? "WGPU" : "WGL2"}) · ${creates} shader/pipeline creates · geo ${mem?.geometries ?? "?"} tex ${mem?.textures ?? "?"} · render ${Math.round(_seg.render)} · atmos ${Math.round(_seg.atmos)} · minimap ${Math.round(_seg.minimap)} · world ${Math.round(_seg.world)} · other ${Math.round(other)}ms` +
          (sinceGo < 6000 ? ` · +${Math.round(sinceGo)}ms after GO` : "")
      );
    }
    return; // either way, keep it out of the percentile stats
  }
  _perfFrames.push(rawMs);
  _perfElapsed += rawMs;
  if (_perfElapsed < 5000) return;
  const n = _perfFrames.length;
  _perfFrames.sort((a, b) => a - b);
  const avgMs = _perfElapsed / n;
  const p99 = _perfFrames[Math.min(n - 1, Math.floor(n * 0.99))];
  const worst = _perfFrames[n - 1];
  const backend = renderer?.backend?.isWebGPUBackend ? "WGPU" : "WGL2";
  const dc = renderer?.info?.render?.drawCalls ?? 0;
  const phase = state === State.RACING ? "race" : state === State.PAUSED ? "pause" : "menu";
  console.log(
    `[zoomies] perf ${phase}: avg ${Math.round(1000 / avgMs)} fps · 1% low ${Math.round(1000 / p99)} · worst ${Math.round(worst)}ms · ${dc}dc · ${renderScale.toFixed(2)}x ${quality[0].toUpperCase()} · ${backend}`
  );
  _perfFrames.length = 0;
  _perfElapsed = 0;
}

// --- Haptic race feel ---------------------------------------------------
// A handful of DISCRETE race moments, never continuous rumble — haptics read
// as premium when they're rare and meaningful, and as noise when everything
// buzzes. All haptic policy lives in this one function: tune thresholds and
// styles here. Real taptics on iOS via the platform seam; on the web this
// maps to navigator.vibrate where it exists (Android Chrome) and is silent
// elsewhere. Player only — AI and remote karts never buzz the hand.
let _platformA = null;
// "Their audio wins": if the player already had music/a podcast rolling at app
// launch (native snapshots this before any game JS runs; web always says no),
// keep the game's music silent for this session — SFX still play. Flipping
// music ON in Settings overrides it. Exposed as a promise so the boot-time
// autoplay can wait for the verdict instead of starting-then-aborting a track.
const _audioPolicyReady = getPlatform().then(async (p) => {
  _platformA = p;
  // Native app-state events (visibilitychange isn't delivered at backgrounding
  // in the app): drive the audio engine's suspend/restore, and update the
  // freeze filter's timestamp so a background gap never logs as a FREEZE.
  p.app.onStateChange((active) => {
    _lastVisChange = performance.now();
    console.log(`[zoomies] app-state: active=${active}`);
    // Pause the race HERE, not off document.hidden — that event isn't
    // delivered at backgrounding in the app, so locking the phone mid-race
    // left the race live: on unlock the engine blared at pre-lock pitch
    // while the sim caught up (the "sped-up audio" report).
    if (!active && state === State.RACING) pauseGame();
    audio.setAppActive(active);
    if (active) {
      audio.unlock();
      // Belt-and-braces: the first touch after returning re-establishes the
      // audio session with a real user gesture behind it (the timing that an
      // app-switcher round trip provided by accident).
      const once = () => {
        window.removeEventListener("pointerdown", once, true);
        p.audio.reactivate().catch(() => {});
        audio.unlock();
      };
      window.addEventListener("pointerdown", once, true);
    }
  });
  try {
    const other = await p.audio.otherAudioPlaying();
    console.log(`[zoomies] audio policy: otherAudioPlaying=${other}`);
    if (other) {
      audio.setMusicAllowed(false);
      console.log("[zoomies] other audio detected — game music muted for this session (SFX unaffected)");
    }
  } catch { /* best-effort */ }
}).catch(() => {});
const _feel = { spin: false, tier: 0, boost: false, air: false, finished: false, last: 0 };
function updateHaptics(nowMs) {
  if (!_platformA || !player || state !== State.RACING) return;
  const h = _platformA.haptics;
  // Shared 90ms gate so stacked events (landing + boost) don't machine-gun.
  const fire = (style) => {
    if (nowMs - _feel.last < 90) return;
    _feel.last = nowMs;
    h.impact(style);
  };
  // Taking a hairball / bump → spin-out: the big one.
  const spinning = player.spinTimer > 0;
  if (spinning && !_feel.spin) fire("heavy");
  _feel.spin = spinning;
  // Drift mini-turbo charging up a tier (mirrors the spark colours blue→gold→rainbow).
  const tier = player.drifting ? (player.driftCharge > 1.5 ? 2 : player.driftCharge > 0.8 ? 1 : 0) : 0;
  if (tier > _feel.tier) fire("light");
  _feel.tier = tier;
  // Boost engages (drift release, toot button, or catnip pickup).
  const boosting = player.boosting || player.catnipBoosting;
  if (boosting && !_feel.boost) fire("medium");
  _feel.boost = boosting;
  // Hard landing — only when the suspension really squashes, so small hops stay quiet.
  const air = player.airborne;
  if (_feel.air && !air && (player._squash || 0) > 0.35) fire("light");
  _feel.air = air;
  // Crossing the finish line: Apple's "success" double-tap pattern.
  if (player.finished && !_feel.finished) { _feel.last = nowMs; h.success(); }
  _feel.finished = player.finished;
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
// The native (Capacitor) app IS the installed app — it just doesn't report the
// PWA standalone signals (it loads from capacitor://localhost, which matches
// neither display-mode:standalone nor navigator.standalone). Count it as
// standalone so the install button and the mandatory install gate below are
// suppressed inside the app. In Safari this is false, so the browser keeps the
// existing Add-to-Home-Screen prompt/gate unchanged.
const _isNativeApp = isNativePlatform();
const _isStandalone =
  _isNativeApp ||
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;
const _isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

// Multiplayer favours performance over looks: two extra ghost karts + the realtime
// client on an already heavy scene means a higher, steadier frame rate (and no iOS
// WebGPU device-loss) matters more than god-rays. So while in a multiplayer
// race, force the memory-lean Low profile (no god-ray target, capped pixel
// ratio, no GPU motes) on EVERY device. NON-persisted — single-player and the saved
// preference are untouched, and it's restored when leaving multiplayer. A player
// who bumps the Settings toggle to High mid-session opts out for that session
// (_mpWantsHigh), so the toggle still works.
let _mpForcedLow = false;
let _mpWantsHigh = false;
function applyMpQuality() {
  const wantLow = MP.enabled && !_mpWantsHigh;
  if (wantLow && quality !== "low") {
    _mpForcedLow = true;
    applyQuality("low", false);
    hud.showToast?.("Graphics set to Low for smoother multiplayer");
  } else if (!wantLow && _mpForcedLow) {
    _mpForcedLow = false;
    let saved = "medium";
    try {
      const v2 = localStorage.getItem(QUALITY_KEY_V2);
      if (v2 === "low" || v2 === "medium" || v2 === "high") saved = v2;
      else if (localStorage.getItem(QUALITY_KEY) === "low") saved = "low";
    } catch {}
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
const ALL_BIOMES = ["meadow", "forest", "alpine", "autumn", "desert", "mesa", "blossom", "jungle", "savanna", "tundra", "city", "beach"];
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
  set("track-twist", _trackDraft.twist ?? 0.5);
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
  trackPanel?.querySelectorAll("#track-feats .biome-chip").forEach((chip) => {
    chip.classList.toggle("on", _trackDraft.features.includes(chip.dataset.feat));
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
const ALL_FEATS = [...FEATURE_CHIP_KINDS, "extras"];
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
    // Set-piece chips: absent config means "all on".
    features: Array.isArray(trackConfig.features) ? [...trackConfig.features] : [...ALL_FEATS],
    twist: trackConfig.twist ?? 0.5,
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
// Set-piece chips: plain multi-toggles (deselecting all = a plain-roads map).
trackPanel?.querySelectorAll("#track-feats .biome-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const f = chip.dataset.feat;
    const i = _trackDraft.features.indexOf(f);
    if (i >= 0) _trackDraft.features.splice(i, 1);
    else _trackDraft.features.push(f);
    syncTrackPanel();
  });
});
// The track maker opens as a sheet from the Track step's "Make your own" card
// and from the start line's map Edit affordance.

// Main-menu map: a thumbnail of the track you're about to race, doubling as a
// shortcut into the track editor. The Track tile echoes the same name plus the
// chosen time of day so the whole setup reads off the front screen.
const TOD_LABELS = { midday: "Midday", sunset: "Sunset", night: "Night", random: "Random sky" };
function refreshMenuMap() {
  // The menu map shows the LIVE world, so its set pieces (planned at build)
  // can be drawn right on the loop, and the track gets its generated name.
  paintTrackMap(document.getElementById("menu-map"), previewLoopPoints(trackConfig), featureGlyphs(track.features));
  const name = trackConfig.mode === "custom"
    ? `${trackTitle(track.features, WORLD_SEED)} · ${trackConfig.seed || "—"}`
    : "Classic circuit";
  const label = document.getElementById("menu-map-label");
  if (label) label.textContent = `${name} · ${TOD_LABELS[trackConfig.timeOfDay] || TOD_LABELS.midday}`;
}
// Cup Series maps are fixed recipes — the map is a preview there, not an editor
// entry point (the button's Edit affordance is hidden via .map-no-edit too).
document.getElementById("menu-map-btn")?.addEventListener("click", () => {
  if (raceMode !== "cup") openTrackPanel();
});
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
document.getElementById("track-twist")?.addEventListener("input", (e) => {
  _trackDraft.twist = e.target.value / 100;
  setTrackVal("track-twist", e.target.value);
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
// Scoped to #track-biomes: the time-of-day chips share the .biome-chip class and
// live in the same panel — an unscoped bind would fire this handler on tod clicks
// too, pushing `undefined` into the biome list (and evicting a real biome at cap).
trackPanel?.querySelectorAll("#track-biomes .biome-chip").forEach((chip) => {
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
  // Resume the flow where the reload interrupts it: applying from the start
  // line's Edit lands back on the start line; applying from the Track step
  // moves on to the racer (the step a track pick would have advanced to).
  saveFlowResume(flowStep === "startline" ? "startline" : "racer");
  markReload("track-apply");
  location.reload(); // rebuild the world from the new recipe
});

// --- Racer step: pick your cat + kart, with a live 3D preview --------------
// The selection just rides in garageConfig; the player kart reads it at race start
// (raceRoster/buildKarts) so no reload is needed. While the Racer step is up the
// menu loop renders an orbiting preview kart instead of the cinematic (see the loop).
let _garageDraft = null; // { cat, kart } in-progress; committed to garageConfig on Done
let _garageOpen = false;
let _garagePreview = null; // the preview kart's group in the scene
let _garagePreviewKart = null; // the preview Kart instance (for the idle blink)
const _garageAnchor = new THREE.Vector3();
const _garageLook = new THREE.Vector3();

// The last-built preview kart is CACHED (not disposed) so re-entering the
// showroom is instant; a boot-idle prewarm builds + pipeline-compiles the saved
// racer so even the FIRST entry doesn't hitch. Changing the draft evicts.
const _previewCache = { key: null, kart: null };
function _previewKey(draft) {
  const cat = catSpec(draft);
  const kart = kartSpec(draft);
  return [cat.fur, cat.pattern, cat.accessory, cat.accessoryColor, cat.name, kart.color, kart.style, kart.number].join("|");
}
function _buildPreviewKart(draft) {
  const cat = catSpec(draft);
  const kart = kartSpec(draft);
  const pk = new Kart({ color: kart.color, catColor: cat.fur, catPattern: cat.pattern, catAccessory: cat.accessory, catAccessoryColor: cat.accessoryColor, kartStyle: kart.style, kartNumber: kart.number, name: cat.name, isPlayer: false, skill: 1 });
  pk.group.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
  });
  toonify(pk.group);
  // (compileAsync was tried here on r185 and REGRESSED: whole-scene pipeline
  // batches stalled the next render 2-6s on device. See startRace note.)
  return pk;
}
// (_disposeGroup is models.js's disposeGroup: frees per-instance geometries +
// materials, skipping the shared colour-keyed/constant ones other karts use.)
function _clearGaragePreview() {
  if (!_garagePreview) return;
  scene.remove(_garagePreview); // stays parked in _previewCache for next time
  _garagePreview = null;
  _garagePreviewKart = null;
}
// Show the draft's kart: pulled straight from the cache when it matches, else
// built fresh (a click-time cost, same as the old garage steppers).
function buildGaragePreview() {
  const key = _previewKey(_garageDraft);
  if (_garagePreview && _previewCache.key === key) return; // already showing it
  _clearGaragePreview();
  if (_previewCache.key !== key) {
    if (_previewCache.kart) _disposeGroup(_previewCache.kart.group); // evict the stale build
    _previewCache.kart = _buildPreviewKart(_garageDraft);
    _previewCache.key = key;
  }
  const pk = _previewCache.kart;
  pk.placeAt(_garageAnchor, Math.PI * 0.85, track); // park on the grid slot, ¾ angle
  scene.add(pk.group);
  _garagePreview = pk.group;
  _garagePreviewKart = pk;
}

// --- Custom creator -------------------------------------------------------
// Curated fur tones (real cat colours) and bold kart liveries the swatch grids
// offer. Custom picks aren't limited to these — they just seed quick choices.
const CAT_FUR_SWATCHES = [0xf0a830, 0xc8966a, 0x8c9298, 0x2a2a2a, 0xfbfbfb, 0xf3dcb6, 0x4a3328, 0x9aa2a8, 0x5a3b2a, 0xd9b38c, 0xe8e2d6, 0x6b4a2f];
const KART_COLOR_SWATCHES = [0xe53935, 0x1e88e5, 0x43a047, 0xfb8c00, 0x8e24aa, 0xfdd835, 0x00897b, 0x26c6da, 0xec407a, 0x5e35b1, 0x16181d, 0xeeeeee];
const KART_STYLE_NAMES = ["GP", "Roadster", "Buggy", "Finned", "Moto", "Minivan", "Cage"];
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
// The accessory-colour palette is per-accessory, so its grid is rebuilt whenever
// the chosen accessory changes (unlike the fixed fur/kart grids). The row hides
// for accessories with no colour (just "none"). A null draft colour means "use the
// accessory's natural default" — highlight that first swatch.
function _syncAccColorGrid(accId, chosenColor) {
  const row = document.getElementById("cat-acccolor-row");
  const grid = document.getElementById("cat-acccolor-grid");
  if (!row || !grid) return;
  const palette = ACCESSORY_COLORS[accId] || [];
  row.classList.toggle("hidden", palette.length === 0);
  if (palette.length === 0) { grid.replaceChildren(); grid._accId = accId; return; }
  if (grid._accId !== accId) { // repopulate only when the accessory (hence palette) changed
    grid.replaceChildren();
    for (const c of palette) {
      const b = document.createElement("button");
      b.className = "swatch-dot";
      b.style.background = _hex6(c);
      b.dataset.color = c;
      b.setAttribute("aria-label", "Accessory colour " + _hex6(c));
      b.addEventListener("click", () => editCustomCat({ accessoryColor: c }));
      grid.appendChild(b);
    }
    grid._accId = accId;
  }
  const effective = (chosenColor != null) ? chosenColor : palette[0];
  for (const b of grid.children) b.classList.toggle("selected", Number(b.dataset.color) === effective);
}

// Refresh the creator panels: Custom mode (chosen on the Presets/Custom toggle)
// swaps the preset stepper for the creator, and mirrors the draft's custom
// values into its controls.
function syncCreators() {
  const catCustom = _garageDraft.cat === CUSTOM_CAT_IDX;
  const kartCustom = _garageDraft.kart === CUSTOM_KART_IDX;
  document.getElementById("cat-custom").classList.toggle("hidden", !catCustom);
  document.getElementById("kart-custom").classList.toggle("hidden", !kartCustom);
  // The stepper only browses presets, so it steps aside in Custom mode (the
  // creator has its own name field + controls).
  document.getElementById("cat-stepper")?.classList.toggle("hidden", catCustom);
  document.getElementById("kart-stepper")?.classList.toggle("hidden", kartCustom);
  document.getElementById("cat-src-preset")?.classList.toggle("is-active", !catCustom);
  document.getElementById("cat-src-custom")?.classList.toggle("is-active", catCustom);
  document.getElementById("kart-src-preset")?.classList.toggle("is-active", !kartCustom);
  document.getElementById("kart-src-custom")?.classList.toggle("is-active", kartCustom);
  if (catCustom) {
    const c = _garageDraft.customCat;
    document.getElementById("cat-pat-name").textContent = _cap(c.pattern);
    document.getElementById("cat-acc-name").textContent = ACCESSORY_LABELS[c.accessory] || _cap(c.accessory);
    const ni = document.getElementById("cat-custom-name");
    if (ni.value !== c.name) ni.value = c.name;
    _markSelectedSwatch("cat-color-grid", c.fur);
    _syncAccColorGrid(c.accessory, c.accessoryColor);
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
// Unlock id for the draft's current pick on one side of the garage.
function draftItemId(which) {
  const idx = _garageDraft[which];
  if (which === "cat") return idx === CUSTOM_CAT_IDX ? "custom.cat" : `cat.${idx}`;
  return idx === CUSTOM_KART_IDX ? "custom.kart" : `kart.${idx}`;
}
// Reflect lock state: 🔒 on locked names, and a Buy/prize row when the current
// pick isn't owned. Browsing locked items is allowed (window shopping — the
// preview shows them); only Done is gated.
function syncGarageLocks() {
  const buyBtn = document.getElementById("garage-buy");
  const note = document.getElementById("garage-lock-note");
  let lockedId = null;
  for (const which of ["cat", "kart"]) {
    const id = draftItemId(which);
    const el = document.getElementById(which + "-name");
    const owned = isUnlocked(profile, id);
    if (el && !owned) el.textContent = "🔒 " + el.textContent;
    if (!owned && !lockedId) lockedId = id;
  }
  if (!buyBtn || !note) return;
  if (!lockedId) {
    buyBtn.classList.add("hidden");
    note.textContent = "";
    return;
  }
  const entry = catalogEntry(lockedId);
  if (entry && typeof entry.price === "number") {
    buyBtn.classList.remove("hidden");
    buyBtn.textContent = `🐟 Buy ${unlockName(lockedId)} · ${entry.price}`;
    buyBtn.disabled = profile.treats < entry.price;
    note.textContent = profile.treats < entry.price
      ? `You have 🐟 ${profile.treats} — earn ${entry.price - profile.treats} more by racing.`
      : `You have 🐟 ${profile.treats}.`;
    buyBtn.dataset.unlock = lockedId;
  } else if (entry && entry.cup) {
    buyBtn.classList.add("hidden");
    const cup = cupById(entry.cup);
    note.textContent = `🏆 ${unlockName(lockedId)} is the ${cup ? cup.name : entry.cup} prize — win the cup to unlock it.`;
  } else if (entry && entry.diff) {
    buyBtn.classList.add("hidden");
    note.textContent = `🎖 ${unlockName(lockedId)} unlocks by winning any cup on ${entry.diff === "hard" ? "Hard" : "Medium or harder"}.`;
  } else {
    buyBtn.classList.add("hidden");
    note.textContent = "Locked.";
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
  syncGarageLocks();
}
// The main menu's Racer tile: current cat + kart by name, with their colours as
// two little swatch dots, so the choice reads without opening the garage.
function refreshRacerSummary() {
  const el = document.getElementById("racer-summary");
  if (!el) return;
  const cat = catSpec(garageConfig);
  const kart = kartSpec(garageConfig);
  el.textContent = `${cat.name} · ${kart.name}`;
  const cs = document.getElementById("racer-swatch-cat");
  if (cs) cs.style.background = _hex6(cat.fur);
  const ks = document.getElementById("racer-swatch-kart");
  if (ks) ks.style.background = _hex6(kart.color);
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
  // Seed the "last browsed preset" so leaving Custom returns somewhere sensible.
  _garagePrevPreset.cat = _garageDraft.cat < CUSTOM_CAT_IDX ? _garageDraft.cat : 0;
  _garagePrevPreset.kart = _garageDraft.kart < CUSTOM_KART_IDX ? _garageDraft.kart : 0;
  syncGarageUI();
  // Instant when the cached kart matches (the prewarmed/common case); a cold
  // build waits for the slide to land so the transition never stutters.
  if (_previewCache.key === _previewKey(_garageDraft)) buildGaragePreview();
  else setTimeout(() => { if (_garageOpen) buildGaragePreview(); }, 470);
  // Kill any in-progress menu cross-dissolve: its frozen snapshot (#menu-xfade)
  // would otherwise hang over the live preview as a doubled "ghost" of the level.
  if (menuXfade) menuXfade.style.opacity = 0;
  _menuPhase = "hold";
  _menuShotT = 0;
  _garageOpen = true;
}
function closeGarage() {
  _garageOpen = false;
  _clearGaragePreview();
}
// The stepper browses PRESETS only; Custom is its own mode on the toggle above
// it (an explicit affordance, not a hidden extra slot at the end of the cycle).
function stepGarage(which, dir) {
  const n = which === "cat" ? CAT_PRESETS.length : KART_PRESETS.length;
  _garageDraft[which] = ((_garageDraft[which] % n) + dir + n) % n;
  syncGarageUI();
  buildGaragePreview();
}
// Remembers the preset you were browsing so toggling Custom → Presets returns
// to it instead of resetting to the first cat/kart.
const _garagePrevPreset = { cat: 0, kart: 0 };
function setGarageSource(which, custom) {
  const customIdx = which === "cat" ? CUSTOM_CAT_IDX : CUSTOM_KART_IDX;
  const isCustom = _garageDraft[which] === customIdx;
  if (custom === isCustom) return;
  if (custom) {
    _garagePrevPreset[which] = _garageDraft[which];
    _garageDraft[which] = customIdx;
  } else {
    _garageDraft[which] = _garagePrevPreset[which] ?? 0;
  }
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
    const patch = { [which]: list[(i + dir + list.length) % list.length] };
    // Switching accessory resets its colour to that type's natural default.
    if (which === "accessory") patch.accessoryColor = null;
    editCustomCat(patch);
  }
}
// Slowly orbit the camera around the parked preview kart. The control card is
// docked to the RIGHT half of the (landscape) screen, so frame the kart in the
// open LEFT half: orbit a touch further back (smaller kart) and pan the aim to
// the right, which slides the kart leftward on screen.
const _garageRight = new THREE.Vector3();
function renderGarage(timeSec, dt = 0.016) {
  if (!_garagePreview) return;
  _garagePreviewKart?.idleBlink(dt); // the parked cat blinks now and then
  const p = _garagePreview.position;
  const ang = timeSec * 0.5;
  const r = 11.2; // well back so the whole kart reads small and never clips
  camera.position.set(p.x + Math.sin(ang) * r, p.y + 3.1, p.z + Math.cos(ang) * r);
  if (camera.fov !== 38) { camera.fov = 38; camera.updateProjectionMatrix(); }
  _garageLook.set(p.x, p.y + 1.25, p.z);
  camera.lookAt(_garageLook);
  // Pan the aim right along the camera's screen-right axis so the kart sits in
  // the open left half (the card covers the right). Re-aim after the shift.
  _garageRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _garageLook.addScaledVector(_garageRight, 3.4);
  camera.lookAt(_garageLook);
  renderFrame();
}

document.getElementById("cat-prev")?.addEventListener("click", () => stepGarage("cat", -1));
document.getElementById("cat-next")?.addEventListener("click", () => stepGarage("cat", 1));
document.getElementById("kart-prev")?.addEventListener("click", () => stepGarage("kart", -1));
document.getElementById("kart-next")?.addEventListener("click", () => stepGarage("kart", 1));
document.getElementById("cat-src-preset")?.addEventListener("click", () => setGarageSource("cat", false));
document.getElementById("cat-src-custom")?.addEventListener("click", () => setGarageSource("cat", true));
document.getElementById("kart-src-preset")?.addEventListener("click", () => setGarageSource("kart", false));
document.getElementById("kart-src-custom")?.addEventListener("click", () => setGarageSource("kart", true));

// Custom-cat creator controls.
_buildSwatchGrid("cat-color-grid", CAT_FUR_SWATCHES, (c) => editCustomCat({ fur: c }));
document.getElementById("cat-pat-prev")?.addEventListener("click", () => stepCustom("pattern", CAT_PATTERNS, -1));
document.getElementById("cat-pat-next")?.addEventListener("click", () => stepCustom("pattern", CAT_PATTERNS, 1));
document.getElementById("cat-acc-prev")?.addEventListener("click", () => stepCustom("accessory", CAT_ACCESSORIES, -1));
document.getElementById("cat-acc-next")?.addEventListener("click", () => stepCustom("accessory", CAT_ACCESSORIES, 1));
document.getElementById("cat-custom-name")?.addEventListener("input", (e) => editCustomCat({ name: e.target.value.slice(0, 14) }, false));
document.getElementById("cat-randomize")?.addEventListener("click", () => {
  const accessory = _pick(CAT_ACCESSORIES);
  const pal = ACCESSORY_COLORS[accessory] || [];
  editCustomCat({
    fur: _pick(CAT_FUR_SWATCHES), pattern: _pick(CAT_PATTERNS), accessory, name: _pick(CUSTOM_CAT_NAMES),
    accessoryColor: pal.length ? _pick(pal) : null,
  });
});

// Custom-kart creator controls.
_buildSwatchGrid("kart-color-grid", KART_COLOR_SWATCHES, (c) => editCustomKart({ color: c }));
// The stepper walks CREATOR_KART_STYLES (parked styles are skipped).
const _stepKartStyle = (dir) => {
  const cur = Math.max(0, CREATOR_KART_STYLES.indexOf(_garageDraft.customKart.style));
  editCustomKart({ style: CREATOR_KART_STYLES[(cur + dir + CREATOR_KART_STYLES.length) % CREATOR_KART_STYLES.length] });
};
document.getElementById("kart-style-prev")?.addEventListener("click", () => _stepKartStyle(-1));
document.getElementById("kart-style-next")?.addEventListener("click", () => _stepKartStyle(1));
document.getElementById("kart-num-prev")?.addEventListener("click", () => editCustomKart({ number: (_garageDraft.customKart.number + 99) % 100 }));
document.getElementById("kart-num-next")?.addEventListener("click", () => editCustomKart({ number: (_garageDraft.customKart.number + 1) % 100 }));
document.getElementById("kart-custom-name")?.addEventListener("input", (e) => editCustomKart({ name: e.target.value.slice(0, 14) }, false));
document.getElementById("kart-randomize")?.addEventListener("click", () => editCustomKart({
  color: _pick(KART_COLOR_SWATCHES), style: _pick(CREATOR_KART_STYLES), number: Math.floor(Math.random() * 100), name: _pick(CUSTOM_KART_NAMES),
}));

document.getElementById("garage-buy")?.addEventListener("click", (e) => {
  const id = e.currentTarget.dataset.unlock;
  if (!id) return;
  if (buyUnlock(profile, id)) {
    saveProfile();
    refreshTreatsChip();
    audio.uiClick?.();
  }
  syncGarageUI();
});
document.getElementById("garage-apply")?.addEventListener("click", () => {
  // Next is the gate: locked picks can be browsed/previewed but not kept.
  const lockedSide = ["cat", "kart"].find((w) => !isUnlocked(profile, draftItemId(w)));
  if (lockedSide) {
    const note = document.getElementById("garage-lock-note");
    if (note) note.textContent = `🔒 ${unlockName(draftItemId(lockedSide))} is locked — buy it or win it first.`;
    uiCue("error");
    return;
  }
  garageConfig.cat = _garageDraft.cat;
  garageConfig.kart = _garageDraft.kart;
  garageConfig.customCat = sanitizeCustomCat(_garageDraft.customCat);
  garageConfig.customKart = sanitizeCustomKart(_garageDraft.customKart);
  saveGarageConfig(garageConfig);
  refreshRacerSummary();
  // Onward: friends-hosting goes to the lobby (this tap is the fullscreen +
  // motion gesture); every solo mode reviews the race on the start line.
  if (raceMode === "mp") hostGame();
  else flowGo("startline");
});
refreshRacerSummary();

musicToggle?.addEventListener("click", () => {
  audio.unlock();
  audio.setMusicOn(!audio.musicOn);
  refreshAudioUI();
});
sfxToggle?.addEventListener("click", () => {
  audio.unlock();
  audio.setSfxOn(!audio.sfxOn);
  setUiCuesEnabled(audio.sfxOn); // menu cues follow the SFX setting
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
  if (indicatorBtn) indicatorBtn.textContent = `Tilt bar: ${showIndicator ? "On" : "Off"}`;
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
    else if (state === State.FLYVIEW) exitFlyView();
    // Esc walks back out: topmost sheet first, then one flow step.
    else if (e.code === "Escape" && !escCloseTopScreen()) flowBack();
  }
});

// --- Menu flow -----------------------------------------------------------
// One linear road to the grid: title → mode → (track | cup | friends) →
// racer → startline → lobby. Screens slide directionally (forward = in from
// the right); each step's enter/leave hook owns its content + 3D backdrop.
document.getElementById("restart-btn").addEventListener("click", () => (timeTrial ? startTimeTrial() : startRace()));

const startBtn = document.getElementById("start-btn");
const mpCodeInput = document.getElementById("mp-code");
const MODE_KEY = "zoomies-mode-v1";
// Which cup the Cup Series mode races (persisted; mid-cup boots override it).
const CUP_CHOICE_KEY = "zoomies-cup-choice";
let _cupChoice = CUPS[0].id;
try { const c = localStorage.getItem(CUP_CHOICE_KEY); if (cupById(c)) _cupChoice = c; } catch { /* ignore */ }
if (_cupState && _activeCup) _cupChoice = _activeCup.id;
// Multiplayer needs a configured relay key; without one the mode isn't offered.
const mpAvailable = !!resolveAblyKey();
let raceMode = "gp";
try {
  const m = localStorage.getItem(MODE_KEY);
  if (m === "gp" || m === "tt" || m === "cup") raceMode = m; // "mp" never persists (needs a live room)
} catch {}
// A cup reload chain always lands in Cup Series mode; a daily link races single.
if (_cupState && _activeCup) raceMode = "cup";
else if (_dailyActive) raceMode = "gp";

// --- Flow controller ---
const menuFlowEl = document.getElementById("menu");
let flowStep = "title";
// A track pick / maker apply rebuilds the world via a reload — remember where
// the flow was so the boot lands back mid-flow instead of on the title.
const FLOW_RESUME_KEY = "zoomies-flow-resume";
function saveFlowResume(step) {
  try { sessionStorage.setItem(FLOW_RESUME_KEY, step); } catch { /* ignore */ }
}
function flowGo(step, dir = 1, instant = false) {
  const next = document.getElementById("flow-" + step);
  if (!next) return;
  const cur = document.getElementById("flow-" + flowStep);
  const changing = flowStep !== step;
  // Leave hooks: the racer step owns the 3D showroom preview.
  if (changing && flowStep === "racer") closeGarage();
  // Enter hooks BEFORE the slide, so the screen arrives fully drawn.
  if (step === "title") refreshTitlePlay();
  else if (step === "mode") refreshModeCards();
  else if (step === "track") renderTrackCards();
  else if (step === "cup") renderCupOptions();
  else if (step === "racer") openGaragePanel();
  else if (step === "startline") refreshStartline();
  if (changing) {
    if (instant) menuFlowEl.classList.add("flow-instant");
    if (cur) {
      cur.classList.remove("is-active");
      cur.style.setProperty("--fx", dir > 0 ? "-55%" : "55%"); // exit opposite the entry side
    }
    next.style.setProperty("--fx", dir > 0 ? "55%" : "-55%");
    void next.offsetWidth; // commit the start position before activating
    next.classList.add("is-active");
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => menuFlowEl.classList.remove("flow-instant")));
    flowStep = step;
    menuFlowEl.dataset.step = step;
  }
  refreshMenuChrome();
}
// Back is always the same edge: one step toward the title. The racer's back
// depends on how you got there; leaving the lobby leaves the room flow.
function flowBack() {
  if (state !== State.MENU || menuFlowEl.classList.contains("hidden")) return false;
  if (flowStep === "lobby") { toMenu(); return true; }
  const back = {
    mode: "title",
    track: "mode",
    cup: "mode",
    friends: "mode",
    racer: raceMode === "mp" ? "friends" : raceMode === "cup" ? "cup" : "track",
    startline: "racer",
  }[flowStep];
  if (!back) return false;
  flowGo(back, -1);
  return true;
}
menuFlowEl.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", flowBack));

// Title: the one way forward. A mid-cup or daily boot jumps straight to the
// start line (the series/daily brings its own track + racer context).
function refreshTitlePlay() {
  if (!startBtn) return;
  if (raceMode === "cup" && _cupState && _activeCup) startBtn.textContent = `▶ RACE ${_cupState.race + 1} OF ${_activeCup.races.length}`;
  else if (_dailyActive) startBtn.textContent = "📅 START DAILY";
  else startBtn.textContent = "▶  Play";
}
startBtn?.addEventListener("click", () => {
  audio.unlock(); // the opening tap doubles as the audio unlock
  if ((raceMode === "cup" && _cupState && _activeCup) || _dailyActive) { flowGo("startline"); return; }
  flowGo("mode");
});

// Kept as the shared "mode/options changed" refresher (setRaceMode + the
// multiplayer connect path call it).
function applyModeUI() {
  refreshTitlePlay();
  if (flowStep === "startline") refreshStartline();
}
function setRaceMode(mode) {
  if (mode === "mp" && !mpAvailable) return;
  // Leaving Multiplayer for a solo mode drops the room connection.
  if (mode !== "mp" && MP.enabled) teardownMultiplayer();
  raceMode = mode;
  if (mode !== "mp") try { localStorage.setItem(MODE_KEY, mode); } catch {}
  applyModeUI();
}

// Mode: one tap chooses AND advances.
function refreshModeCards() {
  for (const m of ["gp", "tt", "mp", "cup"])
    document.getElementById("mode-" + m)?.classList.toggle("is-selected", raceMode === m);
}
document.getElementById("mode-gp")?.addEventListener("click", () => { setRaceMode("gp"); flowGo("track"); });
document.getElementById("mode-tt")?.addEventListener("click", () => { setRaceMode("tt"); flowGo("track"); });
document.getElementById("mode-cup")?.addEventListener("click", () => { setRaceMode("cup"); flowGo("cup"); });
document.getElementById("mode-mp")?.addEventListener("click", () => flowGo("friends"));
// Friends: hosting picks the mode here; joining reloads into the friend's room.
document.getElementById("mp-host-btn")?.addEventListener("click", () => { setRaceMode("mp"); flowGo("racer"); });

// --- Track step: featured recipes painted from the real generator ----------
// Fixed seeds/knobs so the cards are stable, nameable places. Picking a card
// that isn't already built saves the recipe and reloads (the world is built
// from the config at boot), resuming the flow at the Racer step.
const FEATURED_TRACKS = [
  { name: "Buttercup Run", sub: "🌳 Meadow · Midday", cfg: { mode: "custom", seed: "MEOW", size: 0.45, curviness: 0.5, twist: 0.42, hilliness: 0.35, hills: 0.5, biomes: ["meadow", "forest"], timeOfDay: "midday" } },
  { name: "Whisker Canyon", sub: "⛰️ Desert · Sunset", cfg: { mode: "custom", seed: "DUNE", size: 0.55, curviness: 0.55, twist: 0.5, hilliness: 0.6, hills: 0.6, biomes: ["desert", "mesa"], timeOfDay: "sunset" } },
  { name: "Neon Alley", sub: "🏙 City · Night", cfg: { mode: "custom", seed: "NEON", size: 0.5, curviness: 0.45, twist: 0.55, hilliness: 0.3, hills: 0.4, biomes: ["city"], timeOfDay: "night" } },
  { name: "Tuna Cove", sub: "🏖 Beach · Midday", cfg: { mode: "custom", seed: "TUNA", size: 0.5, curviness: 0.5, twist: 0.45, hilliness: 0.35, hills: 0.45, biomes: ["beach", "jungle"], timeOfDay: "midday" } },
  { name: "Snowcap Sprint", sub: "🏔 Alpine · Sunset", cfg: { mode: "custom", seed: "PEAK", size: 0.5, curviness: 0.55, twist: 0.5, hilliness: 0.7, hills: 0.65, biomes: ["alpine", "tundra"], timeOfDay: "sunset" } },
];
const _TRACK_CFG_KEYS = ["seed", "size", "curviness", "twist", "hilliness", "hills", "timeOfDay"];
function trackCardCurrent(cfg) {
  if (cfg.mode !== "custom") return trackConfig.mode !== "custom";
  return trackConfig.mode === "custom"
    && _TRACK_CFG_KEYS.every((k) => trackConfig[k] === cfg[k])
    && String(trackConfig.biomes || []) === String(cfg.biomes || []);
}
function renderTrackCards() {
  const grid = document.getElementById("track-grid");
  if (!grid) return;
  grid.replaceChildren();
  const addCard = (name, sub, cfg, current) => {
    const b = document.createElement("button");
    b.className = "tap-card track-tap" + (current ? " is-selected" : "");
    const shot = document.createElement("span");
    shot.className = "track-shot";
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 188;
    shot.appendChild(canvas);
    const nm = document.createElement("span");
    nm.className = "track-name";
    nm.textContent = name;
    const sb = document.createElement("span");
    sb.className = "track-sub";
    sb.textContent = sub;
    b.append(shot, nm, sb);
    cueifyButton(b);
    b.addEventListener("click", () => chooseTrackCard(cfg));
    grid.appendChild(b);
    try { paintTrackMap(canvas, previewLoopPoints(cfg)); } catch { /* a bad recipe just leaves a blank shot */ }
  };
  addCard("Classic Circuit", "🏁 The original loop", { mode: "classic" }, trackConfig.mode !== "custom");
  for (const t of FEATURED_TRACKS) addCard(t.name, t.sub, t.cfg, trackCardCurrent(t.cfg));
  // The player's own recipe, when the live world isn't one of the cards above.
  if (trackConfig.mode === "custom" && !FEATURED_TRACKS.some((t) => trackCardCurrent(t.cfg))) {
    addCard(trackTitle(track.features, WORLD_SEED), `🛠 My track · ${TOD_LABELS[trackConfig.timeOfDay] || "Midday"}`, { ...trackConfig }, true);
  }
  const mk = document.createElement("button");
  mk.className = "tap-card track-maker-card";
  mk.innerHTML = `<span class="tap-chip" style="background:#ff9ecb">🛠️</span><span class="tap-title">Make your own track</span><span class="tap-chev">›</span>`;
  cueifyButton(mk);
  mk.addEventListener("click", openTrackPanel);
  grid.appendChild(mk);
}
function chooseTrackCard(cfg) {
  if (trackCardCurrent(cfg)) { flowGo("racer"); return; } // already built → onward
  saveTrackConfig({ ...trackConfig, ...cfg });
  saveFlowResume("racer");
  uiCue("loading");
  markReload("track-pick");
  // Drop any explicit world params (a daily/cup/join link) so the saved recipe
  // drives the rebuild instead of the URL's seed.
  const u = new URL(location.href);
  for (const p of ["seed", "w", "daily", "cup"]) u.searchParams.delete(p);
  location.href = u.toString();
}

// --- Start line: the only full summary — map, racer, options, one giant GO --
const GO_LABELS = { gp: "🏁  START RACE", tt: "⏱  START TIME TRIAL", cup: "🏆  START CUP" };
function refreshStartline() {
  refreshMenuMapCycle(); // live-world map, or the chosen cup's cycling previews
  refreshRacerSummary();
  refreshRaceOptSegs();
  const goBtn = document.getElementById("go-btn");
  const note = document.getElementById("start-note");
  const cupDef = cupById(_cupChoice);
  const midCup = raceMode === "cup" && _cupState && _activeCup;
  document.getElementById("laps-row")?.classList.toggle("hidden", raceMode !== "gp");
  document.getElementById("diff-row")?.classList.toggle("hidden", !(raceMode === "gp" || (raceMode === "cup" && !midCup)));
  if (note) {
    let txt = "";
    if (_dailyActive) txt = "📅 Today's challenge — everyone races the same track. Daily bonus when you finish!";
    else if (midCup) txt = `${_activeCup.emoji} ${_activeCup.name} — race ${_cupState.race + 1} of ${_activeCup.races.length}. Points carry across the series.`;
    else if (raceMode === "cup" && cupDef) {
      txt = `${cupDef.emoji} ${cupDef.name} — ${cupDef.races.length} races, points and trophies.`;
      if (cupDef.unlockId && !profile.trophies[cupDef.id]) txt += ` 🎁 First win: ${unlockName(cupDef.unlockId)}.`;
    } else if (raceMode === "tt") {
      const pb = loadTimeTrial()[0];
      txt = pb ? `⏱ One flying lap against the clock — your best is ${formatLap(pb.time)}.`
        : "⏱ One flying lap against the clock — set your first PB!";
    }
    note.textContent = txt;
    note.classList.toggle("hidden", !txt);
  }
  if (goBtn) {
    if (midCup) goBtn.textContent = `▶  RACE ${_cupState.race + 1} OF ${_activeCup.races.length}`;
    else if (_dailyActive) goBtn.textContent = "📅  START DAILY";
    else goBtn.textContent = GO_LABELS[raceMode] || GO_LABELS.gp;
  }
}
document.getElementById("startline-edit")?.addEventListener("click", () => flowGo("racer", -1));
// GO: the tap that grants fullscreen + tilt, then starts whichever mode is up.
document.getElementById("go-btn")?.addEventListener("click", () => {
  if (raceMode === "tt") startTimeTrial();
  else if (raceMode === "cup") {
    if (_cupState && _activeCup) beginRace(); // continue the series (this tap grants tilt)
    else startCup(_cupChoice);
  } else startRace();
});

// Host: connect to my own room (= my world seed) and go straight into the lobby.
// The click is the user gesture beginRace needs for fullscreen + motion permission.
function hostGame() {
  if (!MP.enabled) enterMultiplayer();
  else if (!mpIsHost()) claimHost(); // already connected as a guest (?mp=1 link) → take host
  beginRace(); // gesture setup + (MP.enabled) enterLobby
}
// Promote an already-connected client to host. Needed because arriving via an
// ?mp=1 link auto-connects you as a guest, so hostGame()'s enterMultiplayer()
// (which crowns you) is skipped — without this, a room where everyone joined by
// link has no host and can never start. Broadcasts the claim so peers converge.
function claimHost() {
  if (!MP.enabled || !MP.net) return;
  _amHost = true;
  try { sessionStorage.setItem("mp-host-seed", WORLD_SEED); } catch { /* ignore */ }
  MP.announceHost();
  if (MP.inLobby) renderLobby();
}
// Join by code: a friend's code IS their world seed, so reload into that world
// with multiplayer on and auto-open the lobby. enableMotion() here grabs iOS
// motion permission inside the gesture so it survives the reload.
function joinGame() {
  const code = (mpCodeInput?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) { mpCodeInput?.focus(); uiCue("error"); return; }
  if (code === WORLD_SEED && MP.enabled) { beginRace(); return; } // already in this room
  audio.unlock();
  uiCue("loading"); // joining the room (the reload lands in the lobby)
  try { input.enableMotion(); } catch {}
  // I'm joining someone else's room → I'm a guest, not the host (clear any prior
  // hosted-seed so a refresh in this tab doesn't wrongly crown me).
  try { sessionStorage.setItem("mp-host-seed", ""); } catch {} // I'm a joiner (empty host-seed → my custom track yields to the host's)
  try { sessionStorage.removeItem("mp-adopt-sig"); } catch {} // fresh join → clear the adopt-reload guard so we can adopt the new host's world
  markReload("mp-join");
  const u = new URL(location.href);
  u.searchParams.set("seed", code);
  u.searchParams.set("mp", "1");
  u.searchParams.delete("w"); // dropping into a new room by code — no shared world yet; adopt on connect
  location.href = u.toString(); // reload into the host's world; ?mp=1 auto-opens the lobby
}
// Open the multiplayer lobby once the menu wiring is ready (deferred so it wins
// over the default-visible menu on the initial frame).
function autoOpenLobby() {
  if (_installGate) return; // an un-installed touch device must install first
  enterLobby();
}
function enterMultiplayer() {
  raceMode = "mp";
  _amHost = true; // I'm creating this room → I'm the host (survives a refresh below)
  try { sessionStorage.setItem("mp-host-seed", WORLD_SEED); } catch { /* ignore */ }
  audio.unlock();
  uiCue("loading"); // connecting… (resolved by the onRoster "ready" cue)
  const u = new URL(location.href);
  u.searchParams.set("mp", "1");
  u.searchParams.set("seed", WORLD_SEED);
  history.replaceState(null, "", u);
  initMultiplayer(); // connects (async) in the background
  applyModeUI();
}
// Drop the room connection + remote karts (used when switching back to a solo
// mode on the Game Mode screen). Pure teardown — the caller owns the UI state.
function teardownMultiplayer() {
  MP.teardown(); // netcode teardown: close the connection, drop remotes + parked ghosts
  if (_ref) { _ref.close(); _ref = null; _refTried = false; } // drop the referee link too
  _mpWantsHigh = false; // next MP session re-defaults to lean
  applyMpQuality(); // restore the pre-multiplayer graphics setting
  if (MP.hud) { MP.hud.remove(); MP.hud = null; }
  const u = new URL(location.href);
  u.searchParams.delete("mp");
  history.replaceState(null, "", u);
}
if (mpAvailable) {
  document.getElementById("mode-mp")?.classList.remove("hidden");
  document.getElementById("mp-join-btn")?.addEventListener("click", joinGame);
  mpCodeInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(); });
  // Anyone landing with ?mp=1 — a join reload, an invite link, or a host refresh —
  // is here to play together, so drop straight into the lobby (no flag needed).
  if (new URLSearchParams(location.search).has("mp")) {
    raceMode = "mp";
    setTimeout(autoOpenLobby, 60);
  }
}
applyModeUI();
refreshRaceOptSegs();
// Boot restore: a track pick / maker apply reloaded mid-flow — land back on the
// remembered step (the ?mp=1 lobby path wins; it clears through autoOpenLobby).
{
  let _resume = null;
  try {
    _resume = sessionStorage.getItem(FLOW_RESUME_KEY);
    sessionStorage.removeItem(FLOW_RESUME_KEY);
  } catch { /* ignore */ }
  if (_resume && !new URLSearchParams(location.search).has("mp") && document.getElementById("flow-" + _resume)) {
    // Deferred: the racer step's enter hook touches state (menu cinematic,
    // preview build) that initialises later in this module.
    setTimeout(() => flowGo(_resume, 1, true), 60);
  }
}
// Prewarm the showroom: build the saved cat-in-kart during title idle and draw
// it far underground for two culling-off frames (compiles its pipelines), then
// park it in the cache — entering "Pick your racer" is seamless instead of a
// visible hitch on the first visit.
setTimeout(() => {
  if (state !== State.MENU || _garageOpen || _previewCache.kart) return;
  try {
    const draft = { cat: garageConfig.cat, kart: garageConfig.kart, customCat: { ...garageConfig.customCat }, customKart: { ...garageConfig.customKart } };
    const pk = _buildPreviewKart(draft);
    _previewCache.kart = pk;
    _previewCache.key = _previewKey(draft);
    const slot = track.gridSlot(0);
    pk.group.position.set(slot.position.x, slot.position.y - 80, slot.position.z);
    scene.add(pk.group);
    beginWarmAll(2); // culling-off frames so the buried kart actually draws
    setTimeout(() => { if (pk.group !== _garagePreview && pk.group.parent) scene.remove(pk.group); }, 800);
  } catch { /* prewarm is best-effort */ }
}, 2500);

// --- Progression UI wiring (treats chip, cups, daily, Cat-alog, backup, dev) ---
function refreshTreatsChip() {
  const el = document.getElementById("treats-balance");
  if (el) el.textContent = String(profile.treats);
  const c = document.getElementById("chrome-treats-n");
  if (c) c.textContent = String(profile.treats);
  refreshCatalogTile();
}
// The Cat-alog button's alert dot advertises the reward loop: badges waiting
// to be claimed, or a prize the player can already afford.
function refreshCatalogTile() {
  const alertDot = document.getElementById("catalog-tile-alert");
  if (!alertDot) return;
  const hot = profile.pendingClaims.length > 0
    || CATALOG.some((e) => typeof e.price === "number" && e.price > 0 && e.price <= profile.treats && !isUnlocked(profile, e.id));
  alertDot.classList.toggle("hidden", !hot);
}

// Start a cup: seed the run state and reload into race 1 (each cup race is a
// different seed, and the world is built from the seed at load).
function cupRaceURL(cup, raceIndex) {
  const race = cup.races[raceIndex];
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("seed", race.seed);
  u.searchParams.set("cup", cup.id);
  // The full generated world rides the same token the multiplayer invite uses, so
  // the boot path builds EXACTLY this track whatever the player's saved settings.
  const w = encodeWorld({ cfg: race.cfg, laps: 3, seed: race.seed });
  if (w) u.searchParams.set("w", w);
  return u.toString();
}
function startCup(id) {
  const cup = cupById(id);
  if (!cup) return;
  audio.unlock();
  try { input.enableMotion(); } catch { /* ignore */ } // grab iOS tilt permission inside the tap, like joinGame
  try { sessionStorage.setItem(CUP_KEY, JSON.stringify({ id, race: 0, points: {}, diff: DIFFICULTY })); } catch { /* ignore */ }
  markReload("cup-start");
  location.href = cupRaceURL(cup, 0);
}
document.getElementById("results-next-btn")?.addEventListener("click", () => {
  if (!_cupState || !_activeCup) return;
  _cupState.race++;
  try { sessionStorage.setItem(CUP_KEY, JSON.stringify(_cupState)); } catch { /* ignore */ }
  try { input.enableMotion(); } catch { /* ignore */ } // tap = motion permission survives the reload
  markReload("cup-next");
  location.href = cupRaceURL(_activeCup, _cupState.race);
});

// Daily challenge: reload into today's shared seed with the daily flag.
document.getElementById("open-daily")?.addEventListener("click", () => {
  audio.unlock();
  try { input.enableMotion(); } catch { /* ignore */ }
  markReload("daily-start");
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("seed", dailySeedFor(todayStr()));
  u.searchParams.set("daily", "1");
  location.href = u.toString();
});

// Cup step: one tap-card per series, showing the prize. Picking advances.
const CUP_CHIP_COLORS = ["#ffc24b", "#4cc9f0", "#ff5d5d", "#a4e022"];
function renderCupOptions() {
  const list = document.getElementById("cup-list");
  if (!list) return;
  list.replaceChildren();
  CUPS.forEach((cup, i) => {
    const won = profile.trophies[cup.id];
    const b = document.createElement("button");
    b.className = "tap-card cup-tap" + (cup.id === _cupChoice ? " is-selected" : "");
    const prize = won
      ? `<span class="cup-pill won">🏆 Won on ${won}</span>`
      : cup.unlockId ? `<span class="cup-pill prize">🎁 Win ${unlockName(cup.unlockId)}</span>` : "";
    b.innerHTML =
      `<span class="tap-chip" style="background:${CUP_CHIP_COLORS[i % CUP_CHIP_COLORS.length]}">${cup.emoji}</span>`
      + `<span class="tap-text"><span class="tap-title">${cup.name}</span><span class="tap-sub">${cup.desc}</span></span>`
      + `<span class="tap-chev">›</span>`
      + `<span class="cup-meta"><span class="cup-pill">🏁 ${cup.races.length} races</span>${prize}</span>`;
    cueifyButton(b);
    b.addEventListener("click", () => {
      _cupChoice = cup.id;
      try { localStorage.setItem(CUP_CHOICE_KEY, cup.id); } catch { /* ignore */ }
      clearCupRun(); // picking a (new) cup abandons any half-run series
      flowGo("racer");
    });
    list.appendChild(b);
  });
}
renderCupOptions();

// --- Menu map: cycle the Cup Series' tracks with a cross-fade -----------------
// In Cup Series mode the menu map pages through the chosen cup's generated
// layouts (fade out → repaint → fade in), so the whole series is visible before
// you start. Any other mode shows the live world map as before.
function refreshMenuMapCycle() {
  const cupDef = raceMode === "cup" ? cupById(_cupChoice) : null;
  if (_mapCycleTimer) { clearInterval(_mapCycleTimer); _mapCycleTimer = null; }
  // Cup previews aren't editable — drop the Edit affordance while cycling.
  document.getElementById("menu-map-btn")?.classList.toggle("map-no-edit", !!cupDef);
  const canvas = document.getElementById("menu-map");
  if (!cupDef || !canvas) {
    if (canvas) canvas.style.opacity = "1";
    refreshMenuMap(); // restore the live-world map
    return;
  }
  _mapCycleIdx = _cupState && _activeCup && _activeCup.id === cupDef.id ? _cupState.race : 0;
  const label = document.getElementById("menu-map-label");
  const paint = () => {
    const race = cupDef.races[_mapCycleIdx % cupDef.races.length];
    paintTrackMap(canvas, previewLoopPoints(race.cfg));
    if (label) label.textContent = `${cupDef.emoji} ${cupDef.name} · Race ${(_mapCycleIdx % cupDef.races.length) + 1}/${cupDef.races.length}`;
  };
  paint();
  canvas.style.opacity = "1";
  _mapCycleTimer = setInterval(() => {
    if (state !== State.MENU || _garageOpen || flowStep !== "startline") return; // idle unless the board is up
    canvas.style.opacity = "0";
    setTimeout(() => {
      _mapCycleIdx = (_mapCycleIdx + 1) % cupDef.races.length;
      paint();
      canvas.style.opacity = "1";
    }, 420); // matches the CSS opacity transition
  }, 3200);
}

// Cat-alog: the Prizes page (everything you can win + how) is the main view;
// the second tab holds the trophy shelf, achievements and career stats.
const catalogEl = document.getElementById("catalog");

// ✨ burst — the little dopamine pop for claiming a badge or buying a prize:
// sparkle glyphs fly out from the element's centre and fade (direction via
// inline CSS vars, see .sparkle / @keyframes sparkle-fly).
function sparkleBurst(el, n = 10) {
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    s.className = "sparkle";
    s.textContent = ["✨", "⭐", "🌟"][i % 3];
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const dist = 30 + Math.random() * 30;
    s.style.setProperty("--sx", `${Math.round(Math.cos(ang) * dist)}px`);
    s.style.setProperty("--sy", `${Math.round(Math.sin(ang) * dist - 10)}px`);
    s.style.animationDelay = `${(Math.random() * 0.12).toFixed(2)}s`;
    el.appendChild(s);
    setTimeout(() => s.remove(), 950);
  }
}

// First tap on a locked, priced prize → an in-tile confirm ("Get X for 🐟N?");
// Yes → buy, sparkle, tile flips to owned. Can't afford → a shake + how much is
// missing. The garage's Buy button still works; this is the Cat-alog's own till.
function beginPrizeBuy(tile, id, name, price) {
  if (isUnlocked(profile, id) || tile.querySelector(".prize-confirm")) return;
  const c = document.createElement("div");
  c.className = "prize-confirm";
  if (profile.treats < price) {
    c.innerHTML = `<span class="pc-text">Need 🐟 ${price - profile.treats} more</span>`;
    tile.appendChild(c);
    tile.classList.add("shake");
    uiCue("error");
    setTimeout(() => { c.remove(); tile.classList.remove("shake"); }, 1400);
    return;
  }
  const txt = document.createElement("span");
  txt.className = "pc-text";
  txt.textContent = `Get ${name} for 🐟 ${price}?`;
  const yes = document.createElement("button");
  yes.className = "pc-yes";
  yes.textContent = "✓ Yes!";
  yes.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!buyUnlock(profile, id)) { c.remove(); return; }
    saveProfile();
    refreshTreatsChip();
    c.remove();
    sparkleBurst(tile, 12);
    uiCue("success");
    tile.classList.add("owned", "just-bought");
    tile.classList.remove("buyable");
    const how = tile.querySelector(".prize-how");
    if (how) how.textContent = "✓ yours";
    const bal = document.getElementById("catalog-treats");
    if (bal) bal.textContent = `🐟 ${profile.treats}`;
  });
  const no = document.createElement("button");
  no.className = "pc-no";
  no.textContent = "✕";
  no.addEventListener("click", (ev) => { ev.stopPropagation(); c.remove(); });
  c.append(txt, yes, no);
  tile.appendChild(c);
}

// The badge-claim interstitial: shown on the way from results to the menu when
// badges are waiting. Every card must be tapped (each pays with a sparkle
// burst) before Continue appears — claiming IS the moment, so it can't be
// scrolled past. With nothing pending it goes straight through to onDone.
function showClaimScreen(onDone) {
  const pending = ACHIEVEMENTS.filter((a) => profile.pendingClaims.includes(a.id));
  if (!pending.length) { onDone(); return; }
  const scr = document.getElementById("claim-screen");
  const list = document.getElementById("claim-list");
  const cont = document.getElementById("claim-continue");
  if (!scr || !list || !cont) { onDone(); return; }
  list.innerHTML = "";
  cont.classList.add("hidden");
  for (const a of pending) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "claim-card";
    card.innerHTML = `<span class="claim-medal">🏅</span><span class="claim-text"><span class="claim-name">${a.name}</span><span class="claim-desc">${a.desc}</span></span><span class="claim-cta">TAP! +${a.pay}</span>`;
    card.addEventListener("click", () => {
      const paid = claimAchievement(profile, a.id);
      if (!paid) return;
      saveProfile();
      refreshTreatsChip();
      sparkleBurst(card, 14);
      uiCue("success");
      card.classList.add("claimed");
      card.disabled = true;
      card.querySelector(".claim-cta").textContent = `+${paid.pay} 🐟`;
      if (!profile.pendingClaims.length) cont.classList.remove("hidden");
    });
    list.appendChild(card);
  }
  cont.onclick = () => { scr.classList.add("hidden"); onDone(); };
  scr.classList.remove("hidden");
  uiCue("chime"); // gentle "you've got badges" attention
}
function prizeTile(id, name, colorHex, how, owned) {
  const d = document.createElement("div");
  d.className = "prize-tile" + (owned ? " owned" : "");
  // Real render of the prize (tools/catalog-shots.mjs). If a shot is missing,
  // fall back to the old colour swatch so the tile never shows a broken image.
  const im = document.createElement("img");
  im.className = "prize-shot";
  im.alt = name;
  im.loading = "lazy";
  im.src = `assets/catalog/${id.replace(".", "-")}.jpg`;
  im.addEventListener("error", () => {
    const sw = document.createElement("span");
    sw.className = "prize-swatch";
    sw.style.background = colorHex;
    im.replaceWith(sw);
  });
  const nm = document.createElement("span");
  nm.className = "prize-name";
  nm.textContent = name;
  const st = document.createElement("span");
  st.className = "prize-how";
  st.textContent = owned ? "✓ yours" : how;
  d.append(im, nm, st);
  const e = catalogEntry(id);
  if (!owned && e && typeof e.price === "number" && e.price > 0) {
    d.classList.add("buyable");
    d.addEventListener("click", () => beginPrizeBuy(d, id, name, e.price));
  }
  return d;
}
function prizeHow(id) {
  const e = catalogEntry(id);
  if (!e) return "";
  if (typeof e.price === "number" && e.price > 0) return `🐟 ${e.price}`;
  if (e.cup) { const c = cupById(e.cup); return `🏆 win the ${c ? c.name : e.cup}`; }
  if (e.diff) return e.diff === "hard" ? "🎖 win any cup on Hard" : "🎖 win any cup on Medium+";
  return "free";
}
function renderPrizes() {
  const box = document.getElementById("catalog-prizes");
  if (!box) return;
  box.innerHTML = "";
  const head = (t) => { const h = document.createElement("div"); h.className = "prize-head"; h.textContent = t; box.appendChild(h); };
  head("🐱 Cats");
  const catGrid = document.createElement("div");
  catGrid.className = "prize-grid";
  CAT_PRESETS.forEach((c, i) => {
    const id = `cat.${i}`;
    catGrid.appendChild(prizeTile(id, c.name, _hex6(c.fur), prizeHow(id), isUnlocked(profile, id)));
  });
  box.appendChild(catGrid);
  head("🏎 Karts");
  const kartGrid = document.createElement("div");
  kartGrid.className = "prize-grid";
  KART_PRESETS.forEach((k, i) => {
    const id = `kart.${i}`;
    kartGrid.appendChild(prizeTile(id, k.name, _hex6(k.color), prizeHow(id), isUnlocked(profile, id)));
  });
  box.appendChild(kartGrid);
  head("✨ Creators");
  const cGrid = document.createElement("div");
  cGrid.className = "prize-grid";
  cGrid.appendChild(prizeTile("custom.cat", "Custom Cat", "#f0a830", prizeHow("custom.cat"), isUnlocked(profile, "custom.cat")));
  cGrid.appendChild(prizeTile("custom.kart", "Custom Kart", "#e53935", prizeHow("custom.kart"), isUnlocked(profile, "custom.kart")));
  box.appendChild(cGrid);
}
function setCatalogTab(prizes) {
  document.getElementById("catalog-prizes")?.classList.toggle("hidden", !prizes);
  document.getElementById("catalog-page-ach")?.classList.toggle("hidden", prizes);
  document.getElementById("catalog-tab-prizes")?.classList.toggle("is-active", prizes);
  document.getElementById("catalog-tab-ach")?.classList.toggle("is-active", !prizes);
}
document.getElementById("catalog-tab-prizes")?.addEventListener("click", () => setCatalogTab(true));
document.getElementById("catalog-tab-ach")?.addEventListener("click", () => setCatalogTab(false));
function renderCatalog() {
  renderPrizes();
  setCatalogTab(true); // Prizes is the main page
  refreshTreatsChip();
  const bal = document.getElementById("catalog-treats");
  if (bal) bal.textContent = `🐟 ${profile.treats}`;
  const shelf = document.getElementById("catalog-trophies");
  if (shelf) {
    shelf.innerHTML = "";
    for (const cup of CUPS) {
      const won = profile.trophies[cup.id];
      const d = document.createElement("div");
      d.className = "shelf-cup" + (won ? " won" : "");
      d.innerHTML = `<span class="shelf-emoji">${won ? "🏆" : cup.emoji}</span><span class="shelf-name">${cup.name}</span><span class="shelf-diff">${won ? won : "not won"}</span>`;
      shelf.appendChild(d);
    }
  }
  const list = document.getElementById("catalog-achievements");
  if (list) {
    list.innerHTML = "";
    for (const a of ACHIEVEMENTS) {
      const got = profile.achievements.includes(a.id);
      const pend = profile.pendingClaims.includes(a.id);
      const d = document.createElement("div");
      d.className = "ach-row" + (got ? " got" : "");
      d.innerHTML = `<span class="ach-mark">${got ? "🏅" : "⬜"}</span><span class="ach-text"><span class="ach-name">${a.name}</span><span class="ach-desc">${a.desc}</span></span><span class="ach-pay">${pend ? "" : `🐟 ${a.pay}`}</span>`;
      // A badge earned but never claimed (e.g. the player skipped the results
      // screen) keeps its CLAIM button here, so the treats are never lost.
      if (pend) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ach-claim";
        b.textContent = `CLAIM +${a.pay}`;
        b.addEventListener("click", () => {
          if (!claimAchievement(profile, a.id)) return;
          saveProfile();
          refreshTreatsChip();
          sparkleBurst(d, 10);
          b.replaceWith(Object.assign(document.createElement("span"), { className: "ach-pay", textContent: `+${a.pay} 🐟` }));
          const bal = document.getElementById("catalog-treats");
          if (bal) bal.textContent = `🐟 ${profile.treats}`;
        });
        d.appendChild(b);
      }
      list.appendChild(d);
    }
  }
  const st = document.getElementById("catalog-stats");
  if (st) {
    const s = profile.stats;
    st.textContent = `${s.races} races · ${s.wins} wins · ${s.boxes} boxes · ${s.treatsEarned} treats earned`;
  }
}
document.getElementById("open-catalog")?.addEventListener("click", () => {
  renderCatalog();
  openSubScreen(catalogEl);
});
document.getElementById("catalog-back")?.addEventListener("click", () => closeSubScreen(catalogEl));

// Backup: the whole profile as a copy-paste code (Settings → Progress).
document.getElementById("backup-copy")?.addEventListener("click", async () => {
  const tok = encodeProfileToken(profile);
  let copied = false;
  try { await navigator.clipboard.writeText(tok); copied = true; } catch { /* ignore */ }
  if (!copied) window.prompt("Copy your backup code:", tok);
  const note = document.getElementById("backup-note");
  if (note) note.textContent = copied ? "Backup code copied to the clipboard ✓" : "Copy the code from the box above.";
});
document.getElementById("backup-restore")?.addEventListener("click", () => {
  const tok = window.prompt("Paste your backup code (ZP1.…):", "");
  if (!tok) return;
  const restored = decodeProfileToken(tok);
  const note = document.getElementById("backup-note");
  if (!restored) { if (note) note.textContent = "That code didn't parse — check it and try again."; return; }
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(restored)); } catch { /* ignore */ }
  if (note) note.textContent = "Profile restored — reloading…";
  markReload("profile-restore");
  setTimeout(() => location.reload(), 400);
});

// Developer mode: hidden until ?dev=1 or 7 taps on the Settings title.
function applyDevUI() {
  document.getElementById("dev-card")?.classList.toggle("hidden", !devMode);
}
let _devTaps = 0;
document.querySelector("#settings h1")?.addEventListener("click", () => {
  if (devMode) return;
  if (++_devTaps >= 7) {
    devMode = true;
    try { localStorage.setItem(DEV_KEY, "1"); } catch { /* ignore */ }
    installDevApi();
    applyDevUI();
  }
});
document.getElementById("dev-treats")?.addEventListener("click", () => {
  profile.treats += 1000;
  saveProfile();
  refreshTreatsChip();
});
document.getElementById("dev-unlock")?.addEventListener("click", () => {
  for (const a of ACHIEVEMENTS) if (!profile.achievements.includes(a.id)) profile.achievements.push(a.id);
  for (const e of ["cat.3","cat.4","cat.5","cat.6","cat.7","cat.8","cat.9","kart.3","kart.4","kart.5","kart.6","kart.7","kart.8","custom.cat","custom.kart"]) {
    if (!profile.unlocked.includes(e)) profile.unlocked.push(e);
  }
  for (const cup of CUPS) if (!profile.trophies[cup.id]) profile.trophies[cup.id] = "hard";
  saveProfile();
  refreshTreatsChip();
});
document.getElementById("dev-reset")?.addEventListener("click", () => {
  if (!window.confirm("Reset ALL progression (treats, unlocks, trophies, achievements)?")) return;
  try { localStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ }
  markReload("profile-reset");
  location.reload();
});
document.getElementById("dev-off")?.addEventListener("click", () => {
  devMode = false;
  try { localStorage.removeItem(DEV_KEY); } catch { /* ignore */ }
  applyDevUI();
});
// Console API for the same powers (guarded by dev mode).
function installDevApi() {
  if (!devMode || !window.__zoomies) return;
  window.__zoomies.dev = {
    grantTreats(n = 1000) { profile.treats += Math.max(0, n | 0); saveProfile(); refreshTreatsChip(); return profile.treats; },
    unlockAll() { document.getElementById("dev-unlock")?.click(); return profile.unlocked.length; },
    profile() { return profile; },
    exportToken() { return encodeProfileToken(profile); },
  };
}
installDevApi();
applyDevUI();
refreshTreatsChip();


// A canonical invite URL for the current room (origin + path + ?seed=…&mp=1),
// independent of whatever junk is on location.href right now.
function inviteURL() {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("seed", WORLD_SEED);
  u.searchParams.set("mp", "1");
  // Carry the FULL world (track config + laps), so a friend who opens the link builds
  // the exact same map — the room code alone only ever carried the seed, which left
  // players on different tracks.
  const w = encodeWorld(currentWorld());
  if (w) u.searchParams.set("w", w);
  // P2P is the default, so a normal link needs no flag (both ends default on).
  // Only propagate an opt-OUT, so a host who forced the Ably relay keeps guests
  // on the same transport.
  if (!rtcEnabled()) u.searchParams.set("rtc", "0");
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

// --- Race-entry veil ---
// The first moments of COUNTDOWN are where the remaining big hitches live:
// buildKarts' allocation burst, the GC that follows it, and the first-view
// shader/pipeline compiles as the start-line scene comes on screen. Rather than
// let the player watch those as freezes during the camera swing, hold a
// "GET READY" cover over the stage and freeze the countdown clock until frames
// prove stable (or a hard cap expires — a slow device still gets to race).
// Solo only: a multiplayer countdown runs off the shared network clock and
// can't be held for one client.
const raceVeilEl = document.getElementById("race-veil");
let _veilActive = false;
let _veilStartedAt = 0;
let _veilStableMs = 0;
const VEIL_STABLE_FRAME_MS = 90; // a frame under this counts toward "stable"
// A longer smooth streak before the veil drops (600 → 1100ms): the player has
// said they'd rather wait at "GET READY" a beat longer than feel stragglers
// (late compiles, GC after the kart build) land inside the countdown or GO.
const VEIL_STABLE_NEED_MS = 1100;
const VEIL_MAX_MS = 9000; // hard cap: never hold the race longer than this
let _veilHideTimer = 0;
function showRaceVeil() {
  if (!raceVeilEl) return;
  _veilActive = true;
  _veilStartedAt = performance.now();
  _veilStableMs = 0;
  clearTimeout(_veilHideTimer); // a still-pending fade-out must not re-hide us
  raceVeilEl.classList.remove("hidden", "fading");
}
function hideRaceVeil() {
  _veilActive = false;
  if (!raceVeilEl || raceVeilEl.classList.contains("hidden")) return;
  raceVeilEl.classList.add("fading"); // CSS opacity transition
  _veilHideTimer = setTimeout(() => raceVeilEl.classList.add("hidden"), 400);
}

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

  // Veil FIRST, heavy build second. prepareRace (buildKarts + ghost + warmups)
  // lands in one long frame — running it synchronously in the tap handler froze
  // the still-visible menu before the veil ever painted (the reported "freeze
  // when starting a race"). Two rAFs guarantee the browser has painted the
  // veil, THEN the same stall happens invisibly behind it.
  if (_racePrepPending) return; // double-tap while the deferred build is queued
  _racePrepPending = true;
  showRaceVeil(); // hold the countdown behind a cover until frames settle
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _racePrepPending = false;
    prepareRace();
    countdown = 2.999; // "3","2","1" for 1s each, GO exactly as control unlocks
    countdownCalibrated = false;
    prevCountN = 99;
    track.setStartLight?.("off"); // gantry dark until the countdown's first red
    state = State.COUNTDOWN;
    // Behind the veil, redo the draw-everything pass with the RACE scene (karts,
    // ghost, warmed effects now exist): any pipeline/upload the boot pass could
    // not have covered takes its hit here instead of mid-race. The veil's
    // stability gate won't drop until these heavy frames are done. This fully
    // supersedes the 12-view prewarm spin (same pipelines, fewer renders) — and
    // the two must never overlap (12 renders × culling disabled = one huge frame).
    _prewarmed = true;
    beginWarmAll(2);
  }));
}
let _racePrepPending = false;

// Everything to spin up a race that does NOT need a user gesture — so it can run
// both from the local START click and from a network-triggered synchronized start.
function prepareRace() {
  _raceParked = false; // starting fresh; nothing parked to resume
  _raceStats = { driftBoosts: 0, slipSeconds: 0, milkTrips: 0, zaps: 0, heartSaves: 0, boxes: 0 };
  _racePaid = false;
  document.getElementById("results-earnings")?.classList.add("hidden");
  document.getElementById("results-next-btn")?.classList.add("hidden");
  refreshResumeBtn();
  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  const _hudEl = document.getElementById("hud");
  _hudEl.classList.remove("hidden");
  _hudEl.classList.remove("victory-hidden"); // fresh race → controls back

  // This world's time of day (midday/sunset/night), fixed per seed and already
  // applied at load. Precipitation is separate — dictated by the biome you drive
  // through (see the loop).
  const mood = MOOD;
  applyMood(mood);
  weather.setWeather("none");
  moodSat = mood.sat;
  moodContrast = mood.contrast;
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
  // Warm the race effects' GPU pipelines during the countdown, where a stalled
  // frame is invisible: one near-invisible particle per texture field, one
  // degenerate skid quad, and one ghost hairball — all far underground. Their
  // first mid-race appearances were each a 0.5-1s pipeline-compile freeze on
  // iOS/WebGPU.
  if (player) {
    _warmPos.set(player.position.x, player.position.y - 45, player.position.z);
    effects.warmup(_warmPos);
    hairballs.spawnAt(_warmPos, _warmDir, 0); // ghost ball: no owner, no collisions
  }
  // NOTE: r185's compileAsync no longer crashes, but on-device it made things
  // WORSE here: it requests pipelines for the WHOLE scene and the next render
  // waits on the batch (device log: "91 creates · render 3504ms"-class freezes
  // at exactly the call sites). The draw-based warms above remain the fix.
  updateBoostUI(); // karts start with an empty boost meter
  applyMpQuality(); // iOS: force Low in multiplayer (GPU device-loss safety), else restore
  // Power-up boxes are a competitive item — off in time trial (a solo run against
  // the clock has no rivals to use them on, and they'd pollute the ghost lap).
  props?.setItemsEnabled?.(!timeTrial);
  raceTime = 0;
  items.clear(); // no yarn/puddles carry over between races
  _yarnWarnLast = null;
  yarnWarnEl?.classList.add("hidden");
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
  // Track fingerprint — the map I built. If a host advertises a DIFFERENT world
  // than mine, flag it red so a desync is obvious at a glance (the adopt-reload
  // should then pull me onto the host's map; if it can't, the mismatch stays
  // visible instead of silently racing on two tracks).
  const trackEl = document.getElementById("lobby-track");
  if (trackEl) {
    let hostWorld = null;
    for (const r of MP.remotes.values()) if (r.host && r.world) { hostWorld = r.world; break; }
    const mismatch = hostWorld && !_amHost && !sameWorld(hostWorld, currentWorld());
    trackEl.textContent = mismatch
      ? `⚠ syncing map… (${worldFingerprint(hostWorld)})`
      : worldFingerprint(currentWorld());
    trackEl.classList.toggle("mismatch", !!mismatch);
  }
  if (!MP.enabled || !MP.net) return; // the player list / count need a live connection
  const countEl = document.getElementById("lobby-count");
  if (countEl) countEl.textContent = `${Math.min(mpPlayerCount(), MAX_PLAYERS)} / ${MAX_PLAYERS}`;
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
  // No host in the room yet (everyone arrived via an ?mp=1 link)? Let anyone launch
  // — clicking Start claims host first (see the lobby-start handler). So a room can
  // never get stuck with nobody able to start.
  const canStart = host || !mpHostId();
  const startBtn = document.getElementById("lobby-start");
  const waiting = document.getElementById("lobby-waiting");
  const ready = document.getElementById("lobby-ready");
  if (startBtn) startBtn.style.display = canStart ? "" : "none"; // host (or a hostless room) launches
  if (waiting) waiting.style.display = canStart ? "none" : "";   // others wait for the host
  if (ready) ready.style.display = canStart ? "none" : "";       // joiner: enable tilt first
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
  document.getElementById("results").classList.add("hidden");
  document.getElementById("menu").classList.remove("hidden");
  flowGo("lobby"); // slides in over the world tour
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
  track.setStartLight?.("off"); // gantry dark until the countdown's first red
  state = State.COUNTDOWN;
  // Same supersession as the solo start: two draw-everything frames replace the
  // single 12-render prewarm freeze (MP has no veil, so cheaper is better).
  _prewarmed = true;
  beginWarmAll(2);
}

const COUNTDOWN_LEAD_MS = 4000;
const lobbyStartBtn = document.getElementById("lobby-start");
if (lobbyStartBtn) {
  lobbyStartBtn.addEventListener("click", () => {
    if (!MP.enabled || !MP.net) return;
    // Hostless room (everyone joined via a link): claim host, then launch.
    if (!mpIsHost()) {
      if (mpHostId()) return; // a real host exists — this button shouldn't have shown
      claimHost();
    }
    const at = MP.net.now() + COUNTDOWN_LEAD_MS;
    MP.net.sendStart(at);
    beginSyncedRace(at);
  });
}

// --- Camera follow ---
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
let _camYPrev = NaN; // last frame's clamped camera height (vertical rate limiter)
let _camPitch = NaN; // last frame's smoothed look pitch (rad) — see the pitch rate limiter
// Scratch vectors for updateCamera — reused every frame so the camera path
// allocates nothing per frame. (_camFwd is shared with updateAtmosphere's
// facing test; both write before they read, so the reuse is safe.)
const _camDesired = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _camAim = new THREE.Vector3(); // aim point after pitch-stabilising against eye clamps
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
    let winner = null;
    for (const k of karts) if (k.finished) { winner = k; break; }
    if (!winner && MP.enabled) for (const r of MP.remotes.values()) if (r.finished) { winner = r; break; }
    // `winner` is null until someone crosses the line (i.e. the whole race), and
    // may be the local Kart (.position) OR a RemoteKart wrapper (position at
    // .kart.position). Guard for BOTH: the null case (no finisher yet) OR reading
    // .position off a RemoteKart threw here every frame — the null case froze EVERY
    // race at the green light; the RemoteKart case froze 2nd place when the host won.
    const wp = winner && (winner.position || (winner.kart && winner.kart.position));
    if (wp) {
      const dx = wp.x - track.archApex.x;
      const dz = wp.z - track.archApex.z;
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
      // Two firework sets, alternating LEFT/RIGHT from the mortar pots flanking
      // the arch (shells burst in a column above each pot) — instead of popping
      // out of the arch itself.
      const pots = track.fwLaunchers;
      if (pots && pots.length === 2) {
        _fwSide = 1 - _fwSide;
        const base = pots[_fwSide];
        _fwPos.set(
          base.x + (Math.random() - 0.5) * 2.5,
          base.y + 5 + Math.random() * 5,
          base.z + (Math.random() - 0.5) * 2.5
        );
      } else {
        _fwPos.copy(track.archApex); // fallback: burst from the arch
        _fwPos.x += (Math.random() - 0.5) * 7;
        _fwPos.y += Math.random() * 3;
        _fwPos.z += (Math.random() - 0.5) * 2;
      }
      effects.fireworkBurst(_fwPos);
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
  // The capture below (drawImage of the renderer's canvas into a 2D canvas) is
  // a SYNCHRONOUS GPU->CPU readback of a full-res frame, every frame of the
  // fade — on iOS/WebGPU that's a ~1s main-thread stall per menu transition
  // (the "0 shader creates" freezes in the device log). WebGPU menus hard-cut
  // instead: the camera drift keeps the shot change feeling deliberate. The
  // dissolve stays on WebGL2, where the readback is cheap.
  const canCapture = !!menuXfadeCtx && !renderer?.backend?.isWebGPUBackend;
  if (_menuPhase === "fading" && !canCapture) {
    _menuPhase = "hold"; // skip the fade entirely: render the incoming shot
    _menuShotT = 0; // restart the hold timer, as a completed fade would
    if (menuXfade) menuXfade.style.opacity = 0;
  }
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
    _camDesired.set(
      player.position.x + Math.sin(_finishCamAngle) * r,
      player.position.y + 6,
      player.position.z + Math.cos(_finishCamAngle) * r
    );
    _camLook.set(player.position.x, player.position.y + 1.5, player.position.z);
    const lerp = snap ? 1 : 1 - Math.pow(0.02, dt);
    camPos.lerp(_camDesired, lerp);
    camTarget.lerp(_camLook, lerp);
    featureCameraClamp(track.features, track, camPos); // victory orbit can sweep into tunnel rock
    camera.fov += (62 - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
    camera.position.copy(camPos);
    camera.lookAt(camTarget);
    return;
  }

  _camFwd.set(Math.sin(player.heading), 0, Math.cos(player.heading));
  _camDesired.copy(player.position).addScaledVector(_camFwd, -13);
  _camDesired.y += 7 + player.y * 0.5;
  _camLook.copy(player.position).addScaledVector(_camFwd, 6);
  _camLook.y += 1.5 + player.y;

  const lerp = snap ? 1 : 1 - Math.pow(0.001, dt);
  camPos.lerp(_camDesired, lerp);
  camTarget.lerp(_camLook, lerp);
  const naturalCamY = camPos.y; // eye height BEFORE the collision clamps shove it around

  // Keep the camera above the track surface beneath it: on a steep descent the
  // spot behind the kart is up-slope (higher ground), which could otherwise leave
  // the camera buried under the road. STRAND-AWARE: the plain 2D nearest-road
  // height is wrong wherever two strands stack (crossover decks, stacked
  // passes beside an overpass) — it returned the DECK overhead and launched
  // the camera into its underside while the kart drove below. Biasing the
  // query by the kart's own height keeps the clamp on the kart's road.
  const camGroundY = track.groundYNear(camPos.x, camPos.z, player.position.y);
  if (camPos.y < camGroundY + 3) camPos.y = camGroundY + 3;

  // Don't let the camera poke into a tunnel's mountain: hugging the bore wall
  // (or reversing sideways inside) can park the camera in solid rock.
  featureCameraClamp(track.features, track, camPos);

  // Vertical rate limiter: the clamps above are HARD (they must be — they keep
  // the camera out of roads and rock), but the moment one disengages the
  // camera used to snap several units in a frame or two — leaving a tunnel
  // (ceiling clamp lets go, ground clamp on the ridge behind releases as the
  // road drops away) read as the view lurching down for a beat. Ease toward
  // the new height instead, while the geometry floors/ceilings still win
  // instantly (re-applied after the ease so a low bore can never be clipped).
  if (!snap && Number.isFinite(_camYPrev)) {
    const cap = (camPos.y > _camYPrev ? 9 : 18) * dt; // rise gently; fall fast enough for max-grade descents
    const dy = camPos.y - _camYPrev;
    if (Math.abs(dy) > cap) {
      camPos.y = _camYPrev + Math.sign(dy) * cap;
      if (camPos.y < camGroundY + 3) camPos.y = camGroundY + 3;
      featureCameraClamp(track.features, track, camPos);
    }
  }
  _camYPrev = camPos.y;

  // Pitch stabiliser (fixes the tunnel-mouth "weird angle"). The clamps above move
  // only the EYE (camPos.y) to keep it out of road/rock, but the aim (camTarget.y)
  // tracks the kart freely — so entering/leaving a tunnel, where the ground-behind-
  // the-portal and bore clamps shove the eye up then release, `lookAt` swung the
  // pitch. Carry most of that eye displacement into the aim so the framing ANGLE
  // stays steady while the eye still dodges geometry. Partial (0.7) so genuine
  // climbs/descents keep a little natural tilt.
  const camLift = camPos.y - naturalCamY;
  _camAim.copy(camTarget);
  _camAim.y += camLift * 0.7;

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

  // Pitch rate limiter — the general fix for the "weird camera angle" on sharp
  // hill crests and fast tunnel exits. The camLift stabiliser above only cancels
  // CLAMP-induced eye lift; it can't tame the pitch swing from the natural geometry
  // (cresting a hill flips the look from up-slope to down-slope) or the residual
  // from the vertical rate limiter — and at speed those swings land in a frame or
  // two. So cap how fast the vertical framing ANGLE itself may change: ease toward
  // the target pitch, but never faster than a fixed rad/s, then rebuild the aim at
  // that smoothed pitch (keeping its horizontal/yaw direction). Computed from the
  // pre-shake eye so screen shake never feeds the smoother.
  const _dx = _camAim.x - camPos.x, _dy = _camAim.y - camPos.y, _dz = _camAim.z - camPos.z;
  const _horiz = Math.hypot(_dx, _dz) || 1e-3;
  const _tgtPitch = Math.atan2(_dy, _horiz);
  if (snap || !Number.isFinite(_camPitch)) {
    _camPitch = _tgtPitch;
  } else {
    const _eased = (_tgtPitch - _camPitch) * (1 - Math.pow(0.02, dt)); // smooth follow on gentle terrain
    const _cap = 1.6 * dt; // rad/s ceiling — bounds the violent one-frame swings
    _camPitch += Math.max(-_cap, Math.min(_cap, _eased));
  }
  _camAim.y = camPos.y + _horiz * Math.tan(_camPitch);
  camera.lookAt(_camAim);
}

// --- Kart-vs-kart bumper collisions ---
// Heavier karts (the player) shove lighter ones aside and barely slow down, so
// you can push your way through traffic. Impulses go into each kart's decaying
// `knock` velocity for a springy bumper-car feel.
// Shared kart-vs-kart collision constants (KART_COLLIDE_MIN, kartBumpPower) are
// imported from net/session.js and used by BOTH this single-player path and the
// multiplayer remote-kart path, so the two can never drift out of parity.

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

// Multiplayer: bump against remote ghost karts (the full resolution lives in
// MpSession.resolveRemoteCollisions — we only ever move OUR OWN player out of
// the overlap, since the ghost's pose is network-driven; the other client
// resolves the mirror collision against our ghost, so both sides agree with no
// referee).
function resolveRemoteCollisions() {
  MP.resolveRemoteCollisions(player);
}

// --- Placement ---
// In multiplayer, remote ghost karts join the field as real participants: each
// broadcasts its totalProgress, so a "2nd / 4" agrees across every screen.
// Persistent scratch + hoisted comparator: this runs every racing frame, and the
// old spread + closure pair allocated on each call.
const _placeField = [];
function _placeCmp(a, b) {
  if (a.finished && b.finished) {
    // Rank by the shared-clock finish instant when both have one (multiplayer);
    // fall back to elapsed time for AI / solo where every clock is local.
    if (a.finishClock && b.finishClock) return a.finishClock - b.finishClock;
    return a.finishTime - b.finishTime;
  }
  if (a.finished) return -1;
  if (b.finished) return 1;
  return b.totalProgress - a.totalProgress;
}
function updatePlacement() {
  let n = 0;
  for (const k of karts) _placeField[n++] = k;
  if (MP.enabled) for (const r of MP.remotes.values()) _placeField[n++] = r;
  _placeField.length = n;
  _placeField.sort(_placeCmp);
  for (let i = 0; i < n; i++) _placeField[i].place = i + 1;
  _fieldCount = n; // size of the field, for position-weighted item rolls
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
// Fire whatever the trigger is loaded with: an armed yarn ball takes over the
// shot slot for one roll, then the button goes back to furballs.
function fireShot(kart, charge = 0) {
  if (kart.yarnShots > 0) return fireYarn(kart);
  return fireHairball(kart, charge);
}

// Roll a yarn ball at the nearest kart ahead on the lap (it follows the track
// and homes weakly — see items.js). Same trigger rules as the furball.
function fireYarn(kart) {
  if (kart.shootCooldown > 0 || kart.spinTimer > 0 || kart.finished) return false;
  kart.yarnShots = 0;
  let target = null;
  let best = 0.28; // only lock on within a workable window (fraction of a lap)
  for (const other of karts) {
    if (other === kart || other.finished) continue;
    let gap = (other.trackT - kart.trackT) % 1;
    if (gap < 0) gap += 1;
    if (gap < best) {
      best = gap;
      target = other;
    }
  }
  // Multiplayer: rivals are remote ghosts (not in `karts`). Lock onto the nearest
  // ghost ahead by lap progress (ghosts have no trackT) and home on the ghost the
  // shooter sees, so the authoritative world-space hit matches the shooter's screen.
  let tgtRemote = null;
  if (MP.enabled) {
    for (const r of MP.remotes.values()) {
      if (!r._ready || r.finished) continue;
      const rf = ((r.totalProgress % 1) + 1) % 1; // within-lap fraction
      let gap = (rf - kart.trackT) % 1;
      if (gap < 0) gap += 1;
      if (gap < best) { best = gap; tgtRemote = r; target = r.kart; }
    }
  }
  const y = items.spawnYarn(kart, target);
  effects.tootBurst(kart, 1.4, false); // launch kick: the ball leaves in a puff
  audio.shoot(kart === player ? null : kart.position);
  kart.shootCooldown = SHOOT_RECHARGE;
  // Replicate the ball (exact values read back from the record) so every client
  // renders a homing ghost; the hit rides sendHit from items.update, like hairballs.
  if (MP.enabled && MP.net && kart === player) {
    MP.net.sendYarn(y.t, y.lat, y.speed, tgtRemote ? tgtRemote.id : null, y.life);
  }
  return true;
}

// Shim + colour for the yarn's rolling dust plume (effects.dust wants a
// kart-shaped record; one reused object, zero per-frame allocation).
const _yarnShim = { position: null, heading: 0, groundY: 0 };
const _yarnDustCol = new THREE.Color(0xd9b6a0);

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
    // Incoming yarn: the read is ETA-based (slow homing roller, not a straight
    // shot). Each incoming ball gets ONE plan, decided when it first pings:
    // hop it at the last beat (free, needs timing — favoured mid-drift where a
    // shield would forfeit the charge) or shield it (safe, costs pace + slot).
    const yEta = items.yarnEta(k);
    if (yEta < 1.0) {
      if (!k._yarnPlan) {
        const skill = k.diff ? k.diff.shield : 1;
        const hopBias = k.drifting && k.driftCharge > 0.8 ? 0.75 : 0.4;
        k._yarnPlan = _simRng() < skill * hopBias ? 1 : 2; // 1 = hop, 2 = shield
      }
      if (k._yarnPlan === 2) threat = true;
      else if (yEta < 0.34 && !k.airborne && !k.shielding) k.jump(); // clean hop
    } else {
      k._yarnPlan = 0;
    }
    if (threat && !k._threatPrev) {
      // Sometimes they just don't react — and a charged drift makes shielding
      // genuinely less attractive (raising it forfeits the mini-turbo).
      const keepDrift = k.drifting && k.driftCharge > 1.0 ? 0.55 : 1;
      k._shieldTry = _simRng() < k.shieldSkill * keepDrift;
      k._shieldDelay = 0.18 + _simRng() * 0.32; // human-ish reaction time
    }
    if (threat) k._shieldDelay -= dt;
    k.shielding = threat && k._shieldTry && k._shieldDelay <= 0;
    k._threatPrev = threat;

    // Milk on the line ahead: steer around it; too late and quick enough, hop.
    const pa = items.puddleAhead(k, 30);
    if (pa) {
      let a = Math.atan2(pa.puddle.x - k.position.x, pa.puddle.z - k.position.z) - k.heading;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      if (Math.abs(a) < 0.4) {
        const skill = k.diff ? k.diff.shield : 1;
        const dodge = a >= 0 ? -1 : 1; // swerve to the emptier side
        k.steerInput = Math.max(-1, Math.min(1, k.steerInput + dodge * skill * 0.55));
        if (pa.dist < 11 && k.speed > 13 && !k.airborne && !k.shielding && _simRng() < skill * 0.06) {
          k.jump(); // last-ditch hop (skill-gated, so easy AI eats some spills)
        }
      }
    }

    // Carrying a bottle: spill it when a rival is right on our tail.
    if (k.milkBottles > 0) {
      for (const other of karts) {
        if (other === k || other.finished) continue;
        let gapT = (k.trackT - other.trackT) % 1;
        if (gapT < 0) gapT += 1;
        if (gapT < 42 / track.length && _simRng() < 0.035) {
          k.milkBottles = 0;
          items.dropMilk(k);
          break;
        }
      }
    }

    // --- Toot boost when full, on a straightish stretch (not mid-shield). ---
    if (k.boostMeter >= 1 && !threat && Math.abs(k.steerInput) < 0.45 && k.speed > 8 && !k.boosting) {
      const _over = k.boostMeter > 1.02;
      if (k.tootBoost(k.boostMeter)) {
        k.boostMeter = 0;
        effects.tootBurst(k, _over ? 3.5 : 2);
        audio.toot(k.position);
      }
    }

    // --- Shoot at a kart ahead, gated by the same recharge as the player.
    // ONE ACTION: never while the shield is up, and pulling the trigger moves
    // the thumb off jump — the drift releases (keeping its earned boost, same
    // as the player letting go of jump to shoot). ---
    k._aiShootTimer -= dt;
    if (k.shootCooldown <= 0 && k._aiShootTimer <= 0 && !k.shielding) {
      k._aiShootTimer = (1.0 + Math.random() * 2.2) / (k.diff ? k.diff.shoot : 1); // easier = longer gaps
      // Don't burn a fat drift charge on a pot-shot; wait for the release.
      const driftWorth = k.drifting && k.driftCharge > 0.8;
      if (k.yarnShots > 0 && !driftWorth) {
        // The yarn homes along the track — any rival in the window is a roll.
        let gap = 1;
        for (const other of karts) {
          if (other === k || other.finished) continue;
          let g = (other.trackT - k.trackT) % 1;
          if (g < 0) g += 1;
          gap = Math.min(gap, g);
        }
        if (gap < 0.24 && fireShot(k)) k.driftHeld = false;
      } else if (!driftWorth) {
        for (const other of karts) {
          if (other === k || other.finished) continue;
          _aiTo.subVectors(other.position, k.position);
          const dist = _aiTo.length();
          if (dist > 3 && dist < 46 && _aiTo.normalize().dot(_aiFwd) > 0.8) {
            if (fireShot(k, Math.random() < 0.4 ? 0.8 : 0)) k.driftHeld = false;
            break;
          }
        }
      }
    }

    // ONE ACTION AT A TIME, enforced: a raised shield owns the slot. It drops
    // the drift hold and forfeits any charge — exactly the player's trade.
    if (k.shielding) {
      k.driftHeld = false;
      if (k.drifting) {
        k.drifting = false;
        k.driftCharge = 0;
        k.driftRamp = 0;
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

// Per-frame kart snapshot shared by the prop/string-light updates (and anything
// else that only needs positions/headings). ONE reused array of reused records —
// the old per-consumer raceField().map(...) built two fresh arrays plus a dozen
// object literals every frame, steady GC pressure on mobile.
const _fieldSnap = [];
function fieldSnapshot() {
  let n = 0;
  const take = (k) => {
    if (!k || !k.position) return;
    let s = _fieldSnap[n];
    if (!s) s = _fieldSnap[n] = { x: 0, z: 0, dx: 0, dz: 0, speed: 0, kart: null };
    s.x = k.position.x;
    s.z = k.position.z;
    s.dx = Math.sin(k.heading);
    s.dz = Math.cos(k.heading);
    s.speed = Math.abs(k.speed || 0);
    s.kart = k;
    n++;
  };
  for (const k of karts) take(k);
  if (MP.enabled) for (const r of MP.remotes.values()) take(r.kart);
  _fieldSnap.length = n;
  return _fieldSnap;
}

// --- Race rewards settlement ------------------------------------------------
// Runs ONCE per race, on the first showResults: folds the per-race moment
// counters into the career stats, pays treats, scores the cup, and fires any
// newly earned achievements. Returns everything the earnings panel renders.
function settleRaceRewards() {
  if (_racePaid || timeTrial || !player || !player.finished || !_raceStats) return null;
  _racePaid = true;
  updatePlacement();
  const s = profile.stats;
  s.races++;
  const won = player.place === 1;
  if (won) s.wins++;
  if (won && DIFFICULTY === "hard") s.winsHard++;
  if (won && TIME_OF_DAY === "night") s.winsNight++;
  if (trackConfig.mode === "custom") s.racesCustom++;
  s.driftBoosts += _raceStats.driftBoosts;
  s.slipSeconds += Math.round(_raceStats.slipSeconds);
  s.milkTrips += _raceStats.milkTrips;
  s.zaps += _raceStats.zaps;
  s.heartSaves += _raceStats.heartSaves;
  s.boxes += _raceStats.boxes;
  const daily = _dailyActive && profile.dailyPaid !== todayStr();
  if (daily) { profile.dailyPaid = todayStr(); s.dailies++; }
  const payout = racePayout({
    place: player.place, field: raceField().length, laps: TOTAL_LAPS,
    difficulty: DIFFICULTY, daily, stats: _raceStats,
  });
  profile.treats += payout.total;
  s.treatsEarned += payout.total;
  // Cup scoring: every kart banks points by placement; the final race settles it.
  let cup = null;
  // `scored` guards a restarted cup race from banking its points twice.
  if (_cupState && _activeCup && !MP.enabled && _cupState.scored !== _cupState.race) {
    _cupState.scored = _cupState.race;
    for (const k of raceField()) {
      const name = k === player ? "You" : k.name;
      _cupState.points[name] = (_cupState.points[name] || 0) + cupPoints(k.place);
    }
    const last = _cupState.race >= _activeCup.races.length - 1;
    const standings = cupStandings(_cupState.points);
    cup = { last, standings, cupDef: _activeCup, raceIndex: _cupState.race };
    if (last) {
      cup.award = awardCup(profile, _activeCup.id, standings, "You", DIFFICULTY);
      clearCupRun();
    } else {
      try { sessionStorage.setItem(CUP_KEY, JSON.stringify(_cupState)); } catch { /* ignore */ }
    }
  }
  const fresh = checkAchievements(profile);
  saveProfile();
  refreshTreatsChip();
  return { payout, fresh, cup };
}
function clearCupRun() {
  try { sessionStorage.removeItem(CUP_KEY); } catch { /* ignore */ }
}

// The earnings panel under the standings: itemized treats, achievement banners,
// and — in a cup — the running points table + the Next Race button.
function renderRaceEarnings(settled) {
  const box = document.getElementById("results-earnings");
  const nextBtn = document.getElementById("results-next-btn");
  if (!box) return;
  if (!settled) { return; } // MP re-renders keep the panel from the first settle
  box.innerHTML = "";
  box.classList.remove("hidden");
  const { payout, fresh, cup } = settled;
  for (const l of payout.lines) box.appendChild(earnRow(l.label, `+${l.amt}`));
  box.appendChild(earnRow("Treats earned", `🐟 ${payout.total}`, "earn-total"));
  // Badges are teased here but CLAIMED on the interstitial between results and
  // the menu (showClaimScreen) — that tap is the reward moment.
  for (const a of fresh) box.appendChild(earnRow(`🏅 ${a.name} — ${a.desc}`, "badge!", "earn-ach"));
  if (cup) {
    const head = document.createElement("div");
    head.className = "earn-cup-head";
    head.textContent = `${cup.cupDef.emoji} ${cup.cupDef.name} standings`;
    box.appendChild(head);
    cup.standings.forEach((r, i) => box.appendChild(earnRow(`${i + 1}. ${r.name}`, `${r.pts} pts`, r.name === "You" ? "earn-you" : "")));
    if (!cup.last) {
      document.getElementById("results-title").textContent = `${cup.cupDef.emoji} Race ${cup.raceIndex + 1}/${cup.cupDef.races.length} · ${cup.cupDef.name}`;
      if (nextBtn) {
        nextBtn.textContent = `▶ Race ${cup.raceIndex + 2} of ${cup.cupDef.races.length}`;
        nextBtn.classList.remove("hidden");
      }
    } else {
      const youWon = cup.standings[0] && cup.standings[0].name === "You";
      document.getElementById("results-title").textContent = youWon ? `🏆 ${cup.cupDef.name} Champion!` : `${cup.cupDef.emoji} ${cup.cupDef.name} — ${ordinal(1 + cup.standings.findIndex((r) => r.name === "You"))}`;
      if (cup.award) {
        if (cup.award.treats > 0) box.appendChild(earnRow(`🏆 ${cup.cupDef.name} won`, `+${cup.award.treats}`, "earn-ach"));
        if (cup.award.unlockId) box.appendChild(earnRow(`🎁 Exclusive unlocked: ${unlockName(cup.award.unlockId)}`, "NEW", "earn-ach"));
        for (const id of cup.award.extraUnlocks || []) box.appendChild(earnRow(`🎖 ${AI_DIFFICULTY[DIFFICULTY].label} prize unlocked: ${unlockName(id)}`, "NEW", "earn-ach"));
        if (!cup.award.firstWin && cup.award.upgraded) box.appendChild(earnRow(`🏆 Trophy upgraded to ${cup.award.difficulty}`, "", "earn-ach"));
        if (cup.award.unlockId || (cup.award.extraUnlocks || []).length) uiCue("sparkle"); // a prize was revealed
      }
    }
  }
}
function earnRow(label, amt, cls = "") {
  const li = document.createElement("div");
  li.className = "earn-row" + (cls ? " " + cls : "");
  const l = document.createElement("span");
  l.textContent = label;
  const a = document.createElement("span");
  a.textContent = amt;
  li.append(l, a);
  return li;
}
// Human name for an unlock id ("cat.8" -> "Pepper", "custom.kart" -> the creator).
function unlockName(id) {
  if (id === "custom.cat") return "Custom Cat creator";
  if (id === "custom.kart") return "Custom Kart creator";
  const am = id.match(/^acc\.(\w+)$/);
  if (am) return ACCESSORY_LABELS[am[1]] || am[1];
  const m = id.match(/^(cat|kart)\.(\d+)$/);
  if (!m) return id;
  const arr = m[1] === "cat" ? CAT_PRESETS : KART_PRESETS;
  return arr[+m[2]] ? arr[+m[2]].name : id;
}

// Debug hook: finish the race NOW (headless probes verify the settle → earnings
// flow without driving three real laps). Client-side only, like every hook here.
window.__zoomies.debugFinish = () => {
  if (!player || player.finished) return false;
  player.finished = true;
  player.finishTime = raceTime;
  showResults();
  return true;
};

function showResults() {
  state = State.FINISHED;
  renderResults();
  renderRaceEarnings(settleRaceRewards());
  const _hudEl = document.getElementById("hud");
  _hudEl.classList.remove("hidden");
  _hudEl.classList.remove("victory-hidden"); // results overlay takes over from the faded victory HUD
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
    const time = k.finished
      ? formatClock(k.finishTime)
      : MP.enabled ? "racing…" : "DNF";
    const medal = k.place === 1 ? "🥇" : k.place === 2 ? "🥈" : k.place === 3 ? "🥉" : ordinal(k.place);
    list.appendChild(resultRow(medal, k.name, time, k === player));
  });
  document.getElementById("results-title").textContent =
    player.place === 1 ? "🏆 You Win!" : `🏁 ${ordinal(player.place)} Place`;
}
// One standings row: rank (medal for the podium) | name | time, so the columns
// line up instead of reading as a text blob. `you` lights the player's row gold.
function resultRow(rank, name, time, you) {
  const li = document.createElement("li");
  const r = document.createElement("span");
  r.className = "r-rank";
  r.textContent = rank;
  const n = document.createElement("span");
  n.className = "r-name";
  n.textContent = name;
  const t = document.createElement("span");
  t.className = "r-time";
  t.textContent = time;
  li.append(r, n, t);
  if (you) li.className = "you";
  return li;
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
  const gk = new Kart({ color: look.color, catColor: look.catColor, catPattern: look.catPattern, catAccessory: look.catAccessory, catAccessoryColor: look.catAccessoryColor, kartStyle: look.kartStyle, kartNumber: look.kartNumber, name: "Ghost", isPlayer: false, skill: 1 });
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
  if (yourTime != null) list.appendChild(resultRow("⏱", "Your lap", formatLap(yourTime), true));
  if (!top.length) list.appendChild(resultRow("—", "No times yet", "set one!", false));
  top.forEach((e, i) => {
    const isYou = _ttResult && e === _ttResult.entry;
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    // The date anchors older bests ("when was that?"); your fresh run says so.
    const label = isYou ? "This run" : new Date(e.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    list.appendChild(resultRow(medal, label, formatLap(e.time), isYou));
  });
}

// --- Main loop ---
let last = performance.now();
let prevPlayerLap = -1;
let prevPlayerSpin = 0;

// Frame-rate cap: render at ~60fps even on 120Hz ProMotion phones. Rendering at
// 120fps roughly DOUBLES GPU/CPU power draw — and worse, the dynamic-resolution
// scaler saw the resulting ~8ms frames as spare headroom and cranked resolution
// UP, pegging the GPU. That's the "phone runs hot / battery dies fast" report.
// 60fps is smooth for a kart racer and graphically identical (same resolution,
// same effects) — only the extra frames are dropped. Threshold sits below the
// 60Hz vsync interval (16.7ms) so a 60Hz display never skips a frame. Opt out
// (e.g. a 120Hz desktop) with ?uncap=1.
const _uncapParam = new URLSearchParams(location.search).has("uncap");
const FRAME_MIN_MS = 15;
// Idle-render savings (see the loop): draw the paused scene once (not 60×/s), run
// the ambient menu drift at ~30fps, and refresh the minimap at ~20fps. All hold
// their last frame on the canvas between draws, so there's no visible change.
let _pauseDrawn = false;
let _lastMenuDraw = 0;
let _lastMiniDraw = 0;

function loop(now) {
  requestAnimationFrame(loop);
  // Cap: unless the High graphics tier (or ?uncap=1) opts into uncapped ~120fps,
  // skip this rAF tick when too little time has passed since the last RENDERED
  // frame (leaving `last` untouched so dt still spans to the real last frame).
  if (quality !== "high" && !_uncapParam && now - last < FRAME_MIN_MS) return;
  const rawMs = now - last; // real frame interval (for resolution scaling)
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05); // clamp big frame gaps

  updateDRS(rawMs, dt); // hold the frame rate by scaling render resolution
  updateFpsCounter(dt); // opt-in on-screen FPS readout
  logPerfSummary(rawMs); // 5-second frame-time summary → console (Xcode/devtools)
  _seg.render = _seg.atmos = _seg.minimap = _seg.world = 0; // reset AFTER the report reads them
  warmAllStep(); // first frames: draw everything so Metal's lazy compiles happen under the splash
  warmKartStep(); // retire the off-screen garage warm kart once it has drawn
  // One-time boot timeline. Logged on the SECOND loop pass so `rawMs` covers the
  // first rendered frame — where the whole scene's pipelines compile — and the
  // "pause before the menu" decomposes into its actual phases.
  if (_boot.frames < 2 && ++_boot.frames === 2) {
    console.log(
      `[zoomies] boot timeline: scripts ${Math.round(_boot.eval)}ms · world +${Math.round(_boot.world - _boot.eval)}ms · renderer +${Math.round(_boot.renderer - _boot.world)}ms · first frame ${Math.round(rawMs)}ms · menu at ${Math.round(now)}ms`
    );
  }
  updateTiltCounter(dt); // opt-in on-screen tilt diagnostics
  if (state !== State.PAUSED) {
    _pauseDrawn = false; // any live frame → the next pause redraws its frozen shot once
    const _t = performance.now();
    world.update(now / 1000, dt, player ? player.position : null); // balloons, critters, fireflies, pigeons
    if (gpuParticles) gpuParticles.update(dt, camera.position); // step the GPU compute motes (follows the camera)
    _seg.world = performance.now() - _t;
  }

  if (state === State.PAUSED) {
    // Paused = a frozen scene, so draw it ONCE (the canvas keeps showing that frame)
    // then idle — re-rendering an unchanging image 60×/s behind the pause menu (or a
    // backgrounded app) is pure wasted GPU/battery. Ambient sim is skipped above too.
    if (!_pauseDrawn) { renderFrame(); _pauseDrawn = true; }
    return;
  }

  if (state === State.FLYVIEW) {
    updateFlyCamera(dt); // free-flying inspection camera over the frozen race
    renderFrame();
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
    _hlCx = camera.position.x;
    _hlCz = camera.position.z;
    // Player always keeps a beam; the rest are ranked by distance to the camera.
    // (_hlCmp is hoisted — an inline comparator allocated a closure per frame.)
    _hlCands.sort(_hlCmp);
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

  // One shared kart snapshot for the prop + string-light updates (alloc-free).
  const fieldNow = (props || world.stringLights) ? fieldSnapshot() : null;

  // Step the knockable props and let the karts shove the ones they touch.
  if (props) props.update(dt, fieldNow);

  // Swing the festive string lights as karts pass under them.
  if (world.stringLights) world.stringLights.update(dt, fieldNow);
  updateMultiplayer(dt); // broadcast my pose + interpolate ghost karts

  if (state === State.MENU) {
    if (_garageOpen) {
      // Garage sub-screen: orbit the camera around the parked preview kart so the
      // player can inspect their chosen cat + kart in 3D.
      renderGarage(now / 1000, dt);
      return;
    }
    // Debug/screenshot hook: window.__campin = [x,y,z, tx,ty,tz] pins the menu
    // camera to a fixed shot (headless tooling flies it to the track set pieces).
    if (window.__campin) {
      const c = window.__campin;
      camera.position.set(c[0], c[1], c[2]);
      camera.lookAt(c[3], c[4], c[5]);
      if (menuXfade) menuXfade.style.opacity = 0;
      renderFrame();
      return;
    }
    // Cinematic: slowly orbit the camera over the track so the menu floats above
    // the real world (the menu/how-to overlays are glassy and let it show through).
    updateMenuCamera(now / 1000); // advance tour timing/phase (cheap; keeps the drift smooth)
    // The menu is a slow ambient drift — render it at ~30fps (halves the idle GPU/
    // battery you spend sitting in menus) but keep the brief shot cross-fade at full
    // rate so transitions stay smooth. The canvas holds the last frame between draws.
    if (_menuPhase === "fading" || now - _lastMenuDraw >= 32) {
      _lastMenuDraw = now;
      renderMenuBackground(now / 1000); // single render, or dual-render cross-dissolve
    }
    return;
  }

  if (state === State.COUNTDOWN) {
    // Veil hold: while the "GET READY" cover is up, the countdown clock is
    // frozen — frames keep rendering behind the cover so the kart build's GC
    // and the first-view pipeline compiles burn off invisibly. Drop the veil
    // after an uninterrupted stretch of smooth frames, or at the hard cap.
    if (_veilActive) {
      if (MP.enabled && MP.startAt) {
        hideRaceVeil(); // shared-clock countdown can't be held (belt & braces)
      } else {
        _veilStableMs = rawMs < VEIL_STABLE_FRAME_MS ? _veilStableMs + rawMs : 0;
        const held = performance.now() - _veilStartedAt;
        if (_veilStableMs >= VEIL_STABLE_NEED_MS || held > VEIL_MAX_MS) {
          console.log(`[zoomies] race veil dropped after ${Math.round(held)}ms (stable ${Math.round(_veilStableMs)}ms)`);
          hideRaceVeil();
          // Idle the engine at the start line through the 3-2-1: reads as race
          // anticipation, and moves the engine audio-graph spin-up (oscillators,
          // filters, the looping noise source) off the GO frame. Idempotent —
          // the startEngine at GO is a no-op once this ran.
          audio.startEngine();
        }
      }
    }
    // In multiplayer, drive the countdown straight off the shared clock so every
    // client reaches GO at the same instant regardless of local frame timing.
    if (MP.enabled && MP.startAt) countdown = (MP.startAt - MP.net.now()) / 1000;
    else if (!_veilActive) countdown -= dt;
    updateCamera(dt, camPos.lengthSq() === 0);
    prewarmPipelines(); // one-time (during the first countdown): warm scenery pipelines so a spin-out doesn't compile-hitch
    // The whole GO moment — toast, chirp, GREEN light — fires at the actual
    // race start below. The old formula (ceil(countdown-1)) showed "GO!" (and
    // lit the light early) for the final ~1s while input was still locked.
    // All of it is gated on the veil being down, so the first beep the player
    // hears lines up with the first "3" they can actually see.
    const n = Math.ceil(countdown);
    if (!_veilActive && n >= 1 && n <= 3) hud.showToast(`${n}`);
    // A beep on each 3/2/1 as the number changes, and the start-light gantry
    // steps with it: red through 3/2, amber at 1. Green comes with GO.
    if (!_veilActive && n !== prevCountN && n >= 1 && n <= 3) {
      audio.countdownBeep(n);
      track.setStartLight?.(n >= 2 ? "red" : "amber");
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
      _goAt = performance.now(); // arms the low-threshold FREEZE window
      hud.showToast("GO!");
      audio.countdownBeep(0); // the higher GO! chirp, exactly as control unlocks
      track.setStartLight?.("green"); // green means green: karts can move NOW
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
    // Raising the shield mid-drift is the one-thumb trade: the drift ends NOW
    // and its charge is forfeit (no mini-turbo). Letting go of jump to shoot
    // still releases the drift normally — that path keeps its earned boost.
    if (input.consumeShieldEngage() && player.drifting) {
      player.drifting = false;
      player.driftCharge = 0;
      player.driftRamp = 0;
    }
    player.shielding = input.shielding;
    player.driftHeld = input.jumpHeld;
    // Steering dot: skip the style write (string build + composite) when the
    // needle hasn't visibly moved (~0.4px at the 80px throw).
    if (Math.abs(input.steer - _steerDotLast) > 0.005) {
      _steerDotLast = input.steer;
      steerDot.style.transform = `translateX(${input.steer * 80}px)`;
    }
    if (input.consumeJump()) player.jump();
    // Hold the shoot button to charge a faster/further shot; fire on release.
    if (input.shootHeld && player.shootCooldown <= 0)
      player.shootCharge = Math.min(player.shootCharge + dt / SHOOT_CHARGE_TIME, 1);
    if (input.consumeShootRelease()) {
      fireShot(player, player.shootCharge);
      player.shootCharge = 0;
    }
    if (input.consumeMilk() && player.milkBottles > 0 && player.spinTimer <= 0) {
      player.milkBottles = 0;
      const p = items.dropMilk(player);
      if (MP.enabled && MP.net && p) MP.net.sendMilk(p.x, p.z, p.r);
      hud.showToast("🥛 Spilled!");
    }
    if (input.consumeBoost() && player.boostMeter >= 1) {
      const _over = player.boostMeter > 1.02; // fired with overcharge → beefier burst
      if (player.tootBoost(player.boostMeter)) {
        player.boostMeter = 0; // fully deplete on use
        effects.tootBurst(player, _over ? 3.5 : 2);
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
    // (Chromatic aberration / radial blur: their uniforms are dead stubs — the
    // effects aren't in the post graph (see fxPass) — so nothing eases them
    // per-frame anymore. Re-add the easing when the passes are actually wired in.)

    // AI
    // AI drivers — plus any kart that's finished, so it auto-pilots its victory lap.
    // Hand them the floating power-up box positions so they go for them: leaders
    // only when one's nearly on their line, trailing karts detour further for a
    // catch-up item (see driveAI).
    const boxTargets = props ? props.boxTargets() : null;
    for (const k of karts) if (!k.isPlayer || k.finished) k.driveAI(track, dt, boxTargets, karts);
    aiActions(dt);

    // Slipstreaming: score each kart's draft over the live field (incl. remote
    // ghosts online) so a tuck behind a rival charges the toot boost faster. Runs
    // before physics so Kart.update reads this frame's kart.slipstream.
    const draftField = MP.enabled && MP.remotes.size
      ? [...karts, ...[...MP.remotes.values()].map((r) => r.kart)]
      : karts;
    updateSlipstream(draftField);
    // Laser pointers: lock + zap + beam visuals over the same live field. Runs
    // before physics so Kart.update reads this frame's zapTimer.
    updateLasers(draftField);
    if (_raceStats && player && player.slipstream > 0.3) _raceStats.slipSeconds += dt;

    // Step physics
    for (const k of karts) k.update(dt, track);
    updateHaptics(now); // discrete taptic feedback off fresh player state
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
            if (_ref) _ref.claimHit(id, MP.net.now(), dir); // referee adjudicates (no-op if off)
            // Instant local feedback: jolt the ghost in the hairball's direction
            // so the hit reads immediately, bridging the round-trip until the
            // victim's real spin-out streams back over the network.
            const r = MP.remotes.get(id);
            if (r) r.bump(dir.x, dir.z, 15);
          }
        : null
    );
    // Yarn balls + milk puddles (local karts only; no MP replication yet).
    items.update(dt, karts, {
      onYarnMove: (y) => {
        // Rolling dust plume so the ball reads as a THREAT bearing down.
        _yarnShim.position = y.mesh.position;
        _yarnShim.heading = y.mesh.rotation.y;
        _yarnShim.groundY = y.mesh.position.y - 0.55;
        effects.dust(_yarnShim, _yarnDustCol, 0.9);
      },
      onYarnHit: (k) => {
        effects.tootBurst(k, 2, false);
        audio.shoot(k === player ? null : k.position);
      },
      onYarnBlocked: (k) => effects.tootBurst(k, 1, false),
      onMilkHit: (k, p) => {
        effects.tootBurst(k, 2, false);
        audio.shoot(k === player ? null : k.position);
        // Gloat: whoever's milk this was gets to look back and laugh.
        if (p && p.owner && p.owner !== k) {
          p.owner.gloat(); // local puddle (single-player / AI) — the dropper is right here
          if (p.owner === player && _raceStats) _raceStats.milkTrips++;
        } else if (p && p.ownerId && k === player && MP.enabled && MP.net) {
          MP.net.sendMilkGloat(p.ownerId); // a remote's milk tripped ME → tell them to gloat
        }
      },
    },
    // Multiplayer: the shooter's live yarn hits remote ghosts and reports it
    // authoritatively — same bridge as hairballs.update.
    MP.enabled ? MP.remotes : null,
    MP.enabled
      ? (id, dir) => {
          if (!MP.net) return;
          MP.net.sendHit(id, dir);
          if (_ref) _ref.claimHit(id, MP.net.now(), dir); // referee adjudicates (no-op if off)
          const r = MP.remotes.get(id);
          if (r) r.bump(dir.x, dir.z, 15); // instant local feedback, like hairballs
        }
      : null,
    );
    // Sparks where a kart scraped a railing; skid marks while spinning out;
    // a charge-coloured cloud puff when a drift boost is released. Remote ghosts
    // join this pass (online `karts` is just the player) so a rival's wall scrapes,
    // drift sparks and dust show too — their flags rode in on the pose, so the same
    // cosmetics fire without any physics. Without this a remote kart looked inert:
    // it moved but threw no particles, so you couldn't read what it was doing.
    const fxKarts = MP.enabled && MP.remotes.size
      ? [...karts, ...[...MP.remotes.values()].map((r) => r.kart)]
      : karts;
    for (const k of fxKarts) {
      if (k.wallHit) {
        effects.wallSparks(k);
        audio.scrape(k === player ? null : k.position);
        k.wallHit = false;
      }
      // Slipstream: wind streaks on a kart drafting in a wake, a faint wake off a
      // kart being drafted. Both scale with strength (set in updateSlipstream) and
      // work for the player, AI, and remote ghosts alike.
      if (k.slipstream > 0.05) effects.slipstreamWind(k, k.slipstream);
      if (k._drafted > 0.05) effects.slipstreamWake(k, k._drafted);
      // Nine Lives fired: pop the save so it reads as a rescue, not a whiff.
      if (k.lifePulse) {
        k.lifePulse = false;
        effects.tootBurst(k, 1, false);
        audio.boost(k === player ? null : k.position);
        if (k === player) { hud.showToast("😻 Saved by a life!"); if (_raceStats) _raceStats.heartSaves++; }
      }
      // Being lasered: red sparkles on the zapped kart (skip while shielded — the
      // bubble is visibly eating the beam instead).
      if (k.zapTimer > 0 && !k.shielding) effects.laserZapSparks(k);
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
        if (k === player && _raceStats) _raceStats.driftBoosts++;
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
    // Ease the grade toward the biome under the player (the same smooth
    // border feel as the weather crossfade).
    const _bg = BIOME_GRADE[biomeNameAt(player.position.x, player.position.z, player.position.y)] || BIOME_GRADE.meadow;
    const _bk = Math.min(1, dt * 0.7);
    _bgSat += (_bg.sat - _bgSat) * _bk;
    _bgExp += (_bg.exp - _bgExp) * _bk;
    _bgCon += (_bg.con - _bgCon) * _bk;
    fxPass.uniforms.uSat.value = moodSat * (1 - 0.22 * wet) * _bgSat;
    fxPass.uniforms.uContrast.value = moodContrast * _bgCon;
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
    renderer.toneMappingExposure = moodExposure * (1 - 0.1 * wet - 0.12 * _snowBlend) * (1 + flash * 1.5) * _bgExp;

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

    // HUD (reused options object — no per-frame literal)
    _hudOpts.lapNum = player.displayLap(laps);
    _hudOpts.totalLaps = laps;
    _hudOpts.place = player.place;
    _hudOpts.totalKarts = karts.length + (MP.enabled ? MP.remotes.size : 0);
    _hudOpts.speedKmh = Math.abs(player.speed) * 3.0;
    _hudOpts.time = timeTrial && ttLapStart >= 0 ? raceTime - ttLapStart : raceTime;
    hud.update(_hudOpts);
    hud.setPowerups(player.shieldTimer, player.triShots, player.catnipTimer, player.yarnShots, player.milkBottles, player.lives, player.laserTimer);
    // Incoming-yarn ping: only lights inside the ~1s reaction window — early
    // enough to defend on a read, late enough that pre-arming a shield costs.
    const _yEta = items.yarnEta(player);
    const _yWarn = _yEta < 1.15;
    if (_yWarn !== _yarnWarnLast) {
      _yarnWarnLast = _yWarn;
      yarnWarnEl?.classList.toggle("hidden", !_yWarn);
    }

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
      // Fade the racing HUD out for the victory lap so the camera orbit + fireworks
      // read as a celebration, not a paused race (the "FINISH!" toast stays — see
      // the .victory-hidden rule). Restored when results show / the next race starts.
      document.getElementById("hud").classList.add("victory-hidden");
      // Douse any live laser beams — the laser pass doesn't run during the victory
      // lap, so a beam would otherwise freeze mid-air.
      for (const [, b] of _laserBeams) b.visible = false;
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
          if (_ref) _ref.claimFinish(); // referee stamps the authoritative place (no-op if off)
        }
        // The HUD fades for the victory lap now, so a long empty orbit drags —
        // one flying pass (~6.5s) is celebration enough before the results.
        setTimeout(showResults, 6500);
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
    // Freeze attribution: count every pipeline/shader creation so a FREEZE log
    // line can say whether a stall was shader compilation. Diagnostics only —
    // wrapped calls behave identically.
    try {
      const dev = renderer.backend?.device;
      if (dev && !dev.__zoomiesCounted) {
        dev.__zoomiesCounted = true;
        for (const m of ["createRenderPipeline", "createComputePipeline", "createShaderModule"]) {
          const orig = dev[m]?.bind(dev);
          if (!orig) continue;
          dev[m] = (...a) => { _gpuCreates++; return orig(...a); };
        }
      }
    } catch { /* diagnostics only */ }
    // Ambient GPU compute motes: warm dust by day, cool sparkles at night.
    const night = TIME_OF_DAY === "night";
    initGpuParticles(scene, renderer, {
      count: 450, // sweet spot: 650 read as "too many", 280 as "none" — this is the sparse-but-present middle
      tint: night ? 0xbcd0ff : TIME_OF_DAY === "sunset" ? 0xffd9a0 : 0xfff0c8,
      // A touch more opaque so the (now fewer) specks actually catch the light.
      opacity: night ? 0.5 : TIME_OF_DAY === "sunset" ? 0.3 : 0.22,
      size: night ? 0.52 : 0.42,
    }).then((p) => { gpuParticles = p; if (p && quality === "low") p.setVisible(false); });
  })
  .catch((err) => console.error("[zoomies] renderer init failed:", err))
  .finally(() => {
    _boot.renderer = performance.now();
    // Draw the whole world for the first frames (see warmAllStep); when the
    // pass retires, dismiss the native splash and queue the kart-family warm.
    beginWarmAll(2, () => {
      // Only now dismiss the splash (and apply the rest of the native chrome):
      // the warm frames' compile stall must happen BEHIND the splash, not under
      // a frozen first frame. No-op on the web.
      getPlatform().then((p) => p.ready()).catch(() => {});
      // A beat later (menu idle), warm the kart/cat material family too — the
      // garage's first open otherwise compiles it on-screen (~0.8s pause).
      setTimeout(warmGarageKart, 1200);
    });
    requestAnimationFrame(loop);
    // Native shell chrome (landscape lock, status bar, splash dismissal) is
    // applied by warmAllStep once the draw-everything warm pass finishes, so
    // the splash covers the shader-compile stall instead of a frozen frame.
  });

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
  _isNativeApp ||
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;
if (_isStandalonePWA) {
  audio.unlock();
  // Wait for the audio-policy verdict (bounded — the web resolves instantly,
  // native is one bridge round-trip) before the first play attempt, so a
  // muted-by-policy session never starts-then-aborts the track.
  Promise.race([_audioPolicyReady, new Promise((r) => setTimeout(r, 1500))])
    .then(() => audio.playMusic("bg"));
}
