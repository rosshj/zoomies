// Entity interpolation — the heart of how remote karts move smoothly.
//
// Remote karts are drawn ~100ms in the PAST and interpolated between the two
// network snapshots that bracket that render time. This turns choppy 15–20 Hz
// packets into buttery motion. When the buffer runs dry (a packet is late), we
// EXTRAPOLATE (dead-reckon) from the newest snapshot using its heading + speed,
// capped so a long gap can't fling the kart across the map. Because karts move
// predictably, this is nearly invisible — it's the core latency-hiding trick.
//
// Everything here is pure (no THREE, no DOM) so it can be unit-tested in node.

// Shortest-arc interpolation between two angles (radians).
export function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

const lerp = (a, b, f) => a + (b - a) * f;

// A snapshot is { t, x, y, z, h, p, s } in world units; t is in the shared
// (server-synced) clock, h = heading, p = pitch, s = signed speed.
//
// `buffer` must be sorted ascending by t. Returns the pose to render at time
// `rt`, or null if there's nothing to show yet. `maxExtrapMs` caps how far we
// dead-reckon past the newest snapshot.
export function sampleBuffer(buffer, rt, maxExtrapMs = 250) {
  const n = buffer.length;
  if (n === 0) return null;
  if (n === 1) return { ...buffer[0], extrapolated: false };

  const first = buffer[0];
  const last = buffer[n - 1];

  // Before our oldest sample (just joined / stalled): hold the oldest pose.
  if (rt <= first.t) return { ...first, extrapolated: false };

  // After our newest sample: dead-reckon forward, capped. `f` carries the last
  // snapshot's flags (drift/boost/shield) so the ghost keeps its visual state.
  if (rt >= last.t) {
    const dt = Math.min(rt - last.t, maxExtrapMs) / 1000; // seconds, capped
    return {
      x: last.x + Math.sin(last.h) * last.s * dt,
      y: last.y,
      z: last.z + Math.cos(last.h) * last.s * dt,
      h: last.h,
      p: last.p,
      s: last.s,
      f: last.f,
      t: rt,
      extrapolated: true,
    };
  }

  // Find the pair (a, b) with a.t <= rt <= b.t and interpolate. Position uses
  // CUBIC HERMITE with each snapshot's velocity as the tangent, so at 16 Hz the
  // path curves through corners instead of cutting them in straight chords (what
  // linear lerp did). Velocity is V = (sin h, cos h) * s — the same model the
  // dead-reckon branch above assumes — scaled to the Hermite parameter u∈[0,1]
  // by the span in seconds (dP/du = dP/dt * span_sec).
  for (let i = 0; i < n - 1; i++) {
    const a = buffer[i];
    const b = buffer[i + 1];
    if (rt >= a.t && rt <= b.t) {
      const span = b.t - a.t || 1;
      const u = (rt - a.t) / span;
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
        y: lerp(a.y, b.y, u), // y has no velocity channel → linear
        z: h00 * a.z + h10 * maZ + h01 * b.z + h11 * mbZ,
        h: lerpAngle(a.h, b.h, u), // heading is authoritative facing (drift), not tangent
        p: lerpAngle(a.p, b.p, u),
        s: lerp(a.s, b.s, u),
        f: u < 0.5 ? a.f : b.f, // nearest snapshot's flags
        t: rt,
        extrapolated: false,
      };
    }
  }
  return { ...last, extrapolated: false }; // unreachable, defensive
}

// Insert a snapshot keeping the buffer sorted by t, dropping anything older
// than `keepMs` before the newest (we never need deep history) and duplicates.
export function pushSnapshot(buffer, snap, keepMs = 1000) {
  // Reject out-of-order / duplicate timestamps (last writer for a given t wins).
  if (buffer.length && snap.t <= buffer[buffer.length - 1].t) {
    // Late/reordered packet: only keep it if it's newer than our newest.
    return buffer;
  }
  buffer.push(snap);
  const cutoff = snap.t - keepMs;
  while (buffer.length > 2 && buffer[0].t < cutoff) buffer.shift();
  return buffer;
}
