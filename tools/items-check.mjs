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
  check("3 floating boxes on a small track", before === 3);

  const kart = { name: "P1" };
  for (let x = -6; x < LEN + 6; x += 3) props.update(0.05, [{ x, z: 0, kart }]);
  check("all three boxes grabbed", picks.length === 3);
  check("each grant went to the driver", picks.every((n) => n === "P1"));
  check("pool empties right after pickup", props.boxTargets().length === 0);

  // Idle ~12s: a roadside crate should rise to refill the pool back to 3.
  for (let t = 0; t < 240; t++) props.update(0.05, []);
  check("pool refills to 3 from rising ground crates", props.boxTargets().length === 3);

  // A kart on cooldown (onItem returns false) must NOT consume the box.
  const props2 = await initProps({ add() {}, remove() {} }, track, {
    seed: "items-check-2", size: 0.5, heightAt: () => 0, onItem: () => false,
  });
  const k2 = { name: "P2" };
  for (let x = -6; x < LEN + 6; x += 3) props2.update(0.05, [{ x, z: 0, kart: k2 }]);
  check("a refused pickup leaves the box floating", props2.boxTargets().length === 3);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall item-box checks passed");
