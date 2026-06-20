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

    // Vertical (jump)
    this.y = 0;
    this.vy = 0;
    this.airborne = false;

    // Spinout
    this.spinTimer = 0;
    this.spinDir = 1;

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

    // Tuning
    this.maxSpeed = 58 * skill;
    this.maxReverse = 18;
    this.accel = 34;
    this.brake = 60;

    // Visual
    this.group = new THREE.Group();
    const { group: kart, wheels } = createKartModel(color);
    this.wheels = wheels;
    this.group.add(kart);
    const cat = createCat(catColor);
    cat.scale.setScalar(0.62);
    cat.position.set(0, 0.85, -0.35);
    this.group.add(cat);
  }

  placeAt(position, heading, track) {
    this.position.copy(position);
    this.heading = heading;
    this.speed = 0;
    const proj = track.project(this.position);
    this.prevT = proj.t;
    this.trackT = proj.t;
    this.lap = -1;
    this.totalProgress = -1 + proj.t;
    this._syncMesh();
  }

  jump() {
    if (!this.airborne && this.spinTimer <= 0) {
      this.vy = 11;
      this.airborne = true;
    }
  }

  spinOut() {
    if (this.spinTimer > 0) return;
    this.spinTimer = 2.2;
    this.spinDir = Math.random() < 0.5 ? -1 : 1;
  }

  // Returns a world-space muzzle point + forward direction for hairballs.
  muzzle() {
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const pos = new THREE.Vector3()
      .copy(this.position)
      .addScaledVector(fwd, 3.4)
      .setY(this.y + 1.2);
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

    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      this.heading += this.spinDir * 9 * dt; // rapid spin
      this.speed *= 0.85; // skid to a halt
      this._integrate(dt, track, false);
      this._syncMesh();
      return;
    }

    // --- Longitudinal ---
    const th = this.throttleInput;
    if (th > 0.02) {
      this.speed += this.accel * th * dt;
    } else if (th < -0.02) {
      if (this.speed > 0.5) {
        // braking
        this.speed -= this.brake * -th * dt;
        if (this.speed < 0) this.speed = 0;
      } else {
        // stopped & still holding down -> reverse
        this.speed -= this.accel * -th * dt;
      }
    } else {
      // rolling friction / engine braking
      this.speed *= 1 - Math.min(1, 1.4 * dt);
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    }

    this.speed = Math.max(-this.maxReverse, Math.min(this.maxSpeed, this.speed));

    // --- Steering --- (less effective at very low speed, reversed in reverse)
    const speedFactor = Math.min(1, Math.abs(this.speed) / 12);
    const dir = this.speed >= 0 ? 1 : -1;
    const turnRate = 2.0; // rad/sec at full
    this.heading += this.steerInput * turnRate * speedFactor * dir * dt;

    this._integrate(dt, track, false);
    this._updateLap(track);
    this._syncMesh();
  }

  _integrate(dt, track, finishing) {
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.position.addScaledVector(fwd, this.speed * dt);

    // Off-track grass friction.
    const proj = track.project(this.position);
    this._proj = proj;
    if (Math.abs(proj.lateral) > track.halfWidth + 0.5 && !this.airborne) {
      this.speed *= 1 - Math.min(0.9, 2.2 * dt);
    }

    // Vertical / jump physics.
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
    this.group.position.set(this.position.x, this.y, this.position.z);
    this.group.rotation.y = this.heading;

    // Lean into turns and tilt for spinout flair.
    const lean = -this.steerInput * Math.min(1, Math.abs(this.speed) / 40) * 0.12;
    this.group.rotation.z = lean;

    for (const w of this.wheels) w.rotation.x = this._wheelSpin || 0;
  }

  // --- AI driver ---
  driveAI(track) {
    const lookahead = 0.012 + Math.min(0.05, Math.abs(this.speed) * 0.0007);
    const target = track.getPointAt(this.trackT + lookahead);
    const desired = Math.atan2(target.x - this.position.x, target.z - this.position.z);
    const diff = angleDelta(desired, this.heading);

    this.steerInput = Math.max(-1, Math.min(1, diff * 2.2));
    // Ease off the gas in sharp corners.
    this.throttleInput = Math.max(0.45, 1 - Math.abs(diff) * 0.9);
  }
}
