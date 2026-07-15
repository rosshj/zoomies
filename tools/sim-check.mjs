// Determinism tests for the kart sim (src/kart.js). A real Kart is stepped
// HEADLESS (no meshes) over a scripted input sequence; the same seed must
// reproduce a bit-identical trajectory. This is the foundation for replay +
// server re-simulation. Run: `npm run check:sim`.
import * as THREE from "three";
import { Kart } from "../src/kart.js";
import { makeRng } from "../src/rng.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// Minimal flat straight track along +x (z = lateral) with the methods kart
// physics queries. Determinism doesn't need real geometry — same inputs on the
// same track give the same output whatever its shape.
function simTrack(length = 400, halfWidth = 10) {
  return {
    length, halfWidth, totalLaps: 3, raceTime: 0,
    project(pos) {
      const t = (((pos.x / length) % 1) + 1) % 1;
      return { t, point: new THREE.Vector3(pos.x, 0, 0), tangent: new THREE.Vector3(1, 0, 0), side: new THREE.Vector3(0, 0, 1), lateral: pos.z, groundY: 0 };
    },
    getPointAt(t, out) { out.set(t * length, 0, 0); return out; },
    getTangentAt(t, out) { out.set(1, 0, 0); return out; },
  };
}
const baseCfg = { name: "P", color: 0x888888, catColor: 0x888888, catPattern: 0, catAccessory: 0, catAccessoryColor: 0, kartStyle: 0, kartNumber: 1, headless: true };

// Step a player kart through a fixed script (steer/throttle/drift/jump + a
// seeded spin-out) and return its full per-frame state trajectory.
function runPlayer(seed) {
  const rng = makeRng(seed + "|sim");
  const track = simTrack();
  const k = new Kart({ ...baseCfg, isPlayer: true, rng });
  k.placeAt(new THREE.Vector3(0, 0, 0), 0, track);
  const trace = [];
  const dt = 1 / 60;
  let raceTime = 0;
  for (let i = 0; i < 600; i++) {
    raceTime += dt; track.raceTime = raceTime;
    k.steerInput = Math.sin(i * 0.05) * 0.8;
    k.throttleInput = 1;
    k.driftHeld = i > 100 && i < 220;
    if (i === 150) k.jump();
    if (i === 300) k.spinOut(new THREE.Vector3(1, 0, 0)); // spin dir is seeded
    k.update(dt, track);
    trace.push([k.position.x, k.position.z, k.heading, k.speed, k.y, k.spinTimer, k.spinDir, k.totalProgress]);
  }
  return trace;
}

const a = runPlayer("ZOOM");
const b = runPlayer("ZOOM");
check("headless kart steps with no mesh", a.length === 600 && Number.isFinite(a[599][0]) && a[599][0] !== 0);
check("same seed → bit-identical 600-frame trajectory", JSON.stringify(a) === JSON.stringify(b));
check("kart reached racing speed", Math.max(...a.map((s) => s[3])) > 20);
check("kart made forward progress", Math.max(...a.map((s) => s[0])) > 10);
check("kart cornered (moved laterally)", Math.max(...a.map((s) => Math.abs(s[1]))) > 0.5);
check("seeded spin-out engaged at frame 300", a[300][5] > 0 && (a[300][6] === 1 || a[300][6] === -1));

// A different seed changes the spin direction → the trajectory diverges after
// the spin, proving the seed actually drives the sim (not incidental).
const c = runPlayer("OTHER");
check("a different seed diverges the trajectory", JSON.stringify(a) !== JSON.stringify(c));

// AI traits (lane bias + shield skill) reproduce per seed and vary across seeds.
function aiTraits(seed) {
  const rng = makeRng(seed + "|sim");
  const mk = () => new Kart({ ...baseCfg, isPlayer: false, rng });
  const a1 = mk(), a2 = mk();
  return [a1.laneBias, a1.shieldSkill, a2.laneBias, a2.shieldSkill];
}
check("AI traits reproduce for a seed", JSON.stringify(aiTraits("GRID")) === JSON.stringify(aiTraits("GRID")));
check("AI traits differ across seeds", JSON.stringify(aiTraits("GRID")) !== JSON.stringify(aiTraits("GRID2")));

if (failures) { console.log(`\n${failures} sim check(s) FAILED`); process.exit(1); }
console.log("\nall sim checks passed");
