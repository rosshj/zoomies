import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ---- Track set pieces -------------------------------------------------------
// Signature moments planned onto the loop. The core idea: every feature is a
// deliberate disagreement between the road and the terrain, and the structure
// that resolves it (deck + piers, rock walls, a tube through a ridge, towering
// trunks) IS the feature. The loop generates exactly as before; each feature
// then picks the arc best suited to it — owned by its host biome — and the
// terrain is shaped around that arc ("author the coincidence"). Everything
// draws from the seeded stream, so a seed reproduces its features, and every
// field blends in/out over wide bands so runs stay seamless.
//
// Kinds:
//   STRUCTURAL (terrain + kit):  bridge (over a river, which may step down a
//   waterfall), overpass (deck over a sunken city level), canyon, tunnel,
//   shelf (wall one side / drop the other), dam (reservoir high / valley low),
//   causeway (deck across a lagoon).
//   TREATMENTS (dressing only):  giant forest, flower fields, wind farm,
//   desert rock pillars, neon billboards, an elevated city rail + train.
//   AMBIENCE: ducks on the water, goats on the rims, mist among the giants,
//   fish hopping by the bridge — built with the structures, animated via the
//   update() handle buildFeatureStructures returns.
//
// Wiring:
//   - track.js:  planFeatures(track, biomeNames, rng, allowed) -> track.features
//   - scenery.js heightAt chain: featureHeightMod
//   - scenery.js makeLakes:      featureWaterEntries (river/lagoon/reservoir
//                                reuse the ribbon-lake carve + water wholesale;
//                                riverWithFalls splits the river where the land
//                                drops, making the waterfall step)
//   - scenery.js buildForests:   giantTreeBoost; buildTrees: featureTreeBlock
//   - scenery.js place()/lamps/banners: featureKeepClear / featureSpanBlock
//   - scenery.js buildWorld:     buildFeatureStructures (kits + ambience)
//   - main.js:   featureGlyphs (map icons), trackTitle (generated names)
// Gameplay is untouched: karts project onto the centreline and ride the road's
// own height. A feature only spawns when its biome appears under the loop.

const TAU = Math.PI * 2;
const smooth01 = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

// Planning priority order: single-biome structural kinds pick first, the
// many-biome bridge last (it can always find room), treatments after all
// structural kinds. halfFrac = half the run length as a fraction of the lap.
// flatW/curvW: scoring weights (decks want flat + straight; walls don't care).
// clearR: candidate arcs must keep OTHER passes of the loop this far away
// (only kinds whose WATER carve can't locally yield need it).
const KIND_SPECS = [
  { kind: "causeway", biomes: ["beach"], halfFrac: 0.026, flatW: 3.2, curvW: 150, clearR: 68 },
  { kind: "tunnel", biomes: ["alpine", "desert", "tundra"], halfFrac: 0.024, flatW: 1.4, curvW: 240 },
  { kind: "dam", biomes: ["alpine", "forest"], halfFrac: 0.024, flatW: 3.2, curvW: 170, clearR: 72 },
  { kind: "overpass", biomes: ["city"], halfFrac: 0.038, flatW: 2.6, curvW: 120 },
  { kind: "canyon", biomes: ["desert", "alpine", "tundra"], halfFrac: 0.052, flatW: 0.6, curvW: 40 },
  { kind: "shelf", biomes: ["alpine", "desert", "savanna"], halfFrac: 0.042, flatW: 0.8, curvW: 70 },
  { kind: "giant", biomes: ["forest"], halfFrac: 0.045, flatW: 0.3, curvW: 20 },
  { kind: "bridge", biomes: ["meadow", "autumn", "blossom", "savanna", "tundra", "beach", "forest"], halfFrac: 0.032, flatW: 3.0, curvW: 150, clearR: 0 },
  // Treatments (dressing only — no terrain change beyond what's above).
  { kind: "arches", biomes: ["desert"], halfFrac: 0.028, flatW: 0.5, curvW: 60 },
  { kind: "windfarm", biomes: ["savanna", "tundra", "meadow"], halfFrac: 0.038, flatW: 0.4, curvW: 30 },
  { kind: "flowers", biomes: ["meadow", "blossom"], halfFrac: 0.04, flatW: 0.4, curvW: 20 },
  { kind: "billboards", biomes: ["city"], halfFrac: 0.024, flatW: 0.8, curvW: 60 },
  { kind: "rail", biomes: ["city"], halfFrac: 0.01, flatW: 1.0, curvW: 120 },
];
const ALL_KINDS = KIND_SPECS.map((s) => s.kind);
// The editor's "Extras" chip covers the treatment kinds as one toggle.
export const FEATURE_CHIP_KINDS = ["bridge", "canyon", "tunnel", "giant", "overpass", "shelf", "dam", "causeway"];
const EXTRA_KINDS = ["arches", "windfarm", "flowers", "billboards", "rail"];

const loopDist = (a, b, N) => {
  const d = Math.abs(a - b) % N;
  return Math.min(d, N - d);
};

// Nearest-point query against a spine polyline. Reused scratch object.
const _sd = { d: Infinity, u: -1, y: 0 };
function spineDist(spine, x, z) {
  _sd.d = Infinity;
  _sd.u = -1;
  const n = spine.length;
  for (let i = 0; i < n - 1; i++) {
    const a = spine[i], b = spine[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (a.x + dx * t), pz = z - (a.z + dz * t);
    const d = px * px + pz * pz;
    if (d < _sd.d) {
      _sd.d = d;
      _sd.u = (i + t) / (n - 1);
      _sd.y = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t;
    }
  }
  _sd.d = Math.sqrt(_sd.d);
  return _sd;
}

function otherRoadDist(others, x, z) {
  let d = Infinity;
  for (let i = 0; i < others.length; i += 2) {
    const dx = others[i] - x;
    const dz = others[i + 1] - z;
    const dd = dx * dx + dz * dz;
    if (dd < d) d = dd;
  }
  return Math.sqrt(d);
}

// Run record for samples c-half..c+half: subsampled spine (with road y) plus
// `others`, a coarse list of every OTHER pass of the road so the run's fields
// can yield around folds of the loop instead of burying/sinking that road.
function makeRun(track, kind, c, half) {
  const N = track.samples;
  const spine = [];
  for (let i = c - half; i <= c + half; i += 3) {
    const p = track._pts[((i % N) + N) % N];
    spine.push({ x: p.x, z: p.z, y: p.y });
  }
  const others = [];
  const othersW = []; // wider exclusion: for the water-clearance test, the
  // road CONTINUING just past the run's ends must not count as "another pass"
  // (it is ~30u from the end spine points, which failed every candidate).
  const cc = ((c % N) + N) % N;
  for (let j = 0; j < N; j += 5) {
    const q = track._pts[j];
    if (loopDist(j, cc, N) > half + 12) others.push(q.x, q.z);
    if (loopDist(j, cc, N) > half + 44) othersW.push(q.x, q.z);
  }
  let minY = Infinity;
  for (const s of spine) if (s.y < minY) minY = s.y;
  return { kind, c, half, i0: c - half, i1: c + half, spine, others, othersW, minY, halfWidth: track.halfWidth };
}

const _up = new THREE.Vector3(0, 1, 0);
function sideAt(track, i) {
  const N = track.samples;
  return new THREE.Vector3().crossVectors(track._tans[((i % N) + N) % N], _up).normalize();
}

// Plan the map's set pieces. `allowed` (from the track editor's chips) filters
// which kinds may spawn: null/empty = everything; "extras" covers treatments.
export function planFeatures(track, biomeNames, rng, allowed = null) {
  const N = track.samples;
  const pts = track._pts;
  const tans = track._tans;
  const feats = { runs: [], river: null, waterfall: null };
  const startGuard = Math.round(0.07 * N);
  const taken = [];
  // null/undefined = everything allowed; an ARRAY is exact (so deselecting
  // every chip really does mean "no set pieces").
  const allow = Array.isArray(allowed)
    ? new Set(allowed.flatMap((k) => (k === "extras" ? EXTRA_KINDS : [k])))
    : new Set(ALL_KINDS);

  const overlapsTaken = (c, half) => {
    if (loopDist(c, 0, N) < startGuard + half) return true;
    return taken.some((t) => loopDist(c, t.c, N) < t.half + half + Math.round(0.03 * N));
  };

  for (const spec of KIND_SPECS) {
    if (!allow.has(spec.kind)) continue;
    const half = Math.round(spec.halfFrac * N);
    // Score every viable arc, then take the best that passes the (rarely
    // needed) water-clearance check — so a blocked best falls to second-best
    // instead of dropping the feature.
    const cands = [];
    for (let c = 0; c < N; c += 5) {
      if (overlapsTaken(c, half)) continue;
      let hits = 0, total = 0;
      for (let i = c - half; i <= c + half; i += 4) {
        total++;
        if (spec.biomes.includes(biomeNames[((i % N) + N) % N])) hits++;
      }
      if (hits < total * 0.86) continue;
      let mn = Infinity, mx = -Infinity, curv = 0;
      for (let i = c - half; i <= c + half; i += 2) {
        const idx = ((i % N) + N) % N;
        const y = pts[idx].y;
        if (y < mn) mn = y;
        if (y > mx) mx = y;
        const t0 = tans[idx];
        const t1 = tans[(idx + 2) % N];
        let d = Math.atan2(t1.x, t1.z) - Math.atan2(t0.x, t0.z);
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        curv += Math.abs(d);
      }
      cands.push({ c, score: (mx - mn) * spec.flatW + curv * spec.curvW + rng() * 6 });
    }
    cands.sort((a, b) => a.score - b.score);

    let run = null;
    for (const cand of cands) {
      const r = makeRun(track, spec.kind, cand.c, half);
      if (spec.clearR) {
        // Water carves can't yield locally, so the whole arc must be clear of
        // genuinely-OTHER passes (othersW exempts the run's own continuation).
        let ok = true;
        for (let i = 0; i < r.spine.length && ok; i += 2) {
          if (otherRoadDist(r.othersW, r.spine[i].x, r.spine[i].z) < spec.clearR + track.halfWidth) ok = false;
        }
        if (!ok) continue;
      }
      run = r;
      break;
    }
    if (!run) continue;

    if (spec.kind === "canyon") {
      run.mag = 23 + rng() * 9;
      run.warmRock = biomeNames[((run.c % N) + N) % N] === "desert";
    } else if (spec.kind === "tunnel") {
      run.mag = 19 + rng() * 4; // ridge over the tube (tube apex is ~15)
    } else if (spec.kind === "overpass") {
      run.depth = 7.5;
    } else if (spec.kind === "shelf") {
      run.mag = 20 + rng() * 8; // wall height (outward side)
      run.drop = 20 + rng() * 8; // drop depth (inward side)
      const cp = pts[((run.c % N) + N) % N];
      const cs = sideAt(track, run.c);
      run.inSign = cs.x * cp.x + cs.z * cp.z >= 0 ? -1 : 1; // toward the infield
      run.warmRock = biomeNames[((run.c % N) + N) % N] !== "alpine";
    } else if (spec.kind === "dam") {
      run.depth = 22 + rng() * 6; // valley sink below the deck (inward side)
      const cp = pts[((run.c % N) + N) % N];
      const cs = sideAt(track, run.c);
      run.inSign = cs.x * cp.x + cs.z * cp.z >= 0 ? -1 : 1;
      run.reservoir = makeParallelWater(track, run, -run.inSign, {
        waterR: 20, level: run.minY - 2.4, floorDrop: 6, shore: 2, blend: 10,
      });
      if (!run.reservoir) continue; // no room for the reservoir -> no dam
    } else if (spec.kind === "causeway") {
      // A wide lagoon aligned WITH the road: the deck flies over open water.
      run.lagoon = {
        ribbon: true,
        spine: run.spine.map((s, i) => {
          const j = Math.min(run.spine.length - 1, i + 1);
          const k = Math.max(0, i - 1);
          let dx = run.spine[j].x - run.spine[k].x, dz = run.spine[j].z - run.spine[k].z;
          const l = Math.hypot(dx, dz) || 1;
          return { x: s.x, z: s.z, sx: dz / l, sz: -dx / l };
        }),
        level: run.minY - 3.8,
        floor: run.minY - 3.8 - 5,
        waterR: track.halfWidth + 18,
        shoreR: track.halfWidth + 23,
        blendR: track.halfWidth + 36,
      };
    } else if (spec.kind === "flowers") {
      run.flowerHue = rng(); // poppy / lavender / sunflower per seed
    } else if (spec.kind === "rail") {
      run.rail = makeRailLine(track, run, rng);
      if (!run.rail) continue;
    } else if (spec.kind === "bridge") {
      const river = makeRiver(track, run, rng);
      if (!river) continue;
      feats.river = river;
    }
    taken.push({ c: run.c, half });
    feats.runs.push(run);
  }
  return feats;
}

// A meandering river spine perpendicular to the road at the run's centre,
// extended both ways. Arms truncate against the run's `others` list (any other
// pass of the loop), never against the intended crossing itself; the meander
// eases in from zero so it can't curl back over its own deck.
function makeRiver(track, run, rng) {
  const N = track.samples;
  const c = ((run.c % N) + N) % N;
  const p = track._pts[c];
  const tan = track._tans[c];
  const side = sideAt(track, c);
  const waterR = 10 + rng() * 4;
  const blend = waterR + 3.5 + 11;
  const ph0 = rng() * TAU;
  const ph1 = rng() * TAU;
  const amp = 26 + rng() * 22;

  const STEP = 13;
  const armPts = (sign) => {
    const arm = [];
    for (let k = 1; k <= 30; k++) {
      const t = sign * k * STEP;
      const sway = amp * smooth01(Math.abs(t) / 80) * (Math.sin(t * 0.011 + ph0) * 0.7 + Math.sin(t * 0.023 + ph1) * 0.3);
      const x = p.x + side.x * t + tan.x * sway;
      const z = p.z + side.z * t + tan.z * sway;
      if (otherRoadDist(run.others, x, z) < track.halfWidth + blend + 6) break;
      if (Math.hypot(x, z) > 880) break;
      arm.push({ x, z });
    }
    return arm;
  };
  const a = armPts(-1);
  const b = armPts(1);
  if (a.length + b.length < 9) return null;
  const raw = [...a.reverse(), { x: p.x, z: p.z }, ...b];
  const crossIdx = a.length;

  const spine = raw.map((q, i) => {
    const q0 = raw[Math.max(0, i - 1)];
    const q1 = raw[Math.min(raw.length - 1, i + 1)];
    let dx = q1.x - q0.x, dz = q1.z - q0.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: q.x, z: q.z, sx: dz / l, sz: -dx / l };
  });

  const level = run.minY - 5.5;
  return {
    ribbon: true,
    river: true,
    spine,
    crossIdx,
    level,
    floor: level - 3.4,
    waterR,
    shoreR: waterR + 3.5,
    blendR: blend,
    // Seeded waterfall: the river ALWAYS steps down partway along its longer
    // arm (terrain is road-anchored and only climbs away from the road, so a
    // "natural drop" almost never exists — waiting for one meant no falls).
    fallDrop: 7 + rng() * 4,
    fallAt: 0.45 + rng() * 0.2,
  };
}

// Ribbon water running parallel to a run's road, offset to one side (the dam's
// reservoir). Null if it would run off the terrain sheet.
function makeParallelWater(track, run, sign, cfg) {
  const N = track.samples;
  const off = track.halfWidth + 2 + cfg.waterR;
  const spine = [];
  for (let i = run.i0; i <= run.i1; i += 4) {
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const s = sideAt(track, idx);
    const x = p.x + s.x * sign * off;
    const z = p.z + s.z * sign * off;
    if (Math.hypot(x, z) > 880) return null;
    spine.push({ x, z, sx: s.x * sign, sz: s.z * sign });
  }
  if (spine.length < 4) return null;
  return {
    ribbon: true,
    spine,
    level: cfg.level,
    floor: cfg.level - cfg.floorDrop,
    waterR: cfg.waterR,
    shoreR: cfg.waterR + cfg.shore,
    blendR: cfg.waterR + cfg.shore + cfg.blend,
  };
}

// The elevated rail line crossing over the road: a straight line perpendicular
// to the road at the run centre, clipped where terrain climbs past the beam.
function makeRailLine(track, run, rng) {
  const N = track.samples;
  const c = ((run.c % N) + N) % N;
  const p = track._pts[c];
  const side = sideAt(track, c);
  const beamY = p.y + 12.5;
  const line = { x: p.x, z: p.z, dx: side.x, dz: side.z, y: beamY, len0: -150 - rng() * 40, len1: 150 + rng() * 40 };
  return line;
}

// The river as lake-system entries. Called from makeLakes with its baseHeight
// sampler: when the land along one arm has fallen well below the water, the
// river SPLITS into an upper and lower reach — the step between them is the
// waterfall (face + foam built with the structures).
export function featureWaterEntries(feats, baseHeight) {
  if (!feats) return [];
  const out = [];
  for (const run of feats.runs) {
    if (run.reservoir) out.push(run.reservoir);
    if (run.lagoon) out.push(run.lagoon);
  }
  const river = feats.river;
  if (!river) return out;
  const n = river.spine.length;
  // Pick the split: a NATURAL terrain drop along an arm when one exists
  // (rare — the terrain is road-anchored), otherwise a seeded point partway
  // along the LONGER arm. The lower reach carves its own deeper gorge, so the
  // step always works; the face + foam go in with the structures.
  let split = -1;
  let splitLow = 0;
  for (const dir of [1, -1]) {
    for (let k = 5; k < n - 3; k++) {
      const i = river.crossIdx + dir * k;
      if (i < 2 || i > n - 3) break;
      const s = river.spine[i];
      const ground = baseHeight(s.x, s.z);
      if (ground < river.level - 11) {
        split = i;
        splitLow = Math.max(ground + 2.5, river.level - 14);
        break;
      }
    }
    if (split >= 0) break;
  }
  if (split < 0) {
    // Longer arm, seeded fraction along it, at least 5 points from both the
    // crossing (the deck stays on the upper reach) and the river's end.
    const armA = river.crossIdx;
    const armB = n - 1 - river.crossIdx;
    const dir = armB >= armA ? 1 : -1;
    const armLen = Math.max(armA, armB);
    const k = Math.max(5, Math.round(armLen * (river.fallAt || 0.5)));
    const i = river.crossIdx + dir * k;
    if (i >= 5 && i <= n - 6 && armLen >= 11) {
      split = i;
      splitLow = river.level - (river.fallDrop || 8);
    }
  }
  if (split < 0) {
    out.push(river);
    return out;
  }
  // Two reaches sharing the split point; the crossing keeps the original level.
  const lowFirst = split < river.crossIdx;
  const upSpine = lowFirst ? river.spine.slice(split) : river.spine.slice(0, split + 1);
  const loSpine = lowFirst ? river.spine.slice(0, split + 1) : river.spine.slice(split);
  const mk = (spine, level) => ({
    ribbon: true, river: true, spine, level, floor: level - 3.4,
    waterR: river.waterR, shoreR: river.shoreR, blendR: river.blendR,
  });
  out.push(mk(upSpine, river.level));
  out.push(mk(loSpine, splitLow));
  const sp = river.spine[split];
  const nb = river.spine[split + (lowFirst ? 1 : -1)]; // toward the upper reach
  let fx = sp.x - nb.x, fz = sp.z - nb.z; // flow direction (upper -> lower)
  const fl = Math.hypot(fx, fz) || 1;
  feats.waterfall = {
    x: sp.x, z: sp.z, top: river.level, bot: splitLow,
    dirx: fx / fl, dirz: fz / fl, width: river.waterR * 1.8,
  };
  return out;
}

// Terrain fields: canyon walls up, overpass/dam/shelf sinks down, tunnel ridge
// over the road. All fade along the run and across distance bands, and yield
// around any other fold of the loop (`gate`), so no field ever buries road.
export function featureHeightMod(feats, x, z, h) {
  if (!feats) return h;
  for (const run of feats.runs) {
    if (run.kind === "canyon") {
      const s = spineDist(run.spine, x, z);
      if (s.u < 0 || s.d > 132) continue;
      const endW = smooth01(s.u / 0.16) * smooth01((1 - s.u) / 0.16);
      if (endW <= 0) continue;
      const inner = run.halfWidth + 7;
      const peak0 = inner + 15;
      const peak1 = inner + 50;
      let w = 0;
      if (s.d <= inner) w = 0;
      else if (s.d < peak0) w = smooth01((s.d - inner) / (peak0 - inner));
      else if (s.d < peak1) w = 1;
      else w = 1 - smooth01((s.d - peak1) / (132 - peak1));
      if (w <= 0) continue;
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      if (gate <= 0) continue;
      // Slow, incommensurate variation — a regular sine read as corrugated
      // pleats on the steep face.
      const wob = 0.95 + 0.05 * Math.sin(x * 0.017 + z * 0.021) * Math.sin(x * 0.0073 - z * 0.0091);
      h += run.mag * w * endW * wob * gate;
    } else if (run.kind === "tunnel") {
      // Shoulder hills flanking the tunnel. The heightfield must NEVER rise
      // across the corridor: a raised terrain sheet has no hole, so it filled
      // the portal mouth with a wall you could drive through (visible from
      // outside as its top face, invisible from inside via backface culling).
      // The mountain OVER the tube is a separate shell mesh (see buildTunnel).
      const s = spineDist(run.spine, x, z);
      if (s.u < 0 || s.d > 112) continue;
      const endW = smooth01((s.u - 0.12) / 0.1) * smooth01((0.88 - s.u) / 0.1);
      if (endW <= 0) continue;
      const inner = run.halfWidth + 9;
      if (s.d <= inner) continue;
      const peak0 = inner + 10;
      const peak1 = inner + 48;
      let w;
      if (s.d < peak0) w = smooth01((s.d - inner) / (peak0 - inner));
      else if (s.d < peak1) w = 1;
      else w = 1 - smooth01((s.d - peak1) / (112 - peak1));
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      if (gate <= 0) continue;
      const wob = 0.95 + 0.05 * Math.sin(x * 0.016 + z * 0.019);
      const ridge = s.y + run.mag * 0.85 * wob - h;
      if (ridge > 0) h += ridge * w * endW * gate;
    } else if (run.kind === "overpass") {
      const s = spineDist(run.spine, x, z);
      if (s.u < 0 || s.d > 74) continue;
      const endW = smooth01(s.u / 0.2) * smooth01((1 - s.u) / 0.2);
      const across = 1 - smooth01((s.d - 34) / (74 - 34));
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      const t = across * endW * gate;
      if (t <= 0) continue;
      const sunk = s.y - run.depth;
      h += (Math.min(h, sunk) - h) * t;
    } else if (run.kind === "shelf" || run.kind === "dam") {
      // Sink ONE side (shelf: the infield drop; dam: the valley below the
      // wall). The shelf also raises a wall on its other side.
      const s = spineDist(run.spine, x, z);
      const reach = run.kind === "dam" ? 150 : 130;
      if (s.u < 0 || s.d > reach) continue;
      const endW = smooth01(s.u / 0.18) * smooth01((1 - s.u) / 0.18);
      if (endW <= 0) continue;
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      if (gate <= 0) continue;
      // Which side of the run is (x,z) on?
      const i = Math.round(s.u * (run.spine.length - 1));
      const a = run.spine[Math.max(0, i - 1)];
      const b = run.spine[Math.min(run.spine.length - 1, i + 1)];
      const crossZ = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
      const sideSign = crossZ >= 0 ? 1 : -1; // matches cross(tan, up) side sense
      const dropSide = sideSign === run.inSign;
      // The dam's valley plunges straight off the deck edge (the concrete face
      // needs air behind it); the shelf keeps a soft shoulder first.
      const inner = run.kind === "dam" ? run.halfWidth + 1 : run.halfWidth + 5;
      const ramp = run.kind === "dam" ? 15 : 26;
      if (dropSide) {
        const depth = run.kind === "dam" ? run.depth : run.drop;
        const across = s.d < inner ? 0 : s.d < inner + ramp ? smooth01((s.d - inner) / ramp) : 1 - smooth01((s.d - (inner + 74)) / (reach - (inner + 74)));
        const t = Math.max(0, across) * endW * gate;
        if (t > 0) {
          const sunk = s.y - depth;
          h += (Math.min(h, sunk) - h) * t;
        }
      } else if (run.kind === "shelf") {
        const peak0 = inner + 16;
        const peak1 = inner + 46;
        let w = 0;
        if (s.d <= inner + 2) w = 0;
        else if (s.d < peak0) w = smooth01((s.d - inner - 2) / (peak0 - inner - 2));
        else if (s.d < peak1) w = 1;
        else w = 1 - smooth01((s.d - peak1) / (130 - peak1));
        const wob = 0.95 + 0.05 * Math.sin(x * 0.018 + z * 0.02) * Math.sin(x * 0.008 - z * 0.0095);
        h += run.mag * w * endW * wob * gate;
      }
    }
  }
  return h;
}

// Roadside buildings/props stay out of the runs so each reads as itself.
export function featureKeepClear(feats, x, z) {
  if (!feats) return false;
  for (const run of feats.runs) {
    const R =
      run.kind === "overpass" ? 42
      : run.kind === "canyon" ? 88
      : run.kind === "giant" ? 66
      : run.kind === "tunnel" ? 70
      : run.kind === "shelf" ? 85
      : run.kind === "dam" ? 80
      : run.kind === "causeway" ? 62
      : run.kind === "arches" ? 40
      : run.kind === "flowers" ? 70
      : run.kind === "bridge" ? 34
      : 0;
    if (R) {
      const s = spineDist(run.spine, x, z);
      if (s.u >= 0 && s.d < R) return true;
    }
    if (run.rail) {
      // Keep towers out of the train's path.
      const L = run.rail;
      const t = (x - L.x) * L.dx + (z - L.z) * L.dz;
      if (t > L.len0 && t < L.len1) {
        const px = L.x + L.dx * t, pz = L.z + L.dz * t;
        if (Math.hypot(x - px, z - pz) < 20) return true;
      }
    }
  }
  return false;
}

// Overhead spans (street banners, wooden footbridges) and street lamps stay
// out of runs that carry their own structure overhead or ride a deck.
const SPAN_BLOCK = new Set(["tunnel", "bridge", "overpass", "dam", "causeway", "arches", "rail"]);
export function featureSpanBlock(feats, x, z) {
  if (!feats) return false;
  for (const run of feats.runs) {
    if (!SPAN_BLOCK.has(run.kind)) continue;
    const s = spineDist(run.spine, x, z);
    if (s.u >= 0 && s.d < run.halfWidth + 26) return true;
  }
  return false;
}

// Trees stay off the canyon/shelf wall bands and the tunnel ridge shoulders
// (mid-face trunks clipped into the rock).
export function featureTreeBlock(feats, x, z) {
  if (!feats) return false;
  for (const run of feats.runs) {
    if (run.kind !== "canyon" && run.kind !== "shelf" && run.kind !== "tunnel") continue;
    const s = spineDist(run.spine, x, z);
    if (s.u >= 0 && s.d < run.halfWidth + (run.kind === "tunnel" ? 34 : 58)) return true;
  }
  return false;
}

// 0..1 "make the trees giant here" field for the forest run.
export function giantTreeBoost(feats, x, z) {
  if (!feats) return 0;
  for (const run of feats.runs) {
    if (run.kind !== "giant") continue;
    const s = spineDist(run.spine, x, z);
    if (s.u < 0) return 0;
    const endW = smooth01(s.u / 0.15) * smooth01((1 - s.u) / 0.15);
    return (1 - smooth01((s.d - 70) / 55)) * endW;
  }
  return 0;
}

// Keep the chase camera out of tunnel rock. When the kart hugs the bore wall
// (or reverses sideways inside), the camera's spot behind it can land inside
// the mountain shell — the render then shows the shell's inside-out skin.
// If `pos` falls inside a tunnel's mountain cross-section, pull it back into
// the bore with a small margin. Mutates pos in place.
export function featureCameraClamp(feats, track, pos) {
  if (!feats) return;
  const N = track.samples;
  for (const run of feats.runs) {
    if (run.kind !== "tunnel") continue;
    // Tube + shell span (matches buildTunnel's inset and shell sweep).
    const t0 = run.i0 + Math.round((run.i1 - run.i0) * 0.16);
    const t1 = run.i1 - Math.round((run.i1 - run.i0) * 0.16);
    const halfW = track.halfWidth + 2.6;
    const APEX = 15;
    let best = -1;
    let bestD2 = 45 * 45; // beyond the widest shell -> nothing to do
    for (let i = t0; i <= t1; i++) {
      const p = track._pts[((i % N) + N) % N];
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    if (best < 0) continue;
    const p = track._pts[((best % N) + N) % N];
    const side = sideAt(track, ((best % N) + N) % N);
    const lat = (pos.x - p.x) * side.x + (pos.z - p.z) * side.z;
    // Mountain shell half-ellipse at this sample (same W/A as buildTunnel).
    const u01 = (best - t0) / Math.max(1, t1 - t0);
    const endT = smooth01(Math.min(u01, 1 - u01) / 0.16);
    const W = halfW + 1.4 + 30 * endT;
    const A = APEX + 1.6 + (run.mag - APEX + 3.5) * endT;
    const ex = lat / W;
    const ey = (pos.y - (p.y - 1.2)) / A;
    if (ey < 0 || ex * ex + ey * ey >= 1) continue; // not inside the rock
    const M = 1.1; // stay this far off the bore surface
    const latC = Math.max(-(halfW - M), Math.min(halfW - M, lat));
    pos.x -= side.x * (lat - latC);
    pos.z -= side.z * (lat - latC);
    const ceil = p.y + 0.2 + APEX * Math.sqrt(Math.max(0, 1 - (latC / halfW) * (latC / halfW)));
    if (pos.y > ceil - M) pos.y = ceil - M;
    if (pos.y < p.y + 1.2) pos.y = p.y + 1.2;
    return;
  }
}

// ---- Map glyphs + track names ----------------------------------------------
const KIND_GLYPHS = {
  bridge: "🌉", canyon: "⛰️", tunnel: "🚇", giant: "🌲", overpass: "🛣️",
  shelf: "🧗", dam: "💧", causeway: "🌊", arches: "🪨", windfarm: "🌀",
  flowers: "🌼", billboards: "🌆", rail: "🚂",
};
export function featureGlyphs(feats) {
  if (!feats) return [];
  const out = [];
  for (const run of feats.runs) {
    const g = KIND_GLYPHS[run.kind];
    if (!g) continue;
    const mid = run.spine[Math.floor(run.spine.length / 2)];
    out.push({ x: mid.x, z: mid.z, glyph: g, kind: run.kind });
  }
  return out;
}

// A friendly generated name led by the map's headline feature.
const TITLE_PRIORITY = ["tunnel", "dam", "causeway", "canyon", "bridge", "shelf", "overpass", "giant", "windfarm", "flowers", "arches", "billboards"];
const TITLE_WORDS = {
  tunnel: "Tunnel", dam: "Dam", causeway: "Causeway", canyon: "Canyon",
  bridge: "Riverbend", shelf: "Ledge", overpass: "Skyway", giant: "Grove",
  windfarm: "Windmill", flowers: "Bloom", arches: "Pillars", billboards: "Neon",
};
const TITLE_SUFFIX = ["GP", "Circuit", "Sprint", "Run", "Loop", "Raceway"];
export function trackTitle(feats, seedStr) {
  let h = 2166136261 >>> 0;
  const str = String(seedStr || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const suffix = TITLE_SUFFIX[h % TITLE_SUFFIX.length];
  const kinds = new Set((feats?.runs || []).map((r) => r.kind));
  for (const k of TITLE_PRIORITY) {
    if (kinds.has(k)) return `${TITLE_WORDS[k]} ${suffix}`;
  }
  return `Zoomies ${suffix}`;
}

// ---- Structures + ambience ---------------------------------------------------
// One concrete kit for every elevated run (deck skirts + underside, paired
// piers with crossbeams), plus the tunnel tube/portals, dam wall, canyon and
// shelf rim rocks, waterfall face, treatments (flowers, turbines, pillars,
// billboards, rail + train) and the small lives that make the places feel
// inhabited. Returns { update(time) } that buildWorld drives each frame.
export function buildFeatureStructures(scene, track, heightAt, rng = Math.random, opts = {}) {
  const feats = track.features;
  const anims = [];
  if (!feats || !feats.runs.length) return { update() {} };
  const N = track.samples;
  const spacing = track.length / N;
  const lit = !!opts.lit;
  const litLevel = opts.litLevel || 0;

  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  const cTop = new THREE.Color(0xb5b0a6);
  const cUnder = new THREE.Color(0x7e7a72);
  const pierBoxes = [];

  // Deck (skirts + underside) for a run; `depths` lets the dam sink one skirt
  // to the valley floor.
  const buildDeck = (run, { piers = true, leftDepth = null, rightDepth = null } = {}) => {
    const span = run.i1 - run.i0;
    const skirtTopOff = track.halfWidth + 0.62;
    const positions = [];
    const colors = [];
    const indices = [];
    let row = 0;
    for (let i = run.i0; i <= run.i1; i++) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const u = (i - run.i0) / span;
      const endW = smooth01(u / 0.12) * smooth01((1 - u) / 0.12);
      const base = 0.35 + 2.0 * endW;
      const lx = p.x + side.x * skirtTopOff, lz = p.z + side.z * skirtTopOff;
      const rx = p.x - side.x * skirtTopOff, rz = p.z - side.z * skirtTopOff;
      const dl = leftDepth ? leftDepth(lx, lz, p, endW) : base;
      const dr = rightDepth ? rightDepth(rx, rz, p, endW) : base;
      positions.push(lx, p.y + 0.12, lz, lx, p.y - dl, lz, rx, p.y - dr, rz, rx, p.y + 0.12, rz);
      // Deep faces (the dam wall) keep the light concrete tone so they read as
      // built structure even in their own shade; shallow undersides stay dark.
      const cl = dl > 6 ? cTop : cUnder;
      const cr = dr > 6 ? cTop : cUnder;
      colors.push(cTop.r, cTop.g, cTop.b, cl.r, cl.g, cl.b, cr.r, cr.g, cr.b, cTop.r, cTop.g, cTop.b);
      if (i < run.i1) {
        const a = row * 4;
        const b = a + 4;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
        indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
        indices.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
      }
      row++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, concrete);
    mesh.castShadow = true;
    scene.add(mesh);

    if (!piers) return;
    const step = Math.max(5, Math.round(24 / spacing));
    for (let i = run.i0 + step; i <= run.i1 - step; i += step) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const yaw = Math.atan2(side.x, side.z);
      const deckBottom = p.y - 2.0;
      const legOff = track.halfWidth * 0.42;
      const legs = [];
      let lowest = Infinity;
      for (const sgn of [1, -1]) {
        const x = p.x + side.x * sgn * legOff;
        const z = p.z + side.z * sgn * legOff;
        const gy = heightAt(x, z);
        legs.push({ x, z, gy });
        if (gy < lowest) lowest = gy;
      }
      if (deckBottom - lowest < 1.6) continue;
      for (const leg of legs) {
        const hgt = deckBottom - leg.gy + 1.6;
        pierBoxes.push({ x: leg.x, y: leg.gy - 1.6 + hgt / 2, z: leg.z, sx: 2.5, sy: hgt, sz: 2.1, yaw });
      }
      pierBoxes.push({ x: p.x, y: deckBottom - 0.55, z: p.z, sx: track.halfWidth * 1.5, sy: 1.1, sz: 2.4, yaw });
    }
  };

  // Craggy rim rocks shared by canyon + shelf.
  const rimChunks = [];
  const addRimRocks = (run, sides) => {
    for (let i = run.i0; i <= run.i1; i += 5) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      for (const sgn of sides) {
        if (rng() < 0.62) continue;
        const off = track.halfWidth + 14 + rng() * 34;
        const x = p.x + side.x * sgn * off + (rng() - 0.5) * 5;
        const z = p.z + side.z * sgn * off + (rng() - 0.5) * 5;
        if (track.distanceToCenter(x, z) < track.halfWidth + 10) continue;
        rimChunks.push({ x, z, base: heightAt(x, z), h: 4.5 + rng() * 6, warm: run.warmRock });
      }
    }
  };

  for (const run of feats.runs) {
    if (run.kind === "bridge" || run.kind === "overpass" || run.kind === "causeway") {
      buildDeck(run, { piers: true });
    } else if (run.kind === "dam") {
      // Reservoir side rides a normal skirt; the valley side is the DAM WALL,
      // a full concrete face down to the sunken floor.
      const wallSide = run.inSign; // valley is inward
      // Wall depth probes the valley floor well PAST the sink ramp (the strip
      // right at the skirt is still near road level, which is what left the
      // old face only two units tall).
      buildDeck(run, {
        piers: false,
        leftDepth: (x, z, p, endW) => {
          if (wallSide <= 0) return 0.35 + 2.0 * endW;
          const gx = x + (x - p.x) * 2.1, gz = z + (z - p.z) * 2.1; // ~32u out on this side
          return Math.max(0.35 + 2.0 * endW, (p.y - heightAt(gx, gz)) * endW + 0.4);
        },
        rightDepth: (x, z, p, endW) => {
          if (wallSide >= 0) return 0.35 + 2.0 * endW;
          const gx = x + (x - p.x) * 2.1, gz = z + (z - p.z) * 2.1;
          return Math.max(0.35 + 2.0 * endW, (p.y - heightAt(gx, gz)) * endW + 0.4);
        },
      });
      // Buttresses down the dam face.
      const step = Math.max(6, Math.round(30 / spacing));
      for (let i = run.i0 + step; i <= run.i1 - step; i += step) {
        const idx = ((i % N) + N) % N;
        const p = track._pts[idx];
        const side = sideAt(track, idx);
        const x = p.x + side.x * run.inSign * (track.halfWidth + 1.6);
        const z = p.z + side.z * run.inSign * (track.halfWidth + 1.6);
        const gy = heightAt(x, z);
        const hgt = p.y - gy;
        if (hgt < 6) continue;
        pierBoxes.push({ x, y: gy + hgt / 2, z, sx: 3.2, sy: hgt, sz: 2.6, yaw: Math.atan2(side.x, side.z) });
      }
    } else if (run.kind === "canyon") {
      addRimRocks(run, [1, -1]);
    } else if (run.kind === "shelf") {
      addRimRocks(run, [-run.inSign]); // rocks on the wall side only
    } else if (run.kind === "tunnel") {
      buildTunnel(scene, track, run, rng, anims, opts.groundColorAt);
    } else if (run.kind === "flowers") {
      buildFlowers(scene, track, run, heightAt, rng);
    } else if (run.kind === "windfarm") {
      buildWindFarm(scene, track, run, heightAt, rng, anims);
    } else if (run.kind === "arches") {
      buildArches(scene, track, run, rng);
    } else if (run.kind === "billboards") {
      buildBillboards(scene, track, run, heightAt, rng, lit, litLevel);
    } else if (run.kind === "rail") {
      buildRail(scene, track, run, heightAt, rng, anims);
    }
  }

  if (pierBoxes.length) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8a49b, roughness: 1 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, pierBoxes.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    pierBoxes.forEach((b, i) => {
      q.setFromAxisAngle(_up, b.yaw);
      pv.set(b.x, b.y, b.z);
      sv.set(b.sx, b.sy, b.sz);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }

  if (rimChunks.length) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
    const mesh = new THREE.InstancedMesh(geo, mat, rimChunks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    const col = new THREE.Color();
    rimChunks.forEach((c, i) => {
      const sy = c.h / 2;
      q.setFromEuler(new THREE.Euler(rng() * 0.5, rng() * Math.PI, rng() * 0.5));
      pv.set(c.x, c.base + sy * 0.15, c.z);
      sv.set(2.2 + rng() * 2.4, sy, 2.2 + rng() * 2.4);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(i, m);
      if (c.warm) col.setHSL(0.055, 0.52, 0.33 + rng() * 0.1);
      else col.setHSL(0.09, 0.1, 0.4 + rng() * 0.14);
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.layers.set(1);
    scene.add(mesh);
  }

  if (feats.waterfall) buildWaterfall(scene, feats.waterfall, anims);
  buildAmbience(scene, track, feats, heightAt, rng, anims, opts.lakes || []);

  return {
    update(time) {
      for (const a of anims) a(time);
    },
  };
}

// ---- Tunnel ------------------------------------------------------------------
// An arched tube swept along the run (castShadow=true is what darkens the road
// inside — the tube occludes the sun), stone portal rings at both ends, and
// warm ceiling lamps so the interior reads as a place, not a void.
function buildTunnel(scene, track, run, rng, anims, groundColorAt = null) {
  const N = track.samples;
  // The tube spans the middle of the run; the ridge fades past its ends so the
  // portals punch into a full-height hillside.
  const t0 = run.i0 + Math.round((run.i1 - run.i0) * 0.16);
  const t1 = run.i1 - Math.round((run.i1 - run.i0) * 0.16);
  const halfW = track.halfWidth + 2.6;
  const APEX = 15;
  // Arch profile: verge -> apex -> verge (half-ellipse), swept along samples.
  const ARC = 9;
  const profile = [];
  for (let k = 0; k <= ARC; k++) {
    const a = Math.PI * (k / ARC);
    profile.push([Math.cos(a) * halfW, Math.sin(a) * APEX]);
  }
  const positions = [];
  const colors = [];
  const indices = [];
  const cIn = new THREE.Color(0x4a453f);
  const cLo = new THREE.Color(0x2f2c28);
  let row = 0;
  for (let i = t0; i <= t1; i++) {
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    for (let k = 0; k <= ARC; k++) {
      const [sx, sy] = profile[k];
      positions.push(p.x + side.x * sx, p.y + 0.2 + sy, p.z + side.z * sx);
      const c = sy > APEX * 0.55 ? cLo : cIn; // darker toward the crown
      colors.push(c.r, c.g, c.b);
    }
    if (i < t1) {
      const a = row * (ARC + 1);
      const b = a + ARC + 1;
      for (let k = 0; k < ARC; k++) indices.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
    row++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const tube = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
  tube.castShadow = true; // occludes the sun -> naturally dark interior
  tube.receiveShadow = false;
  scene.add(tube);

  // Portal rings: a stone arch face at each end.
  const portalMat = new THREE.MeshStandardMaterial({ color: 0x8d857a, roughness: 1 });
  for (const end of [t0, t1]) {
    const idx = ((end % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    const yaw = Math.atan2(track._tans[idx].x, track._tans[idx].z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(halfW + 1.2, 2.2, 8, 20, Math.PI), portalMat);
    ring.position.set(p.x, p.y + 0.4, p.z);
    ring.rotation.y = yaw;
    ring.scale.y = (APEX + 1.5) / (halfW + 1.2);
    ring.castShadow = true;
    scene.add(ring);
  }

  // The MOUNTAIN over the tube: a swept shell (its own mesh, NOT the terrain
  // heightfield — a raised heightfield has no hole, so it walled up the portal
  // mouths). Wide and tall mid-run, tapering down to hug the portal rings at
  // the ends; tinted like the local ground so it reads as the hillside.
  {
    const shellPos = [];
    const shellCol = [];
    const shellIdx = [];
    const SEG = 11;
    const col = new THREE.Color(0x8d857a);
    let srow = 0;
    for (let i = t0; i <= t1; i += 2) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const u01 = (i - t0) / (t1 - t0);
      const endT = smooth01(Math.min(u01, 1 - u01) / 0.16); // 0 at portals -> 1 mid
      const W = halfW + 1.4 + 30 * endT;
      const A = APEX + 1.6 + (run.mag - APEX + 3.5) * endT;
      for (let k = 0; k <= SEG; k++) {
        const a = Math.PI * (k / SEG);
        const sx = Math.cos(a) * W;
        const sy = Math.sin(a) * A;
        const x = p.x + side.x * sx;
        const z = p.z + side.z * sx;
        const y = p.y - 1.2 + sy;
        shellPos.push(x, y, z);
        if (groundColorAt) groundColorAt(x, z, y, col);
        shellCol.push(col.r, col.g, col.b);
      }
      const rows = srow;
      if (i + 2 <= t1) {
        const a0 = rows * (SEG + 1);
        const b0 = a0 + SEG + 1;
        for (let k = 0; k < SEG; k++) shellIdx.push(a0 + k, b0 + k, a0 + k + 1, a0 + k + 1, b0 + k, b0 + k + 1);
      }
      srow++;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(shellPos, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(shellCol, 3));
    sg.setIndex(shellIdx);
    sg.computeVertexNormals();
    const shell = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    shell.castShadow = true;
    shell.receiveShadow = true;
    scene.add(shell);
  }

  // Festive string lights draped across the tunnel ceiling: sagging spans of
  // multicolour bulbs that glow in the dark interior.
  {
    const FESTIVE = [0xff5b4d, 0xffd24d, 0x54d98b, 0x4da3ff, 0xff8ee0, 0xfff4d6];
    const bulbGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const spanStep = Math.max(6, Math.round(17 / (track.length / N)));
    const spans = [];
    for (let i = t0 + spanStep; i <= t1 - 3; i += spanStep) spans.push(i);
    const PER = 11;
    // One instanced mesh PER colour: instanceColor can't tint emissive, and an
    // all-white emissive washed the festive colours out.
    const byColor = FESTIVE.map(() => []);
    const wirePts = [];
    let bi = 0;
    for (const i of spans) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const aW = halfW * 0.8;
      const aY = APEX * 0.6;
      for (let k = 0; k < PER; k++) {
        const f = k / (PER - 1); // 0..1 across the span
        const sx = -aW + f * 2 * aW;
        // Anchored on the walls, sagging in the middle.
        const y = p.y + aY - Math.sin(Math.PI * f) * 1.8;
        const x = p.x + side.x * sx;
        const z = p.z + side.z * sx;
        byColor[(bi + k) % FESTIVE.length].push(x, y, z);
        bi++;
        wirePts.push(x, y + 0.14, z);
      }
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3(1, 1, 1);
    const pv = new THREE.Vector3();
    byColor.forEach((pts, ci) => {
      const n = pts.length / 3;
      if (!n) return;
      const mat = new THREE.MeshStandardMaterial({ color: FESTIVE[ci], roughness: 0.4, emissive: FESTIVE[ci], emissiveIntensity: 2.2 });
      const mesh = new THREE.InstancedMesh(bulbGeo, mat, n);
      for (let k = 0; k < n; k++) {
        pv.set(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]);
        m.compose(pv, q, sv);
        mesh.setMatrixAt(k, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    });
    // A thin dark wire through each span's bulbs.
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wirePts, 3));
    const wIdx = [];
    for (let s = 0; s < spans.length; s++) {
      for (let k = 0; k < PER - 1; k++) wIdx.push(s * PER + k, s * PER + k + 1);
    }
    wg.setIndex(wIdx);
    const wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x1c1a17 }));
    scene.add(wire);
  }

  // Ceiling lamps: warm glow discs down the crown.
  const lampCount = Math.max(3, Math.floor((t1 - t0) / 14));
  const glowGeo = new THREE.PlaneGeometry(2.6, 2.6);
  const glowTex = lampGlowCanvas();
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, color: 0xffd98a });
  const lamps = new THREE.InstancedMesh(glowGeo, glowMat, lampCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3(1, 1, 1);
  for (let k = 0; k < lampCount; k++) {
    const i = t0 + Math.round(((k + 0.5) / lampCount) * (t1 - t0));
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    pv.set(p.x, p.y + APEX - 1.1, p.z);
    m.compose(pv, q, sv);
    lamps.setMatrixAt(k, m);
  }
  lamps.instanceMatrix.needsUpdate = true;
  lamps.renderOrder = 2;
  scene.add(lamps);
  void anims;
}

function lampGlowCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,240,200,0.95)");
  g.addColorStop(0.35, "rgba(255,214,130,0.5)");
  g.addColorStop(1, "rgba(255,214,130,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- Waterfall ---------------------------------------------------------------
function buildWaterfall(scene, wf, anims) {
  const drop = wf.top - wf.bot;
  if (drop < 3) return;
  // The falling face: a slightly leaning plane with scrolling streaks.
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(180,220,235,0.35)";
  ctx.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.45})`;
    const x = Math.random() * 64;
    ctx.fillRect(x, 0, 1.5 + Math.random() * 2.5, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(wf.width, drop + 1.6), mat);
  const yaw = Math.atan2(wf.dirx, wf.dirz);
  face.position.set(wf.x - wf.dirx * 1.2, (wf.top + wf.bot) / 2 - 0.2, wf.z - wf.dirz * 1.2);
  face.rotation.y = yaw;
  face.rotation.x = 0.1; // slight lean down-slope
  face.renderOrder = 2;
  scene.add(face);
  anims.push((time) => {
    tex.offset.y = -time * 0.9;
  });

  // Foam at the plunge pool.
  const foamMat = new THREE.MeshStandardMaterial({ color: 0xf2fbff, roughness: 1 });
  const foam = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), foamMat, 7);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  for (let i = 0; i < 7; i++) {
    const off = (i - 3) * (wf.width / 7);
    pv.set(wf.x - wf.dirx * 2.5 + wf.dirz * off, wf.bot + 0.3, wf.z - wf.dirz * 2.5 - wf.dirx * off);
    const s = 0.9 + Math.random() * 1.2;
    sv.set(s, s * 0.5, s);
    q.setFromAxisAngle(_up, Math.random() * TAU);
    m.compose(pv, q, sv);
    foam.setMatrixAt(i, m);
  }
  foam.instanceMatrix.needsUpdate = true;
  scene.add(foam);
}

// ---- Treatments --------------------------------------------------------------
function buildFlowers(scene, track, run, heightAt, rng) {
  // A carpet of flower heads on stems through the run. One stem mesh + one
  // instanced head mesh, tinted per-instance from the seed's palette.
  const PALETTES = [
    [0xe0392f, 0xf2653c, 0xf7f4ec], // poppies
    [0x9b7bd8, 0xb79bee, 0xe8ddfa], // lavender
    [0xf2c12e, 0xf7d95c, 0xffffff], // sunflowers/daisies
  ];
  const palette = PALETTES[Math.floor(run.flowerHue * PALETTES.length) % PALETTES.length];
  const COUNT = 950;
  const stemGeo = new THREE.PlaneGeometry(0.12, 0.95).translate(0, 0.47, 0);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3f7a33, roughness: 1, side: THREE.DoubleSide });
  const headGeo = new THREE.IcosahedronGeometry(0.32, 0);
  const headMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, COUNT);
  const heads = new THREE.InstancedMesh(headGeo, headMat, COUNT);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const col = new THREE.Color();
  const N = track.samples;
  let n = 0;
  let tries = 0;
  while (n < COUNT && tries < COUNT * 4) {
    tries++;
    const i = run.i0 + Math.floor(rng() * (run.i1 - run.i0));
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    const dir = rng() < 0.5 ? 1 : -1;
    const dist = track.halfWidth + 3.5 + rng() * 42; // a dense carpet near the road
    const x = p.x + side.x * dir * dist + (rng() - 0.5) * 6;
    const z = p.z + side.z * dir * dist + (rng() - 0.5) * 6;
    if (track.distanceToCenter(x, z) < track.halfWidth + 3) continue;
    const y = heightAt(x, z);
    const sc = 1.0 + rng() * 0.9;
    q.setFromAxisAngle(_up, rng() * TAU);
    pv.set(x, y, z);
    sv.set(sc, sc, sc);
    m.compose(pv, q, sv);
    stems.setMatrixAt(n, m);
    pv.set(x, y + 0.95 * sc, z);
    m.compose(pv, q, sv);
    heads.setMatrixAt(n, m);
    col.set(palette[Math.floor(rng() * palette.length)]);
    heads.setColorAt(n, col);
    n++;
  }
  stems.count = heads.count = n;
  stems.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
  stems.layers.set(2); // like grass: out of the mirror and outline pass
  heads.layers.set(2);
  scene.add(stems);
  scene.add(heads);
}

function buildWindFarm(scene, track, run, heightAt, rng, anims) {
  const N = track.samples;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.6 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.55 });
  const count = 4 + Math.floor(rng() * 3);
  for (let k = 0; k < count; k++) {
    const i = run.i0 + Math.round(((k + 0.5) / count) * (run.i1 - run.i0));
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    const dir = k % 2 === 0 ? 1 : -1;
    const off = track.halfWidth + 46 + rng() * 60;
    const x = p.x + side.x * dir * off;
    const z = p.z + side.z * dir * off;
    if (track.distanceToCenter(x, z) < track.halfWidth + 30) continue;
    const y = heightAt(x, z);
    const H = 20 + rng() * 5;
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.7, H, 8), poleMat);
    pole.position.y = H / 2;
    pole.castShadow = true;
    g.add(pole);
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 2.4), poleMat);
    nacelle.position.set(0, H, 0.4);
    g.add(nacelle);
    const rotor = new THREE.Group();
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.55, 8.5, 4).scale(1, 1, 0.28), bladeMat);
      blade.geometry.translate?.(0, 4.25, 0);
      blade.rotation.z = (b / 3) * TAU;
      rotor.add(blade);
    }
    rotor.position.set(0, H, 1.8);
    g.add(rotor);
    g.position.set(x, y, z);
    g.rotation.y = Math.atan2(p.x - x, p.z - z); // face the road
    scene.add(g);
    const speed = 0.9 + rng() * 0.5;
    const phase = rng() * TAU;
    anims.push((time) => {
      rotor.rotation.z = time * speed + phase;
    });
  }
}

function buildArches(scene, track, run, rng) {
  // Desert rock pillars (hoodoos) lining the road: standalone tapering
  // columns of varying heights, most wearing a wider caprock on top.
  const N = track.samples;
  const chunks = [];
  const count = 5 + Math.floor(rng() * 3);
  for (let k = 0; k < count; k++) {
    const i = run.i0 + Math.round(((k + 0.5) / count) * (run.i1 - run.i0));
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    const yaw = Math.atan2(side.x, side.z);
    // Most sites get one pillar; some get a facing pair (a lintel-less gate).
    const both = rng() < 0.3;
    const first = rng() < 0.5 ? 1 : -1;
    for (const sgn of both ? [1, -1] : [first]) {
      const off = track.halfWidth + 5 + rng() * 7;
      const px = p.x + side.x * sgn * off;
      const pz = p.z + side.z * sgn * off;
      const tiers = 4 + Math.floor(rng() * 4); // 4..7 — varied heights
      const base = 5.6 + rng() * 1.4;
      // Continuous tapering column (chunks overlap vertically and the base
      // is planted in the ground, so nothing hovers).
      for (let s = 0; s < tiers; s++) {
        const t = s / (tiers - 1);
        const cap = s === tiers - 1 && rng() < 0.75;
        const w = base * (1 - 0.4 * t) * (cap ? 1.5 : 1);
        chunks.push({
          x: px + (rng() - 0.5) * 0.6, y: p.y + 1.2 + s * 2.6, z: pz + (rng() - 0.5) * 0.6,
          sx: w, sy: cap ? 3.4 : 4.6, sz: w * (0.82 + rng() * 0.12),
          yaw: yaw + rng() * 0.6, flat: true,
        });
      }
    }
  }
  if (!chunks.length) return;
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const mesh = new THREE.InstancedMesh(geo, mat, chunks.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const col = new THREE.Color();
  chunks.forEach((csp, i) => {
    // Pillar chunks stay level (tilted ellipsoids open gaps in the column).
    if (csp.flat) q.setFromEuler(new THREE.Euler(0, csp.yaw, 0));
    else q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.4, csp.yaw, (rng() - 0.5) * 0.4));
    pv.set(csp.x, csp.y, csp.z);
    sv.set(csp.sx / 2, csp.sy / 2, csp.sz / 2);
    m.compose(pv, q, sv);
    mesh.setMatrixAt(i, m);
    col.setHSL(0.05, 0.48, 0.35 + rng() * 0.09);
    mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  scene.add(mesh);
}

function buildBillboards(scene, track, run, heightAt, rng, lit, litLevel) {
  const N = track.samples;
  const SIGNS = [
    ["ZOOMIES!", "#22d3ee", "#0b1020"],
    ["CATNIP CO.", "#a3e635", "#101408"],
    ["MEOW MOTORS", "#f472b6", "#180a12"],
    ["PAWS ⚡ POWER", "#facc15", "#141005"],
  ];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.6, metalness: 0.4 });
  const count = 3 + Math.floor(rng() * 2);
  for (let k = 0; k < count; k++) {
    const i = run.i0 + Math.round(((k + 0.5) / count) * (run.i1 - run.i0));
    const idx = ((i % N) + N) % N;
    const p = track._pts[idx];
    const side = sideAt(track, idx);
    const dir = k % 2 === 0 ? 1 : -1;
    const off = track.halfWidth + 8 + rng() * 5;
    const x = p.x + side.x * dir * off;
    const z = p.z + side.z * dir * off;
    if (track.distanceToCenter(x, z) < track.halfWidth + 6) continue;
    const y = heightAt(x, z);
    const [text, fg, bg] = SIGNS[Math.floor(rng() * SIGNS.length)];
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 244, 116);
    ctx.fillStyle = fg;
    ctx.font = "bold 34px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const panelMat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: lit ? 1.6 * litLevel + 0.4 : 0.12,
      roughness: 0.6,
    });
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 8.6, 8), poleMat);
    pole.position.y = 4.3;
    pole.castShadow = true;
    g.add(pole);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.2, 0.35), panelMat);
    panel.position.y = 9.6;
    panel.castShadow = true;
    g.add(panel);
    g.position.set(x, y, z);
    g.rotation.y = Math.atan2(p.x - x, p.z - z);
    scene.add(g);
  }
}

// ---- Rail + train --------------------------------------------------------------
function buildRail(scene, track, run, heightAt, rng, anims) {
  const L = run.rail;
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x565c66, roughness: 0.7, metalness: 0.3 });
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x9a968e, roughness: 1 });
  // Clip the line where terrain climbs past the beam.
  let lo = L.len0, hi = L.len1;
  for (let t = -20; t >= L.len0; t -= 20) if (heightAt(L.x + L.dx * t, L.z + L.dz * t) > L.y - 3) { lo = t + 20; break; }
  for (let t = 20; t <= L.len1; t += 20) if (heightAt(L.x + L.dx * t, L.z + L.dz * t) > L.y - 3) { hi = t - 20; break; }
  if (hi - lo < 90) return;
  const len = hi - lo;
  const cx = L.x + L.dx * (lo + hi) / 2;
  const cz = L.z + L.dz * (lo + hi) / 2;
  const yaw = Math.atan2(L.dx, L.dz);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.4, len), beamMat);
  beam.position.set(cx, L.y, cz);
  beam.rotation.y = yaw;
  beam.castShadow = true;
  scene.add(beam);
  // Pylons down to the ground, skipping the road corridor.
  const pylons = [];
  for (let t = lo + 12; t < hi - 8; t += 26) {
    const x = L.x + L.dx * t;
    const z = L.z + L.dz * t;
    if (track.distanceToCenter(x, z) < track.halfWidth + 3) continue;
    const gy = heightAt(x, z);
    const h = L.y - 0.7 - gy;
    if (h < 2) continue;
    pylons.push({ x, z, gy, h });
  }
  if (pylons.length) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1, 1.6), pylonMat, pylons.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    pylons.forEach((py, i) => {
      pv.set(py.x, py.gy + py.h / 2, py.z);
      sv.set(1, py.h, 1);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }
  // The train: engine + cars sliding along the beam, looping with a pause.
  const train = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc94f3d, roughness: 0.6 });
  const carMat = new THREE.MeshStandardMaterial({ color: 0x4f7dc9, roughness: 0.6 });
  const winMat = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, emissive: 0x9fc6e8, emissiveIntensity: 0.5, roughness: 0.3 });
  const CARS = 4;
  for (let cIdx = 0; cIdx < CARS; cIdx++) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.1, 7.2), cIdx === 0 ? bodyMat : carMat);
    body.castShadow = true;
    car.add(body);
    const win = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.7, 5.6), winMat);
    win.position.y = 0.45;
    car.add(win);
    car.position.z = -cIdx * 8.2;
    train.add(car);
  }
  train.rotation.y = yaw;
  scene.add(train);
  const speed = 26;
  const cycle = (len + CARS * 8.2 + 60) / speed + 2.5; // run + a breather
  const phase = rng() * cycle;
  anims.push((time) => {
    const t = ((time + phase) % cycle) * speed;
    const s = lo - CARS * 8.2 + t;
    if (s > hi + 10) {
      train.visible = false;
      return;
    }
    train.visible = true;
    train.position.set(L.x + L.dx * s, L.y + 1.85, L.z + L.dz * s);
  });
}

// ---- Ambience ------------------------------------------------------------------
function buildAmbience(scene, track, feats, heightAt, rng, anims, lakes) {
  // Ducks: on the river (or the first big lake) — drift in lazy circles.
  const water = lakes.find((l) => l.river) || lakes.find((l) => l.ribbon) || lakes[0];
  if (water) {
    const duckBody = new THREE.MeshStandardMaterial({ color: 0xf5efdd, roughness: 0.9 });
    const duckHead = new THREE.MeshStandardMaterial({ color: 0x3e7d3a, roughness: 0.8 });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xf2a63c, roughness: 0.8 });
    const spots = [];
    if (water.ribbon) {
      for (let k = 0; k < 5; k++) {
        const sp = water.spine[Math.floor(rng() * water.spine.length)];
        spots.push({ x: sp.x + (rng() - 0.5) * water.waterR, z: sp.z + (rng() - 0.5) * water.waterR });
      }
    } else {
      for (let k = 0; k < 5; k++) {
        const a = rng() * TAU;
        const r = rng() * water.waterR * 0.7;
        spots.push({ x: water.x + Math.cos(a) * r, z: water.z + Math.sin(a) * r });
      }
    }
    for (const sp of spots) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6).scale(1, 0.7, 1.3), duckBody);
      g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), duckHead);
      head.position.set(0, 0.55, 0.55);
      g.add(head);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 5).rotateX(Math.PI / 2), beakMat);
      beak.position.set(0, 0.5, 0.9);
      g.add(beak);
      scene.add(g);
      const r = 1.5 + rng() * 3;
      const sp2 = 0.14 + rng() * 0.12;
      const ph = rng() * TAU;
      anims.push((time) => {
        const a = time * sp2 + ph;
        g.position.set(sp.x + Math.cos(a) * r, water.level + 0.28 + Math.sin(time * 1.7 + ph) * 0.05, sp.z + Math.sin(a) * r);
        g.rotation.y = a + Math.PI / 2;
      });
    }
  }

  // Goats: still white silhouettes watching from the canyon/shelf rims.
  const rocky = feats.runs.find((r) => r.kind === "canyon" || r.kind === "shelf");
  if (rocky) {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2eee6, roughness: 1 });
    const hornMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.9 });
    const N = track.samples;
    for (let k = 0; k < 3; k++) {
      const i = rocky.i0 + Math.round(((k + 0.5) / 3) * (rocky.i1 - rocky.i0));
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const sgn = rocky.kind === "shelf" ? -rocky.inSign : rng() < 0.5 ? 1 : -1;
      const off = track.halfWidth + 24 + rng() * 18;
      const x = p.x + side.x * sgn * off;
      const z = p.z + side.z * sgn * off;
      if (track.distanceToCenter(x, z) < track.halfWidth + 12) continue;
      const y = heightAt(x, z);
      const parts = [];
      const body = new THREE.BoxGeometry(0.9, 0.8, 1.5).translate(0, 1.05, 0);
      parts.push(body);
      const head = new THREE.BoxGeometry(0.5, 0.55, 0.6).translate(0, 1.6, 0.85);
      parts.push(head);
      for (const s of [0.28, -0.28]) {
        parts.push(new THREE.BoxGeometry(0.22, 0.9, 0.22).translate(s, 0.45, 0.5));
        parts.push(new THREE.BoxGeometry(0.22, 0.9, 0.22).translate(s, 0.45, -0.5));
      }
      const goat = new THREE.Mesh(mergeGeometries(parts), bodyMat);
      goat.castShadow = true;
      const horns = new THREE.Mesh(
        mergeGeometries([
          new THREE.ConeGeometry(0.07, 0.5, 5).translate(-0.16, 2.05, 0.75),
          new THREE.ConeGeometry(0.07, 0.5, 5).translate(0.16, 2.05, 0.75),
        ]),
        hornMat
      );
      const g = new THREE.Group();
      g.add(goat);
      g.add(horns);
      g.position.set(x, y, z);
      g.rotation.y = Math.atan2(p.x - x, p.z - z); // watching the race
      scene.add(g);
    }
  }

  // Mist among the giants: soft drifting sheets between the huge trunks.
  const giant = feats.runs.find((r) => r.kind === "giant");
  if (giant) {
    const tex = lampGlowCanvas();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.16, depthWrite: false, color: 0xdfe9ea });
    const N = track.samples;
    for (let k = 0; k < 6; k++) {
      const i = giant.i0 + Math.round(((k + 0.5) / 6) * (giant.i1 - giant.i0));
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = sideAt(track, idx);
      const dir = k % 2 === 0 ? 1 : -1;
      const off = track.halfWidth + 20 + rng() * 30;
      const x = p.x + side.x * dir * off;
      const z = p.z + side.z * dir * off;
      const y = heightAt(x, z);
      const mist = new THREE.Mesh(new THREE.PlaneGeometry(26, 9), mat);
      mist.position.set(x, y + 6, z);
      mist.renderOrder = 2;
      scene.add(mist);
      const ph = rng() * TAU;
      anims.push((time) => {
        mist.position.x = x + Math.sin(time * 0.11 + ph) * 7;
        mist.position.z = z + Math.cos(time * 0.09 + ph) * 7;
        mist.rotation.y = Math.atan2(0, 1); // keep flat-ish; billboarding skipped for cost
        mist.material.opacity = 0.11 + 0.07 * (0.5 + 0.5 * Math.sin(time * 0.23 + ph));
      });
    }
  }

  // Fish hopping out of the river near the bridge.
  if (feats.river) {
    const fishMat = new THREE.MeshStandardMaterial({ color: 0x9fb6c4, roughness: 0.5 });
    for (let k = 0; k < 2; k++) {
      const i = Math.max(1, Math.min(feats.river.spine.length - 2, feats.river.crossIdx + (k === 0 ? -3 : 3)));
      const sp = feats.river.spine[i];
      const fish = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 6).rotateX(Math.PI / 2), fishMat);
      scene.add(fish);
      const ph = rng() * 6;
      const level = feats.river.level;
      anims.push((time) => {
        const t = (time + ph) % 6;
        if (t > 1.1) {
          fish.visible = false;
          return;
        }
        fish.visible = true;
        const f = t / 1.1;
        fish.position.set(sp.x + f * 2 - 1, level + Math.sin(f * Math.PI) * 2.1, sp.z);
        fish.rotation.z = f * Math.PI * 1.6;
      });
    }
  }
}
