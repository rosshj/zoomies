// Pure remote-pose tracking — everything about "where do I draw a remote kart
// this frame" with no THREE and no DOM, so it runs headless in the netsim
// harness and later stages (Hermite interpolation, time-dilation convergence)
// modify this one file. RemoteKart (src/remotekart.js) is a thin THREE adapter
// that applies the returned frame to a Kart puppet.
//
// The numbers here are a verbatim move from the original RemoteKart.update —
// including its quirks (see the flags note on sample()) — so the extraction is
// provably behavior-preserving.

import { sampleBuffer, pushSnapshot, lerpAngle } from "./interp.js";

// Pose flag bitmask shared by sender (main loop) and receiver.
export const FLAG = { DRIFT: 1, BOOST: 2, SHIELD: 4, AIRBORNE: 8 };

// How far in the past we render remote karts. On mobile/cellular one-way latency
// plus jitter regularly exceeds 150ms, which left the buffer dry — so the ghost
// dead-reckoned and snapped on every late packet (the "jumpy" report). 200ms keeps
// interpolation working between real snapshots far more of the time.
export const INTERP_DELAY = 200; // ms (starting point; the session adapts it to the ping)

// If a peer's snapshots stop arriving for this long, their kart is effectively
// gone (a bad stall or a silent drop) — hide it rather than leave a confusing
// frozen kart parked on the track. It reappears the instant fresh data resumes.
export const STALE_HIDE_MS = 2500;

// THREE.Vector3.clampLength with y = 0, reproduced operation-for-operation
// (divide-then-multiply even when unclamped) so the extraction is bit-identical
// to the old Vector3 math. `v` is a mutable { x, z }.
function clampLength2D(v, min, max) {
  const length = Math.sqrt(v.x * v.x + v.z * v.z);
  const inv = 1 / (length || 1);
  const clamped = Math.max(min, Math.min(max, length));
  v.x = v.x * inv * clamped;
  v.z = v.z * inv * clamped;
}

export class RemotePose {
  constructor({
    now = () => performance.now(),
    snapDist = 6,
    maxExtrapMs = 250,
    staleMs = STALE_HIDE_MS,
  } = {}) {
    this._now = now;
    this.snapDist = snapDist;
    this.maxExtrapMs = maxExtrapMs;
    this.staleMs = staleMs;
    this.buffer = []; // sorted snapshots { t, x, y, z, h, p, s, f }
    this._prevH = 0;
    this._prevS = 0;
    this._readyFlag = false;
    // Render-smoothing state: the displayed pose eases toward the sampled (interp/
    // dead-reckoned) pose, so a late-packet correction is spread over a few frames
    // instead of teleporting — kills the residual jitter. A big delta (respawn /
    // first sample) snaps instead of smearing.
    this._rinit = false;
    this._rx = 0; this._rz = 0; this._ry = 0; this._rh = 0;
    this._lastRecv = 0; // wall-clock (now()) of the last snapshot received
    // Local collision "bump": a transient offset added on top of the interpolated
    // pose so the ghost visibly springs away when you ram it, instead of sitting
    // there like a wall. It decays back to zero, letting the authoritative network
    // path (which reflects the other client's own knockback) take over.
    this._bumpOff = { x: 0, z: 0 };
    this._bumpVel = { x: 0, z: 0 };
    // Latest raw progress from the wire — placement's shared sort key.
    this.totalProgress = -1;
  }

  // A pose snapshot arrived from the network (already in shared-clock time).
  pushState(pose) {
    this._lastRecv = this._now();
    pushSnapshot(this.buffer, pose);
    // Progress isn't interpolated through the buffer — latest value wins. It only
    // feeds placement, which doesn't need sub-frame accuracy.
    if (typeof pose.pr === "number") this.totalProgress = pose.pr;
  }

  // Give the ghost a SMALL, brief bump for instant local feedback. This is just
  // an immediacy bridge — the real slide arrives over the network as the other
  // client's kart actually gets knocked, and that's what dominates after ~250ms.
  // Velocity is capped so repeated/fast contacts can never accumulate into a
  // fling off the track.
  bump(nx, nz, impulse) {
    this._bumpVel.x += nx * impulse;
    this._bumpVel.z += nz * impulse;
    clampLength2D(this._bumpVel, 0, 10);
  }

  get stale() {
    return this._now() - this._lastRecv > this.staleMs;
  }
  get ready() {
    return this._readyFlag;
  }

  // Produce the frame to display at `renderTime` (shared clock minus the interp
  // delay), or null (stale peer / nothing buffered yet). Mutates the smoothing
  // state, so call exactly once per rendered frame.
  //
  // NOTE (latent, deliberately preserved): interpolated/extrapolated samples from
  // sampleBuffer don't carry `f`, so flags decode to 0 on virtually every frame —
  // remote drift/boost/shield visuals almost never show. Fix belongs to Stage 1,
  // not this behavior-preserving extraction.
  sample(renderTime, dt) {
    if (this.stale) return null;

    const s = sampleBuffer(this.buffer, renderTime, this.maxExtrapMs);
    if (!s) return null; // nothing buffered yet

    // Collision bump: a short local nudge that fades quickly so it hands off to
    // the authoritative network slide (the other client's real knockback)
    // without double-counting or lingering past the contact.
    this._bumpOff.x += this._bumpVel.x * dt;
    this._bumpOff.z += this._bumpVel.z * dt;
    const velFade = 1 - Math.min(1, 3 * dt); // fade as network catches up
    this._bumpVel.x *= velFade;
    this._bumpVel.z *= velFade;
    const offFade = 1 - Math.min(1, 1.5 * dt); // ease back to true path
    this._bumpOff.x *= offFade;
    this._bumpOff.z *= offFade;
    clampLength2D(this._bumpOff, 0, 5); // safety only

    // Converge the displayed pose onto the interpolated path. Snap on a big jump
    // (first sample / respawn / spin-out reposition) so we don't smear across the
    // map.
    let snapped = false;
    if (!this._rinit || Math.hypot(s.x - this._rx, s.z - this._rz) > this.snapDist) {
      this._rx = s.x; this._rz = s.z; this._ry = s.y; this._rh = s.h;
      this._rinit = true;
      snapped = true;
    } else {
      // Projective velocity blending for x/z: first advance the displayed point at
      // the sample's OWN velocity (V = (sin h, cos h)·s — the same model interp/
      // dead-reckon use), then decay the residual error toward the base over ~tau.
      // The advance means there is NO steady-state follow-lag (the old ease chased
      // a moving target and always trailed it by ~V·(1−a)/a); err→0 means the
      // ghost rides the true interpolated path exactly, and a correction is
      // absorbed smoothly instead of snapping.
      const decay = Math.exp(-dt / 0.12); // tau = 0.12s (~95% converge in ~0.35s)
      const velX = Math.sin(s.h) * s.s;
      const velZ = Math.cos(s.h) * s.s;
      this._rx = (this._rx + velX * dt) * decay + s.x * (1 - decay);
      this._rz = (this._rz + velZ * dt) * decay + s.z * (1 - decay);
      // y (elevation) and heading have no velocity channel here — keep the simple
      // exponential ease; their follow-lag is minor and not what this fixes.
      const a = 1 - Math.exp(-dt / 0.06);
      this._ry += (s.y - this._ry) * a;
      this._rh = lerpAngle(this._rh, s.h, a);
    }

    // Derive lean + cat-rig cornering from how fast the heading is turning, so
    // the puppet leans into bends and the cat reacts without extra bandwidth.
    const yawRate = dt > 0 ? lerpAngle(this._prevH, this._rh, 1) - this._prevH : 0;
    const turn = Math.max(-1, Math.min(1, (yawRate / Math.max(dt, 0.001)) * 0.5));

    const frame = {
      // Smoothed display pose (bump offset NOT baked in — the adapter adds it,
      // exactly like the old `_rx + bumpOff.x`).
      x: this._rx, y: this._ry, z: this._rz, h: this._rh,
      p: s.p, s: s.s, f: s.f | 0, t: s.t,
      bumpX: this._bumpOff.x, bumpZ: this._bumpOff.z,
      // Raw sampled pose, pre-smoothing — metrics use this to measure how much
      // error the exponential smoother is absorbing.
      rawX: s.x, rawZ: s.z,
      steer: turn,
      driftDir: turn >= 0 ? 1 : -1,
      lat: Math.max(-1.2, Math.min(1.2, turn * 1.2)),
      lon: Math.max(-1, Math.min(1, (s.s - this._prevS) / Math.max(dt, 0.001) / 45)),
      spinDelta: s.s * dt * 1.6,
      extrapolated: !!s.extrapolated,
      snapped,
    };

    this._prevH = this._rh;
    this._prevS = s.s;
    this._readyFlag = true;
    return frame;
  }
}
