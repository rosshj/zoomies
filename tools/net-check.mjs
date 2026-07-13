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

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall net checks passed");
