// Recorded-trace replay. A trace is what one real device actually received: for
// each peer, the sequence of pose snapshots with the local wall-clock time they
// ARRIVED. Replaying it through the real Net + MpSession + RemotePose reproduces
// that device's interpolation exactly, so the harness can score receive-side
// quality (snaps, extrapolation share, correction magnitude, staleness) against
// genuine cellular conditions the synthetic scenarios only approximate.
//
// Trace schema v1:
//   {
//     version: 1,
//     capturedAt: "2026-07-13T...",     // ISO, informational
//     transport: "ably" | "webrtc" | …,
//     clock: { offset, bestRtt },        // receiver's shared-clock offset at capture
//     peers: {
//       "<peerId>": [ { w, pose: { t, x, y, z, h, p, s, f, pr } }, … ]  // w = perf.now() at arrival
//     }
//   }
//
// No ground truth is recorded (the sender's true path is unknown), so replay
// metrics are receive-side only — there is no positional-error number here.

import { Net } from "../net.js";
import { MpSession } from "../session.js";
import { SimClock } from "./sched.js";
import { MetricSink } from "./metrics.js";
import { SimRemote } from "./scenario.js";

// Transport that plays a recorded trace to a single receiver. Emits a synthetic
// welcome + one hello per peer, answers clock pings with the recorded offset (so
// ClockSync lands where it did at capture), and delivers each pose `state` at its
// recorded arrival time on the sim clock.
export class TraceTransport {
  constructor(trace, clock, { selfId = "self" } = {}) {
    this.trace = trace;
    this.clock = clock;
    this.selfId = selfId;
    this.offset = (trace.clock && trace.clock.offset) || 0;
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
  }

  open() {
    const c = this.clock;
    c.setTimeout(() => this._recv({ type: "welcome", id: this.selfId }), 0);
    for (const peerId of Object.keys(this.trace.peers)) {
      const entries = this.trace.peers[peerId];
      const firstW = entries.length ? entries[0].w : 0;
      // Announce the peer just before its first pose lands.
      c.setTimeout(() => this._recv({ type: "hello", id: peerId, name: peerId }), Math.max(0, firstW - 1));
      for (const e of entries) {
        c.setTimeout(() => this._recv({ type: "state", id: peerId, ...e.pose }), Math.max(0, e.w));
      }
    }
  }

  send(msg) {
    // Pure receiver: only answer clock pings so the shared clock reconstructs.
    if (msg && msg.type === "ping") {
      this.clock.setTimeout(() => this._recv({ type: "pong", c: msg.c, S: this.clock.now() + this.offset }), 0);
    }
  }
  _recv(msg) {
    if (this.onmessage) this.onmessage(msg);
  }
  close() {
    if (this.onclose) this.onclose();
  }
}

// Latest arrival time across all peers — how long to pump the clock.
function traceEndMs(trace) {
  let end = 0;
  for (const peerId of Object.keys(trace.peers)) {
    const entries = trace.peers[peerId];
    if (entries.length) end = Math.max(end, entries[entries.length - 1].w);
  }
  return end;
}

// Inter-arrival gaps per peer, straight from the trace (independent of replay).
function interArrival(trace, metrics) {
  for (const peerId of Object.keys(trace.peers)) {
    const entries = trace.peers[peerId];
    for (let i = 1; i < entries.length; i++) {
      metrics.record("interArrival", entries[i].w - entries[i - 1].w);
    }
  }
}

// Replay a trace and return receive-side metrics (same shape as runScenario,
// minus positional error). tickHz drives the render cadence, as in the game.
export async function replayTrace(trace, { tickHz = 60, warmupMs = 500 } = {}) {
  if (!trace || trace.version !== 1) throw new Error("unsupported trace (need version 1)");

  const clock = new SimClock();
  const now = () => clock.now();
  const netOptions = { localNow: now, timers: clock.timers() };

  const mp = new MpSession({
    createRemote: (identity) => new SimRemote(identity, now),
    disposeRemote: () => {},
    hasLocalPlayer: () => false, // pure receiver: we don't broadcast our own pose
    getPose: () => null,
    amHost: () => false,
    wallNow: now,
    netOptions,
  });
  mp.enabled = true;

  const transport = new TraceTransport(trace, clock);
  // begin() calls new Net(transport, …) and connect() synchronously in its .then;
  // await so the transport is wired before we pump.
  await mp.begin(Promise.resolve(transport), () => ({ name: "self" }));

  const metrics = new MetricSink();
  interArrival(trace, metrics);
  const dt = 1 / tickHz;
  const tickMs = 1000 / tickHz;
  const endMs = traceEndMs(trace) + 500; // a little tail so the last poses render
  const prevPos = new Map();

  for (let step = 0; ; step++) {
    const t = step * tickMs;
    if (t > endMs) break;
    clock.run(t);
    mp.update(dt);
    if (t < warmupMs) continue;
    for (const r of mp.remotes.values()) {
      metrics.inc("frames.total");
      if (r.hidden) { metrics.inc("frames.hidden"); continue; }
      const f = r.lastFrame;
      if (!f) continue;
      metrics.inc("frames.shown");
      if (f.extrapolated) metrics.inc("frames.extrap");
      metrics.record("correction", Math.hypot(f.rawX - f.x, f.rawZ - f.z));
      metrics.record("staleness", mp.net.now() - f.t);
      const dispX = f.x + f.bumpX;
      const dispZ = f.z + f.bumpZ;
      const prev = prevPos.get(r.id);
      if (prev && !f.snapped) {
        const jump = Math.hypot(dispX - prev.x, dispZ - prev.z);
        if (jump > 3) metrics.inc("teleports");
      }
      if (f.snapped && prev) metrics.inc("snaps");
      prevPos.set(r.id, { x: dispX, z: dispZ });
    }
  }

  const summary = metrics.summary();
  summary.peers = Object.keys(trace.peers).length;
  summary.transport = trace.transport || "unknown";
  return summary;
}

// Validate a parsed trace object; throws with a helpful message. Exposed so the
// CLI can fail clearly on a malformed file.
export function validateTrace(trace) {
  if (!trace || typeof trace !== "object") throw new Error("trace is not an object");
  if (trace.version !== 1) throw new Error(`unsupported trace version ${trace.version} (need 1)`);
  if (!trace.peers || typeof trace.peers !== "object") throw new Error("trace.peers missing");
  for (const [peerId, entries] of Object.entries(trace.peers)) {
    if (!Array.isArray(entries)) throw new Error(`trace.peers[${peerId}] is not an array`);
    for (const e of entries) {
      if (typeof e.w !== "number" || !e.pose || typeof e.pose.t !== "number") {
        throw new Error(`trace.peers[${peerId}] has a malformed entry`);
      }
    }
  }
  return trace;
}
