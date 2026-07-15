// Unit tests for the binary pose codec (src/net/posecodec.js). Pure, no browser.
// Run: `npm run check:codec`.
import { encodePosePacket, decodePosePacket } from "../src/net/posecodec.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// Half-step round-trip bounds per field (quantization error ≤ half the step).
const TOL = {
  x: 1600 / 65535 / 2 + 1e-9, z: 1600 / 65535 / 2 + 1e-9,
  y: 430 / 65535 / 2 + 1e-9, h: (2 * Math.PI) / 65535 / 2 + 1e-9,
  s: 90 / 65535 / 2 + 1e-9, pr: 10 / 65535 / 2 + 1e-9,
  p: Math.PI / 255 / 2 + 1e-9,
};
const T0 = 1_700_000_000_000; // a realistic shared-clock ms
const now0 = () => T0;

function poseNear(a, b) {
  for (const k of Object.keys(TOL)) if (Math.abs(a[k] - b[k]) > TOL[k]) return false;
  return true;
}

// --- Round-trip across the field ranges ---
{
  const cases = [
    { x: 0, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0, t: T0 },
    { x: -800, y: -10, z: 800, h: -Math.PI, p: -Math.PI / 2, s: -20, f: 15, pr: -2, t: T0 },
    { x: 800, y: 420, z: -800, h: Math.PI, p: Math.PI / 2, s: 70, f: 8, pr: 8, t: T0 },
    { x: 123.45, y: 37.2, z: -456.78, h: 1.234, p: 0.31, s: 42.5, f: 5, pr: 2.375, t: T0 },
  ];
  let ok = true;
  for (const c of cases) {
    const [dec] = decodePosePacket(encodePosePacket([c]), now0);
    if (!poseNear(dec, c)) { ok = false; console.log("   mismatch:", c, "->", dec); }
    if ((c.f & 0xFF) !== dec.f) ok = false; // flags are exact
    if (Math.round(c.t) !== dec.t) ok = false; // t is exact (integer ms)
  }
  check("round-trips every field within the half-step bound (flags + t exact)", ok);
}

// --- Clamp / saturation: out-of-range saturates, never wraps ---
{
  const [d] = decodePosePacket(encodePosePacket([{ x: 5000, y: 9999, z: -5000, h: 10, p: 5, s: 200, f: 0, pr: 50, t: T0 }]), now0);
  check("over-range saturates at the max edge (no wrap)", Math.abs(d.x - 800) < TOL.x && Math.abs(d.s - 70) < TOL.s && Math.abs(d.pr - 8) < TOL.pr);
  check("under-range saturates at the min edge (no wrap)", Math.abs(d.z - (-800)) < TOL.z);
}

// --- Packet sizes + count ---
{
  const p = (t) => ({ x: 1, y: 2, z: 3, h: 0.1, p: 0.05, s: 20, f: 1, pr: 0.5, t });
  check("1-pose packet is 18 bytes", encodePosePacket([p(T0)]).byteLength === 18);
  check("3-pose packet is 50 bytes", encodePosePacket([p(T0), p(T0 - 33), p(T0 - 66)]).byteLength === 50);
  check("history > 3 truncates to 3 (50 bytes)", encodePosePacket([p(T0), p(T0 - 33), p(T0 - 66), p(T0 - 99)]).byteLength === 50);
  check("count round-trips", decodePosePacket(encodePosePacket([p(T0), p(T0 - 33)]), now0).length === 2);
}

// --- FEC packet decodes to ASCENDING t (so pushSnapshot accepts the redundancy) ---
{
  const p = (t, x) => ({ x, y: 0, z: 0, h: 0, p: 0, s: 30, f: 0, pr: 0, t });
  const out = decodePosePacket(encodePosePacket([p(T0, 3), p(T0 - 33, 2), p(T0 - 66, 1)]), now0);
  const ascending = out.every((v, i) => i === 0 || v.t > out[i - 1].t);
  check("decode returns poses ascending in t (FEC-safe order)", ascending && out.length === 3);
  check("newest pose is last, x preserved", Math.abs(out[2].x - 3) < TOL.x && out[2].t === T0);
  check("older poses reconstruct via tdelta", out[0].t === T0 - 66 && out[1].t === T0 - 33);
}

// --- t low-24 reconstruction under clock skew + the 2^24 wrap boundary ---
{
  const PERIOD = 0x1000000;
  const enc = encodePosePacket([{ x: 0, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0, t: T0 }]);
  for (const skew of [0, 30_000, -30_000, 3_600_000, -3_600_000, 7_200_000, -7_200_000]) {
    const [d] = decodePosePacket(enc, () => T0 + skew);
    if (d.t !== T0) { check(`t recovers exactly under ${skew / 1000}s skew`, false); continue; }
    check(`t recovers exactly under ${skew / 1000}s skew`, true);
  }
  // Wrap boundary: t24 sits just above a 2^24 multiple, the anchor just below it.
  const k = Math.floor(T0 / PERIOD);
  const Tb = k * PERIOD + 3; // t24 = 3, just past the boundary
  const encB = encodePosePacket([{ x: 0, y: 0, z: 0, h: 0, p: 0, s: 0, f: 0, pr: 0, t: Tb }]);
  const [db] = decodePosePacket(encB, () => Tb - 10); // anchor 10ms below the boundary
  check("t reconstructs across a 2^24 wrap boundary", db.t === Tb);
}

if (failures) { console.log(`\n${failures} codec check(s) FAILED`); process.exit(1); }
console.log("\nall codec checks passed");
