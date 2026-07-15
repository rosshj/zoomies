// In-process loopback transport — a fake "server room" used for tests and local
// development with no infrastructure. It mimics what the PartyKit server does
// (assign ids, relay messages, cache identities, answer clock pings) and can
// simulate latency, jitter, and a deliberately skewed server clock so we can
// prove interpolation + clock-sync hold up before any real network exists.

export class LoopbackHub {
  // rng/schedule/now are injectable so a test harness can drive the hub on a
  // virtual clock with a seeded rng and get bit-identical runs; the defaults
  // keep the original wall-clock behavior. `loss` drops that fraction of pose
  // deliveries (state messages ONLY — losing welcome/hello/pong would break
  // joins and clock sync, which ride reliable channels on every real transport).
  constructor({
    latency = 60,
    jitter = 0,
    clockSkew = 0,
    rng = Math.random,
    schedule = (fn, ms) => setTimeout(fn, ms),
    now = () => Date.now(),
    loss = 0,
  } = {}) {
    this.latency = latency; // one-way delay (ms)
    this.jitter = jitter; // +/- random (ms)
    this.clockSkew = clockSkew; // server clock offset from now() (ms)
    this.rng = rng;
    this.schedule = schedule;
    this.localNow = now;
    this.loss = loss; // 0..1 probability a state delivery is dropped
    this.clients = new Map(); // id -> transport
    this.hellos = new Map(); // id -> last hello (identity cache)
    this._n = 0;
  }

  now() {
    return this.localNow() + this.clockSkew;
  }
  _delay() {
    return Math.max(0, this.latency + (this.jitter ? (this.rng() * 2 - 1) * this.jitter : 0));
  }

  // A new client connects; it immediately receives a 'welcome' with its id.
  connect() {
    const id = "c" + ++this._n;
    const transport = new LoopbackTransport(this, id);
    this.clients.set(id, transport);
    this._toClient(id, { type: "welcome", id });
    return transport;
  }

  _toClient(id, msg) {
    const t = this.clients.get(id);
    if (!t) return;
    if (msg.type === "state" && this.loss > 0 && this.rng() < this.loss) return;
    this.schedule(() => t._recv(msg), this._delay());
  }
  _broadcastOthers(fromId, msg) {
    for (const id of this.clients.keys()) if (id !== fromId) this._toClient(id, msg);
  }

  _fromClient(id, msg) {
    switch (msg.type) {
      case "ping":
        this._toClient(id, { type: "pong", c: msg.c, S: this.now() });
        break;
      case "hello":
        this.hellos.set(id, msg);
        this._broadcastOthers(id, msg);
        // Catch the newcomer up on everyone already here.
        for (const [oid, h] of this.hellos) if (oid !== id) this._toClient(id, h);
        break;
      case "state":
      default: // state / start / hit / finish … fan out to everyone else
        this._broadcastOthers(id, msg);
        break;
    }
  }

  _disconnect(id) {
    if (this.clients.delete(id)) {
      this.hellos.delete(id);
      this._broadcastOthers(id, { type: "bye", id });
    }
  }
}

export class LoopbackTransport {
  constructor(hub, id) {
    this.hub = hub;
    this.id = id;
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
  }
  open() {} // 'welcome' is already queued by hub.connect()
  send(msg) {
    this.hub._fromClient(this.id, msg);
  }
  _recv(msg) {
    if (this.onmessage) this.onmessage(msg);
  }
  close() {
    this.hub._disconnect(this.id);
    if (this.onclose) this.onclose();
  }
}
