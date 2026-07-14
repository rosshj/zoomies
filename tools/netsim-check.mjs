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

// 60s virtual each, fixed seeds. `strict` scenarios must produce zero snaps
// (a clean link should never need a teleport-correction).
// `strict` links (clean) must never snap-correct. `p50Budget` is a GENEROUS
// per-scenario ceiling on typical-frame delayed error (p50 — robust to the
// dropout tails that dominate p95 on lossy links); it catches a wholly broken
// run without pinning quality, which becomes baseline-tracked in a later step.
const MATRIX = [
  { name: "lan", seed: "LAN", players: field(2), hub: { latency: 20, jitter: 2, clockSkew: 0, loss: 0 }, clientSkews: [0, 0], strict: true, p50Budget: 4 },
  { name: "wifi", seed: "WIFI", players: field(3), hub: { latency: 60, jitter: 10, clockSkew: 300, loss: 0 }, clientSkews: [0, 5000, -5000], strict: true, p50Budget: 4 },
  { name: "cellular", seed: "CELL", players: field(4), hub: { latency: 140, jitter: 60, clockSkew: -1200, loss: 0.02 }, clientSkews: [0, 12000, -8000, 3000], p50Budget: 6 },
  { name: "awful", seed: "AWFUL", players: field(6), hub: { latency: 250, jitter: 120, clockSkew: 5000, loss: 0.05 }, clientSkews: [0, 40000, -40000, 15000, -22000, 8000], p50Budget: 15 },
];

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// Reduce a full summary to the small set of numbers we track as a baseline.
function keyMetrics(summary) {
  const errD = summary.series.errDelayed || { p50: 0, p95: 0 };
  const total = summary.counters["frames.total"] || 1;
  return {
    errDelayedP50: errD.p50,
    errDelayedP95: errD.p95,
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

  // Hard invariants (condition-independent):
  check(`[${sc.name}] no teleports (smooth displayed motion)`, teleports === 0);
  check(`[${sc.name}] ghosts actually rendered`, (summary.counters["frames.shown"] || 0) > 1000);
  check(`[${sc.name}] typical-frame error within budget (p50 ${errD.p50} < ${sc.p50Budget}u)`, errD.p50 < sc.p50Budget);
  if (sc.strict) check(`[${sc.name}] clean link → no snap-corrections`, snaps === 0);
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
  // Regression bands: a change may not meaningfully worsen delayed-error p95,
  // add snap-corrections, or extrapolate more. Slack absorbs float noise; a real
  // regression blows past it, a Stage-1 improvement passes comfortably (and
  // should be re-captured with --write-baseline).
  const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  console.log("\n— baseline comparison —");
  for (const sc of MATRIX) {
    const b = base[sc.name];
    const c = current[sc.name];
    if (!b) { console.log(`  (no baseline for ${sc.name})`); continue; }
    const errCap = b.errDelayedP95 * 1.15 + 0.05;
    const extrapCap = b.extrapShare * 1.25 + 0.01;
    check(`[${sc.name}] delayed-error p95 not regressed (${c.errDelayedP95} ≤ ${errCap.toFixed(4)})`, c.errDelayedP95 <= errCap);
    check(`[${sc.name}] no new snap-corrections (${c.snaps} ≤ ${b.snaps})`, c.snaps <= b.snaps);
    check(`[${sc.name}] extrapolation not regressed (${c.extrapShare} ≤ ${extrapCap.toFixed(4)})`, c.extrapShare <= extrapCap);
  }
} else {
  console.log("\n(no baseline yet — run with --write-baseline to capture one)");
}

if (failures) { console.log(`\n${failures} netsim check(s) FAILED`); process.exit(1); }
console.log("\nall netsim checks passed");
