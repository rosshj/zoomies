// Netsim harness CLI. Runs the scenario matrix (a spread of network conditions
// from LAN to awful cellular) against the real send loop + interpolation + clock
// sync extracted from main.js, checks hard invariants, and proves the whole thing
// is deterministic (same seed → byte-identical metrics).
//
//   npm run check:netsim            run the matrix, invariants + determinism
//   node tools/netsim-check.mjs --json   also dump full metrics JSON
//
// Baseline capture/compare (--write-baseline) is wired in a later step.
import { runScenario } from "../src/net/sim/scenario.js";
import { circleDriver, figureEightDriver } from "../src/net/sim/drivers.js";

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");

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

const results = {};
for (const sc of MATRIX) {
  const summary = await runScenario({
    seed: sc.seed, players: sc.players, durationMs: 60000, tickHz: 60,
    hub: sc.hub, clientSkews: sc.clientSkews,
  });
  results[sc.name] = summary;

  const errD = summary.series.errDelayed || { p50: 0, p95: 0, avg: 0 };
  const errA = summary.series.errAbs || { p95: 0 };
  const stale = summary.series.staleness || { p50: 0, p95: 0 };
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
    `\n   extrap ${(extrapShare * 100).toFixed(1)}% · hidden ${(hiddenShare * 100).toFixed(1)}% · snaps ${snaps} · teleports ${teleports}`,
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

if (failures) { console.log(`\n${failures} netsim check(s) FAILED`); process.exit(1); }
console.log("\nall netsim checks passed");
