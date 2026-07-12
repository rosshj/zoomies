import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { attribute, color as tslColor, float, mix, smoothstep, time, positionWorld, normalView, positionViewDirection } from "three/tsl";
import { biomeBarrierStyle, biomeNameAt, biomeRoadStyle, biomeRoadStyleBlend, setBiomeLayout, setHeightSampler, planBiomeWedges } from "./scenery.js";
import { planFeatures } from "./features.js";
import { rand, makeRng } from "./rng.js";

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v ?? 0.5));

// The original hand-authored circuit, kept as the "classic" preset. Triples are
// [x, z, y] (y is elevation), mapped to Vector3(x, y, z) at build time.
const CLASSIC_POINTS = [
  [0, -430, 0], [120, -400, 4], [210, -330, 14], [180, -250, 22], [250, -160, 30],
  [310, -40, 38], [270, 80, 32], [320, 200, 22], [280, 330, 12], [180, 420, 5],
  [80, 400, 6], [55, 300, 12], [-45, 300, 14], [-70, 400, 8], [-170, 430, 4],
  [-280, 350, 28], [-310, 200, 58], [-250, 90, 78], [-300, -40, 84], [-250, -160, 58],
  [-280, -290, 28], [-180, -370, 8], [-70, -400, 3],
];

// Procedurally generate a closed loop of control points from a few knobs. Built
// in POLAR coordinates (one radius per monotonically-increasing angle), which
// guarantees the loop never crosses itself — the worst pitfall in track gen.
//   size:      overall scale of the circuit (length)
//   curviness: how wiggly / how many corners (radius variance + point count)
//   hilliness: elevation amplitude (flat -> mountainous)
// Randomness (the loop's specific "personality") comes from the seeded `rand()`
// stream, so the same world seed reproduces the same track.
// Weighted sum of sine harmonics at angle `a`, normalized to ~[-1, 1]. `list` is
// [{k, w}]; one seeded phase per harmonic in `phases`.
function harmSum(list, a, phases) {
  let s = 0;
  let wsum = 0;
  for (let j = 0; j < list.length; j++) {
    s += list[j].w * Math.sin(list[j].k * a + phases[j]);
    wsum += list[j].w;
  }
  return wsum > 0 ? s / wsum : 0;
}

// Does the closed Catmull-Rom through `pts` (XZ plane) avoid crossing itself AND
// keep every corner above `minR`? A pure radius-per-angle loop can't fold or
// snake, so we let the points snake sideways and just validate the result.
function _loopOK(pts, minR, xover = null) {
  const cv = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
  const S = 260;
  const P = [];
  for (let i = 0; i < S; i++) P.push(cv.getPointAt(i / S));
  // Segment intersection with parameters, so a hit can be judged: a plan-view
  // crossing is fatal UNLESS this is a crossover map and the two strands pass
  // with (near) full deck clearance — then exactly ONE such crossing is legal.
  const xseg = (a, b, c, d) => {
    const rX = b.x - a.x, rZ = b.z - a.z, sX = d.x - c.x, sZ = d.z - c.z;
    const den = rX * sZ - rZ * sX;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c.x - a.x) * sZ - (c.z - a.z) * sX) / den;
    const u = ((c.x - a.x) * rZ - (c.z - a.z) * rX) / den;
    return t > 0 && t < 1 && u > 0 && u < 1 ? { t, u } : null;
  };
  const xings = [];
  const wantX = xover ? xover.m : 0;
  for (let i = 0; i < S; i++) {
    for (let j = i + 2; j < S; j++) {
      if (i === 0 && j === S - 1) continue;
      const hit = xseg(P[i], P[(i + 1) % S], P[j], P[(j + 1) % S]);
      if (!hit) continue;
      if (xings.length >= wantX) return false; // unsanctioned / one too many
      const y1 = P[i].y + (P[(i + 1) % S].y - P[i].y) * hit.t;
      const y2 = P[j].y + (P[(j + 1) % S].y - P[j].y) * hit.u;
      if (Math.abs(y1 - y2) < xover.clear - 2.5) return false; // too flat to bridge
      xings.push({ x: P[i].x + (P[(i + 1) % S].x - P[i].x) * hit.t, z: P[i].z + (P[(i + 1) % S].z - P[i].z) * hit.t });
    }
  }
  if (xings.length !== wantX) return false; // crossings promised but the shape lost one
  // Curvature + separation are validated on a FINER sampling. The coarse
  // 260-sample chords above smoothed over needle-tip hairpins — a true
  // radius-5 tip read as ~25 through 10u-spaced samples, passed validation,
  // and folded the 30-wide road over itself at the tip (the reported "sharp
  // turn where the track folds over and you can drive off").
  // 1000 matches the density the built track is sampled at — the biome-rhythm
  // envelope packs wiggles tighter than the old generator, and 520 samples
  // under-measured needle corners that the built road then exposed.
  const F = 1000;
  const Q = [];
  for (let i = 0; i < F; i++) Q.push(cv.getPointAt(i / F));
  // Grade is a hard invariant too: the limiter enforces it by construction,
  // but any pin-conflict corner case that slips through must NOT ship a
  // 40-degree wall — reject and let the next attempt re-roll.
  for (let i = 0; i < F; i++) {
    const a = Q[i], b = Q[(i + 1) % F];
    if (Math.abs(b.y - a.y) > Math.hypot(b.x - a.x, b.z - a.z) * 0.48) return false;
  }
  for (let i = 0; i < F; i++) {
    const p0 = Q[(i - 2 + F) % F], p1 = Q[i], p2 = Q[(i + 2) % F];
    const a = Math.hypot(p0.x - p1.x, p0.z - p1.z);
    const b = Math.hypot(p1.x - p2.x, p1.z - p2.z);
    const c = Math.hypot(p0.x - p2.x, p0.z - p2.z);
    const area = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z)) / 2;
    if (area > 1e-3 && (a * b * c) / (4 * area) < minR) return false;
  }
  // No NEAR-folds either: two stretches whose centrelines come within MIN_SEP
  // read as one folded corridor (and much closer they'd overlap tarmac — a
  // kart on the seam projects onto whichever pass is nearer and can hop off
  // the track). Pairs closer than SEP_ARC along the lap are exempt: that's a
  // legal hairpin's own legs. Lab-tuned across 360 knob/seed combos: accepts
  // at full strength everywhere while keeping every distant pass 80u+ apart
  // on the built curve.
  const MIN_SEP = 64;
  const SEP_ARC = 170;
  // STACKED passes are legal when clearly separated in HEIGHT — a climbing
  // stretch shouldering past a low one. 38u+ apart in plan with 9u+ of height
  // between them can't interfere: containment keeps a kart within ~13u of its
  // own centreline, so the nearest arm is always its own, and the terrain
  // builder renders the gap as a terrace face. Tighter or flatter is a fold.
  const SEP_TIGHT = 38;
  const SEP_DY = 9;
  const win = Math.max(4, Math.ceil((SEP_ARC / cv.getLength()) * F));
  // Separation scans every OTHER sample (~5u steps, same coverage as the old
  // 520-sample scan) so doubling F for the corner check doesn't quadruple the
  // O(F^2) pair walk.
  for (let i = 0; i < F; i += 2) {
    for (let j = i + win; j < F; j += 2) {
      if (F - (j - i) < win) continue; // wrap-adjacent neighbours
      const dx = Q[i].x - Q[j].x;
      const dz = Q[i].z - Q[j].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < MIN_SEP * MIN_SEP) {
        // Around a sanctioned crossing the strands legitimately share plan
        // space: right down to d=0 with deck clearance, and — the double-
        // crossing interchange — two same-level strands running parallel at
        // barrier distance (38u+, containment never lets karts meet).
        // Everywhere else the stacked-pass rule applies untouched.
        if (xings.length && (Math.abs(Q[i].y - Q[j].y) >= 8 || d2 >= SEP_TIGHT * SEP_TIGHT)) {
          // The 3-loop family's crossings sit close enough that the corridor
          // BETWEEN adjacent loops needs the same grace as the crossings.
          const xr = wantX >= 3 ? 150 : 100;
          let nearX = false;
          for (const xg of xings) {
            const ex = Q[i].x - xg.x, ez = Q[i].z - xg.z;
            if (ex * ex + ez * ez < xr * xr) { nearX = true; break; }
          }
          if (nearX) continue;
        }
        if (d2 < SEP_TIGHT * SEP_TIGHT || Math.abs(Q[i].y - Q[j].y) < SEP_DY) return false;
      }
    }
  }
  return true;
}

// `rng` defaults to the shared world stream (so the built track matches the seed),
// but the menu preview passes an isolated stream seeded from the same value to
// draw the identical shape without disturbing the world build.
// Per-biome corner RHYTHM: how technical (wiggly) each biome's stretch of road
// is. The generator scales its high-frequency harmonics by the wedge under each
// angle — city blocks read tight and busy, deserts open into long fast sweeps —
// so crossing a biome border changes how the road DRIVES, not just how it looks.
const BIOME_RHYTHM = {
  city: 1.0, forest: 0.8, autumn: 0.65, blossom: 0.6, alpine: 0.6,
  meadow: 0.5, tundra: 0.45, beach: 0.35, savanna: 0.3, desert: 0.18,
};
// The summit: a per-seed mountain in the ELEVATION PROFILE — a big Gaussian
// peak the road genuinely climbs over and dives off. Pure height change, so it
// can never break the plan-view validity the generator fights for, and it
// composes with everything downstream for free: terrain anchors to the road
// (the mountainside builds itself), alpine tunnels bore through the shoulder,
// grade physics makes the climb slow and the descent fast. Drawn from an
// isolated stream so worlds with and without a peak keep every other roll
// identical.
function planSummitPeak(cfg) {
  if (!cfg || cfg.mode !== "custom") return null;
  const size = clamp01(cfg.size);
  const elevation = clamp01(cfg.hilliness);
  const r = makeRng(String(cfg.seed || "summit") + "|summit");
  const roll = r(); // ALWAYS draw the gate roll first so param draws line up
  if (size < 0.3 || elevation < 0.25 || roll > 0.55) return null;
  return {
    ang: (0.16 + r() * 0.68) * TAU, // peak centre (kept clear of the start line)
    w: (0.1 + r() * 0.05) * TAU, // Gaussian half-width, in lap angle
    h: 40 + r() * 20 + elevation * 16 + size * 34, // summit height (size buys altitude)
  };
}

// The crossover: a TRUE self-crossing lap — the road passes over itself on a
// deck. Instead of splicing a crossing into a plain loop (fragile: every weld
// is a chance for a cusp), the whole loop is drawn from the LIMACON family
// r = k + cos(a): for k < 1 the curve has an inner loop and crosses itself
// exactly once, BY CONSTRUCTION. Transversal crossings are topologically
// stable, so the harmonic wobble (damped near the crossing) can restyle the
// lap without ever losing or doubling the crossing — the validator only has
// to confirm what the family already guarantees. Heights pin the two passages
// `clear` apart; features build the upper one as a deck.
function planCrossover(cfg) {
  if (!cfg || cfg.mode !== "custom") return null;
  const size = clamp01(cfg.size);
  const r = makeRng(String(cfg.seed || "x") + "|xover");
  const roll = r(); // gate roll first so parameter draws line up across gates
  // Crossing odds scale with map size: no room below 0.4, common by 0.7+.
  // Crossings are a headline feature: on any map big enough to fit the
  // inner loop they fire MOST of the time, and near-always on big maps.
  const p = size < 0.32 ? 0 : 0.55 + (size - 0.32) * 0.5;
  if (roll > p) return null;
  // Big maps draw the lap from parametric EPICYCLE families
  // P(t) = e^(it) + c*e^(i(kk*t + psi)):
  //   kk = +3 (co-rotating):      TWO pinch loops diving INWARD, ~600u apart
  //   kk = -2 (counter-rotating): THREE loops hanging OUTWARD off the rim
  //                               corners (the sketchbook "spiral outwards")
  // Each crossing is locally just two strands, far from the others. (A polar
  // radius function can never do this — it passes through the exact origin at
  // every sign change, funnelling all passages through one point.)
  const mRoll = r();
  let fam = null;
  if (size >= 0.82 && mRoll < 0.3) fam = { kk: -2, c: 0.82 + r() * 0.06, L: 3 };
  else if (size >= 0.72 && mRoll < 0.62) fam = { kk: 3, c: 0.56 + r() * 0.12, L: 2 };
  if (fam) {
    const rot = r() * TAU;
    // Locate the loops' self-intersections numerically; psi phases the whole
    // pinch pattern around the lap, redrawn until every passage keeps clear
    // of the start line (t=0). Deterministic per seed.
    const D = 720;
    for (let tries = 0; tries < 24; tries++) {
      const psi = r() * TAU;
      const Q = [];
      for (let i = 0; i < D; i++) {
        const t = (i / D) * TAU;
        Q.push([Math.cos(t) + fam.c * Math.cos(fam.kk * t + psi), Math.sin(t) + fam.c * Math.sin(fam.kk * t + psi)]);
      }
      const pairs = [];
      const skip = 30;
      for (let i = 0; i < D && pairs.length <= fam.L; i += 2) {
        for (let j = i + skip; j < D; j += 2) {
          if (D - (j - i) < skip) continue;
          const a = Q[i], bq = Q[(i + 2) % D], c2 = Q[j], d = Q[(j + 2) % D];
          const rX = bq[0] - a[0], rZ = bq[1] - a[1], sX = d[0] - c2[0], sZ = d[1] - c2[1];
          const den = rX * sZ - rZ * sX;
          if (Math.abs(den) < 1e-9) continue;
          const t2 = ((c2[0] - a[0]) * sZ - (c2[1] - a[1]) * sX) / den;
          const u = ((c2[0] - a[0]) * rZ - (c2[1] - a[1]) * rX) / den;
          if (t2 <= 0 || t2 >= 1 || u <= 0 || u >= 1) continue;
          const hx = a[0] + rX * t2, hz = a[1] + rZ * t2;
          if (pairs.some((q) => Math.hypot(q.x - hx, q.z - hz) < 0.08)) continue;
          let tA = ((i + 2 * t2) / D) * TAU, tB = ((j + 2 * u) / D) * TAU;
          if (tB - tA > Math.PI) { const sw = tA; tA = tB; tB = sw + TAU; } // wrapped pair
          pairs.push({ x: hx, z: hz, tA, tB });
          break;
        }
      }
      if (pairs.length !== fam.L) continue;
      const clearOfStart = pairs.every((q) => {
        const d1 = Math.abs(Math.atan2(Math.sin(q.tA), Math.cos(q.tA)));
        const d2 = Math.abs(Math.atan2(Math.sin(q.tB), Math.cos(q.tB)));
        return Math.min(d1, d2) > 0.5;
      });
      if (!clearOfStart) continue;
      let lows, ups;
      if (fam.L >= 3) {
        // The clover's passages INTERLEAVE along the lap (each petal edge
        // serves two crossings), so per-pair enter=low/exit=up conflicts with
        // itself. The trefoil is an ALTERNATING knot: flag passages up/down
        // alternately in lap order and every crossing gets one of each.
        const ps = [];
        for (const q of pairs) ps.push(q.tA % TAU, q.tB % TAU);
        ps.sort((x, y) => x - y);
        lows = ps.filter((_, i) => i % 2 === 0);
        ups = ps.filter((_, i) => i % 2 === 1);
        const flagOf = (t) => (ups.some((u) => Math.abs(u - (t % TAU)) < 1e-6) ? 1 : 0);
        if (!pairs.every((q) => flagOf(q.tA) + flagOf(q.tB) === 1)) continue; // parity broke: re-roll psi
      } else {
        lows = pairs.map((q) => q.tA);
        ups = pairs.map((q) => q.tB);
      }
      return {
        kind: "epi", m: fam.L, kk: fam.kk, c: fam.c, psi, rot,
        lows, ups,
        pinches: [...lows, ...ups], // wobble damps around every passage
        clear: 13,
      };
    }
  }
  // Single crossing: the limacon inner loop (guaranteed one transversal).
  const m = 1;
  const k = 0.44 + r() * 0.12; // inner-loop size: ~0.24-0.35x of the rim radius
  const b = 0;
  const psi = 0;
  const g = (rel) => k + Math.cos(m * rel) + b * Math.cos(rel - psi);
  // Passage angles: the signed radius factor's zeros (numeric — the b term
  // shifts them off the analytic acos). Petal arcs are where g < 0.
  const zeros = [];
  let prev = g(0);
  for (let i = 1; i <= 1440; i++) {
    const rel = (i / 1440) * TAU, v = g(rel);
    if (prev < 0 !== v < 0) zeros.push(rel - (TAU / 1440) * v / (v - prev));
    prev = v;
  }
  if (zeros.length !== 2 * m) return null; // malformed petal count: no crossing
  const norm = 1 + k + b;
  // Which passages carry the deck: for m=1 the petal's exit strand; for m=2
  // the MIDDLE two zeros (petal-1 exit + petal-2 entry) — the pairing the
  // sweep found bridges both crossings; bumping the outer pair leaves one
  // crossing between two ground-level strands.
  const ups = m === 2 ? [zeros[1], zeros[2]] : [zeros[1]];
  const lows = m === 2 ? [zeros[0], zeros[3]] : [zeros[0]];
  // The start line (a=0) must sit on positive-radius rim, clear of every
  // passage's flattened zone. Seeded rejection keeps it deterministic.
  const marg = m === 2 ? 0.5 : 0.75;
  let phi = 0;
  for (let t = 0; t < 32; t++) {
    phi = r() * TAU;
    const rel0 = ((-phi % TAU) + TAU) % TAU;
    if (g(rel0) / norm < 0.25) continue; // start must be on the outer rim
    let ok = true;
    for (const z of zeros) {
      const d = Math.abs(Math.atan2(Math.sin(phi + z), Math.cos(phi + z)));
      if (d < marg) { ok = false; break; }
    }
    if (ok) break;
  }
  return { kind: "lima", m, k, b, psi, phi, zeros, ups, lows, norm, clear: 13 };
}

function generateLoopPoints(cfg, rng = rand, wedges = null) {
  const size = clamp01(cfg.size);
  const curviness = clamp01(cfg.curviness);
  const elevation = clamp01(cfg.hilliness); // how high/low (amplitude)
  const hills = clamp01(cfg.hills ?? 0.5); // how MANY hills (frequency)
  const xover = planCrossover(cfg);
  // One centrepiece per lap: a crossing map skips the summit (its flattened
  // crossing zone and the peak's Gaussian would fight over the profile).
  const summit = xover ? null : planSummitPeak(cfg);

  // How many curves the loop has scales with BOTH knobs, but the corner DENSITY
  // is tied to map size: a bigger circuit has room for more (and tighter-packed)
  // curves, a small one gets fewer, gentler bends — so small maps don't pinch the
  // road into corners too sharp for the roadside scenery to fit beside.
  const detail = curviness * (0.55 + 0.45 * size); // effective high-frequency curviness
  let N = 16 + Math.round(curviness * (8 + size * 20)); // ~24 on small maps, ~44 on big
  // Parametric crossover families carry loops AND deep waist bays — through a
  // low-curviness knob's sparse control net the spline aliases the bays and
  // balloons them into spurious centre crossings. Their control budget is
  // set by the shape, not the knob.
  if (xover && xover.kind === "epi") N = Math.max(N, 30 + 8 * xover.m);
  // Rim radius: the size knob now spans a much wider world — a max-size
  // circuit is ~20% larger than before (laps well past 3500u), which also
  // buys the room that tall climbs and crossings want.
  const baseR = 250 + size * 330;
  // Hill amplitude grows with map SIZE as well as the elevation knob: a big
  // circuit has the run length to climb genuinely high at gentle grades (the
  // grade limiter enforces the "gently"), so the same knob feels like a real
  // journey on a large map instead of the same bumps stretched wider.
  const hillAmp = elevation * (120 + 260 * size);
  // Tightest centreline corner radius. The road is laid out flat across its width,
  // so a centreline radius below halfWidth (15) folds the inner edge over itself —
  // which looks especially broken where a tight corner also falls on a steep grade.
  // Keep a margin above halfWidth so the inner edge always has room (radius ~7).
  const MIN_CORNER = 22;

  // Elevation profile: number of hills scales with the Hills knob AND map size
  // (bigger maps fit more hills). 1/k weighting keeps the climbs/drops drivable
  // (the amplitude lives in the big low-frequency hill, with smaller bumps on top).
  const hillFreq = Math.max(1, Math.round((0.6 + hills * 5) * (0.6 + size * 0.7)));
  const eH = [];
  // 1/k^1.35 weighting (was 1/k): even more of the amplitude lives in the
  // single big lap-scale hill, so elevation reads as one long climb-and-
  // return with detail on top, not a series of equal rollers.
  for (let k = 1; k <= hillFreq; k++) eH.push({ k, w: 1 / Math.pow(k, 1.35) });
  const ePhase = eH.map(() => rng() * TAU);

  // Build the XZ loop with a radial wobble (lobes/bays) PLUS a smaller tangential
  // snake (the track weaves sideways for S-bends, not just outward bulges).
  // Curviness scales both. Then validate the loop is simple + drivable, rerolling
  // at FULL strength until one passes (most do); a damped pass is a rare fallback.
  // Low harmonics (overall lobe count) follow curviness; the high harmonics that
  // pack in extra wiggles follow `detail`, so they thin out on small maps.
  const rH = [
    { k: 1, w: 0.45 },
    { k: 2, w: 0.85 },
    { k: 3, w: 0.4 + curviness * 0.9 },
    { k: 4, w: detail * 1.1 },
    { k: 5, w: detail * 0.85 },
    { k: 6, w: detail * 0.6 },
    { k: 7, w: detail * 0.4 },
  ];
  const tH = [
    { k: 1, w: 0.4 },
    { k: 2, w: 0.7 + curviness * 0.2 },
    { k: 3, w: 0.5 + detail * 0.8 },
    { k: 4, w: detail * 0.95 },
    { k: 5, w: detail * 0.65 },
  ];
  // Rhythm envelope: the technicality of the wedge under angle `a`, blended
  // softly across wedge seams — EXACTLY the wedge formula scenery's warmBlend
  // uses, so the rhythm lands in the biome that motivates it.
  const rhythmAt = (a) => {
    if (!wedges || wedges.order.length < 2) return 0.5;
    const n = wedges.order.length;
    const sWedge = ((a / TAU + wedges.offset + 1) % 1) * n;
    const i0 = Math.floor(sWedge) % n;
    const frac = sWedge - Math.floor(sWedge);
    const t0 = BIOME_RHYTHM[wedges.order[i0]] ?? 0.5;
    const t1 = BIOME_RHYTHM[wedges.order[(i0 + 1) % n]] ?? 0.5;
    const bl = frac < 0.75 ? 0 : (frac - 0.75) / 0.25;
    return t0 + (t1 - t0) * bl * bl * (3 - 2 * bl);
  };
  // High-frequency harmonics (the packed-in wiggle) take the rhythm envelope;
  // the low ones (the loop's overall lobes) stay global so the silhouette holds.
  const rLo = rH.slice(0, 3), rHi = rH.slice(3);
  const tLo = tH.slice(0, 2), tHi = tH.slice(2);

  const sm01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  const wrapA = (d) => Math.atan2(Math.sin(d), Math.cos(d));
  const hillsAt = (a) => Math.max(0, hillAmp * (0.5 + 0.5 * harmSum(eH, a, ePhase)));
  // Crossover height plan: each crossing's two passages pin to a COMMON level
  // (the base profile at that pair's lower passage), the upper one lifted by
  // the deck clearance. Base hills flatten across each crossing's
  // neighbourhood so the pin ramps stay gentle and the grade limiter never
  // needs to touch a deck. Windows shrink with m (petals sit closer together).
  const xoPass = [];
  let xoW = null;
  if (xover) {
    // One pin level per crossing (each pairs its own enter/exit strands; the
    // epitrochoid's two crossings sit ~600u apart, so their pins are free to
    // follow the local base profile independently). Passage "angles" are in
    // PARAM space — for the limacon param == polar angle and the shape is
    // rotated by phi, for the epitrochoid rotation is spatial so params pass
    // through unshifted.
    const base = xover.kind === "epi" ? 0 : xover.phi;
    // Three loops leave only 2-3 free control points between adjacent pinned
    // passages — independent pin heights there are INFEASIBLE at legal grades
    // (the feasibility bounds cross and mint cliffs), so the whole interchange
    // shares one level. Two loops sit ~600u apart and keep their own.
    const shared = xover.lows.length >= 3 ? hillsAt(base + xover.lows[0]) : null;
    for (let ci = 0; ci < xover.lows.length; ci++) {
      const pin = shared ?? hillsAt(base + xover.lows[ci]);
      xoPass.push({ a: base + xover.lows[ci], pin, up: false });
      xoPass.push({ a: base + xover.ups[ci], pin, up: true });
    }
    xoW = xover.kind !== "epi"
      ? { zone: 1.35, zoneRamp: 0.75, up: 0.62, upRamp: 0.38, plateau: 0.24 }
      : xover.m >= 3
        ? { zone: 0.45, zoneRamp: 0.28, up: 0.18, upRamp: 0.1, plateau: 0.08 } // clover passages sit 0.2 rad apart
        : { zone: 0.85, zoneRamp: 0.45, up: 0.5, upRamp: 0.28, plateau: 0.22 };
  }

  let best = null, bestXo = null;
  // Attempt budget: the first 30 tries carry the biome-rhythm envelope at
  // stepping-down strength; after that the schedule matches the old
  // generator's (40 clean full-strength tries, then damped last resorts) so
  // hard seeds converge as reliably as before the envelope existed. A
  // crossover map keeps its crossing through attempt 43, then falls back to a
  // plain loop — a hard seed still always converges to SOMETHING drivable.
  for (let attempt = 0; attempt < 78; attempt++) {
    const xo = attempt < 44 ? xover : null;
    const damp = attempt < 70 ? 1 : Math.pow(0.85, attempt - 69);
    const radVar = (0.12 + curviness * 0.55 + detail * 0.18) * damp;
    const tangAmp = (curviness * 0.18 + detail * 0.2) * damp;
    const rPhase = rH.map(() => rng() * TAU);
    const tPhase = tH.map(() => rng() * TAU);
    const rPhaseHi = rPhase.slice(3), tPhaseHi = tPhase.slice(2);

    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      // desert ~0.66x wiggle … city ~1.3x — hot enough to FEEL at the wheel,
      // cool enough that loop validity stays near the old generator's rate
      // (pushing to 1.55x cratered it). Late attempts step the envelope back
      // toward uniform so hard seeds still converge to SOME valid loop.
      const envRaw = 0.6 + 0.7 * rhythmAt(a);
      const envK = attempt < 10 ? 1 : attempt < 20 ? 0.55 : attempt < 30 ? 0.25 : 0;
      const env = 1 + (envRaw - 1) * envK;
      let x, z;
      if (xo && xo.kind === "epi") {
        // Epicycle base, rotated into place. Wobble scales the whole point
        // radially from the origin and fades near every pinch so the
        // crossings stay crisp transversals.
        const R = baseR / (1 + xo.c);
        const px = (Math.cos(a) + xo.c * Math.cos(xo.kk * a + xo.psi)) * R;
        const pz = (Math.sin(a) + xo.c * Math.sin(xo.kk * a + xo.psi)) * R;
        let dmin = Infinity;
        for (const pc of xo.pinches) dmin = Math.min(dmin, Math.abs(wrapA(a - pc)));
        const envX = sm01((dmin - 0.45) / 0.4);
        // ... and fades again where the base curve dives toward the centre:
        // the 3-loop family's waist bays pass within ~0.2R of the origin, and
        // full-strength wobble there grazed them into extra flat crossings.
        const rr0 = Math.hypot(px, pz) / R;
        const envC = sm01((rr0 - 0.42) / 0.3);
        // The clover's petal TIPS are its sharpest base geometry (radius ~35u
        // before styling) — wobble there shaved them under the corner floor,
        // so it fades out over the outermost radius band on 3-loop maps.
        const envT = xo.m >= 3 ? sm01((1 + xo.c - rr0 - 0.2) / 0.45) : 1;
        const wf = xo.m >= 3 ? 0.3 : 0.4;
        const wob = 1 + radVar * wf * envX * envC * envT * (harmSum(rLo, a, rPhase) + env * harmSum(rHi, a, rPhaseHi));
        const cR = Math.cos(xo.rot), sR = Math.sin(xo.rot);
        x = (px * cR - pz * sR) * wob;
        z = (px * sR + pz * cR) * wob;
      } else {
        let r, tg;
        if (xo) {
          // Limacon base: signed radius factor sweeps negative through the
          // inner loop. Wobble fades out near the zero crossings (keeps the
          // transversal crisp) and scales with |lim| so the inner loop keeps
          // its proportions instead of inheriting rim-sized swings.
          const rel = a - xo.phi;
          const gv = xo.k + Math.cos(xo.m * rel) + xo.b * Math.cos(rel - xo.psi);
          const lim = gv / xo.norm;
          const envX = sm01((Math.abs(gv) - 0.05) / 0.35);
          const mag = Math.max(0.35, Math.abs(lim));
          r = baseR * (lim + radVar * 0.5 * envX * mag * (harmSum(rLo, a, rPhase) + env * harmSum(rHi, a, rPhaseHi)));
          tg = baseR * tangAmp * 0.5 * envX * (harmSum(tLo, a, tPhase) + env * harmSum(tHi, a, tPhaseHi));
        } else {
          r = baseR * (1 + radVar * (harmSum(rLo, a, rPhase) + env * harmSum(rHi, a, rPhaseHi)));
          tg = baseR * tangAmp * (harmSum(tLo, a, tPhase) + env * harmSum(tHi, a, tPhaseHi));
        }
        x = Math.cos(a) * r - Math.sin(a) * tg;
        z = Math.sin(a) * r + Math.cos(a) * tg;
      }
      let y = Math.max(0, hillAmp * (0.5 + 0.5 * harmSum(eH, a, ePhase)));
      // The summit peak rides on top: base hills fade near the crest (the
      // mountain doesn't need bumps on its face, and damping them keeps the
      // combined grade climbable where the Gaussian is steepest).
      if (summit) {
        const da = Math.atan2(Math.sin(a - summit.ang), Math.cos(a - summit.ang));
        const g = Math.exp(-(da * da) / (summit.w * summit.w));
        y = y * (1 - 0.55 * g) + summit.h * g;
      }
      if (xo) {
        for (const ps of xoPass) {
          const d = Math.abs(wrapA(a - ps.a));
          const uZ = sm01((xoW.zone - d) / xoW.zoneRamp); // wide flatten
          y = y * (1 - uZ) + ps.pin * uZ;
          if (ps.up) y += xo.clear * sm01((xoW.up - d) / xoW.upRamp);
        }
      }
      pts.push(new THREE.Vector3(x, y, z));
    }
    // Crossover plateau points are exact CONTRACTS (the deck build and the
    // validator's clearance check both rely on them): assign them their exact
    // pin level and mark them immovable for the limiter below. (Re-pinning
    // AFTER the limiter instead used to snap plateaus back up next to freshly
    // relaxed ramps, minting steps far steeper than the limit.)
    const TAN_MAX = 0.27;
    const pinned = xo ? new Uint8Array(N) : null;
    if (xo) {
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        for (const ps of xoPass) {
          if (Math.abs(wrapA(a - ps.a)) <= xoW.plateau) {
            pts[i].y = ps.pin + (ps.up ? xo.clear : 0);
            pinned[i] = 1;
          }
        }
      }
      // A plateau narrower than the control spacing could miss every point —
      // each passage always pins its NEAREST control point.
      for (const ps of xoPass) {
        const i0 = ((Math.round((ps.a / TAU) * N) % N) + N) % N;
        pts[i0].y = ps.pin + (ps.up ? xo.clear : 0);
        pinned[i0] = 1;
      }
      // Feasibility clamp: propagate pin-anchored height bounds around the
      // ring (Bellman-style), then squeeze free points inside them. Without
      // this the limiter below can face an UNSATISFIABLE spot — a tall hill
      // two chords from a pinned deck — and oscillate a point between "pull
      // down toward the hill" and "pull up toward the pin", leaving a cliff.
      const UB = new Float64Array(N).fill(Infinity);
      const LB = new Float64Array(N).fill(-Infinity);
      for (let i = 0; i < N; i++) if (pinned[i]) { UB[i] = LB[i] = pts[i].y; }
      const limAt = (i) => {
        const p = pts[i], q = pts[(i + 1) % N];
        return Math.hypot(q.x - p.x, q.z - p.z) * TAN_MAX;
      };
      for (let lap = 0; lap < 3; lap++) {
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N, L = limAt(i);
          if (UB[i] + L < UB[j]) UB[j] = UB[i] + L;
          if (LB[i] - L > LB[j]) LB[j] = LB[i] - L;
        }
        for (let i = N - 1; i >= 0; i--) {
          const j = (i + 1) % N, L = limAt(i);
          if (UB[j] + L < UB[i]) UB[i] = UB[j] + L;
          if (LB[j] - L > LB[i]) LB[i] = LB[j] - L;
        }
      }
      for (let i = 0; i < N; i++) {
        if (pinned[i]) continue;
        if (LB[i] > UB[i]) pts[i].y = (LB[i] + UB[i]) / 2; // conflicting pins: split the difference
        else pts[i].y = Math.max(LB[i], Math.min(UB[i], pts[i].y));
      }
    }
    // Grade limiter: hill harmonics and the summit peak can stack into climbs
    // or dives steeper than the karts are tuned for. Relax control-point
    // heights until no segment exceeds ~17deg — normally pulling the HIGH
    // side down (valleys, lake shelves and the y>=0 floor stay put; a too-
    // eager summit just gets a rounder crest), but around a pinned crossover
    // plateau the FREE side moves instead, whichever direction feasibility
    // needs. The spline overshoots the chord grade through plan-view corners
    // (run compresses while y keeps moving), so the chord cap sits well under
    // the ~24deg the built road and the kart tuning actually tolerate.
    const runLimiter = (passes) => {
      for (let pass = 0; pass < passes; pass++) {
        let changed = false;
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N;
          const p = pts[i], q = pts[j];
          const lim = Math.hypot(q.x - p.x, q.z - p.z) * TAN_MAX;
          const dy = q.y - p.y;
          if (Math.abs(dy) <= lim) continue;
          const pa = pinned && pinned[i], pb = pinned && pinned[j];
          if (pa && pb) continue; // adjacent plateau points share a level anyway
          changed = true;
          if (pa) q.y = p.y + Math.sign(dy) * lim;
          else if (pb) p.y = q.y - Math.sign(dy) * lim;
          else if (dy > 0) q.y = p.y + lim;
          else p.y = q.y + lim;
        }
        if (!changed) break;
      }
    };
    runLimiter(8);
    // De-lump: the limiter's per-chord clamps leave slope KINKS at ramp ends,
    // and through a corner the spline rings off them — the "lumpy, folded
    // hillside on a climbing turn". Two gentle rounding passes blend each
    // point toward its neighbours' mean (pinned deck plateaus stay exact),
    // then a short limiter sweep re-caps anything the rounding steepened.
    for (let pass = 0; pass < 2; pass++) {
      const y0 = pts.map((p) => p.y);
      for (let i = 0; i < N; i++) {
        if (pinned && pinned[i]) continue;
        pts[i].y = y0[i] * 0.5 + (y0[(i - 1 + N) % N] + y0[(i + 1) % N]) * 0.25;
      }
    }
    runLimiter(3);
    best = pts;
    bestXo = xo;
    if (_loopOK(pts, MIN_CORNER, xo)) {
      if (xo) pts._xover = xo;
      return pts;
    }
  }
  if (bestXo) best._xover = bestXo; // last resort: keep the deck machinery on
  return best;
}


// Centreline control points a given track config WILL produce, for the menu map
// preview — without building the world or touching the shared RNG stream. Custom
// tracks reproduce the exact shape via an isolated stream seeded from the same
// value; classic returns the hand-authored circuit.
export function previewLoopPoints(config) {
  if (!config || config.mode !== "custom") {
    return CLASSIC_POINTS.map(([x, z, y]) => new THREE.Vector3(x, y, z));
  }
  return generateLoopPoints(config, makeRng(config.seed || "preview"), planBiomeWedges(config.biomes, String(config.seed || "preview")));
}

// Cheap flat "wet sheen" shader for the forest puddles: a dark glossy patch with
// a grazing-angle (Fresnel) sky tint and a faint moving glint so it reads as
// standing water, with no extra render pass or reflection sampling. uBase is the
// dark water tone; uSky is the colour the surface brightens toward at the rim.
const PUDDLE_SHEEN_SHADER = {
  uniforms: {
    uTime: { value: 0 },
    uBase: { value: new THREE.Color(0x0c1822) },
    uSky: { value: new THREE.Color(0x9fb7c8) },
  },
  vertexShader: `
    attribute float aEdge;
    varying vec3 vWorld;
    varying float vEdge;
    void main(){
      vEdge = aEdge;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uBase;
    uniform vec3 uSky;
    varying vec3 vWorld;
    varying float vEdge;
    void main(){
      // Fresnel against the flat (upward) surface: brighter, sky-tinted at grazing angles.
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(clamp(1.0 - max(V.y, 0.0), 0.0001, 1.0), 3.0);
      // Faint moving glint so the water shimmers a little.
      float glint = 0.5 + 0.5 * sin(vWorld.x * 1.3 + vWorld.z * 1.1 + uTime * 1.6);
      vec3 col = mix(uBase, uSky, fres * 0.85) + glint * 0.04;
      float alpha = (1.0 - smoothstep(0.4, 1.0, vEdge)) * 0.9;
      gl_FragColor = vec4(col, alpha);
    }`,
};

// Bluish-white tone for the alpine road's icy patches.
const SNOW_PATCH = new THREE.Color(0xdfeaf5);
// Loose road cover the traffic sweeps off the driving lanes: snow dust and
// wind-blown sand (lerped over the asphalt, weighted by the local biome mix).
const SNOW_COVER = new THREE.Color(0xe9f1f8);
const SAND_COVER = new THREE.Color(0xd9c08b);
const _covA = new THREE.Color();
const _covB = new THREE.Color();

// Glowing cyan chevron texture for boost pads (arrows point "up" = forward).
let _chevronTex = null;
function chevronTexture() {
  if (_chevronTex) return _chevronTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0bd1e6";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let y = 6; y <= 54; y += 16) {
    ctx.beginPath();
    ctx.moveTo(12, y + 13);
    ctx.lineTo(32, y);
    ctx.lineTo(52, y + 13);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (_chevronTex = t);
}

// An irregular, organic puddle blob built flat in world XZ (y = 0; the mesh is
// lifted to the water level), centred at world (cx, cz). Triangle fan with a
// noisy radius per angle; `aEdge` is 0 at the centre and 1 at the rim for the
// soft edge fade. Multiple blobs merge into one wet-sheen decal mesh.
function puddleBlob(cx, cz, baseR, stretchZ) {
  const segs = 26;
  const pos = [cx, 0, cz];
  const edge = [0];
  const nrm = [0, 1, 0]; // flat puddle faces straight up — needed for the Fresnel sky tint (normalView)
  const ph0 = Math.random() * 6.28, ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28, ph3 = Math.random() * 6.28;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    // Several harmonics (incl. a low one) for a clearly irregular, organic outline.
    const wob = 1 + 0.28 * Math.sin(a + ph0) + 0.4 * Math.sin(a * 2 + ph1) + 0.24 * Math.sin(a * 3 + ph2) + 0.15 * Math.sin(a * 5 + ph3);
    const r = baseR * Math.max(0.4, wob);
    const wx = cx + Math.cos(a) * r;
    const wz = cz + Math.sin(a) * r * stretchZ;
    pos.push(wx, 0, wz);
    edge.push(1);
    nrm.push(0, 1, 0);
  }
  const idx = [];
  for (let i = 0; i < segs; i++) idx.push(0, 1 + i, 1 + ((i + 1) % segs));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}

// Fine grayscale noise used as the road's bump map (asphalt grain).
function noiseTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(64, 64);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 140 + Math.random() * 115;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// A closed race track built from a smooth 3D Catmull-Rom loop. The curve now
// carries elevation (y), so the road climbs and dips. Provides the road mesh,
// barrier walls, start/finish line and helpers for projecting a world position
// onto the track (lap timing, AI, containment, ground height).
export class Track {
  // `config` (optional): { mode:"custom", size, curviness, hilliness, width }.
  // Without it (or mode !== "custom") the hand-authored classic circuit is used.
  constructor(config = null) {
    this.width = config && config.width ? config.width : 30;
    this.halfWidth = this.width / 2;

    // Control points (x, y, z). Either the procedural loop from the knobs, or
    // the classic hand-authored serpentine circuit.
    // Custom tracks plan their biome wedges FIRST (isolated stream), so the
    // generator's per-biome rhythm and scenery's wedge layout agree exactly.
    const wedges = config && config.mode === "custom" ? planBiomeWedges(config.biomes, String(config.seed || "w")) : null;
    const pts =
      config && config.mode === "custom"
        ? generateLoopPoints(config, rand, wedges)
        : CLASSIC_POINTS.map(([x, z, y]) => new THREE.Vector3(x, y, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.length = this.curve.getLength();

    // Precompute samples for fast nearest-point lookups.
    this.samples = 1000;
    this._pts = [];
    this._tans = [];
    for (let i = 0; i < this.samples; i++) {
      const t = i / this.samples;
      this._pts.push(this.curve.getPointAt(t));
      this._tans.push(this.curve.getTangentAt(t));
    }

    // Point list for cheap distance/height queries used by scenery.
    this._coarse = [];
    for (let i = 0; i < this.samples; i += 2) this._coarse.push(this._pts[i]);

    // Crossover: locate the actual crossing on the BUILT samples (the plan's
    // angles only approximate where the spline put it), remember which strand
    // is the deck, and give terrain a sample list that ignores the deck window
    // — ground anchors to the LOWER road there, so the world builds a valley
    // floor for the deck to span instead of ramping terrain up to the bridge.
    this.crossovers = [];
    this._coarseGround = this._coarse;
    if (pts._xover) {
      const P = this._pts, S = this.samples;
      const skip = Math.ceil((170 / this.length) * S); // ignore arc-adjacent pairs
      for (let i = 0; i < S && this.crossovers.length < pts._xover.m; i += 2) {
        const a = P[i], b = P[(i + 2) % S];
        for (let j = i + skip; j < S; j += 2) {
          if (S - (j - i) < skip) continue;
          // one crossing per neighbourhood: skip pairs near an already-found one
          const c = P[j], d = P[(j + 2) % S];
          const rX = b.x - a.x, rZ = b.z - a.z, sX = d.x - c.x, sZ = d.z - c.z;
          const den = rX * sZ - rZ * sX;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((c.x - a.x) * sZ - (c.z - a.z) * sX) / den;
          const u = ((c.x - a.x) * rZ - (c.z - a.z) * rX) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const hx = a.x + rX * t, hz = a.z + rZ * t;
          if (this.crossovers.some((xg) => Math.hypot(xg.x - hx, xg.z - hz) < 60)) continue;
          const y1 = a.y + (b.y - a.y) * t;
          const y2 = c.y + (d.y - c.y) * u;
          this.crossovers.push({ x: hx, z: hz, iUp: y1 > y2 ? i : j, iLow: y1 > y2 ? j : i, clear: pts._xover.clear });
          break;
        }
      }
      if (this.crossovers.length) {
        const ground = [];
        for (let ci = 0; ci < this._coarse.length; ci++) {
          const si = ci * 2;
          let clearOfDecks = true;
          for (const xg of this.crossovers) {
            const d = Math.abs(si - xg.iUp);
            if (Math.min(d, S - d) * (this.length / S) <= 92) { clearOfDecks = false; break; }
          }
          if (clearOfDecks) ground.push(this._coarse[ci]);
        }
        if (ground.length > 8) this._coarseGround = ground;
      }
    }

    // Biome layout for this track: altitude-driven (alpine on the peaks, warm
    // biomes in the lows) for generated tracks; angular wedges for the classic
    // one. The height sampler lets biomeAt read the local road elevation. Set
    // BEFORE building the road so its biome styling matches the scenery.
    let eMin = Infinity;
    let eMax = -Infinity;
    for (const p of this._pts) {
      if (p.y < eMin) eMin = p.y;
      if (p.y > eMax) eMax = p.y;
    }
    this.elevMin = eMin;
    this.elevMax = eMax;
    setHeightSampler((x, z) => this.groundInfo(x, z).y);
    setBiomeLayout(config && config.biomes, {
      altitude: !!(config && config.mode === "custom"),
      elevMin: eMin,
      elevMax: eMax,
      wedges,
    });

    // Set pieces (river bridge / canyon / giant forest / overpass): planned off
    // the finished loop + biome layout, each owned by its host biome. Scenery
    // reads this to shape the terrain and dress the runs (see features.js).
    const biomeNames = this._pts.map((p) => biomeNameAt(p.x, p.z, p.y));
    this.biomeNames = biomeNames; // kept for debugging/headless tooling
    // config.features (from the editor's set-piece chips) filters which kinds
    // may spawn; null/absent means everything is allowed.
    this.features = planFeatures(this, biomeNames, rand, config && config.features);

    this.group = new THREE.Group();
    this._buildRoad();
  }

  _sideAt(i) {
    return new THREE.Vector3().crossVectors(this._tans[i], new THREE.Vector3(0, 1, 0)).normalize();
  }

  _buildRoad() {
    const div = this.samples;
    const cross = 10; // subdivisions across the road — enough to resolve the tyre lanes
    const vpr = cross + 1; // vertices per row
    const positions = [];
    const uvs = [];
    const colors = [];
    const indices = [];
    const base = new THREE.Color(0x53535b); // asphalt
    const c = new THREE.Color();

    const hash = (a, b) => {
      const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    const smooth01 = (t) => {
      t = Math.min(Math.max(t, 0), 1);
      return t * t * (3 - 2 * t);
    };

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      // The driving line wanders a touch along the lap, so the wear bands
      // snake instead of reading as two ruler-straight stripes.
      const wander = 0.03 * Math.sin(idx * 0.06) + 0.02 * Math.sin(idx * 0.017 + 2.1);
      for (let j = 0; j < vpr; j++) {
        const f = j / cross; // 0..1 across the road
        const lat = -this.halfWidth + f * this.width;
        const x = p.x + side.x * lat;
        const z = p.z + side.z * lat;
        positions.push(x, p.y + 0.02, z);
        uvs.push(f, i * 0.1);

        // How heavily driven this bit of road is: two tyre lanes (~1/3 in from
        // each edge, where the karts actually run), 1 on the lane centres and
        // fading smoothly to clean tarmac at the verges and centreline.
        const lane = Math.min(Math.abs(f - (0.32 + wander)), Math.abs(f - (0.68 + wander)));
        const wear = (1 - smooth01(lane / 0.17)) * (0.82 + 0.18 * Math.sin(idx * 0.11 + f * 3));

        // Asphalt tone: smooth patchy variation + fine grain. Worn lanes read
        // darker and more polished (traffic grinds the grain smooth).
        let shade =
          1 +
          0.07 * Math.sin(x * 0.05) * Math.cos(z * 0.045) +
          0.05 * Math.sin(x * 0.013 + z * 0.017) +
          (hash(idx, j) - 0.5) * 0.07 * (1 - 0.5 * wear);
        shade -= 0.08 * wear;

        // Biome surface: tint the asphalt and add per-biome speckle so the road
        // changes character as you lap. The tint/kind cross-fades over wide seam
        // bands (biomeRoadStyleBlend) so surfaces transition gradually instead
        // of switching at a hard line.
        const style = biomeRoadStyleBlend(x, z, p.y);
        const kSand = style.kinds.sand || 0;
        const kSnow = style.kinds.snow || 0;
        const kDamp = style.kinds.damp || 0;
        let [tr, tg, tb] = style.tint;
        // The driving lanes pull the biome tint partway back toward bare
        // asphalt — the beaten path always reads a little more "road".
        const sweep = 0.45 * wear;
        tr += (1 - tr) * sweep;
        tg += (1 - tg) * sweep;
        tb += (1 - tb) * sweep;
        const h2 = hash(idx * 1.7 + 3.1, j * 2.3 + 5.7);
        c.setRGB(base.r * tr, base.g * tg, base.b * tb).multiplyScalar(shade);
        // Low-frequency world-space clumping so cover and patches gather in
        // soft drifts instead of uniform per-vertex noise.
        const clump =
          0.5 + 0.5 * Math.sin(x * 0.16 + Math.sin(z * 0.13) * 2.2) * Math.cos(z * 0.11 + Math.sin(x * 0.09) * 1.8);
        // Loose cover blanket (snow dust / blown sand): lies across the road in
        // clumps, piles into drifts along the verges, and is swept down to bare
        // asphalt along the two driving lanes — so the heavily driven line
        // shows as dark wheel tracks through the cover.
        const loose = kSnow + kSand;
        if (loose > 0.02) {
          const edgeDrift = smooth01((0.12 - Math.min(f, 1 - f)) / 0.12);
          const cover =
            loose * (0.18 + 0.42 * clump) * (1 - 0.92 * smooth01(wear * 1.25)) + loose * 0.3 * edgeDrift;
          _covA.copy(SNOW_COVER).multiplyScalar(kSnow / loose);
          _covB.copy(SAND_COVER).multiplyScalar(kSand / loose);
          _covA.add(_covB);
          c.lerp(_covA, Math.min(cover, 0.88));
        }
        // Accent speckle, placed where it belongs: cracks concentrate IN the
        // beaten lanes (traffic breaks the surface), while ice and standing
        // water survive only OFF the driving line, in the same clumped drifts.
        if (h2 < 0.05 && kSand > 0.15) c.multiplyScalar(1 - 0.45 * kSand * (0.55 + 0.45 * wear)); // dark cracks
        if (h2 > 0.93 && kSnow > 0.15 && clump > 0.55) c.lerp(SNOW_PATCH, 0.55 * kSnow * (1 - 0.85 * wear)); // ice
        if (h2 > 0.94 && kDamp > 0.15 && clump > 0.5) c.multiplyScalar(1 - 0.3 * kDamp * (1 - 0.65 * wear)); // wet
        colors.push(c.r, c.g, c.b);
      }

      if (i < div) {
        const row = i * vpr;
        const next = (i + 1) * vpr;
        for (let j = 0; j < cross; j++) {
          indices.push(row + j, next + j, row + j + 1);
          indices.push(row + j + 1, next + j, next + j + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const bump = noiseTexture();
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(6, 6);
    bump.anisotropy = 8;
    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        bumpMap: bump,
        bumpScale: 0.25,
        // DoubleSide: the strip's triangle winding follows the loop's direction,
        // and custom-generated tracks can run CLOCKWISE — with the default
        // FrontSide the whole road was back-face culled from above on those
        // seeds (invisible road; the terrain beneath read as the "road").
        side: THREE.DoubleSide,
      })
    );
    road.receiveShadow = true;
    this.group.add(road);

    this._buildSandTrim();
    this._buildWalls();
    this._buildCenterLine();
    this._buildEdgeLines();
    this._buildBoostPads();
    this._buildPuddles();
    this._buildStartLine();
  }

  // Intentional puddles where water would actually pool: a big one in the LOWEST
  // part of the forest stretch (elongated along the road), and a few smaller ones
  // in other low spots. Odd organic shapes with a cheap flat wet-sheen shader (no
  // extra render pass). Each blob sits flush on its own local ground height.
  // Centres go in this.puddles so the main loop can splash when driven through.
  _buildPuddles() {
    this.puddles = [];
    const forest = [];
    for (let i = 0; i < this.samples; i++) {
      const p = this._pts[i];
      if (biomeRoadStyle(p.x, p.z).kind === "damp") forest.push({ i, p });
    }
    if (!forest.length) return;
    forest.sort((a, b) => a.p.y - b.p.y); // lowest first

    // A hero puddle in the lowest dip plus a few smaller ones in other low forest
    // spots. With a flat decal (no reflection plane) they can spread out: each
    // blob is lifted to its own ground height so it sits flush on the road.
    const placements = [{ cx: forest[0].p.x, cz: forest[0].p.z, gy: forest[0].p.y, baseR: 6, stretch: 1.25 }];
    for (let k = 1; k < forest.length && placements.length < 6; k++) {
      const s = forest[k];
      if (placements.some((q) => (q.cx - s.p.x) ** 2 + (q.cz - s.p.z) ** 2 < 18 * 18)) continue;
      placements.push({ cx: s.p.x, cz: s.p.z, gy: s.p.y, baseR: 2 + Math.random() * 2, stretch: 1 });
    }

    // Merge every blob into one wet-sheen decal mesh.
    const geoms = placements.map((pl) => {
      this.puddles.push({ x: pl.cx, z: pl.cz, r: pl.baseR * pl.stretch });
      const g = puddleBlob(pl.cx, pl.cz, pl.baseR, pl.stretch);
      g.translate(0, pl.gy + 0.04, 0); // sit flush on this puddle's ground
      return g;
    });
    // Wet puddles reflect the SKY (they face up), so the "reflection" is a bright
    // sky tint baked into the colour. The earlier version only showed it at
    // grazing angles via a steep fresnel — but you drive over puddles looking
    // DOWN at them, where fresnel≈0, so they read as flat dark patches (the
    // reported "no longer reflective"). Now the sky mirror shows at ALL angles
    // (a base 55% blend), brightens further toward grazing, and a moving glint
    // shimmers across it — a convincing wet mirror without the SSR pass.
    const pmat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const edge = attribute("aEdge");
    const glint = positionWorld.x.mul(1.3).add(positionWorld.z.mul(1.1)).add(time.mul(1.6)).sin().mul(0.5).add(0.5);
    // 0 looking straight down, 1 at grazing — softer power so the sky reflection
    // is strong even from the near-overhead driving view.
    const fres = normalView.dot(positionViewDirection).clamp(0, 1).oneMinus().pow(1.5);
    const skyRefl = tslColor(0x8fb2d4); // the daytime sky the puddle mirrors
    const wetDark = tslColor(0x14212c); // wet-asphalt tone seen straight down
    const sky = float(0.5).add(fres.mul(0.42)); // 50% sky top-down → ~92% at grazing
    pmat.colorNode = mix(wetDark, skyRefl, sky).add(glint.mul(0.16));
    pmat.metalnessNode = float(0); // no env/SSR to catch — the reflection is baked in colour
    pmat.roughnessNode = float(0.06); // glossy so the sun glint stays tight
    pmat.opacityNode = float(0.74).add(fres.mul(0.22)).mul(float(1).sub(smoothstep(0.4, 1.0, edge)));
    pmat.uniforms = { uTime: { value: 0 } }; // dummy: keeps the existing uTime write a no-op
    const mesh = new THREE.Mesh(mergeGeometries(geoms), pmat);
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.puddleMesh = mesh;
  }

  // Glowing chevron pads painted on the road that kick your speed when driven
  // over. Built as a short ribbon that follows the road samples so the pad lies
  // flush across pitch and curve. Records centres in this.boostPads.
  _buildBoostPads() {
    this.boostPads = [];
    const halfW = 6;
    const ringsHalf = 2; // samples each side of centre (pad ~conforms over its length)
    const mat = new THREE.MeshBasicMaterial({
      map: chevronTexture(),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide, // flat decal: stay visible regardless of winding
    });
    const div = this.samples;
    for (const t of [0.12, 0.38, 0.6, 0.85]) {
      const ci = Math.round(t * div) % div;
      const positions = [];
      const uvs = [];
      const indices = [];
      const nRings = ringsHalf * 2 + 1;
      for (let r = 0; r < nRings; r++) {
        const idx = (((ci - ringsHalf + r) % div) + div) % div;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        positions.push(
          p.x + side.x * halfW, p.y + 0.06, p.z + side.z * halfW,
          p.x - side.x * halfW, p.y + 0.06, p.z - side.z * halfW
        );
        const v = r / (nRings - 1);
        uvs.push(0, v, 1, v);
        if (r < nRings - 1) {
          const a = r * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 1; // draw over the road
      this.group.add(mesh);
      const pc = this._pts[ci];
      this.boostPads.push({ x: pc.x, z: pc.z, r: 6 });
    }
  }

  // Solid painted lines down both edges of the tarmac (just inside the verge).
  _buildEdgeLines() {
    const inset = this.halfWidth - 0.55;
    const hw = 0.22; // half-width of the painted line
    const mat = new THREE.MeshStandardMaterial({
      color: 0xece7da,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    // Both painted lines share one material — bake them into ONE mesh (one draw).
    const positions = [];
    const indices = [];
    for (const sgn of [1, -1]) {
      const base = positions.length / 3;
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        const a = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset - hw));
        const b = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset + hw));
        positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
        if (i < this.samples) {
          const k = base + i * 2;
          indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildSandTrim() {
    const div = this.samples;
    const positions = [];
    const colors = [];
    const indices = [];
    const trim = 3.2;
    const sand = new THREE.Color(0xc2a86a);
    const concrete = new THREE.Color(0x9ba2a9); // city SIDEWALK slabs
    const concreteSeam = new THREE.Color(0x878e95); // alternating slab joints
    const red = new THREE.Color(0xd83a2f);
    const white = new THREE.Color(0xf2f2f2);
    const c = new THREE.Color();
    const tanAng = (k) => {
      const t = this._tans[((k % div) + div) % div];
      return Math.atan2(t.x, t.z);
    };
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      // Local curvature: how much the heading turns over a short look-ahead. On
      // bends the verge becomes a red/white rumble kerb; straights stay sandy —
      // or, in the CITY, concrete sidewalk slabs (alternating tone = paving joints).
      let d = tanAng(idx + 10) - tanAng(idx);
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const urban = biomeRoadStyle(p.x, p.z).kind === "urban";
      if (Math.abs(d) > 0.055) c.copy(Math.floor(i / 2) % 2 === 0 ? red : white);
      else if (urban) c.copy(Math.floor(i / 3) % 2 === 0 ? concrete : concreteSeam);
      else c.copy(sand);
      const lOut = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth + trim);
      const lIn = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const rIn = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);
      const rOut = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth - trim);
      positions.push(lOut.x, lOut.y, lOut.z, lIn.x, lIn.y, lIn.z, rIn.x, rIn.y, rIn.z, rOut.x, rOut.y, rOut.z);
      for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
      if (i < div) {
        const a = i * 4;
        indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        indices.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // DoubleSide for the same reason as the road: winding follows loop direction.
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const wallH = 1.6;
    const off = this.halfWidth + 0.8; // inner face — kept where the old thin wall sat
    const ca = new THREE.Color();
    const cb = new THREE.Color();

    // Cross-section of the barrier, offset OUTWARD from the road (sOff) and UP
    // (yOff): a solid wall with a rounded top, so it reads as a chunky kerb
    // rather than a paper-thin ribbon. Swept along the spine below.
    const W = 0.85; // thickness
    const r = W / 2; // top round radius
    const shoulderY = wallH - r;
    const profile = [[0, 0]];
    const ARC = 5;
    for (let k = 0; k <= ARC; k++) {
      const a = Math.PI * (1 - k / ARC); // inner shoulder -> over the top -> outer shoulder
      profile.push([r + Math.cos(a) * r, shoulderY + Math.sin(a) * r]);
    }
    profile.push([W, 0]);
    const P = profile.length;

    // Continuous barriers (no gaps) down each side of the road. The two
    // alternating colours come from the biome the segment sits in, so the
    // fencing changes as you pass from meadow to forest to desert, etc.
    // One material for both sides (was a fresh identical material per side).
    const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
    for (const dirSign of [1, -1]) {
      const positions = [];
      const colors = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx); // horizontal lateral; outward when scaled by dirSign
        const style = biomeBarrierStyle(p.x + side.x * dirSign * off, p.z + side.z * dirSign * off);
        const c = Math.floor(i / 6) % 2 === 0 ? ca.set(style.a) : cb.set(style.b);
        for (const [sOff, yOff] of profile) {
          const d = off + sOff;
          positions.push(p.x + side.x * dirSign * d, p.y + yOff, p.z + side.z * dirSign * d);
          colors.push(c.r, c.g, c.b);
        }
        if (i < this.samples) {
          const a0 = i * P;
          const b0 = (i + 1) * P;
          for (let j = 0; j < P - 1; j++) {
            indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, wallMat);
      // The "fence flicker" was really the global shadow-map instability on WebGPU
      // (the kart shadow flickers too) — fixed at the source via the shadow bias in
      // scene.js. So the barrier casts its shadow again (restoring the grounding it
      // lost), but doesn't RECEIVE shadows: a thin double-sided wall self-shadowing
      // is an easy extra source of acne for no real visual gain.
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
    }
  }

  _buildCenterLine() {
    // The centre line only appears in the built-up town stretches and the alpine
    // (snowy) pass. A per-sample 0/1 visibility field is box-blurred so the line
    // fades in and out over distance instead of stopping abruptly.
    const div = this.samples;
    const ZONES = 6; // matches the town/farm zoning in scenery.buildRoadside
    let vis = new Float32Array(div);
    for (let i = 0; i < div; i++) {
      const kind = biomeRoadStyle(this._pts[i].x, this._pts[i].z).kind;
      const town = Math.floor((i / div) * ZONES) % 2 === 0;
      // Towns get a centre line, but never the forest ("damp") or the snowy
      // alpine pass ("snow").
      vis[i] = town && kind !== "damp" && kind !== "snow" ? 1 : 0;
    }
    const W = 7; // blur half-window; two passes give a gentle ~tens-of-units fade
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(div);
      for (let i = 0; i < div; i++) {
        let s = 0;
        for (let k = -W; k <= W; k++) s += vis[(((i + k) % div) + div) % div];
        out[i] = s / (2 * W + 1);
      }
      vis = out;
    }

    const hw = 0.24; // half-width of the line
    const positions = [];
    const alphas = [];
    const indices = [];
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      const a = new THREE.Vector3().copy(p).addScaledVector(side, -hw);
      const b = new THREE.Vector3().copy(p).addScaledVector(side, hw);
      positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
      alphas.push(vis[idx], vis[idx]);
      if (i < div) {
        const k = i * 2;
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    // Flat road overlay: normals straight up (the unlit material doesn't light,
    // but the SSR normal pre-pass samples normals from every rendered mesh).
    const nrm = new Float32Array(positions.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alphas, 1));
    geo.setIndex(indices);
    // TSL node material (WebGPU): yellow centre line whose opacity is the
    // per-vertex aAlpha fade baked above.
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.colorNode = tslColor(0xf4cf3a);
    mat.opacityNode = attribute("aAlpha");
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  _buildStartLine() {
    const p = this.curve.getPointAt(0);
    const tan = this.curve.getTangentAt(0);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();

    // Bold black/white CHECKERED LINE across the full road: one crisp
    // canvas-textured plane instead of the old 22 small cell meshes. The cells
    // are true SQUARES (~0.8u) in world space — depth/rows fixes the cell size,
    // cols derives from the road width so the pattern stays square on any track.
    {
      const depth = 3.2, rows = 4, px = 32;
      const cellSize = depth / rows;
      const cols = Math.max(2, Math.round(this.width / cellSize));
      const c = document.createElement("canvas");
      c.width = cols * px;
      c.height = rows * px;
      const ctx = c.getContext("2d");
      for (let x = 0; x < cols; x++)
        for (let y = 0; y < rows; y++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? "#101010" : "#f8f8f8";
          ctx.fillRect(x * px, y * px, px, px);
        }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter; // keep the squares razor-crisp
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(cols * cellSize, depth),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
      );
      line.position.set(p.x, p.y + 0.06, p.z);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -Math.atan2(tan.z, tan.x) + Math.PI / 2;
      this.group.add(line);
    }

    // START GATE: the same pole-and-band construction as the street banners
    // around the map (dark metal poles, top + bottom bars, a taut billowed
    // cloth) — but carrying the "ZOOMIES GP" print. Replaces the old red tube
    // arch. archApex is kept (above the banner) for the fireworks proximity gate.
    const up = new THREE.Vector3(0, 1, 0);
    const W = this.halfWidth + 3; // pole offset from centre (matches street banners)
    const pt = (s, y) => new THREE.Vector3().copy(p).addScaledVector(side, s).addScaledVector(up, y);
    const topY = 9.4, botY = 6.7; // banner band clears the karts below
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3c4047, roughness: 0.5, metalness: 0.45 });
    const barMat = new THREE.MeshStandardMaterial({ color: 0x2d3036, roughness: 0.45, metalness: 0.55 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.5, metalness: 0.3 });
    this.archApex = pt(0, topY + 0.6);
    for (const s of [-W, W]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, topY + 0.9, 10), poleMat);
      pole.position.copy(pt(s, (topY + 0.9) / 2));
      pole.castShadow = true;
      this.group.add(pole);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), capMat);
      cap.position.copy(pt(s, topY + 0.9));
      this.group.add(cap);
    }
    const yaw = Math.atan2(tan.x, tan.z);
    for (const by of [topY, botY]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, W * 2, 8), barMat);
      bar.rotation.z = Math.PI / 2;
      const grp = new THREE.Group();
      grp.add(bar);
      grp.position.copy(pt(0, by));
      grp.rotation.y = yaw;
      this.group.add(grp);
    }

    // The printed cloth: navy with a gold border, checker strips at the ends and
    // "ZOOMIES GP" lettering, with the same gentle billow as the street banners.
    {
      const bw = W * 2 - 1.4;
      const bh = topY - botY;
      const cw = 1536, ch = Math.round(cw * (bh / bw)); // canvas matches the cloth's aspect
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#1c2340";
      ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = "#ffd54f";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, cw - 10, ch - 10);
      const sq = Math.floor((ch - 24) / 3); // checker strips at both ends
      for (const x0 of [22, cw - 22 - sq * 2]) {
        for (let x = 0; x < 2; x++)
          for (let y = 0; y < 3; y++) {
            ctx.fillStyle = (x + y) % 2 === 0 ? "#f8f8f8" : "#101010";
            ctx.fillRect(x0 + x * sq, 12 + y * sq, sq, sq);
          }
      }
      // Lettering, vertically centred from MEASURED font metrics ("middle"
      // baseline sits visibly high for system fonts, which is what made the old
      // text ride above centre on the banner).
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.round(ch * 0.56)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText("ZOOMIES GP");
      const asc = m.actualBoundingBoxAscent ?? ch * 0.4;
      const desc = m.actualBoundingBoxDescent ?? 0;
      ctx.fillText("ZOOMIES GP", cw / 2, ch / 2 + (asc - desc) / 2);

      // The app-icon cat face on each side of the lettering (same shapes as
      // tools/gen-icons.mjs, drawn as paths in the icon's normalized coords).
      const face = (cx, cy, s) => {
        const X = (u) => cx + (u - 0.5) * s;
        const Y = (v) => cy + (v - 0.5) * s;
        const tri = (t, col) => {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(X(t[0]), Y(t[1]));
          ctx.lineTo(X(t[2]), Y(t[3]));
          ctx.lineTo(X(t[4]), Y(t[5]));
          ctx.closePath();
          ctx.fill();
        };
        const ell = (u, v, ru, rv, col) => {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.ellipse(X(u), Y(v), ru * s, rv * s, 0, 0, Math.PI * 2);
          ctx.fill();
        };
        tri([0.27, 0.42, 0.33, 0.1, 0.47, 0.32], "#f4a93a"); // ears
        tri([0.73, 0.42, 0.67, 0.1, 0.53, 0.32], "#f4a93a");
        ell(0.5, 0.57, 0.3, 0.29, "#f4a93a"); // head
        tri([0.32, 0.4, 0.35, 0.18, 0.43, 0.33], "#ff8fab"); // inner ears
        tri([0.68, 0.4, 0.65, 0.18, 0.57, 0.33], "#ff8fab");
        ell(0.5, 0.66, 0.16, 0.1, "#ffe7c7"); // muzzle
        ell(0.4, 0.55, 0.055, 0.08, "#9ccc65"); // eyes
        ell(0.6, 0.55, 0.055, 0.08, "#9ccc65");
        ell(0.4, 0.55, 0.02, 0.06, "#111111"); // pupils
        ell(0.6, 0.55, 0.02, 0.06, "#111111");
        tri([0.47, 0.62, 0.53, 0.62, 0.5, 0.67], "#ff6f9b"); // nose
      };
      // Face box slightly smaller than the band. The drawn face's CONTENT spans
      // v 0.10..0.86 of its box (ear tips to chin), so its visual midpoint sits
      // at v=0.48 — draw the box offset so that midpoint lands exactly on the
      // band's centreline.
      const fs = ch * 0.92;
      const gap = fs * 0.62;
      const faceY = ch / 2 + (0.5 - 0.48) * fs;
      face(cw / 2 - m.width / 2 - gap, faceY, fs);
      face(cw / 2 + m.width / 2 + gap, faceY, fs);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const geo = new THREE.PlaneGeometry(bw, bh, 24, 1);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        pos.setZ(v, Math.sin((pos.getX(v) / bw) * Math.PI * 3) * 0.22); // gentle billow
      }
      geo.computeVertexNormals();
      const banner = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide })
      );
      // Front face toward -tangent: karts ALWAYS approach the line from the grid
      // side (the lap loops back around), so that's the side the text must read on.
      banner.position.copy(pt(0, (topY + botY) / 2));
      banner.rotation.y = yaw + Math.PI;
      banner.castShadow = true;
      this.group.add(banner);
    }

    // START LIGHTS: a small 3-lamp panel (red / amber / green) hanging under
    // the banner's bottom bar, driven by setStartLight() from the race
    // countdown. The lamp meshes are stored (not their materials) because
    // toonify() swaps material instances post-build — mesh.material stays live.
    {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.95, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.6 })
      );
      panel.position.copy(pt(0, 6.1));
      panel.rotation.y = yaw;
      panel.castShadow = true;
      this.group.add(panel);
      this._lamps = {};
      const lampDefs = [
        ["red", 0xe53935, -0.8],
        ["amber", 0xffb300, 0],
        ["green", 0x2ecc55, 0.8],
      ];
      for (const [key, col, s] of lampDefs) {
        // Built UNLIT: a dark lens (like a real traffic light that's off) —
        // setStartLight() swaps in the full lens colour + a strong emissive when
        // the lamp is live, so the active light clearly GLOWS while the others
        // read as off, instead of three permanently-coloured dots.
        const lamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0x23262b, emissive: col, emissiveIntensity: 0, roughness: 0.4 })
        );
        lamp.position.copy(pt(s, 6.1));
        lamp.userData.lensCol = col;
        this.group.add(lamp);
        this._lamps[key] = lamp;
      }
    }

    // FIREWORK MORTAR POTS flanking the arch on the verge — the finish
    // celebration launches from these two (see updateFireworks in main.js)
    // instead of popping out of the arch itself.
    this.fwLaunchers = [];
    const potBodyMat = new THREE.MeshStandardMaterial({ color: 0xb3402e, roughness: 0.7 });
    const potRimMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.5, metalness: 0.3 });
    for (const s of [-(W + 2.4), W + 2.4]) {
      const base = pt(s, 0);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, 1.5, 10), potBodyMat);
      pot.position.copy(pt(s, 0.75));
      pot.castShadow = true;
      this.group.add(pot);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.16, 10), potRimMat);
      rim.position.copy(pt(s, 1.5));
      this.group.add(rim);
      const mouth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.06, 10),
        new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 1 })
      );
      mouth.position.copy(pt(s, 1.56));
      this.group.add(mouth);
      this.fwLaunchers.push(new THREE.Vector3(base.x, base.y + 1.6, base.z));
    }
  }

  // Drive the start-light panel: "off" | "red" | "amber" | "green". The live
  // lamp gets its lens colour + a strong emissive (bright enough to bloom) and
  // pops slightly larger; the rest go dark like unlit traffic-light lenses.
  // Writes go through mesh.material (toonify replaces the instances post-build).
  setStartLight(stage) {
    if (!this._lamps) return;
    for (const key of ["red", "amber", "green"]) {
      const lamp = this._lamps[key];
      const m = lamp.material;
      const on = stage === key;
      if (m && m.color) m.color.setHex(on ? lamp.userData.lensCol : 0x23262b);
      // Red runs a touch lower: at full 3.4 tone mapping blows saturated red
      // toward orange, which made it read like a second amber.
      if (m && m.emissiveIntensity !== undefined) m.emissiveIntensity = on ? (key === "red" ? 2.4 : 3.4) : 0;
      lamp.scale.setScalar(on ? 1.25 : 1);
    }
  }

  // `target` (optional) is written and returned instead of allocating — the AI
  // drivers call these several times per kart per frame.
  getPointAt(t, target) {
    return this.curve.getPointAt(((t % 1) + 1) % 1, target);
  }

  getTangentAt(t, target) {
    return this.curve.getTangentAt(((t % 1) + 1) % 1, target);
  }

  // Closest point on the polyline `pts` to (x,z), interpolated *along* the
  // nearest segment so the result (especially height) is continuous — no
  // stair-stepping as you cross sample boundaries.
  // When `py` is given, sample selection weighs height difference too (dy
  // doubled) — on a crossover map two strands share plan space at the
  // crossing, and only the kart's own height says which road it is on. The
  // deck clearance (13u → 26u weighted) dwarfs any wheel-contact wobble, so
  // karts, wheels probes and lap progress all stay glued to their own strand.
  _projectArr(pts, x, z, py) {
    const N = pts.length;
    let best = 0;
    let bestD = Infinity;
    const useY = py !== undefined;
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x;
      const dz = pts[i].z - z;
      let d = dx * dx + dz * dz;
      if (useY) {
        const dy = pts[i].y - py;
        d += dy * dy * 4;
      }
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let rDist = Infinity;
    let ry = pts[best].y;
    let ri = best;
    let ru = 0;
    let cx = pts[best].x;
    let cz = pts[best].z;
    for (const di of [-1, 0]) {
      const a = (best + di + N) % N;
      const b = (a + 1) % N;
      const ax = pts[a].x;
      const az = pts[a].z;
      const ex = pts[b].x - ax;
      const ez = pts[b].z - az;
      const len2 = ex * ex + ez * ez || 1;
      let u = ((x - ax) * ex + (z - az) * ez) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = ax + ex * u;
      const pz = az + ez * u;
      const dx = x - px;
      const dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < rDist) {
        rDist = d;
        ry = pts[a].y + (pts[b].y - pts[a].y) * u;
        ri = a;
        ru = u;
        cx = px;
        cz = pz;
      }
    }
    return { dist: Math.sqrt(rDist), y: ry, i: ri, u: ru, cx, cz };
  }

  // Projection onto the centerline with an interpolated ground height:
  // { t, point, tangent, side, lateral, distance, groundY }.
  // Road height near (x,z) as seen from height y — strand-aware, for the
  // chase camera's above-road clamp (2D-nearest picks the deck overhead when
  // strands stack; this picks the strand the kart is actually on).
  groundYNear(x, z, y) {
    return this._projectArr(this._pts, x, z, y).y;
  }

  project(pos) {
    const r = this._projectArr(this._pts, pos.x, pos.z, pos.y);
    const t = (r.i + r.u) / this.samples;
    const point = new THREE.Vector3(r.cx, r.y, r.cz);
    const tangent = this._tans[r.i];
    const side = this._sideAt(r.i);
    const lateral = (pos.x - r.cx) * side.x + (pos.z - r.cz) * side.z;
    return { t, point, tangent, side, lateral, distance: r.dist, groundY: r.y };
  }

  // Nearest XZ distance + interpolated height (coarse, for scenery).
  groundInfo(x, z) {
    const r = this._projectArr(this._coarse, x, z);
    return { dist: r.dist, y: r.y };
  }

  // Terrain-anchoring variant: on crossover maps the deck window's samples
  // are excluded, so ground under the bridge follows the LOWER road. Distance
  // queries (prop placement, road-avoidance) keep the full list via groundInfo.
  // Where TWO arc-separated strands share plan space at different heights
  // (stacked passes, a low road under a mountainside approach), snapping to
  // the nearest strand minted vertical terrace WALLS with baked tree shadows
  // smeared down them — instead, blend toward the second strand as the point
  // approaches equidistance, so the gap becomes a hillside.
  groundInfoTerrain(x, z) {
    const r = this._projectArr(this._coarseGround, x, z);
    const pts = this._coarseGround;
    const n = pts.length;
    const win = Math.max(6, Math.ceil(((170 / this.length) * this.samples) / 2)); // arc window, in coarse indices
    let d2 = Infinity, y2 = r.y;
    for (let i = 0; i < n; i++) {
      const ad = Math.abs(i - r.i);
      if (Math.min(ad, n - ad) <= win) continue; // same strand as the winner
      const dx = pts[i].x - x, dz = pts[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < d2) { d2 = d; y2 = pts[i].y; }
    }
    if (d2 < Infinity) {
      const gap = Math.sqrt(d2) - r.dist;
      if (gap < 70) {
        const w = 0.5 * (1 - gap / 70);
        return { dist: r.dist, y: r.y * (1 - w) + y2 * w };
      }
    }
    return { dist: r.dist, y: r.y };
  }

  distanceToCenter(x, z) {
    return this.groundInfo(x, z).dist;
  }

  // World position + heading for a starting grid slot (on the road surface).
  gridSlot(index) {
    const back = 8 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const tApprox = -back / this.length;
    const p = this.getPointAt(tApprox);
    const tan = this.getTangentAt(tApprox);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
    const pos = new THREE.Vector3().copy(p).addScaledVector(side, lateral);
    const heading = Math.atan2(tan.x, tan.z);
    return { position: pos, heading };
  }
}
