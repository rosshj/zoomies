// Real 3D kart physics for the battle arena.
//
// The racing kart is a 2D arcade model: scalar `speed`, scalar `heading`, and
// `position.y` ASSIGNED the ground height every frame, with jumps faked as a
// `y` offset above it. Every previous attempt at air in the arena was a
// heuristic bolted onto that — detect a launch by frame-differencing the
// heightfield, invent a take-off velocity from a slope sample, then guard the
// mess with teleport guards, wall holds, minimum pops and float assists. It
// never felt right because no flight was ever simulated.
//
// This module gives the battle kart the real thing:
//
//   GROUNDED — the arcade model is untouched (that's the feel we like), but
//     each frame we ask a PHYSICAL question: if the kart flew freely for this
//     step, would it end up above the ground ahead? If yes, the surface has
//     fallen away from under it and it takes off. No thresholds, no tuned
//     grades, no minimum pop — a crest launches you exactly when geometry says
//     it should, at any frame rate.
//
//   AIRBORNE — a true projectile. A 3D velocity vector, constant gravity, no
//     ground following, no terrain snapping, limited air steering, and the
//     nose follows the arc.
//
//   LANDING — velocity is decomposed against the SURFACE NORMAL: the normal
//     component becomes impact (suspension squash, speed scrub, camera thump),
//     the tangential component is preserved and projected back onto the nose.
//     That's what makes a landing read as a landing instead of a full stop —
//     and it's why a bad angle costs you speed while a clean one doesn't.
//
// `kart.y` (height above the ground under it) and `kart.position.y` (that
// ground height) are kept exactly as the rest of the game expects, so the
// camera, shadows, muzzle, minimap and arena collision all work unchanged.
import * as THREE from "three";

export const ARENA_G = 26; // gravity while airborne (u/s²)
const AIR_STEER = 0.9; // rad/s of heading authority in the air
const AIR_VEL_FOLLOW = 0.35; // per second: how much travel eases toward the nose
const SLOPE_EPS = 0.9; // surface sampling distance (u)
const LAND_SCRUB_AT = 46; // normal impact (u/s) that costs the full scrub
const MAX_SCRUB = 0.45;
// Steepest surface a kart could actually be driving up (~33°). Anything above
// this is a wall face, not a ramp — every authored ramp is well under it.
const MAX_DRIVABLE_SLOPE = 0.65;

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

// Surface grade along a heading, measured FORWARD over `d`. Sampling distance
// is a parameter on purpose: the take-off test and the launch velocity must
// read the surface at the same scale, or they disagree and the kart pops off
// flat ground (a symmetric ±0.9u sampler vs a 0.5u prediction step is exactly
// how a rolling floor became a trampoline).
export function arenaSlopeAlong(arena, x, z, y, fx, fz, d = SLOPE_EPS) {
  const h1 = arena.heightNear(x + fx * d, z + fz * d, y);
  const h0 = arena.heightNear(x, z, y);
  return (h1 - h0) / d;
}

// Surface normal from the heightfield gradient (central differences).
export function arenaNormal(arena, x, z, y, out = _n) {
  const hx = arena.heightNear(x + SLOPE_EPS, z, y) - arena.heightNear(x - SLOPE_EPS, z, y);
  const hz = arena.heightNear(x, z + SLOPE_EPS, y) - arena.heightNear(x, z - SLOPE_EPS, y);
  return out.set(-hx / (2 * SLOPE_EPS), 1, -hz / (2 * SLOPE_EPS)).normalize();
}

// Leave the ground carrying the kart's true surface velocity. `addVy` is the
// only place an impulse is ever added (the jump button) — ramps get nothing
// but their own geometry.
export function arenaLaunch(kart, addVy = 0, slopeIn = null) {
  const a = kart.arena;
  const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
  const slope = slopeIn != null
    ? slopeIn
    : arenaSlopeAlong(a, kart.position.x, kart.position.z, kart.position.y, fx, fz, 0.6);
  const inv = 1 / Math.sqrt(1 + slope * slope);
  const horiz = kart.speed * inv; // horizontal part of the along-surface speed
  kart.vel.set(fx * horiz, kart.speed * slope * inv + addVy, fz * horiz);
  kart._wy = kart.position.y + kart.y; // world height, tracked while flying
  kart._pgy = undefined; // the ledge test re-arms on landing
  kart.grounded = false;
  kart.airborne = true;
  kart.drifting = false;
  kart.driftCharge = 0;
}

// The crest test, asked every grounded frame: would free flight this step put
// us above the ground ahead? Then the ground fell away — we're flying.
export function arenaTakeoffCheck(kart, dt) {
  const a = kart.arena;
  if (kart.spinTimer > 0) return false; // a spin-out stays glued (it's a slide, not a jump)
  const spd = kart.speed;
  if (Math.abs(spd) < 3) return false;
  const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
  const x = kart.position.x, z = kart.position.z, y = kart.position.y;

  // Evaluate at a REFERENCE step, not the frame's own dt: "is the surface
  // curving away faster than gravity can hold me?" is a property of the
  // geometry. Asked over a real 100ms frame it degrades into "would I clear
  // the ground 3 metres ahead?" — true on almost any bump, which is how a slow
  // device turns into a trampoline while a fast one plays fine.
  const h = Math.min(dt, 1 / 60);
  const d = Math.max(0.25, Math.abs(spd) * h); // one step of travel

  // LEDGE: the ground under us vanished this step — a ramp's head, a deck
  // edge, the top of a block. At speed the kart crosses such a lip entirely
  // within one frame, so the curvature test below never sees it and the kart
  // just snaps down the drop. Launch ballistically from where the surface WAS,
  // carrying no vertical speed: you drove off, you didn't jump.
  const prev = kart._pgy;
  const px = kart._plx, pz = kart._plz;
  kart._pgy = y;
  kart._plx = x;
  kart._plz = z;
  // Only trust the comparison if we actually DROVE here (a teleport moves the
  // kart far in one step and its old ground height means nothing).
  const stepped = px === undefined ? 1e9 : Math.hypot(x - px, z - pz);
  if (prev !== undefined && stepped < Math.max(4, Math.abs(spd) * dt * 2.5)) {
    const dropped = prev - y;
    if (dropped > Math.max(0.35, Math.abs(spd) * dt * 0.5) && dropped < 12) {
      kart.y = dropped; // keep world height continuous at the lip
      arenaLaunch(kart, 0, 0);
      return true;
    }
  }

  const h0 = a.heightNear(x, z, y);
  const h1 = a.heightNear(x + fx * d, z + fz * d, y);
  const h2 = a.heightNear(x + fx * 2 * d, z + fz * 2 * d, y);

  // Second difference = how much the surface bends AWAY under us in one step.
  // Take off exactly when that beats the drop gravity could pull in the same
  // step. Both terms are measured over the same distance, so a flat-but-rolling
  // floor can never fake a launch.
  const bend = (h1 - h0) - (h2 - h1);
  const slope = (h1 - h0) / d;
  // A sample pair can straddle a VERTICAL face (the side of a block, a ramp's
  // edge) and report a slope of 10:1 — geometry the kart could never have been
  // driving up, which turned into 35 u/s rocket launches. If the surface under
  // us rises faster than a kart can climb, we're at a wall, not a ramp: leave
  // it to the collision system. (A steep DROP ahead is fine — that's a ledge,
  // and it launches with the slope we actually had.)
  if (slope > MAX_DRIVABLE_SLOPE) return false;
  if (bend > 0.5 * ARENA_G * h * h + 0.01) {
    arenaLaunch(kart, 0, slope); // same-scale slope → honest take-off speed
    return true;
  }
  return false;
}

// One airborne step: ballistics, air control, landing.
export function arenaAirStep(kart, dt) {
  const a = kart.arena;

  // Limited air steering — you can adjust the landing, not pivot in place.
  kart.heading += Math.max(-1, Math.min(1, kart.steerInput)) * AIR_STEER * dt;
  const hs = Math.hypot(kart.vel.x, kart.vel.z);
  if (hs > 0.01) {
    const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
    const k = 1 - Math.pow(1 - AIR_VEL_FOLLOW, dt);
    kart.vel.x += (fx * hs - kart.vel.x) * k;
    kart.vel.z += (fz * hs - kart.vel.z) * k;
  }

  kart.vel.y -= ARENA_G * dt;
  kart.position.x += kart.vel.x * dt;
  kart.position.z += kart.vel.z * dt;
  kart._wy += kart.vel.y * dt;

  // Keep the arcade scalar in step so HUD/audio/effects read sensibly.
  const fx2 = Math.sin(kart.heading), fz2 = Math.cos(kart.heading);
  kart.speed = hs * Math.sign(kart.vel.x * fx2 + kart.vel.z * fz2 || 1);

  // The nose follows the flight arc.
  const pitchTarget = -Math.atan2(kart.vel.y, Math.max(6, hs)) * 0.8;
  kart.slopePitch += (pitchTarget - kart.slopePitch) * Math.min(1, dt * 6);

  const gh = a.heightNear(kart.position.x, kart.position.z, kart._wy);
  if (kart._wy <= gh) {
    arenaLand(kart, gh);
    return;
  }
  kart.groundY = gh;
  kart.position.y = gh;
  kart.y = kart._wy - gh;
  kart._wheelSpin = (kart._wheelSpin || 0) + kart.speed * dt * 1.6;
}

// Touchdown: split velocity against the surface normal — keep what runs along
// the ground, spend what runs into it.
function arenaLand(kart, gh) {
  const a = kart.arena;
  kart._wy = gh;
  kart.groundY = gh;
  kart.position.y = gh;
  kart.y = 0;
  kart.grounded = true;
  kart.airborne = false;
  kart.vy = 0;
  kart._pgy = gh;

  arenaNormal(a, kart.position.x, kart.position.z, gh, _n);
  const vn = kart.vel.dot(_n); // negative = into the surface
  _t.copy(kart.vel).addScaledVector(_n, -vn); // the part that survives

  // Touching down with the nose off the direction of travel is a SKID, not a
  // wall: the tyres bite and drag the kart straight. Rotate part of the way
  // toward the travel direction before projecting, or every mid-air steering
  // input turns into a landing that dumps most of the speed.
  const th = Math.hypot(_t.x, _t.z);
  if (th > 2) {
    let d = Math.atan2(_t.x, _t.z) - kart.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    kart.heading += Math.max(-0.7, Math.min(0.7, d)) * 0.55;
  }
  const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
  let s = _t.x * fx + _t.z * fz; // project the survivor onto the nose
  const impact = Math.max(0, -vn);
  s *= 1 - Math.min(MAX_SCRUB, impact / LAND_SCRUB_AT);
  kart.speed = s;
  kart.vel.set(0, 0, 0);
  kart._squash = Math.min(1, impact / 14);
  kart._landImpact = impact; // main.js turns this into dust + a thump, then clears it
  kart.slopePitch = 0; // the grounded step re-derives it from the surface next frame
}
