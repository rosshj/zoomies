import * as THREE from "three";
import { Kart } from "./kart.js";
import { sampleBuffer, pushSnapshot, lerpAngle } from "./net/interp.js";

// Pose flag bitmask shared by sender (main loop) and receiver (RemoteKart).
export const FLAG = { DRIFT: 1, BOOST: 2, SHIELD: 4, AIRBORNE: 8 };

// How far in the past we render remote karts. 150ms gives the buffer enough
// headroom at ~100ms ping so interpolation always has snapshots to work between.
export const INTERP_DELAY = 150; // ms

// A remote player's kart: a render-only puppet. It reuses the entire Kart visual
// (chassis, cat rig, lean, contact shadow, shield bubble, spinning wheels) but
// NEVER runs physics or AI — its pose comes straight from interpolated network
// snapshots. That keeps it cheap and prevents it from diverging from what the
// owning client actually sees.
export class RemoteKart {
  constructor(identity) {
    this.id = identity.id;
    this.name = identity.name;
    this.kart = new Kart({
      color: identity.color,
      catColor: identity.catColor,
      name: identity.name,
      isPlayer: false,
    });
    this.group = this.kart.group;
    this.buffer = []; // sorted snapshots { t, x, y, z, h, p, s, f }
    this._prevH = 0;
    this._prevS = 0;
    this._ready = false;
    // Local collision "bump": a transient offset added on top of the interpolated
    // pose so the ghost visibly springs away when you ram it, instead of sitting
    // there like a wall. It decays back to zero, letting the authoritative network
    // path (which reflects the other client's own knockback) take over.
    this.bumpOff = new THREE.Vector3();
    this.bumpVel = new THREE.Vector3();
    // Race-placement fields, kept duck-type compatible with Kart so the shared
    // placement sort treats local and remote karts identically.
    this.totalProgress = -1;
    this.finished = false;
    this.finishTime = 0;
    this.place = 1;
  }

  // A pose snapshot arrived from the network (already in shared-clock time).
  pushState(pose) {
    pushSnapshot(this.buffer, pose);
    // Progress isn't interpolated through the buffer — latest value wins. It only
    // feeds placement, which doesn't need sub-frame accuracy.
    if (typeof pose.pr === "number") this.totalProgress = pose.pr;
  }

  // Give the ghost a momentary shove (local, visual only). nx/nz is the unit
  // push direction, `sep` an immediate positional kick, `impulse` a velocity so
  // it keeps drifting briefly like a real bump before easing back.
  bump(nx, nz, sep, impulse) {
    this.bumpOff.x += nx * sep;
    this.bumpOff.z += nz * sep;
    this.bumpVel.x += nx * impulse;
    this.bumpVel.z += nz * impulse;
    // Keep it sane so a fast pile-up can't fling the ghost across the map.
    const cap = 3;
    this.bumpOff.clampLength(0, cap);
  }

  // Render the kart at `renderTime` (shared clock minus INTERP_DELAY).
  update(renderTime, dt) {
    const s = sampleBuffer(this.buffer, renderTime, 250);
    if (!s) return; // nothing buffered yet
    const k = this.kart;

    // Integrate + decay the local collision bump (a spring back to the true path).
    this.bumpOff.addScaledVector(this.bumpVel, dt);
    this.bumpVel.multiplyScalar(1 - Math.min(1, 4 * dt));
    this.bumpOff.multiplyScalar(1 - Math.min(1, 3 * dt));

    // Drop the puppet onto the interpolated pose, plus the transient bump offset.
    k.position.x = s.x + this.bumpOff.x;
    k.position.z = s.z + this.bumpOff.z;
    k.groundY = s.y; // sender already did ground-follow; y is absolute world height
    k.y = 0; // hops are baked into the sender's y; no separate jump offset
    k.position.y = s.y;
    k.heading = s.h;
    k.slopePitch = s.p;
    k.speed = s.s;

    // Decode visual flags.
    const f = s.f | 0;
    k.drifting = (f & FLAG.DRIFT) !== 0;
    k.shielding = (f & FLAG.SHIELD) !== 0;
    k.fartTimer = f & FLAG.BOOST ? 0.1 : 0; // drives the boost wheelie + tail lift

    // Derive lean + cat-rig cornering from how fast the heading is turning, so
    // the puppet leans into bends and the cat reacts without extra bandwidth.
    const yawRate = dt > 0 ? lerpAngle(this._prevH, s.h, 1) - this._prevH : 0;
    const turn = Math.max(-1, Math.min(1, (yawRate / Math.max(dt, 0.001)) * 0.5));
    k.steerInput = turn;
    k.driftDir = turn >= 0 ? 1 : -1;
    k._lat = Math.max(-1.2, Math.min(1.2, turn * 1.2));
    k._lon = Math.max(-1, Math.min(1, (s.s - this._prevS) / Math.max(dt, 0.001) / 45));
    k._dt = dt;
    k._wheelSpin = (k._wheelSpin || 0) + s.s * dt * 1.6;

    this._prevH = s.h;
    this._prevS = s.s;
    this._ready = true;
    k._syncMesh();
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
