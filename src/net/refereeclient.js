// Client side of the optional race referee (Stage 4). A thin WebSocket connection
// to the Cloudflare Durable Object (workers/referee/) that runs ALONGSIDE the
// peer-to-peer pose channel — it never carries movement. It:
//   • streams a lightweight, throttled position feed (for the DO's lag comp),
//   • forwards local hit / finish CLAIMS,
//   • applies the DO's authoritative verdicts via injected callbacks,
// and degrades to a silent no-op whenever the socket isn't open, so the game is
// exactly itself if the referee is off or unreachable.
//
// The socket is injectable (makeSocket) so the whole protocol is unit-testable
// headless against a mock that speaks to a RefereeRoom directly — no Cloudflare
// runtime needed. In the browser it defaults to the global WebSocket.

export class RefereeClient {
  constructor({
    url,
    room = "main",
    id,
    name = "",
    onHit = () => {},      // (target, by, dir, at) — apply the spin
    onLap = () => {},      // (id, lap, at)
    onFinish = () => {},   // (id, place, at)
    onWelcome = () => {},  // (standings)
    makeSocket = (u) => new WebSocket(u),
    now = () => Date.now(),
    stateHz = 10,          // lag-comp feed rate (well under the pose rate)
    debug = false,         // ?refdebug=1 → log connect / verdicts / rejects to console
  } = {}) {
    this.url = url;
    this.room = room;
    this.id = id;
    this.name = name;
    this._onHit = onHit;
    this._onLap = onLap;
    this._onFinish = onFinish;
    this._onWelcome = onWelcome;
    this._makeSocket = makeSocket;
    this._now = now;
    this._stateInterval = 1000 / stateHz;
    this.ws = null;
    this.open = false;
    this._lastState = 0;
    this._joined = false;
    this._log = debug ? (...a) => console.log("[referee]", ...a) : () => {};
  }

  connect() {
    if (!this.url || !this.id) return this; // misconfigured → stay a no-op
    const sep = this.url.includes("?") ? "&" : "?";
    const full = `${this.url}${sep}room=${encodeURIComponent(this.room)}`;
    let ws;
    try { ws = this._makeSocket(full); } catch { return this; }
    this.ws = ws;
    this._log("connecting to", full);
    ws.onopen = () => {
      this.open = true;
      this._joined = true;
      this._send({ type: "join", id: this.id, name: this.name });
      this._log("connected ✓ (joined room", this.room + ")");
    };
    ws.onclose = () => { this.open = false; this._log("disconnected"); };
    ws.onerror = () => { this.open = false; this._log("socket error"); };
    ws.onmessage = (ev) => this._onMessage(ev && ev.data !== undefined ? ev.data : ev);
    return this;
  }

  _onMessage(raw) {
    let m;
    try { m = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
    if (!m || typeof m.type !== "string") return;
    switch (m.type) {
      case "welcome": this._log("welcome — standings:", m.standings || []); this._onWelcome(m.standings || []); break;
      case "hitv": this._log(`HIT verdict: ${m.by} → ${m.target}`); this._onHit(m.target, m.by, m.dir || { x: 0, z: 0 }, m.at); break;
      case "lapv": this._log(`LAP verdict: ${m.id} → lap ${m.lap}`); this._onLap(m.id, m.lap, m.at); break;
      case "finishv": this._log(`FINISH verdict: ${m.id} → place ${m.place}`); this._onFinish(m.id, m.place, m.at); break;
      case "reject": this._log(`rejected ${m.of}: ${m.reason}`); break; // e.g. shielded / cooldown / out-of-range
    }
  }

  // Throttled lag-comp feed. `pose` = { t, x, z, f, pr } (shared-clock t). Cheap
  // enough to call every frame — it self-limits to stateHz.
  sendState(pose) {
    if (!this.open) return;
    const n = this._now();
    if (n - this._lastState < this._stateInterval) return;
    this._lastState = n;
    this._send({ type: "state", id: this.id, t: pose.t, x: pose.x, z: pose.z, f: pose.f | 0, pr: pose.pr });
  }

  // Report a local hit I detected (shooter-authoritative geometry, referee-owned
  // validity). `t` = the shared-clock fire-time so the DO can lag-compensate.
  claimHit(target, t, dir) {
    if (!this.open || !target) return;
    this._send({ type: "hitclaim", id: this.id, target, t, dir: dir ? { x: dir.x, z: dir.z } : { x: 0, z: 0 } });
  }

  claimFinish() {
    if (!this.open) return;
    this._send({ type: "finishclaim", id: this.id });
  }

  _send(obj) {
    try { this.ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  close() {
    this.open = false;
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } }
  }

  get ready() { return this.open; }
}
