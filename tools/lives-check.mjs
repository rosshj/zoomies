// Nine Lives mechanics on a headless Kart: a banked heart downgrades spinOut to
// a speed-keeping wobble (consumed, capped at 3). Imports three
// (steps a real Kart), so it runs locally like check:sim — not in the node-only CI.
// Run: `npm run check:lives`.
import * as THREE from "three";
import { Kart } from "../src/kart.js";
import { makeRng } from "../src/rng.js";
function simTrack(length = 400, halfWidth = 10) {
  return {
    length, halfWidth, totalLaps: 3, raceTime: 0,
    project(pos) { const t = (((pos.x / length) % 1) + 1) % 1; return { t, point: new THREE.Vector3(pos.x, 0, 0), tangent: new THREE.Vector3(1, 0, 0), side: new THREE.Vector3(0, 0, 1), lateral: pos.z, groundY: 0 }; },
    getPointAt(t, out) { out.set(t * length, 0, 0); return out; },
    getTangentAt(t, out) { out.set(1, 0, 0); return out; },
  };
}
const track = simTrack();
const mk = () => { const k = new Kart({ name: "P", color: 0x888888, catColor: 0x888888, catPattern: 0, catAccessory: 0, catAccessoryColor: 0, kartStyle: 0, kartNumber: 1, headless: true, isPlayer: true, rng: makeRng("LIVES") }); k.placeAt(new THREE.Vector3(0, 0, 0), 0, track); return k; };
const dt = 1 / 60;
let fails = 0;
const check = (n, c) => { console.log((c ? "  ok  " : "FAIL  ") + n); if (!c) fails++; };

// 1) Without a life: spinOut wipes out (speed → 0, spinTimer set).
const a = mk(); a.throttleInput = 1;
for (let i = 0; i < 240; i++) { track.raceTime += dt; a.update(dt, track); }
const preSpeed = a.speed;
a.spinOut();
check("no life → real spinout (spinTimer set, speed zeroed)", a.spinTimer > 0 && a.speed === 0);

// 2) With a life: downgraded to a wobble — keeps most speed, consumes the heart.
const b = mk(); b.throttleInput = 1;
for (let i = 0; i < 240; i++) { track.raceTime += dt; b.update(dt, track); }
b.giveLife();
check("giveLife banks a heart", b.lives === 1);
const s0 = b.speed;
b.spinOut();
check("life fires: no spinTimer, wobble armed, heart consumed, pulse set",
  b.spinTimer === 0 && b.wobbleTimer > 0 && b.lives === 0 && b.lifePulse === true);
let minSpeed = b.speed;
for (let i = 0; i < 60; i++) { track.raceTime += dt; b.update(dt, track); minSpeed = Math.min(minSpeed, Math.abs(b.speed)); }
check(`kept most speed through the wobble (min ${minSpeed.toFixed(1)} vs ${s0.toFixed(1)} pre-hit)`, minSpeed > s0 * 0.6);
check("wobble expired", b.wobbleTimer <= 0);

// 3) Second hit without a heart → real wipeout again.
b.spinOut();
check("next hit (no heart left) → real spinout", b.spinTimer > 0);

// 4) Lives cap at 3.
const c = mk(); c.giveLife(); c.giveLife(); c.giveLife(); c.giveLife();
check("lives cap at 3", c.lives === 3);


console.log(fails ? `${fails} FAILED` : "all nine-lives checks passed");
process.exit(fails ? 1 : 0);
