// Transport-agnostic networking facade.
//
// The game talks only to this object — never to PartyKit, WebSockets, or WebRTC
// directly. A `transport` is any object with { send(obj), close(), open?() } and
// assignable handlers { onmessage(obj), onopen(), onclose() }. Swapping the
// transport (loopback for tests, PartyKit today, WebRTC later) changes nothing
// in gameplay code. See net/loopback.js and net/partysocket.js.
//
// Wire protocol (JSON messages, tiny at 6 players / ~16 Hz):
//   server -> client : {type:'welcome', id}        connection accepted, here's your id
//                      {type:'pong', c, S}          clock round-trip reply (S = server now)
//                      {type:'hello', id, name,...}  another player's identity (presence)
//                      {type:'state', id, t, x,...}  another player's pose snapshot
//                      {type:'bye', id}              a player left
//   client -> server : {type:'ping', c}             clock round-trip probe
//                      {type:'hello', id, name,...}  my identity (broadcast on join)
//                      {type:'state', id, t, x,...}  my pose (broadcast ~16 Hz)

import { ClockSync } from "./clock.js";

export class Net {
  // `timers` is injectable so tests can run the ping burst/re-sync loop on a
  // virtual clock. Defaults MUST stay arrow wrappers — a bare `setTimeout`
  // reference throws "Illegal invocation" in Chrome when called unbound.
  constructor(transport, identity, {
    localNow = () => Date.now(),
    timers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    },
  } = {}) {
    this.transport = transport;
    this.identity = identity; // { name, color, catColor }
    this.id = null;
    this.connected = false;
    this.clock = new ClockSync(localNow);
    this._localNow = localNow;
    this._timers = timers;
    this._peers = new Set(); // ids we've already announced (server may resend hellos)
    this._handlers = { open: [], peer: [], state: [], peerleave: [], start: [], shoot: [], hit: [], milk: [], yarn: [], finish: [], host: [], milkgloat: [], close: [] };
    this._pingTimer = null;
  }

  // Events: 'open'(id) · 'peer'(identity) · 'state'(id, pose) · 'peerleave'(id) · 'close'
  on(ev, fn) {
    (this._handlers[ev] || (this._handlers[ev] = [])).push(fn);
    return this;
  }
  _emit(ev, ...args) {
    for (const fn of this._handlers[ev] || []) fn(...args);
  }

  connect() {
    this.transport.onmessage = (m) => this._onMessage(m);
    this.transport.onclose = () => {
      this.connected = false;
      this._stopPing();
      this._emit("close");
    };
    this.transport.onopen = () => {}; // real readiness comes from 'welcome'
    if (this.transport.open) this.transport.open();
    return this;
  }

  // Pose send rate (Hz). The transport advertises it (WebRTC runs 30 Hz on the
  // direct channel; Ably/loopback/party leave it unset → 16 Hz, the relay-safe
  // default). The session's send loop divides by this.
  get sendRateHz() {
    return (this.transport && this.transport.sendRateHz) || 16;
  }

  // Server-aligned current time (ms), shared across clients — used to stamp
  // outgoing snapshots and to pick the render time for interpolation.
  now() {
    return this.clock.now();
  }

  // Broadcast my kart pose. pose = { x, y, z, h, p, s, f, pr } (f = flag bitmask,
  // pr = totalProgress = lap + within-lap fraction, the shared placement key).
  sendState(pose) {
    if (!this.connected) return;
    this.transport.send({
      type: "state",
      id: this.id,
      t: this.now(),
      x: pose.x, y: pose.y, z: pose.z,
      h: pose.h, p: pose.p, s: pose.s,
      f: pose.f | 0,
      pr: pose.pr,
    });
  }

  // Host broadcasts the synchronized race start. `at` is the shared-clock time
  // (ms) the countdown reaches GO, so every client can line up the same instant.
  sendStart(at) {
    if (!this.connected) return;
    this.transport.send({ type: "start", id: this.id, at });
  }

  // Broadcast that I fired a hairball, so others can render the projectile.
  sendShoot(pos, dir, charge, tri = false) {
    if (!this.connected) return;
    this.transport.send({
      type: "shoot", id: this.id,
      px: pos.x, py: pos.y, pz: pos.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      c: charge || 0,
      t: tri ? 1 : 0, // tri-furball: replicate the 3-way fan on the other clients
    });
  }

  // Shooter-authoritative hit: tell `target` it was struck (spin out), with the
  // hairball's travel direction so the spin shoves the right way.
  sendHit(target, dir) {
    if (!this.connected) return;
    this.transport.send({ type: "hit", id: this.id, target, hx: dir.x, hz: dir.z });
  }

  // Shooter-authoritative yarn: replicate the ball so every client renders a
  // cosmetic ghost that homes on its local copy of `target` (a RemoteKart id, or
  // "" for an unlocked roll). The hit itself is reported separately via sendHit,
  // exactly like ghost hairballs.
  sendYarn(t, lat, speed, target, life) {
    if (!this.connected) return;
    this.transport.send({ type: "yarn", id: this.id, yt: t, yl: lat, ys: speed, tg: target || "", lf: life });
  }

  // Victim-authoritative milk: replicate a dropped puddle by its final world
  // position + radius. Each client re-creates the puddle and trips its OWN player
  // on it, so no hit message is needed (the spin streams via the pose channel).
  sendMilk(x, z, r) {
    if (!this.connected) return;
    this.transport.send({ type: "milk", id: this.id, mx: x, mz: z, mr: r });
  }

  // Tell the player whose milk I just spun out on that they got me — `target` is
  // their id, so only they react (their cat looks back and laughs). Purely
  // cosmetic; the spin itself already streamed over the pose channel.
  sendMilkGloat(target) {
    if (!this.connected || !target) return;
    this.transport.send({ type: "milkgloat", id: this.id, target });
  }

  // Claim the host role for this room. Sent when a client that joined as a guest
  // (e.g. via an ?mp=1 link) promotes itself to host — the initial hello's host
  // flag can't change, so peers learn the new host from this. Ties resolve to the
  // lowest id (see MpSession._onHostClaim).
  sendHostClaim() {
    if (!this.connected) return;
    this.transport.send({ type: "host", id: this.id });
  }

  // Announce that I crossed the finish line. `ft` is my race time (seconds since
  // the synchronized GO), directly comparable across clients for final ordering.
  // ft = elapsed race time (for display). fc = shared-clock instant of finishing,
  // which is what every client ranks by — local elapsed time drifts between
  // clients over a long race and can't decide a close finish.
  sendFinish(ft, fc) {
    if (!this.connected) return;
    this.transport.send({ type: "finish", id: this.id, ft, fc });
  }

  _onMessage(m) {
    switch (m.type) {
      case "welcome":
        this.id = m.id;
        this.connected = true;
        this.transport.send({ type: "hello", id: this.id, ...this.identity });
        this._burstPings();
        this._startPing();
        this._emit("open", this.id);
        break;
      case "pong":
        this.clock.sample(m.c, m.S, this._localNow());
        break;
      case "hello":
        if (m.id === this.id || this._peers.has(m.id)) break; // dedupe re-sent hellos
        this._peers.add(m.id);
        this._emit("peer", { id: m.id, name: m.name, color: m.color, catColor: m.catColor, catPattern: m.catPattern, kartStyle: m.kartStyle, kartNumber: m.kartNumber, host: !!m.host, world: m.world || null });
        break;
      case "state":
        if (m.id === this.id) break;
        this._emit("state", m.id, {
          x: m.x, y: m.y, z: m.z, h: m.h, p: m.p, s: m.s, f: m.f | 0, t: m.t, pr: m.pr,
        });
        break;
      case "bye":
        if (!this._peers.delete(m.id)) break; // unknown / already gone
        this._emit("peerleave", m.id);
        break;
      case "start":
        this._emit("start", m.at);
        break;
      case "shoot":
        this._emit("shoot", { px: m.px, py: m.py, pz: m.pz, dx: m.dx, dy: m.dy, dz: m.dz, c: m.c, t: m.t });
        break;
      case "hit":
        this._emit("hit", { target: m.target, hx: m.hx, hz: m.hz });
        break;
      case "yarn":
        this._emit("yarn", { owner: m.id, t: m.yt, lat: m.yl, speed: m.ys, target: m.tg || null, life: m.lf });
        break;
      case "milk":
        this._emit("milk", { owner: m.id, x: m.mx, z: m.mz, r: m.mr });
        break;
      case "milkgloat":
        this._emit("milkgloat", m.target);
        break;
      case "finish":
        if (m.id === this.id) break;
        this._emit("finish", m.id, m.ft, m.fc);
        break;
      case "host":
        if (m.id === this.id) break;
        this._emit("host", m.id);
        break;
    }
  }

  _ping() {
    this.transport.send({ type: "ping", c: this._localNow() });
  }
  // A quick burst at join nails the clock down fast; then occasional re-syncs.
  _burstPings() {
    for (let i = 0; i < 4; i++) this._timers.setTimeout(() => this._ping(), i * 120);
  }
  _startPing() {
    this._stopPing();
    this._pingTimer = this._timers.setInterval(() => {
      this.clock.relaxBestRtt();
      this._ping();
    }, 3000);
  }
  _stopPing() {
    if (this._pingTimer) {
      this._timers.clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  close() {
    this._stopPing();
    if (this.transport.close) this.transport.close();
  }
}
