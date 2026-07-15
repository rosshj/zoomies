// Pure race referee — the brain of the optional authority server (Stage 4).
//
// It owns NO positions: clients keep exchanging poses peer-to-peer, so movement
// stays zero-latency and unchanged. What a referee fixes is the CONTESTED,
// discrete events that today each client decides for itself and can disagree on:
//   • hits   — shooter-authoritative today, so two screens can disagree on
//              whether a furball landed (or whether a shield saved you);
//   • laps   — a desynced client can miscount;
//   • finish — a close finish is ranked off each client's own drifting clock.
// The referee adjudicates all three from ONE clock with lag compensation, then
// broadcasts a verdict every client obeys — so the race agrees with itself.
//
// This module is deliberately transport-free and dependency-free (injectable
// now()) so it runs identically inside the Cloudflare Durable Object
// (workers/referee/) and inside the headless test (tools/referee-check.mjs).
// The DO is a thin WebSocket shell around this class.

// Per-player position history kept for lag compensation (ms). One second is far
// more than any sane hit-claim age; older samples are dropped.
const HISTORY_MS = 1000;
// Reject a hit claim whose fire-time is older than this — a real furball resolves
// within a couple hundred ms of firing, so an older claim is a stale/replayed one.
const MAX_REWIND_MS = 350;
// One adjudicated hit per victim per window: absorbs the shooter + its ghost both
// reporting the same contact, and stops hit-spam from re-spinning a victim.
const HIT_COOLDOWN_MS = 900;
// Loose geometry sanity: at fire-time the victim must be within this of the
// shooter. Furballs/yarn travel far, so this is generous — it only rejects
// wildly implausible cross-map claims, never a legitimate shot.
const MAX_HIT_RANGE = 90;
// Progress (lap + within-lap fraction) can't advance more than this in a single
// update without it being a teleport/desync — reject the lap it would grant.
const MAX_PROGRESS_STEP = 1.1;

// Shared with the pose flag bitmask (remotepose.js FLAG); referee only reads
// SHIELD, evaluated at the lag-compensated fire-time.
const FLAG_SHIELD = 4;

export class RefereeRoom {
  constructor({ now = () => Date.now(), totalLaps = 3 } = {}) {
    this._now = now;
    this.totalLaps = totalLaps;
    this.players = new Map(); // id -> { history:[{t,x,z,f}], progress, laps, hitUntil, finished, place }
    this._nextPlace = 1;
  }

  join(id) {
    if (!this.players.has(id)) {
      this.players.set(id, { history: [], progress: 0, laps: 0, hitUntil: 0, finished: false, place: 0 });
    }
    return this.players.get(id);
  }
  leave(id) { this.players.delete(id); }

  // A pose snapshot arrived (shared-clock t). Feed the lag-comp buffer and fold
  // lap progress. Returns a lap-complete verdict { id, lap, at } or null.
  ingestState(id, pose) {
    const p = this.join(id);
    const t = pose.t;
    // Keep the buffer time-sorted; drop anything older than HISTORY_MS behind the
    // newest. Out-of-order/duplicate stamps are ignored (last writer per t is fine
    // for interpolation; we only need brackets around a fire-time).
    const h = p.history;
    if (!h.length || t > h[h.length - 1].t) {
      h.push({ t, x: pose.x, z: pose.z, f: pose.f | 0 });
      const cutoff = t - HISTORY_MS;
      while (h.length > 2 && h[0].t < cutoff) h.shift();
    }
    return typeof pose.pr === "number" ? this._foldProgress(p, id, pose.pr) : null;
  }

  // Interpolate a player's position at shared-clock time `t` (lag compensation).
  // Flags take the nearest bracketing sample (they don't interpolate). Returns
  // { x, z, f } or null if we can't bracket t within the buffer.
  positionAt(id, t) {
    const p = this.players.get(id);
    if (!p || !p.history.length) return null;
    const h = p.history;
    if (t <= h[0].t) return { x: h[0].x, z: h[0].z, f: h[0].f };
    const last = h[h.length - 1];
    if (t >= last.t) return { x: last.x, z: last.z, f: last.f };
    for (let i = 0; i < h.length - 1; i++) {
      const a = h[i], b = h[i + 1];
      if (t >= a.t && t <= b.t) {
        const u = (t - a.t) / (b.t - a.t || 1);
        return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, f: u < 0.5 ? a.f : b.f };
      }
    }
    return { x: last.x, z: last.z, f: last.f };
  }

  // Adjudicate a shooter's hit claim against `target`, lag-compensated to fire
  // time `t`. Geometry itself is trusted (the shooter already hit-tested on its
  // screen); the referee owns the shield/cooldown/freshness/range gate so every
  // client applies the SAME verdict. Returns { ok, reason?, event? }.
  // event = { target, by, dir, at } to broadcast when ok.
  adjudicateHit({ shooter, target, t, dir }) {
    const now = this._now();
    if (!target || shooter === target) return { ok: false, reason: "self-or-empty" };
    const vp = this.players.get(target);
    if (!vp) return { ok: false, reason: "unknown-target" };
    if (now - t > MAX_REWIND_MS) return { ok: false, reason: "stale-claim" };
    if (now < vp.hitUntil) return { ok: false, reason: "cooldown" };
    if (vp.finished) return { ok: false, reason: "target-finished" };

    // Rewind the victim to fire-time: a shield up THEN saves them (matches the
    // shooter's own screen, since the shooter fired against that rewound ghost).
    const vpos = this.positionAt(target, t);
    if (vpos && (vpos.f & FLAG_SHIELD)) return { ok: false, reason: "shielded" };

    // Loose cross-map sanity using the shooter's rewound position if we have one.
    const spos = this.positionAt(shooter, t);
    if (spos && vpos) {
      const d = Math.hypot(vpos.x - spos.x, vpos.z - spos.z);
      if (d > MAX_HIT_RANGE) return { ok: false, reason: "out-of-range" };
    }

    vp.hitUntil = now + HIT_COOLDOWN_MS;
    return { ok: true, event: { target, by: shooter, dir: dir || { x: 0, z: 0 }, at: now } };
  }

  // Fold a fresh progress reading, emitting a lap-complete verdict when the whole
  // lap count ticks up by exactly one without a teleport. Monotonic: backward or
  // implausibly-large jumps are ignored (kept as the running max).
  _foldProgress(p, id, pr) {
    if (!Number.isFinite(pr)) return null;
    const prev = p.progress;
    if (pr <= prev) { return null; } // no forward progress → nothing to grant
    const jumped = pr - prev > MAX_PROGRESS_STEP;
    p.progress = pr; // track the max either way (so we don't re-grant later)
    if (jumped) return null; // teleport/desync — advance the marker but grant no lap
    const laps = Math.floor(pr);
    if (laps > p.laps) {
      p.laps = laps;
      return { id, lap: laps, at: this._now() };
    }
    return null;
  }

  // Adjudicate a finish claim. Requires the player to have actually completed the
  // race distance (referee-tracked progress), and ranks by REFEREE arrival order
  // — not the client's self-reported time — so a close or contested finish is
  // decided by one clock. Idempotent per id. Returns { ok, reason?, event? }.
  // event = { id, place, at }.
  adjudicateFinish(id) {
    const p = this.players.get(id);
    if (!p) return { ok: false, reason: "unknown" };
    if (p.finished) return { ok: true, event: { id, place: p.place, at: p.finishAt } }; // idempotent
    if (p.progress < this.totalLaps) return { ok: false, reason: "laps-incomplete" };
    p.finished = true;
    p.place = this._nextPlace++;
    p.finishAt = this._now();
    return { ok: true, event: { id, place: p.place, at: p.finishAt } };
  }

  // Snapshot for late joiners / reconnects: who's finished and in what place.
  standings() {
    const out = [];
    for (const [id, p] of this.players) if (p.finished) out.push({ id, place: p.place, at: p.finishAt });
    out.sort((a, b) => a.place - b.place);
    return out;
  }
}

export const REFEREE_CONSTS = { HISTORY_MS, MAX_REWIND_MS, HIT_COOLDOWN_MS, MAX_HIT_RANGE, MAX_PROGRESS_STEP, FLAG_SHIELD };
