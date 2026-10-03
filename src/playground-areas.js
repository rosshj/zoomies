// The feature playground's test areas (playground.html). Each area is a small
// closed loop authored as explicit control points, plus everything staged on
// it: breakable structures and road props (props.js layouts), raised surface
// features (track-surface.js) and floating power-up boxes. Positions are given
// in TRACK coordinates — `t` (lap fraction) + `lateral` (metres off the
// centreline, + = the loop's right-hand side) — and resolved to world space
// against the built track by playground.js, so an area can be reshaped without
// re-plotting every object.
import { ROAD_PROPS } from "./road-prop-assets.js";
import { BREAKABLES, BIOME_SCENES, SIZE_LABELS } from "./breakables.js";
import { EDGE_STYLES, EDGE_STYLE_KEYS, VERGE_KINDS, BIOME_EDGES } from "./track-edges.js";
import { ROAD_PROP_BIOMES } from "./road-prop-assets.js";

// A rounded-rectangle loop: two straights of 2*halfLen along X joined by
// semicircles of `radius`. Straights are where the test stations go (a kart
// approaches at full pace, in a straight line), the ends just turn it round.
// Points are [x, z, y]; the lap starts mid-way down the first straight.
function roundedLoop(halfLen, radius, straightPts = 5, arcPts = 5) {
  const pts = [];
  const straight = (z, dir) => {
    for (let i = 0; i < straightPts; i++) {
      const f = (i + 0.5) / straightPts;
      pts.push([dir * (-halfLen + f * 2 * halfLen), z, 0]);
    }
  };
  const arc = (cx, a0) => {
    for (let i = 1; i < arcPts; i++) {
      const a = a0 + (i / arcPts) * Math.PI;
      pts.push([cx + Math.cos(a) * radius, Math.sin(a) * radius, 0]);
    }
  };
  straight(-radius, 1); // first straight, +x direction (z = -radius)
  arc(halfLen, -Math.PI / 2); // right-hand end
  straight(radius, -1); // back straight, -x direction
  arc(-halfLen, Math.PI / 2); // left-hand end
  return pts;
}

// Lap-fraction helpers for the rounded loops above: the first straight runs
// t ∈ [0, S), the back straight t ∈ [0.5, 0.5 + S) where S is the straight's
// share of the lap. Stations are spaced along those.
const loopShare = (halfLen, radius) => (2 * halfLen) / (4 * halfLen + 2 * Math.PI * radius);

// The biome tour: ONE biome at a time, a small loop entirely inside it with
// everything the biome owns — its terrain, trees, grass and flowers, its
// buildings, landmarks and set pieces, its animals, birds and insects, its
// weather and wind, its road surface, its stock barrier and every alternative
// (left), every runoff verge (right), every breakable scene recipe and every
// road prop — packed along the roadside so the whole kit is on screen within a
// lap. Pick the biome with the panel's selector (or ?biome=).
export const TOUR_BIOMES = Object.keys(BIOME_SCENES);
export function tourArea(biome) {
  return {
    id: "tour",
    name: "Biome tour",
    icon: "🗺️",
    biome,
    blurb: `Everything the ${biome} biome has, on one small loop: its land, flora and fauna, buildings and set pieces, weather, every barrier (left) and verge (right), every breakable scene and road prop, packed along the kerbs. Switch biome above; R resets the smashables.`,
    loop: { halfLen: 190, radius: 68 },
    width: 30,
    biomes: [biome],
    edges: "tour",
    features: null, // the biome's own set pieces may spawn
    scenery: true,
    tour: true,
  };
}

export const AREAS = [
  tourArea("meadow"),
  {
    id: "smash",
    name: "Destructibles",
    icon: "💥",
    blurb:
      "Market stalls, racks, café furniture, pallets, tyre piles, luggage and scrap: drive through them and watch the pieces go. R resets the lot.",
    loop: { halfLen: 115, radius: 55 },
    width: 30,
    biomes: ["city"],
    // Stations down each straight, hugging alternate kerbs, with two piles in
    // the middle of the road for head-on hits. yawRel rotates a structure's
    // long axis off the road tangent (0 = parallel to the kerb).
    breakables: (S) => [
      { kind: "marketStall", t: 0.1 * S, lateral: -10.5, yawRel: 0 },
      { kind: "fishStall", t: 0.3 * S, lateral: 10.5, yawRel: 0 },
      { kind: "newsRack", t: 0.5 * S, lateral: -11, yawRel: 0 },
      { kind: "cafeSeating", t: 0.7 * S, lateral: 9.5, yawRel: 0 },
      { kind: "palletStack", t: 0.9 * S, lateral: -10, yawRel: 0.3 },
      { kind: "tireStack", t: 0.5 + 0.12 * S, lateral: 10, yawRel: 0 },
      { kind: "luggageCart", t: 0.5 + 0.32 * S, lateral: -10.5, yawRel: 0 },
      { kind: "scrapHeap", t: 0.5 + 0.52 * S, lateral: 9.5, yawRel: 0.4 },
      { kind: "tireStack", t: 0.5 + 0.72 * S, lateral: 0, yawRel: 0.8 },
      { kind: "palletStack", t: 0.5 + 0.9 * S, lateral: 1, yawRel: 1.2 },
    ],
    props: (S) => [
      { kind: "crate", t: 0.2 * S, lateral: 4 },
      { kind: "barrel", t: 0.4 * S, lateral: -4 },
      { kind: "trafficCone", t: 0.6 * S, lateral: 5, yaw: 0.3 },
      { kind: "cardboardBox", t: 0.8 * S, lateral: -5 },
    ],
  },
  {
    id: "scenes",
    name: "Biome scenes",
    icon: "🏞️",
    blurb:
      "Every biome's procedurally generated roadside scenes (what a race scatters along its kerbs), one biome per station at a random size: S, M or L.",
    loop: { halfLen: 300, radius: 70 },
    width: 30,
    biomes: ["city"],
    // One station per biome, cycling through its recipes with the size
    // stepping S → M → L so a lap shows the whole range.
    breakables: (S) => {
      const biomes = Object.keys(BIOME_SCENES);
      const out = [];
      biomes.forEach((biome, i) => {
        const recipes = BIOME_SCENES[biome];
        const half = i < 8 ? 0 : 0.5;
        const k = i < 8 ? i : i - 8;
        const kind = recipes[i % recipes.length];
        out.push({ kind, biome, size: i % 3, t: half + ((k + 0.5) / 8) * S, lateral: k % 2 ? 10 : -10, yawRel: 0 });
      });
      return out;
    },
  },
  {
    id: "edges",
    name: "Road edges",
    icon: "🧱",
    blurb:
      "Every barrier kind down the left of the first straight (rock faces, boulders, hedges, snow bank, adobe, concrete, tyres, hay, logs, sandbags, basalt) and every runoff verge down the back straight. Stations park you against each; scrape along it to feel the difference.",
    loop: { halfLen: 300, radius: 70 },
    width: 30,
    biomes: ["city"],
    // Explicit spans in lap fractions (see planEdges): barriers on the left
    // of straight 1, the stock kinds on its right; verges on the back straight.
    edges: (S) => {
      const out = [];
      const n = EDGE_STYLE_KEYS.length;
      EDGE_STYLE_KEYS.forEach((key, i) =>
        out.push({ t0: (i / n) * S, t1: ((i + 1) / n) * S, side: "left", barrier: key }),
      );
      const verges = Object.keys(VERGE_KINDS);
      verges.forEach((kind, i) =>
        out.push({
          t0: 0.5 + (i / verges.length) * S,
          t1: 0.5 + ((i + 1) / verges.length) * S,
          side: "both",
          verge: kind,
        }),
      );
      return out;
    },
    stations: (S) => {
      const n = EDGE_STYLE_KEYS.length;
      const out = EDGE_STYLE_KEYS.map((key, i) => ({
        label: EDGE_STYLES[key].name,
        t: ((i + 0.5) / n) * S,
        lateral: -12.6,
      }));
      const verges = Object.keys(VERGE_KINDS);
      verges.forEach((kind, i) =>
        out.push({ label: `${VERGE_KINDS[kind].name} verge`, t: 0.5 + ((i + 0.5) / verges.length) * S, lateral: 12.4 }),
      );
      return out;
    },
  },
  {
    id: "jumps",
    name: "Jumps",
    icon: "🪂",
    blurb:
      "Speed bumps, humps, a whoop, a kicker, a launch ramp, a tabletop, a drop-off and a gap jump. Telemetry shows air time, height and distance for every flight.",
    loop: { halfLen: 110, radius: 50 },
    width: 30,
    biomes: ["meadow"],
    surface: (S) => [
      { label: "Speed bumps", type: "bumps", t: 0.08 * S, width: 16, length: 12, height: 0.12, count: 3 },
      { label: "Low hump", type: "hump", t: 0.28 * S, width: 16, length: 16, height: 0.9 },
      { label: "Whoop", type: "hump", t: 0.5 * S, width: 12, length: 9, height: 1.5 },
      { label: "Kicker", type: "kicker", t: 0.74 * S, lateral: -4, width: 7, length: 7, height: 1.7 },
      { label: "Launch ramp", type: "ramp", t: 0.5 + 0.1 * S, width: 10, length: 11, height: 2.8 },
      { label: "Tabletop", type: "tabletop", t: 0.5 + 0.34 * S, width: 10, length: 24, height: 2.4 },
      { label: "Drop-off", type: "drop", t: 0.5 + 0.56 * S, lateral: 4, width: 9, length: 10, height: 1.6 },
      { label: "Gap jump", type: "ramp", t: 0.5 + 0.78 * S, width: 9, length: 10, height: 2.0 },
      {
        label: "Gap landing",
        type: "ramp",
        t: 0.5 + 0.78 * S,
        along: 24,
        width: 11,
        length: 12,
        height: 2.0,
        reverse: true,
        teleport: false,
      },
    ],
  },
  {
    id: "items",
    name: "Power-ups",
    icon: "🎁",
    blurb:
      "Hand yourself any item and fire it (F shoot, M milk, B boost, Shift shield), or grab the floating boxes for a real roll. Spawn a dummy rival to aim at.",
    loop: { halfLen: 85, radius: 48 },
    width: 30,
    biomes: ["blossom"],
    boxes: () => [
      { t: 0.12, lateral: 0 },
      { t: 0.37, lateral: 3 },
      { t: 0.62, lateral: -3 },
      { t: 0.87, lateral: 0 },
    ],
    props: () => [
      { kind: "crate", t: 0.2, lateral: 9 },
      { kind: "crate", t: 0.5, lateral: -9 },
      { kind: "crate", t: 0.75, lateral: 9 },
    ],
    dummy: true,
    items: true,
  },
  {
    id: "props",
    name: "Shipped props",
    icon: "📦",
    blurb:
      "Every road prop the game already ships, lined up down both straights for a side-by-side with the new breakables.",
    loop: { halfLen: 125, radius: 50 },
    width: 30,
    biomes: ["meadow"],
    props: (S) => {
      const kinds = ["crate", "barrel", ...Object.keys(ROAD_PROPS)];
      const perSide = Math.ceil(kinds.length / 2);
      return kinds.map((kind, i) => {
        const side = i < perSide ? 0 : 0.5;
        const k = i % perSide;
        return { kind, t: side + ((k + 0.5) / perSide) * S, lateral: k % 2 ? 8 : -8 };
      });
    },
    leafPiles: (S) => [{ t: 0.5 + 0.5 * S, lateral: 0 }],
  },
];

// Resolve an area's track-coordinate stations against its built track.
// Returns the props.js layout (world XZ + yaw) and the surface specs, plus a
// list of teleport targets for the side panel.
export function resolveArea(area, track) {
  const S = loopShare(area.loop.halfLen, area.loop.radius);
  const world = (t, lateral = 0, along = 0) => {
    const tt = t + along / track.length;
    const p = track.getPointAt(tt);
    const tan = track.getTangentAt(tt);
    tan.y = 0;
    tan.normalize();
    const sx = -tan.z, // side = cross(tangent, up)
      sz = tan.x;
    return { x: p.x + sx * lateral, z: p.z + sz * lateral, tx: tan.x, tz: tan.z, t: tt };
  };
  const targets = [];
  const layout = { props: [], breakables: [], boxes: [], leafPiles: [] };
  for (const b of area.breakables?.(S) || []) {
    const w = world(b.t, b.lateral);
    // Structure local +X along the road: rotation.y = yaw maps local X to
    // (cos yaw, 0, -sin yaw), so yaw = atan2(-tz, tx) lines it up with the tangent.
    const yaw = Math.atan2(-w.tz, w.tx) + (b.yawRel || 0);
    layout.breakables.push({ kind: b.kind, x: w.x, z: w.z, yaw, size: b.size ?? 1 });
    const label = `${b.biome ? b.biome + " · " : ""}${BREAKABLES[b.kind].name}${b.size !== undefined ? ` (${SIZE_LABELS[b.size]})` : ""}`;
    targets.push({ label, t: w.t, lateral: b.lateral });
  }
  for (const o of area.props?.(S) || []) {
    const w = world(o.t, o.lateral);
    layout.props.push({ kind: o.kind, x: w.x, z: w.z, yaw: o.yaw || 0, mode: o.mode });
    if (area.id === "props") targets.push({ label: ROAD_PROPS[o.kind]?.name || o.kind, t: w.t, lateral: o.lateral });
  }
  for (const b of area.boxes?.(S) || []) {
    const w = world(b.t, b.lateral);
    layout.boxes.push({ x: w.x, z: w.z });
  }
  for (const l of area.leafPiles?.(S) || []) {
    const w = world(l.t, l.lateral);
    layout.leafPiles.push({ x: w.x, z: w.z });
  }
  for (const st of area.stations?.(S) || []) targets.push(st);
  if (area.tour) tourStations(track, layout, targets, area.biome);
  const surface = [];
  for (const f of area.surface?.(S) || []) {
    const spec = { ...f };
    if (f.along) spec.t = f.t + f.along / track.length;
    delete spec.along;
    surface.push(spec);
    if (f.teleport !== false) targets.push({ label: f.label || f.type, t: spec.t, lateral: f.lateral || 0 });
  }
  return { layout, surface, targets, loopPoints: null };
}

// Track config extras an area asks for (explicit edge spans, or the tour plan).
export function areaTrackConfig(area) {
  const S = loopShare(area.loop.halfLen, area.loop.radius);
  // Bays only on the tour (the other areas place things by hand).
  const cfg = { bays: area.tour ? "tour" : false };
  if (typeof area.edges === "function") cfg.edges = area.edges(S);
  else if (area.edges) cfg.edges = area.edges;
  return cfg;
}

// Contiguous biome stretches of a built track: [{ biome, i0, i1 }] in lap order.
export function biomeStretches(track) {
  const names = track.biomeNames || [];
  const N = names.length;
  const out = [];
  let i = 0;
  while (i < N) {
    const biome = names[i];
    let end = i;
    while (end < N && names[end] === biome) end++;
    out.push({ biome, i0: i, i1: end });
    i = end;
  }
  // The lap starts mid-wedge: the first and last stretches are one biome
  // split by the start line — join them (i0 goes negative, callers wrap).
  if (out.length > 1 && out[0].biome === out.at(-1).biome) {
    const last = out.pop();
    out[0].i0 = last.i0 - N;
  }
  return out;
}

// The tour pack: the biome's recipes cycle along the whole lap every ~40u
// (sizes cycling, the wide seating ones capped at M) alternating kerbs, its
// road props every ~18u hugging the kerbs (never the middle of the road),
// leaf piles on the leafy biomes, and a station per scene and per set piece.
const LEAFY = new Set(["meadow", "forest", "autumn", "blossom", "jungle", "lavender", "wetlands"]);
function tourStations(track, layout, targets, biome) {
  const N = track.samples;
  const L = track.length;
  const world = (u, lateral) => {
    const w = ((Math.round((u / L) * N) % N) + N) % N;
    const p = track._pts[w],
      tan = track._tans[w];
    const sx = -tan.z,
      sz = tan.x;
    return { x: p.x + sx * lateral, z: p.z + sz * lateral, tx: tan.x, tz: tan.z, t: w / N };
  };
  // Set pieces (bridges, tunnels, dams…) planned on this loop: a station each,
  // and nothing parked inside the structural ones.
  const runs = track.features?.runs || [];
  const structural = new Set(["tunnel", "bridge", "causeway", "dam", "canyon", "overpass", "crossover", "shelf"]);
  const blocked = (u) => {
    const i = Math.round((u / L) * N) % N;
    return runs.some((r) => structural.has(r.kind) && Math.min(Math.abs(i - r.c), N - Math.abs(i - r.c)) < r.half + 6);
  };
  for (const r of runs) targets.push({ label: `⛰ ${r.kind}`, t: (((r.c % N) + N) % N) / N, lateral: 0, biome });
  targets.push({ label: `🏞 ${biome}`, t: 0.01, lateral: 0, biome, header: true });
  const recipes = BIOME_SCENES[biome] || [];
  const props = ROAD_PROP_BIOMES[biome] || [];
  // Scenes sit in the BAYS the track widened (every 78u, sides alternating):
  // on the apron, out of the lane, like a stall on a real road. The recipes
  // cycle; the deeper bay (every third) is offered the large size. props.js
  // fits each one to its bay (`sceneInBay`), shrinking it if it has to, so
  // the layout hands over the BAY, not a spot.
  let n = 0;
  for (const bay of track.bays || []) {
    const kind = recipes[n % recipes.length];
    const gen = BREAKABLES[kind].gen;
    const size = bay.depth >= 6 ? (gen === "seating" ? 1 : 2) : n % 2;
    const lateral = (bay.side === 0 ? 1 : -1) * (track.halfWidth + bay.depth * 0.5);
    layout.breakables.push({ kind, bay, size, yawJitter: ((n * 7) % 5) * 0.06 - 0.12 });
    targets.push({ label: `${biome} · ${BREAKABLES[kind].name} (≤${SIZE_LABELS[size]})`, t: bay.t, lateral, biome });
    n++;
  }
  // Road props in small GROUPS at the kerb, one group in each gap between
  // bays on the opposite side to the bay ahead (a tyre, a cone and a box
  // left together, not one object every few metres): three props a group,
  // 10.5-12.5u out so the middle of the road stays clear.
  let k = 0;
  const bays = track.bays || [];
  const gaps = bays.length
    ? bays.map((b, i) => {
        const next = bays[(i + 1) % bays.length];
        const u0 = b.t * L,
          u1 = next.t * L + (i + 1 === bays.length ? L : 0);
        return { u: (u0 + u1) / 2, side: next.side === 0 ? -1 : 1 };
      })
    : Array.from({ length: Math.floor(L / 72) }, (_, i) => ({ u: 36 + i * 72, side: i % 2 ? 1 : -1 }));
  for (const g of gaps) {
    const u = g.u % L;
    if (blocked(u) || !props.length) continue;
    for (let j = 0; j < 3; j++) {
      const kind = props[k % props.length];
      const lateral = g.side * (10.5 + ((k * 13) % 5) * 0.5);
      const w = world(u + (j - 1) * 2.6 + ((k * 7) % 3) * 0.4, lateral);
      layout.props.push({ kind, x: w.x, z: w.z, yaw: (k * 1.7) % 6.28 });
      k++;
    }
  }
  if (LEAFY.has(biome))
    for (let u = 45; u < L - 40; u += 70) {
      if (blocked(u)) continue;
      const w = world(u, (u / 70) % 2 ? 12.5 : -12.5);
      layout.leafPiles.push({ x: w.x, z: w.z });
    }
}

export function areaPoints(area) {
  return roundedLoop(area.loop.halfLen, area.loop.radius);
}
