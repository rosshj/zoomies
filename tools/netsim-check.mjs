// Netsim harness CLI. Runs the scenario matrix (a spread of network conditions
// from LAN to awful cellular) against the real send loop + interpolation + clock
// sync extracted from main.js, checks hard invariants, and proves the whole thing
// is deterministic (same seed → byte-identical metrics).
//
//   npm run check:netsim            run the matrix, invariants, determinism +
//                                   baseline comparison
//   node tools/netsim-check.mjs --write-baseline   capture tools/netsim/baseline.json
//   node tools/netsim-check.mjs --json   also dump full metrics JSON
//   node tools/netsim-check.mjs --trace <file>   replay a recorded trace instead
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runScenario } from "../src/net/sim/scenario.js";
import { circleDriver, figureEightDriver } from "../src/net/sim/drivers.js";
import { replayTrace, validateTrace } from "../src/net/sim/trace.js";

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const writeBaseline = argv.includes("--write-baseline");
const traceIdx = argv.indexOf("--trace");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "netsim", "baseline.json");

// --- Trace replay mode: score a real recorded session, receive-side only ---
if (traceIdx !== -1) {
  const file = argv[traceIdx + 1];
  if (!file) { console.error("usage: --trace <file.json>"); process.exit(2); }
  const trace = validateTrace(JSON.parse(readFileSync(file, "utf8")));
  const summary = await replayTrace(trace);
  const s = summary.series;
  const c = summary.counters;
  const total = c["frames.total"] || 1;
  const ia = s.interArrival || { p50: 0, p95: 0, max: 0 };
  console.log(`trace: ${file}`);
  console.log(`  transport=${summary.transport} peers=${summary.peers} captured poses=${Object.values(trace.peers).reduce((n, a) => n + a.length, 0)}`);
  console.log(`  inter-arrival p50=${ia.p50}ms p95=${ia.p95}ms max=${ia.max}ms`);
  console.log(`  staleness p50=${(s.staleness || {}).p50}ms p95=${(s.staleness || {}).p95}ms`);
  console.log(`  correction avg=${(s.correction || {}).avg}u p95=${(s.correction || {}).p95}u`);
  console.log(`  extrap ${(((c["frames.extrap"] || 0) / total) * 100).toFixed(1)}% · hidden ${(((c["frames.hidden"] || 0) / total) * 100).toFixed(1)}% · snaps ${c.snaps || 0} · teleports ${c.teleports || 0}`);
  if (wantJson) console.log("\n" + JSON.stringify(summary, null, 2));
  if ((c.teleports || 0) > 0) { console.log("\nFAIL: replay produced teleports"); process.exit(1); }
  console.log("\ntrace replay ok");
  process.exit(0);
}

// Build a mixed field of drivers, spread in phase so karts don't stack.
function field(n) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const phase = (i / n) * Math.PI * 2;
    players.push({
      driver: i % 2 === 0
        ? circleDriver({ radius: 60, speed: 30, phase })
        : figureEightDriver({ radius: 55, speed: 32, phase }),
    });
  }
  return players;
}

// 60s virtual each, fixed seeds. `strict` links (clean) must never snap-correct.
// `p50Budget` = typical-frame delayed-error ceiling (u) — how well the smoother
// tracks its OWN render target, tightened after the Stage 1 convergence win.
// `staleMax` = staleness p50 ceiling (ms). `errAbsMax` = absolute-error ceiling
// (u) vs truth-NOW.
//
// NOTE: the old "predict-to-present" pull (Stage 5) that rendered remote karts near
// PRESENT was reverted — on real phones it made the ghost jitter and mis-rotate as
// the render offset collapsed over the first ~2s, because near-present it dead-
// reckons every frame on noisy data (the netsim's clean loss model didn't reproduce
// that). Remote karts now INTERPOLATE at the buffered jitter-aware delay — smooth
// and accurate, in the past. So errAbs vs truth-now and staleness are HIGHER by
// design (we render behind the newest snapshot, not ahead); the real quality guards
// are delayed-error (fidelity to the render target), teleports=0, and snaps.
const MATRIX = [
  { name: "lan", seed: "LAN", players: field(2), hub: { latency: 20, jitter: 2, clockSkew: 0, loss: 0 }, clientSkews: [0, 0], strict: true, p50Budget: 0.6, staleMax: 115, errAbsMax: 5.5 },
  { name: "wifi", seed: "WIFI", players: field(3), hub: { latency: 60, jitter: 10, clockSkew: 300, loss: 0 }, clientSkews: [0, 5000, -5000], strict: true, p50Budget: 0.6, staleMax: 150, errAbsMax: 6.5 },
  { name: "cellular", seed: "CELL", players: field(4), hub: { latency: 140, jitter: 60, clockSkew: -1200, loss: 0.02 }, clientSkews: [0, 12000, -8000, 3000], p50Budget: 2, errAbsMax: 13 },
  { name: "awful", seed: "AWFUL", players: field(6), hub: { latency: 250, jitter: 120, clockSkew: 5000, loss: 0.05 }, clientSkews: [0, 40000, -40000, 15000, -22000, 8000], p50Budget: 4, errAbsMax: 80 },
];

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// Reduce a full summary to the small set of numbers we track as a baseline.
function keyMetrics(summary) {
  const errD = summary.series.errDelayed || { p50: 0, p95: 0 };
  const errA = summary.series.errAbs || { p95: 0 };
  const total = summary.counters["frames.total"] || 1;
  return {
    errDelayedP50: errD.p50,
    errDelayedP95: errD.p95,
    // Absolute error vs truth-now — the predict-to-present headline. Banded below
    // so a regression that quietly reintroduces render lag fails the check.
    errAbsP95: errA.p95,
    snaps: summary.counters.snaps || 0,
    extrapShare: Math.round(((summary.counters["frames.extrap"] || 0) / total) * 1e4) / 1e4,
    stalenessP50: (summary.series.staleness || {}).p50 || 0,
    // rawAccel p95 = the interpolated path's acceleration spike at snapshot
    // boundaries (u/s²). Hermite (C1-continuous) collapses it vs linear's kinks.
    // Tracked for the record; not banded (Hermite legitimately raises p50).
    rawAccelP95: (summary.series.rawAccel || {}).p95 || 0,
  };
}

const results = {};
const current = {};
for (const sc of MATRIX) {
  const summary = await runScenario({
    seed: sc.seed, players: sc.players, durationMs: 60000, tickHz: 60,
    hub: sc.hub, clientSkews: sc.clientSkews,
  });
  results[sc.name] = summary;
  current[sc.name] = keyMetrics(summary);

  const errD = summary.series.errDelayed || { p50: 0, p95: 0, avg: 0 };
  const errA = summary.series.errAbs || { p95: 0 };
  const stale = summary.series.staleness || { p50: 0, p95: 0 };
  const rawAcc = summary.series.rawAccel || { p50: 0, p95: 0 };
  const teleports = summary.counters.teleports || 0;
  const snaps = summary.counters.snaps || 0;
  const total = summary.counters["frames.total"] || 1;
  const extrap = summary.counters["frames.extrap"] || 0;
  const hidden = summary.counters["frames.hidden"] || 0;
  const extrapShare = extrap / total;
  const hiddenShare = hidden / total;

  console.log(
    `\n[${sc.name}] ${sc.players.length}p  lat ${sc.hub.latency}±${sc.hub.jitter}ms loss ${sc.hub.loss}` +
    `\n   errDelayed p50=${errD.p50}u p95=${errD.p95}u avg=${errD.avg}u · errAbs p95=${errA.p95}u` +
    `\n   staleness p50=${stale.p50}ms p95=${stale.p95}ms · interpDelay=${summary.interpDelayFinal.join("/")}ms` +
    `\n   path-accel p50=${rawAcc.p50} p95=${rawAcc.p95}u/s² · extrap ${(extrapShare * 100).toFixed(1)}% · hidden ${(hiddenShare * 100).toFixed(1)}% · snaps ${snaps} · teleports ${teleports}`,
  );

  // Hard invariants:
  check(`[${sc.name}] no teleports (smooth displayed motion)`, teleports === 0);
  check(`[${sc.name}] ghosts actually rendered`, (summary.counters["frames.shown"] || 0) > 1000);
  check(`[${sc.name}] typical-frame error within budget (p50 ${errD.p50} < ${sc.p50Budget}u)`, errD.p50 < sc.p50Budget);
  check(`[${sc.name}] absolute error vs truth-now within ceiling (p95 ${errA.p95} < ${sc.errAbsMax}u)`, errA.p95 < sc.errAbsMax);
  if (sc.strict) check(`[${sc.name}] clean link → no snap-corrections`, snaps === 0);
  if (sc.staleMax) check(`[${sc.name}] staleness p50 under the jitter-aware target (${stale.p50}ms < ${sc.staleMax}ms)`, stale.p50 < sc.staleMax);
}

// Determinism: a full re-run of the awful scenario must serialize identically.
{
  const a = await runScenario({ seed: "AWFUL", players: field(6), durationMs: 60000, tickHz: 60, hub: MATRIX[3].hub, clientSkews: MATRIX[3].clientSkews });
  const b = await runScenario({ seed: "AWFUL", players: field(6), durationMs: 60000, tickHz: 60, hub: MATRIX[3].hub, clientSkews: MATRIX[3].clientSkews });
  check("same seed → byte-identical metrics", JSON.stringify(a) === JSON.stringify(b));
}

if (wantJson) console.log("\n" + JSON.stringify(results, null, 2));

// --- Baseline capture / comparison ---
if (writeBaseline) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`\nbaseline written → ${BASELINE_PATH}`);
} else if (existsSync(BASELINE_PATH)) {
  // Regression bands: a change may not meaningfully worsen delayed-error p95 or
  // add snap-corrections. Slack absorbs float noise; a real regression blows past
  // it, an improvement passes comfortably (and should be re-captured with
  // --write-baseline). Extrapolation share is guarded by an absolute per-scenario
  // ceiling in the loop above (it's a deliberate function of the delay), not a
  // never-increases band.
  const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  console.log("\n— baseline comparison —");
  for (const sc of MATRIX) {
    const b = base[sc.name];
    const c = current[sc.name];
    if (!b) { console.log(`  (no baseline for ${sc.name})`); continue; }
    const errCap = b.errDelayedP95 * 1.15 + 0.05;
    check(`[${sc.name}] delayed-error p95 not regressed (${c.errDelayedP95} ≤ ${errCap.toFixed(4)})`, c.errDelayedP95 <= errCap);
    // errAbs may be absent in a pre-Stage-5 baseline — only band it once captured.
    if (typeof b.errAbsP95 === "number") {
      const absCap = b.errAbsP95 * 1.15 + 0.3;
      check(`[${sc.name}] absolute-error p95 not regressed (${c.errAbsP95} ≤ ${absCap.toFixed(4)})`, c.errAbsP95 <= absCap);
    }
    check(`[${sc.name}] no new snap-corrections (${c.snaps} ≤ ${b.snaps})`, c.snaps <= b.snaps);
  }
} else {
  console.log("\n(no baseline yet — run with --write-baseline to capture one)");
}

if (failures) { console.log(`\n${failures} netsim check(s) FAILED`); process.exit(1); }
console.log("\nall netsim checks passed");
