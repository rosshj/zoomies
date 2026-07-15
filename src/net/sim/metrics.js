// Metric accumulation for netsim runs. Two kinds of signal:
//   • series  — per-frame measurements summarized as avg / p50 / p95 / p99 / max
//   • counters — event tallies (snaps, teleports) and share denominators
// summary() returns a plain object with rounded numbers so two identical runs
// serialize byte-for-byte and baselines diff cleanly.

const ROUND = 1e4; // 4 decimal places
const round = (v) => Math.round(v * ROUND) / ROUND;

export class MetricSink {
  constructor() {
    this.series = new Map(); // name -> number[]
    this.counters = new Map(); // name -> number
  }

  record(name, value) {
    let arr = this.series.get(name);
    if (!arr) { arr = []; this.series.set(name, arr); }
    arr.push(value);
  }
  inc(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }
  get(name) {
    return this.counters.get(name) || 0;
  }

  static _stats(arr) {
    const n = arr.length;
    if (n === 0) return { n: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = arr.slice().sort((a, b) => a - b);
    let sum = 0;
    for (const v of arr) sum += v;
    const pct = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
    return {
      n,
      avg: round(sum / n),
      p50: round(pct(0.5)),
      p95: round(pct(0.95)),
      p99: round(pct(0.99)),
      max: round(sorted[n - 1]),
    };
  }

  summary() {
    const out = { series: {}, counters: {} };
    for (const [name, arr] of this.series) out.series[name] = MetricSink._stats(arr);
    for (const [name, v] of this.counters) out.counters[name] = round(v);
    return out;
  }
}
