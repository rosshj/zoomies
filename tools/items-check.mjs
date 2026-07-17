// Headless regression tests for the item-box / power-up systems. Pure-logic
// checks (no browser): they import the game modules directly with tiny stubs and
// assert behaviour, exiting non-zero on the first failure. Run: `npm run check:items`.
//
// Covers:
//   - the tri-furball fan (spawn fans 3, consumes one charge, 4th shot is single)
//   - the TRI_FAN spread constant stays a symmetric 3-way
//   - the floating power-up box lifecycle: drive-through grants to the right kart,
//     the box sinks, and a roadside crate rises to refill the pool
import * as THREE from "three";
import { HairballManager, TRI_FAN } from "../src/hairball.js";
import { initProps } from "../src/props.js";
import { ItemManager } from "../src/items.js";

// A dead-straight track along +x (z = lateral) with just the methods ItemManager
// needs — enough to unit-test yarn/milk without the full procedural track.
function straightTrack(LEN = 200, halfWidth = 10) {
  return {
    length: LEN, halfWidth,
    project(pos) {
      const t = (((pos.x / LEN) % 1) + 1) % 1;
      return { t, point: new THREE.Vector3(pos.x, 0, 0), tangent: new THREE.Vector3(1, 0, 0), side: new THREE.Vector3(0, 0, 1), lateral: pos.z, groundY: 0 };
    },
    getPointAt(t, out) { out.set(t * LEN, 0, 0); return out; },
    getTangentAt(t, out) { out.set(1, 0, 0); return out; },
  };
}
const stubScene = { add() {}, remove() {} };
function milkKart(x, over = {}) {
  return { finished: false, spinTimer: 0, y: 0, catnipBoosting: false, shielding: false, heading: 0, position: new THREE.Vector3(x, 0, 0), spun: false, spinOut() { this.spun = true; this.spinTimer = 1.4; }, ...over };
}

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}`); failures++; }
}

// --- Tri-furball fan -------------------------------------------------------
{
  check("TRI_FAN is a symmetric 3-way", TRI_FAN.length === 3 && TRI_FAN[1] === 0 && TRI_FAN[0] === -TRI_FAN[2] && TRI_FAN[0] < 0);

  const hm = new HairballManager({ add() {}, remove() {} });
  const owner = { triShots: 3, muzzle: () => ({ pos: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(0, 0, 1) }) };
  hm.spawn(owner); hm.spawn(owner); hm.spawn(owner); // three tri-shots → 3 fans of 3
  check("three tri-shots spawn 9 balls", hm.balls.length === 9);
  check("tri charge fully consumed", owner.triShots === 0);
  const dirs = hm.balls.slice(0, 3).map((b) => b.vel.clone().setY(0).normalize());
  check("a fan spreads (outer shots differ, centre straight)", Math.abs(dirs[0].x - dirs[2].x) > 0.1 && Math.abs(dirs[1].x) < 1e-6);
  hm.spawn(owner); // 4th: no charge left → a single ball
  check("post-charge shot is a single ball", hm.balls.length === 10);
}

// --- Floating power-up box lifecycle --------------------------------------
{
  const N = 200, LEN = 200;
  const pts = [], tans = [];
  for (let i = 0; i < N; i++) { pts.push(new THREE.Vector3(i * (LEN / N), 0, 0)); tans.push(new THREE.Vector3(1, 0, 0)); }
  const track = {
    samples: N, length: LEN, halfWidth: 10, _pts: pts, _tans: tans,
    groundInfo: () => ({ y: 0, dist: 0 }), distanceToCenter: (x, z) => Math.abs(z),
  };
  const picks = [];
  const props = await initProps({ add() {}, remove() {} }, track, {
    seed: "items-check", size: 0.5, heightAt: () => 0, onItem: (k) => { picks.push(k.name); return true; },
  });
  check("props built", !!props);
  const before = props.boxTargets().length;
  check("5 floating boxes on a small track", before === 5);

  // Drive through one box (at its own position) so we don't bulldoze the whole
  // field — it grants to the driver and stops floating (it tumbles off as a spent
  // crate), dropping the pool to 4.
  const kart = { name: "P1" };
  const target = props.boxTargets()[0];
  for (let s = -6; s <= 6; s += 3) props.update(0.05, [{ x: target.x + s, z: target.z, kart }]);
  check("driving through a box grants it to the driver", picks.length === 1 && picks[0] === "P1");
  check("the used box stops floating", props.boxTargets().length === 4);

  // Idle ~15s: a roadside crate should rise to refill the pool back to 5.
  for (let t = 0; t < 300; t++) props.update(0.05, []);
  check("pool refills to 5 from a rising ground crate", props.boxTargets().length === 5);

  // A kart on cooldown (onItem returns false) must NOT consume the box.
  const props2 = await initProps({ add() {}, remove() {} }, track, {
    seed: "items-check-2", size: 0.5, heightAt: () => 0, onItem: () => false,
  });
  const k2 = { name: "P2" };
  for (let x = -6; x < LEN + 6; x += 3) props2.update(0.05, [{ x, z: 0, kart: k2 }]);
  check("a refused pickup leaves the box floating", props2.boxTargets().length === 5);
}

// --- Milk replication (spawnMilkAt, victim-authoritative) -----------------
{
  const track = straightTrack();
  const im = new ItemManager(stubScene, track);

  const puddle = im.spawnMilkAt({ x: 50, z: 0, r: 3 });
  check("spawnMilkAt creates an owner-less, grace-free puddle",
    im.puddles.length === 1 && puddle.owner === null && puddle.grace === 0 && puddle.r === 3 && puddle.x === 50);

  const p1 = milkKart(50);
  im.update(0.016, [p1], {});
  check("a replicated puddle trips a local player driving through it", p1.spun === true);

  im.spawnMilkAt({ x: 100, z: 0, r: 3 });
  const hopper = milkKart(100, { y: 1.5 });
  im.update(0.016, [hopper], {});
  check("airborne kart hops the puddle (no spin)", hopper.spun === false);
  const catCart = milkKart(100, { catnipBoosting: true });
  im.update(0.016, [catCart], {});
  check("catnip plows through the puddle (no spin)", catCart.spun === false);

  im.spawnMilkAt({ x: 150, z: 0, r: 3 });
  const shielded = milkKart(150, { shielding: true });
  im.update(0.016, [shielded], {});
  check("shield does NOT save you from milk (floor hazard)", shielded.spun === true);

  const far = milkKart(150 + 3 + 1.2 + 0.5); // just outside r+1.2
  im.spawnMilkAt({ x: 300, z: 0, r: 3 });
  im.update(0.016, [far], {});
  check("a kart clear of every puddle is untouched", far.spun === false);
}

// --- Yarn replication (ghost cosmetic, shooter-authoritative remote bridge) --
{
  const track = straightTrack();
  const im = new ItemManager(stubScene, track);
  // Owner near t=0.1 (x=20). spawnYarn reads owner._proj + speed.
  const owner = { position: new THREE.Vector3(20, 0, 0), speed: 20, _proj: { t: 0.1, lateral: 0 }, trackT: 0.1 };

  // A REAL yarn spins a local kart sitting in its arc window.
  const yr = im.spawnYarn(owner, null);
  check("spawnYarn returns a non-ghost record", !!yr && yr.ghost === false);
  const victim = milkKart(21.5, { trackT: 0.1075, _proj: { lateral: 0 } });
  im.update(0.001, [owner, victim], {});
  check("a real yarn spins a kart in its arc window", victim.spun === true);

  // A GHOST yarn (a remote's, replicated) never decides a hit — cosmetic only.
  const gy = im.spawnYarnGhost({ t: 0.1, lat: 0, speed: 60, life: 12, target: null });
  check("spawnYarnGhost creates a ghost record", !!gy && gy.ghost === true);
  const bystander = milkKart(21.5, { trackT: 0.1075, _proj: { lateral: 0 } });
  im.update(0.001, [bystander], {});
  check("a ghost yarn never spins a kart (cosmetic)", bystander.spun === false);

  // The shooter's live yarn hits a remote GHOST world-space via the bridge.
  function bridgeHit(ghostOver) {
    const im2 = new ItemManager(stubScene, track);
    im2.spawnYarn(owner, null);
    const hits = [];
    const gk = { position: new THREE.Vector3(20, 0, 0), y: 0, shielding: false, catnipBoosting: false, ...ghostOver };
    const remotes = new Map([["R1", { _ready: true, id: "R1", kart: gk }]]);
    im2.update(0.001, [owner], {}, remotes, (id) => hits.push(id));
    return hits;
  }
  check("yarn hits a remote ghost world-space → onRemoteHit fires", bridgeHit({}).length === 1);
  check("a hopped remote ghost dodges the yarn (no remote hit)", bridgeHit({ y: 1.5 }).length === 0);
  check("a shielded remote ghost blocks the yarn (no remote hit)", bridgeHit({ shielding: true }).length === 0);
  check("a catnip remote ghost blocks the yarn (no remote hit)", bridgeHit({ catnipBoosting: true }).length === 0);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall item-box checks passed");
