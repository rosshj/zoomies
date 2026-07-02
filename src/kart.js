import * as THREE from "three";
import { color as tslColor, time, normalView, positionViewDirection } from "three/tsl";
import { createKartModel, createCat, updateCatRig } from "./models.js";

const UP = new THREE.Vector3(0, 1, 0);
// Scratch vectors for the per-frame integrator — shared by every kart (each is
// fully written before it's read, and karts update sequentially).
const _iFwd = new THREE.Vector3();
const _iProbe = new THREE.Vector3();

// Projected-shadow sun parameters, set per race from the active mood's sunDir.
// The contact shadow is a flat quad stretched + aimed along the sun so it reads
// as a real directional cast shadow — long at sunset, short at midday — for ~1
// draw call and zero shadow-map cost. (Real sun shadows on the karts were the
// frame-rate killer when the field bunched up; this gives the look back cheaply.)
let _sunAz = 0;        // world azimuth the shadow's long axis lies along
let _sunStretch = 1;   // length multiplier (≈1 round at midday, longer at sunset)
let _sunAlpha = 0.42;  // base opacity (a touch darker when the sun is low)
export function setSunShadow(sunDir) {
  const x = sunDir[0], y = Math.max(0.06, sunDir[1]), z = sunDir[2];
  _sunAz = Math.atan2(x, z);
  _sunStretch = Math.min(3.0, Math.max(1, 0.6 / y));
  _sunAlpha = 0.7 + (1 - Math.min(1, y)) * 0.12;
}

// Shield bubble (WebGPU TSL): a glowing Fresnel energy orb — bright at the rim,
// faint fill, with a travelling shimmer + gentle breathing pulse off `time`.
function makeShieldMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const ndv = normalView.dot(positionViewDirection).clamp(0, 1);
  // A softer/wider fresnel (lower power) spreads the glow further in from the rim,
  // so the whole bubble luminesces rather than only a hairline edge — but the
  // centre still stays clear enough to see the kart and track through it.
  const fres = ndv.oneMinus().clamp(0.001, 1).pow(2.3);
  const band = time.mul(4).sin().mul(0.5).add(0.5); // travelling shimmer
  const pulse = time.mul(2.5).sin().mul(0.16).add(0.9); // gentle breathing
  // A second, faster ripple crossing the first so the surface reads as live energy.
  const ripple = time.mul(6.5).sin().mul(0.5).add(0.5).mul(time.mul(3.1).cos().mul(0.5).add(0.5));
  // Brighter glowing rim + a genuine translucent body fill (the 0.09 term) so it
  // looks like a glass energy bubble, not just a thin outline.
  const glow = fres.mul(1.75).add(0.09).mul(pulse).add(band.mul(fres).mul(0.6)).add(ripple.mul(fres).mul(0.35));
  mat.colorNode = tslColor(0x8fe6ff).mul(glow);
  // More translucent presence than before: a soft see-through fill (0.05) plus the
  // glowing rim, capped so the kart stays visible through the bubble.
  mat.opacityNode = fres.mul(0.7).add(0.05).add(band.mul(fres).mul(0.28)).clamp(0, 0.85);
  // Dummy uniforms bag: the update loop writes material.uniforms.uTime.value.
  mat.uniforms = { uTime: { value: 0 } };
  return mat;
}

// Boost meter recharge rate (full in ~16s) — identical for the player and AI.
export const BOOST_RECHARGE = 1 / 16;

// A drift must be held at least this long (seconds) to earn a mini-turbo. Below
// it the drift just ends with no boost — so brief flicks, and the short re-grabs
// the AI makes when its curvature reading wiggles at a corner exit or S-bend
// inflection, don't each pop a boost on the straight.
const MIN_DRIFT_CHARGE = 0.5;

// Soft radial blob used as a contact/grounding shadow under each kart.
let _shadowTex = null;
function shadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  // Darker + a broader solid core so the shadow reads from the chase cam (the
  // old soft 0.5 core faded out within the kart's own footprint and vanished).
  g.addColorStop(0, "rgba(0,0,0,0.82)");
  g.addColorStop(0.55, "rgba(0,0,0,0.6)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

// Smallest signed difference between two angles (radians).
function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Kart {
  constructor({ color, catColor, catPattern, catAccessory, catAccessoryColor, kartStyle, kartNumber, name, isPlayer, skill = 1 }) {
    this.name = name;
    this.isPlayer = isPlayer;
    this.color = color; // body colour, also used for the minimap dot
    this.skill = skill; // AI speed multiplier (1 = full)

    // State
    this.position = new THREE.Vector3();
    this.heading = 0; // radians, forward = (sin h, 0, cos h)
    this.speed = 0; // units/sec, signed

    this.steerInput = 0;
    this.throttleInput = 0;

    // Vertical (jump) + terrain following
    this.y = 0; // jump height above the road
    this.vy = 0;
    this.airborne = false;
    this.groundY = 0; // road surface height under the kart
    this.slopePitch = 0;

    // Spinout
    this.spinTimer = 0;
    this.spinDir = 1;
    this.spinAngVel = 0; // angular velocity (decays) while spinning out
    this.spinVel = new THREE.Vector3(); // carries inertia while spinning out

    // Bumper-car knockback (decaying positional impulse)
    this.knock = new THREE.Vector3();
    this.mass = isPlayer ? 1.35 : 1.0;

    // Wall scrape (for spark effects)
    this.wallHit = false;
    this.wallHitDir = new THREE.Vector3();

    // Drift (hold jump while turning to slide + charge a mini-turbo)
    this.drifting = false;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.driftHeld = false; // jump button held (sustains the drift)

    // Boost (drift mini-turbo and the toot boost button)
    this.boostTimer = 0;
    this.boostSpeed = 0;
    this.tootTimer = 0; // tail-lift/toot animation timer
    this.boostMeter = 0; // toot-boost charge, 0..1 (starts empty, recharges)
    this.boostPuff = -1; // pending drift-release cloud charge (>=0 = emit one)
    this.catnipTimer = 0; // catnip power-up: hands-free continuous boost (green) for 7s
    this.shieldTimer = 0; // item-box shield: hands-free protection (no button held)
    this.triShots = 0; // item-box tri-furball: this many upcoming shots fire a wide 3-way fan
    this.boxCooldown = 0; // brief lockout after grabbing a power-up box (no vacuuming)

    // Lap tracking
    this.lap = -1; // becomes 0 when crossing start line the first time
    this.prevT = 0;
    this.trackT = 0;
    this.totalProgress = -1;
    this.finished = false;
    this.finishTime = 0; // elapsed race time at finish (for display)
    this.finishClock = 0; // shared-clock instant at finish (for MP ranking)
    this.place = 1;
    this._stuck = 0; // AI: time spent crawling (wall recovery)

    // Shooting cooldown
    this.shootCooldown = 0;
    this.shootCharge = 0; // player: hold-to-charge level 0..1
    // AI: a fixed preferred lane offset (-1..1) so the field spreads across the
    // road instead of all chasing the exact same line into a corner.
    this.laneBias = isPlayer ? 0 : (Math.random() * 2 - 1) * 0.55;
    // AI shield reactions are deliberately imperfect: a per-driver chance they
    // even react to a given shot, plus a reaction delay (so fast shots slip by).
    this.shieldSkill = isPlayer ? 0 : 0.4 + Math.random() * 0.28;
    this._threatPrev = false;
    this._shieldTry = false;
    this._shieldDelay = 0;

    // Tuning (calmer, less frantic than an all-out racer)
    this.maxSpeed = 34 * skill;
    this.baseMaxSpeed = this.maxSpeed; // for AI catch-up scaling
    this.maxReverse = 11;
    this.accel = 20;
    this.brake = 42;
    this.radius = 1.8; // half-width for road containment

    // Visual
    this.group = new THREE.Group();
    // Vehicle rotation order: yaw (heading) first, then pitch and roll in the
    // kart's LOCAL frame. With the default XYZ order the pitch is applied around
    // the world axis, so the kart only tilts to the grade when facing ±Z — on a
    // looping track it mostly wouldn't pitch at all.
    this.group.rotation.order = "YXZ";
    const { group: kart, wheels, brakeMat, flames } = createKartModel(color, { style: kartStyle, number: kartNumber });
    this.wheels = wheels;
    this.brakeMat = brakeMat; // tail lights; brightened when braking (see update)
    this.flames = flames; // boost exhaust flames; shown/flickered while boosting
    this.group.add(kart);
    const cat = createCat(catColor, { pattern: catPattern, accessory: catAccessory, accessoryColor: catAccessoryColor });
    cat.scale.setScalar(0.62);
    cat.position.set(0, 0.85, -0.35);
    this.group.add(cat);
    this.catRig = cat.userData.rig;

    // Shield bubble (held protection from hairballs) — a glowing Fresnel energy
    // orb: bright at the rim, faint fill, with travelling shimmer bands.
    this.shielding = false;
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(3.3, 24, 16),
      makeShieldMaterial()
    );
    this.shieldMesh.position.y = 1.2;
    this.shieldMesh.visible = false;
    this.group.add(this.shieldMesh);
    // Bouncy pop-in/out: an under-damped spring on the orb's "presence" (0 hidden,
    // ~1 shown, overshooting past 1 on the way up for a springy pop). Seeded
    // slightly OPEN (a barely-visible dot for the first few frames, e.g. during
    // the countdown): the orb's TSL material only compiles its render pipeline
    // the first time the mesh is actually rendered, so without the warm-up the
    // first shield press mid-race stalled the frame on a shader compile.
    this._shieldS = { a: 0.02, v: 0 };

    // Soft contact shadow that stays on the ground (even mid-hop). The quad sits
    // in a holder so it can be spun to the sun azimuth independent of the kart's
    // heading; _syncMesh stretches it with the sun's lowness for a directional
    // cast-shadow look without any real shadow-map cost.
    this.shadowQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 3.1),
      new THREE.MeshBasicMaterial({
        map: shadowTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.shadowQuad.rotation.x = -Math.PI / 2;
    // Push the shadow toward the anti-sun side (holder +Z faces the sun) so it
    // trails out from under the chassis instead of hiding directly beneath it.
    // The holder's Z scale (sun lowness) stretches this offset too.
    this.shadowQuad.position.z = -1.4;
    this.groundShadow = new THREE.Group();
    this.groundShadow.add(this.shadowQuad);
    this.group.add(this.groundShadow);

    // Cat physics signals (cornering / acceleration), smoothed in update().
    this._prevSpeed = 0;
    this._lat = 0;
    this._lon = 0;
    this._dt = 0.016;
  }

  placeAt(position, heading, track) {
    this.position.copy(position);
    this.heading = heading;
    this.speed = 0;
    this.knock.set(0, 0, 0);
    const proj = track.project(this.position);
    this.prevT = proj.t;
    this.trackT = proj.t;
    this.groundY = proj.groundY;
    this.position.y = this.groundY;
    this.lap = -1;
    this.totalProgress = -1 + proj.t;
    this._syncMesh();
  }

  jump() {
    if (!this.airborne && this.spinTimer <= 0) {
      this.vy = 9;
      this.airborne = true;
    }
  }

  // Apply a temporary speed boost. `mult` is the boosted top speed as a
  // fraction of maxSpeed; `toot` triggers the tail-lift/toot effect.
  applyBoost(mult, duration, toot = false) {
    this.boostSpeed = this.maxSpeed * mult;
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.speed = Math.max(this.speed, this.maxSpeed); // instant kick
    if (toot) this.tootTimer = Math.max(this.tootTimer, duration);
  }

  // The toot boost button (limited uses are tracked by the caller).
  tootBoost() {
    if (this.spinTimer > 0 || this.finished) return false;
    this.applyBoost(1.6, 1.5, true);
    return true;
  }

  // End a drift, awarding a boost that scales with how long it was held (the
  // longer you hold jump through the corner, the bigger the boost). A drift that
  // didn't charge long enough earns nothing — no trivial flick boosts.
  endDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    const charge = this.driftCharge;
    this.driftCharge = 0;
    if (charge < MIN_DRIFT_CHARGE) return; // too short to earn a mini-turbo
    const c = Math.min(charge, 3.2);
    this.applyBoost(1.12 + c * 0.12, 0.4 + c * 0.28);
    this.boostPuff = c; // signal a charge-coloured boost cloud (see main loop)
  }

  get boosting() {
    return this.boostTimer > 0;
  }

  // Catnip power-up: a hands-free continuous boost (no drift/button needed) for 7s.
  // Sustained each frame in update(); reads as a green boost (cloud + flames).
  giveCatnip() {
    if (this.finished) return;
    this.catnipTimer = 7;
  }
  get catnipBoosting() {
    return this.catnipTimer > 0;
  }
  // Item-box shield: hands-free hairball protection for `secs` (no button held).
  // The bubble shows and blocks hits for the duration (see update()).
  giveShield(secs = 15) {
    if (this.finished) return;
    this.shieldTimer = Math.max(this.shieldTimer, secs);
  }
  // Item-box tri-furball: the next `n` shots each fire a wide 3-way fan.
  giveTriShots(n = 3) {
    if (this.finished) return;
    this.triShots = Math.max(this.triShots, n);
  }

  // Spin out — keep the kart's momentum so it slides out realistically and
  // the spin decays, rather than whipping around in place. `impactDir` (xz)
  // adds a modest shove from the hit.
  spinOut(impactDir = null) {
    if (this.spinTimer > 0) return;
    this.spinTimer = 1.4;
    // Can't fire back for a couple of seconds after taking a hairball.
    this.shootCooldown = Math.max(this.shootCooldown, 2.0);
    this.driftHeld = false;
    this.spinDir = Math.random() < 0.5 ? -1 : 1;
    this.spinAngVel = this.spinDir * (4.5 + Math.random() * 1.5);
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.spinVel.copy(fwd).multiplyScalar(Math.abs(this.speed)); // real momentum
    if (impactDir) this.spinVel.addScaledVector(impactDir, 6);
    this.drifting = false;
    this.speed = 0;
  }

  // Returns a world-space muzzle point + forward direction for hairballs.
  // The direction follows the kart's slope pitch so shots clear the hill ahead
  // when climbing instead of burying into it.
  muzzle() {
    const cp = Math.cos(this.slopePitch);
    const sp = Math.sin(this.slopePitch);
    const fwd = new THREE.Vector3(cp * Math.sin(this.heading), -sp, cp * Math.cos(this.heading));
    const pos = new THREE.Vector3().copy(this.position).addScaledVector(fwd, 3.4);
    pos.y += this.y + 1.4;
    return { pos, dir: fwd };
  }

  // Drive just the cat's idle animation (the occasional blink) for showcase
  // views like the garage, where the kart itself isn't being simulated.
  idleBlink(dt) {
    updateCatRig(this.catRig, dt, 0, 0, false, false, true);
  }

  update(dt, track) {
    this._dt = dt;
    if (this.finished) {
      // Victory lap: keep cruising the circuit on autopilot at a relaxed pace
      // (steering is fed by the AI driver each frame) instead of stopping.
      this.throttleInput = Math.min(Math.max(this.throttleInput, 0.4), 0.62);
      this.shootCharge = 0;
    }

    if (this.shootCooldown > 0) this.shootCooldown -= dt;
    if (this.boxCooldown > 0) this.boxCooldown -= dt;
    if (this.tootTimer > 0) this.tootTimer -= dt;
    if (this.boostTimer > 0) this.boostTimer -= dt;
    this.boostMeter = Math.min(1, this.boostMeter + BOOST_RECHARGE * dt);
    // Catnip keeps the boost topped up (so `boosting` stays true) for its duration.
    if (this.catnipTimer > 0) {
      this.catnipTimer -= dt;
      this.applyBoost(1.5, 0.18, true);
    }
    // Item-box shield: force the bubble on for the duration, whatever the button
    // says. Runs after the input/AI assignment of `shielding` so it can't be
    // cleared mid-duration; the bubble + hit-blocking read from `shielding`.
    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
      this.shielding = true;
    }

    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      // Angular velocity decays (friction) so the spin settles down.
      this.heading += this.spinAngVel * dt;
      this.spinAngVel *= 1 - Math.min(1, 1.1 * dt);
      // Slide out carrying real inertia, decaying with friction.
      this.position.addScaledVector(this.spinVel, dt);
      this.spinVel.multiplyScalar(1 - Math.min(1, 1.6 * dt));
      this.speed = 0;
      this._lat = Math.max(-1, Math.min(1, this.spinAngVel * 0.12));
      this._lon = 0;
      this._integrate(dt, track, false);
      this._syncMesh();
      return;
    }

    // --- Longitudinal ---
    const boosting = this.boostTimer > 0;
    const th = this.throttleInput;
    if (boosting) {
      this.speed += this.accel * 2.2 * dt; // strong push while boosting
    } else if (th > 0.02) {
      this.speed += this.accel * th * dt;
    } else if (th < -0.02) {
      if (this.speed > 0.5) {
        this.speed -= this.brake * -th * dt; // braking
        if (this.speed < 0) this.speed = 0;
      } else {
        this.speed -= this.accel * -th * dt; // reverse
      }
    } else {
      this.speed *= 1 - Math.min(1, 1.4 * dt); // engine braking
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    }

    // Clamp: boosting allows exceeding the normal top speed; afterwards the
    // extra speed bleeds off gradually rather than snapping down.
    const upper = boosting ? this.boostSpeed : this.maxSpeed;
    if (this.speed > upper) {
      this.speed = boosting ? upper : Math.max(upper, this.speed - 26 * dt);
    }
    this.speed = Math.max(-this.maxReverse, this.speed);

    // Tail lights flare when braking or reversing (dim red glow otherwise).
    if (this.brakeMat) this.brakeMat.emissiveIntensity = this.throttleInput < -0.05 ? 2.8 : 0.25;

    // --- Drift: continues as long as jump is held; release fires the boost ---
    if (this.drifting) {
      this.driftCharge += dt;
      if (!this.driftHeld || this.speed < 6) this.endDrift();
    } else if (this.driftHeld && !this.airborne && this.speed > 7 && Math.abs(this.steerInput) > 0.25) {
      this.drifting = true;
      this.driftDir = Math.sign(this.steerInput);
      this.driftCharge = 0;
    }

    // --- Steering --- (less effective at very low speed, reversed in reverse)
    const speedFactor = Math.min(1, Math.abs(this.speed) / 10);
    const dir = this.speed >= 0 ? 1 : -1;
    let steer = this.steerInput;
    let turnRate = 1.9; // rad/sec at full
    if (this.drifting) {
      turnRate = 1.8;
      // The drift has a gentle inherent pull; steering has strong authority over
      // it. Tilt into the drift to tighten, tilt against it to pull back (and a
      // little past straight) — counter-steering really bites now.
      const rel = this.steerInput * this.driftDir; // +1 into, -1 counter
      const amount = Math.max(-0.4, 0.2 + rel * 0.7);
      steer = this.driftDir * amount;
    }
    // Catnip is fast, which makes tight corners hard — give it extra steering
    // authority so it stays controllable through bends.
    if (this.catnipBoosting && !this.drifting) turnRate *= 1.4;
    this.heading += steer * turnRate * speedFactor * dir * dt;

    this._integrate(dt, track, false);

    // Cat physics signals: cornering intensity + longitudinal acceleration.
    const corner = this.drifting ? this.driftDir * 1.2 : this.steerInput;
    this._lat = Math.max(-1.2, Math.min(1.2, corner * Math.min(1, Math.abs(this.speed) / 14)));
    const accel = (this.speed - this._prevSpeed) / Math.max(dt, 0.001);
    this._lon = Math.max(-1, Math.min(1, accel / 45));
    this._prevSpeed = this.speed;

    this._updateLap(track);
    this._syncMesh();
  }

  _integrate(dt, track, finishing) {
    const fwd = _iFwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.position.addScaledVector(fwd, this.speed * dt);

    // Bumper-car knockback (decaying positional impulse). The decay is gentle so
    // a bump glides to a stop rather than snapping — this is the slide both the
    // player and (over the network) other clients see when this kart is hit.
    if (this.knock.lengthSq() > 0.0001) {
      this.position.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(1 - Math.min(1, 2.5 * dt));
    }

    // Keep the kart contained on the road: clamp it inside the barriers and
    // scrub a little speed when it scrapes the wall.
    const proj = track.project(this.position);
    this._proj = proj;
    const limit = track.halfWidth - this.radius;
    if (Math.abs(proj.lateral) > limit) {
      const correction = Math.sign(proj.lateral) * limit - proj.lateral;
      this.position.addScaledVector(proj.side, correction);
      this.speed *= 1 - Math.min(0.4, 1.6 * dt);
      this.knock.multiplyScalar(0.5);
      // Clipping a wall kills an active drift and forfeits its charge (no boost
      // reward) — drive clean through the corner to keep the slide.
      if (this.drifting) {
        this.drifting = false;
        this.driftCharge = 0;
      }
      if (Math.abs(this.speed) > 6) {
        this.wallHit = true;
        this.wallHitDir.copy(proj.side).multiplyScalar(Math.sign(proj.lateral));
      }
    }

    // Sit the kart on its front + rear wheel contacts (not just the centreline),
    // so the wheels lay on the slope and the rear doesn't dig into the hill on
    // crests/descents. The sample baseline matches the actual wheelbase, the
    // body is lifted by the wheel-contact offset so the tyres rest on the road,
    // and the pitch follows quickly so it stays glued through slope changes.
    const half = 1.55; // matches the front/rear wheel positions
    const frontY = track.project(_iProbe.copy(this.position).addScaledVector(fwd, half)).groundY;
    const rearY = track.project(_iProbe.copy(this.position).addScaledVector(fwd, -half)).groundY;
    this.groundY = (frontY + rearY) * 0.5 + 0.08; // lift so the tyres rest on, not in, the road
    const targetPitch = Math.atan2(rearY - frontY, 2 * half);
    // Track the slope quickly so the kart stays glued through crests/dips instead
    // of the nose stabbing in or the tail floating during the transition.
    this.slopePitch += (targetPitch - this.slopePitch) * Math.min(1, 26 * dt);
    this.position.y = this.groundY;

    // Vertical / jump physics (relative to the road surface).
    if (this.airborne || this.y > 0 || this.vy !== 0) {
      this.vy -= 30 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        // Suspension squash on touchdown, scaled by how hard we hit.
        if (this.vy < -2) this._squash = Math.min(1, -this.vy / 14);
        this.vy = 0;
        this.airborne = false;
      }
    }

    // Suspension spring: the squash impulse relaxes back with a little overshoot.
    this._squash = (this._squash || 0) * Math.max(0, 1 - 9 * dt);

    // Wheel spin visual.
    this._wheelSpin = (this._wheelSpin || 0) + this.speed * dt * 1.6;
  }

  _updateLap(track) {
    const t = (this._proj || track.project(this.position)).t;
    const d = t - this.prevT;
    if (d < -0.5) {
      this.lap++;
      if (!this.finished && this.lap >= track.totalLaps) {
        this.finished = true;
        this.finishTime = track.raceTime;
      }
    } else if (d > 0.5) {
      this.lap--;
    }
    this.prevT = t;
    this.trackT = t;
    this.totalProgress = this.lap + t;
  }

  // 1-based lap number to show in the HUD.
  displayLap(totalLaps) {
    return Math.max(1, Math.min(totalLaps, this.lap + 1));
  }

  _syncMesh() {
    this.group.position.set(this.position.x, this.groundY + this.y, this.position.z);
    this.group.rotation.y = this.heading;

    // Pitch with the slope (+ a slight wheelie on boost).
    this.group.rotation.x = this.slopePitch + (this.tootTimer > 0 ? -0.12 : 0);

    // Lean into turns — smoothed so the tilt builds gradually as you commit to a
    // corner instead of snapping to a fixed angle.
    //  - Drifting: the lean deepens the harder you steer INTO the drift, and the
    //    kart stands back up (even tips slightly the other way) as you counter-
    //    steer out of it — so the body language tracks the slide.
    //  - Not drifting: sharp steering still leans the kart, with a touch of expo
    //    so a hard flick leans more than a gentle correction.
    const sf = Math.min(1, Math.abs(this.speed) / 40); // no lean when crawling
    let leanTarget;
    if (this.drifting) {
      const rel = this.steerInput * this.driftDir; // +1 fully into, -1 full counter
      const commit = Math.max(-0.3, Math.min(1.15, 0.45 + rel * 0.6));
      leanTarget = this.driftDir * commit * 0.34 * sf;
    } else {
      const s = this.steerInput;
      leanTarget = Math.sign(s) * Math.pow(Math.abs(s), 1.25) * 0.17 * sf;
    }
    this._lean = (this._lean || 0) + (leanTarget - (this._lean || 0)) * Math.min(1, (this._dt || 0.016) * 9);
    this.group.rotation.z = -this._lean;

    // Boost flames: show + flicker while boosting. Catnip turns them green.
    if (this.flames) {
      const on = this.boosting;
      this.flames.visible = on;
      if (on) {
        this.flames.scale.set(1, 1, 0.7 + Math.random() * 0.6);
        const green = this.catnipBoosting;
        if (green !== this._flamesGreen) {
          this._flamesGreen = green;
          const oc = this.flames.children[0] && this.flames.children[0].material;
          const cc = this.flames.children[1] && this.flames.children[1].material;
          if (oc) oc.color.set(green ? 0x49d62a : 0xff7a1e);
          if (cc) cc.color.set(green ? 0xd6ffb0 : 0xfff2c0);
        }
      }
    }

    // Drive the cat's ears/whiskers/tail with cornering physics (tail also
    // lifts while tooting).
    // Blink only on the post-race victory lap (the racing rig already gives a
    // moving cat plenty of life); never mid-race.
    updateCatRig(this.catRig, this._dt, this._lat, this._lon, this.tootTimer > 0, this.finished, this.finished);

    // Projected sun shadow: keep it flat on the ground (cancel the hop), aim its
    // long axis along the sun azimuth (independent of which way the kart faces),
    // and stretch it with the sun's lowness so it reads as a real directional
    // cast shadow. Shrinks + fades as the kart hops.
    const air = 1 / (1 + this.y * 0.16);
    this.groundShadow.position.y = -this.y + 0.04;
    this.groundShadow.rotation.y = _sunAz - this.heading;
    this.groundShadow.scale.set(air, 1, air * _sunStretch);
    this.shadowQuad.material.opacity = _sunAlpha * air;

    // Shield bubble: springy pop in/out (never an instant snap), plus a little
    // sway/lean as the kart corners so the orb feels like it has weight.
    const sdt = Math.min(this._dt || 0.016, 0.05);
    const sp = this._shieldS;
    const target = this.shielding ? 1 : 0;
    sp.v += (target - sp.a) * 320 * sdt; // stiff spring → quick, bouncy response
    sp.v *= Math.max(0, 1 - 11 * sdt);   // light damping → a touch of overshoot
    sp.a += sp.v * sdt;
    if (sp.a < 0) { sp.a = 0; sp.v = 0; } // clamp the pop-out floor
    const showing = this.shielding || sp.a > 0.01;
    this.shieldMesh.visible = showing;
    if (showing) {
      const now = performance.now();
      const breathe = 1 + Math.sin(now * 0.01) * 0.04; // gentle idle pulse
      this.shieldMesh.scale.setScalar(Math.max(0, sp.a) * breathe);
      // Lean opposite the turn (inertia) with a tiny vertical wobble from the spring.
      const lat = this._lat || 0;
      this.shieldMesh.position.x = -lat * 0.55;
      this.shieldMesh.position.y = 1.2 + sp.v * 0.04;
      this.shieldMesh.rotation.z = lat * 0.18;
      this.shieldMesh.material.uniforms.uTime.value = now * 0.001;
    }

    // Wheels roll; the fronts (indices 0,1) also steer with the input.
    const steerAng = (this.drifting ? this.driftDir * 0.6 : this.steerInput) * 0.45;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.rotation.order = "YXZ";
      w.rotation.y = i < 2 ? steerAng : 0; // front axle steers
      w.rotation.x = this._wheelSpin || 0; // roll
    }

    // Suspension squash: compress vertically + bulge a touch on touchdown.
    const sq = this._squash || 0;
    this.group.scale.set(1 + sq * 0.12, 1 - sq * 0.18, 1 + sq * 0.12);
  }

  // --- AI driver ---
  driveAI(track, dt = 0.016, catnipTargets = null) {
    const speed = Math.abs(this.speed);
    const L = track.length;
    const wrap = (t) => ((t % 1) + 1) % 1;

    // Sharpness of the corner just ahead. Using fixed DISTANCES (not a fixed t)
    // matters now the track is long — a fixed t-step would reach much further in
    // world units and make the AI cut across bends into the inside wall.
    const t0 = track.getTangentAt(wrap(this.trackT + 5 / L));
    const t1 = track.getTangentAt(wrap(this.trackT + (18 + speed) / L));
    const curve = angleDelta(Math.atan2(t1.x, t1.z), Math.atan2(t0.x, t0.z));
    const sharp = Math.min(1, Math.abs(curve) * 6);

    // Aim point a short distance ahead — shorter on sharp corners so we follow
    // the bend instead of cutting it. A gentle apex on mild bends, blended with
    // this driver's own lane bias so the field fans out instead of clumping.
    const aimDist = (8 + speed * 0.5) * (1 - 0.5 * sharp);
    const aT = wrap(this.trackT + aimDist / L);
    const target = track.getPointAt(aT);
    const side = new THREE.Vector3().crossVectors(track.getTangentAt(aT), UP).normalize();
    const apex = Math.sign(curve) * (1 - sharp) * (track.halfWidth - 4);
    const lane = this.laneBias * (1 - sharp) * (track.halfWidth - 3); // hold a personal line
    target.addScaledVector(side, apex + lane);

    // Crate seeking: ease the aim toward a crate to grab the (hidden) catnip.
    // Everyone snaps at one that's nearly on their line; karts running at the back
    // (4th+) look much further afield and commit harder, detouring to gamble for a
    // catch-up boost. We only chase crates genuinely ahead. Since catnip hides in
    // an ordinary crate, this just reads as the AI going for boxes.
    if (catnipTargets && catnipTargets.length && !this.catnipBoosting && this.spinTimer <= 0) {
      const fwx = Math.sin(this.heading), fwz = Math.cos(this.heading);
      const behind = Math.max(0, (this.place || 1) - 3); // 0 for top-3, up to 3 for last
      const catnipMul = this.diff ? this.diff.catnip : 1; // easier modes chase catnip less
      const range = (24 + behind * 18) * catnipMul;       // trailing karts reach much further
      let best = null, bestD = range;
      for (const cn of catnipTargets) {
        const dx = cn.x - this.position.x, dz = cn.z - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 3 || d > bestD) continue;
        if ((dx * fwx + dz * fwz) / d < 0.25) continue; // must be roughly ahead, not behind
        bestD = d; best = cn;
      }
      if (best) {
        // Commit harder the closer it is AND the further back we are (more willing
        // to leave the racing line for it when there's ground to make up).
        const pull = Math.min(0.92, (range - bestD) / range * 0.7 + 0.2 + behind * 0.08);
        target.x += (best.x - target.x) * pull;
        target.z += (best.z - target.z) * pull;
      }
    }

    const desired = Math.atan2(target.x - this.position.x, target.z - this.position.z);
    const diff = angleDelta(desired, this.heading);
    this.steerInput = Math.max(-1, Math.min(1, diff * 3.2));

    // Carry good corner speed: brake for sharp bends but keep a healthy floor so
    // they stay competitive instead of crawling round every turn.
    this.throttleInput = Math.max(
      sharp > 0.6 ? 0.34 : 0.55,
      1 - sharp * 0.82 - Math.min(0.35, Math.abs(diff) * 0.45)
    );

    // Drift through sweeping corners and HOLD it well into the exit for a long
    // charge (bigger boost). Hysteresis: start only on a real sweeper, but once
    // drifting keep holding until the road nearly straightens out.
    if (this.spinTimer > 0) {
      this.driftHeld = false;
    } else if (this.drifting) {
      this.driftHeld = speed > 8 && sharp > 0.16; // hold through the exit
    } else {
      this.driftHeld = speed > 16 && sharp > 0.4 && sharp < 0.96 && Math.abs(this.steerInput) > 0.3;
    }

    // Stuck recovery: if we've been crawling (pinned on a wall) without being
    // spun out, reverse to peel off it; normal driving then re-aims us.
    if (speed < 2.5 && this.spinTimer <= 0 && !this.finished) this._stuck += dt;
    else this._stuck = Math.max(0, this._stuck - 2 * dt);
    if (this._stuck > 0.6) {
      this.throttleInput = -1;
      this.steerInput *= -0.3; // steering inverts in reverse; nudge off the wall
      this.driftHeld = false;
      if (this._stuck > 1.8) this._stuck = 0; // try forward again
    }
  }
}
