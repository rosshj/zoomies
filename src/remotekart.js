import { Kart } from "./kart.js";
import { disposeGroup } from "./models.js";
import { RemotePose, FLAG, INTERP_DELAY } from "./net/remotepose.js";

// The pose constants live with the pure tracking core now; re-export so the
// sender (main loop) keeps importing them from here unchanged.
export { FLAG, INTERP_DELAY };

// A remote player's kart: a render-only puppet. It reuses the entire Kart visual
// (chassis, cat rig, lean, contact shadow, shield bubble, spinning wheels) but
// NEVER runs physics or AI — its pose comes straight from interpolated network
// snapshots. That keeps it cheap and prevents it from diverging from what the
// owning client actually sees.
//
// All the tracking math (snapshot buffer, render smoothing, collision bump,
// stale detection) lives in RemotePose (src/net/remotepose.js), which is pure
// and headless-testable; this class just applies the sampled frame to the THREE
// puppet each render tick.
export class RemoteKart {
  constructor(identity) {
    this.id = identity.id;
    this.name = identity.name;
    this.kart = new Kart({
      color: identity.color,
      catColor: identity.catColor,
      catPattern: identity.catPattern,
      catAccessory: identity.catAccessory,
      catAccessoryColor: identity.catAccessoryColor,
      kartStyle: identity.kartStyle,
      kartNumber: identity.kartNumber,
      name: identity.name,
      isPlayer: false,
    });
    this.kart.isRemote = true; // ghost: power-up boxes sink but grant no local effect
    this.group = this.kart.group;
    this.pose = new RemotePose();
    // Race-placement fields, kept duck-type compatible with Kart so the shared
    // placement sort treats local and remote karts identically.
    this.finished = false;
    this.finishTime = 0;
    this.finishClock = 0; // shared-clock instant at finish (for ranking)
    this.place = 1;
  }

  // Placement reads (and race-reset writes) go straight through to the tracker.
  get totalProgress() {
    return this.pose.totalProgress;
  }
  set totalProgress(v) {
    this.pose.totalProgress = v;
  }
  // Collision code skips ghosts that haven't produced a real pose yet.
  get _ready() {
    return this.pose.ready;
  }

  // A pose snapshot arrived from the network (already in shared-clock time).
  pushState(pose) {
    this.pose.pushState(pose);
  }

  // Instant local feedback when the player rams this ghost (see RemotePose.bump).
  bump(nx, nz, impulse) {
    this.pose.bump(nx, nz, impulse);
  }

  // Render the kart. The pose owns its own jitter-aware delay now, so it just
  // needs the shared-clock now + live RTT to pick its render offset.
  update(nowShared, rttMs, dt) {
    // Hide (don't freeze) a peer whose updates have dried up; show it again the
    // moment data resumes. Uses wall-clock so it's independent of the shared clock.
    const stale = this.pose.stale;
    this.group.visible = !stale;
    if (stale) return;

    const frame = this.pose.sampleAt(nowShared, rttMs, dt);
    if (!frame) return; // nothing buffered yet
    const k = this.kart;

    // Drop the puppet onto the smoothed pose, plus the transient bump offset.
    k.position.x = frame.x + frame.bumpX;
    k.position.z = frame.z + frame.bumpZ;
    k.groundY = frame.y; // sender already did ground-follow; y is absolute world height
    k.y = 0; // hops are baked into the sender's y; no separate jump offset
    k.position.y = frame.y;
    k.heading = frame.h;
    k.slopePitch = frame.p;
    k.speed = frame.s;

    // Decode visual flags.
    k.drifting = (frame.f & FLAG.DRIFT) !== 0;
    k.shielding = (frame.f & FLAG.SHIELD) !== 0;
    k.tootTimer = frame.f & FLAG.BOOST ? 0.1 : 0; // drives the boost wheelie + tail lift

    // Lean + cat-rig cornering, derived by the tracker from heading/speed deltas.
    k.steerInput = frame.steer;
    k.driftDir = frame.driftDir;
    k._lat = frame.lat;
    k._lon = frame.lon;
    k._dt = dt;
    k._wheelSpin = (k._wheelSpin || 0) + frame.spinDelta;

    k._syncMesh();
  }

  dispose(scene) {
    scene.remove(this.group);
    // Free the puppet's GPU resources (merged geometries + per-kart materials;
    // shared colour-keyed materials are skipped) — without this, every real
    // join/leave in a long multiplayer session leaked a full kart.
    disposeGroup(this.group);
  }
}
