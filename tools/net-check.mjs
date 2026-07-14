// Unit checks for the netcode's testable seams: the WebRTC transport's pure
// routing decisions (the stateful RTCPeerConnection mesh can only be tested
// live, but these guard the logic that decides who initiates and how the Ably
// state-fallback is de-duplicated), and the loopback hub + Net running fully
// deterministically on a virtual clock with a seeded rng — the substrate the
// netsim harness builds on.
// Run: `npm run check:net`.
import { isInitiator, acceptAblyState, WebRTCTransport } from "../src/net/webrtc.js";
import { Net } from "../src/net/net.js";
import { LoopbackHub } from "../src/net/loopback.js";
import { SimClock } from "../src/net/sim/sched.js";
import { makeRng } from "../src/rng.js";
import { RemotePose, FLAG } from "../src/net/remotepose.js";
import { MpSession, REMOTE_GRACE_MS, KART_COLLIDE_MIN, kartBumpPower } from "../src/net/session.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Initiator is deterministic (lower id offers) and never both sides.
check("lower id initiates", isInitiator("aaa", "bbb") === true);
check("higher id waits", isInitiator("bbb", "aaa") === false);
check("exactly one side initiates a pair", isInitiator("x", "y") !== isInitiator("y", "x"));

// Ably state-fallback dedup: accept when there's no live P2P link, drop when there is.
check("no peer yet → accept Ably state", acceptAblyState(undefined) === true);
check("peer still connecting → accept Ably state", acceptAblyState({ ready: false }) === true);
check("peer P2P-live → drop the Ably duplicate", acceptAblyState({ ready: true }) === false);

// --- Integration: two transports form a P2P link and route state directly ---
// Mocks WebRTC (a linked data-channel pair that "connects" on offer/answer) and
// Ably (an in-process relay/presence bus), so the real signalling + routing code
// runs end to end. Proves a bug isn't hiding in the handshake or the send path.
{
  class MockChannel {
    constructor(label) { this.label = label; this.readyState = "connecting"; this.onopen = this.onclose = this.onmessage = null; this._pair = null; }
    send(data) { if (this._pair && this._pair.onmessage) queueMicrotask(() => this._pair.onmessage({ data })); }
    close() { this.readyState = "closed"; }
    _open() { this.readyState = "open"; if (this.onopen) this.onopen(); }
  }
  class MockPC {
    constructor() { this.onicecandidate = this.ondatachannel = this.onconnectionstatechange = null; this.connectionState = "new"; this.localDescription = this.remoteDescription = null; this._dc = null; }
    createDataChannel(label) { this._dc = new MockChannel(label); return this._dc; }
    createOffer() { return Promise.resolve({ type: "offer", _dc: this._dc }); }
    createAnswer() { return Promise.resolve({ type: "answer" }); }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    setRemoteDescription(d) {
      this.remoteDescription = d;
      if (d.type === "offer" && d._dc) { // answerer: pair a channel to the initiator's and open both
        const local = new MockChannel("game");
        local._pair = d._dc; d._dc._pair = local;
        queueMicrotask(() => { if (this.ondatachannel) this.ondatachannel({ channel: local }); local._open(); d._dc._open(); });
      }
      return Promise.resolve();
    }
    addIceCandidate() { return Promise.resolve(); }
    close() { this.connectionState = "closed"; }
  }
  globalThis.RTCPeerConnection = MockPC;

  const bus = [];
  class FakeAbly {
    constructor(id) { this._id = id; this._on = null; this._q = [{ type: "welcome", id }]; this.onclose = null; bus.push(this); }
    get onmessage() { return this._on; }
    set onmessage(fn) { this._on = fn; if (fn) { const q = this._q; this._q = []; for (const m of q) fn(m); } }
    _rx(m) { if (this._on) this._on(m); else this._q.push(m); }
    open() { for (const o of bus) if (o !== this) { this._rx({ type: "hello", id: o._id, name: "P" }); o._rx({ type: "hello", id: this._id, name: "P" }); } }
    send(obj) { for (const o of bus) if (o !== this) o._rx({ ...obj, id: this._id }); }
    close() {}
  }

  const A = new WebRTCTransport(new FakeAbly("aaa"));
  const B = new WebRTCTransport(new FakeAbly("bbb"));
  const gotA = [], gotB = [];
  A.onmessage = (m) => gotA.push(m);
  B.onmessage = (m) => gotB.push(m);
  A.open();
  B.open();
  // Let the mocked offer/answer/data-channel microtasks settle.
  await tick(); await tick(); await tick();

  check("both peers report a live P2P link", A.p2pCount() === 1 && B.p2pCount() === 1);

  // A sends a pose; B should receive it directly, exactly once (no Ably duplicate).
  const beforeStates = gotB.filter((m) => m.type === "state").length;
  A.send({ type: "state", x: 42, id: "aaa" });
  await tick(); await tick();
  const states = gotB.filter((m) => m.type === "state");
  check("state routes peer-to-peer to the other side", states.some((m) => m.x === 42));
  check("no duplicate state (P2P only, no Ably copy)", states.length - beforeStates === 1);
}

// --- RemotePose golden sequences ---
// The pure tracker extracted from RemoteKart must reproduce the old inline math
// exactly. Expected values are transcribed independently from the same formulas
// (not read back from the implementation), down to float-operation order.
{
  const dt = 1 / 60;
  let wall = 0;
  const rp = new RemotePose({ now: () => wall });

  check("empty buffer → no frame", rp.sample(1000, dt) === null && rp.ready === false);

  const sa = { t: 1000, x: 0, y: 0, z: 0, h: 0, p: 0, s: 30, f: FLAG.DRIFT | FLAG.BOOST, pr: 0.1 };
  const sb = { t: 1100, x: 3, y: 0, z: 1, h: 0.2, p: 0, s: 30, f: FLAG.DRIFT, pr: 0.12 };
  rp.pushState(sa);
  rp.pushState(sb);
  check("progress: latest value wins", rp.totalProgress === 0.12);

  // Cubic-Hermite position between two snapshots, tangents = velocity·span_sec.
  // Transcribed independently from the math (not read back from interp.js).
  function hermiteXZ(a, b, span, u) {
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const spanSec = span / 1000;
    const maX = Math.sin(a.h) * a.s * spanSec;
    const maZ = Math.cos(a.h) * a.s * spanSec;
    const mbX = Math.sin(b.h) * b.s * spanSec;
    const mbZ = Math.cos(b.h) * b.s * spanSec;
    return {
      x: h00 * a.x + h10 * maX + h01 * b.x + h11 * mbX,
      z: h00 * a.z + h10 * maZ + h01 * b.z + h11 * mbZ,
    };
  }

  // The very first frame snaps to the raw Hermite sample at u = 0.5.
  const her1 = hermiteXZ(sa, sb, 100, 0.5);
  const f1 = rp.sample(1050, dt);
  check("first frame snaps to the raw Hermite sample", f1.snapped === true && f1.x === her1.x && f1.z === her1.z);
  check("heading still lerps (authoritative facing, not tangent)", Math.abs(f1.h - 0.1) < 1e-12);
  check("interpolated frames now carry nearest-snapshot flags", f1.f === FLAG.DRIFT);
  check("ready after first frame", rp.ready === true);

  // Second frame: projective velocity blending onto the Hermite sample (u = 0.6).
  // Advance the displayed x at the sample's own velocity, then decay the residual
  // toward the base over tau = 0.12s. Heading at u=0.6 is lerpAngle(0,0.2,0.6).
  const her2 = hermiteXZ(sa, sb, 100, 0.6);
  const sH2 = 0.2 * 0.6; // lerpAngle(0, 0.2, 0.6)
  const decay = Math.exp(-dt / 0.12);
  const velX2 = Math.sin(sH2) * 30;
  const exX2 = (her1.x + velX2 * dt) * decay + her2.x * (1 - decay);
  const f2 = rp.sample(1060, dt);
  check("projective blending converges onto the Hermite path", f2.snapped === false && f2.x === exX2);

  // Past the newest snapshot: dead-reckon from heading × speed, capped at 250ms;
  // the resulting jump is > 6u so the smoother snaps rather than smears. The
  // dead-reckon branch is unchanged, but now carries the last snapshot's flags.
  const exX3 = 3 + Math.sin(0.2) * 30 * 0.25;
  const f3 = rp.sample(1700, dt);
  check("dead-reckons past newest, capped at 250ms", f3.extrapolated === true && f3.rawX === exX3);
  check("big correction snaps instead of smearing", f3.snapped === true && f3.x === exX3);
  check("dead-reckon carries the last snapshot's flags", f3.f === FLAG.DRIFT);

  // Bump: impulse capped at 10 (THREE clampLength float-op order), integrated
  // for one frame, then faded — all before the 5u safety clamp.
  const rp2 = new RemotePose({ now: () => 0 });
  rp2.pushState({ t: 0, x: 0, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0 });
  rp2.bump(1, 0, 20);
  let vel = 1 * 20;
  { const len = Math.sqrt(vel * vel + 0); vel = vel * (1 / (len || 1)) * Math.max(0, Math.min(10, len)); }
  let off = vel * dt;
  off *= 1 - Math.min(1, 1.5 * dt);
  { const len = Math.sqrt(off * off + 0); off = off * (1 / (len || 1)) * Math.max(0, Math.min(5, len)); }
  const f4 = rp2.sample(0, dt);
  check("bump capped + integrated (THREE-order float math)", f4.bumpX === off && f4.bumpZ === 0);

  // Staleness: hidden after 2.5s of silence, back the instant data resumes.
  wall = 3000;
  check("stale after 2.5s of silence", rp.stale === true && rp.sample(1050, dt) === null);
  rp.pushState({ t: 1200, x: 4, y: 0, z: 2, h: 0.2, p: 0, s: 30, f: 0, pr: 0.15 });
  check("reappears on fresh data", rp.stale === false && rp.sample(1150, dt) !== null);
}

// --- Per-peer jitter-aware adaptive delay (sampleAt) ---
// A clean, steady feed drives the delay to its jitter-aware target; a bursty
// feed raises it. Verifies the RFC-3550 estimator + easing + clamp end to end.
{
  const dt = 1 / 60;
  function driveDelay(intervalsMs, rttMs) {
    let w = 0;
    const rp = new RemotePose({ now: () => w });
    let st = 1000;
    let nextIdx = 0;
    let sendAt = 0;
    let x = 0;
    // 20s of frames; push a snapshot on the given (repeating) interval schedule.
    for (let frame = 0; frame < 1200; frame++) {
      w = frame * (1000 * dt);
      while (sendAt <= w) {
        rp.pushState({ t: st, x: x++, y: 0, z: 0, h: 0, p: 0, s: 16, f: 0, pr: 0 });
        const gap = intervalsMs[nextIdx % intervalsMs.length];
        st += gap; sendAt += gap; nextIdx++;
      }
      rp.sampleAt(w + 100000, rttMs, dt); // nowShared arbitrary — delay easing is independent
    }
    return rp;
  }

  // Clean link: steady 62.5ms, rtt 20 → target = 10 + 60 + 2·jitter, clamped to
  // the 90ms floor. Assert it converged to its own formula (robust to tiny
  // quantization jitter) AND that it actually dropped below the old 180ms floor.
  const clean = driveDelay([62.5], 20);
  const cleanTarget = Math.max(90, Math.min(300, 20 * 0.5 + 75 + 2 * clean._jitter));
  check("clean-link delay converges to the jitter-aware target", Math.abs(clean.interpDelay - cleanTarget) < 0.5);
  check("clean-link delay drops well below the old 180ms floor", clean.interpDelay < 140);

  // Bursty link (alternating 30/95ms gaps → high jitter) with the same rtt must
  // buffer MORE than the clean link — the whole point of jitter-awareness.
  const bursty = driveDelay([30, 95], 20);
  check("bursty link buffers more than a clean one", bursty.interpDelay > clean.interpDelay + 20);
  check("delay never exceeds the ceiling", bursty.interpDelay <= 300 && clean.interpDelay >= 90);
}

// --- Determinism: a two-client loopback session on a virtual clock ---
// Everything that moves (message delays, ping timers, send cadence, device
// clocks) runs off one SimClock + one seeded rng, so an identical seed must
// reproduce the identical session — the property the netsim harness relies on.
{
  function runLoopbackSession(seed, { loss = 0 } = {}) {
    const clock = new SimClock();
    const rng = makeRng(seed);
    const hub = new LoopbackHub({
      latency: 40, jitter: 25, clockSkew: 5000, loss,
      rng, schedule: (fn, ms) => clock.setTimeout(fn, ms), now: () => clock.now(),
    });
    const log = [];
    // Client B's device clock is 30s off — ClockSync has to absorb it.
    const skews = [0, -30000];
    const nets = ["A", "B"].map((name, i) => {
      const localNow = () => clock.now() + skews[i];
      const n = new Net(hub.connect(), { name }, { localNow, timers: clock.timers() });
      n.on("peer", (p) => log.push(`${name}+${p.id}`));
      n.on("state", (id, pose) => log.push(`${name}<${id} t=${pose.t.toFixed(3)} x=${pose.x}`));
      n.connect();
      return n;
    });
    let step = 0;
    const iv = clock.setInterval(() => {
      step++;
      nets[0].sendState({ x: step, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0 });
      nets[1].sendState({ x: -step, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0 });
    }, 62);
    clock.run(5000);
    clock.clearInterval(iv);
    return { log, nets, hub, clock };
  }

  const run1 = runLoopbackSession("NETSIM");
  const run2 = runLoopbackSession("NETSIM");
  check("same seed → identical session log", JSON.stringify(run1.log) === JSON.stringify(run2.log));
  check("session actually exchanged poses", run1.log.filter((l) => l.includes("<")).length > 100);
  check("both peers discovered each other", run1.log.includes("A+c2") && run1.log.includes("B+c1"));

  // Clock convergence: each client's shared clock lands on the hub clock (skewed
  // +5s from the sim clock, with client B's device a further -30s off). With
  // ±25ms jitter the best-rtt ping bounds the offset error well under the jitter.
  const worst = Math.max(...run1.nets.map((n) => Math.abs(n.now() - run1.hub.now())));
  check(`shared clocks converge on the hub (worst ${worst.toFixed(1)}ms)`, worst < 40);

  // Loss knob: drops poses only — presence and clock sync must survive intact.
  const lossy = runLoopbackSession("NETSIM", { loss: 1 });
  check("loss=1 drops every pose", !lossy.log.some((l) => l.includes("<")));
  check("loss=1 leaves presence intact", lossy.log.includes("A+c2") && lossy.log.includes("B+c1"));
  const lossyWorst = Math.max(...lossy.nets.map((n) => Math.abs(n.now() - lossy.hub.now())));
  check("loss=1 leaves clock sync intact", lossyWorst < 40);
}

// --- MpSession orchestration over the loopback hub ---
// Drives the REAL session extracted from main.js (headless, with stub remotes)
// against a raw Net standing in for a second player, so the send loop, spawn/
// state routing, park→reap grace, teardown and collision pass are all exercised
// end to end — the coverage the two-tab manual test can't give in CI.
{
  const clock = new SimClock();
  const hub = new LoopbackHub({
    latency: 30, jitter: 0, clockSkew: 0,
    rng: makeRng("MPSESSION"), schedule: (fn, ms) => clock.setTimeout(fn, ms), now: () => clock.now(),
  });
  const netOpts = { localNow: () => clock.now(), timers: clock.timers() };

  // A headless stand-in for RemoteKart: records what the session drives into it.
  const built = [];
  function makeStubRemote(identity) {
    const r = {
      id: identity.id, name: identity.name, host: false,
      group: { visible: true },
      kart: { position: { x: 0, y: 0, z: 0 }, mass: 1, speed: 0 },
      _ready: false, _lastPose: null, _bumps: 0, disposed: false,
      finished: false, finishTime: 0, finishClock: 0, totalProgress: -1,
      pose: { interpDelay: 200 }, // enough surface for the session delay aggregate
      pushState(pose) { this._lastPose = pose; this._ready = true; this.kart.position.x = pose.x; this.kart.position.z = pose.z; },
      bump() { this._bumps++; },
      update() {},
      dispose() { this.disposed = true; },
    };
    built.push(r);
    return r;
  }

  const rosterTicks = [];
  const mp = new MpSession({
    createRemote: makeStubRemote,
    disposeRemote: (r) => r.dispose(),
    hasLocalPlayer: () => true,
    getPose: () => ({ x: 5, y: 0, z: 6, h: 0, p: 0, s: 20, f: FLAG.DRIFT, pr: 0.4 }),
    amHost: () => true,
    wallNow: () => clock.now(),
    netOptions: netOpts,
    hooks: { onRoster: () => rosterTicks.push(mp.remotes.size) },
  });
  mp.enabled = true;

  // The "other player": a raw Net that joins the same room and streams poses.
  const other = new Net(hub.connect(), { name: "Rival", host: false }, netOpts);
  const otherGotState = [];
  other.on("state", (id, pose) => otherGotState.push(pose));
  other.connect();

  // Await so the transport promise resolves and the session's Net is wired +
  // connected before we start pumping the virtual clock.
  await mp.begin(Promise.resolve(hub.connect()), () => ({ name: "Me", host: true }));

  // Drive the session's per-frame update at 60 Hz while the rival sends 16 Hz poses.
  let tickAcc = 0, rivalAcc = 0, rstep = 0;
  const frame = clock.setInterval(() => {
    mp.update(1 / 60);
    rivalAcc += 1 / 60;
    if (rivalAcc >= 1 / 16) { rivalAcc = 0; rstep++; other.sendState({ x: rstep, y: 0, z: 0, h: 0, p: 0, s: 15, f: 0, pr: 0.3 }); }
  }, 1000 / 60);
  clock.run(2000);

  check("session spawned the rival ghost on presence", mp.remotes.size === 1 && built.length === 1);
  check("rival poses routed into the ghost buffer", built[0]._ready && built[0]._lastPose !== null);
  check("roster hook fired on join", rosterTicks.length >= 1 && rosterTicks[rosterTicks.length - 1] === 1);
  check("session broadcast my pose at ~16 Hz", otherGotState.length > 25 && otherGotState.length < 40);
  check("my broadcast carried the drift flag + progress", otherGotState[0].f === FLAG.DRIFT && otherGotState[0].pr === 0.4);
  check("session delay aggregate stays sane [90,300]", mp.interpDelay >= 90 && mp.interpDelay <= 300);

  // Collision pass: put the player right on top of the ghost and confirm the
  // session knocks the player, nudges (bumps) the ghost, and separates them.
  built[0].kart.position.x = 1; built[0].kart.position.z = 0; // ghost near origin
  const player = { position: { x: 0, y: 0, z: 0 }, mass: 1.35, speed: 20, knock: { x: 0, z: 0 }, catnipBoosting: false };
  mp.resolveRemoteCollisions(player);
  check("collision knocked the player back", player.knock.x < 0);
  check("collision separated the player from the ghost", player.position.x < 0);
  check("collision cosmetically bumped the ghost", built[0]._bumps === 1);

  // Soft despawn parks the ghost; it's revived on rejoin within grace.
  clock.clearInterval(frame);
  const rid = built[0].id;
  mp.despawn(rid);
  check("soft despawn parks the ghost (not disposed)", mp.remotes.size === 0 && mp.parked.has(rid) && !built[0].disposed);
  mp.spawn({ id: rid, name: "Rival", host: false });
  check("rejoin within grace revives the same ghost", mp.remotes.size === 1 && mp.parked.size === 0 && built.length === 1);

  // Parked past the grace window gets reaped by update()'s sweeper.
  mp.despawn(rid);
  clock.run(clock.now() + REMOTE_GRACE_MS + 1000);
  mp.update(1 / 60);
  check("parked ghost reaped after the grace window", mp.parked.size === 0 && built[0].disposed);

  // Teardown drops the connection + all remotes.
  mp.spawn({ id: "late", name: "Late", host: false });
  const lateGhost = built[built.length - 1];
  mp.teardown();
  check("teardown disposes remaining remotes + disables", !mp.enabled && mp.remotes.size === 0 && lateGhost.disposed);

  // Shared collision constants match the single-player formula they replaced.
  check("KART_COLLIDE_MIN preserved", KART_COLLIDE_MIN === 4.4);
  check("kartBumpPower preserved", kartBumpPower(20, 10) === 10 + (20 + 10) * 0.4);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall net checks passed");
