// TRACK AUDIT — automated pathology detection for generated tracks.
//
// The existing checks assert that FEATURES work: the game boots, the HUD
// updates, an item roll is fairly distributed. This one asks a different
// question — is a track PLAYABLE? It races a full AI field on a track for a
// couple of minutes and counts the things that are bad no matter what the
// track was trying to be:
//
//   wedged   — a kart that wants to drive forward and covers no ground
//              (caught on a barrier, a feature wall, a scenery collision)
//   grind    — the share of race time the field spends scraping barriers;
//              effectively a corner-quality metric, since a spike means a
//              bend the AI's aim-point logic cannot take cleanly
//   stalled  — a kart whose lap progress stops advancing (can't complete)
//   offroad  — a kart outside the barriers (the containment clamp failing)
//   airborne — launches with absurd hang time (a crest the generator made
//              far steeper than intended)
//   nan      — non-finite kart state (the end of any physics debugging)
//
// The point is that these need no judgement about whether a track is FUN.
// They are pure "this is broken" signals, so they can gate CI — which
// matters most for the PROCEDURAL GENERATOR: custom tracks come from a seed
// plus a handful of knobs, and nobody has ever driven the overwhelming
// majority of what it can produce. Sweeping seeds and gating on pathologies
// turns "the generator is probably fine" into a measured claim.
//
// Three outcomes, deliberately distinct: PASS (judged, clean), FAIL (a
// pathology was found), and INCONCLUSIVE (the run ran out of wall clock
// before gathering enough racing to judge). Only FAIL sets the exit code —
// a harness that reports its own slowness as a broken track is worse than no
// harness, because it teaches you to ignore red.
//
// Deliberate limitation: this measures the ABSENCE OF BAD, not the presence
// of good. A track can pass every gate here and still be dull.
//
//   node tools/track-audit.mjs                  # the shipped featured tracks
//   TRACKS=random SEEDS=6 node tools/track-audit.mjs
//   TRACKS=extreme SEEDS=5 node tools/track-audit.mjs   # every knob maxed
//   TRACKS=all SECONDS=45 node tools/track-audit.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8089;
const SECONDS = Number(process.env.SECONDS || 30); // SIMULATED race seconds sampled per track
const SEEDS = Number(process.env.SEEDS || 4); // how many random recipes when asked
const WHICH = process.env.TRACKS || "featured";
// Wall-clock budget per track. Maxed-out recipes are the longest and most
// detailed the generator makes, so they legitimately need several times the
// wall time of a featured track to reach the same simulated seconds.
const WALL_CAP = Number(process.env.WALLCAP || Math.max(240, SECONDS * 20)) * 1000;
// Below this much simulated racing there isn't enough evidence to judge a
// track either way — that is INCONCLUSIVE, which is not the same as broken.
const MIN_SIM = Math.min(15, SECONDS * 0.5);

// The shipped recipes from main.js's FEATURED_TRACKS — these are stable,
// nameable places players actually race, so they must always be clean.
const FEATURED = [
  { name: "Classic", cfg: { mode: "classic" } },
  { name: "Buttercup Run", cfg: { mode: "custom", seed: "MEOW", size: 0.45, curviness: 0.5, twist: 0.42, hilliness: 0.35, hills: 0.5, biomes: ["meadow", "forest"], timeOfDay: "midday" } },
  { name: "Whisker Canyon", cfg: { mode: "custom", seed: "DUNE", size: 0.55, curviness: 0.55, twist: 0.5, hilliness: 0.6, hills: 0.6, biomes: ["desert", "mesa"], timeOfDay: "sunset" } },
  { name: "Neon Alley", cfg: { mode: "custom", seed: "NEON", size: 0.5, curviness: 0.45, twist: 0.55, hilliness: 0.3, hills: 0.4, biomes: ["city"], timeOfDay: "night" } },
  { name: "Tuna Cove", cfg: { mode: "custom", seed: "TUNA", size: 0.5, curviness: 0.5, twist: 0.45, hilliness: 0.35, hills: 0.45, biomes: ["beach", "jungle"], timeOfDay: "midday" } },
  { name: "Snowcap Sprint", cfg: { mode: "custom", seed: "PEAK", size: 0.5, curviness: 0.55, twist: 0.5, hilliness: 0.7, hills: 0.65, biomes: ["alpine", "tundra"], timeOfDay: "sunset" } },
  { name: "Maple Falls", cfg: { mode: "custom", seed: "LEAF", size: 0.5, curviness: 0.55, twist: 0.48, hilliness: 0.5, hills: 0.55, biomes: ["autumn", "forest"], timeOfDay: "sunset" } },
  { name: "Petal Parade", cfg: { mode: "custom", seed: "POSY", size: 0.45, curviness: 0.5, twist: 0.4, hilliness: 0.3, hills: 0.45, biomes: ["blossom", "meadow"], timeOfDay: "midday" } },
];

const BIOMES = ["meadow", "forest", "desert", "mesa", "city", "beach", "jungle", "alpine", "tundra", "autumn", "blossom"];
const TODS = ["midday", "sunset", "night"];

// Deterministic RNG so a sweep is reproducible and a failing seed can be
// re-run on its own.
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomRecipes(n, salt = 1) {
  const r = mulberry(salt * 9301 + 49297);
  const out = [];
  for (let i = 0; i < n; i++) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let seed = "";
    for (let c = 0; c < 4; c++) seed += letters[Math.floor(r() * 26)];
    const nB = 1 + Math.floor(r() * 3);
    const biomes = [];
    while (biomes.length < nB) {
      const b = BIOMES[Math.floor(r() * BIOMES.length)];
      if (!biomes.includes(b)) biomes.push(b);
    }
    // Full knob range on purpose — the extremes are exactly where a generator
    // produces geometry nobody has driven.
    out.push({
      name: `random ${seed}`,
      cfg: {
        mode: "custom", seed,
        size: +(0.3 + r() * 0.6).toFixed(2),
        curviness: +(0.25 + r() * 0.65).toFixed(2),
        twist: +(0.25 + r() * 0.65).toFixed(2),
        hilliness: +(0.15 + r() * 0.75).toFixed(2),
        hills: +(0.2 + r() * 0.7).toFixed(2),
        biomes,
        timeOfDay: TODS[Math.floor(r() * TODS.length)],
      },
    });
  }
  return out;
}

// Every knob at its ceiling (the editor clamps 0..1), varying only the seed and
// the biome mix. This is the harshest thing the generator can be asked for —
// longest circuit, most corners, up to three self-crossings, maximum
// elevation — and therefore where undrivable geometry is most likely to hide.
function extremeRecipes(n, salt = 7) {
  const r = mulberry(salt * 9301 + 49297);
  const out = [];
  for (let i = 0; i < n; i++) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let seed = "";
    for (let c = 0; c < 4; c++) seed += letters[Math.floor(r() * 26)];
    const nB = 1 + Math.floor(r() * 3);
    const biomes = [];
    while (biomes.length < nB) {
      const b = BIOMES[Math.floor(r() * BIOMES.length)];
      if (!biomes.includes(b)) biomes.push(b);
    }
    out.push({
      name: `extreme ${seed}`,
      cfg: {
        mode: "custom", seed,
        size: 1, curviness: 1, twist: 1, hilliness: 1, hills: 1,
        biomes, timeOfDay: TODS[Math.floor(r() * TODS.length)],
      },
    });
  }
  return out;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (p === "/") p = "/index.html";
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(d);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

// Race one track and return its pathology counts.
async function auditTrack(entry) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 280 } });
  const pageErrors = [];
  await ctx.addInitScript((cfg) => {
    try {
      localStorage.setItem("zoomies-track-v1", JSON.stringify(cfg));
      localStorage.setItem("zoomies-mode-v1", "gp"); // a plain single race
      // We are auditing the SIMULATION, not the pixels — the cheapest renderer
      // setting makes the software-rendered sim run far closer to real time.
      localStorage.setItem("zoomies-quality-v2", "low");
    } catch { /* ignore */ }
  }, entry.cfg);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text().slice(0, 160)); });

  const out = { name: entry.name, cfg: entry.cfg, errors: [] };
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 180000 });
    await page.waitForSelector("#start-btn", { timeout: 30000 });

    // Start a race without walking the menu wizard: the GO button's handler is
    // bound at load and calls startRace() directly.
    await page.evaluate(() => document.getElementById("go-btn").click());
    // Hold the throttle for the human kart. It has no driver headless, and
    // leaving it parked turns it into a roadblock in the middle of the start
    // grid — which jams the whole field and reads as a track full of wedges.
    // It just drives; its own metrics are excluded.
    await page.keyboard.down("ArrowUp");

    // Wait for a real racing signal: main.js mirrors the race clock onto the
    // track every racing frame, so raceTime advancing means the countdown is
    // done and the field has been released.
    let rolling = false;
    for (let i = 0; i < 180; i++) {
      rolling = await page.evaluate(() => {
        const z = window.__zoomies;
        return !!(z && z.track && z.track.raceTime > 2 && z.karts &&
          z.karts.some((k) => !k.isPlayer && Math.abs(k.speed) > 6));
      }).catch(() => false);
      if (rolling) break;
      await page.waitForTimeout(1000);
    }
    if (!rolling) {
      out.errors.push("the field never got racing (build or countdown failed)");
      await ctx.close();
      return out;
    }

    // In-page sampler. Every timer runs on the GAME's race clock, not wall
    // time: under software rendering the simulation advances several times
    // slower than real time, so wall-clock thresholds would report a healthy
    // kart as wedged simply because the renderer is slow.
    await page.evaluate(() => {
      const z = window.__zoomies;
      const A = z.__audit = {
        samples: 0, grind: 0, wedged: 0, wedgedAt: [], stalled: 0, stalledWho: [],
        offroad: 0, offroadAt: [], bigAir: 0, maxAir: 0, nan: 0,
        speedSum: 0, sim: 0, simStart: z.track.raceTime, progress: {},
      };
      let last = z.track.raceTime;
      const st = new Map();
      z.__auditT = setInterval(() => {
        const now = z.track.raceTime;
        const dt = now - last;
        last = now;
        if (dt <= 0) return; // paused, or the loop hasn't stepped since last tick
        A.sim += dt;
        for (const k of z.karts) {
          if (k.isPlayer) continue;
          A.samples++;
          if (!Number.isFinite(k.position.x) || !Number.isFinite(k.position.y) || !Number.isFinite(k.speed)) {
            A.nan++;
            continue;
          }
          A.speedSum += Math.abs(k.speed);
          if (k.wallHitPulse > 0) A.grind++;
          A.maxAir = Math.max(A.maxAir, k.y);
          if (k.y > 6) A.bigAir++;

          // Outside the barriers: the containment clamp should make this
          // impossible, so any hit is a real physics escape.
          const proj = z.track.project(k.position);
          if (Math.abs(proj.lateral) > z.track.halfWidth + 2.5) {
            A.offroad++;
            if (A.offroadAt.length < 8) A.offroadAt.push(`${k.name} lat ${proj.lateral.toFixed(1)}`);
          }

          const s = st.get(k) || { x: k.position.x, z: k.position.z, t: 0, prog: k.totalProgress, ptime: 0 };
          // WEDGED — displacement, not speed: a kart shuffling through a pack
          // is racing; a kart that wants to go forward and has covered no
          // ground in seconds is caught on something. Spun-out karts (a
          // hairball hit) and karts crowded by a rival are excluded — that's
          // combat and traffic, not geometry.
          let crowded = false;
          for (const o of z.karts) {
            if (o === k) continue;
            if (Math.hypot(o.position.x - k.position.x, o.position.z - k.position.z) < 6.5) { crowded = true; break; }
          }
          if (k.throttleInput > 0.4 && k.spinTimer <= 0 && !crowded && !k.finished) {
            s.t += dt;
            if (Math.hypot(k.position.x - s.x, k.position.z - s.z) > 5) {
              s.x = k.position.x; s.z = k.position.z; s.t = 0;
            } else if (s.t > 3) {
              A.wedged++;
              if (A.wedgedAt.length < 8) A.wedgedAt.push(`${k.position.x.toFixed(0)},${k.position.z.toFixed(0)} @${A.sim.toFixed(0)}s`);
              s.x = k.position.x; s.z = k.position.z; s.t = 0;
            }
          } else {
            s.x = k.position.x; s.z = k.position.z; s.t = 0;
          }

          // STALLED — lap progress not advancing at all (can't get round,
          // whatever the reason).
          if (k.totalProgress > s.prog + 0.002) { s.prog = k.totalProgress; s.ptime = 0; }
          else if (!k.finished) {
            s.ptime += dt;
            if (s.ptime > 12) { A.stalled++; A.stalledWho.push(k.name); s.ptime = 0; }
          }
          st.set(k, s);
        }
      }, 100);
    });

    // Run for SECONDS of SIMULATED race time, capped in wall time so a broken
    // build can never hang the sweep. Hitting the cap is NOT a track failure —
    // see the outcome split below.
    const t0 = Date.now();
    let timedOut = false;
    for (;;) {
      await page.waitForTimeout(4000);
      const sim = await page.evaluate(() => window.__zoomies.__audit.sim).catch(() => 0);
      if (sim >= SECONDS) break;
      if (Date.now() - t0 > WALL_CAP) { timedOut = true; break; }
    }
    out.wallSeconds = Math.round((Date.now() - t0) / 1000);

    const a = await page.evaluate(() => {
      clearInterval(window.__zoomies.__auditT);
      const z = window.__zoomies;
      const A = z.__audit;
      A.progress = {};
      for (const k of z.karts) {
        if (k.isPlayer) continue;
        A.progress[k.name] = +k.totalProgress.toFixed(2);
      }
      A.totalLaps = z.track.totalLaps;
      A.trackLength = Math.round(z.track.length);
      return A;
    });
    out.stats = a;
    out.grindPct = +(a.grind / Math.max(1, a.samples) * 100).toFixed(1);
    out.meanSpeed = +(a.speedSum / Math.max(1, a.samples)).toFixed(1);
    out.simSeconds = +a.sim.toFixed(0);
    const progressed = Object.values(a.progress);
    out.minProgress = progressed.length ? +Math.min(...progressed).toFixed(2) : -99;

    // A run that ran out of wall clock without enough racing can't be judged.
    // Reporting that as a broken track would be a lie — and the kind of lie
    // that trains you to ignore the tool.
    if (timedOut && out.simSeconds < MIN_SIM) {
      out.inconclusive = `only ${out.simSeconds}s of race time in ${out.wallSeconds}s wall clock — too little to judge (raise WALLCAP or lower SECONDS)`;
      await ctx.close();
      return out;
    }
    // Past the minimum, the evidence gathered is plenty to spot a pathology:
    // judge it, and note that the sample was short.
    if (timedOut) out.partial = true;

    if (a.wedged > 0) out.errors.push(`${a.wedged} wedge event(s): ${a.wedgedAt.join(" | ")}`);
    if (out.grindPct > 12) out.errors.push(`barrier grind ${out.grindPct}% of race time`);
    if (a.stalled > 0) out.errors.push(`${a.stalled} lap-progress stall(s): ${[...new Set(a.stalledWho)].join(", ")}`);
    if (a.offroad > 0) out.errors.push(`${a.offroad} off-track sample(s) outside the barriers: ${a.offroadAt.join(" | ")}`);
    if (a.nan > 0) out.errors.push(`${a.nan} non-finite kart state sample(s)`);
    if (a.maxAir > 14) out.errors.push(`absurd hang time (max ${a.maxAir.toFixed(1)}u above the road)`);
    // PACE, not lap count: a drivable track lets the field average a real
    // fraction of top speed (34 u/s). Well under that means they are fighting
    // the geometry the whole way round even if nothing latches as a wedge.
    if (out.meanSpeed < 12) out.errors.push(`field averaged only ${out.meanSpeed} u/s over ${out.simSeconds}s of racing`);
    const fatal = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    if (fatal.length) out.errors.push(`page errors: ${[...new Set(fatal)].slice(0, 3).join(" | ")}`);
  } catch (e) {
    out.errors.push(`audit threw: ${String(e).slice(0, 160)}`);
  }
  await ctx.close();
  return out;
}

const list =
  WHICH === "random" ? randomRecipes(SEEDS)
  : WHICH === "extreme" ? extremeRecipes(SEEDS)
  : WHICH === "all" ? [...FEATURED, ...randomRecipes(SEEDS), ...extremeRecipes(SEEDS)]
  : WHICH === "featured" ? FEATURED
  : FEATURED.filter((f) => WHICH.split(",").map((s) => s.trim().toLowerCase()).includes(f.name.toLowerCase()));

if (!list.length) {
  console.error(`no tracks matched TRACKS="${WHICH}"`);
  process.exit(2);
}
console.error(`[track-audit] ${list.length} track(s) x ${SECONDS}s\n`);

const results = [];
for (const entry of list) {
  process.stderr.write(`  ${entry.name} … `);
  const r = await auditTrack(entry);
  results.push(r);
  process.stderr.write(
    r.inconclusive ? `INCONCLUSIVE\n      ${r.inconclusive}\n`
    : r.errors.length ? `FAIL (${r.errors.length})\n      ${r.errors.join("\n      ")}\n`
    : `ok${r.partial ? " (short sample)" : ""} (${r.simSeconds}s raced in ${r.wallSeconds}s, mean ${r.meanSpeed} u/s, grind ${r.grindPct}%)\n`
  );
}

const inconclusive = results.filter((r) => r.inconclusive);
const failed = results.filter((r) => !r.inconclusive && r.errors.length);
console.log(JSON.stringify({
  seconds: SECONDS,
  tracks: results.map((r) => ({
    name: r.name, seed: r.cfg.seed || null,
    outcome: r.inconclusive ? "inconclusive" : r.errors.length ? "fail" : r.partial ? "pass (short sample)" : "pass",
    grindPct: r.grindPct ?? null,
    meanSpeed: r.meanSpeed ?? null, simSeconds: r.simSeconds ?? null,
    wallSeconds: r.wallSeconds ?? null, minProgress: r.minProgress ?? null,
    wedged: r.stats?.wedged ?? null,
    maxAir: r.stats ? +r.stats.maxAir.toFixed(1) : null, errors: r.errors,
  })),
  passed: results.length - failed.length - inconclusive.length,
  failed: failed.length,
  inconclusive: inconclusive.length,
}, null, 2));

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
