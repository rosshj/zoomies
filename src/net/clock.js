// Shared-clock synchronisation (NTP-style).
//
// Interpolation is meaningless unless every client agrees on "now". We estimate
// the offset between this device's clock and the server's by timing a ping/pong
// round trip: the lower the round-trip, the more trustworthy the sample, so we
// keep the offset from the lowest-RTT exchange seen recently. `now()` then
// returns server-aligned milliseconds that all clients share.
//
// Pure math (computeOffset) is separated out so it can be unit-tested in node.

// Given the local send time t0, the server's timestamp serverT, and the local
// receive time t1 (all ms), estimate the server clock's offset from ours and
// the round-trip time. Assumes symmetric latency (standard NTP assumption).
export function computeOffset(t0, serverT, t1) {
  const rtt = t1 - t0;
  const offset = serverT - (t0 + t1) / 2; // add to local clock -> server clock
  return { offset, rtt };
}

export class ClockSync {
  constructor(localNow = () => Date.now()) {
    this._localNow = localNow;
    this._offset = 0;
    this._bestRtt = Infinity;
    this.synced = false;
  }

  // Feed a completed round trip. We trust the sample with the smallest RTT,
  // and let a clearly-better sample replace a stale one.
  sample(t0, serverT, t1) {
    const { offset, rtt } = computeOffset(t0, serverT, t1);
    if (rtt <= this._bestRtt || rtt < this._bestRtt * 1.5) {
      // Blend toward the new offset, weighting tighter round-trips more.
      const w = rtt <= this._bestRtt ? 1 : 0.25;
      this._offset = this.synced ? this._offset + (offset - this._offset) * w : offset;
      if (rtt < this._bestRtt) this._bestRtt = rtt;
      this.synced = true;
    }
    return { offset: this._offset, rtt };
  }

  // Let the best RTT decay so we don't cling forever to one lucky early sample.
  relaxBestRtt(factor = 1.25) {
    if (Number.isFinite(this._bestRtt)) this._bestRtt *= factor;
  }

  get offset() {
    return this._offset;
  }
  get rtt() {
    return Number.isFinite(this._bestRtt) ? this._bestRtt : 0;
  }

  // Server-aligned current time (ms), shared across all clients.
  now() {
    return this._localNow() + this._offset;
  }
}
