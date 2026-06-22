import * as THREE from "three";
import { createKartModel, createCat, updateCatRig } from "./models.js";

const UP = new THREE.Vector3(0, 1, 0);

// Boost meter recharge rate (full in ~16s) — identical for the player and AI.
export const BOOST_RECHARGE = 1 / 16;

// Soft radial blob used as a contact/grounding shadow under each kart.
let _shadowTex = null;
function shadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,0.5)");
  g.addColorStop(0.6, "rgba(0,0,0,0.25)");
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
  constructor({ color, catColor, name, isPlayer, skill = 1 }) {
    this.name = name;
    this.isPlayer = isPlayer;
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

    // Boost (drift mini-turbo and the fart boost button)
    this.boostTimer = 0;
    this.boostSpeed = 0;
    this.fartTimer = 0; // tail-lift/fart animation timer
    this.boostMeter = 0; // fart-boost charge, 0..1 (starts empty, recharges)

    // Lap tracking
    this.lap = -1; // becomes 0 when crossing start line the first time
    this.prevT = 0;
    this.trackT = 0;
    this.totalProgress = -1;
    this.finished = false;
    this.finishTime = 0;
    this.place = 1;

    // Shooting cooldown
    this.shootCooldown = 0;

    // Tuning (calmer, less frantic than an all-out racer)
    this.maxSpeed = 34 * skill;
    this.baseMaxSpeed = this.maxSpeed; // for AI catch-up scaling
    this.maxReverse = 11;
    this.accel = 20;
    this.brake = 42;
    this.radius = 1.8; // half-width for road containment

    // Visual
    this.group = new THREE.Group();
    const { group: kart, wheels } = createKartModel(color);
    this.wheels = wheels;
    this.group.add(kart);
    const cat = createCat(catColor);
    cat.scale.setScalar(0.62);
    cat.position.set(0, 0.85, -0.35);
    this.group.add(cat);
    this.catRig = cat.userData.rig;

    // Shield bubble (held protection from hairballs)
    this.shielding = false;
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(3.3, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x4fc3f7,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    this.shieldMesh.position.y = 1.2;
    this.shieldMesh.visible = false;
    this.group.add(this.shieldMesh);

    // Soft contact shadow that stays on the ground (even mid-hop).
    this.groundShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 3.1),
      new THREE.MeshBasicMaterial({
        map: shadowTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.groundShadow.rotation.x = -Math.PI / 2;
    this.groundShadow.position.y = 0.05;
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
  // fraction of maxSpeed; `fart` triggers the tail-lift/fart effect.
  applyBoost(mult, duration, fart = false) {
    this.boostSpeed = this.maxSpeed * mult;
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.speed = Math.max(this.speed, this.maxSpeed); // instant kick
    if (fart) this.fartTimer = Math.max(this.fartTimer, duration);
  }

  // The fart boost button (limited uses are tracked by the caller).
  fartBoost() {
    if (this.spinTimer > 0 || this.finished) return false;
    this.applyBoost(1.6, 1.5, true);
    return true;
  }

  // End a drift, awarding a boost that scales with how long it was held (the
  // longer you hold jump through the corner, the bigger the boost).
  endDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    const c = Math.min(this.driftCharge, 3.2);
    this.applyBoost(1.12 + c * 0.12, 0.4 + c * 0.28);
    this.driftCharge = 0;
  }

  get boosting() {
    return this.boostTimer > 0;
  }

  // Spin out — keep the kart's momentum so it slides out realistically and
  // the spin decays, rather than whipping around in place. `impactDir` (xz)
  // adds a modest shove from the hit.
  spinOut(impactDir = null) {
    if (this.spinTimer > 0) return;
    this.spinTimer = 1.4;
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

  update(dt, track) {
    this._dt = dt;
    if (this.finished) {
      // Coast to a gentle stop after finishing.
      this.speed *= 0.95;
      this._lat = 0;
      this._lon = 0;
      this._integrate(dt, track, true);
      this._syncMesh();
      return;
    }

    if (this.shootCooldown > 0) this.shootCooldown -= dt;
    if (this.fartTimer > 0) this.fartTimer -= dt;
    if (this.boostTimer > 0) this.boostTimer -= dt;
    this.boostMeter = Math.min(1, this.boostMeter + BOOST_RECHARGE * dt);

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
    let turnRate = 1.6; // rad/sec at full
    if (this.drifting) {
      turnRate = 1.8;
      // The drift has a gentle inherent pull; steering has strong authority over
      // it. Tilt into the drift to tighten, tilt against it to pull back (and a
      // little past straight) — counter-steering really bites now.
      const rel = this.steerInput * this.driftDir; // +1 into, -1 counter
      const amount = Math.max(-0.4, 0.2 + rel * 0.7);
      steer = this.driftDir * amount;
    }
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
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.position.addScaledVector(fwd, this.speed * dt);

    // Bumper-car knockback (decaying positional impulse).
    if (this.knock.lengthSq() > 0.0001) {
      this.position.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(1 - Math.min(1, 4 * dt));
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
      if (Math.abs(this.speed) > 6) {
        this.wallHit = true;
        this.wallHitDir.copy(proj.side).multiplyScalar(Math.sign(proj.lateral));
      }
    }

    // Follow the road surface height; estimate slope for a pitch tilt.
    this.groundY = proj.groundY;
    const ahead = track.project(
      new THREE.Vector3().copy(this.position).addScaledVector(fwd, 6)
    );
    const targetPitch = -(ahead.groundY - this.groundY) / 6;
    this.slopePitch += (targetPitch - this.slopePitch) * Math.min(1, 8 * dt);
    this.position.y = this.groundY;

    // Vertical / jump physics (relative to the road surface).
    if (this.airborne || this.y > 0 || this.vy !== 0) {
      this.vy -= 30 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.airborne = false;
      }
    }

    // Wheel spin visual.
    this._wheelSpin = (this._wheelSpin || 0) + this.speed * dt * 1.6;
  }

  _updateLap(track) {
    const t = (this._proj || track.project(this.position)).t;
    const d = t - this.prevT;
    if (d < -0.5) {
      this.lap++;
      if (this.lap >= track.totalLaps) {
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
    this.group.rotation.x = this.slopePitch + (this.fartTimer > 0 ? -0.12 : 0);

    // Lean into turns (harder while drifting).
    const leanInput = this.drifting ? this.driftDir : this.steerInput;
    const leanAmt = this.drifting ? 0.26 : 0.12;
    this.group.rotation.z = -leanInput * Math.min(1, Math.abs(this.speed) / 40) * leanAmt;

    // Drive the cat's ears/whiskers/tail with cornering physics (tail also
    // lifts while farting).
    updateCatRig(this.catRig, this._dt, this._lat, this._lon, this.fartTimer > 0);

    // Contact shadow stays on the ground and shrinks as the kart hops.
    const air = 1 / (1 + this.y * 0.16);
    this.groundShadow.position.y = -this.y + 0.05;
    this.groundShadow.scale.setScalar(air);
    this.groundShadow.material.opacity = 0.5 * air;

    // Shield bubble.
    this.shieldMesh.visible = this.shielding;
    if (this.shielding) {
      const s = 1 + Math.sin(performance.now() * 0.01) * 0.04;
      this.shieldMesh.scale.setScalar(s);
    }

    for (const w of this.wheels) w.rotation.x = this._wheelSpin || 0;
  }

  // --- AI driver ---
  driveAI(track) {
    const speed = Math.abs(this.speed);
    // Look further ahead the faster we go, and aim for the inside of the
    // upcoming corner (a simple racing line) rather than the exact centerline.
    const lookahead = 0.01 + Math.min(0.05, speed * 0.0009);
    const aheadTan = track.getTangentAt(this.trackT + lookahead);
    const farTan = track.getTangentAt(this.trackT + lookahead + 0.05);
    const curve = angleDelta(Math.atan2(farTan.x, farTan.z), Math.atan2(aheadTan.x, aheadTan.z));

    const target = track.getPointAt(this.trackT + lookahead);
    const side = new THREE.Vector3().crossVectors(aheadTan, UP).normalize();
    // Bias toward the inside of the bend (apex), scaled by sharpness.
    const apex = Math.max(-1, Math.min(1, curve * 6)) * (track.halfWidth - 3);
    target.addScaledVector(side, apex);

    const desired = Math.atan2(target.x - this.position.x, target.z - this.position.z);
    const diff = angleDelta(desired, this.heading);
    this.steerInput = Math.max(-1, Math.min(1, diff * 2.6));

    // Brake into sharp corners, full gas on straights.
    this.throttleInput = Math.max(0.5, 1 - Math.abs(curve) * 5 - Math.abs(diff) * 0.5);
  }
}
