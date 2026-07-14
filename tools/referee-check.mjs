// Headless tests for the pure race referee (src/net/referee.js) — the logic that
// runs inside the Cloudflare Durable Object. Everything is driven off an injected
// clock so hit rewinding, lap counting and finish ordering are exercised without
// any network or Cloudflare runtime. Run: `npm run check:referee`.
import { RefereeRoom, REFEREE_CONSTS } from "../src/net/referee.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };
const { FLAG_SHIELD } = REFEREE_CONSTS;

// A controllable clock so tests can advance "now" deterministically.
function clockRoom(totalLaps = 3) {
  let t = 100000;
  const room = new RefereeRoom({ now: () => t, totalLaps });
  return { room, at: (v) => { t = v; }, adv: (d) => { t += d; }, now: () => t };
}

// --- Lag-compensated position lookup ---
{
  const { room } = clockRoom();
  room.ingestState("a", { t: 1000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("a", { t: 1100, x: 10, z: 0, f: 0, pr: 0 });
  const mid = room.positionAt("a", 1050);
  check("positionAt interpolates between samples", Math.abs(mid.x - 5) < 1e-9 && mid.z === 0);
  check("positionAt clamps before the first sample", room.positionAt("a", 500).x === 0);
  check("positionAt clamps after the last sample", room.positionAt("a", 5000).x === 10);
  check("positionAt is null for an unknown player", room.positionAt("ghost", 1050) === null);
}

// --- Hit adjudication: clean accept ---
{
  const { room, adv } = clockRoom();
  room.ingestState("s", { t: 100000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 100000, x: 5, z: 0, f: 0, pr: 0 });
  adv(30); // claim is 30ms old — well within the rewind window
  const r = room.adjudicateHit({ shooter: "s", target: "v", t: 100000, dir: { x: 1, z: 0 } });
  check("clean hit is accepted", r.ok && r.event.target === "v" && r.event.by === "s");
  check("accepted hit stamps the referee clock", r.event.at === room["_now"]());
}

// --- Hit rejections ---
{
  const { room, adv } = clockRoom();
  room.ingestState("s", { t: 100000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 100000, x: 5, z: 0, f: 0, pr: 0 });
  adv(20);
  check("self-hit rejected", !room.adjudicateHit({ shooter: "s", target: "s", t: 100000 }).ok);
  check("unknown-target rejected", !room.adjudicateHit({ shooter: "s", target: "x", t: 100000 }).ok);
  // Stale claim: older than MAX_REWIND_MS.
  const stale = room.adjudicateHit({ shooter: "s", target: "v", t: 100000 - 500, dir: { x: 1, z: 0 } });
  check("stale claim rejected", !stale.ok && stale.reason === "stale-claim");
}

// --- Cooldown: a second hit inside the window is dropped ---
{
  const { room, adv } = clockRoom();
  room.ingestState("s", { t: 100000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 100000, x: 5, z: 0, f: 0, pr: 0 });
  adv(10);
  const first = room.adjudicateHit({ shooter: "s", target: "v", t: 100000, dir: { x: 1, z: 0 } });
  adv(50); // still inside HIT_COOLDOWN_MS
  const second = room.adjudicateHit({ shooter: "s", target: "v", t: 100040, dir: { x: 1, z: 0 } });
  check("first hit accepted, duplicate within cooldown rejected", first.ok && !second.ok && second.reason === "cooldown");
  adv(REFEREE_CONSTS.HIT_COOLDOWN_MS); // past the window
  const third = room.adjudicateHit({ shooter: "s", target: "v", t: room["_now"]() - 5, dir: { x: 1, z: 0 } });
  check("hit accepted again after the cooldown expires", third.ok);
}

// --- Lag-compensated shield: up at fire-time saves the victim even if down now ---
{
  const { room, adv } = clockRoom();
  room.ingestState("s", { t: 100000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 100000, x: 5, z: 0, f: FLAG_SHIELD, pr: 0 }); // shielded at fire-time
  room.ingestState("v", { t: 100100, x: 5, z: 0, f: 0, pr: 0 });          // shield dropped later
  adv(20); // now ≈ 100120
  const rewound = room.adjudicateHit({ shooter: "s", target: "v", t: 100000, dir: { x: 1, z: 0 } });
  check("shield UP at fire-time rejects the hit (lag comp)", !rewound.ok && rewound.reason === "shielded");
  const nowClaim = room.adjudicateHit({ shooter: "s", target: "v", t: 100100, dir: { x: 1, z: 0 } });
  check("same victim, shield DOWN at fire-time → hit lands", nowClaim.ok);
}

// --- Out-of-range sanity ---
{
  const { room, adv } = clockRoom();
  room.ingestState("s", { t: 100000, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 100000, x: 500, z: 0, f: 0, pr: 0 }); // across the map
  adv(20);
  const r = room.adjudicateHit({ shooter: "s", target: "v", t: 100000, dir: { x: 1, z: 0 } });
  check("cross-map hit claim rejected as out-of-range", !r.ok && r.reason === "out-of-range");
}

// --- Lap counting ---
{
  const { room, adv } = clockRoom();
  check("no lap at partial progress", room.ingestState("a", { t: 1, x: 0, z: 0, f: 0, pr: 0.5 }) === null);
  adv(100);
  const l1 = room.ingestState("a", { t: 2, x: 0, z: 0, f: 0, pr: 1.02 });
  check("crossing into lap 1 grants exactly one lap", l1 && l1.lap === 1 && l1.id === "a");
  check("no re-grant while still in the same lap", room.ingestState("a", { t: 3, x: 0, z: 0, f: 0, pr: 1.4 }) === null);
  check("backward progress grants nothing", room.ingestState("a", { t: 4, x: 0, z: 0, f: 0, pr: 1.1 }) === null);
  const tele = room.ingestState("a", { t: 5, x: 0, z: 0, f: 0, pr: 3.0 }); // +1.6 jump
  check("teleport jump advances the marker but grants no lap", tele === null);
  const l2 = room.ingestState("a", { t: 6, x: 0, z: 0, f: 0, pr: 3.05 });
  check("normal step after a teleport-marker grants the next lap", l2 && l2.lap === 3);
}

// --- Finish ordering by referee arrival, not client claim ---
{
  const { room, adv } = clockRoom(2);
  room.ingestState("a", { t: 1, x: 0, z: 0, f: 0, pr: 2.01 }); // both completed 2 laps
  room.ingestState("b", { t: 1, x: 0, z: 0, f: 0, pr: 2.5 });
  const early = room.adjudicateFinish("c"); // unknown
  check("finish for unknown player rejected", !early.ok);
  room.ingestState("d", { t: 1, x: 0, z: 0, f: 0, pr: 1.2 }); // hasn't finished the race
  check("finish rejected when laps incomplete", !room.adjudicateFinish("d").ok);
  adv(10);
  const fa = room.adjudicateFinish("a");
  adv(10);
  const fb = room.adjudicateFinish("b");
  check("first arrival gets place 1", fa.ok && fa.event.place === 1);
  check("second arrival gets place 2", fb.ok && fb.event.place === 2);
  const again = room.adjudicateFinish("a");
  check("finish is idempotent (same place on repeat)", again.ok && again.event.place === 1);
  check("standings list finishers in place order", JSON.stringify(room.standings().map((s) => s.id)) === JSON.stringify(["a", "b"]));
}

// --- Determinism: same script + same injected clock → identical verdicts ---
function scripted() {
  const { room, at } = clockRoom();
  at(200000);
  room.ingestState("s", { t: 199990, x: 0, z: 0, f: 0, pr: 0 });
  room.ingestState("v", { t: 199990, x: 6, z: 0, f: 0, pr: 0 });
  return room.adjudicateHit({ shooter: "s", target: "v", t: 199990, dir: { x: 1, z: 0 } });
}
check("same script → identical verdict", JSON.stringify(scripted()) === JSON.stringify(scripted()));

if (failures) { console.log(`\n${failures} referee check(s) FAILED`); process.exit(1); }
console.log("\nall referee checks passed");
