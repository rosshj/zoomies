import * as THREE from "three";
import { createKartModel, createCat } from "./models.js";

const UP = new THREE.Vector3(0, 1, 0);

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

    // Drift (hop into a corner to slide + charge a mini-turbo)
    this.drifting = false;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.driftGrace = 0; // window after a hop in which a drift can start

    // Boost (drift mini-turbo and the fart boost button)
    this.boostTimer = 0;
    this.boostSpeed = 0;
    this.fartTimer = 0; // tail-lift/fart animation timer

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
    this.catTail = cat.userData.tail;
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
      this.driftGrace = 1.0; // turning during/after the hop starts a drift
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

  // End a drift, awarding a mini-turbo sized by how long it was held.
  endDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    if (this.driftCharge > 1.5) this.applyBoost(1.35, 1.1);
    else if (this.driftCharge > 0.8) this.applyBoost(1.18, 0.6);
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
    if (this.finished) {
      // Coast to a gentle stop after finishing.
      this.speed *= 0.95;
      this._integrate(dt, track, true);
      this._syncMesh();
      return;
    }

    if (this.shootCooldown > 0) this.shootCooldown -= dt;
    if (this.fartTimer > 0) this.fartTimer -= dt;
    if (this.boostTimer > 0) this.boostTimer -= dt;

    if (this.driftGrace > 0) this.driftGrace -= dt;

    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      // Angular velocity decays (friction) so the spin settles down.
      this.heading += this.spinAngVel * dt;
      this.spinAngVel *= 1 - Math.min(1, 1.1 * dt);
      // Slide out carrying real inertia, decaying with friction.
      this.position.addScaledVector(this.spinVel, dt);
      this.spinVel.multiplyScalar(1 - Math.min(1, 1.6 * dt));
      this.speed = 0;
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

    // --- Drift start: easy to initiate within a grace window after a hop ---
    if (!this.drifting && this.driftGrace > 0 && Math.abs(this.steerInput) > 0.22 && this.speed > 7) {
      this.drifting = true;
      this.driftDir = Math.sign(this.steerInput);
      this.driftCharge = 0;
      this.driftGrace = 0;
    }

    // --- Drift end conditions ---
    if (this.drifting) {
      this.driftCharge += dt;
      const sameDir = Math.sign(this.steerInput) === this.driftDir;
      if (!sameDir || Math.abs(this.steerInput) < 0.12 || this.speed < 6) {
        this.endDrift();
      }
    }

    // --- Steering --- (less effective at very low speed, reversed in reverse)
    const speedFactor = Math.min(1, Math.abs(this.speed) / 10);
    const dir = this.speed >= 0 ? 1 : -1;
    let steer = this.steerInput;
    let turnRate = 1.7; // rad/sec at full
    if (this.drifting) {
      turnRate = 2.0; // a bit tighter while drifting (gentler than before)
      // bias toward the drift direction, but don't yank — follow the player's
      // actual tilt, just with a modest floor.
      steer = this.driftDir * Math.max(Math.abs(this.steerInput), 0.4);
    }
    this.heading += steer * turnRate * speedFactor * dir * dt;

    const wasAirborne = this.airborne;
    this._integrate(dt, track, false);

    // Landing from a hop opens the drift grace window.
    if (wasAirborne && !this.airborne) this.driftGrace = 0.5;

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

    // Lift the tail when farting.
    if (this.catTail) this.catTail.rotation.x = this.fartTimer > 0 ? -1.1 : 0;

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
