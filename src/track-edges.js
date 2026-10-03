// Roadside EDGE TREATMENTS: what lines the road (the barrier) and what the
// outer strip of the road itself is made of (the verge). Until now every biome
// had exactly one barrier (scenery.js BARRIER_STYLES: a kerb, a timber rail, a
// dry-stone wall or a palisade) for its whole stretch. This module plans the
// edges per SPAN instead — a seeded walk down each side of the lap that keeps
// the biome's default barrier most of the way and swaps in its own
// alternatives for 60-160u at a time (a granite rock face and a boulder row
// in the alpine, a hedge and a line of hay bales in the meadow, a tyre wall
// and concrete blocks in the city, basalt columns in the volcanic…), and lays
// a runoff VERGE (sand, gravel, mud, snow, grass) along the outer few metres
// of some spans, which slows a kart that strays onto it.
//
// The plan is data: track.edges[side][sample] = { style, verge, vergeW }.
// Track._buildWalls sweeps the swept-body kinds from it (the kerb, stone,
// rail, slat and the new rockface / hedge / snowbank / adobe / jersey), and
// buildEdgeExtras() here adds the kinds made of discrete things (boulders,
// tyres, hay bales, logs, sandbags, basalt columns, adobe beams) as instanced
// or merged meshes per world cell. Track.dragAt / barrierAt answer the kart.
//
// Nothing here is the collision surface — kart.js clamps on the projection at
// halfWidth — so a barrier can be as lumpy as it likes. What changes per kind
// is the FEEL of touching it: `scrub` scales the speed a scrape costs (a hedge
// is soft, a rock face is not) and `bounce` kicks the kart back off tyres and
// concrete.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { biomeBarrierStyle, biomeRoadStyle, chunkByCell, fitInstanceBounds } from "./scenery.js";
import { makeRng } from "./rng.js";

// ---- Barrier styles ----------------------------------------------------------
// `kind` picks the builder; the rest is palette + feel. Swept kinds (rockface,
// hedge, snowbank, adobe, jersey) are drawn by Track._buildWalls from the same
// profile as the kerb; the discrete kinds stand on a low sill it sweeps.
const S = (kind, extra) => ({ kind, scrub: 1, bounce: 0, ...extra });
export const EDGE_STYLES = {
  // Cliffs: two or three courses of big angular rocks jumbled on a bedrock sill.
  "rockface.granite": S("rockface", {
    name: "Granite rock face",
    lo: 0x5d6168,
    hi: 0x9a9ea3,
    cap: 0xc9ccd0,
    strata: 0x7a7d83,
    sill: 0x4e5258,
    h: 2.6,
    scrub: 1.3,
  }),
  "rockface.sandstone": S("rockface", {
    name: "Sandstone rock face",
    lo: 0xb08a5c,
    hi: 0xe0c08c,
    cap: 0xf0dcb4,
    strata: 0xc69a62,
    sill: 0x9c7a4e,
    h: 2.4,
    scrub: 1.3,
  }),
  "rockface.redrock": S("rockface", {
    name: "Red rock face",
    lo: 0x8a4a34,
    hi: 0xc9805a,
    cap: 0xe0b48e,
    strata: 0x6f3a2a,
    sill: 0x74402c,
    h: 2.9,
    scrub: 1.3,
  }),
  "rockface.basalt": S("rockface", {
    name: "Basalt rock face",
    lo: 0x2c2d36,
    hi: 0x5a5c68,
    cap: 0x8a8c96,
    strata: 0x3d3f4a,
    sill: 0x26262e,
    h: 2.5,
    scrub: 1.3,
  }),
  "rockface.mossy": S("rockface", {
    name: "Mossy rock face",
    lo: 0x4e5a46,
    hi: 0x8a9a6e,
    cap: 0xb4c48c,
    strata: 0x66705a,
    sill: 0x3f4a3a,
    h: 2.3,
    scrub: 1.3,
  }),
  // Rows of big rocks (discrete, instanced).
  "boulders.granite": S("boulders", {
    name: "Granite boulders",
    lo: 0x6a6e74,
    hi: 0xa3a7ac,
    cap: 0xd0d3d6,
    sill: 0x7d8a6a,
    scrub: 1.3,
  }),
  "boulders.sandstone": S("boulders", {
    name: "Sandstone boulders",
    lo: 0xb58d5e,
    hi: 0xe3c391,
    cap: 0xf2e0bf,
    sill: 0xcdb078,
    scrub: 1.3,
  }),
  "boulders.limestone": S("boulders", {
    name: "Limestone boulders",
    lo: 0xa89c7c,
    hi: 0xd8ccae,
    cap: 0xf0e8d4,
    sill: 0xb09a5c,
    scrub: 1.3,
  }),
  "boulders.snowy": S("boulders", {
    name: "Snow-capped boulders",
    lo: 0x6b7078,
    hi: 0x9aa0a8,
    cap: 0xf2f6f8,
    sill: 0xdfe8ec,
    snowy: true,
    scrub: 1.3,
  }),
  "boulders.mossy": S("boulders", {
    name: "Mossy boulders",
    lo: 0x55624c,
    hi: 0x8a9c6a,
    cap: 0xb8c890,
    sill: 0x3f7a36,
    scrub: 1.3,
  }),
  // Hedges: two rows of rounded bush clumps on a soil sill, flecked with
  // flowers / leaves where the biome has them (fleckRate 0 = plain green).
  "hedge.green": S("hedge", {
    name: "Hedgerow",
    lo: 0x3f7a2e,
    hi: 0x76b24c,
    fleck: 0xf2f0ea,
    fleckRate: 0.15,
    sill: 0x4a3f2c,
    scrub: 0.5,
  }),
  "hedge.lavender": S("hedge", {
    name: "Lavender hedge",
    lo: 0x5e6a4a,
    hi: 0x8e9a6a,
    fleck: 0xa48ed0,
    fleckRate: 0.9,
    sill: 0x4a3f2c,
    scrub: 0.5,
  }),
  "hedge.blossom": S("hedge", {
    name: "Blossom hedge",
    lo: 0x4b7a3a,
    hi: 0x86b864,
    fleck: 0xffb3cf,
    fleckRate: 0.7,
    sill: 0x4a3f2c,
    scrub: 0.5,
  }),
  "hedge.autumn": S("hedge", {
    name: "Autumn hedge",
    lo: 0x8a4a22,
    hi: 0xd4863a,
    fleck: 0xf2c04a,
    fleckRate: 0.5,
    sill: 0x4a3f2c,
    scrub: 0.5,
  }),
  "hedge.reeds": S("hedge", {
    name: "Reed bank",
    lo: 0x7a7a3e,
    hi: 0xb8b068,
    fleck: 0xe0d890,
    fleckRate: 0.4,
    sill: 0x4f7563,
    reeds: true,
    scrub: 0.45,
  }),
  // Snow bank: overlapping soft mounds on a snow sill.
  snowbank: S("snowbank", { name: "Snow bank", lo: 0xc6d6e0, hi: 0xf4f8fa, cap: 0xffffff, sill: 0xe4ecf2, scrub: 0.7 }),
  // Low rounded mud wall with beam ends (swept + merged beams).
  adobe: S("adobe", { name: "Adobe wall", lo: 0xc08e5e, hi: 0xdfb688, cap: 0xecd2b0, beam: 0x6f4a2a, scrub: 1.1 }),
  // Concrete: real jersey-profile blocks, 4u long with a gap between them.
  jersey: S("jersey", {
    name: "Concrete barrier",
    lo: 0x8d9298,
    hi: 0xb4b9bf,
    cap: 0xcfd3d8,
    seam: 0x6c7177,
    sill: 0x6c7177,
    scrub: 1.1,
    bounce: 3,
  }),
  "jersey.striped": S("jersey", {
    name: "Striped concrete barrier",
    lo: 0x8d9298,
    hi: 0xb4b9bf,
    cap: 0xcfd3d8,
    seam: 0x6c7177,
    sill: 0x6c7177,
    stripeA: 0xf2c230,
    stripeB: 0x2b2b2b,
    scrub: 1.1,
    bounce: 3,
  }),
  // Discrete, instanced.
  tyres: S("tyres", {
    name: "Tyre wall",
    lo: 0x2a2b2f,
    paint: [0xf2f0ea, 0xd8463c, 0x3b78c2],
    sill: 0x55585e,
    scrub: 0.9,
    bounce: 6,
  }),
  hay: S("hay", { name: "Hay bale line", lo: 0xd8b753, hi: 0xf0d58a, band: 0x9c7a3a, sill: 0x8a9b6a, scrub: 0.6 }),
  "logs.forest": S("logs", { name: "Log wall", lo: 0x6d4a2a, hi: 0x9a6b3f, end: 0xd6aa65, sill: 0x3f6b32, scrub: 1.0 }),
  "logs.pale": S("logs", {
    name: "Pale log wall",
    lo: 0x8d7a5c,
    hi: 0xb8a583,
    end: 0xe6dcc4,
    sill: 0xd6e0e4,
    scrub: 1.0,
  }),
  "logs.driftwood": S("logs", {
    name: "Driftwood",
    lo: 0xb8a98a,
    hi: 0xe2d6bc,
    end: 0xf2ecdc,
    sill: 0xe6d6a2,
    scrub: 0.9,
  }),
  "logs.jungle": S("logs", {
    name: "Mossy log wall",
    lo: 0x5a5a32,
    hi: 0x8a8a4a,
    end: 0xc8c080,
    sill: 0x2f7a34,
    scrub: 1.0,
  }),
  sandbags: S("sandbags", { name: "Sandbag wall", lo: 0x9a8a5a, hi: 0xc4b48a, sill: 0x8a7a50, scrub: 0.8 }),
  lava: S("lava", {
    name: "Basalt columns",
    lo: 0x26262e,
    hi: 0x4a4a56,
    top: 0x6a6878,
    glow: 0xff7a2a,
    sill: 0x3a3238,
    scrub: 1.3,
  }),
};
export const EDGE_STYLE_KEYS = Object.keys(EDGE_STYLES);

// Runoff verges: the outer strip of the road itself. `drag` is the speed lost
// per second on it (speed *= 1 - drag·dt), `w` the strip width in metres.
export const VERGE_KINDS = {
  sand: { name: "Sand", color: 0xd8c48e, speck: 0xb59f6a, drag: 0.9, w: 3.6 },
  gravel: { name: "Gravel", color: 0x8e8a80, speck: 0x5d5a52, drag: 0.6, w: 3.4 },
  mud: { name: "Mud", color: 0x5e4c38, speck: 0x3e3224, drag: 1.1, w: 3.4 },
  snow: { name: "Snow", color: 0xeef3f6, speck: 0xc8d8e2, drag: 0.8, w: 3.8 },
  grass: { name: "Grass", color: 0x6f9d4f, speck: 0x4f7d36, drag: 0.45, w: 3.2 },
};

// Per-biome palette: the alternatives a biome mixes in beside its default
// barrier, and the verges it lays.
export const BIOME_EDGES = {
  meadow: { barriers: ["hedge.green", "hay", "boulders.limestone"], verges: ["grass"] },
  lavender: { barriers: ["hedge.lavender", "hay", "boulders.limestone"], verges: ["grass"] },
  blossom: { barriers: ["hedge.blossom", "boulders.mossy"], verges: ["grass"] },
  autumn: { barriers: ["hedge.autumn", "hay", "logs.forest"], verges: ["grass", "mud"] },
  forest: { barriers: ["logs.forest", "boulders.granite", "rockface.mossy"], verges: ["mud", "grass"] },
  alpine: { barriers: ["rockface.granite", "boulders.granite", "snowbank"], verges: ["snow", "gravel"] },
  tundra: { barriers: ["snowbank", "boulders.snowy", "logs.pale"], verges: ["snow"] },
  desert: { barriers: ["adobe", "rockface.sandstone", "boulders.sandstone"], verges: ["sand"] },
  mesa: { barriers: ["rockface.redrock", "boulders.sandstone", "adobe"], verges: ["sand", "gravel"] },
  savanna: { barriers: ["boulders.limestone", "hay", "adobe"], verges: ["sand", "grass"] },
  beach: { barriers: ["logs.driftwood", "sandbags", "boulders.limestone"], verges: ["sand"] },
  jungle: { barriers: ["rockface.mossy", "logs.jungle", "boulders.mossy"], verges: ["mud"] },
  wetlands: { barriers: ["sandbags", "logs.forest", "hedge.reeds"], verges: ["mud"] },
  city: { barriers: ["jersey", "tyres", "jersey.striped"], verges: ["gravel"] },
  volcanic: { barriers: ["lava", "rockface.basalt", "tyres"], verges: ["gravel"] },
};

// ---- Bays (lay-bys) -----------------------------------------------------------
// A bay widens the road on one side for a stretch: a paved apron outside the
// lane where a market stall, a café's tables or a vendor's barrow can stand
// without being in the road, the way real roads host them. The barrier, sand
// trim, verges and edge extras all step out with it (track._extra[side][i] is
// the extra half-width per sample, a cosine ramp in and out), the kart's
// containment and the props' fence read the same numbers, and props.js
// parks its scenes IN the bays. Planned in the roadside's town zones (so a
// stall sits where the buildings are) plus the odd rural one.
//
// A bay is a GRADUAL, SHALLOW widening (5-6.5u over a 66-90u span, the
// tapers 40% of the span each, so the edge never steepens past ~20°) — a
// lay-by the kart drifts into and out of, not a bite out of the road edge.
// The first version was 12-15u deep with 8u tapers: driving in meant a wall
// at the end, and the barriers around the cut read as broken.
const BAY_RAMP = 24; // minimum taper at each end, in metres (grows with the span)
export function planBays(track, config) {
  const N = track.samples;
  const perU = N / track.length;
  const extra = [new Float32Array(N), new Float32Array(N)];
  const bays = [];
  const runs = (track.features?.runs || []).filter((r) => STRUCTURAL_RUNS.has(r.kind));
  const loopDist = (a, b) => {
    const d = Math.abs(a - b) % N;
    return Math.min(d, N - d);
  };
  const clear = (c, half, gap) =>
    c > 0.05 * N &&
    c < 0.95 * N &&
    !runs.some((r) => loopDist(c, ((r.c % N) + N) % N) < r.half + half + Math.round(10 * perU)) &&
    !bays.some((b) => loopDist(c, b.c) < b.half + half + Math.round(gap * perU));
  const add = (c, side, len, depth, kind, gap = 30) => {
    const half = Math.round((len / 2) * perU);
    if (!clear(c, half, gap)) return false;
    const i0 = c - half,
      i1 = c + half;
    const rampU = Math.max(BAY_RAMP, len * 0.4);
    const ramp = Math.round(rampU * perU);
    // `plateau`: the flat, full-depth middle the scene has to stand on.
    bays.push({ c, side, i0, i1, half, len, depth, kind, t: c / N, plateau: Math.max(8, len - 2 * rampU) });
    for (let i = i0; i <= i1; i++) {
      const k = i - i0,
        m = i1 - i;
      const f = Math.min(1, k / ramp, m / ramp);
      extra[side][((i % N) + N) % N] = depth * (f * f * (3 - 2 * f));
    }
    return true;
  };
  if (Array.isArray(config?.bays)) {
    for (const b of config.bays)
      add(
        Math.round((((b.t % 1) + 1) % 1) * N),
        b.side === "left" ? 1 : 0,
        b.len || 66,
        b.depth || 5,
        b.kind || "stall",
      );
  } else if (config?.bays === "tour") {
    // The biome tour: a bay every 78u, sides alternating, a little deeper
    // every third one so the larger scenes get a spot.
    let k = 0;
    for (let u = 30; u < track.length - 82; u += 78, k++)
      add(Math.round(u * perU), k % 2, 72, k % 3 === 2 ? 6.5 : 5, "stall", 2);
  } else if (config?.bays !== false) {
    // A race: the roadside's town zones are where the buildings are (six
    // angular zones, every other one a town) — one bay in each, placed in the
    // zone's first half where the houses stand, plus one rural bay somewhere
    // in a field zone at half odds. Own rng stream: never shifts the scenery.
    const rng = makeRng(String(config?.seed || "classic") + "|bays");
    const zones = 6;
    // Two bays per town zone (one in each half of it, where the houses
    // stand) — a town reads as a town when there are a few places to smash
    // along its street; the spacing guard in `clear` keeps them apart on a
    // short lap.
    const halves = [
      [0.1, 0.45],
      [0.55, 0.9],
    ];
    for (let z = 0; z < zones; z += 2)
      for (const [lo, hi] of halves)
        for (let attempt = 0; attempt < 5; attempt++) {
          const t = (z + lo + rng() * (hi - lo)) / zones;
          if (add(Math.round(t * N), rng() < 0.5 ? 0 : 1, 72 + rng() * 24, rng() < 0.4 ? 6.5 : 5, "town")) break;
        }
    if (rng() < 0.5)
      for (let attempt = 0; attempt < 4; attempt++) {
        const z = 1 + 2 * Math.floor(rng() * (zones / 2));
        const t = (z + 0.2 + rng() * 0.6) / zones;
        if (add(Math.round(t * N), rng() < 0.5 ? 0 : 1, 60, 4.5, "rural")) break;
      }
  }
  return { bays, extra };
}
const STRUCTURAL_RUNS = new Set(["tunnel", "bridge", "causeway", "dam", "canyon", "overpass", "crossover", "shelf"]);

// The bay aprons: a paved strip from the lane edge out to the widened edge,
// in a paving tone off the biome's road tint (concrete slabs in the city,
// packed earth / flagstones elsewhere) with a dark seam grid so it reads as
// laid, not painted. Sits on the road's own height.
export function buildBays(track) {
  if (!track.bays.length) return null;
  const N = track.samples;
  const positions = [],
    colors = [],
    indices = [];
  const c = new THREE.Color(),
    base = new THREE.Color(0x585860);
  for (const b of track.bays) {
    const dirSign = b.side === 0 ? 1 : -1;
    let prev = null;
    for (let i = b.i0; i <= b.i1; i++) {
      const idx = ((i % N) + N) % N;
      const ex = track._extra[b.side][idx];
      const p = track._pts[idx],
        sd = track._sideAt(idx);
      const sx = sd.x * dirSign,
        sz = sd.z * dirSign;
      const style = biomeRoadStyle(p.x, p.z);
      const urban = style.kind === "urban";
      const along = (idx * track.length) / N;
      const seam = Math.abs(((along % 3.2) + 3.2) % 3.2) < 0.22;
      const basePt = positions.length / 3;
      for (const [lat, f] of [
        [track.halfWidth - 0.3, 0],
        [track.halfWidth + ex * 0.5, 0.5],
        [track.halfWidth + ex + 0.35, 1],
      ]) {
        positions.push(p.x + sx * lat, p.y + 0.028, p.z + sz * lat);
        c.setRGB(base.r * style.tint[0], base.g * style.tint[1], base.b * style.tint[2]);
        c.multiplyScalar(urban ? 1.55 : 1.32); // paving: paler than the lane
        if (!urban) c.lerp(new THREE.Color(0xa08a68), 0.35); // flagstone / packed earth
        if (seam || (f === 0.5 && hash(idx, 7) > 0.5)) c.multiplyScalar(0.82);
        colors.push(c.r, c.g, c.b);
      }
      if (prev !== null)
        for (let j = 0; j < 2; j++)
          indices.push(prev + j, basePt + j, prev + j + 1, prev + j + 1, basePt + j, basePt + j + 1);
      prev = basePt;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, side: THREE.DoubleSide }),
  );
  mesh.receiveShadow = true;
  mesh.userData.bays = true;
  track.group.add(mesh);
  return mesh;
}

// ---- Planner -------------------------------------------------------------------
// track.edges[0] is the +lateral side (dirSign 1 in _buildWalls), [1] the other.
// config.edges (the playground) is an explicit list of spans:
//   { t0, t1, side: "left" | "right" | "both", barrier?: styleKey, verge?: kind }
// where "right" is the +lateral side. Otherwise a seeded walk per side.
export function planEdges(track, config) {
  const N = track.samples;
  const names = track.biomeNames || new Array(N).fill("meadow");
  const def = (i) => {
    const p = track._pts[i];
    return biomeBarrierStyle(p.x, p.z);
  };
  const sides = [[], []];
  for (let s = 0; s < 2; s++) for (let i = 0; i < N; i++) sides[s].push({ style: def(i), verge: null, vergeW: 0 });
  // "tour" (the playground's biome tour): every biome stretch shows its stock
  // barrier then each of its alternatives down the left, and its stock barrier
  // with each of its verges down the right — the whole catalogue in context.
  if (config && config.edges === "tour") {
    let i = 0;
    while (i < N) {
      const biome = names[i];
      let end = i;
      while (end < N && names[end] === biome) end++;
      const pal = BIOME_EDGES[biome] || { barriers: [], verges: [] };
      const left = [null, ...pal.barriers];
      const right = [null, ...pal.verges];
      for (let k = i; k < end; k++) {
        const f = (k - i) / Math.max(1, end - i);
        const alt = left[Math.min(left.length - 1, Math.floor(f * left.length))];
        if (alt) sides[1][k].style = EDGE_STYLES[alt];
        const verge = right[Math.min(right.length - 1, Math.floor(f * right.length))];
        if (verge) {
          sides[0][k].verge = verge;
          sides[0][k].vergeW = VERGE_KINDS[verge].w;
        }
      }
      i = end;
    }
    return sides;
  }
  if (config && Array.isArray(config.edges)) {
    for (const e of config.edges) {
      const i0 = Math.round((((e.t0 % 1) + 1) % 1) * N),
        i1 = Math.round((((e.t1 % 1) + 1) % 1) * N);
      const list = e.side === "both" ? [0, 1] : e.side === "left" ? [1] : [0];
      for (const s of list)
        for (let i = i0; i !== i1; i = (i + 1) % N) {
          const cell = sides[s][i];
          if (e.barrier) cell.style = EDGE_STYLES[e.barrier] || cell.style;
          if (e.verge) {
            cell.verge = e.verge;
            cell.vergeW = VERGE_KINDS[e.verge]?.w || 3.4;
          }
          if (i === (i1 - 1 + N) % N) break;
        }
    }
    return sides;
  }
  const rng = makeRng(String((config && config.seed) || "classic") + "|edges");
  const perU = N / track.length; // samples per metre
  for (let s = 0; s < 2; s++) {
    let i = Math.round(rng() * 40);
    while (i < N) {
      const biome = names[i];
      const pal = BIOME_EDGES[biome];
      const len = Math.round((60 + rng() * 100) * perU);
      // The span ends at a biome seam: a hedge never crosses into the desert.
      let end = Math.min(N, i + len);
      for (let k = i; k < end; k++)
        if (names[k] !== biome) {
          end = k;
          break;
        }
      const alt = pal && rng() < 0.45 ? EDGE_STYLES[pal.barriers[Math.floor(rng() * pal.barriers.length)]] : null;
      const verge = pal && rng() < 0.3 ? pal.verges[Math.floor(rng() * pal.verges.length)] : null;
      for (let k = i; k < end; k++) {
        const cell = sides[s][k];
        if (alt) cell.style = alt;
        if (verge) {
          cell.verge = verge;
          cell.vergeW = VERGE_KINDS[verge].w;
        }
      }
      i = Math.max(end, i + 1);
    }
  }
  return sides;
}

// ---- Discrete-kind builders -------------------------------------------------------
// Deterministic jitter off a hash (never the seeded rng): the same plan
// rebuilds the same wall every time, whatever else drew random numbers.
const hash = (a, b) => {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return n - Math.floor(n);
};
const _c = new THREE.Color(),
  _c2 = new THREE.Color();

// A rock: a low-poly icosahedron with per-vertex radial noise, FLAT shaded
// (non-indexed, so every facet keeps its own normal) — angular stone, not a
// lumpy balloon. `detail` 0 is a 20-facet boulder, 1 a rounder 80-facet one.
function rockGeo(seed, detail = 1, squash = 0.82) {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const p = g.attributes.position;
  // Jitter per UNIQUE vertex position (hash of the position itself) so the
  // facets stay welded while the silhouette breaks up.
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n =
      0.74 +
      0.4 * hash(seed + Math.round(x * 100) * 0.031 + 7, Math.round(y * 100) * 0.027 + Math.round(z * 100) * 0.019);
    p.setXYZ(i, x * n, y * n * squash, z * n);
  }
  g.computeVertexNormals();
  return g;
}
// A soft clump (bush, snow mound): smooth-shaded, gently irregular.
function clumpGeo(seed, squash = 0.85) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n = 0.86 + 0.2 * hash(seed + x * 2.1 + 3, y * 1.7 + z * 1.3);
    p.setXYZ(i, x * n, y * n * squash, z * n);
  }
  g.computeVertexNormals();
  return g;
}
// Jersey barrier block: the real profile (wide kicked base, sloped faces,
// narrow top), extruded 3.9u along the road, flat shaded.
function jerseyGeo() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.46, 0);
  shape.lineTo(0.46, 0);
  shape.lineTo(0.46, 0.16);
  shape.lineTo(0.32, 0.36);
  shape.lineTo(0.16, 1.2);
  shape.lineTo(0.1, 1.28);
  shape.lineTo(-0.1, 1.28);
  shape.lineTo(-0.16, 1.2);
  shape.lineTo(-0.32, 0.36);
  shape.lineTo(-0.46, 0.16);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 3.7, bevelEnabled: false }).toNonIndexed();
  g.translate(0, 0, -1.85);
  g.computeVertexNormals();
  // Bake shading into the vertex colour (the instance colour multiplies it):
  // a grimy foot, a lighter top, and darker end faces so the joints read.
  const p = g.attributes.position,
    n = g.attributes.normal,
    cols = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    let v = y < 0.36 ? 0.72 : y > 1.19 ? 1.08 : 0.92 + y * 0.1;
    if (Math.abs(n.getZ(i)) > 0.9) v *= 0.8; // the block's end faces
    cols.set([v, v, v], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return g;
}

// Walk a side's plan, calling `fn(i, cell, p, sx, sz, tan)` for every sample
// whose style is `kind`; the discrete kinds place things between samples.
function eachSample(track, side, kind, fn) {
  const N = track.samples,
    dirSign = side === 0 ? 1 : -1;
  for (let i = 0; i < N; i++) {
    const cell = track.edges[side][i];
    if (cell.style.kind !== kind) continue;
    const p = track._pts[i],
      s = track._sideAt(i);
    fn(i, cell, p, s.x * dirSign, s.z * dirSign, track._tans[i], track._extra ? track._extra[side][i] : 0);
  }
}

// Place `n` things along the segment from sample i to i+1, at the wall line.
function alongSegment(track, i, p, sx, sz, off, spacing, fn) {
  const N = track.samples;
  const q = track._pts[(i + 1) % N];
  const seg = Math.hypot(q.x - p.x, q.z - p.z);
  const per = Math.max(1, Math.round(seg / spacing));
  for (let k = 0; k < per; k++) {
    const t = k / per;
    fn(p.x + (q.x - p.x) * t + sx * off, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t + sz * off, i * 7 + k);
  }
}

function instanced(group, geo, items, tag, cell = 160) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: !!geo.attributes.color,
    roughness: 0.92,
    flatShading: !geo.index, // non-indexed = the angular kinds (rocks, blocks)
  });
  const m = new THREE.Matrix4(),
    q = new THREE.Quaternion(),
    e = new THREE.Euler(),
    v = new THREE.Vector3(),
    t = new THREE.Vector3();
  for (const chunk of chunkByCell(items, cell)) {
    const mesh = new THREE.InstancedMesh(geo, mat, chunk.length);
    chunk.forEach((it, k) => {
      e.set(it.pitch || 0, it.yaw || 0, it.roll || 0, "YXZ");
      q.setFromEuler(e);
      m.compose(t.set(it.x, it.y, it.z), q, v.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1));
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, _c.set(it.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    fitInstanceBounds(mesh);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData.barrier = tag;
    group.add(mesh);
  }
}

export function buildEdgeExtras(track) {
  const group = track.group;
  const off = track.halfWidth + 0.8;
  const white = new THREE.Float32BufferAttribute();
  const tintGeo = (g) => {
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return g;
  };

  // Boulders: 4 angular rock variants, scaled 1.1-2.0, overlapping so the
  // row is solid; snowy ones get a white top by colour.
  const rocks = [0, 1, 2, 3].map((k) => tintGeo(rockGeo(k * 17.3, k % 2)));
  const rockItems = [[], [], [], []];
  for (const side of [0, 1])
    eachSample(track, side, "boulders", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.9, 1.6, (x, y, z, seed) => {
        const h1 = hash(seed, 1),
          h2 = hash(seed, 2);
        const s = 1.1 + h1 * 0.9;
        _c.set(st.lo).lerp(_c2.set(st.hi), h2);
        if (st.snowy && h2 > 0.4) _c.lerp(_c2.set(st.cap), 0.5);
        rockItems[seed % 4].push({
          x,
          y: y + s * 0.62,
          z,
          yaw: hash(seed, 3) * 6.28,
          roll: (hash(seed, 6) - 0.5) * 0.5,
          sx: s * (0.9 + hash(seed, 4) * 0.5),
          sy: s * (0.8 + hash(seed, 7) * 0.4),
          sz: s,
          color: _c.getHex(),
        });
      });
    });
  rocks.forEach((g, k) => rockItems[k].length && instanced(group, g, rockItems[k], "boulders"));

  // Rock faces: a cliff jumbled from three courses of big angular blocks —
  // the bottom course largest and most forward, the courses above set back
  // and tinted by strata, the top course sparse and pale (weathered), so
  // the skyline breaks up instead of running level like a wall.
  const cliffItems = [[], [], [], []];
  for (const side of [0, 1])
    eachSample(track, side, "rockface", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      const H = st.h || 2.5;
      alongSegment(track, i, p, sx, sz, off + ex + 1.3, 1.9, (x, y, z, seed) => {
        const courses = [
          { s: 1.8 + hash(seed, 1) * 0.8, back: 0, y: 0, col: null, keep: 1 },
          { s: 1.2 + hash(seed, 2) * 0.6, back: 0.55, y: H * 0.5, col: st.strata, keep: 1 },
          { s: 0.9 + hash(seed, 3) * 0.6, back: 0.95, y: H * 0.9, col: st.cap, keep: hash(seed, 4) > 0.35 ? 1 : 0 },
        ];
        courses.forEach((c, k) => {
          if (!c.keep) return;
          _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 5 + k));
          if (c.col) _c.lerp(_c2.set(c.col), 0.5);
          cliffItems[(seed + k) % 4].push({
            x: x + sx * c.back,
            y: y + c.y + c.s * 0.55,
            z: z + sz * c.back,
            yaw: hash(seed, 8 + k) * 6.28,
            roll: (hash(seed, 11 + k) - 0.5) * 0.4,
            sx: c.s * (1.0 + hash(seed, 14 + k) * 0.5),
            sy: c.s * (0.75 + hash(seed, 17 + k) * 0.5),
            sz: c.s * (0.9 + hash(seed, 20 + k) * 0.4),
            color: _c.getHex(),
          });
        });
      });
    });
  rocks.forEach((g, k) => cliffItems[k].length && instanced(group, g, cliffItems[k], "rockface"));

  // Hedges: two rows of bush clumps (the back row taller) on a soil sill,
  // with flower / leaf flecks dotted over the surface (reeds for the bank).
  const bushes = [0, 1, 2].map((k) => tintGeo(clumpGeo(k * 23.7)));
  const bushItems = [[], [], []];
  const fleck = tintGeo(new THREE.IcosahedronGeometry(0.16, 0));
  const fleckItems = [];
  const reed = tintGeo(new THREE.CylinderGeometry(0.03, 0.05, 1, 5).translate(0, 0.5, 0));
  const reedItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "hedge", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.85, 1.25, (x, y, z, seed) => {
        for (let r = 0; r < 2; r++) {
          const s = (r ? 1.25 : 1.0) + hash(seed, 1 + r) * 0.4;
          _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 3 + r));
          const bx = x + sx * r * 0.9 + tan.x * (r ? 0.6 : 0),
            bz = z + sz * r * 0.9 + tan.z * (r ? 0.6 : 0);
          const by = y + s * 0.55 + (r ? 0.25 : 0);
          bushItems[(seed + r) % 3].push({
            x: bx,
            y: by,
            z: bz,
            yaw: hash(seed, 5 + r) * 6.28,
            sx: s * 1.15,
            sy: s,
            sz: s,
            color: _c.getHex(),
          });
          if (st.reeds) {
            for (let k = 0; k < 4; k++)
              reedItems.push({
                x: bx + (hash(seed, 30 + k + r * 4) - 0.5) * s * 1.2,
                y: y + 0.1,
                z: bz + (hash(seed, 40 + k + r * 4) - 0.5) * s * 1.2,
                roll: (hash(seed, 50 + k) - 0.5) * 0.3,
                pitch: (hash(seed, 60 + k) - 0.5) * 0.3,
                sy: 1.6 + hash(seed, 70 + k) * 1.2,
                color: hash(seed, 80 + k) > 0.5 ? st.hi : st.fleck,
              });
          } else if (st.fleckRate && hash(seed, 7 + r) < st.fleckRate) {
            const n = 2 + Math.floor(hash(seed, 9 + r) * 4);
            for (let k = 0; k < n; k++) {
              const a = hash(seed, 12 + k + r * 7) * 6.28,
                e = 0.3 + hash(seed, 19 + k + r * 7) * 0.9;
              fleckItems.push({
                x: bx + Math.cos(a) * s * 1.05 * Math.sin(e),
                y: by + s * Math.cos(e) * 0.95,
                z: bz + Math.sin(a) * s * 0.95 * Math.sin(e),
                s: 0.8 + hash(seed, 26 + k) * 0.6,
                color: st.fleck,
              });
            }
          }
        }
      });
    });
  bushes.forEach((g, k) => bushItems[k].length && instanced(group, g, bushItems[k], "hedge"));
  if (fleckItems.length) instanced(group, fleck, fleckItems, "hedge-flecks");
  if (reedItems.length) instanced(group, reed, reedItems, "reeds");

  // Snow bank: overlapping soft mounds, wider than tall, a blue shadow tint on
  // the front ones so the drift reads as depth rather than one white strip.
  const mound = tintGeo(clumpGeo(41.2, 0.6));
  const moundItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "snowbank", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 1.2, 1.5, (x, y, z, seed) => {
        for (let r = 0; r < 2; r++) {
          const s = (r ? 1.7 : 1.3) + hash(seed, 1 + r) * 0.6;
          _c.set(st.hi).lerp(_c2.set(st.lo), r ? 0.08 : 0.3 + hash(seed, 3) * 0.2);
          moundItems.push({
            x: x + sx * r * 1.1 + tan.x * (r ? 0.75 : 0),
            y: y + s * 0.3 + (r ? 0.35 : 0),
            z: z + sz * r * 1.1 + tan.z * (r ? 0.75 : 0),
            yaw: hash(seed, 5 + r) * 6.28,
            sx: s * 1.3,
            sy: s * (0.75 + hash(seed, 7 + r) * 0.3),
            sz: s,
            color: _c.getHex(),
          });
        }
      });
    });
  if (moundItems.length) instanced(group, mound, moundItems, "snowbank");

  // Concrete: jersey blocks laid end to end with a 0.2u gap, each tinted a
  // touch differently; the striped variant alternates yellow / black blocks.
  const block = jerseyGeo(); // carries its own shading tint
  const blockItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "jersey", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.7, 4.1, (x, y, z, seed) => {
        const n = Math.floor(hash(seed, 1) * 1000);
        let col;
        if (st.stripeA) col = n % 2 ? st.stripeA : st.stripeB;
        else col = _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 2)).getHex();
        // A degree or two of yaw per block, and the odd one nudged out of
        // line: a row of blocks dropped by a crew, not one extruded ribbon.
        blockItems.push({
          x: x + sx * (hash(seed, 3) - 0.5) * 0.14,
          y,
          z: z + sz * (hash(seed, 3) - 0.5) * 0.14,
          yaw: Math.atan2(tan.x, tan.z) + (hash(seed, 4) - 0.5) * 0.05,
          color: col,
        });
      });
    });
  if (blockItems.length) instanced(group, block, blockItems, "jersey");

  // Tyres: flat stacks two or three high, every ~7th painted.
  const tyre = tintGeo(new THREE.TorusGeometry(0.58, 0.26, 6, 10).rotateX(Math.PI / 2));
  const tyreItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "tyres", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.7, 1.25, (x, y, z, seed) => {
        const rows = 2 + (hash(seed, 1) > 0.55 ? 1 : 0);
        for (let r = 0; r < rows; r++) {
          const painted = hash(seed, 2 + r) > 0.86;
          tyreItems.push({
            x: x + (hash(seed, 5 + r) - 0.5) * 0.12,
            y: y + 0.27 + r * 0.5,
            z: z + (hash(seed, 8 + r) - 0.5) * 0.12,
            yaw: hash(seed, 11 + r) * 6.28,
            color: painted ? st.paint[seed % st.paint.length] : st.lo,
          });
        }
      });
    });
  if (tyreItems.length) instanced(group, tyre, tyreItems, "tyres");

  // Hay bales: lying along the road, a band around each.
  const bale = tintGeo(new THREE.CylinderGeometry(0.8, 0.8, 1.55, 10).rotateZ(Math.PI / 2));
  const hayItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "hay", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.95, 1.7, (x, y, z, seed) => {
        _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 1));
        hayItems.push({
          x,
          y: y + 0.8,
          z,
          yaw: Math.atan2(tan.x, tan.z) + Math.PI / 2 + (hash(seed, 2) - 0.5) * 0.25,
          roll: (hash(seed, 3) - 0.5) * 0.2,
          color: _c.getHex(),
        });
      });
    });
  if (hayItems.length) instanced(group, bale, hayItems, "hay");

  // Logs: three staggered courses lying along the road.
  const log = tintGeo(new THREE.CylinderGeometry(0.3, 0.33, 3.3, 8).rotateZ(Math.PI / 2));
  const logItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "logs", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.75, 3.0, (x, y, z, seed) => {
        for (let r = 0; r < 3; r++) {
          _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 1 + r));
          const shift = (r % 2) * 1.5;
          logItems.push({
            x: x + tan.x * shift,
            y: y + 0.32 + r * 0.56,
            z: z + tan.z * shift,
            yaw: Math.atan2(tan.x, tan.z) + Math.PI / 2 + (hash(seed, 4 + r) - 0.5) * 0.08,
            color: _c.getHex(),
          });
        }
      });
    });
  if (logItems.length) instanced(group, log, logItems, "logs");

  // Sandbags: four staggered courses of fat pillow-shaped bags (a squashed
  // sphere, smooth shaded), each slumped a little differently.
  const bag = tintGeo(new THREE.IcosahedronGeometry(1, 2).scale(0.52, 0.2, 0.32));
  const bagItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "sandbags", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.7, 1.0, (x, y, z, seed) => {
        for (let r = 0; r < 4; r++) {
          _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 1 + r));
          const shift = (r % 2) * 0.5;
          bagItems.push({
            x: x + tan.x * shift + sx * (hash(seed, 9 + r) - 0.5) * 0.12,
            y: y + 0.19 + r * 0.34,
            z: z + tan.z * shift + sz * (hash(seed, 9 + r) - 0.5) * 0.12,
            yaw: Math.atan2(tan.x, tan.z) + Math.PI / 2 + (hash(seed, 5 + r) - 0.5) * 0.3,
            roll: (hash(seed, 13 + r) - 0.5) * 0.25,
            sx: 1 + hash(seed, 17 + r) * 0.25,
            sy: 1 + hash(seed, 21 + r) * 0.3,
            sz: 1,
            color: _c.getHex(),
          });
        }
      });
    });
  if (bagItems.length) instanced(group, bag, bagItems, "sandbags");

  // Basalt columns: tightly packed hexagonal prisms of varied height, two rows.
  const column = tintGeo(new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0));
  const colItems = [];
  for (const side of [0, 1])
    eachSample(track, side, "lava", (i, cell, p, sx, sz, tan, ex) => {
      const st = cell.style;
      alongSegment(track, i, p, sx, sz, off + ex + 0.65, 0.88, (x, y, z, seed) => {
        for (let r = 0; r < 2; r++) {
          const h = 1.1 + hash(seed, 1 + r) * 1.4 + (r ? 0.5 : 0);
          const hot = hash(seed, 4 + r) > 0.9;
          _c.set(st.lo).lerp(_c2.set(st.hi), hash(seed, 2 + r));
          if (hot) _c.lerp(_c2.set(st.glow), 0.35);
          colItems.push({
            x: x + sx * r * 0.85 + tan.x * (r ? 0.44 : 0),
            y,
            z: z + sz * r * 0.85 + tan.z * (r ? 0.44 : 0),
            yaw: hash(seed, 3) * 1.05,
            sy: h,
            color: _c.getHex(),
          });
        }
      });
    });
  if (colItems.length) instanced(group, column, colItems, "lava");

  // Adobe beam ends poking out of the wall near the top, every ~3u.
  const beamGeos = [];
  for (const side of [0, 1])
    eachSample(track, side, "adobe", (i, cell, p, sx, sz, tan, ex) => {
      if (i % 2) return;
      const st = cell.style;
      const g = new THREE.BoxGeometry(0.22, 0.22, 1.1);
      const n = g.attributes.position.count,
        cols = new Float32Array(n * 3);
      _c.set(st.beam);
      for (let k = 0; k < n; k++) cols.set([_c.r, _c.g, _c.b], k * 3);
      g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      g.rotateY(Math.atan2(sx, sz));
      const d = off + ex + 0.55;
      g.translate(p.x + sx * d, p.y + 1.1, p.z + sz * d);
      beamGeos.push(g);
    });
  if (beamGeos.length) {
    const mesh = new THREE.Mesh(
      mergeGeometries(beamGeos),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    );
    mesh.castShadow = true;
    mesh.userData.barrier = "beams";
    group.add(mesh);
  }
  void white;
}

// Verge decal strips: the outer `vergeW` of the road on spans that have one,
// a jagged inner edge and speckle so it reads as loose stuff, not paint.
export function buildVerges(track) {
  const N = track.samples;
  const positions = [],
    colors = [],
    indices = [];
  const c = new THREE.Color(),
    sp = new THREE.Color();
  for (const side of [0, 1]) {
    const dirSign = side === 0 ? 1 : -1;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const idx = i % N;
      const cell = track.edges[side][idx];
      if (!cell.verge) {
        prev = null;
        continue;
      }
      const kind = VERGE_KINDS[cell.verge];
      const p = track._pts[idx],
        s = track._sideAt(idx);
      const sx = s.x * dirSign,
        sz = s.z * dirSign;
      const ex = track._extra ? track._extra[side][idx] : 0;
      const inner = track.halfWidth + ex - cell.vergeW * (0.82 + hash(idx, 9) * 0.3);
      const outer = track.halfWidth + ex + 0.45;
      const base = positions.length / 3;
      c.set(kind.color);
      sp.set(kind.speck);
      for (const [lat, shade] of [
        [inner, 0.96],
        [inner + (outer - inner) * 0.5, 1],
        [outer, 0.9],
      ]) {
        positions.push(p.x + sx * lat, p.y + 0.05, p.z + sz * lat);
        const k = hash(idx * 3 + lat, 5) > 0.72 ? 1 : 0;
        const col = k ? sp : c;
        colors.push(col.r * shade, col.g * shade, col.b * shade);
      }
      if (prev !== null) {
        for (let j = 0; j < 2; j++)
          indices.push(prev + j, base + j, prev + j + 1, prev + j + 1, base + j, base + j + 1);
      }
      prev = base;
    }
  }
  if (!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.renderOrder = 1; // road overlay: Track applies the depth bias to this set
  mesh.receiveShadow = true;
  mesh.userData.verge = true;
  track.group.add(mesh);
  return mesh;
}
