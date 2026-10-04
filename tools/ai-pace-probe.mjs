// AI pace probe: how hard is each difficulty tier, measured instead of felt.
//
// Runs the REAL Kart physics + driveAI headless in node (no browser) on the
// classic circuit and two generated loops. For every tier in main.js's
// AI_DIFFICULTY table it reports the rivals' solo flying lap, then simulates
// 3-lap races of five rivals (anti-clump, collisions, toot boost and the tier's
// rubber band, as aiActions does them — no items) against four MODELLED
// players, and prints where each model finishes and its gap to the best rival:
//   beginner  a small child: 85% throttle, late + noisy steering, no boosts
//   flat      holds the throttle flat round the AI's own line, never boosts
//   toot      flat, and toots whenever the meter fills
//   skilled   flat, toots, drifts every corner for mini-turbos
// The ladder is tuned so each tier brackets a player type: easy ~ beginner,
// medium ~ flat (P2-P5), hard ~ toot (podium fight), expert ~ beats skilled by
// 10-15s — a real player with items, slipstream and better lines has to earn it.
//   node tools/ai-pace-probe.mjs            (~1-2 min)
//   node tools/ai-pace-probe.mjs --solo     solo laps only
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser's import map points "three" at the WebGPU build (node materials).
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === "three" ? "three/webgpu" : s, c); }`), import.meta.url);

// Enough DOM for track.js to build (its canvas textures draw into a stub 2D context).
const _ctx = new Proxy({}, {
  get: (t, p) => (p === "canvas" ? _canvas() : (...a) => (p === "measureText" ? { width: 1 } : p === "getImageData" ? { data: new Uint8ClampedArray(a[2] * a[3] * 4 || 4), width: a[2] || 1, height: a[3] || 1 } : /Gradient|Pattern/.test(String(p)) ? { addColorStop() {} } : _ctx)),
  set: () => true,
});
const _canvas = () => ({ width: 64, height: 64, style: {}, getContext: () => _ctx, toDataURL: () => "", addEventListener() {} });
globalThis.location = { search: "", href: "http://localhost/", hash: "" };
globalThis.window = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", platform: "Linux", maxTouchPoints: 0, hardwareConcurrency: 4, language: "en" }, configurable: true });
globalThis.document = { createElement: () => _canvas(), createElementNS: () => _canvas(), body: {}, documentElement: { style: {} }, querySelector: () => null, getElementById: () => null, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("toNonIndexed")) _warn(...a); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Track } = await import(path.join(ROOT, "src/track.js"));
const { Kart } = await import(path.join(ROOT, "src/kart.js"));
const { makeRng } = await import(path.join(ROOT, "src/rng.js"));

// The live tier table, lifted straight out of main.js so the probe can't drift from it.
const mainSrc = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
const tblSrc = mainSrc.slice(mainSrc.indexOf("const AI_DIFFICULTY = {"), mainSrc.indexOf("const DIFF_ORDER"));
const AI_DIFFICULTY = new Function(tblSrc + "return AI_DIFFICULTY;")();
const ROSTER = [
  { name: "Mittens", skill: 1.03, lane: -0.35 },
  { name: "Whiskers", skill: 1.05, lane: 0.45 },
  { name: "Pumpkin", skill: 1.0, lane: 0.1 },
  { name: "Shadow", skill: 1.06, lane: -0.5 },
  { name: "Biscuit", skill: 1.02, lane: 0.3 },
];
const PLAYERS = {
  beginner: { throttle: 0.85, noise: 0.35, lag: 0.3, toot: false, drift: false },
  flat: { throttle: 1, noise: 0.1, lag: 0.08, toot: false, drift: false },
  toot: { throttle: 1, noise: 0.08, lag: 0.08, toot: true, drift: false },
  skilled: { throttle: 1, noise: 0.05, lag: 0.05, toot: true, drift: true },
};
const DT = 1 / 60;
const KART_COLLIDE_MIN = 3.6;

// --- the bits of main.js aiActions / resolveCollisions a race needs ---
function antiClump(k, karts, raceTime) {
  if (raceTime < 1.3) { k.throttleInput = 1; return; }
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  let nearestAhead = Infinity;
  for (const o of karts) {
    if (o === k || o.finished) continue;
    const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.001 && d < 16 && (dx * fx + dz * fz) / d > 0.6) {
      if (d < nearestAhead) nearestAhead = d;
      let a = Math.atan2(dx, dz) - k.heading;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      const away = Math.abs(a) < 0.05 ? (k.laneBias >= 0 ? 1 : -1) : -Math.sign(a);
      k.steerInput = Math.max(-1, Math.min(1, k.steerInput + away * 0.35));
    }
  }
  if (nearestAhead < 16) k.throttleInput *= 0.55 + 0.45 * (nearestAhead / 16);
}
function collide(karts) {
  for (let i = 0; i < karts.length; i++) for (let j = i + 1; j < karts.length; j++) {
    const a = karts[i], b = karts[j];
    const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= 1e-4 || d2 >= KART_COLLIDE_MIN ** 2) continue;
    const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, ov = KART_COLLIDE_MIN - d;
    const ima = 1 / a.mass, imb = 1 / b.mass, inv = ima + imb;
    a.position.x -= (nx * ov * ima) / inv; a.position.z -= (nz * ov * ima) / inv;
    b.position.x += (nx * ov * imb) / inv; b.position.z += (nz * ov * imb) / inv;
    a.speed *= 0.99; b.speed *= 0.99;
  }
}
function toot(k) {
  if (k.boostMeter >= 1 && Math.abs(k.steerInput) < 0.45 && k.speed > 8 && !k.boosting && k.tootBoost(k.boostMeter)) k.boostMeter = 0;
}
function rubber(k, tier, gap) {
  k.maxSpeed = k.baseMaxSpeed * (1 + Math.max(-tier.lead, Math.min(0.16, gap * tier.rubberGain)) * tier.rubber);
}
function makeAI(cfg, tier, rng) {
  const k = new Kart({ ...cfg, rng, headless: true });
  k.diff = tier;
  k.baseMaxSpeed *= tier.speed;
  k.maxSpeed = k.baseMaxSpeed;
  k.laneBias = cfg.lane;
  return k;
}
// A modelled player steers along driveAI's own aim line, then its hands take over.
function drivePlayer(k, pm, t, rng) {
  k._lag.push(k.steerInput);
  while (k._lag.length > Math.max(1, Math.round(pm.lag / DT))) k._lag.shift();
  k._noise = (k._noise || 0) + (rng() * 2 - 1) * pm.noise * 0.5 - (k._noise || 0) * 0.08;
  k.steerInput = Math.max(-1, Math.min(1, k._lag[0] + k._noise));
  k.throttleInput = k.finished ? 0 : t < 1.3 ? 1 : pm.throttle;
  k.driftHeld = pm.drift && !k.airborne && k.speed > 7 && Math.abs(k.steerInput) > 0.25;
  if (pm.toot) toot(k);
}

function soloLap({ track, tier = null, player = null, seed = "solo" }) {
  track.totalLaps = 99;
  const rng = makeRng(seed);
  const k = player ? new Kart({ name: "You", skill: 1, isPlayer: true, rng, headless: true }) : makeAI(ROSTER[2], tier, rng);
  k._lag = [];
  const s = track.gridSlot(0);
  k.placeAt(s.position, s.heading, track);
  const crossings = [];
  let last = k.lap, t = 0, scrapes = 0;
  while (t < 600 && crossings.length < 4) {
    track.raceTime = t;
    k.driveAI(track, DT, null, [k]);
    if (player) drivePlayer(k, PLAYERS[player], t, rng); else toot(k);
    k.update(DT, track);
    if (k.wallHit) scrapes++;
    if (k.lap !== last) { crossings.push(t); last = k.lap; }
    t += DT;
  }
  const laps = crossings.slice(1).map((c, i) => c - crossings[i]);
  return { lap: laps.reduce((a, b) => a + b, 0) / laps.length, scrapes: scrapes / laps.length };
}

function race({ track, tier, player, laps = 3, seed = "race" }) {
  track.totalLaps = laps;
  const rng = makeRng(seed);
  const bot = new Kart({ name: "You", skill: 1, isPlayer: true, rng, headless: true });
  bot._lag = [];
  const karts = [bot, ...ROSTER.map((cfg) => makeAI(cfg, tier, rng))];
  [2, 0, 1, 3, 4, 5].forEach((slot, i) => { const s = track.gridSlot(slot); karts[i].placeAt(s.position, s.heading, track); });
  let t = 0;
  while (t < 600 && !bot.finished) {
    track.raceTime = t;
    for (const k of karts) {
      k.driveAI(track, DT, null, karts);
      if (k.isPlayer) drivePlayer(k, PLAYERS[player], t, rng);
      else { antiClump(k, karts, t); rubber(k, tier, bot.totalProgress - k.totalProgress); toot(k); }
    }
    for (const k of karts) k.update(DT, track);
    collide(karts);
    t += DT;
  }
  const rank = (k) => (k.finished ? 1e9 - k.finishTime : k.totalProgress);
  const place = [...karts].sort((a, b) => rank(b) - rank(a)).indexOf(bot) + 1;
  const best = Math.max(...karts.slice(1).map((k) => k.totalProgress));
  return { place, gapS: (bot.totalProgress - best) * (bot.finishTime / laps) };
}

const tracks = {
  classic: new Track(),
  generated: new Track({ mode: "custom", seed: "RUNTIME", size: 0.5, curviness: 0.45, twist: 0.4, hilliness: 0.25, hills: 0.4, biomes: ["meadow"], timeOfDay: "midday" }),
  twisty: new Track({ mode: "custom", seed: "TWIST", size: 0.5, curviness: 0.85, twist: 0.4, hilliness: 0.25, hills: 0.4, biomes: ["meadow"], timeOfDay: "midday" }),
};
const f1 = (x) => x.toFixed(1).padStart(6);
console.log("Solo flying lap (s) / wall-scrape frames per lap");
console.log("track     " + [...Object.keys(PLAYERS), ...Object.keys(AI_DIFFICULTY).map((k) => "AI " + k)].map((h) => h.padStart(12)).join(""));
for (const [tn, track] of Object.entries(tracks)) {
  const cells = [
    ...Object.keys(PLAYERS).map((p) => soloLap({ track, player: p })),
    ...Object.values(AI_DIFFICULTY).map((tier) => soloLap({ track, tier })),
  ].map((o) => `${f1(o.lap)}/${String(Math.round(o.scrapes)).padStart(4)}`.padStart(12));
  console.log(tn.padEnd(10) + cells.join(""));
}
if (!process.argv.includes("--solo")) {
  for (const [tn, track] of Object.entries(tracks)) {
    console.log(`\n${tn}: modelled player's place after 3 laps (+ahead / -behind the best rival, s)`);
    console.log("player    " + Object.keys(AI_DIFFICULTY).map((k) => k.padStart(14)).join(""));
    for (const p of Object.keys(PLAYERS)) {
      const row = Object.values(AI_DIFFICULTY).map((tier) => { const r = race({ track, tier, player: p }); return `P${r.place} ${(r.gapS >= 0 ? "+" : "") + r.gapS.toFixed(0)}s`.padStart(14); });
      console.log(p.padEnd(10) + row.join(""));
    }
  }
}
