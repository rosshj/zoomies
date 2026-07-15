// In-game network recorder (dev tool). Captures every remote pose snapshot as it
// ARRIVES — the local wall-clock time plus the pose — into a per-peer ring
// buffer, then exports a v1 trace (see net/sim/trace.js) you can replay through
// the netsim harness. The whole point of Stage 0's harness is to tune against
// real cellular behavior; this is how you capture it from an actual phone.
//
// Enable with ?rec=1 (or localStorage["zoomies-netrec"]="1" for installed PWAs,
// which have no address bar), then tap the "REC ⬇" chip on the debug HUD to save.

export class NetRecorder {
  constructor({ maxEntries = 20000, wallNow = () => performance.now() } = {}) {
    this.maxEntries = maxEntries;
    this.wallNow = wallNow;
    this.peers = new Map(); // id -> [{ w, pose }]
    this.count = 0;
    this.transport = "unknown";
    this.net = null;
  }

  attach(net) {
    this.net = net;
    this.transport =
      net.transport && typeof net.transport.p2pCount === "function" ? "webrtc" : "ably";
    net.on("state", (id, pose) => this._record(id, pose));
    return this;
  }

  _record(id, pose) {
    let arr = this.peers.get(id);
    if (!arr) { arr = []; this.peers.set(id, arr); }
    arr.push({
      w: this.wallNow(),
      // Copy only the wire fields, so we snapshot the value at arrival.
      pose: { t: pose.t, x: pose.x, y: pose.y, z: pose.z, h: pose.h, p: pose.p, s: pose.s, f: pose.f | 0, pr: pose.pr },
    });
    this.count++;
    // Ring buffer: drop this peer's oldest when the global cap is hit, so a long
    // session can't grow without bound on a phone.
    if (this.count > this.maxEntries) {
      let longest = null;
      for (const a of this.peers.values()) if (!longest || a.length > longest.length) longest = a;
      if (longest && longest.length) { longest.shift(); this.count--; }
    }
  }

  toJSON() {
    const clock = this.net && this.net.clock ? this.net.clock : null;
    const peers = {};
    for (const [id, arr] of this.peers) peers[id] = arr;
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      transport: this.transport,
      clock: { offset: clock ? clock.offset : 0, bestRtt: clock ? clock.rtt : 0 },
      peers,
    };
  }

  // Save the trace as a file: a normal download on desktop, the native share
  // sheet on mobile (where <a download> is unreliable). Returns false if there's
  // nothing to save yet.
  export() {
    if (this.count === 0) return false;
    const json = JSON.stringify(this.toJSON());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `zoomies-trace-${stamp}.json`;
    const blob = new Blob([json], { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [new File([blob], name)] })) {
        navigator.share({ files: [new File([blob], name)], title: "Zoomies netcode trace" });
        return true;
      }
    } catch { /* fall through to download */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
}

// Whether recording is enabled for this session (URL flag or persisted pref).
export function recorderEnabled() {
  try {
    if (new URLSearchParams(location.search).has("rec")) return true;
    return localStorage.getItem("zoomies-netrec") === "1";
  } catch { return false; }
}
