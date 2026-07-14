// Netsim scenario runner. Builds N simulated clients — each a REAL Net + real
// MpSession (the code main.js ships) fed by a headless remote per peer — over one
// LoopbackHub on one SimClock with a seeded rng, then pumps virtual render frames
// and measures how faithfully each client's ghost of each peer tracks that peer's
// scripted ground truth. Because every timing/random source is injected, a given
// (seed, config) reproduces bit-for-bit.
//
// See metrics.js for the summary shape and the CLI (tools/netsim-check.mjs) for
// the scenario matrix + invariants.

import { Net } from "../net.js";
import { LoopbackHub } from "../loopback.js";
import { MpSession } from "../session.js";
import { RemotePose, FLAG } from "../remotepose.js";
import { SimClock } from "./sched.js";
import { MetricSink } from "./metrics.js";
import { circleDriver } from "./drivers.js";
import { makeRng } from "../../rng.js";

// Headless mirror of RemoteKart: applies the sampled frame to a bare kart object
// and remembers the frame so the harness can score it. Same field surface the
// session/collision code touches (kart.position/mass/speed, group.visible,
// _ready, placement fields).
class SimRemote {
  constructor(identity, now) {
    this.id = identity.id;
    this.name = identity.name;
    this.host = false;
    this.group = { visible: true };
    this.kart = { position: { x: 0, y: 0, z: 0 }, mass: 1, speed: 0 };
    this.pose = new RemotePose({ now });
    this.finished = false;
    this.finishTime = 0;
    this.finishClock = 0;
    this.lastFrame = null;
    this.hidden = false;
  }
  get totalProgress() { return this.pose.totalProgress; }
  set totalProgress(v) { this.pose.totalProgress = v; }
  get _ready() { return this.pose.ready; }
  pushState(pose) { this.pose.pushState(pose); }
  bump(nx, nz, impulse) { this.pose.bump(nx, nz, impulse); }
  update(renderTime, dt) {
    this.hidden = this.pose.stale;
    this.group.visible = !this.hidden;
    if (this.hidden) { this.lastFrame = null; return; }
    const f = this.pose.sample(renderTime, dt);
    this.lastFrame = f;
    if (f) {
      this.kart.position.x = f.x + f.bumpX;
      this.kart.position.z = f.z + f.bumpZ;
      this.kart.speed = f.s;
    }
  }
  dispose() {}
}

export async function runScenario(cfg = {}) {
  const {
    seed = "NETSIM",
    players = [
      { driver: circleDriver({ radius: 60, speed: 30, phase: 0 }) },
      { driver: circleDriver({ radius: 60, speed: 30, phase: Math.PI }) },
    ],
    durationMs = 60000,
    tickHz = 60,
    warmupMs = 2000, // skip metrics while clocks sync + ghosts spawn
    hub: hubCfg = { latency: 60, jitter: 10, clockSkew: 0, loss: 0 },
    clientSkews = [],
  } = cfg;

  const clock = new SimClock();
  const rng = makeRng(seed);
  const hub = new LoopbackHub({
    ...hubCfg,
    rng,
    schedule: (fn, ms) => clock.setTimeout(fn, ms),
    now: () => clock.now(),
  });
  const now = () => clock.now();

  const N = players.length;
  const sessions = [];
  for (let i = 0; i < N; i++) {
    const skew = clientSkews[i] || 0;
    const localNow = () => clock.now() + skew;
    const netOptions = { localNow, timers: clock.timers() };
    const driver = players[i].driver;
    const mp = new MpSession({
      createRemote: (identity) => new SimRemote(identity, now),
      disposeRemote: () => {},
      hasLocalPlayer: () => true,
      getPose: () => {
        const t = clock.now();
        const p = driver.poseAt(t);
        return { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p, s: p.s, f: 0, pr: t * 1e-4 };
      },
      amHost: () => i === 0,
      wallNow: now,
      netOptions,
    });
    mp.enabled = true;
    sessions.push(mp);
  }

  // Connect everyone (await so each Net is wired before the clock pumps).
  await Promise.all(
    sessions.map((mp, i) =>
      mp.begin(Promise.resolve(hub.connect()), () => ({ name: "P" + i, host: i === 0 })),
    ),
  );

  const metrics = new MetricSink();
  const dt = 1 / tickHz;
  const tickMs = 1000 / tickHz;
  // Previous displayed position per (client i, remote id) for the teleport check.
  const prevPos = new Map();
  const idToDriver = new Map(); // remote id -> that peer's driver

  for (let step = 0; ; step++) {
    const t = step * tickMs;
    if (t > durationMs) break;
    clock.run(t); // deliver everything due (messages, pings) up to now
    for (const mp of sessions) mp.update(dt);

    if (t < warmupMs) continue;
    for (let i = 0; i < N; i++) {
      const mp = sessions[i];
      const interpDelay = mp.interpDelay;
      for (const r of mp.remotes.values()) {
        // Which player is this a ghost of? Map its net id to its driver once.
        let driver = idToDriver.get(r.id);
        if (!driver) {
          driver = resolveDriver(sessions, players, r.id);
          if (driver) idToDriver.set(r.id, driver);
        }
        metrics.inc("frames.total");
        if (r.hidden) { metrics.inc("frames.hidden"); continue; }
        const f = r.lastFrame;
        if (!f) continue;
        metrics.inc("frames.shown");
        if (f.extrapolated) metrics.inc("frames.extrap");

        const dispX = f.x + f.bumpX;
        const dispZ = f.z + f.bumpZ;

        // Correction magnitude: how far the smoother is from the raw sample.
        metrics.record("correction", Math.hypot(f.rawX - f.x, f.rawZ - f.z));
        // Staleness: how far in the past (shared clock) the shown pose is.
        metrics.record("staleness", mp.net.now() - f.t);

        if (driver) {
          const absTruth = driver.poseAt(t);
          const delTruth = driver.poseAt(t - interpDelay);
          metrics.record("errAbs", Math.hypot(dispX - absTruth.x, dispZ - absTruth.z));
          metrics.record("errDelayed", Math.hypot(dispX - delTruth.x, dispZ - delTruth.z));
        }

        // Teleport invariant: displayed pose must not jump > 3u between frames
        // unless the tracker snapped (respawn / first sample / big correction).
        const key = i + ":" + r.id;
        const prev = prevPos.get(key);
        if (prev && !f.snapped) {
          const jump = Math.hypot(dispX - prev.x, dispZ - prev.z);
          if (jump > 3) metrics.inc("teleports");
          metrics.record("frameJump", jump);
        }
        if (f.snapped && prev) metrics.inc("snaps"); // exclude the first-frame snap (no prev)
        prevPos.set(key, { x: dispX, z: dispZ });
      }
    }
  }

  const summary = metrics.summary();
  summary.interpDelayFinal = sessions.map((mp) => Math.round(mp.interpDelay * 10) / 10);
  summary.rttFinal = sessions.map((mp) => Math.round((mp.net.clock.rtt || 0) * 10) / 10);
  return summary;
}

// A remote's net id (c1, c2, …) is assigned by the hub in client-creation order,
// which is session order — session i's transport is the (i+1)-th connect(). Map
// the id back to the owning player's driver.
function resolveDriver(sessions, players, remoteId) {
  for (let j = 0; j < sessions.length; j++) {
    if (sessions[j].net && sessions[j].net.id === remoteId) return players[j].driver;
  }
  return null;
}

export { SimRemote, FLAG };
