// Binary pose codec for the WebRTC P2P channel. Encodes a compact quantized
// PACKET of poses — the current pose plus up to two previous (piggyback FEC), so
// a single dropped datagram is recovered from the next packet's redundancy. On
// the wire the packet carries neither sender id nor message type: the data
// channel is always the "state" stream and its peer is known (see webrtc.js
// wire()), so the receiver stamps those in.
//
// Only used on the real WebRTC data channel (and its net-check mock); the Ably
// fallback and the loopback keep plain JSON objects. Pure + headless-testable.
//
// Layout (little-endian):
//   [count u8]
//   newest pose (17 B): x z y h s pr (u16×6)  p f (u8×2)  t24 (3 B, low 24 bits of t)
//   older  pose (16 B): x z y h s pr (u16×6)  p f (u8×2)  tdelta (u16, ms behind newest)
//   ... (count-1) older poses, on the wire in DESCENDING t (newest-first order)
// 1 pose = 18 B; a 3-pose FEC packet = 50 B — smaller than one ~150 B JSON pose,
// with 3× redundancy.

// Quantization ranges (see the Stage 2b plan for the verified value envelopes).
const X_MIN = -800, X_MAX = 800;   // track XZ extent (both track types) with margin
const Y_MIN = -10, Y_MAX = 420;    // ABSOLUTE world elevation, not hop height
const H_MIN = -Math.PI, H_MAX = Math.PI;
const S_MIN = -20, S_MAX = 70;     // signed speed (reverse .. boosted)
const PR_MIN = -2, PR_MAX = 8;     // totalProgress = lap+fraction (TOTAL_LAPS ≤ 5)
const P_MIN = -Math.PI / 2, P_MAX = Math.PI / 2; // road-grade pitch (8-bit is plenty)

const PERIOD = 0x1000000; // 2^24 ms ≈ 4.66 h — the timestamp wrap window
const MAX_POSES = 3;

// Clamp BEFORE quantizing so an out-of-range value saturates at the edge instead
// of wrapping to a wildly wrong number (a wrapped s/y would teleport a ghost).
function q16(v, min, max) {
  const c = v < min ? min : v > max ? max : v;
  return Math.round(((c - min) / (max - min)) * 65535);
}
function dq16(u, min, max) { return min + (u / 65535) * (max - min); }
function q8(v, min, max) {
  const c = v < min ? min : v > max ? max : v;
  return Math.round(((c - min) / (max - min)) * 255);
}
function dq8(u, min, max) { return min + (u / 255) * (max - min); }

function writePoseFields(dv, o, p) {
  dv.setUint16(o, q16(p.x, X_MIN, X_MAX), true); o += 2;
  dv.setUint16(o, q16(p.z, X_MIN, X_MAX), true); o += 2;
  dv.setUint16(o, q16(p.y, Y_MIN, Y_MAX), true); o += 2;
  dv.setUint16(o, q16(p.h, H_MIN, H_MAX), true); o += 2;
  dv.setUint16(o, q16(p.s, S_MIN, S_MAX), true); o += 2;
  dv.setUint16(o, q16(p.pr, PR_MIN, PR_MAX), true); o += 2;
  dv.setUint8(o, q8(p.p, P_MIN, P_MAX)); o += 1;
  dv.setUint8(o, (p.f | 0) & 0xFF); o += 1;
  return o; // advanced by 14
}
function readPoseFields(dv, o) {
  return {
    x: dq16(dv.getUint16(o, true), X_MIN, X_MAX),
    z: dq16(dv.getUint16(o + 2, true), X_MIN, X_MAX),
    y: dq16(dv.getUint16(o + 4, true), Y_MIN, Y_MAX),
    h: dq16(dv.getUint16(o + 6, true), H_MIN, H_MAX),
    s: dq16(dv.getUint16(o + 8, true), S_MIN, S_MAX),
    pr: dq16(dv.getUint16(o + 10, true), PR_MIN, PR_MAX),
    p: dq8(dv.getUint8(o + 12), P_MIN, P_MAX),
    f: dv.getUint8(o + 13),
  };
}

// Encode a packet. `poses` is NEWEST-FIRST (poses[0] is the current pose); up to
// MAX_POSES are included as redundancy. Returns a Uint8Array.
export function encodePosePacket(poses) {
  const count = Math.min(poses.length, MAX_POSES);
  const buf = new ArrayBuffer(1 + 17 + 16 * (count - 1));
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, count); o += 1;

  const newestT = Math.round(poses[0].t);
  o = writePoseFields(dv, o, poses[0]);
  const t24 = ((newestT % PERIOD) + PERIOD) % PERIOD; // low 24 bits (arithmetic — t > 2^32)
  dv.setUint16(o, t24 & 0xFFFF, true); o += 2;
  dv.setUint8(o, (t24 >>> 16) & 0xFF); o += 1;

  for (let i = 1; i < count; i++) {
    o = writePoseFields(dv, o, poses[i]);
    let d = newestT - Math.round(poses[i].t);
    if (d < 0) d = 0; else if (d > 65535) d = 65535;
    dv.setUint16(o, d, true); o += 2;
  }
  return new Uint8Array(buf);
}

// Decode a packet. `now` anchors the timestamp reconstruction (shared-clock ms;
// the transport passes Date.now — see the plan for why that recovers the exact
// shared-clock t for any device within ~2.33 h of the shared clock). Returns
// poses in ASCENDING t — REQUIRED, so pushSnapshot's monotonic guard accepts the
// piggybacked older poses (feeding newest-first would drop them and kill FEC).
export function decodePosePacket(buf, now = Date.now) {
  let ab, off, len;
  if (buf instanceof ArrayBuffer) { ab = buf; off = 0; len = buf.byteLength; }
  else { ab = buf.buffer; off = buf.byteOffset || 0; len = buf.byteLength; } // Uint8Array/DataView
  const dv = new DataView(ab, off, len);

  const count = dv.getUint8(0);
  let o = 1;

  const newest = readPoseFields(dv, o); o += 14;
  const t24 = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16); o += 3;
  const nowV = now();
  const base = Math.floor(nowV / PERIOD) * PERIOD; // high bits via arithmetic (nowV > 2^32)
  let nt = base + t24;
  if (nt > nowV + PERIOD / 2) nt -= PERIOD;
  else if (nt < nowV - PERIOD / 2) nt += PERIOD;
  newest.t = nt;

  const older = [];
  for (let i = 1; i < count; i++) {
    const p = readPoseFields(dv, o); o += 14;
    const d = dv.getUint16(o, true); o += 2;
    p.t = nt - d;
    older.push(p); // built 2nd-newest, 3rd-newest, … → descending t
  }
  older.reverse(); // → ascending t
  older.push(newest); // newest last
  return older;
}
