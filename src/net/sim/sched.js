// Virtual clock + scheduler for deterministic network simulation. Every timing
// source in a sim (LoopbackHub's schedule/now, each Net's timers/localNow, each
// RemotePose's now) is pointed at one SimClock, so a whole multi-client session
// runs instantly and reproducibly: same seed in, byte-identical metrics out.
//
// Events fire in (time, insertion order) — two events due at the same virtual
// millisecond run in the order they were scheduled, which is what makes runs
// with identical rng streams identical.

export class SimClock {
  constructor(startMs = 0) {
    this._now = startMs;
    this._queue = []; // sorted by (time, seq)
    this._seq = 0;
    this._nextId = 1;
    this._cancelled = new Set();
  }

  now() {
    return this._now;
  }

  setTimeout(fn, ms) {
    const id = this._nextId++;
    this._insert({ time: this._now + Math.max(0, ms || 0), seq: this._seq++, fn, id, every: 0 });
    return id;
  }
  clearTimeout(id) {
    this._cancelled.add(id);
  }
  // Intervals reschedule themselves relative to their due time (not fire time),
  // matching how a busy real event loop still averages the requested period.
  setInterval(fn, ms) {
    const id = this._nextId++;
    const every = Math.max(1, ms || 0);
    this._insert({ time: this._now + every, seq: this._seq++, fn, id, every });
    return id;
  }
  clearInterval(id) {
    this._cancelled.add(id);
  }

  // Bundle in the shape Net's `timers` option expects.
  timers() {
    return {
      setTimeout: (fn, ms) => this.setTimeout(fn, ms),
      setInterval: (fn, ms) => this.setInterval(fn, ms),
      clearInterval: (id) => this.clearInterval(id),
    };
  }

  // Advance virtual time to `untilMs`, firing every due event in order. Events
  // scheduled by other events are honored if they land within the window.
  run(untilMs) {
    while (this._queue.length && this._queue[0].time <= untilMs) {
      const ev = this._queue.shift();
      if (this._cancelled.has(ev.id)) {
        if (!ev.every) this._cancelled.delete(ev.id);
        continue;
      }
      this._now = Math.max(this._now, ev.time);
      if (ev.every) this._insert({ time: ev.time + ev.every, seq: this._seq++, fn: ev.fn, id: ev.id, every: ev.every });
      ev.fn();
    }
    this._now = Math.max(this._now, untilMs);
  }

  _insert(ev) {
    // Binary search by (time, seq) keeps insertion O(log n) + splice.
    let lo = 0;
    let hi = this._queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this._queue[mid];
      if (q.time < ev.time || (q.time === ev.time && q.seq < ev.seq)) lo = mid + 1;
      else hi = mid;
    }
    this._queue.splice(lo, 0, ev);
  }
}
