import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { attribute, color as tslColor, mix, smoothstep, float, time, positionLocal, positionGeometry, vec3, normalView, positionViewDirection, hash, instanceIndex, uniform, texture, uv } from "three/tsl";
import { rand, makeRng } from "./rng.js"; // seeded RNG so the world is identical per seed
import { cloudClusterGeo } from "./scene.js"; // the sky ring's cloud lump (asset catalog shows one)
import { makeLeafGeo } from "./props.js"; // shared leaf silhouette (used by piles + ground scatter)
import { mergeMeshes } from "./models.js"; // bake rigid sub-assemblies (animals) into one mesh
// Track set pieces (river bridge / canyon / giant forest / overpass): the
// planner lives on the track (track.features); these helpers shape the terrain
// around the runs and build their structures. See features.js for the system.
import { featureHeightMod, featureKeepClear, featureSpanBlock, featureTreeBlock, featureWaterEntries, giantTreeBoost, buildFeatureStructures, makeWindTurbine, makeBillboard, BILLBOARD_SIGNS, makeTrain, makeDuck, makeGoat } from "./features.js";
import { uSunViewNode, uSunColNode } from "./toon.js"; // shared per-frame sun nodes (grass backlight reads them)
import { windLean, windGustDrift, bakeBendWeights, setWind, uKartPos } from "./wind.js"; // the world's one wind field

// Registries of animated parts, filled in as the world is built and driven from
// buildWorld's update(): continuous spinners (windmill sails, Ferris wheel,
// lighthouse beam) and gentle flutterers (flags).
const _spinners = []; // { obj, ax:'x'|'y'|'z', speed, phase }
const _flutterers = []; // { obj, phase }
const _critters = []; // wandering ground animals: { obj, base, ... }
// Set per build: true where a lake basin sits, so scatter/grass/props avoid it.
let _inLake = () => false;

// ---- Biomes ----
// Five themed sectors radiating around the map. Since the track loops through
// every angle, you drive through each biome as you lap. Cheap to evaluate
// (just atan2), so terrain, trees and grass can all be themed per position.
// `weather` is the precipitation that biome brings (so weather is dictated by
// where you are, not a per-race dice roll). Alpine's snow is handled by altitude
// up on the pass; the wet forest brings rain; dry/open biomes stay clear.
// `style` drives terrain logic (pine = dense woods, cactus = desert props); the
// new `treeShape` picks the canopy silhouette so each biome reads distinctly:
//   round   – billowy deciduous lollipop (meadow, autumn)
//   pine    – stacked-tier conifer (forest, alpine, tundra)
//   acacia  – flat-topped umbrella on a tall bare trunk (savanna)
//   blossom – fluffy cherry-blossom cloud (blossom)
//   cactus  – desert succulent (desert)
const BIOMES = [
  { name: "meadow", weather: "none", ground: 0x4f9d3a, ground2: 0x3c7a2e, foliage: [0.3, 0.5, 0.34], style: "cone", treeShape: "round", sx: 1.0, sy: 1.0, treeDensity: 0.7, grassTint: 0xcfe9b0, grassDensity: 1.0, barrier: { a: 0xfafafa, b: 0x7cb342 } },
  { name: "forest", weather: "rain", ground: 0x356b2c, ground2: 0x244f22, foliage: [0.34, 0.55, 0.24], style: "pine", treeShape: "pine", sx: 0.8, sy: 1.45, treeDensity: 1.0, grassTint: 0x9cc080, grassDensity: 0.9, barrier: { a: 0x6b4a2b, b: 0x3f2c19 } },
  // Alpine sits on the big left-side hill, so its high ground reads as snow.
  { name: "alpine", weather: "snow", ground: 0x6f7e74, ground2: 0x586a62, foliage: [0.4, 0.42, 0.22], style: "pine", treeShape: "pine", sx: 0.7, sy: 1.55, treeDensity: 0.85, grassTint: 0xbcccb0, grassDensity: 0.45, barrier: { a: 0xe53935, b: 0xfafafa } },
  { name: "autumn", weather: "none", ground: 0x7a6a32, ground2: 0x6b5326, foliage: [0.07, 0.7, 0.45], style: "cone", treeShape: "round", sx: 1.05, sy: 1.0, treeDensity: 0.9, grassTint: 0xd9c070, grassDensity: 0.65, barrier: { a: 0xc8642a, b: 0xf0e0c0 } },
  { name: "desert", weather: "none", ground: 0xcaa56b, ground2: 0xb98e50, foliage: [0.28, 0.45, 0.4], style: "cactus", treeShape: "cactus", sx: 1.0, sy: 1.0, treeDensity: 0.3, grassTint: 0xd9c98a, grassDensity: 0.12, barrier: { a: 0xc2a86a, b: 0x9c5a3a } },
  // Red-rock mesa country: rust sandstone ground, sparse cacti, canyon-friendly.
  { name: "mesa", weather: "none", ground: 0xc0714a, ground2: 0xa25836, foliage: [0.26, 0.42, 0.38], style: "cactus", treeShape: "cactus", sx: 1.0, sy: 1.1, treeDensity: 0.22, grassTint: 0xd8a878, grassDensity: 0.1, barrier: { a: 0xd8956a, b: 0x7a4028 } },
  // Cherry-blossom spring: fresh green ground under candy-pink canopies.
  { name: "blossom", weather: "none", ground: 0x6fae4a, ground2: 0x5a9440, foliage: [0.92, 0.6, 0.82], style: "cone", treeShape: "blossom", sx: 1.05, sy: 1.05, treeDensity: 0.8, grassTint: 0xd6f0a8, grassDensity: 0.95, barrier: { a: 0xffd9e6, b: 0xff9fc0 } },
  // Steamy rainforest: deep wet greens, dense arching palms, drumming rain.
  // style "pine" opts it into the dense-woods pass; the palms make it a jungle.
  { name: "jungle", weather: "rain", ground: 0x2f7a34, ground2: 0x255f28, foliage: [0.36, 0.62, 0.3], style: "pine", treeShape: "palm", sx: 1.15, sy: 1.25, treeDensity: 1.0, grassTint: 0x8cd080, grassDensity: 1.0, barrier: { a: 0x2e7d32, b: 0xffc107 } },
  // Dry golden savanna: tawny earth, sparse wide acacia trees, pale grass.
  { name: "savanna", weather: "none", ground: 0xb89a4e, ground2: 0xa07f3a, foliage: [0.13, 0.45, 0.4], style: "cone", treeShape: "acacia", sx: 1.25, sy: 0.85, treeDensity: 0.35, grassTint: 0xd8c070, grassDensity: 0.5, barrier: { a: 0xc9a86a, b: 0x8a6a3a } },
  // Frosted tundra: pale sage ground, short blue-green pines, light snow.
  { name: "tundra", weather: "snow", ground: 0x9fb0a4, ground2: 0x84988e, foliage: [0.38, 0.32, 0.42], style: "pine", treeShape: "pine", sx: 0.75, sy: 1.2, treeDensity: 0.6, grassTint: 0xc8d8c0, grassDensity: 0.3, barrier: { a: 0xdfeaf0, b: 0x9fb8c0 } },
  // Downtown: a grey asphalt boulevard lined with tall towers, hazard-striped
  // barriers. Only the ROAD is grey (see ROAD_STYLES) — the surrounding hills
  // are a muted urban-park green, like a city sitting in ordinary countryside.
  { name: "city", weather: "none", ground: 0x5d8a47, ground2: 0x4a6f3c, foliage: [0.3, 0.35, 0.38], style: "urban", treeShape: "none", sx: 1.0, sy: 1.0, treeDensity: 0, grassTint: 0xa8c290, grassDensity: 0.25, barrier: { a: 0xf2c94c, b: 0x2b2b2b } },
  // Seaside: pale sand, tall palms, and a shoreline (the sea is a large sandy-shored
  // lake placed in the beach sectors — see makeLakes). Sea-blue + sand barriers.
  { name: "beach", weather: "none", ground: 0xe6d6a2, ground2: 0xd4bf84, foliage: [0.28, 0.5, 0.42], style: "beach", treeShape: "palm", sx: 0.7, sy: 1.6, treeDensity: 0.22, grassTint: 0xdccf9a, grassDensity: 0.22, barrier: { a: 0xe8cf96, b: 0x5aa0cf } },
];
for (const b of BIOMES) {
  b.groundCol = new THREE.Color(b.ground);
  b.ground2Col = new THREE.Color(b.ground2);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SNOW_WHITE = new THREE.Color(0xeef4fa);
const UP_Y = new THREE.Vector3(0, 1, 0); // shared up axis for yaw-only instance rotation

// Rounded box for the soft, toy-town art direction. Low segment count keeps the
// tri budget sane across the many roadside props; radius auto-clamps to the box.
// Used for silhouette-defining masses (building bodies, animals, props); tiny
// trim stays as plain BoxGeometry, and rocks/cliffs are left intentionally craggy.
function rbox(w, h, d, r = 0.15, seg = 2) {
  const radius = Math.min(r, w / 2, h / 2, d / 2) * 0.95;
  return new RoundedBoxGeometry(w, h, d, seg, radius);
}

// A vertical prism that rounds only the four UPRIGHT corners, leaving the top
// and bottom flat — what a building actually wants. (A RoundedBoxGeometry rounds
// all 12 edges, so a roof on its puffed-in top reads as a mushroom.) Built by
// extruding a rounded-rectangle footprint; centred like BoxGeometry so callers
// can position it the same way. UVs are normalised so emissive window maps tile
// cleanly around the walls instead of clamping/streaking.
function roundedColumn(w, h, d, r) {
  r = Math.max(0.01, Math.min(r, w / 2 - 0.01, d / 2 - 0.01));
  const hw = w / 2, hd = d / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r);
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  const uvGen = {
    generateTopUV: () => [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()],
    generateSideWallUV: (g, v, a, b, c, dd) => {
      const U = (i) => Math.atan2(v[i * 3 + 1], v[i * 3]) / (Math.PI * 2) + 0.5;
      const V = (i) => v[i * 3 + 2] / h;
      return [a, b, c, dd].map((i) => new THREE.Vector2(U(i), V(i)));
    },
  };
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 3, UVGenerator: uvGen });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2, 0); // centre vertically like BoxGeometry
  return geo;
}

// Biome layout. Two modes:
//  - "angular" (classic track): biomes are wedges around the origin, as before.
//  - "altitude" (generated tracks): ALPINE follows high ground (snow on the
//    peaks), the warm biomes fill the lower ground as wide, soft-edged wedges.
// A height sampler lets biomeAt() look up the local elevation itself, so callers
// don't have to thread `y` everywhere.
let _activeBiomes = BIOMES;
let _altMode = false;
let _warm = BIOMES.filter((b) => b.name !== "alpine");
let _alpine = null;
let _eMin = 0;
let _eMax = 1;
let _heightSampler = null;
// Seeded angular offset (in turns, 0..1) for the warm-biome wedges. Rotates which
// biome the start line sits on so it varies per seed instead of always biome #0.
let _biomeAngleOffset = 0;

// Choose which biomes appear (by name). Empty/unknown -> all. opts:
//   { altitude, elevMin, elevMax } enable altitude-driven layout (custom tracks).
// Decide the warm-biome wedge ORDER + angular phase for a seed, from an
// ISOLATED stream — so the track GENERATOR can read the same plan before the
// world build starts (its per-biome corner rhythm aligns with the wedges) and
// setBiomeLayout can adopt it without consuming the shared world stream.
export function planBiomeWedges(names, seedStr) {
  const sel = Array.isArray(names) && names.length ? BIOMES.filter((b) => names.includes(b.name)) : BIOMES;
  let warm = sel.filter((b) => b.name !== "alpine");
  if (!warm.length) warm = sel;
  const r = makeRng(String(seedStr) + "|wedges");
  const order = warm.map((b) => b.name);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { order, offset: r() };
}

export function setBiomeLayout(names, opts = {}) {
  const sel = Array.isArray(names) && names.length ? BIOMES.filter((b) => names.includes(b.name)) : BIOMES;
  _activeBiomes = sel.length ? sel : BIOMES;
  _alpine = _activeBiomes.find((b) => b.name === "alpine") || null;
  _warm = _activeBiomes.filter((b) => b.name !== "alpine");
  if (!_warm.length) _warm = _activeBiomes; // alpine-only map
  _altMode = !!opts.altitude;
  _eMin = opts.elevMin ?? 0;
  _eMax = opts.elevMax ?? 1;
  _biomeAngleOffset = 0;
  // Generated tracks: scramble both the ORDER of the warm biomes and the angular
  // phase, so the sequence of biomes and which one the start sits on are unique
  // per seed (classic keeps its hand-authored fixed order). When the track hands
  // us its wedge PLAN (planBiomeWedges), adopt it — the generator already laid
  // the road's rhythm out against those exact wedges.
  if (opts.wedges) {
    const byName = new Map(_warm.map((b) => [b.name, b]));
    const ordered = opts.wedges.order.map((n) => byName.get(n)).filter(Boolean);
    if (ordered.length === _warm.length) _warm = ordered;
    _biomeAngleOffset = opts.wedges.offset;
  } else if (_altMode) {
    for (let i = _warm.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [_warm[i], _warm[j]] = [_warm[j], _warm[i]];
    }
    _biomeAngleOffset = rand();
  }
}

// Provide an elevation lookup fn(x,z)->y so biomeAt can read altitude. Set by the
// track once its samples exist (before it styles its road).
export function setHeightSampler(fn) {
  _heightSampler = fn;
}

const smooth = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

// How "alpine" an elevation reads, 0 (warm) .. 1 (full snow), with a wide
// transition band so the snow line is a gradient, not a hard edge.
const ALPINE_LINE = 0.52;
const ALPINE_BAND = 0.24;
function alpineWeight(y) {
  if (!_alpine || !_altMode) return 0;
  if (_eMax - _eMin < 8) return 0; // ~flat track -> no peaks -> no alpine/snow
  const yn = clamp((y - _eMin) / (_eMax - _eMin), 0, 1);
  return smooth((yn - (ALPINE_LINE - ALPINE_BAND)) / (2 * ALPINE_BAND));
}

// The lower-ground warm biome at (x,z) as a wide, soft-edged angular blend.
// Returns { a, b, t } (colour = lerp(a,b,t)).
function warmBlend(x, z) {
  const n = _warm.length;
  if (n <= 1) return { a: _warm[0], b: _warm[0], t: 0 };
  const s = ((Math.atan2(z, x) / (Math.PI * 2) + _biomeAngleOffset + 1) % 1) * n;
  const i0 = Math.floor(s) % n;
  const frac = s - Math.floor(s);
  const t = frac < 0.58 ? 0 : smooth((frac - 0.58) / 0.42); // soft seam over ~40% of each wedge
  return { a: _warm[i0], b: _warm[(i0 + 1) % n], t };
}

// Dominant biome at a point (for scatter / weather / barriers). `y` optional —
// looked up via the height sampler in altitude mode when omitted.
function biomeAt(x, z, y) {
  if (!_altMode) {
    const u = (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1;
    return _activeBiomes[Math.floor(u * _activeBiomes.length) % _activeBiomes.length];
  }
  if (y === undefined) y = _heightSampler ? _heightSampler(x, z) : 0;
  if (alpineWeight(y) >= 0.5) return _alpine;
  const wb = warmBlend(x, z);
  return wb.t < 0.5 ? wb.a : wb.b;
}

// What the roadside barrier is actually MADE OF, per biome. Every biome used to
// get the identical chunky striped kerb with only the paint swapped, which
// reads as one track wearing different colours rather than different country.
// The barrier is not the collision surface — kart.js clamps on the track
// projection at halfWidth and props.js reflects off halfWidth + 0.8, both
// independent of this mesh — so a fence here can be mostly air (post-and-rail)
// or lumpy and irregular (dry stone) without anything falling through it.
//
//   kerb  the original swept wall, alternating stripes. Right for a street
//         circuit, and the fallback for biomes not yet given their own.
//   rail  a low sill with two timber rails over it on posts — countryside.
//   stone dry-stone wall: the same sweep, but height and width jittered
//         per-sample off a hash so no two metres of it match, and coloured
//         from a rubble palette instead of stripes.
//   slat  uprights on a sill under a top rail — one shape that covers a
//         bamboo palisade, a slatted snow fence, a beach dune fence and a
//         savanna thorn boma, which are the same fence in different timber.
//
// Whatever the style, the top edge keeps a light/dark contrast and the height
// stays near 1.6u: at 100km/h the barrier's first job is telling you where the
// track ends, and naturalism that costs legibility is a bad trade.
const BARRIER_STYLES = {
  meadow: { kind: "rail", post: 0x6b4a2b, rail: 0xa9855a, cap: 0xe8dcc4, sill: 0x8a9b6a },
  blossom: { kind: "rail", post: 0x7a5a3c, rail: 0xc0a07c, cap: 0xffeef4, sill: 0x8fae68 },
  autumn: { kind: "rail", post: 0x5f4a30, rail: 0x8f7550, cap: 0xd9c9a8, sill: 0x8a7a44 },
  // Stone is pulled GREYER than the ground it stands on. Matching the local
  // earth is what real dry stone does and it reads as a berm, not a wall — the
  // barrier has to separate from the terrain to say "track ends here".
  desert: { kind: "stone", lo: 0x8a7458, hi: 0xc4b394, cap: 0xe6dcc4 },
  mesa: { kind: "stone", lo: 0x6f4a3a, hi: 0xa8836b, cap: 0xd8c3ad },
  // Split-log: the meadow fence gone rough and dark under the canopy.
  forest: { kind: "rail", post: 0x4a3520, rail: 0x6d5334, cap: 0xa39070, sill: 0x3f6b32 },
  // Bamboo palisade: tall close-set green uprights, pale at the cut tops.
  jungle: { kind: "slat", slat: 0x86a83f, cap: 0xd8e2a0, rail: 0x5f7a30, sill: 0x2f7a34, h: 1.75, gap: 0.42, lean: 0.05 },
  // Snow fence: weathered slats, widely spaced, snow banked against the sill.
  alpine: { kind: "slat", slat: 0x8a6f4e, cap: 0xe8e2d6, rail: 0x6b5439, sill: 0xe6eef4, h: 1.35, gap: 0.85, lean: 0.13 },
  tundra: { kind: "slat", slat: 0x7f6a52, cap: 0xdfe6ea, rail: 0x60503c, sill: 0xd6e0e4, h: 1.3, gap: 0.9, lean: 0.15 },
  // Dune fence: pale sand-bleached slats, half-buried.
  beach: { kind: "slat", slat: 0xd8c48e, cap: 0xf4ead0, rail: 0xb8a070, sill: 0xe6d6a2, h: 1.25, gap: 0.7, lean: 0.16 },
  // Thorn boma: dark scrappy branches at every angle, no two the same height.
  savanna: { kind: "slat", slat: 0x5c4a2e, cap: 0x9a8258, rail: 0x4a3a24, sill: 0xa07f3a, h: 1.5, gap: 0.5, lean: 0.34 },
};
export function biomeBarrierStyle(x, z) {
  const b = biomeAt(x, z);
  return BARRIER_STYLES[b.name] || { kind: "kerb", ...b.barrier };
}

// Biome NAME at a position (used by the track's set-piece planner, which needs
// to know which biome owns each stretch of road). `y` optional as in biomeAt.
export function biomeNameAt(x, z, y) {
  return biomeAt(x, z, y).name;
}

// Precipitation the biome at a position brings ("none" / "rain" / "snow").
export function biomeWeatherAt(x, z) {
  return biomeAt(x, z).weather;
}

// How hard the wind blows in each biome — the weather half of a biome's
// character, and the thing that makes an alpine pass feel like a storm and a
// desert feel like dead air. Multiplies the track's own prevailing force, and
// main.js eases toward it as you drive, so a biome boundary is weather closing
// in over a few seconds rather than a switch being thrown.
const BIOME_WIND = {
  alpine: 2.1, // the storm biome: snow driving sideways off the pass
  tundra: 1.9,
  forest: 1.7, // squally under the canopy
  beach: 1.6, // onshore breeze, nothing to break it
  jungle: 1.5,
  autumn: 1.35,
  savanna: 1.2,
  meadow: 1.0,
  city: 0.9, // sheltered between the buildings
  blossom: 0.85, // still enough for the petals to hang
  mesa: 0.75,
  desert: 0.7, // dead air over the heat
};
export function biomeWindAt(x, z) {
  return BIOME_WIND[biomeAt(x, z).name] ?? 1;
}

// Road-surface character for the biome at a position: an RGB multiplier applied
// to the base asphalt, plus a `kind` the track uses for per-biome speckle
// (sandy cracks, alpine ice, damp forest tarmac, warm autumn).
const ROAD_STYLES = {
  meadow: { tint: [1, 1, 1], kind: "asphalt" },
  forest: { tint: [0.78, 0.85, 0.93], kind: "damp" },
  alpine: { tint: [1.35, 1.42, 1.55], kind: "snow" },
  autumn: { tint: [1.1, 1.0, 0.85], kind: "autumn" },
  desert: { tint: [1.7, 1.45, 1.02], kind: "sand" },
  mesa: { tint: [1.55, 1.12, 0.88], kind: "sand" },
  jungle: { tint: [0.8, 0.92, 0.84], kind: "damp" },
  blossom: { tint: [1.04, 0.97, 1.02], kind: "asphalt" },
  savanna: { tint: [1.45, 1.28, 0.95], kind: "sand" },
  tundra: { tint: [1.25, 1.32, 1.4], kind: "snow" },
  // City keeps the grey on the ROAD (a cool, fresh-laid asphalt) now that its
  // terrain is green; beach tarmac reads sun-bleached and sandy. The "urban"
  // kind gives the city concrete SIDEWALKS instead of the sandy verge trim.
  city: { tint: [0.92, 0.95, 1.04], kind: "urban" },
  beach: { tint: [1.5, 1.35, 1.05], kind: "sand" },
};
export function biomeRoadStyle(x, z) {
  return ROAD_STYLES[biomeAt(x, z).name] || ROAD_STYLES.meadow;
}

// Blended road style for the road SURFACE itself: instead of the hard
// per-vertex switch above, the tint cross-fades over the same wide seam bands
// the terrain uses (angular wedges in classic mode; warm wedges + the alpine
// snow-line by height on generated tracks), so tarmac changes character
// gradually. Alongside the tint it reports the weight of each speckle `kind`
// (0..1, summing to ~1) so the track can fade its per-biome speckle in/out
// across the same band. Returns a reused scratch object — consume it before
// the next call. `y` is the road elevation at (x,z), passed by the track so
// the snow line doesn't need a height lookup.
const _roadBlend = { tint: [1, 1, 1], kinds: {} };
function _accumRoadStyle(style, w) {
  if (w <= 0) return;
  _roadBlend.tint[0] += style.tint[0] * w;
  _roadBlend.tint[1] += style.tint[1] * w;
  _roadBlend.tint[2] += style.tint[2] * w;
  _roadBlend.kinds[style.kind] = (_roadBlend.kinds[style.kind] || 0) + w;
}
export function biomeRoadStyleBlend(x, z, y) {
  _roadBlend.tint[0] = _roadBlend.tint[1] = _roadBlend.tint[2] = 0;
  for (const k in _roadBlend.kinds) _roadBlend.kinds[k] = 0;
  if (!_altMode) {
    const n = _activeBiomes.length;
    const s = ((Math.atan2(z, x) / (Math.PI * 2) + 1) % 1) * n;
    const i0 = Math.floor(s) % n;
    const frac = s - Math.floor(s);
    const t = frac < 0.6 ? 0 : smooth((frac - 0.6) / 0.4);
    _accumRoadStyle(ROAD_STYLES[_activeBiomes[i0].name] || ROAD_STYLES.meadow, 1 - t);
    _accumRoadStyle(ROAD_STYLES[_activeBiomes[(i0 + 1) % n].name] || ROAD_STYLES.meadow, t);
    return _roadBlend;
  }
  if (y === undefined) y = _heightSampler ? _heightSampler(x, z) : 0;
  const wb = warmBlend(x, z);
  const aw = alpineWeight(y);
  _accumRoadStyle(ROAD_STYLES[wb.a.name] || ROAD_STYLES.meadow, (1 - wb.t) * (1 - aw));
  _accumRoadStyle(ROAD_STYLES[wb.b.name] || ROAD_STYLES.meadow, wb.t * (1 - aw));
  if (aw > 0 && _alpine) _accumRoadStyle(ROAD_STYLES[_alpine.name] || ROAD_STYLES.meadow, aw);
  return _roadBlend;
}

// Tint for the dust a kart kicks up: the local ground colour, paled and warmed —
// dust reads lighter than the soil it came from. Snow biomes stay near-white,
// desert goes sandy, grass a muted khaki. Writes/returns `out` (caller owns it).
const _DUST_PALE = new THREE.Color(0xe7dcc6);
export function biomeDustColor(x, z, out = new THREE.Color()) {
  biomeGround(x, z, out);
  out.lerp(_DUST_PALE, 0.6);
  return out;
}

// Terrain rises as you move away from the road, so the track sits in a shallow
// valley with hillsides climbing on both sides — that way the scenery and
// landmarks on those slopes are visible from the road instead of hidden in
// dips. Ramps from 0 at the verge up to a plateau by ~150 units out.
function valleyRise(dist) {
  const u = clamp((dist - 18) / 132, 0, 1);
  return 38 * u * u * (3 - 2 * u);
}

// Ground colour with SOFT biome borders. In altitude mode the warm biomes blend
// as wide wedges and the alpine base fades in with height; in classic mode it's
// the original angular blend (over the active biomes). Writes `out`, returns it.
function biomeGround(x, z, out, y) {
  if (!_altMode) {
    const n = _activeBiomes.length;
    const s = ((Math.atan2(z, x) / (Math.PI * 2) + 1) % 1) * n;
    const i0 = Math.floor(s) % n;
    const frac = s - Math.floor(s);
    const w = frac < 0.6 ? 0 : smooth((frac - 0.6) / 0.4);
    return out.copy(_activeBiomes[i0].groundCol).lerp(_activeBiomes[(i0 + 1) % n].groundCol, w);
  }
  if (y === undefined) y = _heightSampler ? _heightSampler(x, z) : 0;
  const wb = warmBlend(x, z);
  out.copy(wb.a.groundCol).lerp(wb.b.groundCol, wb.t);
  const aw = alpineWeight(y);
  if (aw > 0 && _alpine) out.lerp(_alpine.groundCol, aw); // warm -> alpine base by height
  return out;
}

// Builds the world around the track: rolling hills, distant mountains, a small
// town of buildings, forests, rocks, hero landmarks, hot-air balloons and birds.
// Returns { grass, update(time) } for the animated bits.
export function buildWorld(scene, track, opts = {}) {
  const night = opts.timeOfDay === "night";
  // Lamps / string lights / bridge lantern come on at NIGHT and at SUNSET (dusk),
  // dimmer at dusk. `lit` = are they on at all; `litLevel` = how bright (0.55 dusk,
  // 1 night).
  const lit = night || opts.timeOfDay === "sunset";
  const litLevel = night ? 1 : opts.timeOfDay === "sunset" ? 0.55 : 0;
  _spinners.length = 0;
  _flutterers.length = 0;
  _critters.length = 0;
  const roadClear = track.halfWidth + 10; // keep scenery off the tarmac
  // Every track gets its own prevailing wind out of the seed, so the direction
  // the grass and the treeline lean is part of a world's character.
  setWind({ dirRad: rand() * Math.PI * 2, strength: 0.9 + rand() * 0.3 });

  // Gentle rolling detail laid on top of the road-anchored hills (kept small so
  // it never digs the ground below the road — that just makes scenery vanish
  // into dips, which is what we're trying to avoid).
  const detail = (x, z) =>
    14 * Math.sin(x * 0.011 - 1.2) * Math.cos(z * 0.013 + 0.7) +
    6 * Math.sin(x * 0.03) * Math.sin(z * 0.025 + 2.1);

  const flatten = (d) => {
    const start = roadClear;
    const end = roadClear + 55;
    if (d <= start) return 0;
    if (d >= end) return 1;
    const u = (d - start) / (end - start);
    return u * u * (3 - 2 * u); // smoothstep
  };

  // Angular profile of the track's outer radius, so we can tell "outside the
  // loop" from "inside" (the infield) cheaply. The valley rise is then applied
  // only on the OUTSIDE — hillsides climb around the road for visibility, while
  // the infield stays low and flat, which is where the big lake belongs.
  const ANG_BINS = 360;
  const angR = new Float32Array(ANG_BINS);
  for (let i = 0; i < track.samples; i++) {
    const p = track._pts[i];
    const a = ((Math.atan2(p.z, p.x) / (Math.PI * 2)) + 1) % 1;
    const bin = Math.min(ANG_BINS - 1, Math.floor(a * ANG_BINS));
    const r = Math.hypot(p.x, p.z);
    if (r > angR[bin]) angR[bin] = r;
  }
  for (let b = 0; b < ANG_BINS; b++) {
    if (angR[b] === 0) angR[b] = angR[(b - 1 + ANG_BINS) % ANG_BINS] || 250;
  }
  const isOutside = (x, z) => {
    const a = ((Math.atan2(z, x) / (Math.PI * 2)) + 1) % 1;
    return Math.hypot(x, z) > angR[Math.min(ANG_BINS - 1, Math.floor(a * ANG_BINS))];
  };

  // Uncarved ground height: anchored to the nearest road height, lifted by the
  // valley rise (outside only) so the surroundings climb into hillsides, plus a
  // little rolling detail. Used for the terrain and to set lake water levels.
  const baseHeight = (x, z) => {
    // Terrain variant: on crossover maps this ignores the deck strand, so the
    // ground under the bridge anchors to the LOWER road (see track.js).
    const gi = track.groundInfoTerrain(x, z);
    const rise = isOutside(x, z) ? valleyRise(gi.dist) : 0;
    return gi.y - 0.25 + rise + flatten(gi.dist) * detail(x, z);
  };

  // Lakes: a big one in the open infield (the loop wraps right around it) plus a
  // couple of smaller ones out on the hills. Their level matches the ground.
  // The set-piece RIVER (if the map bridged one) rides in the same list, so it
  // shares the carve, the water and the prop-exclusion wholesale.
  const feats = track.features || { runs: [] };
  const lakes = makeLakes(track, baseHeight);
  // Clear props out to the full carve (the shore bank), not just the waterline,
  // so nothing sits on the slope between the road and the lake.
  _inLake = (x, z) => lakes.some((L) => lakeDist(L, x, z) < L.blendR);

  // The world's ONE height truth: road-anchored hills, minus the lake/river
  // carves, plus the set-piece fields (canyon walls up, overpass plaza down).
  const heightAt = (x, z) => featureHeightMod(feats, x, z, carveLakes(lakes, x, z, baseHeight(x, z)));

  // The terrain mesh gets an EXTRA drop under the road corridor (tapering to
  // zero by the sand trim's outer edge, so the visible verge is unchanged).
  // The terrain grid is coarse (~4-5u cells) and its base sits only ~0.25 under
  // the road; on crests the linear interpolation between cells poked ABOVE the
  // road surface — invisible while terrain and asphalt were similar colours,
  // glaring once the city's ground went green (green patches on the tarmac).
  // Only the terrain uses this sampler; placements keep the true heightAt.
  const terrainHeight = (x, z) => {
    const d = track.groundInfo(x, z).dist;
    const u = clamp(1 - (d - track.halfWidth) / 3, 0, 1);
    return heightAt(x, z) - 1.2 * (u * u * (3 - 2 * u));
  };
  // World extents adapt to the track: big maps (rim radius grew with the
  // size knob) can reach ~1060u out, past the old fixed 1900x1900 terrain
  // sheet and into the fixed mountain ring's band.
  let trackReach = 0;
  for (const p of track._pts) trackReach = Math.max(trackReach, Math.hypot(p.x, p.z));
  buildTerrain(scene, terrainHeight, litLevel, trackReach + 330); // night/dusk darkening (snow handled hard inside)
  buildMountains(scene, heightAt, track, trackReach);
  buildTrees(scene, track, heightAt, flatten);
  const groundLeaves = buildGroundLeaves(scene, track, heightAt); // loose scattered leaves (leafy biomes feel carpeted; kick up in a kart's wake)
  buildBlossomPetals(scene, track, heightAt); // GPU-animated cherry petals drifting down over blossom sectors (no per-frame CPU)
  buildForests(scene, track, heightAt); // dense woods hugging the road in forest/alpine
  buildRocks(scene, track, heightAt, flatten);
  // Ground tint for feature shells (the tunnel's mountain), matching the
  // terrain-mesh colouring: biome ground, whitening toward snow with altitude
  // exactly as buildTerrain does, so the shell reads as part of the hillside.
  const _shellSnow = new THREE.Color(0xf4f7fb);
  const _shellRock = new THREE.Color(0x7a6f5d);
  const groundColorAt = (x, z, y, out) => {
    biomeGround(x, z, out, y);
    if (_altMode) {
      const aw = alpineWeight(y);
      if (aw > 0) out.lerp(_shellSnow, aw * clamp(0.55 + y / 240, 0.55, 1));
      else if (y > 95) out.lerp(_shellRock, Math.min(0.4, (y - 95) / 130));
    } else if (biomeAt(x, z, y).name === "alpine" && y >= 62) {
      out.copy(_shellRock).lerp(_shellSnow, Math.min(1, (y - 62) / 16));
    } else if (y > 52) {
      out.lerp(_shellRock, Math.min(1, (y - 52) / 32));
    }
    return out;
  };
  const featAnim = buildFeatureStructures(scene, track, heightAt, rand, { lit, litLevel, lakes, groundColorAt }); // set-piece kits + ambience
  buildRoadside(scene, track, heightAt); // town & farm zones lining the road
  buildTrafficLights(scene, track, heightAt); // city boulevards: mast-arm signals, always green
  buildCityRoadDetails(scene, track, heightAt); // crosswalks at the signals + manhole covers
  batchBuildings(scene); // merge the hundreds of static buildings into a few meshes (draw-call slasher)
  batchStaticProps(scene); // same treatment for benches/fences/bushes/stalls etc.
  buildStreetLamps(scene, track, heightAt, lit, litLevel); // roadside lamps (on at dusk/night)
  buildRhythmPosts(scene, track, heightAt); // evenly-beat marker bollards hugging both verges (perceived speed)
  const stringLights = buildStringLights(scene, track, litLevel, heightAt); // festive bulb strings (swing + glow)
  buildOverheadStructures(scene, track, heightAt, lit, litLevel); // banners + wooden footbridges spanning the road
  buildLandmarks(scene, track, heightAt); // hero structures around the horizon
  const waters = buildWater(scene, lakes, 1 - litLevel * 0.6); // dimmer water at dusk/night
  const grass = buildGrass(scene, track, heightAt);
  const balloons = buildBalloons(scene, heightAt);
  const birds = buildBirds(scene);
  const fireflies = buildFireflies(scene, track, heightAt);
  buildAmbientFlyers(scene, track, heightAt, litLevel); // butterflies/dragonflies (day) or moths (night) — GPU-animated, no per-frame CPU
  buildWindDebris(scene, track, heightAt); // tumbleweed (desert) + seed-fluff (savanna), GPU-animated wind buffeting
  buildRoadCrossers(scene, track, heightAt); // leaves/wisps/litter crossing the road itself (perceived speed)
  const pigeonFlocks = buildPigeons(scene, track, heightAt);

  return {
    grass,
    lakes, // water entries (level/floor/spine) — debug probes verify carve vs water level
    heightAt, // terrain height sampler (incl. road carve) — props use it so piles sit on the ground
    groundLeaves, // { update(karts, camPos) } | null — drives the kart-wake leaf pop
    stringLights, // { update(dt, karts) } — driven from main.js with live kart data
    balloons, // debug hook: headless screenshot tours fly the camera to one
    update(time, dt = 0.016, playerPos = null) {
      for (const b of balloons) {
        b.mesh.position.y = b.baseY + Math.sin(time * 0.5 + b.phase) * 4;
        b.mesh.rotation.y = time * 0.1 + b.phase;
      }
      for (const s of _spinners) s.obj.rotation[s.ax] = time * s.speed + s.phase;
      featAnim.update(time);
      for (const f of _flutterers) f.obj.rotation.y = Math.sin(time * 5 + f.phase) * 0.4;
      for (const fl of birds.flocks) updateFlock(fl, time);
      syncBirdWings(birds);
      for (const c of _critters) {
        // Far-off animals freeze in place — an amble is invisible from 220u+,
        // and freezing (vs culling) means they're right there when you return.
        if (playerPos) {
          const dx = c.base.x - playerPos.x, dz = c.base.z - playerPos.z;
          if (dx * dx + dz * dz > 220 * 220) continue;
        }
        updateCritter(c, dt, time, heightAt);
      }
      for (const pf of pigeonFlocks) updatePigeons(pf, dt, time, playerPos);
      // (fireflies + water animate via the TSL `time` node; node materials drop the
      // dummy .uniforms after they compile, so don't write to them.)
      if (fireflies && fireflies.material.uniforms) fireflies.material.uniforms.uTime.value = time;
      for (const w of waters) if (w.uniforms) w.uniforms.uTime.value = time;
      // (the roadside cover is a group of TSL sprig meshes driven by the shared
      // wind field's own `time` node — nothing to tick from here. The old
      // GLSL-era uniform poke that lived here was already dead code, and threw
      // outright once `grass` became a group.)
    },
  };
}

// ---- Lakes ----
// A big hero lake sits in the open infield so the loop drives right around it,
// plus a couple of smaller lakes out on the hills for variety. Each carve makes
// a bowl below the waterline, a flat beach plateau at `level` (so the flat
// water plane can't look like it's floating on a slope), then a wide ramp back
// to the surrounding ground. Footprints are verified clear of the road and of
// each other; any that don't fit are skipped.
function makeLakes(track, baseHeight) {
  const lakes = [];
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  // Feature height-mods run AFTER the lake carve in the final height chain
  // (heightAt wraps carveLakes), so a crossover ramp's terrain pin or a
  // canyon ridge inside the water ring silently overwrites the carved beach —
  // terrain drops below the waterline and the water sheet hangs in the air
  // at its rim. A candidate is only valid when no mod fights the waterline.
  const waterlineClear = (cx, cz, L) => {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const r of [L.waterR, (L.waterR + L.shoreR) / 2]) {
        const sx = cx + Math.cos(a) * r, sz = cz + Math.sin(a) * r;
        if (Math.abs(featureHeightMod(track.features, sx, sz, L.level) - L.level) > 0.6) return false;
      }
    }
    return true;
  };

  // Set-piece water goes in FIRST so every lake placed below keeps clear of it:
  // the river (split into two reaches around a waterfall when the land drops),
  // the causeway's lagoon and the dam's reservoir. All ribbon entries, so the
  // candidate loops below already reject against them.
  const featWater = featureWaterEntries(track.features, baseHeight);
  for (const w of featWater) lakes.push(w);

  // Hero lake: a curved RIBBON in the infield that follows a LOW, FLAT arc of the
  // road, so it hugs the road's shape and the bank stays gentle. The arc is chosen
  // per seed — we throw several random candidate arcs and keep the lowest, flattest
  // one — so the lake lands somewhere unique each map instead of always at the
  // start line. The shore bank rises back to road height exactly at the barrier.
  {
    const span = Math.max(3, Math.round(0.05 * N)); // half the arc length, in samples
    // Score a candidate arc: low + flat ground, AND fairly STRAIGHT — a tight
    // curve makes the offset ribbon swing toward (or across) the road.
    const arcStats = (c) => {
      let mn = Infinity, mx = -Infinity, sum = 0, k = 0, curv = 0;
      for (let i = c - span; i <= c + span; i++) {
        const y = track._pts[((i % N) + N) % N].y;
        if (y < mn) mn = y;
        if (y > mx) mx = y;
        sum += y; k++;
        const t0 = track._tans[((i % N) + N) % N];
        const t1 = track._tans[(((i + 1) % N) + N) % N];
        let d = Math.atan2(t1.x, t1.z) - Math.atan2(t0.x, t0.z);
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        curv += Math.abs(d);
      }
      return { avg: sum / k, flat: mx - mn, curv };
    };
    let bestC = Math.floor(rand() * N), bestScore = Infinity;
    for (let t = 0; t < 10; t++) {
      const c = Math.floor(rand() * N);
      const s = arcStats(c);
      const score = s.avg + s.flat * 1.5 + s.curv * 130; // low, flat AND straight
      if (score < bestScore) { bestScore = score; bestC = c; }
    }
    const waterR = 38 + rand() * 12; // half-width of the ribbon (varies per seed)
    const bankW = 13; // shore slope width: water edge -> road height at the barrier
    const off = track.halfWidth + bankW + waterR;
    // One infield direction for the WHOLE arc (taken at its centre), so the ribbon
    // can't flip across the road mid-arc on a wiggle.
    const cp = track._pts[bestC];
    const cs = new THREE.Vector3().crossVectors(track._tans[bestC], up).normalize();
    const inSign = cs.x * cp.x + cs.z * cp.z >= 0 ? -1 : 1;
    const spine = [];
    let minY = Infinity, minDist = Infinity;
    for (let i = bestC - span; i <= bestC + span; i += 2) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
      const x = p.x + side.x * inSign * off;
      const z = p.z + side.z * inSign * off;
      spine.push({ x, z, sx: side.x * inSign, sz: side.z * inSign });
      if (p.y < minY) minY = p.y;
      minDist = Math.min(minDist, track.distanceToCenter(x, z)); // nearest road to the lake centre
    }
    // Only place the hero lake if the water clears EVERY part of the road (the lake
    // centre must stay at least waterR + halfWidth + a margin from any road) — on a
    // fold this fails, so we skip it rather than spill water onto the track. It must
    // also keep clear of the set-piece water (which touches the road on purpose).
    const clearOfFeat = spine.every((s) => featWater.every((L) => lakeDist(L, s.x, s.z) > waterR + L.blendR + 6));
    // Same waterline test as the circle lakes: no feature height-mod may
    // fight the carved water level anywhere across the ribbon.
    const level = minY - 2;
    const modsOK = spine.every((s) => {
      for (const rr of [-waterR * 0.7, 0, waterR * 0.7]) {
        if (Math.abs(featureHeightMod(track.features, s.x + s.sx * rr, s.z + s.sz * rr, level) - level) > 0.6) return false;
      }
      return true;
    });
    if (minDist > waterR + track.halfWidth + 5 && clearOfFeat && modsOK) {
      lakes.push({
        ribbon: true, spine, level,
        floor: level - 8,
        waterR,
        shoreR: waterR, // no flat beach; the whole bank rises to the road
        blendR: waterR + bankW, // ramp reaches road height at the barrier
      });
    }
  }

  // A few scenic hill lakes out in the open, placed at seeded angles & distances
  // (not fixed coordinates) so they scatter uniquely per map. We throw a generous
  // batch of candidates and keep the first 1–3 that clear the road and each other.
  const wantHill = 1 + Math.floor(rand() * 3); // 1..3
  let placedHill = 0;
  for (let t = 0; t < 14 && placedHill < wantHill; t++) {
    const ang = rand() * Math.PI * 2;
    const radius = 360 + rand() * 320; // out beyond the loop
    const x = Math.cos(ang) * radius;
    const z = Math.sin(ang) * radius;
    const waterR = 30 + rand() * 26;
    const shoreR = waterR + 12 + rand() * 8;
    const blendR = shoreR + 24 + rand() * 14;
    const gi = track.groundInfo(x, z);
    if (gi.dist < track.halfWidth + blendR + 8) continue; // would touch the road
    if (lakes.some((L) => !L.ribbon && Math.hypot(x - L.x, z - L.z) < blendR + L.blendR + 6)) continue;
    // Keep clear of the hero ribbon lake too.
    if (lakes.some((L) => L.ribbon && lakeDist(L, x, z) < blendR + L.blendR + 6)) continue;
    const level = baseHeight(x, z);
    const cand = {
      x, z, level,
      floor: level - (6 + rand() * 3),
      waterR, shoreR, blendR,
    };
    if (!waterlineClear(x, z, cand)) continue;
    lakes.push(cand);
    placedHill++;
  }

  // Seaside: for each stretch of BEACH biome, drop a large lake with a WIDE flat
  // sandy shore on the outward side, so the beach has open water and a shoreline
  // in view. Reuses the lake carve + water + shore system wholesale (the carved
  // shore automatically takes the beach's sand colour), so there's no bespoke
  // ocean plumbing. The push-out loop guarantees the shore/blend clears the road.
  {
    const beachIdx = [];
    for (let i = 0; i < N; i += 3) {
      const p = track._pts[i];
      if (biomeAt(p.x, p.z).name === "beach") beachIdx.push(i);
    }
    const picks = [];
    if (beachIdx.length) {
      picks.push(beachIdx[Math.floor(beachIdx.length * 0.35)]);
      if (beachIdx.length > 10) picks.push(beachIdx[Math.floor(beachIdx.length * 0.78)]);
    }
    for (const i of picks) {
      const p = track._pts[i];
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
      const waterR = 58;
      const shoreR = waterR + 30; // wide flat sandy beach at the water's edge
      const blendR = shoreR + 16;
      for (let push = 0; push < 6; push++) {
        const off = track.halfWidth + blendR + 10 + push * 16;
        const x = p.x + side.x * outward * off;
        const z = p.z + side.z * outward * off;
        if (track.distanceToCenter(x, z) < track.halfWidth + blendR + 8) continue; // shore/blend would touch the road
        if (lakes.some((L) => (L.ribbon ? lakeDist(L, x, z) : Math.hypot(x - L.x, z - L.z)) < blendR + (L.blendR || 0) + 6)) continue;
        const level = baseHeight(x, z) - 1.5;
        const cand = { x, z, level, floor: level - 7, waterR, shoreR, blendR, beach: true };
        if (!waterlineClear(x, z, cand)) continue;
        lakes.push(cand);
        break;
      }
    }
  }
  return lakes;
}

// Distance from (x,z) to a lake — radial for a circle lake, nearest-point on the
// spine polyline for a ribbon lake.
function lakeDist(L, x, z) {
  if (!L.ribbon) return Math.hypot(x - L.x, z - L.z);
  let md = Infinity;
  const sp = L.spine;
  for (let i = 0; i < sp.length - 1; i++) {
    const a = sp[i], b = sp[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < md) md = d;
  }
  return md;
}

function carveLakes(lakes, x, z, h) {
  for (const L of lakes) {
    const d = lakeDist(L, x, z);
    if (d >= L.blendR) continue;
    if (d < L.waterR) {
      const u = d / L.waterR; // 0 centre .. 1 shoreline
      h = L.floor + (L.level - L.floor) * (u * u); // bowl floor up to water level
    } else if (d < L.shoreR) {
      h = L.level; // flat beach at the waterline
    } else {
      const u = (d - L.shoreR) / (L.blendR - L.shoreR);
      const s = u * u * (3 - 2 * u); // smoothstep beach -> natural terrain
      h = L.level + (h - L.level) * s;
    }
  }
  return h;
}

// Stylised toon water shared by round and ribbon lakes. Colour/foam are driven
// by a per-vertex "shore" value (0 at the centre/spine, 1 at the bank) and a
// "len" value along the water, so there's no concentric/pinwheel pattern.
function makeWaterMaterial(darken = 1) {
  // TSL node material (WebGPU). Now a METALLIC standard material so screen-space
  // reflections (SSR, in main.js) mirror the scene on the lake. It keeps its
  // stylised deep/shallow/foam colour as the base (so it reads blue, not pure
  // mirror) and the ripples modulate roughness so the reflection shimmers. aShore:
  // 0 at the centre/spine -> 1 at the bank. aLen: along the water. Animates off the
  // global TSL `time`. `darken` dims it at dusk/night.
  // depthWrite off: the water never needs to occlude anything by depth (the
  // depth TEST against the already-drawn opaque world still applies), and any
  // coincident water triangles — the welded fold pinch, or two lakes stacked
  // along a grazing view — blend smoothly instead of z-fighting as dithered
  // blocky bands (visible from a low/underwater camera in the track viewer).
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const shore = attribute("aShore");
  const len = attribute("aLen");
  // Deep water leans clearly BLUE: the old 0x1f6f8c teal picked up the green
  // terrain under the 92%-opaque surface and read as swamp from above.
  const deep = tslColor(0x2578ab).mul(darken);
  const shallow = tslColor(0x57c6d6).mul(darken);
  const foamCol = tslColor(0xeafcff).mul(0.4 + 0.6 * darken);
  const w1 = len.mul(40).add(shore.mul(8)).add(time.mul(1.4)).sin();
  const w2 = len.mul(26).sub(shore.mul(5)).sub(time.mul(1.0)).sin();
  const ripple = smoothstep(0.55, 0.95, w1.mul(0.5).add(0.5)).mul(0.6)
    .add(smoothstep(0.65, 0.98, w2.mul(0.5).add(0.5)).mul(0.4));
  let col = mix(deep, shallow, smoothstep(0.0, 1.0, shore));
  col = mix(col, col.mul(1.18), ripple.mul(0.5));
  // Fresnel "reflection": water brightens toward a sky tint at grazing angles
  // (looking across it) — the cue that sells a reflective surface. This used to
  // drive SSR metalness instead, but a flat up-facing plane viewed at grazing
  // angles while driving past is SSR's worst case: the reflected bank slides
  // off-screen and the half-res march collapses into blocky miss-patches that
  // read as holes in the water (the same failure the puddles hit — see
  // track.js _buildPuddles). Bake the sky tint like the puddles do and keep the
  // lakes off the SSR path. Foam fringe stays matte so the bank doesn't tint.
  const fres = normalView.dot(positionViewDirection).clamp(0, 1).oneMinus().pow(3);
  const shoreFade = smoothstep(0.9, 0.7, shore);
  const skyTint = tslColor(0xcfe6f2).mul(0.4 + 0.6 * darken);
  // The fresnel term goes to ~0 looking straight down, which left overhead
  // views (track viewer, high camera sweeps) totally untinted — a flat murky
  // slab. A small constant floor keeps a hint of sky in the water from every
  // angle; grazing views still get the full effect on top.
  col = mix(col, skyTint, fres.mul(0.5).add(0.12).mul(shoreFade));
  col = mix(col, foamCol, smoothstep(0.84, 0.995, shore));
  mat.colorNode = col;
  mat.roughnessNode = float(0.05).add(ripple.mul(0.2)); // tight sun glints; ripples shimmer them
  mat.opacityNode = float(0.95); // a touch more opaque: the dark lake bed was muddying the colour
  // Dummy uniforms bag so the existing `w.uniforms.uTime.value = …` write stays a
  // harmless no-op (animation is via `time`).
  mat.uniforms = { uTime: { value: 0 } };
  return mat;
}

function buildWater(scene, lakes, darken = 1) {
  const mats = [];
  for (const L of lakes) {
    const mat = makeWaterMaterial(darken);
    const mesh = L.ribbon ? ribbonWaterMesh(L, mat) : circleWaterMesh(L, mat);
    scene.add(mesh);
    mats.push(mat);
  }
  return mats;
}

function circleWaterMesh(L, mat) {
  const geo = new THREE.CircleGeometry(L.waterR, 56);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const shore = new Float32Array(pos.count);
  const lenA = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    shore[i] = Math.min(1, Math.hypot(x, z) / L.waterR);
    lenA[i] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
  }
  geo.setAttribute("aShore", new THREE.BufferAttribute(shore, 1));
  geo.setAttribute("aLen", new THREE.BufferAttribute(lenA, 1));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(L.x, L.level + 0.05, L.z);
  return mesh;
}

// A flat ribbon following the spine (left edge / centre / right edge per
// sample) with rounded end caps, so the water hugs the curve of the road.
function ribbonWaterMesh(L, mat) {
  const sp = L.spine, half = L.waterR, n = sp.length;
  // Edge polylines at ±half. On the inside of a bend tighter than the ribbon
  // is wide, the raw offset points REVERSE direction (the offset curve
  // self-intersects): the folded quads z-fight with themselves and smear
  // bright shallow/foam colour across the middle of the lake as a striped
  // "fan". Enforce monotone edges instead: any edge point that would step
  // backwards against the spine's travel is welded to the previous edge
  // point — the folded quads collapse to zero area (invisible), and the
  // slight overreach past the true offset boundary hides under the bank,
  // which rises above water level right there.
  const edges = [[], []]; // [-side, +side], one {x, z, welded} per spine sample
  for (const sgn of [-1, 1]) {
    const e = edges[(sgn + 1) / 2];
    for (let j = 0; j < n; j++) {
      const s = sp[j];
      e.push({ x: s.x + s.sx * sgn * half, z: s.z + s.sz * sgn * half, welded: false });
    }
    for (let j = 1; j < n; j++) {
      const k = Math.min(j + 1, n - 1);
      const tx = sp[k].x - sp[j - 1].x, tz = sp[k].z - sp[j - 1].z; // spine travel
      if ((e[j].x - e[j - 1].x) * tx + (e[j].z - e[j - 1].z) * tz < 0) e[j] = { x: e[j - 1].x, z: e[j - 1].z, welded: true };
    }
    // Second pass: a slow spiral fold "advances" at every LOCAL step (the test
    // above can't see it) yet still sweeps back over the water of an earlier
    // stretch of spine. Those overlapping coplanar quads double-blend and
    // z-fight — seen from a low or underwater camera they smear as blocky
    // shimmering bands. Any edge point sitting well inside the corridor of a
    // clearly-earlier spine section gets welded too.
    for (let j = 2; j < n; j++) {
      if (e[j].welded) continue;
      for (let k = 0; k < j - 3; k++) {
        const dx = e[j].x - sp[k].x, dz = e[j].z - sp[k].z;
        if (dx * dx + dz * dz < half * half * 0.81) { // inside 0.9·half of an earlier section
          e[j] = { x: e[j - 1].x, z: e[j - 1].z, welded: true };
          break;
        }
      }
    }
  }
  const pos = [], shore = [], lenA = [], idx = [];
  for (let j = 0; j < n; j++) {
    const s = sp[j], u = j / (n - 1);
    // Welded edge points sit INSIDE the water (at the fold pinch), so give
    // them a shore value under the foam threshold — full shore=1 painted a
    // white foam streak across the middle of the pinch.
    pos.push(edges[0][j].x, 0, edges[0][j].z); shore.push(edges[0][j].welded ? 0.7 : 1); lenA.push(u);
    pos.push(s.x, 0, s.z); shore.push(0); lenA.push(u);
    pos.push(edges[1][j].x, 0, edges[1][j].z); shore.push(edges[1][j].welded ? 0.7 : 1); lenA.push(u);
  }
  for (let j = 0; j < n - 1; j++) {
    const a = j * 3, b = (j + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const cap = (end, nb) => {
    const s = sp[end];
    let tx = sp[end].x - sp[nb].x, tz = sp[end].z - sp[nb].z;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const c = pos.length / 3;
    pos.push(s.x, 0, s.z); shore.push(0); lenA.push(end === 0 ? 0 : 1);
    // On a curving end the half-disc otherwise reaches back OVER the body's
    // last quads — the overlap double-blends as a visibly deeper wedge with a
    // hard seam. Pull any cap vertex that would land inside the corridor of a
    // non-adjacent spine section back toward the cap centre (largest clear
    // radius, found by a short bisection).
    const capClamp = (dx, dz, f) => {
      const clear = (ff) => {
        const px = s.x + dx * half * ff, pz = s.z + dz * half * ff;
        for (let k = 0; k < n; k++) {
          if (Math.abs(k - end) <= 2) continue;
          const ddx = px - sp[k].x, ddz = pz - sp[k].z;
          if (ddx * ddx + ddz * ddz < half * half * 0.85) return false;
        }
        return true;
      };
      if (clear(f)) return f;
      let lo = 0, hi = f;
      for (let it = 0; it < 4; it++) { const mid = (lo + hi) / 2; if (clear(mid)) lo = mid; else hi = mid; }
      return lo;
    };
    // Radial RINGS so aShore grades across the cap the way it does across the
    // ribbon body. The old single fan interpolated shore over whole
    // half-width-sized triangles, so the cap rendered as one solid bright
    // shallow disc with a hard seam against the dark body.
    const SEG = 8, RINGS = 3;
    const ringStart = [];
    for (let r = 1; r <= RINGS; r++) {
      ringStart[r] = pos.length / 3;
      const f = r / RINGS;
      for (let k = 0; k <= SEG; k++) {
        const ang = (k / SEG) * Math.PI - Math.PI / 2;
        const dx = Math.cos(ang) * tx + Math.sin(ang) * s.sx;
        const dz = Math.cos(ang) * tz + Math.sin(ang) * s.sz;
        const fc = capClamp(dx, dz, f);
        pos.push(s.x + dx * half * fc, 0, s.z + dz * half * fc);
        shore.push(fc); lenA.push(end === 0 ? 0 : 1);
      }
    }
    for (let k = 0; k < SEG; k++) idx.push(c, ringStart[1] + k, ringStart[1] + k + 1);
    for (let r = 1; r < RINGS; r++)
      for (let k = 0; k < SEG; k++) {
        const a = ringStart[r] + k, b = ringStart[r + 1] + k;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
  };
  cap(0, 1);
  cap(n - 1, n - 2);
  // Enforce UPWARD-facing winding on every triangle. The spine's side vector
  // flips handedness with the lake's infield sign (and each cap's outward
  // tangent flips it again), so the raw winding faced DOWN on some lakes and
  // caps. DoubleSide still drew those triangles, but the renderer flips the
  // +Y vertex normals on backfaces and lit the water from BELOW — the whole
  // lake rendered as a near-black slab (hemisphere ground light only), with
  // bright shallow colour only on the odd cap/fold whose winding flipped
  // back. The "sometimes odd" was literally which side of the road the
  // lake's spine sat on.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const abx = pos[b] - pos[a], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acz = pos[c + 2] - pos[a + 2];
    // (ab × ac).y < 0 → faces down → swap two indices to flip it up.
    if (abz * acx - abx * acz < 0) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  // The ribbon is flat (y=0 everywhere), so every normal is straight up. The lit
  // water material needs them for its lighting/fresnel/SSR — without the
  // attribute every ribbon lake logs a TSL.NormalNode warning and shades wrong.
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("aShore", new THREE.Float32BufferAttribute(shore, 1));
  geo.setAttribute("aLen", new THREE.Float32BufferAttribute(lenA, 1));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = L.level + 0.05; // spine positions are already world x/z
  return mesh;
}

// ---- Roadside ground cover -------------------------------------------------
// One tapered card standing on y=0, exactly 1 unit tall (the wind bend measures
// its offsets as a fraction of that height, so every sprig must share it) with
// a base→tip colour gradient baked in. Two height segments, because a bend
// weighted by y² across a single quad can only shear it — the extra ring is
// what turns the lean into an arc.
function sprigCard(wBase, wTop, lo, hi, curve = 0) {
  const SEG = 2;
  const pos = [], col = [], idx = [];
  const a = new THREE.Color(lo), b = new THREE.Color(hi), c = new THREE.Color();
  for (let s = 0; s <= SEG; s++) {
    const t = s / SEG;
    const w = (wBase + (wTop - wBase) * t) * 0.5;
    const bow = curve * t * t; // a resting curve, before any wind
    pos.push(-w, t, bow, w, t, bow);
    c.copy(a).lerp(b, t);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  for (let s = 0; s < SEG; s++) {
    const i0 = s * 2;
    idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Each biome's signature roadside plant. All are built from the same cards and
// all ride the same wind + kart bow-wave, so a gust crosses a meadow of
// flowers, a savanna of dry stalks and a jungle of reeds as ONE gust.
// `scale` stretches the 1-unit card to the plant's real height; `tinted` says
// whether the biome's grass tint multiplies it (flower heads carry their own
// colour and must not be washed green).
const SPRIGS = {
  blade: { scale: 1.0, tinted: true, geo: () => sprigCard(0.18, 0.05, 0x2f7d32, 0x86c560, 0.06) },
  flower: { scale: 0.95, tinted: true, geo: () => sprigCard(0.07, 0.035, 0x3c7d3a, 0x6faa52, 0.05) },
  stalk: { scale: 1.75, tinted: true, geo: () => sprigCard(0.07, 0.03, 0x8a7434, 0xd8c072, 0.1) },
  reed: { scale: 1.6, tinted: true, geo: () => sprigCard(0.16, 0.02, 0x1f6b2c, 0x63b45a, 0.14) },
  scrub: { scale: 0.6, tinted: true, geo: () => sprigCard(0.1, 0.02, 0x6f6338, 0xa79a63, 0.16) },
  tussock: { scale: 0.55, tinted: true, geo: () => sprigCard(0.14, 0.03, 0x5d6a55, 0x9aa88c, 0.1) },
  marram: { scale: 1.2, tinted: true, geo: () => sprigCard(0.09, 0.02, 0x7f8a52, 0xc3c98a, 0.18) },
};
const SPRIG_BY_BIOME = {
  meadow: "flower", blossom: "flower",
  savanna: "stalk", autumn: "stalk",
  jungle: "reed",
  desert: "scrub", mesa: "scrub",
  alpine: "tussock", tundra: "tussock",
  beach: "marram",
};
// Flower-head palettes. The heads ride as a SECOND instanced mesh on the very
// same roots, yaws and scales as the stems, so they bend with their own stem
// exactly — and being separate, they can carry a colour of their own instead of
// being multiplied into the biome's green.
const FLOWER_COLS = {
  meadow: [0xfff3d0, 0xffe27a, 0xf6f2ff, 0xe8b6f0],
  blossom: [0xffd3e4, 0xffb0cd, 0xfff0f6, 0xff9ec2],
};
// A few petals: two crossed cards up at the top of the stem, tiny and white so
// the per-instance colour reads true.
function flowerHeadGeo() {
  const a = sprigCard(0.02, 0.17, 0xffffff, 0xffffff);
  const b = sprigCard(0.02, 0.17, 0xf2f2f2, 0xf2f2f2);
  a.translate(0, -1, 0); a.scale(1, 0.13, 1); a.translate(0, 0.95, 0);
  b.translate(0, -1, 0); b.scale(1, 0.13, 1); b.translate(0, 0.95, 0);
  b.rotateY(Math.PI / 2);
  return mergeGeometries([a, b]);
}

// Instanced roadside cover along the verge, swaying in the shared wind.
function buildGrass(scene, track, heightAt) {
  const COUNT = 26000; // instanced 4-triangle cards — cheap to raise
  const halfW = track.halfWidth;
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);

  // TSL node material. The old GLSL onBeforeCompile sway/backlight never ran
  // under WebGPURenderer — BOTH its backends (WebGPU and the WebGL2 fallback)
  // compile through the node system, which ignores onBeforeCompile — so the
  // meadow has stood perfectly still since the WebGPU migration. Rebuilt as
  // nodes: the idle wind sway, the sun backlight (reading the same shared
  // uSunView/uSunCol nodes as the tree foliage), and the new kart BOW-WAVE.
  //
  // Bow-wave: blades close to the player kart lean away from it, harder with
  // speed — the roadside physically parts as you blast past. uKart is
  // (x, y, z, strength), written once per frame from the main loop.
  const uKart = uKartPos; // shared: the petal flurry reads the same kart
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 1,
  });
  mat.userData.skipToon = true; // keep the custom position/emissive nodes
  {
    const root = attribute("aRoot"); // blade base, world space
    const yawScale = attribute("aYawScale"); // instance yaw + scale
    // A blade BENDS about its planted base — it never slides. Every offset
    // below is a FRACTION OF THE BLADE'S OWN HEIGHT (local space is exactly 1
    // unit tall, so the numbers are already that fraction) weighted by y²: nil
    // at the root, all of it at the tip. The first cut instead pushed tips by a
    // fixed number of WORLD units, which uprooted short blades, stretched them
    // to twice their length and made the meadow look like it was flying apart.
    // A sprig BENDS about its planted base — it never slides.
    //
    // Read the height off positionGeometry, NOT positionLocal: on an
    // InstancedMesh three has already folded the instance matrix into
    // positionLocal by the time a positionNode sees it, so positionLocal.y is
    // the blade's WORLD height (tens of units on a hillside), not 0..1. Using
    // it squared the terrain height into the bend weight and hurled the whole
    // meadow into the distance — which is precisely the "grass flies all over
    // the place" this shader was reported for. It survived earlier passes only
    // because the coefficients happened to be small enough to look merely odd.
    //
    // The flip side of that same fact: an offset added to positionLocal lands
    // in WORLD space (these meshes sit at the origin), so the wind and bow-wave
    // vectors go in as-is — no rotating them back through the instance yaw.
    const y01 = positionGeometry.y; // 0 at the base -> 1 at the tip, always
    const bend = y01.mul(y01); // base holds firm, the top gives
    const height = yawScale.y; // uniform instance scale of a 1-unit card = its height
    // Idle wind comes from the shared field (wind.js), so a gust that lays the
    // grass over is the same gust rolling through the trees a moment later.
    const sway = windLean(root.x, root.z, 0.18);
    // Bow-wave: sprigs close to the player kart lean away from it, harder with
    // speed. Amplitudes are fractions of the plant's OWN height, so a short
    // blade and a tall reed bend through the same angle.
    const dx = root.x.sub(uKart.x);
    const dz = root.z.sub(uKart.z);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt().max(0.001);
    const near = smoothstep(0.9, 3.8, dist).oneMinus(); // 1 at the kart -> 0 by 3.8u
    const push = near.mul(near).mul(uKart.w).mul(0.5); // <= ~0.55 of a plant height
    const reach = bend.mul(height); // world units at an amplitude of 1
    const px = sway.x.add(dx.div(dist).mul(push)).mul(reach);
    const pz = sway.y.add(dz.div(dist).mul(push)).mul(reach);
    // Length preservation: leaning a tip out by s costs it ~s²/2 of reach, so
    // the sprig arcs over its base rather than growing.
    const py = px.mul(px).add(pz.mul(pz)).mul(-0.5).div(height.max(0.001));
    mat.positionNode = positionLocal.add(vec3(px, py, pz));
    // Looking toward the sun through the blade -> warm translucent glow,
    // strongest near the (lighter) tips. Same shared nodes as the foliage
    // (main.js drives them each frame); ×1.4 restores the grass's slightly
    // brighter glow from the GLSL era.
    const backlit = positionViewDirection.negate().dot(uSunViewNode).max(0).pow(3);
    mat.emissiveNode = uSunColNode.mul(1.4).mul(backlit).mul(attribute("color").y.mul(0.65).add(0.35));
  }

  // All sprig kinds share the material (and so the one wind + bow-wave shader),
  // and hang off a group so main.js keeps its single `world.grass` handle for
  // the uKart write and the quality toggle.
  const group = new THREE.Group();
  group.userData.uKart = uKart; // main.js writes the kart position + push here
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const _side = new THREE.Vector3();
  const byKind = new Map(); // kind -> instance records, bucketed for one mesh each
  let n = 0;
  let tries = 0;
  // PLACEMENT — the sway was invisible in play for a placement reason, not a
  // shader one. The old scatter spread single blades evenly from the kerb out
  // to 36u, which over a ~2.8km loop worked out to ONE BLADE PER ~34m², with
  // the median blade 20u past the road edge: nothing you could ever see from a
  // kart. Now they go down in TUFTS hugging the verge, where the eye actually
  // is, with a thinner outfield scatter so the fringe doesn't end in a stripe.
  const TUFT = 7; // blades per tuft — a clump reads as grass; a lone blade doesn't
  while (n < COUNT && tries < COUNT * 3) {
    tries++;
    const i = Math.floor(rand() * N);
    const pt = track._pts[i];
    _side.crossVectors(track._tans[i], up).normalize();
    const dir = rand() < 0.5 ? 1 : -1;
    // 4 in 5 tufts sit in the 7.5u fringe just past the kerb; the rest thin out
    // across the next 16u so the verge blends into the scenery.
    const dist = rand() < 0.8 ? halfW + 1 + rand() * 7.5 : halfW + 8.5 + rand() * 16;
    const tx = pt.x + _side.x * dir * dist;
    const tz = pt.z + _side.z * dir * dist;
    if (track.distanceToCenter(tx, tz) < halfW + 0.8) continue;
    if (_inLake(tx, tz)) continue;
    const biome = biomeAt(tx, tz);
    if (rand() > biome.grassDensity) continue; // sparse in dry biomes
    // The whole tuft is one plant type — mixed sprigs in a single clump read as
    // a mess, and a stand of one thing is what a verge actually looks like.
    const kind = SPRIG_BY_BIOME[biome.name] || "blade";
    const petals = FLOWER_COLS[biome.name];
    let recs = byKind.get(kind);
    if (!recs) byKind.set(kind, (recs = []));
    for (let k = 0; k < TUFT && n < COUNT; k++) {
      const x = tx + (rand() - 0.5) * 0.9;
      const z = tz + (rand() - 0.5) * 0.9;
      recs.push({
        x, y: heightAt(x, z), z,
        yaw: rand() * Math.PI,
        scale: (0.7 + rand() * 1.1) * SPRIGS[kind].scale,
        tilt: [(rand() - 0.5) * 0.3, (rand() - 0.5) * 0.3],
        tint: biome.grassTint,
        petal: petals ? petals[(rand() * petals.length) | 0] : 0xffffff,
      });
      n++;
    }
  }

  // One instanced mesh per sprig kind (plus a second for flower heads).
  const addMesh = (geo, recs, colourOf, tag) => {
    const aRoot = new Float32Array(recs.length * 3);
    const aYawScale = new Float32Array(recs.length * 2);
    geo.setAttribute("aRoot", new THREE.InstancedBufferAttribute(aRoot, 3));
    geo.setAttribute("aYawScale", new THREE.InstancedBufferAttribute(aYawScale, 2));
    const mesh = new THREE.InstancedMesh(geo, mat, recs.length);
    recs.forEach((r, i) => {
      dummy.position.set(r.x, r.y, r.z);
      dummy.rotation.set(r.tilt[0], r.yaw, r.tilt[1]);
      dummy.scale.setScalar(r.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.set(colourOf(r)));
      aRoot[i * 3] = r.x; aRoot[i * 3 + 1] = r.y; aRoot[i * 3 + 2] = r.z;
      aYawScale[i * 2] = r.yaw; aYawScale[i * 2 + 1] = r.scale;
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.layers.set(2); // own layer: out of the mirror AND the outline pass
    mesh.userData.sprig = tag; // which biome signature this is (probes frame by it)
    group.add(mesh);
  };
  for (const [kind, recs] of byKind) {
    if (!recs.length) continue;
    addMesh(SPRIGS[kind].geo(), recs, (r) => r.tint, kind);
    // Flower heads: same roots, yaws and scales, so each head bends with its
    // own stem — but its own mesh, so its colour isn't multiplied by the
    // biome's green.
    if (kind === "flower") addMesh(flowerHeadGeo(), recs, (r) => r.petal, "flower-head");
  }
  scene.add(group);
  return group;
}

function buildTerrain(scene, heightAt, litLevel = 0, halfExtent = 950) {
  // General ground only dims a LITTLE at night (so the scene stays as bright as it
  // was before) — but snow is darkened HARD, because near-white snow reflects the
  // moonlight far more than anything else and is what reads "self-lit".
  const groundDarken = 1 - litLevel * 0.15; // ~0.85 at night
  // Sheet size follows the track's reach; segment count follows the sheet so
  // cell size (and the look of the rolling detail) stays roughly constant.
  const SIZE = Math.max(1900, Math.ceil(halfExtent * 2));
  const SEG = Math.min(380, Math.round(SIZE / 6.8));
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];
  const cRock = new THREE.Color(0x7a6f5d);
  const cSnow = new THREE.Color(0xf4f7fb);
  const cMoonSnow = new THREE.Color(0x2a3550); // cool, dark "snow under moonlight"
  const base = new THREE.Color();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);

    biomeGround(x, z, base, y);
    const b = biomeAt(x, z, y);
    base.lerp(b.ground2Col, rand() * 0.3); // subtle dappling
    c.copy(base);
    let snowAmt = 0; // how snowy this vertex is, so we can extra-darken it at night
    if (_altMode) {
      // Altitude layout: snow whitens with height (gradual, follows the alpine
      // weight); warm biomes' tallest peaks get a faint rock tint, never white.
      const aw = alpineWeight(y);
      if (aw > 0) { snowAmt = aw * clamp(0.55 + y / 240, 0.55, 1); c.lerp(cSnow, snowAmt); }
      else if (y > 95) c.lerp(cRock, Math.min(0.4, (y - 95) / 130));
    } else if (b.name === "alpine") {
      // Classic layout: the original altitude-banded alpine snow.
      if (y >= 62) { snowAmt = Math.min(1, (y - 62) / 16); c.copy(cRock).lerp(cSnow, snowAmt); }
      else if (y >= 44) c.copy(base).lerp(cRock, (y - 44) / 18);
    } else if (y > 52) {
      c.copy(base).lerp(cRock, Math.min(1, (y - 52) / 32));
    }
    // Snow at night: push it hard toward a dark, cool moonlit tone AND darken it
    // well below the rest of the ground, so it stops glowing like daytime and only
    // brightens where the lamps/headlights actually fall on it. General ground keeps
    // its daytime brightness (just the mild groundDarken).
    let darken = groundDarken;
    if (litLevel > 0 && snowAmt > 0) {
      const snowTint = snowAmt * litLevel; // 0..1, full on high snow at night
      c.lerp(cMoonSnow, Math.min(0.82, snowTint));
      darken *= 1 - snowTint * 0.55; // extra darkening for snow only
    }
    colors.push(c.r * darken, c.g * darken, c.b * darken);
  }

  // Baked ambient occlusion: darken concave ground (valley floors, hill bases,
  // basin/cliff edges) where neighbouring terrain rises above it. Computed once
  // from the grid heights (no projection), so it's free at runtime and adds the
  // depth/grounding that makes a scene feel "lit" rather than flat.
  const seg1 = SEG + 1;
  for (let iz = 0; iz <= SEG; iz++) {
    for (let ix = 0; ix <= SEG; ix++) {
      const idx = iz * seg1 + ix;
      const y = pos.getY(idx);
      let occ = 0;
      let n = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx > SEG || nz > SEG) continue;
        occ += Math.max(0, pos.getY(nz * seg1 + nx) - y);
        n++;
      }
      const ao = 1 - Math.min(0.36, (occ / Math.max(1, n)) * 0.045);
      colors[idx * 3] *= ao;
      colors[idx * 3 + 1] *= ao;
      colors[idx * 3 + 2] *= ao;
    }
  }

  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    flatShading: false, // smooth-shaded so the hills aren't stepped
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Rock palette and snowline per biome. `snow` is the fraction of the mountain's
// own height above which snow starts (1 = never — a snow-capped peak behind a
// cactus looks absurd), and it's a fraction rather than a world height so a
// small foothill and a giant both get their caps in proportion.
const MOUNTAIN_ROCK = {
  alpine: { lo: 0x4e5866, hi: 0x8a97a8, snow: 0.40 },
  tundra: { lo: 0x59616a, hi: 0x939ba4, snow: 0.44 },
  forest: { lo: 0x4a5348, hi: 0x7d8878, snow: 0.66 },
  jungle: { lo: 0x3f5040, hi: 0x6f8470, snow: 0.74 },
  meadow: { lo: 0x6a6355, hi: 0x9a9384, snow: 0.68 },
  blossom: { lo: 0x6e6559, hi: 0xa09689, snow: 0.70 },
  autumn: { lo: 0x6f6045, hi: 0xa08d6c, snow: 0.72 },
  savanna: { lo: 0x7a6647, hi: 0xb09a74, snow: 1 },
  desert: { lo: 0x9c6a3e, hi: 0xd6a874, snow: 1 },
  mesa: { lo: 0x8d4830, hi: 0xc47f56, snow: 1 },
  beach: { lo: 0x8a8270, hi: 0xc0b7a0, snow: 0.85 },
  city: { lo: 0x63656a, hi: 0x94969c, snow: 0.68 },
};

// ONE MOLDED SURFACE, not a cone. The old peaks were literally ConeGeometry
// with a smaller cone stuck on top for snow, which is why they all read the
// same however the height and radius were rolled: a cone has no silhouette to
// vary. This sweeps a single unbroken skin from summit to base and sculpts it
// with azimuth-aware terms — ridges radiating off the summit, gullies eroded
// between them, an off-centre apex, an elliptical base and a leaning axis — so
// every mountain gets its own outline and its own profile from any angle.
//
// The azimuth terms are all cos/sin of INTEGER harmonics, which is what keeps
// the surface welded where the ring closes: any hash-per-vertex noise would
// leave a visible split seam running down one flank. Indices wrap modulo SEGS
// so there is no duplicated seam column to disagree in the first place.
//
// Snow is baked into the vertex colours off the vertex's own height rather
// than being a separate cap mesh, so the snowline follows the ridges and dips
// into the gullies — a ragged line the way real snow lies, not a clean circle.
function mountainGeo(h, rad, rock, opts = {}) {
  const RINGS = 15;
  const SEGS = 28;
  const TAU = Math.PI * 2;
  // Ridge/erosion harmonics. Low counts read as big spurs, high as scree.
  const harm = [];
  for (let k = 0; k < 4; k++) {
    harm.push({ n: 2 + k * 2 + Math.floor(rand() * 2), ph: rand() * TAU, a: (0.20 - k * 0.04) * (0.6 + rand() * 0.8) });
  }
  const gullyN = 5 + Math.floor(rand() * 5);
  const gullyPh = rand() * TAU;
  const gullyA = 0.09 + rand() * 0.09;
  // Elliptical footprint + an axis that leans, so the apex doesn't sit dead
  // centre over the base.
  const ex = 1 + (rand() - 0.5) * 0.5;
  const ez = 1 + (rand() - 0.5) * 0.5;
  const leanX = (rand() - 0.5) * 0.42;
  const leanZ = (rand() - 0.5) * 0.42;
  // A shoulder: one flank swells into a subsidiary bulge partway down.
  const shPh = rand() * TAU;
  const shAmp = 0.18 + rand() * 0.22;
  const shAt = 0.42 + rand() * 0.22;
  const snowStart = opts.snow ?? rock.snow;
  const snowWob = 0.055 + rand() * 0.05; // how ragged the snowline is
  const snowPh = rand() * TAU;

  const lo = new THREE.Color(rock.lo);
  const hi = new THREE.Color(rock.hi);
  const snowCol = new THREE.Color(0xf2f6fb);
  const c = new THREE.Color();

  const pos = [];
  const col = [];
  const idx = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS; // 0 at the apex -> 1 at the base
    // Concave flare, plus a splayed foot (the talus a mountain actually sits in
    // — a clean elliptical cut into the ground is the other half of what made
    // these read as dropped-in cones) and a summit that is a small broken crest
    // rather than a machined point.
    const prof = Math.pow(t, 0.72) + 0.12 * Math.pow(t, 5) + 0.055 * Math.pow(1 - t, 3);
    const ridgeW = Math.sin(Math.PI * Math.pow(t, 0.75)); // spurs peak mid-flank
    for (let j = 0; j < SEGS; j++) {
      const th = (j / SEGS) * TAU;
      let az = 0;
      for (const { n, ph, a } of harm) az += Math.cos(n * th + ph) * a;
      // Gullies only bite the lower flanks, where water would actually run.
      const gully = Math.max(0, Math.cos(gullyN * th + gullyPh)) * gullyA * Math.pow(t, 1.4);
      // The shoulder is a smooth lobe in both azimuth and height.
      const shA = Math.max(0, Math.cos(th - shPh));
      const shH = Math.max(0, 1 - Math.abs(t - shAt) / 0.3);
      const sh = shA * shA * shH * shH * shAmp;
      const r = rad * prof * (1 + az * ridgeW - gully + sh);
      // Summit jag: the very top is broken rock, not a machined point.
      const jag = (Math.cos(3 * th + harm[0].ph) * 0.06 + Math.cos(5 * th - harm[1].ph) * 0.035) * Math.pow(1 - t, 1.9);
      const y = h * (1 - t) + h * jag;
      const x = Math.sin(th) * r * ex + leanX * rad * (1 - t);
      const z = Math.cos(th) * r * ez + leanZ * rad * (1 - t);
      pos.push(x, y, z);
      // Colour: rock gets lighter with height, then a ragged snowline on top.
      const f = Math.max(0, Math.min(1, y / h));
      c.copy(lo).lerp(hi, Math.pow(f, 0.8));
      if (snowStart < 1) {
        const line = snowStart + Math.cos(2 * th + snowPh) * snowWob + Math.cos(5 * th - snowPh) * snowWob * 0.5;
        const sAmt = Math.max(0, Math.min(1, (f - line) / 0.07));
        if (sAmt > 0) c.lerp(snowCol, sAmt);
      }
      // Gullies sit in their own shade — cheap baked occlusion that makes the
      // erosion read in silhouette-free views.
      const shade = 1 - gully * 2.1;
      col.push(c.r * shade, c.g * shade, c.b * shade);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a0 = i * SEGS + j;
      const a1 = i * SEGS + ((j + 1) % SEGS); // wrap: no seam column to split
      const b0 = a0 + SEGS;
      const b1 = a1 + SEGS;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildMountains(scene, heightAt, track, trackReach = 900) {
  // One vertex-coloured material for every peak in the world: the rock palette,
  // the snowline and the gully shading all live in the vertex colours, so the
  // whole ring still bakes down to a single draw.
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });

  // Peaks never move — collect every one and bake the lot into ONE mesh at the
  // end (~50 draw calls → 1). The ring surrounds the camera so half of it is in
  // view from anywhere; per-peak frustum culling bought little, and the whole
  // ring is only a few thousand triangles.
  // Peaks never move — collect every one and bake the lot into ONE mesh at the
  // end. NOTE they are merged here with mergeGeometries rather than the shared
  // mergeMeshes helper: that one strips every attribute except position/normal/
  // uv so mismatched parts always merge cleanly, which silently threw away the
  // `color` attribute and left vertexColors reading nothing — a range of
  // blank-white mountains that raised no error at all.
  const peakGeos = [];
  const peakInfo = []; // where each summit ended up, so probes can frame one
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _v = new THREE.Vector3();
  const place = (geo, x, y, z) => {
    _e.set(0, rand() * Math.PI * 2, 0);
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(_m4);
    peakGeos.push(geo);
  };
  const peak = (x, z, h, rad, bury) => {
    const rock = MOUNTAIN_ROCK[biomeAt(x, z).name] || MOUNTAIN_ROCK.meadow;
    const base = heightAt(x, z) - bury;
    place(mountainGeo(h, rad, rock), x, base, z);
    peakInfo.push({ x, z, y: base, h, rad });
    // Bigger peaks come as a MASSIF rather than a lone spike: a subsidiary
    // summit set off to one side and fused into the same footprint. It is the
    // single strongest cue that a mountain is a mountain and not a pyramid.
    if (h > 150 && rand() < 0.7) {
      const a = rand() * Math.PI * 2;
      const d = rad * (0.55 + rand() * 0.3);
      const sx = x + Math.cos(a) * d;
      const sz = z + Math.sin(a) * d;
      place(mountainGeo(h * (0.5 + rand() * 0.22), rad * (0.55 + rand() * 0.2), rock), sx, heightAt(sx, sz) - bury * 0.7, sz);
    }
  };

  // Distant mountain ring around the whole world. Pushed out past the loop's
  // ACTUAL reach (big maps stretch further than the old fixed ring allowed),
  // so a ring peak never lands on the track.
  const ringBase = Math.max(1080, trackReach + 230);
  const count = 24;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.2;
    const r = ringBase + rand() * 180;
    peak(Math.cos(a) * r, Math.sin(a) * r, 190 + rand() * 160, 90 + rand() * 70, 30);
  }

  // A few peaks brought in close beside the track, so you race right up against
  // a mountainside on those stretches. On curvy circuits the loop can fold back
  // near the spot "outward" of a road point, so verify the peak's whole footprint
  // clears the ENTIRE track (not just the point it was offset from) before placing
  // it — otherwise a mountain ends up cutting across a different part of the road.
  if (track) {
    const up = new THREE.Vector3(0, 1, 0);
    for (const tt of [0.24, 0.58, 0.9]) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const i = Math.floor(((tt + attempt * 0.045) % 1) * track.samples);
        const p = track._pts[i];
        const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
        const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
        const off = 165 + rand() * 55;
        const rad = 62 + rand() * 30;
        const x = p.x + side.x * outward * off;
        const z = p.z + side.z * outward * off;
        // Need the road's nearest approach to clear the cone's base radius.
        if (track.distanceToCenter(x, z) < track.halfWidth + rad + 12) continue;
        peak(x, z, 120 + rand() * 50, rad, 22);
        break;
      }
    }
  }
  if (peakGeos.length) {
    const merged = new THREE.Mesh(mergeGeometries(peakGeos), rockMat);
    merged.castShadow = false;
    merged.receiveShadow = false;
    merged.frustumCulled = false; // the ring surrounds every viewpoint anyway
    merged.userData.mountains = peakInfo; // probes census + frame the range by this
    scene.add(merged);
  }
}


// Helper: scatter `count` valid positions away from the road.
function scatter(count, track, flatten, minFlat, range) {
  const out = [];
  let tries = 0;
  while (out.length < count && tries < count * 30) {
    tries++;
    const x = (rand() - 0.5) * range;
    const z = (rand() - 0.5) * range;
    const d = track.distanceToCenter(x, z);
    if (flatten(d) < minFlat) continue;
    out.push({ x, z });
  }
  return out;
}

// Loose leaves scattered across the ground (in addition to the knockable piles) so
// leafy biomes feel carpeted and lived-in. The shared leaf silhouette, small and
// autumn-toned, denser in autumn/forest. They gently RUSTLE in the wind (the
// "alive" part). Split into spatial CHUNKS so off-screen leaves frustum-cull — a
// single track-spanning mesh could never cull, so every leaf was processed every
// frame; chunking lets us carry far more leaves for less cost. No shadow (flat).
const GROUND_LEAF_COLS = [0xc4471f, 0xe07b1e, 0xf0c040, 0xd23a2a, 0x9c6b1f, 0x7a2e1e, 0xe8a838];
// Fallen cherry-blossom petals: candy pinks + a few near-whites, so the blossom
// biome floor reads as a pink carpet that kicks up in the same wake as the leaves.
const PETAL_COLS = [0xffc7dd, 0xff9fc4, 0xffd9e6, 0xf7b0cf, 0xffe3ef, 0xff8fb8];
const FOREST_LEAF_COLS = [0x3f6b2c, 0x4f7d34, 0x6b8e3a, 0x5a4327, 0x2f5520, 0x7a5a2c];
const MEADOW_DEBRIS_COLS = [0x9fd06a, 0x8cc457, 0xb6e07a, 0xe8e26a, 0xfbfbfb, 0xc7e08a]; // clippings + wildflower specks
const SAVANNA_DEBRIS_COLS = [0xcdae5e, 0xb8973f, 0xd9c070, 0xa07f3a, 0xe0cb84]; // dry golden grass
const DESERT_DEBRIS_COLS = [0xd2b074, 0xc49a5a, 0xbf8f4a, 0xddc590, 0xb98e50]; // sand + dry scrub
const SNOW_DEBRIS_COLS = [0xeef4fa, 0xdfeaf2, 0xffffff, 0xcfe0ec, 0xe6eef5]; // frost flecks / snow tufts
// Per-biome ground debris that scatters across the verge and kicks up in a kart's
// wake. Every biome gets something appropriate so the whole track feels alive, not
// just the leafy ones: snow flecks on the cold biomes, sand on the desert, dry
// grass on the savanna, leaves/petals/clippings elsewhere. Shared wake shader.
const GROUND_DEBRIS = {
  autumn: { dens: 1.0, cols: GROUND_LEAF_COLS },
  blossom: { dens: 0.9, cols: PETAL_COLS },
  forest: { dens: 0.7, cols: FOREST_LEAF_COLS },
  meadow: { dens: 0.36, cols: MEADOW_DEBRIS_COLS },
  savanna: { dens: 0.5, cols: SAVANNA_DEBRIS_COLS },
  desert: { dens: 0.26, cols: DESERT_DEBRIS_COLS },
  alpine: { dens: 0.42, cols: SNOW_DEBRIS_COLS },
  tundra: { dens: 0.5, cols: SNOW_DEBRIS_COLS },
};

// Colour for one airborne fleck of the LOCAL biome's loose debris (the wake
// wash the karts throw up at speed — see effects.wakeDebris): a random pick
// from the same palettes as the ground-leaf carpet, so what flies up behind a
// kart matches what's lying on the verge. Biomes without a carpet get their
// own small palettes (city litter, beach sand, jungle leaves); anything else
// falls back to the dust tint. Writes/returns `out` (caller owns it).
const WAKE_DEBRIS_COLS = {
  autumn: GROUND_LEAF_COLS,
  blossom: PETAL_COLS,
  forest: FOREST_LEAF_COLS,
  meadow: MEADOW_DEBRIS_COLS,
  savanna: SAVANNA_DEBRIS_COLS,
  desert: DESERT_DEBRIS_COLS,
  mesa: DESERT_DEBRIS_COLS,
  alpine: SNOW_DEBRIS_COLS,
  tundra: SNOW_DEBRIS_COLS,
  city: [0xd8d8d2, 0xbfc3c7, 0xe8e6da, 0xaab0b6], // paper scraps + street grit
  beach: [0xe8d9ae, 0xf2e8c8, 0xd9c493, 0xfbf6e4], // sand + shell chips
  jungle: [0x2f6e33, 0x4a8f3c, 0x6aa84f, 0x3c5a24], // deep green leaf bits
};
export function biomeDebrisColor(x, z, out = new THREE.Color()) {
  const pal = WAKE_DEBRIS_COLS[biomeAt(x, z).name];
  if (!pal) return biomeDustColor(x, z, out);
  return out.set(pal[(Math.random() * pal.length) | 0]);
}

function buildGroundLeaves(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const placements = [];
  const MAX = 1900;
  for (let i = 0; i < N && placements.length < MAX; i++) {
    const p = track._pts[i];
    const b = biomeAt(p.x, p.z);
    const cfg = GROUND_DEBRIS[b.name];
    const dens = cfg ? cfg.dens : 0;
    if (dens <= 0) continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const tries = Math.ceil(dens * 6);
    for (let k = 0; k < tries && placements.length < MAX; k++) {
      if (rand() > dens) continue;
      const lat = (rand() * 2 - 1) * (track.halfWidth + 12); // on the road edges + verge
      const x = p.x + side.x * lat + (rand() - 0.5) * 5;
      const z = p.z + side.z * lat + (rand() - 0.5) * 5;
      if (_inLake(x, z)) continue;
      placements.push({ x, y: heightAt(x, z), z, cols: cfg.cols });
    }
  }
  if (!placements.length) return null;

  // Kart-wake uniforms: the few karts nearest the camera (updated each frame from
  // main.js). Leaves within uWakeR of one POP UP and flutter, settling as the kart
  // passes — all on the GPU, no per-leaf CPU physics.
  const wakes = [0, 1, 2, 3].map(() => uniform(new THREE.Vector3(1e6, 1e6, 1e6)));
  // A lingering wake TRAIL behind the nearest kart: each puff is (x,y,z,strength)
  // and decays over ~1.5s, so leaves you drive over stay kicked up and flutter
  // back down in your wake instead of snapping flat the instant the kart passes.
  const PUFFS = 12;
  const puffs = Array.from({ length: PUFFS }, () => uniform(new THREE.Vector4(1e6, 1e6, 1e6, 0)));
  const uWakeR = uniform(13.0); // generous so leaves you drive near clearly react (even passing at speed)

  // Shared material across all chunk meshes: wind rustle + kart-wake pop.
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, side: THREE.DoubleSide, flatShading: true });
  const _ph = hash(instanceIndex).mul(6.2832);
  const _t = time.add(_ph);
  const _amp = positionLocal.length().mul(0.45); // idle wind: outer edges rock more than the centre (a touch livelier so none look dead)
  const _sway = vec3(_t.mul(2.6).sin(), _t.mul(3.3).sin().mul(0.4), _t.mul(2.1).cos()).mul(_amp);
  // Wake lift: sum each kart's nearby influence (1 at the kart, 0 past the radius).
  // Built as an immutable node expression (no toVar/assign — those need an Fn scope).
  const _base = attribute("aBase"); // this leaf's world position
  let _liftSum = float(0);
  for (const w of wakes) {
    const dx = _base.x.sub(w.x);
    const dz = _base.z.sub(w.z);
    const d = dx.mul(dx).add(dz.mul(dz)).sqrt();
    _liftSum = _liftSum.add(smoothstep(float(0), uWakeR, d).oneMinus());
  }
  // Trail puffs add their (decaying) strength, so a leaf stays lifted after the
  // kart has gone, then eases back down as the puffs fade — reads as real flutter.
  for (const pf of puffs) {
    const dx = _base.x.sub(pf.x);
    const dz = _base.z.sub(pf.z);
    const d = dx.mul(dx).add(dz.mul(dz)).sqrt();
    _liftSum = _liftSum.add(smoothstep(float(0), uWakeR, d).oneMinus().mul(pf.w));
  }
  const _lift = _liftSum.min(1.0);
  // The leaf geo is baked flat (normal +Y) and instances use yaw-only rotation, so
  // a local +Y offset is world-up: pop the whole leaf up, plus a fast flutter.
  const _pop = vec3(0, 1, 0).mul(_lift.mul(5.0)); // big, obvious pop when a kart passes
  const _wflut = vec3(_t.mul(9.0).sin(), _t.mul(6.5).cos(), _t.mul(7.5).sin()).mul(_lift.mul(2.1)); // strong scatter/swirl in the wake
  mat.positionNode = positionLocal.add(_sway).add(_pop).add(_wflut);

  // Bucket placements into coarse chunks so off-screen leaves cull as a group; each
  // chunk gets its own geo carrying an aBase attribute (per-leaf world position).
  // 200u (was 130) ≈ half the chunk count/draws; still far smaller than the world,
  // so off-screen chunks cull just as effectively.
  const CHUNK = 200;
  const buckets = new Map();
  for (const s of placements) {
    const key = Math.round(s.x / CHUNK) + "_" + Math.round(s.z / CHUNK);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(s);
  }
  const dummy = new THREE.Object3D();
  const _c = new THREE.Color();
  for (const arr of buckets.values()) {
    const geo = makeLeafGeo();
    geo.rotateX(-Math.PI / 2); // lie flat; instances rotate yaw-only so the wake pop stays world-up
    const aBase = new Float32Array(arr.length * 3);
    const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
    arr.forEach((s, i) => {
      dummy.position.set(s.x, s.y + 0.03, s.z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0); // yaw only
      dummy.scale.setScalar(0.5 + rand() * 0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const pal = s.cols || GROUND_LEAF_COLS;
      mesh.setColorAt(i, _c.set(pal[(rand() * pal.length) | 0]));
      aBase[i * 3] = s.x; aBase[i * 3 + 1] = s.y; aBase[i * 3 + 2] = s.z;
    });
    geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(aBase, 3));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false; // flat on the ground — shadow not worth the shadow-pass cost
    mesh.receiveShadow = true;
    mesh.layers.set(1);
    scene.add(mesh);
  }

  // Each frame, point the wake at the karts nearest the camera (those whose wake
  // you'd actually see kicking up leaves).
  const _sorted = [];
  let _puffHead = 0;
  const _lastDrop = new THREE.Vector3(1e6, 1e6, 1e6);
  return {
    update(karts, camPos, dt = 0.016) {
      _sorted.length = 0;
      // Only moving karts kick leaves (same 2.5 u/s gate as the leaf piles) —
      // otherwise the grid at the start line levitates its leaf carpet.
      for (const k of karts) if (k && k.position && Math.abs(k.speed || 0) > 2.5) _sorted.push(k);
      _sorted.sort((a, b) => a.position.distanceToSquared(camPos) - b.position.distanceToSquared(camPos));
      for (let i = 0; i < wakes.length; i++) {
        const k = _sorted[i];
        if (k) wakes[i].value.copy(k.position);
        else wakes[i].value.set(1e6, 1e6, 1e6);
      }
      // Fade the lingering trail (~1.5s e-fold).
      const decay = Math.exp(-dt / 0.6);
      for (const pf of puffs) pf.value.w *= decay;
      // Drop a fresh full-strength puff behind the nearest kart once it's moved a
      // few units, building a trail of disturbed leaves that flutters down behind it.
      const lead = _sorted[0];
      if (lead && _lastDrop.distanceToSquared(lead.position) > 9) {
        _puffHead = (_puffHead + 1) % puffs.length;
        puffs[_puffHead].value.set(lead.position.x, lead.position.y, lead.position.z, 1);
        _lastDrop.copy(lead.position);
      }
    },
  };
}

// Biomes that get ambient airborne fall, with their palette and how fast/tumbly it
// drifts: cherry petals float slowly over blossom, autumn leaves spin down a touch
// faster over the autumn wood. (Snow/rain are handled by the weather system.)
const AMBIENT_FALL = {
  blossom: { cols: PETAL_COLS, speed: 0.12, tumble: 0.18 },
  autumn: { cols: GROUND_LEAF_COLS, speed: 0.17, tumble: 0.34 },
};

// Ambient rain of petals/leaves over the biomes that have it: each speck drifts
// down, sways, snaps back to the top and falls again — the whole loop runs in the
// vertex shader off `time`, so there is ZERO per-frame CPU and no buffer uploads.
// Each speck falls within its own column (XZ fixed at spawn) so chunk bounds stay
// tight and off-screen chunks frustum-cull as a group. One InstancedMesh field per
// biome (shared fall material per biome), built only for biomes actually in play.
function buildBlossomPetals(scene, track, heightAt) {
  for (const [name, cfg] of Object.entries(AMBIENT_FALL)) buildAmbientFall(scene, track, heightAt, name, cfg);
}

function buildAmbientFall(scene, track, heightAt, biomeName, cfg) {
  const N = track.samples;
  const cols = [];
  const MAX = 460;
  for (let i = 0; i < N && cols.length < MAX; i++) {
    const p = track._pts[i];
    if (biomeAt(p.x, p.z).name !== biomeName) continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], UP_Y).normalize();
    for (let k = 0; k < 5 && cols.length < MAX; k++) {
      const lat = (rand() * 2 - 1) * (track.halfWidth + 16); // over the road + verge
      const x = p.x + side.x * lat + (rand() - 0.5) * 6;
      const z = p.z + side.z * lat + (rand() - 0.5) * 6;
      if (_inLake(x, z)) continue;
      cols.push({ x, y: heightAt(x, z), z });
    }
  }
  if (!cols.length) return; // this biome not active on the map — nothing to build

  const FALL_H = 9.0; // metres a speck falls before wrapping back to the top
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, side: THREE.DoubleSide, flatShading: true });
  const _ph = hash(instanceIndex).mul(6.2832);
  // Per-speck fall clock: fract() ramps 0→1 forever; (1-fract) maps it to a
  // descent from FALL_H down to 0, then an instant (and visually hidden) reset.
  const _fallClock = time.mul(cfg.speed).add(hash(instanceIndex));
  const _fall = float(FALL_H).mul(_fallClock.fract().oneMinus());
  // Drift + flutter. Geo is baked flat with yaw-only instances, so a local +Y
  // offset is world-up (same trick as the ground leaves) — and because three
  // folds the instance matrix into positionLocal before this runs, positionLocal
  // .xz IS the speck's world position, which is exactly what the wind field
  // wants to be sampled at. So petals blow the way the trees are leaning,
  // instead of milling about on a clock of their own.
  const _t = time.mul(1.4).add(_ph);
  const _drift = windGustDrift(positionLocal.x, positionLocal.z, 1.15, hash(instanceIndex));
  const _flut = vec3(0, _t.mul(2.3).sin().mul(cfg.tumble), 0);
  // FLURRY: blast through a blossom grove and the fall is disturbed — specks
  // near the kart are thrown outward and UP, hardest at speed, settling back as
  // you pull away. Ambient weather you can also disturb beats ambient weather
  // you can only watch, and the petals were the one biome signature that stayed
  // completely indifferent to the race happening inside it.
  // positionLocal.xz is the speck's world column (three has already folded the
  // instance matrix in), so these are world-space deltas.
  const _kdx = positionLocal.x.sub(uKartPos.x);
  const _kdz = positionLocal.z.sub(uKartPos.z);
  const _kd = _kdx.mul(_kdx).add(_kdz.mul(_kdz)).sqrt().max(0.001);
  const _kick = smoothstep(2.5, 12, _kd).oneMinus().pow(1.6).mul(uKartPos.w);
  const _flurry = vec3(
    _kdx.div(_kd).mul(_kick).mul(3.4),
    _kick.mul(2.8).mul(_t.mul(3.1).sin().mul(0.25).add(0.85)), // lift, with a churn
    _kdz.div(_kd).mul(_kick).mul(3.4)
  );
  mat.positionNode = positionLocal.add(vec3(0, 1, 0).mul(_fall.add(0.6))).add(_drift).add(_flut).add(_flurry);

  const CHUNK = 200; // (was 130 — see the ground-leaf chunk note)
  const buckets = new Map();
  for (const c of cols) {
    const key = Math.round(c.x / CHUNK) + "_" + Math.round(c.z / CHUNK);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(c);
  }
  const dummy = new THREE.Object3D();
  const _c = new THREE.Color();
  for (const arr of buckets.values()) {
    const geo = makeLeafGeo();
    geo.rotateX(-Math.PI / 2); // lie flat; instances rotate yaw-only so the fall stays world-up
    const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
    arr.forEach((c, i) => {
      dummy.position.set(c.x, c.y, c.z); // column base; the shader lifts each speck by _fall
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.45 + rand() * 0.4);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, _c.set(cfg.cols[(rand() * cfg.cols.length) | 0]));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false; // tiny airborne specks — not worth a shadow pass
    mesh.frustumCulled = true;
    mesh.layers.set(1); // keep out of the rear-view mirror render
    scene.add(mesh);
  }
}

// A scribbly tumbleweed ball and a soft seed-fluff dot, drawn to canvases and
// cached — the sprites for the wind-blown debris.
let _debrisTex = {};
function debrisTexture(kind) {
  if (_debrisTex[kind]) return _debrisTex[kind];
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const ctx = c.getContext("2d");
  if (kind === "tumbleweed") {
    // A dense tangle of dry twigs. Chords that START near the centre fill the
    // middle (no donut hole), with a few concentric arcs for the woven-ball read.
    ctx.strokeStyle = "#c9a86a";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.5;
      const r1 = 3 + (i % 5) * 2.5; // start close to centre so the middle fills in
      ctx.beginPath();
      ctx.moveTo(24 + Math.cos(a) * r1, 24 + Math.sin(a) * r1);
      ctx.lineTo(24 + Math.cos(a + 1.7) * 20, 24 + Math.sin(a + 1.7) * 20);
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.ellipse(24, 24, 8 + i * 2.4, 6 + i * 2.6, i * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (kind === "leaf") {
    // Small pointed leaf silhouette (white — tinted per biome by mat.color).
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(24, 6);
    ctx.quadraticCurveTo(40, 18, 24, 42);
    ctx.quadraticCurveTo(8, 18, 24, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(24, 8);
    ctx.lineTo(24, 40);
    ctx.stroke();
  } else if (kind === "streak") {
    // Ground-hugging wisp (blown sand / spindrift): a soft horizontal ribbon.
    const g = ctx.createLinearGradient(2, 0, 46, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.3, "rgba(255,255,255,0.75)");
    g.addColorStop(0.7, "rgba(255,255,255,0.75)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(24, 24, 22, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "paper") {
    // A scrap of litter: a slightly tilted white square with a soft crease.
    ctx.save();
    ctx.translate(24, 24);
    ctx.rotate(0.35);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(-11, -14, 22, 28);
    ctx.fillStyle = "rgba(200,200,200,0.5)";
    ctx.fillRect(-11, -2, 22, 3);
    ctx.restore();
  } else {
    // Soft fluffy seed: a fading radial puff.
    const g = ctx.createRadialGradient(24, 24, 0, 24, 24, 22);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.5, "rgba(245,240,225,0.55)");
    g.addColorStop(1, "rgba(245,240,225,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(24, 24, 22, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  return (_debrisTex[kind] = tex);
}

// Wind-blown debris — every dry or bare biome's airborne signature: tumbleweed
// bowling across the DESERT and MESA, seed-fluff over the SAVANNA, spindrift
// snaking off the ALPINE and TUNDRA snow, litter tumbling through the CITY.
// Each mote hovers around its home point (no linear wrap, so no snap) and is
// carried by the SHARED wind field, which is the whole point: the gust that
// lays the grass over and bends the treeline is the same gust that shoves this
// entire field of tumbleweeds downwind together. Motion is all vertex shader,
// one draw per kind, zero per-frame CPU. Nothing here is precipitation (that's
// the weather system) — this is atmosphere the leafy biomes get from leaves.
function buildWindDebris(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const build = (kind, biomes, cfg) => {
    const bases = [];
    let tries = 0;
    while (bases.length / 3 < cfg.want && tries < cfg.want * 9) {
      tries++;
      const i = Math.floor(rand() * N);
      const p = track._pts[i];
      if (!biomes.includes(biomeAt(p.x, p.z).name)) continue;
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const dirS = rand() < 0.5 ? 1 : -1;
      const dist = track.halfWidth + 3 + rand() * 40;
      const x = p.x + side.x * dirS * dist + (rand() - 0.5) * 10;
      const z = p.z + side.z * dirS * dist + (rand() - 0.5) * 10;
      if (track.distanceToCenter(x, z) < track.halfWidth + 2) continue;
      if (_inLake(x, z)) continue;
      bases.push(x, heightAt(x, z) + cfg.baseLift, z);
    }
    if (!bases.length) return;
    const count = bases.length / 3;
    const geo = new THREE.PlaneGeometry(cfg.size, cfg.size);
    geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(new Float32Array(bases), 3));
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.map = debrisTexture(kind);
    mat.color = new THREE.Color(cfg.tint);
    mat.opacity = cfg.opacity;
    const b = attribute("aBase");
    // Carried by the shared field: downwind on the gust, back as it passes,
    // hopping when it's actually being shoved.
    mat.positionNode = b.add(windGustDrift(b.x, b.z, cfg.amp, hash(instanceIndex), cfg.bounce));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.renderOrder = 3;
    mesh.layers.set(1);
    mesh.userData.debris = kind + ":" + biomes.join("+"); // probes frame by this
    scene.add(mesh);
  };
  // Tumbleweed: bigger, tan, bowls along the ground and hops on the gusts.
  build("tumbleweed", ["desert", "mesa"], { want: 46, size: 2.4, baseLift: 1.1, tint: 0xcfae72, opacity: 0.9, amp: 4.2, bounce: 1.6 });
  // Seed-fluff: small, pale, floats higher and drifts more gently.
  build("fluff", ["savanna"], { want: 90, size: 0.7, baseLift: 1.6, tint: 0xf2ecd8, opacity: 0.7, amp: 3.2, bounce: 0.5 });
  // Spindrift: loose snow torn off the drifts, hugging the ground in long
  // streaks — the cold biomes' answer to the desert's tumbleweed. Tinted COOL
  // rather than white: pure white spindrift over white snow is invisible, and
  // the faint blue shadow-tone is what actually reads as blowing snow.
  build("streak", ["alpine", "tundra"], { want: 130, size: 1.9, baseLift: 0.35, tint: 0xc9dcf0, opacity: 0.62, amp: 4.4, bounce: 0.25 });
  // Litter: paper scraps loose in the streets, kicked about between the kerbs.
  build("paper", ["city"], { want: 42, size: 0.55, baseLift: 0.8, tint: 0xf0eee6, opacity: 0.75, amp: 3.6, bounce: 0.9 });
}

// Debris that CROSSES the road (perceived speed): leaves skittering over the
// tarmac, sand/spindrift wisps snaking across, litter tumbling through the
// city. The wind debris above lives on the verges — these motes put MOVING
// reference objects directly in your path, and overtaking something that is
// itself moving reads faster than passing anything static. Same recipe as
// buildWindDebris (one InstancedMesh per kind+biome actually present, motion
// entirely in the vertex shader off `time`, zero per-frame CPU): each mote
// glides from verge to verge along its row's side vector and FADES OUT before
// the ends, so the wrap-around teleport is never visible.
function buildRoadCrossers(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const span = track.halfWidth + 7; // crossing half-width: verge to verge, a bit beyond
  const build = (kind, biome, cfg) => {
    const bases = [];
    const sides = [];
    let tries = 0;
    while (bases.length / 3 < cfg.want && tries < cfg.want * 12) {
      tries++;
      const i = Math.floor(rand() * N);
      const p = track._pts[i];
      if (biomeAt(p.x, p.z).name !== biome) continue;
      if (featureSpanBlock(track.features, p.x, p.z)) continue; // decks/tunnels own their spans
      const s = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      bases.push(p.x, p.y + cfg.lift, p.z);
      sides.push(s.x, s.z);
    }
    if (!bases.length) return;
    const count = bases.length / 3;
    const geo = new THREE.PlaneGeometry(cfg.size, cfg.size * (cfg.aspect || 1));
    geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(new Float32Array(bases), 3));
    geo.setAttribute("aSide", new THREE.InstancedBufferAttribute(new Float32Array(sides), 2));
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.map = debrisTexture(kind);
    mat.color = new THREE.Color(cfg.tint);
    const b = attribute("aBase");
    const sd = attribute("aSide");
    const ph = hash(instanceIndex);
    // -1 -> +1 across the road, wrapping; per-mote phase AND speed variation so
    // the field never marches in step.
    const u = time.mul(cfg.rate).mul(ph.mul(0.5).add(0.75)).add(ph.mul(7.31)).fract().mul(2).sub(1);
    const hop = time.add(ph.mul(6.2832)).mul(cfg.hopSpd).sin().abs().mul(cfg.hop); // skittering bounce
    const drift = time.add(ph.mul(9.7)).mul(0.9).sin().mul(cfg.driftAmp); // small along-road wobble
    mat.positionNode = vec3(
      b.x.add(sd.x.mul(u.mul(span))).sub(sd.y.mul(drift)),
      b.y.add(hop),
      b.z.add(sd.y.mul(u.mul(span))).add(sd.x.mul(drift))
    );
    // Fade at both ends of the crossing so the wrap is invisible.
    mat.opacityNode = float(cfg.opacity).mul(smoothstep(1.0, 0.82, u.abs()));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = `roadCrosser:${kind}:${biome}`; // findable in headless probes
    mesh.frustumCulled = false; // instances span whole biome stretches
    mesh.castShadow = false;
    mesh.renderOrder = 3;
    mesh.layers.set(1);
    scene.add(mesh);
  };
  // Leaves amble across (~10-16s a crossing); wisps gust across low and fast;
  // litter tumbles through at city-wind pace. Builds for absent biomes no-op.
  // Kept deliberately sparse, small and low — a handful of motes crossing your
  // path sells the speed; a confetti field just reads as clutter.
  const leaf = { want: 10, size: 0.42, lift: 0.16, opacity: 0.6, rate: 0.05, hopSpd: 2.6, hop: 0.3, driftAmp: 1.4 };
  build("leaf", "forest", { ...leaf, tint: 0x4a7230 });
  build("leaf", "autumn", { ...leaf, want: 12, tint: 0xc05f1a });
  build("leaf", "jungle", { ...leaf, tint: 0x3f7d33 });
  build("leaf", "blossom", { ...leaf, size: 0.34, tint: 0xff9fc4, hop: 0.45 }); // petals, floatier
  const wisp = { want: 10, size: 2.4, aspect: 0.4, lift: 0.3, opacity: 0.42, rate: 0.09, hopSpd: 1.2, hop: 0.15, driftAmp: 2.2 };
  build("streak", "desert", { ...wisp, tint: 0xe3c88f });
  build("streak", "mesa", { ...wisp, tint: 0xd9b184 });
  build("streak", "beach", { ...wisp, tint: 0xf0e4bc });
  build("streak", "alpine", { ...wisp, tint: 0xf4f8ff, opacity: 0.55 }); // spindrift
  build("streak", "tundra", { ...wisp, tint: 0xf4f8ff, opacity: 0.55 });
  build("paper", "city", { want: 8, size: 0.42, lift: 0.3, opacity: 0.65, rate: 0.07, hopSpd: 3.1, hop: 0.7, driftAmp: 1.8, tint: 0xe4e4de });
}

function buildTrees(scene, track, heightAt, flatten) {
  // Each candidate spot is tagged with its biome, kept with that biome's tree
  // density, then bucketed by tree style (cone-shaped trees vs desert cacti).
  const spots = scatter(340, track, flatten, 0.55, 1700)
    .filter((s) => !_inLake(s.x, s.z)) // keep forests out of the water
    .filter((s) => !featureTreeBlock(track.features, s.x, s.z)) // bare canyon walls
    .map((s) => ({ ...s, y: heightAt(s.x, s.z), b: biomeAt(s.x, s.z) }))
    .filter((s) => s.y <= 30 && rand() < s.b.treeDensity);

  const leafy = spots.filter((s) => s.b.treeShape !== "cactus" && s.b.treeShape !== "none");
  const cacti = spots.filter((s) => s.b.treeShape === "cactus");
  if (leafy.length) buildShapedTrees(scene, leafy);
  if (cacti.length) buildCacti(scene, cacti);
}

// Per-shape canopy geometry, baked so the canopy BASE sits at y≈0 (it meets the
// trunk top there). Cached so every biome of the same shape shares one geometry
// → one InstancedMesh / draw call per shape, not per tree. flatShading on the
// shared material keeps the merged blobs reading as faceted toon foliage.
const _foliageGeoCache = {};
function foliageGeoFor(shape) {
  if (_foliageGeoCache[shape]) return _foliageGeoCache[shape];
  let g;
  if (shape === "pine") {
    // Stacked tiers → a proper layered conifer instead of a single cone.
    g = mergeGeometries([
      new THREE.ConeGeometry(2.2, 3.0, 7).translate(0, 1.5, 0),
      new THREE.ConeGeometry(1.7, 2.6, 7).translate(0, 3.4, 0),
      new THREE.ConeGeometry(1.15, 2.3, 7).translate(0, 5.2, 0),
    ]);
  } else if (shape === "acacia") {
    // Flat-topped umbrella: a wide, thin dome with a smaller crown on top. Pairs
    // with a tall bare trunk (trunkHmul below) for the savanna silhouette.
    g = mergeGeometries([
      new THREE.SphereGeometry(3.0, 10, 6).scale(1, 0.3, 1).translate(0, 0.7, 0),
      new THREE.SphereGeometry(2.1, 9, 5).scale(1, 0.28, 1).translate(0, 1.25, 0),
    ]);
  } else if (shape === "blossom") {
    // Fluffy cherry cloud: a cluster of offset blobs reads as billowy blossom.
    const blobs = [
      [0, 1.7, 0, 1.75], [1.3, 2.1, 0.4, 1.25], [-1.1, 2.0, -0.5, 1.3],
      [0.3, 2.85, 0.2, 1.3], [-0.4, 1.55, 1.0, 1.1], [0.9, 1.6, -0.9, 1.05],
    ];
    g = mergeGeometries(blobs.map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z)));
  } else if (shape === "palm") {
    // A crown of long fronds that attach at the trunk top and ARCH down and out,
    // like a real palm — each is a thin flat blade whose WIDE end sits at the
    // crown and whose tip droops well below horizontal. No central hub (that read
    // as a spiky star before). Ringed around Y with a little length/droop variety.
    const fronds = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const len = 3.4 + (i % 3) * 0.4;
      const f = new THREE.ConeGeometry(0.5, len, 3); // 3-sided → a flat-ish blade
      f.scale(1, 1, 0.16); // flatten into a frond
      f.rotateZ(Math.PI / 2); // lay it along +X (tip outward)
      f.translate(len / 2, 0, 0); // pivot at the WIDE base (crown), tip out at +len
      f.rotateZ(-0.7 - (i % 2) * 0.12); // arch: base stays at crown, tip droops down
      f.rotateY((i / n) * Math.PI * 2 + (i % 2) * 0.18);
      fronds.push(f);
    }
    g = mergeGeometries(fronds);
    g.translate(0, 0.5, 0); // sit the crown at the trunk top
  } else {
    // round (deciduous): a single faceted lollipop crown.
    g = new THREE.IcosahedronGeometry(2.3, 1).scale(1, 0.95, 1).translate(0, 2.15, 0);
  }
  _foliageGeoCache[shape] = g;
  return g;
}

// How much taller/shorter the (shared) trunk stretches per shape, so acacias get a
// long bare trunk under their umbrella while the rest keep stocky trunks.
const TRUNK_HMUL = { round: 1.0, pine: 0.9, acacia: 1.85, blossom: 0.95, palm: 1.7 };

// Biome-diverse trees. One shared brown trunk InstancedMesh for the whole batch,
// plus ONE foliage InstancedMesh per distinct canopy shape present (round / pine /
// acacia / blossom) — each shape its own silhouette, recoloured per-instance from
// the biome's foliage HSL. Draw calls stay tiny: 1 trunk + ≤4 canopy meshes.
function buildShapedTrees(scene, spots, scaleMul = 1) {
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 3, 6); // baked base at y=0..3
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  foliageMat.userData.backlight = true; // glow when backlit by the sun (set in toonify)
  // Canopies bow in the shared wind field, pivoting on the trunk top. The
  // number is the crown's lean as a fraction of its own height; 0.12 reads
  // clearly from a kart at speed (0.085 was there first and all but vanished
  // in motion) while staying a breeze rather than a gale.
  foliageMat.userData.sway = 0.12;

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();

  // Bucket spots by canopy shape so each shape fills one InstancedMesh.
  const byShape = new Map();
  for (const spot of spots) {
    const shape = spot.b.treeShape || "round";
    let arr = byShape.get(shape);
    if (!arr) byShape.set(shape, (arr = []));
    arr.push(spot);
  }

  // Precompute each spot's trunk-top so trunk + canopy line up.
  spots.forEach((spot, i) => {
    const { y, b } = spot;
    const shape = b.treeShape || "round";
    const sc = (0.8 + rand() * 1.4) * scaleMul;
    const hmul = TRUNK_HMUL[shape] ?? 1.0;
    spot._sc = sc;
    spot._yaw = rand() * Math.PI;
    spot._top = y + 3 * sc * hmul; // world Y of the trunk top (canopy base)
    q.setFromAxisAngle(UP_Y, spot._yaw);
    p.set(spot.x, y + 1.5 * sc * hmul, spot.z);
    s.set(sc, sc * hmul, sc);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
  });
  trunks.instanceMatrix.needsUpdate = true;
  trunks.layers.set(1); // excluded from the rear-view mirror render
  scene.add(trunks);

  // One foliage mesh per shape. The canopy geometry is CLONED off the shared
  // cache here because the wind bend needs per-instance data (aWindRoot) on it,
  // and the cache hands the same geometry to every batch in the world.
  for (const [shape, arr] of byShape) {
    const geo = bakeBendWeights(foliageGeoFor(shape).clone());
    const windRoot = new Float32Array(arr.length * 3);
    geo.setAttribute("aWindRoot", new THREE.InstancedBufferAttribute(windRoot, 3));
    const foliage = new THREE.InstancedMesh(geo, foliageMat, arr.length);
    foliage.castShadow = true;
    foliage.layers.set(1);
    arr.forEach((spot, i) => {
      windRoot[i * 3] = spot.x; // where it stands: the gust wave is sampled here
      windRoot[i * 3 + 1] = spot.z;
      windRoot[i * 3 + 2] = spot.b.sy * spot._sc; // its height scale, so the lean is a fraction of ITS height
      const { b } = spot;
      const sc = spot._sc;
      q.setFromAxisAngle(UP_Y, spot._yaw);
      p.set(spot.x, spot._top - 0.2 * sc, spot.z); // tiny overlap into the trunk top
      // Per-biome width/height tweak still applies (sx/sy), keeping the old variety.
      s.set(b.sx * sc, b.sy * sc, b.sx * sc);
      m.compose(p, q, s);
      foliage.setMatrixAt(i, m);

      let h = b.foliage[0];
      if (b.name === "autumn") h += (rand() - 0.5) * 0.12; // mix red/orange/gold
      else if (b.name === "blossom") h += (rand() - 0.5) * 0.04; // a little pink variance
      col.setHSL(h, b.foliage[1], clamp(b.foliage[2] + (rand() - 0.5) * 0.1, 0.14, 0.86));
      if (b.name === "alpine") col.lerp(SNOW_WHITE, 0.45); // snow-dusted pines
      foliage.setColorAt(i, col);
    });
    foliage.instanceMatrix.needsUpdate = true;
    if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
    scene.add(foliage);
  }

  // Soft contact shadow under each tree — grounds them without the cost of a
  // real shadow pass (reads as the SSAO "occlusion" darkening at the base).
  buildBlobShadows(
    scene,
    spots.map((spot) => {
      const sc = 0.9 * scaleMul;
      const wide = spot.b.treeShape === "acacia" ? 1.5 : 1; // umbrellas shade a wider patch
      return { x: spot.x, y: spot.y, z: spot.z, r: (2.0 + spot.b.sx) * sc * wide };
    })
  );
}

// Warm radial texture for the lamps' ground light-pools and glow halos.
let _lampGlowTex = null;
function lampGlowTexture() {
  if (_lampGlowTex) return _lampGlowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,226,162,0.95)");
  g.addColorStop(0.45, "rgba(255,196,110,0.4)");
  g.addColorStop(1, "rgba(255,180,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _lampGlowTex = new THREE.CanvasTexture(c);
  _lampGlowTex.colorSpace = THREE.SRGBColorSpace;
  return _lampGlowTex;
}

// Lamp posts lining the road, on alternating sides. Posts, shades and bulbs are
// always present (street furniture); at NIGHT the bulbs glow (emissive + bloom),
// each lays a warm additive light-pool on the ground and a soft halo, so the
// night reads as lit rather than pitch black. Instanced for cheap draw calls.
function buildStreetLamps(scene, track, heightAt, lit, level = 1) {
  const up = new THREE.Vector3(0, 1, 0);
  const N = track.samples;
  const spacing = 78; // ~metres between lamps along the road
  const step = Math.max(2, Math.round((N * spacing) / track.length));
  const POST_H = 9;
  const spots = [];
  let side = 1;
  for (let i = 0; i < N; i += step) {
    const p = track._pts[i];
    const s = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const outward = s.x * p.x + s.z * p.z >= 0 ? 1 : -1;
    const dir = outward * side; // alternate sides for an avenue feel
    side *= -1;
    const off = track.halfWidth + 5;
    const x = p.x + s.x * dir * off;
    const z = p.z + s.z * dir * off;
    if (track.distanceToCenter(x, z) < track.halfWidth + 3) continue; // folded over road
    if (_inLake(x, z)) continue;
    if (featureSpanBlock(track.features, x, z)) continue; // decks/tunnel carry their own furniture
    if (p.y - heightAt(x, z) > 4) continue; // elevated ramp: a ground-planted lamp turns into a stilt
    spots.push({ x, z, y: heightAt(x, z), ax: -s.x * dir, az: -s.z * dir }); // arm aims at road
  }
  if (!spots.length) return;

  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.7, metalness: 0.3 });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff0c8, emissive: 0xffd98a, emissiveIntensity: lit ? 2.4 * level : 0.0, roughness: 0.4,
  });
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.4, POST_H, 7), postMat, spots.length);
  const heads = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.95, 0.55, 0.7, 8), postMat, spots.length);
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 10, 8), bulbMat, spots.length);
  posts.castShadow = true;
  heads.castShadow = true;
  const m = new THREE.Matrix4();
  const ID = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  spots.forEach((sp, i) => {
    pos.set(sp.x, sp.y + POST_H / 2, sp.z);
    posts.setMatrixAt(i, m.compose(pos, ID, sc));
    const hx = sp.x + sp.ax, hz = sp.z + sp.az; // head juts toward the road
    pos.set(hx, sp.y + POST_H + 0.1, hz);
    heads.setMatrixAt(i, m.compose(pos, ID, sc));
    pos.set(hx, sp.y + POST_H - 0.35, hz);
    bulbs.setMatrixAt(i, m.compose(pos, ID, sc));
  });
  for (const im of [posts, heads, bulbs]) {
    im.instanceMatrix.needsUpdate = true;
    im.layers.set(1); // out of the rear-view mirror render
    scene.add(im);
  }
  if (!lit) return;

  // Warm ground pools (additive). Each is a tessellated disc whose vertices are
  // dropped onto the road surface (via groundInfo) so the light hugs the ground /
  // its slope instead of floating as a flat disc, and its soft round texture means
  // no hard cut-off edge. All discs merge into a single mesh (one draw call).
  const tex = lampGlowTexture();
  const POOL_R = 15;
  const discGeos = [];
  for (const sp of spots) {
    const cx = sp.x + sp.ax;
    const cz = sp.z + sp.az;
    const g = new THREE.CircleGeometry(POOL_R, 22).rotateX(-Math.PI / 2);
    const pa = g.attributes.position;
    for (let v = 0; v < pa.count; v++) {
      const wx = cx + pa.getX(v);
      const wz = cz + pa.getZ(v);
      // Sit on whichever surface is on top here — the road mesh (groundInfo) over
      // the tarmac, the terrain (heightAt) where the verge rises — so the pool
      // hugs the ground everywhere instead of floating or sinking.
      const surfY = Math.max(track.groundInfo(wx, wz).y, heightAt(wx, wz));
      pa.setY(v, surfY + 0.06);
      pa.setX(v, wx);
      pa.setZ(v, wz);
    }
    pa.needsUpdate = true;
    discGeos.push(g);
  }
  const poolGeo = mergeGeometries(discGeos);
  const pools = new THREE.Mesh(
    poolGeo,
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.35 + 0.65 * level, // subtler at dusk
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
    })
  );
  pools.layers.set(1);
  pools.renderOrder = 1;
  scene.add(pools);

  // Soft halos around each bulb: ONE instanced billboard field (same pattern as
  // the effects sprites) instead of a THREE.Sprite per lamp — that was ~25
  // individual transparent draws every night frame.
  const haloPos = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
  spots.forEach((sp, i) => haloPos.setXYZ(i, sp.x + sp.ax, sp.y + POST_H - 0.35, sp.z + sp.az));
  const haloMat = new THREE.SpriteNodeMaterial({
    map: tex, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85 * level,
  });
  haloMat.color.set(0xffe6b0);
  haloMat.positionNode = attribute("aPos");
  haloMat.scaleNode = float(7);
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  haloGeo.setAttribute("aPos", haloPos);
  const halos = new THREE.InstancedMesh(haloGeo, haloMat, spots.length);
  halos.frustumCulled = false; // instances ring the whole lap
  halos.layers.set(1);
  scene.add(halos);
}

// Trackside rhythm posts: small red-capped marker bollards hugging BOTH verges
// at a steady ~16u beat all the way around the lap. Pure perceived-speed
// furniture — optic flow needs reference objects streaming past close to the
// eye, and a regular beat makes speed legible the way fence posts do from a
// motorway. Denser than the lamps (which are avenue dressing), much smaller,
// and cheap: two instanced meshes for the whole lap, no shadows, no lights.
function buildRhythmPosts(scene, track, heightAt) {
  const up = new THREE.Vector3(0, 1, 0);
  const N = track.samples;
  const spacing = 16; // ~metres between posts along the road
  const step = Math.max(1, Math.round((N * spacing) / track.length));
  const BODY_H = 1.5;
  const CAP_H = 0.34;
  const spots = [];
  for (let i = 0; i < N; i += step) {
    const p = track._pts[i];
    const s = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    for (const dir of [1, -1]) {
      const off = track.halfWidth + 2.6; // just outside the barrier line
      const x = p.x + s.x * dir * off;
      const z = p.z + s.z * dir * off;
      // Same guards as the street lamps: skip where the verge folds onto another
      // pass of the lap, into a lake, under a set piece's own furniture, or
      // where the road runs elevated (a ground post would become a stilt).
      if (track.distanceToCenter(x, z) < track.halfWidth + 1.8) continue;
      if (_inLake(x, z)) continue;
      if (featureSpanBlock(track.features, x, z)) continue;
      const gy = heightAt(x, z);
      if (p.y - gy > 4) continue;
      spots.push({ x, z, y: gy });
    }
  }
  if (!spots.length) return;

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.8 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xd83a2f, roughness: 0.6 });
  const bodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.13, 0.17, BODY_H, 6), bodyMat, spots.length);
  const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.14, CAP_H, 6), capMat, spots.length);
  const m = new THREE.Matrix4();
  const ID = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  spots.forEach((sp, i) => {
    pos.set(sp.x, sp.y + BODY_H / 2, sp.z);
    bodies.setMatrixAt(i, m.compose(pos, ID, sc));
    pos.set(sp.x, sp.y + BODY_H + CAP_H / 2 - 0.02, sp.z);
    caps.setMatrixAt(i, m.compose(pos, ID, sc));
  });
  for (const im of [bodies, caps]) {
    im.instanceMatrix.needsUpdate = true;
    im.layers.set(1); // out of the rear-view mirror render (same as the lamps)
    scene.add(im);
  }
}

// Festive bulb strings strung in a catenary over a few road spans. The bulbs are
// bright un-tonemapped colours, so bloom makes them twinkle/glow at night while
// still reading as little fairy lights by day. One instanced mesh for all bulbs.
// City traffic signals: a dark metal pole with a mast arm reaching over the
// road edge and a 3-lens head (red / amber / green) — always showing GREEN
// (this is a race, nobody stops). One every ~60u of city road, alternating
// sides. Static + shared materials, so batchStaticProps() merges the lot into
// a few draws; the green lens is emissive so it glows at dusk/night.
let _tlMats = null;
// One traffic signal (pole + mast arm + 3-lens head, green LIT — this is a
// race, nobody stops). Local +Z is the arm's reach toward the road. Also built
// standalone by the asset viewer.
function makeTrafficLight() {
  if (!_tlMats) {
    _tlMats = {
      pole: mat(0x3c4047, { roughness: 0.5, metalness: 0.45 }),
      head: mat(0x1f2327, { roughness: 0.6 }),
      red: mat(0x4a2a28, { roughness: 0.4 }), // unlit dark-red lens
      amber: mat(0x4a3d20, { roughness: 0.4 }), // unlit dark-amber lens
      green: mat(0x2ecc55, { roughness: 0.4, emissive: 0x2ecc55, emissiveIntensity: 1.9 }), // LIT
    };
  }
  const g = new THREE.Group();
  const armY = 7.8, armLen = 4.6;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, armY + 0.2, 8), _tlMats.pole);
  pole.position.y = (armY + 0.2) / 2;
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, armLen, 8), _tlMats.pole);
  arm.rotation.x = Math.PI / 2; // lie along local +Z (toward the road)
  arm.position.set(0, armY, armLen / 2);
  arm.castShadow = true;
  g.add(arm);
  // Signal head hanging near the arm's end: dark housing + three lenses that
  // poke out of BOTH faces (readable from either driving direction).
  const headZ = armLen - 0.5;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.5, 0.52), _tlMats.head);
  head.position.set(0, armY - 0.85, headZ);
  head.castShadow = true;
  g.add(head);
  const lensDefs = [[_tlMats.red, 0.46], [_tlMats.amber, 0], [_tlMats.green, -0.46]];
  for (const [m, dy] of lensDefs) {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), m);
    lens.position.set(0, armY - 0.85 + dy, headZ);
    g.add(lens);
  }
  return g;
}

function buildTrafficLights(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const spacing = track.length / N;
  const step = Math.max(1, Math.round(60 / spacing));
  // The mast arm reaches ~5u from the pole with the head at ~6-7u up: fine
  // over its own road, but a pole standing between two passes of the lap can
  // hang that head over the LOWER strand at kart-graze height.
  const otherStrandNear = (x, z, i) => {
    // Exclusion window ~2% of the lap: just past the legal-hairpin arc, so a
    // hairpin's far leg (or a crossing corridor's other strand) still counts
    // as foreign road even though it is close along the lap.
    const win = Math.ceil(N * 0.02);
    for (let k = 0; k < N; k += 2) {
      const ad = Math.abs(k - i);
      if (Math.min(ad, N - ad) <= win) continue;
      const q = track._pts[k];
      if ((q.x - x) ** 2 + (q.z - z) ** 2 < 26 * 26) return true;
    }
    return false;
  };
  let flip = 1;
  for (let i = 0; i < N; i += step) {
    const p = track._pts[i];
    if (biomeAt(p.x, p.z).name !== "city") continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    flip = -flip; // alternate sides down the boulevard
    const off = track.halfWidth + 2.2;
    const x = p.x + side.x * flip * off;
    const z = p.z + side.z * flip * off;
    if (track.distanceToCenter(x, z) < track.halfWidth + 2) continue;
    if (_inLake(x, z)) continue;
    // Elevated stretch (deck/ramp): the pole grounds on the terrain below and
    // its mast arm ends up hanging in the lower lane at kart height.
    if (p.y - heightAt(x, z) > 3) continue;
    if (otherStrandNear(x, z, i)) continue;

    const g = makeTrafficLight();
    // Never below the road it serves: on a climbing curve the verge beside
    // the boulevard can dip ~1.5u — planted there, the mast head ends up at
    // kart-graze height over the rising road ahead.
    g.position.set(x, Math.max(heightAt(x, z), p.y - 0.5), z);
    // Local +Z points from the pole back toward the road centre.
    g.rotation.y = Math.atan2(-side.x * flip, -side.z * flip);
    g.traverse((o) => o.layers.set(1));
    g.userData.staticProp = true; // merged by batchStaticProps()
    scene.add(g);
  }
}

// City road details: zebra CROSSWALKS at the signal spots (reads as an
// intersection) and scattered MANHOLE COVERS along the boulevard. Both are flat
// decals in two InstancedMeshes — 2 draws for the whole city.
function buildCityRoadDetails(scene, track, heightAt) {
  const N = track.samples;
  const spacing = track.length / N;

  // Zebra-stripe texture: white bars elongated ALONG the driving direction,
  // repeated across the road (transparent between bars, slightly worn).
  const cwTex = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "rgba(248,248,248,0.92)";
    const bars = 16;
    const bw = c.width / bars;
    for (let i = 0; i < bars; i += 2) ctx.fillRect(i * bw + 2, 3, bw - 4, c.height - 6);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  })();

  // Manhole texture: dark iron disc with a lighter rim and cross-hatch.
  const mhTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#2e3236";
    ctx.beginPath();
    ctx.arc(32, 32, 31, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4a5056";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) { // cross-hatch tread lines
      ctx.beginPath();
      ctx.moveTo(10, 32 + i * 8);
      ctx.lineTo(54, 32 + i * 8);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // Collect spots first, then bake each set into ONE InstancedMesh. Both decals
  // must lie IN the road's local tangent plane (pitch + camber), not flat in
  // world XZ — a horizontal plane on a sloped boulevard hovers off the surface
  // at one end and reads as a floating object instead of paint.
  const cwSpots = []; // { p, tan } — centred on the road, just past the signal
  const mhSpots = []; // { x, y, z, tan, yaw } — scattered on the tarmac
  const cwStep = Math.max(1, Math.round(60 / spacing)); // matches buildTrafficLights
  const cwShift = Math.max(1, Math.round(4 / spacing)); // stripes sit "before" the light
  for (let i = 0; i < N; i += cwStep) {
    if (biomeAt(track._pts[i].x, track._pts[i].z).name !== "city") continue;
    // Shift by SAMPLE index (not a raw tangent offset) so position, height and
    // slope are all re-sampled at the crosswalk's actual spot.
    const j = (i + cwShift) % N;
    cwSpots.push({ p: track._pts[j], tan: track._tans[j] });
  }
  const mhStep = Math.max(1, Math.round(23 / spacing));
  for (let i = 0; i < N; i += mhStep) {
    const p = track._pts[i];
    if (biomeAt(p.x, p.z).name !== "city") continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], UP_Y).normalize();
    const lat = (rand() * 2 - 1) * (track.halfWidth - 4); // on the tarmac, off the racing edge
    mhSpots.push({ x: p.x + side.x * lat, y: p.y, z: p.z + side.z * lat, tan: track._tans[i], yaw: rand() * Math.PI });
  }

  const dummy = new THREE.Object3D();
  const _side = new THREE.Vector3();
  const _norm = new THREE.Vector3();
  const _along = new THREE.Vector3();
  // Aligns `dummy` so the decal plane's X spans the road, Y runs along the
  // (sloped) tangent and Z is the road normal, then lifts it along that normal.
  const conform = (x, y, z, tan, lift, spin = 0) => {
    _along.copy(tan).normalize();
    _side.crossVectors(_along, UP_Y).normalize();
    _norm.crossVectors(_side, _along).normalize();
    dummy.matrix.makeBasis(_side, _along, _norm);
    if (spin) dummy.matrix.multiply(new THREE.Matrix4().makeRotationZ(spin));
    dummy.matrix.setPosition(x + _norm.x * lift, y + _norm.y * lift, z + _norm.z * lift);
  };
  if (cwSpots.length) {
    const geo = new THREE.PlaneGeometry(track.width * 0.86, 3.0);
    const mat_ = new THREE.MeshStandardMaterial({ map: cwTex, transparent: true, roughness: 0.9, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geo, mat_, cwSpots.length);
    cwSpots.forEach((s, k) => {
      conform(s.p.x, s.p.y, s.p.z, s.tan, 0.045);
      mesh.setMatrixAt(k, dummy.matrix);
    });
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // instances span the map; geometry bounds would cull wrongly
    scene.add(mesh);
  }
  if (mhSpots.length) {
    const geo = new THREE.CircleGeometry(0.55, 16);
    const mat_ = new THREE.MeshStandardMaterial({ map: mhTex, transparent: true, roughness: 0.85, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geo, mat_, mhSpots.length);
    mhSpots.forEach((s, k) => {
      conform(s.x, s.y, s.z, s.tan, 0.04, s.yaw);
      mesh.setMatrixAt(k, dummy.matrix);
    });
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
}

function buildStringLights(scene, track, level = 0, heightAt = null) {
  const up = new THREE.Vector3(0, 1, 0);
  const N = track.samples;
  const SPANS = 5;
  const COLS = [0xff3b30, 0xffd60a, 0x34c759, 0x0a84ff, 0xff9f0a, 0xffffff];
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2a2622, transparent: true, opacity: 0.7, fog: true });
  const bulbGeo = new THREE.SphereGeometry(0.34, 8, 8);
  const bulbMat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
  // Each string hangs between two wooden posts (one per end). Collected here as
  // [x, z, topY] and built into one instanced mesh after the spans are laid out.
  const postSpots = [];

  // Per-span data, kept so the strings can SWING (a damped spring) when karts pass
  // under them and so the bulbs/wire/point-light all follow that sway each frame.
  const spans = [];
  let totalBulbs = 0;
  for (let s = 0; s < SPANS; s++) {
    const i = Math.floor(((s + 0.5) / SPANS + rand() * 0.12) * N) % N;
    const p = track._pts[i];
    // Festive bulb strings don't belong downtown — city stretches get traffic
    // lights instead (buildTrafficLights).
    if (biomeAt(p.x, p.z).name === "city") continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const off = track.halfWidth + 4;
    // A span needs honest footings: skip spots where a post would land on
    // ANOTHER pass of the lap (loop necks put strands a post-width away) or
    // where this road is elevated — a ground-planted post under a deck
    // becomes a stilt rising through whatever runs below (the lower lane).
    {
      let ok = true;
      for (const sgn of [1, -1]) {
        const px = p.x + side.x * sgn * off, pz = p.z + side.z * sgn * off;
        if (track.distanceToCenter(px, pz) < track.halfWidth + 1.5) { ok = false; break; }
        if (heightAt && p.y - heightAt(px, pz) > 4) { ok = false; break; }
      }
      if (!ok) continue;
    }
    const A = new THREE.Vector3(p.x + side.x * off, p.y + 8.5, p.z + side.z * off);
    const B = new THREE.Vector3(p.x - side.x * off, p.y + 8.5, p.z - side.z * off);
    postSpots.push([A.x, A.z, A.y], [B.x, B.z, B.y]);
    const per = 12, sag = 3.0;
    const fwd = new THREE.Vector3(track._tans[i].x, 0, track._tans[i].z).normalize(); // sway axis
    const base = [];
    const cols = [];
    for (let k = 0; k <= per; k++) {
      const t = k / per;
      const dip = Math.sin(t * Math.PI) * sag; // catenary-ish droop
      base.push(new THREE.Vector3(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t - dip, A.z + (B.z - A.z) * t));
      if (k > 0 && k < per) cols.push(COLS[(k + s) % COLS.length]);
    }
    spans.push({
      per, base, fwd, cols,
      mid: new THREE.Vector3(p.x, p.y, p.z), // the road crossing point (for "kart under" test)
      bulbStart: totalBulbs, bulbCount: per - 1,
      swing: { x: 0, z: 0, vx: 0, vz: 0 }, phase: rand() * 6.28,
      wire: null, wireGeo: null, light: null,
    });
    totalBulbs += per - 1;
  }
  if (!totalBulbs) return { update() {} };

  // Bulbs (instanced) — bright/unlit so they bloom.
  const mesh = new THREE.InstancedMesh(bulbGeo, bulbMat, totalBulbs);
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  const glow = 0.9 + level * 0.7;
  const _c = new THREE.Color();
  for (const sd of spans) {
    for (let b = 0; b < sd.bulbCount; b++) mesh.setColorAt(sd.bulbStart + b, _c.set(sd.cols[b]).multiplyScalar(glow));
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);

  // Wooden support posts at each string end (the strings used to float unsupported).
  // One instanced mesh of tapered poles, each scaled from the ground up to its wire
  // anchor. Static — the wire endpoints don't swing, so the posts stay aligned.
  if (postSpots.length) {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3829, roughness: 0.92 });
    const postGeo = new THREE.CylinderGeometry(0.15, 0.22, 1, 8); // unit height; Y-scaled per post
    const posts = new THREE.InstancedMesh(postGeo, postMat, postSpots.length);
    posts.frustumCulled = false;
    const pm = new THREE.Matrix4(), pq = new THREE.Quaternion(), psc = new THREE.Vector3(), pv = new THREE.Vector3();
    for (let i = 0; i < postSpots.length; i++) {
      const [x, z, topY] = postSpots[i];
      const gy = heightAt ? heightAt(x, z) : topY - 8.5; // stand on the real ground
      const h = Math.max(2, topY - gy + 0.3); // up to just above the wire join
      pm.compose(pv.set(x, gy + h / 2, z), pq, psc.set(1, h, 1));
      posts.setMatrixAt(i, pm);
    }
    posts.instanceMatrix.needsUpdate = true;
    scene.add(posts);
  }

  // Wires + (at dusk/night) a real warm point light per span so the strings
  // actually illuminate the road beneath them.
  spans.forEach((sd, si) => {
    const geo = new THREE.BufferGeometry().setFromPoints(sd.base.map((v) => v.clone()));
    const wire = new THREE.Line(geo, wireMat);
    wire.layers.set(1);
    wire.frustumCulled = false;
    scene.add(wire);
    sd.wire = wire; sd.wireGeo = geo;
    // Only every other span casts a REAL light (the rest still glow via emissive
    // bulbs + bloom). Every dynamic light is per-pixel cost at night, and the pools
    // overlap anyway, so halving them is ~invisible but meaningfully cheaper.
    if (level > 0.01 && si % 2 === 0) {
      const lp = sd.base[Math.floor(sd.per / 2)];
      const pl = new THREE.PointLight(0xfff0c8, 13 * level, 32, 1.7); // a touch brighter to cover the gaps
      pl.position.copy(lp);
      pl.castShadow = false;
      scene.add(pl);
      sd.light = pl;
    }
  });

  const _m = new THREE.Matrix4();
  const _id = new THREE.Quaternion();
  const _sc = new THREE.Vector3(1, 1, 1);
  const _v = new THREE.Vector3();
  const K = 17, D = 2.5; // spring stiffness + damping for the swing
  // Drive each span's swing from the karts and rebuild bulb/wire/light positions.
  // karts: array of { x, z, dx, dz, speed } (dx,dz = horizontal heading).
  function update(dt, karts) {
    let wrote = false;
    for (const sd of spans) {
      const sw = sd.swing;
      // Distance gate: a span nobody is near doesn't rebuild its wire verts +
      // bulb matrices this frame — the sway is invisible from 200u+ and the pose
      // freezes harmlessly. A span still swinging from a recent pass keeps
      // animating (wherever the karts went) until the spring settles.
      let near = false;
      if (karts) {
        for (const k of karts) {
          if (!k) continue;
          const dx = k.x - sd.mid.x, dz = k.z - sd.mid.z;
          if (dx * dx + dz * dz < 200 * 200) { near = true; break; }
        }
      }
      if (!near && Math.abs(sw.x) + Math.abs(sw.z) + Math.abs(sw.vx) + Math.abs(sw.vz) < 0.02) continue;
      wrote = true;
      if (karts) {
        for (const k of karts) {
          if (!k) continue;
          const dx = k.x - sd.mid.x, dz = k.z - sd.mid.z;
          if (dx * dx + dz * dz < 64 && k.speed > 3) { // within ~8 units, moving
            sw.vx += (k.dx || 0) * k.speed * 0.012; // shove in the kart's travel dir
            sw.vz += (k.dz || 0) * k.speed * 0.012;
          }
        }
      }
      // Damped harmonic spring back to rest.
      sw.vx += (-K * sw.x - D * sw.vx) * dt;
      sw.vz += (-K * sw.z - D * sw.vz) * dt;
      sw.x += sw.vx * dt;
      sw.z += sw.vz * dt;
      const mag = Math.hypot(sw.x, sw.z);
      if (mag > 2.0) { sw.x *= 2.0 / mag; sw.z *= 2.0 / mag; } // cap the swing
      // Gentle idle breeze on top so they're never dead-still.
      const idle = Math.sin(performance.now() * 0.0011 + sd.phase) * 0.12;
      const ox = sw.x + sd.fwd.x * idle, oz = sw.z + sd.fwd.z * idle;
      // Apply the offset weighted by the catenary droop (max at the centre).
      const posAttr = sd.wireGeo.attributes.position;
      for (let kk = 0; kk <= sd.per; kk++) {
        const w = Math.sin((kk / sd.per) * Math.PI);
        const bp = sd.base[kk];
        posAttr.setXYZ(kk, bp.x + ox * w, bp.y, bp.z + oz * w);
      }
      posAttr.needsUpdate = true;
      for (let b = 0; b < sd.bulbCount; b++) {
        const kk = b + 1;
        const w = Math.sin((kk / sd.per) * Math.PI);
        const bp = sd.base[kk];
        _m.compose(_v.set(bp.x + ox * w, bp.y - 0.25, bp.z + oz * w), _id, _sc);
        mesh.setMatrixAt(sd.bulbStart + b, _m);
      }
      if (sd.light) {
        const lp = sd.base[Math.floor(sd.per / 2)];
        sd.light.position.set(lp.x + ox, lp.y, lp.z + oz);
      }
    }
    if (wrote) mesh.instanceMatrix.needsUpdate = true;
  }

  return { update };
}

// Street-banner cloth colours: simple solid bands (no printing) — the only
// lettered banner on the map is the start gate's "ZOOMIES GP".
const BANNER_COLS = [0xd23b34, 0x2f6fb0, 0x3a9d4e, 0xe0a73a];

// One street banner: two ground poles, a top + bottom bar holding a taut SKINNY
// plain band between them (with a gentle billow), spanning across the road.
function addStreetBanner(scene, track, heightAt, p, sx, sz, yaw, poleMat, barMat, texIndex) {
  const off = track.halfWidth + 3;
  const topY = p.y + 8.9, botY = p.y + 7.7;        // a slim band, well clear of the karts below
  const bannerW = off * 2 - 1.4, bannerH = topY - botY;
  const midY = (topY + botY) / 2;
  // Poles (grounded on the real terrain, each side), with a small cap.
  for (const dir of [1, -1]) {
    const px = p.x + sx * dir * off, pz = p.z + sz * dir * off;
    const gy = heightAt ? heightAt(px, pz) : p.y;
    const poleTop = topY + 0.9;
    const h = Math.max(3, poleTop - gy);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, h, 10), poleMat);
    pole.position.set(px, gy + h / 2, pz);
    pole.castShadow = true; pole.layers.set(1);
    scene.add(pole);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), barMat);
    cap.position.set(px, poleTop, pz); cap.layers.set(1);
    scene.add(cap);
  }
  // Top + bottom bars the banner laces onto (so it reads taut, not floating).
  for (const by of [topY, botY]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, off * 2, 8), barMat);
    bar.rotation.z = Math.PI / 2;        // lie horizontal (along local X)...
    bar.rotation.y = 0;
    const bargrp = new THREE.Group();
    bargrp.add(bar);
    bargrp.position.set(p.x, by, p.z);
    bargrp.rotation.y = yaw;             // ...then yaw to lie across the road
    bargrp.layers.set(1);
    bar.layers.set(1);
    scene.add(bargrp);
  }
  // The taut band: a segmented plane with a gentle billow baked in. Plain solid
  // cloth — no printing — so it reads as simple trackside dressing.
  const geo = new THREE.PlaneGeometry(bannerW, bannerH, 24, 1);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    pos.setZ(v, Math.sin((x / bannerW) * Math.PI * 3) * 0.22); // bow in/out across the width
  }
  geo.computeVertexNormals();
  const banner = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: BANNER_COLS[texIndex % BANNER_COLS.length], roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  );
  banner.position.set(p.x, midY, p.z);
  banner.rotation.y = yaw + Math.PI;
  banner.castShadow = true;
  banner.layers.set(1);
  scene.add(banner);
}

// Overhead structures you drive UNDER: printed street banners on poles, and a
// chunky bridge/overpass spanning the road. Seeded placement across the track.
function buildOverheadStructures(scene, track, heightAt, lit, level = 1) {
  const N = track.samples;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 });
  // Street-banner poles read as painted metal posts (darker, a touch of sheen).
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3c4047, roughness: 0.5, metalness: 0.45 });
  const barMat = new THREE.MeshStandardMaterial({ color: 0x2d3036, roughness: 0.45, metalness: 0.55 });

  const spanAt = (frac) => {
    const i = Math.floor((frac % 1) * N) % N;
    const p = track._pts[i];
    const t = track._tans[i];
    const tl = Math.hypot(t.x, t.z) || 1;
    return { p, sx: -t.z / tl, sz: t.x / tl, yaw: Math.atan2(t.x / tl, t.z / tl) };
  };

  // A road-spanning structure needs the ground BESIDE its own road to be free
  // of every other pass of the lap. Self-crossing maps run strands as close as
  // ~34u apart at loop necks — a banner or footbridge planted there hangs its
  // cloth/deck straight across the neighbouring tarmac at kart height (and its
  // poles stand in that road). Walk the span line and reject any spot whose
  // samples beyond our own corridor land on another strand.
  const spanClear = (p, sx, sz, reach) => {
    for (let s = -reach; s <= reach; s += 5) {
      if (Math.abs(s) <= track.halfWidth + 1) continue; // our own corridor
      if (track.distanceToCenter(p.x + sx * s, p.z + sz * s) < track.halfWidth - 1) return false;
    }
    return true;
  };
  const bannerBlocked = (sp) =>
    featureSpanBlock(track.features, sp.p.x, sp.p.z) || !spanClear(sp.p, sp.sx, sp.sz, track.halfWidth + 19);

  // --- Printed street banners (2) ---
  // Nudged along the lap if their spot lands inside a set piece that carries
  // its own overhead structure (a banner inside the tunnel clips the tube).
  [0.2 + rand() * 0.1, 0.66 + rand() * 0.1].forEach((frac, bi) => {
    let sp = spanAt(frac);
    for (let n = 0; n < 6 && bannerBlocked(sp); n++) sp = spanAt(frac + 0.04 * (n + 1));
    if (bannerBlocked(sp)) return;
    const { p, sx, sz, yaw } = sp;
    addStreetBanner(scene, track, heightAt, p, sx, sz, yaw, poleMat, barMat, bi + ((rand() * BANNER_COLS.length) | 0));
  });

  // --- Wooden walking footbridges spanning the road ---
  // Placed where they won't fight the scenery: pick the flattest candidate spans
  // whose landings clear the lakes and avoid the dense town building-rows, so a
  // bridge never plants a post in the water or inside a village. The whole
  // timber structure of each bridge merges into ONE geometry (1 draw call).
  for (const frac of pickFootbridgeSpans(track, heightAt, 2)) {
    buildFootbridge(scene, track, heightAt, frac, postMat, lit, level);
  }
}

// Town zones alternate with farm/open zones every 1/6 of the lap (see
// buildRoadside): even sixths are packed towns. A bridge wants the open ones.
function inTownZone(frac) {
  const f = ((frac % 1) + 1) % 1;
  return Math.floor(f * 6) % 2 === 0;
}

// Score candidate spans and return the best `count` fracs, spread apart, whose
// landings are clear of water and (preferably) clear of town building-rows.
function pickFootbridgeSpans(track, heightAt, count) {
  const N = track.samples;
  const RAMP = 15; // how far past the barrier the landings reach
  const TRIES = 28;
  const cands = [];
  for (let s = 0; s < TRIES; s++) {
    const frac = (s + 0.5) / TRIES;
    const i = Math.floor(frac * N) % N;
    const p = track._pts[i];
    const t = track._tans[i];
    const tl = Math.hypot(t.x, t.z) || 1;
    const sx = -t.z / tl, sz = t.x / tl; // unit vector across the road
    const reach = track.halfWidth + RAMP;
    const lx = p.x + sx * reach, lz = p.z + sz * reach; // left landing
    const rx = p.x - sx * reach, rz = p.z - sz * reach; // right landing
    if (_inLake(lx, lz) || _inLake(rx, rz)) continue; // a post would stand in the lake
    if (featureSpanBlock(track.features, p.x, p.z)) continue; // tunnel/deck runs span themselves
    // Another pass of the lap inside the span's reach (a loop neck) would put
    // the bridge deck and its landing ramp straight across that road.
    let clearSpan = true;
    for (let s = -(reach + 8); s <= reach + 8 && clearSpan; s += 5) {
      if (Math.abs(s) <= track.halfWidth + 1) continue;
      if (track.distanceToCenter(p.x + sx * s, p.z + sz * s) < track.halfWidth - 1) clearSpan = false;
    }
    if (!clearSpan) continue;
    // Avoid a sharp corner — the straight deck would cut the barrier on a tight bend.
    const t1 = track._tans[(i + 6) % N];
    const turn = Math.abs(Math.atan2(t1.x, t1.z) - Math.atan2(t.x, t.z));
    if (Math.min(turn, Math.PI * 2 - turn) > 0.32) continue;
    // Prefer level landings (a big bank-height gap makes the bridge lurch).
    const lY = heightAt(lx, lz), rY = heightAt(rx, rz);
    let score = -Math.abs(lY - rY) - Math.abs((lY + rY) / 2 - p.y) * 0.5;
    if (inTownZone(frac)) score -= 40; // keep clear of the packed village rows
    cands.push({ frac, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= count) break;
    if (chosen.every((f) => Math.abs(((c.frac - f + 1) % 1)) > 0.12 && Math.abs(((f - c.frac + 1) % 1)) > 0.12)) {
      chosen.push(c.frac);
    }
  }
  return chosen;
}

// One arched plank footbridge: the walkway rises from the ground on one verge,
// arcs over the road (high enough to drive under) and descends to the far verge,
// with timber posts at the road edges, plank rails and balusters. Everything is
// built in the span's local frame (X across, Z along the road, Y up; local Y=0 is
// road height) and merged into a single mesh — 1 draw call for the whole bridge.
function buildFootbridge(scene, track, heightAt, frac, woodMat, lit, level) {
  const N = track.samples;
  const i = Math.floor((frac % 1) * N) % N;
  const p = track._pts[i];
  const t = track._tans[i];
  const tl = Math.hypot(t.x, t.z) || 1;
  const sx = -t.z / tl, sz = t.x / tl; // across the road (unit)
  const yaw = Math.atan2(t.x / tl, t.z / tl);
  const halfW = track.halfWidth;
  const RAMP = 15;
  const L = halfW + RAMP; // half-span: ends out on the verges
  const deckW = 4.2; // walkway width (along the road)
  const CLEAR = 8.5; // deck crown height above the road (drive-under clearance)

  // World terrain → local-Y helper (local Y = worldY - p.y, valid because the
  // bridge only rotates about Y, which preserves world height). The mesh's local
  // +X maps to -(sx,sz) in world space once rotated by yaw, so sample along -sx/-sz
  // to keep each deck end seated on the terrain actually beneath it.
  const worldAt = (u) => heightAt(p.x - sx * u * L, p.z - sz * u * L);
  const endL = worldAt(-1) - p.y, endR = worldAt(1) - p.y;
  const midBase = (endL + endR) / 2;
  // Deck height across the span: terrain at the ends, arcing to CLEAR over the road.
  const deckY = (u) => endL + (endR - endL) * (u + 1) / 2 + (CLEAR - midBase) * (1 - u * u);

  const parts = [];
  const box = (w, h, d, x, y, z, rotZ = 0) => {
    const g = rbox(Math.max(0.05, w), Math.max(0.05, h), Math.max(0.05, d), 0.08, 1);
    if (rotZ) g.rotateZ(rotZ); // tilt about the road axis (local Z) to follow the deck slope
    g.translate(x, y, z);
    parts.push(g);
  };

  // Deck: a run of planks following the arch. Each plank tilts to match the local
  // slope so the walkway reads as a smooth ramp-arch, not a staircase.
  const SEG = 30;
  const plankLen = (2 * L) / SEG + 0.12; // slight overlap, no gaps
  for (let k = 0; k < SEG; k++) {
    const u = -1 + (k + 0.5) * (2 / SEG);
    const x = u * L;
    const y = deckY(u);
    const slope = Math.atan2(deckY(u + 1 / SEG) - deckY(u - 1 / SEG), (2 / SEG) * L);
    box(plankLen, 0.32, deckW, x, y, 0, slope);
    // Side rails (top + mid) and a baluster, on both edges, every couple of planks.
    if (k % 2 === 0) {
      for (const dz of [-deckW / 2, deckW / 2]) {
        box(0.22, 0.95, 0.22, x, y + 0.6, dz);          // baluster
        box(plankLen + 0.2, 0.16, 0.18, x, y + 1.15, dz, slope); // top rail
        box(plankLen + 0.2, 0.12, 0.14, x, y + 0.62, dz, slope); // mid rail
      }
    }
  }

  // Support posts dropping to the ground just outside each barrier (never on the
  // road), plus stout end posts at the landings.
  for (const u of [-1, -(halfW + 1.5) / L, (halfW + 1.5) / L, 1]) {
    const x = u * L;
    const top = deckY(u);
    const ground = worldAt(u) - p.y;
    const h = Math.max(1.2, top - ground);
    for (const dz of [-deckW / 2 + 0.2, deckW / 2 - 0.2]) {
      box(0.5, h, 0.5, x, ground + h / 2, dz);
    }
  }

  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, woodMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = yaw;
  mesh.layers.set(1);
  scene.add(mesh);

  // A warm lantern hung under the crown at dusk/night.
  if (lit) {
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff0c8, emissive: 0xffd98a, emissiveIntensity: 2.4 * level })
    );
    lamp.position.set(p.x, p.y + CLEAR - 0.8, p.z);
    lamp.layers.set(1);
    scene.add(lamp);
  }
}

// Flat, soft, dark discs laid on the ground under objects — a cheap contact /
// ambient-occlusion shadow. One shared soft-edged texture, all instanced.
let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.6, "rgba(0,0,0,0.32)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

function buildBlobShadows(scene, discs) {
  if (!discs.length) return;
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // lie flat
  const mat = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.5,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, discs.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  discs.forEach((d, i) => {
    p.set(d.x, d.y + 0.06, d.z); // just above the ground to avoid z-fighting
    s.set(d.r * 2, 1, d.r * 2);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 1; // draw over the ground, under the trees
  mesh.layers.set(1); // match the trees: excluded from the mirror render
  scene.add(mesh);
}

// Desert cacti: a saguaro built once and instanced.
function buildCacti(scene, spots) {
  const geo = cactusGeometry();
  const mat = new THREE.MeshStandardMaterial({ color: 0x4f8a4a, roughness: 1, flatShading: true });
  const cacti = new THREE.InstancedMesh(geo, mat, spots.length);
  cacti.castShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  spots.forEach((spot, i) => {
    const sc = 0.9 + rand() * 0.9;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    p.set(spot.x, spot.y, spot.z);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    cacti.setMatrixAt(i, m);
    cacti.setColorAt(i, col.setHSL(0.28, 0.4, 0.34 + rand() * 0.12));
  });
  cacti.instanceMatrix.needsUpdate = true;
  if (cacti.instanceColor) cacti.instanceColor.needsUpdate = true;
  cacti.layers.set(1);
  scene.add(cacti);

  buildBlobShadows(
    scene,
    spots.map((spot) => ({ x: spot.x, y: spot.y, z: spot.z, r: 1.6 }))
  );
}

function cactusGeometry() {
  const parts = [
    new THREE.CylinderGeometry(0.5, 0.62, 4, 8).translate(0, 2, 0),
    new THREE.CylinderGeometry(0.28, 0.3, 1.4, 6).rotateZ(Math.PI / 2).translate(-0.9, 2.4, 0),
    new THREE.CylinderGeometry(0.28, 0.3, 1.3, 6).translate(-1.5, 3.0, 0),
    new THREE.CylinderGeometry(0.26, 0.28, 1.2, 6).rotateZ(Math.PI / 2).translate(0.8, 1.8, 0),
    new THREE.CylinderGeometry(0.26, 0.28, 1.1, 6).translate(1.3, 2.3, 0),
  ];
  return mergeGeometries(parts);
}

// Dense woods crowding right up to the road through forest/alpine sectors, so
// those stretches feel like driving through an actual forest (the general
// scatter only fills the open distance). Walks the track and packs pines into a
// band just off the tarmac.
function buildForests(scene, track, heightAt) {
  const N = track.samples;
  const halfW = track.halfWidth;
  const up = new THREE.Vector3(0, 1, 0);
  const spots = [];
  const giants = []; // the giant-forest set piece: fewer, MUCH bigger trees
  for (let i = 0; i < N; i += 2) {
    const p = track._pts[i];
    const here = biomeAt(p.x, p.z);
    if (here.style !== "pine") continue; // forest + alpine + jungle get dense woods
    const reps = here.name === "forest" || here.name === "jungle" ? 6 : 3;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    for (let r = 0; r < reps; r++) {
      const dir = rand() < 0.5 ? 1 : -1;
      const dist = halfW + 8 + rand() * 112;
      const x = p.x + side.x * dir * dist + (rand() - 0.5) * 9;
      const z = p.z + side.z * dir * dist + (rand() - 0.5) * 9;
      // Guard on the tree CENTRE, with headroom for the canopy (up to ~5.6 radius)
      // so a pine's foliage never leans out over the tarmac/barrier.
      if (track.distanceToCenter(x, z) < halfW + 7) continue;
      if (_inLake(x, z)) continue;
      if (featureTreeBlock(track.features, x, z)) continue; // bare canyon walls
      const b = biomeAt(x, z);
      if (b.style !== "pine") continue;
      // Inside the giant-forest run the woods swap for towering specimens:
      // thinner on the ground (giants need room) and pushed a bit further off
      // the verge so their huge canopies still clear the road.
      const boost = giantTreeBoost(track.features, x, z);
      if (boost > 0.35) {
        if (rand() < 0.6) continue; // sparser
        if (track.distanceToCenter(x, z) < halfW + 17) continue; // canopy headroom
        giants.push({ x, z, y: heightAt(x, z), b });
        continue;
      }
      spots.push({ x, z, y: heightAt(x, z), b });
    }
  }
  if (spots.length) buildShapedTrees(scene, spots, 1.45); // taller, fuller forest trees
  if (giants.length) buildShapedTrees(scene, giants, 3.2); // the giant-forest run
}

function buildRocks(scene, track, heightAt, flatten) {
  const spots = scatter(140, track, flatten, 0.4, 1700).filter((s) => !_inLake(s.x, s.z));
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 1 });
  const rocks = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  spots.forEach((spot, i) => {
    const y = heightAt(spot.x, spot.z);
    const sc = 1 + rand() * 3;
    q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
    p.set(spot.x, y + sc * 0.4, spot.z);
    s.set(sc, sc * 0.8, sc);
    m.compose(p, q, s);
    rocks.setMatrixAt(i, m);
  });
  rocks.instanceMatrix.needsUpdate = true;
  rocks.layers.set(1); // excluded from the rear-view mirror render
  scene.add(rocks);
}

function buildTown(scene, track, heightAt) {
  const palette = [0xd9776a, 0xe0b15a, 0x7aa6c2, 0x9ccc8f, 0xc9bfa8, 0xb98ec2];
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a3b34, roughness: 1 });
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xfff2b0,
    emissive: 0xffd95e,
    emissiveIntensity: 0.5,
  });

  // A cluster (town) plus a few scattered outbuildings.
  const placements = [];
  const townCenter = { x: 320, z: 330 };
  for (let i = 0; i < 26; i++) {
    placements.push({
      x: townCenter.x + (rand() - 0.5) * 240,
      z: townCenter.z + (rand() - 0.5) * 240,
    });
  }
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2;
    const r = 300 + rand() * 260;
    placements.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }

  for (const pl of placements) {
    if (track.distanceToCenter(pl.x, pl.z) < track.halfWidth + 30) continue;
    const y = heightAt(pl.x, pl.z);
    const w = 8 + rand() * 10;
    const d = 8 + rand() * 10;
    const floors = 1 + Math.floor(rand() * 4);
    const h = floors * 5;
    const mat = new THREE.MeshStandardMaterial({
      color: palette[Math.floor(rand() * palette.length)],
      roughness: 0.9,
    });
    const b = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    b.add(body);

    // Pitched roof.
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 4, 4), roofMat);
    roof.position.y = h + 2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    b.add(roof);

    // Window strips (emissive) on the front and back.
    for (let f = 0; f < floors; f++) {
      for (const sz of [d / 2 + 0.05, -d / 2 - 0.05]) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, 1.6), winMat);
        win.position.set(0, 3 + f * 5, sz);
        if (sz < 0) win.rotation.y = Math.PI;
        b.add(win);
      }
    }

    b.position.set(pl.x, y, pl.z);
    b.rotation.y = rand() * Math.PI;
    scene.add(b);
  }
}

// ---- Roadside town & farm zones ----
// Walk along the track and line the roadside. Town zones are packed (a front
// row of buildings, a taller back row, and street props), farm zones are open,
// so you plunge into a busy village and come out into open country.
function buildRoadside(scene, track, heightAt) {
  const N = track.samples;
  const pts = track._pts;
  const tans = track._tans;
  const halfW = track.halfWidth;
  const up = new THREE.Vector3(0, 1, 0);
  const spacing = track.length / N;
  const step = Math.max(1, Math.round(9 / spacing));
  const zones = 6;

  const place = (builder, dist, dir, p, side, faceRoad) => {
    const x = p.x + side.x * dir * dist;
    const z = p.z + side.z * dir * dist;
    if (track.distanceToCenter(x, z) < halfW + 4) return;
    if (_inLake(x, z)) return;
    if (featureKeepClear(track.features, x, z)) return; // set pieces keep their corridor clear
    // Sample the footprint, not just the centre: on a slope the prop sits at
    // the LOW corner (sunk in, never hovering), and genuinely steep ground —
    // canyon walls, river banks, cliff edges — gets no structure at all
    // (that's what left houses floating off ledges).
    const y0 = heightAt(x, z);
    const y1 = heightAt(x + 4, z), y2 = heightAt(x - 4, z);
    const y3 = heightAt(x, z + 4), y4 = heightAt(x, z - 4);
    const lo = Math.min(y0, y1, y2, y3, y4);
    const hi = Math.max(y0, y1, y2, y3, y4);
    if (hi - lo > 4.2) return; // too steep to build on
    const prop = builder(biomeAt(x, z)); // biome-aware builders use it; others ignore
    prop.position.set(x, lo + 0.04, z);
    prop.rotation.y = faceRoad
      ? Math.atan2(-side.x * dir, -side.z * dir) + (rand() - 0.5) * 0.4
      : rand() * Math.PI * 2;
    prop.traverse((o) => o.layers.set(1)); // keep out of the mirror render
    scene.add(prop);
    // Anything that never moves is merged by batchStaticProps() after placement
    // (a bench/fence/bush is 2-6 meshes each — hundreds of draw calls that all
    // collapse into a few per area). Animated props (wandering animals, spinning
    // windmill sails) keep their own meshes.
    if (!prop.userData.wander && !prop.userData.animated) prop.userData.staticProp = true;
    // Animals amble around their spawn (capped so the per-frame cost stays low).
    if (prop.userData.wander && _critters.length < 48) {
      _critters.push({
        obj: prop,
        base: prop.position.clone(),
        ry: prop.rotation.y,
        range: prop.userData.wander.range,
        speed: prop.userData.wander.speed,
        bob: prop.userData.wander.bob,
        phase: rand() * 6.28,
        t: rand() * 3,
        tx: prop.position.x,
        tz: prop.position.z,
      });
    }
  };

  for (let i = 0; i < N; i += step) {
    const t = i / N;
    const zf = t * zones;
    const town = Math.floor(zf) % 2 === 0;
    const phase = zf - Math.floor(zf); // 0..1 within the zone
    const density = 0.5 + 0.5 * Math.sin(phase * Math.PI); // denser mid-zone
    const p = pts[i];
    const side = new THREE.Vector3().crossVectors(tans[i], up).normalize();

    // Decide "is this a CITY stretch" from the ROAD point, not each offset
    // placement — biomeAt flips to the neighbour right at a wedge seam, which is
    // what let a rural house appear at the city's edge. Keyed off the road point,
    // a whole city stretch stays consistently urban.
    const roadCity = biomeAt(p.x, p.z).name === "city";
    // City buildings: mostly towers with some low storefronts for ground-level life.
    const cityFront = () => (rand() < 0.4 ? makeCityStore() : makeTower(density));
    const cityRow = () => (rand() < 0.22 ? makeCityStore() : makeTower(density));
    for (const dir of [1, -1]) {
      if (town) {
        // Front structures by the road. City stretches get towers + storefronts;
        // every other biome gets the small-town building. Placed at halfW+9.. (not
        // +5): a town building's overhanging pyramid roof reaches ~6.65 back toward
        // the road, so the old +5 let roof corners hang over the tarmac. +9 clears it.
        if (rand() < 0.62 + density * 0.32)
          place((b) => (roadCity ? cityFront() : makeTownStructure(density, b)), halfW + 9 + rand() * 3, dir, p, side, true);
        // Several rows stacking back from the road, thinning with depth so the town
        // (or skyline) recedes into the distance instead of being a thin strip.
        const rows = [13, 24, 36, 50, 66];
        for (let r = 0; r < rows.length; r++) {
          if (rand() < (0.52 + density * 0.4) * (1 - r * 0.15))
            place((b) => (roadCity ? cityRow() : makeBuilding(density, b)), halfW + rows[r] + rand() * 7, dir, p, side, true);
        }
        if (rand() < 0.5)
          place(makeStreetProp, halfW + 3.2 + rand() * 1.4, dir, p, side, true);
      } else if (rand() < 0.4) {
        place(makeFarmProp, halfW + 6 + rand() * 18, dir, p, side, false);
      }
    }
  }
}

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, ...opts });
}

// Shared emissive "windows" texture so each building is just 2 meshes but still
// looks like a lit facade.
let _windowTex = null;
function windowTexture() {
  if (_windowTex) return _windowTex;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 80;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 64, 80);
  const cols = 3; // few, larger windows -> cosy small-town look
  const rows = 4;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const lit = rand();
      // Gentler contrast than before (lit windows were up to 255 on near-black):
      // a softer warm glow on a dim panel reads as clean cel facades instead of a
      // harsh grid that shimmers into noise when the frame minifies at distance.
      const v = lit < 0.5 ? Math.floor(120 + rand() * 55) : 40;
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.84)},${Math.floor(v * 0.55)})`;
      ctx.fillRect(8 + col * 18, 7 + r * 18, 11, 12);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; // filter the window grid smoothly at grazing angles / distance (was aliasing into noise)
  return (_windowTex = t);
}

const BUILDING_PALETTE = [0xe8d3ad, 0xe7b386, 0xcdd7e0, 0xbcd2b6, 0xece0c8, 0xd4b3cf, 0xf0e6d2, 0xe0907c, 0xb8c79c];
const ROOF_PALETTE = [0x8d5a3a, 0xa84838, 0x6d6e5a, 0x4f6e78, 0x7a5a8a, 0x3f5566, 0x9c6b33];
const TRIM_PALETTE = [0xfbf3e3, 0xf2e6cc, 0x5b3a22, 0x3f4a55];

// Shared material for all the solid (vertex-coloured) building detail, so a
// fully detailed building is still only ~2 draw calls.
const _solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });

// Add a positioned geometry to `parts` with a baked vertex colour. Geometries
// are normalised to non-indexed first: RoundedBoxGeometry (from rbox()) is
// non-indexed while Box/Cone/Cylinder are indexed, and mergeGeometries() refuses
// to mix the two. Converting everything here keeps every merge compatible.
function part(parts, geo, color) {
  if (geo.index) geo = geo.toNonIndexed();
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  parts.push(geo);
}

function bodyMaterial(wall) {
  return new THREE.MeshStandardMaterial({
    color: wall,
    roughness: 0.94,
    emissive: 0xffcf86,
    emissiveMap: windowTexture(),
    emissiveIntensity: 0.32,
  });
}

// A detailed small-town / farm building: foundation, trim, varied overhanging
// roof, chimney, dormer, framed door + awning, sometimes an L-shaped wing.
function makeBuilding(density, biome) {
  const g = new THREE.Group();
  const w = 4 + rand() * 3.5;
  const d = 4 + rand() * 3.5;
  let floors = 1;
  if (rand() < 0.45 + density * 0.2) floors = 2;
  if (floors === 2 && rand() < 0.15) floors = 3;
  const h = floors * 2.7;
  const base = 0.6;
  const top = base + h;
  // In the snowy biomes (alpine, tundra), frost the walls and snow-cover the roof.
  const snow = biome && (biome.name === "alpine" || biome.name === "tundra");
  let wall = pick(BUILDING_PALETTE);
  if (snow) wall = new THREE.Color(wall).lerp(new THREE.Color(0xffffff), 0.3).getHex();
  const roofCol = snow ? 0xeef4fa : pick(ROOF_PALETTE);
  const trim = snow ? 0xdfe8f0 : pick(TRIM_PALETTE);

  // Window-lit body (+ optional wing), merged into one emissive mesh.
  const bodyParts = [roundedColumn(w, h, d, 0.9).translate(0, base + h / 2, 0)];
  let wing = null;
  if (rand() < 0.4) {
    const ww = w * 0.6;
    const wd = d * 0.62;
    const wh = h * (floors > 1 ? 0.6 : 0.92);
    const wx = (w / 2 + ww / 2 - 0.2) * (rand() < 0.5 ? 1 : -1);
    const wz = (rand() - 0.5) * d * 0.3;
    bodyParts.push(roundedColumn(ww, wh, wd, 0.9).translate(wx, base + wh / 2, wz));
    wing = { ww, wd, wh, wx, wz };
  }
  const body = new THREE.Mesh(mergeGeometries(bodyParts), bodyMaterial(wall));
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.bodyWall = wall; // batchBuildings() bakes this into vertex colour to merge bodies
  g.add(body);

  // Everything else: solid vertex-coloured detail.
  const parts = [];
  part(parts, new THREE.BoxGeometry(w + 0.5, base, d + 0.5).translate(0, base / 2, 0), 0x5a4f44); // foundation
  part(parts, new THREE.BoxGeometry(w + 0.12, 0.18, d + 0.12).translate(0, top - 0.1, 0), trim); // eave band

  const flat = rand() < 0.25;
  if (flat) {
    part(parts, new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3).translate(0, top + 0.25, 0), roofCol);
    part(parts, new THREE.BoxGeometry(w + 0.4, 0.5, 0.3).translate(0, top + 0.6, d / 2 + 0.05), trim); // front parapet
  } else {
    const roofH = 1.4 + floors * 0.45;
    const rad = Math.max(w, d) * 0.82 + 0.5;
    part(parts, new THREE.ConeGeometry(rad, roofH, 4).rotateY(Math.PI / 4).translate(0, top + roofH / 2, 0), roofCol);
    if (rand() < 0.75) {
      const cx = w * 0.25;
      const cz = d * 0.2;
      part(parts, new THREE.BoxGeometry(0.5, 1.6, 0.5).translate(cx, top + roofH * 0.4, cz), 0x8a5a44);
      part(parts, new THREE.BoxGeometry(0.7, 0.22, 0.7).translate(cx, top + roofH * 0.4 + 0.9, cz), 0x333333);
    }
    if (floors >= 2 && rand() < 0.5) {
      part(parts, new THREE.BoxGeometry(1.3, 1.1, 1.0).translate(0, top + 0.35, d / 2 - 0.3), wall);
      part(parts, new THREE.ConeGeometry(1.1, 0.8, 4).rotateY(Math.PI / 4).translate(0, top + 1.2, d / 2 - 0.3), roofCol);
    }
  }

  // Framed door (+ step).
  const dx = (rand() - 0.5) * (w - 2.2);
  part(parts, new THREE.BoxGeometry(1.4, 2.1, 0.18).translate(dx, base + 1.0, d / 2 + 0.02), trim);
  part(parts, new THREE.BoxGeometry(0.95, 1.65, 0.12).translate(dx, base + 0.82, d / 2 + 0.12), 0x4a2f1c);
  part(parts, new THREE.BoxGeometry(1.6, 0.2, 0.7).translate(dx, base, d / 2 + 0.35), 0x7a6b58); // step
  if (rand() < 0.4) {
    const awn = new THREE.BoxGeometry(2.2, 0.22, 1.1);
    awn.rotateX(-0.32);
    awn.translate(dx, base + 2.0, d / 2 + 0.55);
    part(parts, awn, pick([0xd23a2a, 0x2a7ad2, 0x2e9e4a, 0xe0a52a]));
  }

  const solid = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  solid.castShadow = true;
  solid.receiveShadow = true;
  g.add(solid);
  g.userData.isBuilding = true; // collected + merged by batchBuildings() to slash draw calls
  return g;
}

// A downtown TOWER for the city biome: a tall glass-and-concrete high-rise with
// horizontal floor bands, a parapet, and a rooftop unit/antenna. Same 2-mesh
// (body + solid) structure as makeBuilding so batchBuildings() merges it too.
const CITY_WALLS = [0x8b93a0, 0x9aa6b2, 0x76808c, 0xa7b0bc, 0x6f7b88, 0xaeb6c0, 0x8090a8];
const CITY_TRIM = [0x3a4048, 0x2b2f36, 0x4a5058];
function makeTower(density) {
  const g = new THREE.Group();
  const w = 5 + rand() * 4.5;
  const d = 5 + rand() * 4.5;
  const floors = 4 + Math.floor(rand() * (4 + density * 6)); // ~4..14 storeys
  const fh = 2.8;
  const h = floors * fh;
  const base = 0.4;
  const top = base + h;
  const wall = pick(CITY_WALLS);
  const trim = pick(CITY_TRIM);
  const body = new THREE.Mesh(roundedColumn(w, h, d, 0.5).translate(0, base + h / 2, 0), bodyMaterial(wall));
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.bodyWall = wall; // batchBuildings() bakes this into vertex colour
  g.add(body);

  const parts = [];
  part(parts, new THREE.BoxGeometry(w + 0.4, base, d + 0.4).translate(0, base / 2, 0), 0x40454d); // plinth
  for (let f = 1; f < floors; f++) {
    part(parts, new THREE.BoxGeometry(w + 0.08, 0.14, d + 0.08).translate(0, base + f * fh, 0), trim); // floor spandrel band
  }
  part(parts, new THREE.BoxGeometry(w + 0.2, 0.5, d + 0.2).translate(0, top + 0.25, 0), trim); // roof parapet
  part(parts, new THREE.BoxGeometry(w * 0.42, 1.0, d * 0.42).translate((rand() - 0.5) * w * 0.3, top + 0.9, (rand() - 0.5) * d * 0.3), 0x555b63); // rooftop unit
  if (rand() < 0.5) part(parts, new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5).translate(w * 0.22, top + 1.7, d * 0.2), 0x2a2a2a); // antenna
  const solid = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  solid.castShadow = true;
  solid.receiveShadow = true;
  g.add(solid);
  g.userData.isBuilding = true;
  return g;
}

// A low CITY storefront: a flat-roofed 1-2 storey shop with a glass storefront,
// a coloured awning and a rooftop sign — mixed in with the towers so the city
// has ground-level street life, not just a wall of high-rises. Same 2-mesh
// structure as the other buildings so batchBuildings() merges it.
const STORE_WALLS = [0xb8837a, 0x8a9db0, 0xc2a86a, 0x9a8f86, 0xa86b6b, 0x7d95a0, 0xcabf9a];
const STORE_ACCENT = [0xd0503a, 0x3a86c8, 0x2ea86a, 0xe0a52a, 0xc44a8a, 0x39434f];
function makeCityStore() {
  const g = new THREE.Group();
  const w = 7 + rand() * 5;
  const d = 6 + rand() * 3;
  const floors = rand() < 0.4 ? 2 : 1;
  const fh = 3.0;
  const h = floors * fh + 0.6; // taller ground floor for the storefront
  const base = 0.3;
  const top = base + h;
  const wall = pick(STORE_WALLS);
  const trim = pick(CITY_TRIM);
  const accent = pick(STORE_ACCENT);
  const body = new THREE.Mesh(roundedColumn(w, h, d, 0.4).translate(0, base + h / 2, 0), bodyMaterial(wall));
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.bodyWall = wall;
  g.add(body);

  const parts = [];
  part(parts, new THREE.BoxGeometry(w + 0.4, base, d + 0.4).translate(0, base / 2, 0), 0x40454d); // plinth
  part(parts, new THREE.BoxGeometry(w * 0.86, 2.0, 0.22).translate(0, base + 1.2, d / 2 + 0.05), 0x2a3038); // dark glass storefront
  const awn = new THREE.BoxGeometry(w * 0.9, 0.24, 1.4);
  awn.rotateX(-0.22);
  awn.translate(0, base + 2.5, d / 2 + 0.72);
  part(parts, awn, accent); // awning
  part(parts, new THREE.BoxGeometry(w + 0.2, 0.5, d + 0.2).translate(0, top + 0.25, 0), trim); // flat-roof parapet
  part(parts, new THREE.BoxGeometry(w * 0.5, 0.9, 0.28).translate(0, top + 0.85, d / 2 - 0.2), accent); // rooftop sign
  if (floors === 2) part(parts, new THREE.BoxGeometry(w + 0.08, 0.14, d + 0.08).translate(0, base + fh + 0.6, 0), trim); // floor band
  const solid = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  solid.castShadow = true;
  solid.receiveShadow = true;
  g.add(solid);
  g.userData.isBuilding = true;
  return g;
}

// Shared material for all merged building BODIES: wall colour comes from baked
// vertex colours (so every wall tint merges into one mesh) while the lit-window
// emissive map still reads per-facade via UVs.
let _bodyMergeMat = null;
function bodyMergeMaterial() {
  if (_bodyMergeMat) return _bodyMergeMat;
  _bodyMergeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    emissive: 0xffcf86,
    emissiveMap: windowTexture(),
    emissiveIntensity: 0.32,
  });
  return _bodyMergeMat;
}

// Bake a flat colour into a geometry's vertex-colour attribute (creating it).
function bakeVertexColor(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

// Draw-call slasher: the roadside town is hundreds of buildings, each 2 meshes
// drawn again for shadows — the dominant draw-call cost. Buildings are static, so
// here we bake every one into world space and merge them into a FEW meshes, grouped
// into coarse spatial chunks so off-screen chunks still frustum-cull. Bodies (per-
// wall-colour) merge via baked vertex colours + the shared window-emissive material;
// solid detail already shares _solidMat. Collapses ~2 draw calls/building into ~2
// per chunk. Call once after all buildings are placed.
function batchBuildings(scene) {
  scene.updateMatrixWorld(true);
  const groups = [];
  scene.traverse((o) => { if (o.userData && o.userData.isBuilding) groups.push(o); });
  if (!groups.length) return;
  const CHUNK = 150; // world units per merge bucket (coarse culling granularity)
  const buckets = new Map();
  const bucketOf = (x, z) => {
    const key = Math.round(x / CHUNK) + "_" + Math.round(z / CHUNK);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { bodies: [], solids: [] }));
    return b;
  };
  for (const g of groups) {
    const b = bucketOf(g.position.x, g.position.z);
    for (const child of g.children) {
      if (!child.isMesh) continue;
      const geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld); // bake world transform
      if (child.userData.bodyWall !== undefined) {
        bakeVertexColor(geo, child.userData.bodyWall);
        b.bodies.push(geo);
      } else {
        b.solids.push(geo); // already vertex-coloured (_solidMat)
      }
    }
    g.parent && g.parent.remove(g);
    // free the now-unused per-building geometries/materials
    g.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material !== _solidMat) o.material.dispose();
      }
    });
  }
  const addMerged = (geos, material) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos);
    geos.forEach((gg) => gg.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(1); // match the originals (scenery layer)
    scene.add(mesh);
  };
  for (const b of buckets.values()) {
    addMerged(b.bodies, bodyMergeMaterial());
    addMerged(b.solids, _solidMat);
  }
}

// Merge the static street/farm props (benches, fences, bushes, planters, market
// stalls, signs, hay bales…) the way batchBuildings merges houses. Each prop is
// 2-6 little meshes; a town sightline used to submit HUNDREDS of them as
// individual draw calls. Props share no material INSTANCES (mat() mints one per
// call), so meshes are grouped by a key of the material's properties and merged
// per 150u chunk — one draw call per (chunk, look) instead of one per plank.
function batchStaticProps(scene) {
  scene.updateMatrixWorld(true);
  const groups = [];
  scene.traverse((o) => { if (o.userData && o.userData.staticProp) groups.push(o); });
  if (!groups.length) return;
  const CHUNK = 150; // world units per merge bucket (coarse culling granularity)
  const buckets = new Map();
  const keep = []; // meshes that can't merge (textured/exotic) — reparent, don't drop
  const _underLive = (o, root) => {
    for (let p = o; p && p !== root.parent; p = p.parent) if (p.userData.keepLive) return true;
    return false;
  };
  for (const g of groups) {
    const bKey = Math.round(g.position.x / CHUNK) + "_" + Math.round(g.position.z / CHUNK);
    let bucket = buckets.get(bKey);
    if (!bucket) buckets.set(bKey, (bucket = new Map()));
    g.traverse((o) => {
      // keepLive subtrees (a windmill's spinning sail hub) stay animated — the
      // whole subtree is re-attached to the scene before the group is removed.
      if (o.userData.keepLive) { keep.push(o); return; }
      if (!o.isMesh || _underLive(o, g)) return;
      const m = o.material;
      // Only plain, un-textured standard materials merge safely; anything else
      // (maps, node materials, arrays) survives as its own mesh.
      if (!m || Array.isArray(m) || !m.isMeshStandardMaterial || m.map || m.transparent) {
        keep.push(o);
        return;
      }
      const mKey = `${m.color.getHexString()}|${m.roughness}|${m.metalness}|${m.flatShading ? 1 : 0}|${m.side}|${m.emissive.getHexString()}|${m.emissiveIntensity}|${m.userData.backlight ? 1 : 0}`;
      let entry = bucket.get(mKey);
      if (!entry) bucket.set(mKey, (entry = { material: m, geos: [] }));
      let geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld); // bake world transform
      if (geo.index) geo = geo.toNonIndexed(); // mergeGeometries can't mix indexed/non
      for (const a of Object.keys(geo.attributes)) {
        if (a !== "position" && a !== "normal" && a !== "uv") geo.deleteAttribute(a);
      }
      entry.geos.push(geo);
    });
  }
  for (const o of keep) scene.attach(o); // preserve world transform outside the doomed group
  // Materials are minted per call by mat(); each look keeps ONE representative
  // (referenced by the merged mesh below) and the duplicates are disposed.
  const heldMats = new Set();
  for (const bucket of buckets.values()) for (const e of bucket.values()) heldMats.add(e.material);
  for (const g of groups) {
    g.parent && g.parent.remove(g);
    g.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (!heldMats.has(o.material)) o.material.dispose?.();
      }
    });
  }
  for (const bucket of buckets.values()) {
    for (const { material, geos } of bucket.values()) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      geos.forEach((gg) => gg.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(1); // match the originals (scenery layer, out of the mirror)
      scene.add(mesh);
    }
  }
}

// Pick a town structure — mostly houses, occasionally a landmark.
function makeTownStructure(density, biome) {
  const r = rand();
  if (r < 0.05) return makeChurch();
  if (r < 0.09) return makeWaterTower();
  return makeBuilding(density, biome);
}

function makeChurch() {
  const g = new THREE.Group();
  const wall = 0xeae0cf;
  const roofCol = 0x4f6e78;
  const parts = [];
  const naveH = 6;
  part(parts, roundedColumn(6, naveH, 9, 1.0).translate(0, naveH / 2, 0), wall);
  part(parts, new THREE.ConeGeometry(5, 3, 4).rotateY(Math.PI / 4).translate(0, naveH + 1.5, 0), roofCol);
  // bell tower
  const tH = 10;
  part(parts, roundedColumn(3, tH, 3, 0.85).translate(0, tH / 2, 5), wall);
  part(parts, new THREE.ConeGeometry(2.4, 4, 4).rotateY(Math.PI / 4).translate(0, tH + 2, 5), roofCol);
  // cross
  part(parts, new THREE.BoxGeometry(0.2, 1.4, 0.2).translate(0, tH + 4.6, 5), 0xf0e6d2);
  part(parts, new THREE.BoxGeometry(0.9, 0.2, 0.2).translate(0, tH + 4.8, 5), 0xf0e6d2);
  // door
  part(parts, new THREE.BoxGeometry(1.4, 2.4, 0.2).translate(0, 1.2, 5 + 1.5), 0x4a2f1c);
  g.add(new THREE.Mesh(mergeGeometries(parts), _solidMat));
  return g;
}

function makeWaterTower() {
  const g = new THREE.Group();
  const parts = [];
  const legH = 7;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      part(parts, new THREE.CylinderGeometry(0.25, 0.25, legH, 6).translate(sx * 1.6, legH / 2, sz * 1.6), 0x6b5644);
    }
  part(parts, new THREE.CylinderGeometry(2.6, 2.6, 3, 12).translate(0, legH + 1.5, 0), 0xb24a3a);
  part(parts, new THREE.ConeGeometry(2.8, 1.8, 12).translate(0, legH + 3.9, 0), 0x5a4438);
  g.add(new THREE.Mesh(mergeGeometries(parts), _solidMat));
  return g;
}

function makeWindmill() {
  const g = new THREE.Group();
  const parts = [];
  const tH = 7;
  part(parts, new THREE.CylinderGeometry(1.1, 1.8, tH, 10).translate(0, tH / 2, 0), 0xe6dcc6);
  part(parts, new THREE.ConeGeometry(1.6, 1.6, 10).translate(0, tH + 0.8, 0), 0x7a4a36);
  g.add(new THREE.Mesh(mergeGeometries(parts), _solidMat));
  // sails — a cross of blades at the front that actually turns in the wind. The
  // four blades spin as ONE unit, so they bake into a single mesh on the hub
  // (1 draw instead of 4); the hub is tagged keepLive so the static-prop batch
  // merges the tower but leaves the spinning sails their own subtree.
  const sailMat = mat(0xf4efe2);
  const hub = new THREE.Group();
  hub.position.set(0, tH, 1.7);
  const bladeGeos = [];
  for (let i = 0; i < 4; i++) {
    bladeGeos.push(new THREE.BoxGeometry(0.5, 4, 0.1).translate(0, 2, 0).rotateZ((i / 4) * Math.PI * 2));
  }
  hub.add(new THREE.Mesh(mergeGeometries(bladeGeos), sailMat));
  hub.userData.keepLive = true;
  g.add(hub);
  _spinners.push({ obj: hub, ax: "z", speed: 0.6, phase: rand() * 6.28 });
  return g;
}

function makeSilo() {
  const g = new THREE.Group();
  const parts = [];
  const hH = 8;
  part(parts, new THREE.CylinderGeometry(1.6, 1.6, hH, 12).translate(0, hH / 2, 0), 0xc9ccd2);
  part(parts, new THREE.SphereGeometry(1.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, hH, 0), 0x8a9aa6);
  g.add(new THREE.Mesh(mergeGeometries(parts), _solidMat));
  return g;
}

function makeStreetProp() {
  const r = rand();
  if (r < 0.26) return makeLamp();
  if (r < 0.42) return makeBench();
  if (r < 0.54) return makeHydrant();
  if (r < 0.7) return makePlanter();
  if (r < 0.85) return makeMarketStall();
  if (r < 0.94) return makeSign();
  return makeBush();
}

function makePlanter() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(rbox(1.4, 0.6, 1.4, 0.14), mat(0x8d6e3a));
  box.position.y = 0.3;
  g.add(box);
  const m = mat(0x4caf50, { flatShading: true });
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), m);
    b.position.set((rand() - 0.5) * 0.8, 0.8, (rand() - 0.5) * 0.8);
    g.add(b);
  }
  return g;
}

function makeMarketStall() {
  const g = new THREE.Group();
  const wood = mat(0x9c6b3f);
  const table = new THREE.Mesh(rbox(2.6, 0.2, 1.4, 0.09), wood);
  table.position.y = 1.0;
  g.add(table);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1, 0.14), wood);
      leg.position.set(sx * 1.1, 0.5, sz * 0.55);
      g.add(leg);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), wood);
      post.position.set(sx * 1.2, 1.2, sz * 0.6);
      g.add(post);
    }
  const stripe = rand() < 0.5 ? 0xd23a2a : 0x2a7ad2;
  const canopy = new THREE.Mesh(rbox(3, 0.3, 1.9, 0.13), mat(stripe));
  canopy.position.y = 2.5;
  canopy.castShadow = true;
  g.add(canopy);
  // produce
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 8),
      mat([0xe53935, 0xff9800, 0x8bc34a, 0xffeb3b][i % 4])
    );
    c.position.set(-0.9 + i * 0.6, 1.2, 0);
    g.add(c);
  }
  return g;
}

function makeSign() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 6), mat(0x5d4037));
  post.position.y = 1.1;
  g.add(post);
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.8, 0.1),
    mat([0x2e7d32, 0xc62828, 0x1565c0, 0xf9a825][Math.floor(rand() * 4)])
  );
  board.position.y = 1.9;
  g.add(board);
  return g;
}

function makeBench() {
  const g = new THREE.Group();
  const wood = mat(0x8d6e3a);
  const seat = new THREE.Mesh(rbox(2.4, 0.18, 0.7, 0.08), wood);
  seat.position.y = 0.6;
  g.add(seat);
  const back = new THREE.Mesh(rbox(2.4, 0.7, 0.15, 0.07), wood);
  back.position.set(0, 1.0, -0.28);
  g.add(back);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.6), wood);
    leg.position.set(sx * 1.0, 0.3, 0);
    g.add(leg);
  }
  return g;
}

function makeHydrant() {
  const g = new THREE.Group();
  const red = mat(0xd23a2a);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 1.1, 8), red);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), red);
  cap.position.y = 1.1;
  g.add(cap);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 6), red);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(sx * 0.32, 0.7, 0);
    g.add(arm);
  }
  return g;
}

function makeFarmProp(biome) {
  const b = biome || BIOMES[0];
  const r = rand();
  if (b.style === "cactus") {
    // Dry country: cacti, rocks and the odd ranch structure.
    if (r < 0.45) return makeCactusProp();
    if (r < 0.62) return makeRockProp();
    if (r < 0.74) return makeFence(0x9c7a4a);
    if (r < 0.84) return makeHayBale();
    if (r < 0.93) return makeWindmill();
    return makeSilo();
  }
  // Biome-appropriate wildlife + dressing.
  if (b.name === "beach") {
    // Seaside: crabs and gulls on the sand, parasols, driftwood rocks + palms.
    if (r < 0.24) return makeCrab();
    if (r < 0.44) return makeGull();
    if (r < 0.60) return makeParasol();
    if (r < 0.74) return makeTree(b); // a stray palm
    if (r < 0.88) return makeRockProp();
    return makeBush();
  }
  if (b.name === "forest" || b.name === "alpine" || b.name === "tundra") {
    // Woodland: deer among the trees, rocks, rustic fences.
    if (r < 0.26) return makeDeer();
    if (r < 0.46) return makeTree(b);
    if (r < 0.60) return makeBush();
    if (r < 0.74) return makeRockProp();
    if (r < 0.88) return makeFence(0x6b4a2b);
    return makeHayBale();
  }
  if (b.name === "city") {
    // Downtown verge: urban street furniture, not grey trees or livestock. (A
    // makeTree here rendered a GREY lollipop because the city foliage HSL is
    // desaturated — replaced with planters/benches/hydrants/signs.)
    if (r < 0.32) return makePlanter();
    if (r < 0.52) return makeBench();
    if (r < 0.70) return makeHydrant();
    if (r < 0.85) return makeSign();
    return makeBush();
  }
  // Pastoral (meadow / autumn / blossom / savanna): cows, sheep, farm buildings.
  if (r < 0.24) return makeTree(b);
  if (r < 0.4) return makeBush();
  if (r < 0.5) return makeCow();
  if (r < 0.6) return makeSheep();
  if (r < 0.7) return makeHayBale();
  if (r < 0.78) return makeFence(0x8d6e3a);
  if (r < 0.86) return makeBarn();
  if (r < 0.93) return makeWindmill();
  return makeSilo();
}

function makeCactusProp() {
  const g = new THREE.Group();
  const c = new THREE.Mesh(cactusGeometry(), mat(0x4f8a4a, { flatShading: true }));
  c.scale.setScalar(0.9 + rand() * 0.8);
  c.castShadow = true;
  g.add(c);
  return g;
}

function makeRockProp() {
  const g = new THREE.Group();
  const m = mat(0x9a8a6a);
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6 + rand() * 1.0, 1), m);
    r.position.set((rand() - 0.5) * 2, 0.4, (rand() - 0.5) * 2);
    r.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    r.castShadow = true;
    g.add(r);
  }
  return g;
}

function makeHouse() {
  const g = new THREE.Group();
  const palette = [0xd9776a, 0xe0b15a, 0x7aa6c2, 0x9ccc8f, 0xc9bfa8, 0xb98ec2, 0xe8e0d0];
  const w = 5 + rand() * 4;
  const d = 5 + rand() * 4;
  const floors = 1 + Math.floor(rand() * 3);
  const h = floors * 3.2;
  const body = new THREE.Mesh(roundedColumn(w, h, d, 0.9), mat(pick(palette)));
  body.position.y = h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.8, 2.6, 4), mat(0x6d4c41));
  roof.position.y = h + 1.3;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
  const winMat = mat(0xfff2b0, { emissive: 0xffd95e, emissiveIntensity: 0.5 });
  for (let f = 0; f < floors; f++) {
    for (const sz of [d / 2 + 0.05, -d / 2 - 0.05]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, 1.3), winMat);
      win.position.set(0, 1.6 + f * 3.2, sz);
      if (sz < 0) win.rotation.y = Math.PI;
      g.add(win);
    }
  }
  return g;
}

function makeLamp() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 5, 6), mat(0x37474f));
  pole.position.y = 2.5;
  pole.castShadow = true;
  g.add(pole);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 8, 8),
    mat(0xfff3c4, { emissive: 0xffe082, emissiveIntensity: 0.8 })
  );
  head.position.y = 5;
  g.add(head);
  return g;
}

function makeFence(color) {
  const g = new THREE.Group();
  const m = mat(color);
  const len = 6;
  for (let i = 0; i <= 3; i++) {
    const post = new THREE.Mesh(rbox(0.2, 1.4, 0.2, 0.09), m);
    post.position.set(-len / 2 + (i / 3) * len, 0.7, 0);
    g.add(post);
  }
  for (const ry of [0.5, 1.05]) {
    const rail = new THREE.Mesh(rbox(len, 0.16, 0.12, 0.06), m);
    rail.position.set(0, ry, 0);
    g.add(rail);
  }
  return g;
}

function makeTree(biome) {
  const b = biome || BIOMES[0];
  const shape = b.treeShape === "cactus" ? "round" : b.treeShape || "round";
  const g = new THREE.Group();
  const s = 0.9 + rand() * 1.2;
  const hmul = TRUNK_HMUL[shape] ?? 1.0;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 6), mat(0x6b4a2b));
  trunk.position.y = 1.5 * s * hmul;
  trunk.scale.set(s, s * hmul, s);
  trunk.castShadow = true;
  g.add(trunk);
  let h = b.foliage[0];
  if (b.name === "autumn") h += (rand() - 0.5) * 0.12;
  else if (b.name === "blossom") h += (rand() - 0.5) * 0.04;
  const folCol = new THREE.Color().setHSL(h, b.foliage[1], clamp(b.foliage[2] + (rand() - 0.5) * 0.1, 0.14, 0.86));
  // Share the cached canopy silhouette so roadside trees match the scattered ones.
  const fol = new THREE.Mesh(foliageGeoFor(shape), mat(folCol.getHex(), { flatShading: true }));
  fol.position.y = 3 * s * hmul - 0.2 * s;
  fol.scale.set(b.sx * s, b.sy * s, b.sx * s);
  fol.castShadow = true;
  g.add(fol);
  return g;
}

function makeBush() {
  const g = new THREE.Group();
  const m = mat(0x4caf50, { flatShading: true });
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + rand() * 0.6, 0), m);
    b.position.set((rand() - 0.5) * 2, 0.7, (rand() - 0.5) * 2);
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

function makeCow() {
  // The whole cow wanders as a unit, so its parts are rigid relative to each
  // other — bake them into ONE multi-material mesh (2 draws) instead of 7 meshes.
  const g = new THREE.Group();
  const white = mat(0xf2f2f2);
  const dark = mat(0x3a2f2a);
  const parts = [];
  const body = new THREE.Mesh(rbox(3, 1.6, 1.5, 0.45), white);
  body.position.y = 1.5;
  parts.push(body);
  const patch = new THREE.Mesh(rbox(1.1, 1.62, 1.0, 0.3), dark);
  patch.position.set(0.6, 1.5, 0);
  parts.push(patch);
  const head = new THREE.Mesh(rbox(0.9, 0.9, 0.9, 0.28), white);
  head.position.set(-1.7, 1.7, 0);
  parts.push(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(rbox(0.3, 1.5, 0.3, 0.12), dark);
      leg.position.set(sx * 1.1, 0.75, sz * 0.5);
      parts.push(leg);
    }
  g.add(mergeMeshes(parts, { castShadow: true }));
  g.userData.wander = { range: 4, speed: 1.1, bob: 0.06 }; // cows graze slowly
  return g;
}

function makeSheep() {
  // Rigid like the cow: one multi-material mesh (2 draws) instead of 6 meshes.
  const g = new THREE.Group();
  const wool = mat(0xf6f4ef, { flatShading: true });
  const dark = mat(0x2b2b2b);
  const parts = [];
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), wool);
  body.position.y = 1.4;
  body.scale.set(1.3, 1, 1);
  parts.push(body);
  const head = new THREE.Mesh(rbox(0.7, 0.7, 0.6, 0.22), dark);
  head.position.set(-1.4, 1.5, 0);
  parts.push(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(rbox(0.22, 1.1, 0.22, 0.09), dark);
      leg.position.set(sx * 0.7, 0.55, sz * 0.45);
      parts.push(leg);
    }
  g.add(mergeMeshes(parts, { castShadow: true }));
  g.userData.wander = { range: 5, speed: 1.6, bob: 0.16 }; // sheep bounce more
  return g;
}

// A deer for the woodland biomes (forest / alpine / tundra): tan body on tall
// legs, a raised head, and a small fork of antlers.
function makeDeer() {
  const g = new THREE.Group();
  const tan = mat(0x9c6a3c);
  const dark = mat(0x5a3a22);
  const parts = [];
  const body = new THREE.Mesh(rbox(2.2, 1.2, 1.0, 0.4), tan);
  body.position.y = 1.7; parts.push(body);
  const neck = new THREE.Mesh(rbox(0.5, 1.1, 0.5, 0.2), tan);
  neck.position.set(-1.05, 2.15, 0); neck.rotation.z = 0.5; parts.push(neck);
  const head = new THREE.Mesh(rbox(0.8, 0.55, 0.5, 0.2), tan);
  head.position.set(-1.55, 2.7, 0); parts.push(head);
  for (const sx of [-1, 1]) { // antler forks
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.6, 4), dark);
    a.position.set(-1.6, 3.1, sx * 0.14); a.rotation.z = 0.3; parts.push(a);
    const a2 = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 4), dark);
    a2.position.set(-1.72, 3.35, sx * 0.22); a2.rotation.z = 0.9; parts.push(a2);
  }
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(rbox(0.22, 1.5, 0.22, 0.09), dark);
      leg.position.set(sx * 0.8, 0.75, sz * 0.35); parts.push(leg);
    }
  g.add(mergeMeshes(parts, { castShadow: true }));
  g.userData.wander = { range: 6, speed: 2.2, bob: 0.12 }; // deer step lightly
  return g;
}

// A little crab for the beach: a wide flat shell, two eyestalks, two claws, that
// scuttles quickly in short hops.
function makeCrab() {
  const g = new THREE.Group();
  const shell = mat(0xe0663a, { flatShading: true });
  const parts = [];
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), shell);
  body.scale.set(1.5, 0.6, 1.1); body.position.y = 0.35; parts.push(body);
  for (const sx of [-1, 1]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.28, 4), shell);
    stalk.position.set(sx * 0.18, 0.62, 0.3); parts.push(stalk);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), mat(0x1a1a1a));
    eye.position.set(sx * 0.18, 0.78, 0.3); parts.push(eye);
    const claw = new THREE.Mesh(rbox(0.34, 0.24, 0.2, 0.08), shell);
    claw.position.set(sx * 0.82, 0.32, 0.1); parts.push(claw);
    for (let l = 0; l < 3; l++) { // walking legs
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 4), shell);
      leg.position.set(sx * 0.6, 0.18, -0.1 - l * 0.18); leg.rotation.z = sx * 0.9; parts.push(leg);
    }
  }
  g.add(mergeMeshes(parts, { castShadow: true }));
  g.scale.setScalar(1.1);
  g.userData.wander = { range: 3.5, speed: 3.2, bob: 0.02 }; // scuttles fast, low
  return g;
}

// A seaside gull that struts along the sand: white body, grey back, orange beak.
function makeGull() {
  const g = new THREE.Group();
  const white = mat(0xf4f6f8);
  const grey = mat(0x9aa4ac);
  const parts = [];
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), white);
  body.scale.set(1, 0.9, 1.5); body.position.y = 0.7; parts.push(body);
  const back = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), grey);
  back.scale.set(1, 0.5, 1.4); back.position.set(0, 0.86, -0.1); parts.push(back);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), white);
  head.position.set(0, 1.05, 0.42); parts.push(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.24, 5), mat(0xe0a52a));
  beak.rotation.x = Math.PI / 2; beak.position.set(0, 1.02, 0.68); parts.push(beak);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.44, 4), mat(0xe0a52a));
    leg.position.set(sx * 0.12, 0.26, 0.1); parts.push(leg);
  }
  g.add(mergeMeshes(parts, { castShadow: true }));
  g.userData.wander = { range: 4, speed: 2.0, bob: 0.05 };
  return g;
}

// A beach parasol (static prop): a pole and a tilted candy-striped canopy.
const PARASOL_COLS = [0xe0533a, 0x3a86c8, 0x2ea86a, 0xe0a52a, 0xd05a9a];
function makeParasol() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), mat(0xf0ead8));
  pole.position.y = 1.6; g.add(pole);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.9, 10), mat(pick(PARASOL_COLS), { side: THREE.DoubleSide, flatShading: true }));
  canopy.position.y = 3.2; canopy.rotation.z = 0.18; canopy.castShadow = true;
  g.add(canopy);
  return g;
}

function makeHayBale() {
  const bale = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1.7, 12),
    mat(0xd4b15a, { flatShading: true })
  );
  bale.rotation.z = Math.PI / 2;
  bale.position.y = 1;
  bale.castShadow = true;
  const g = new THREE.Group();
  g.add(bale);
  return g;
}

function makeBarn() {
  const g = new THREE.Group();
  const red = mat(0xa8322a);
  const body = new THREE.Mesh(roundedColumn(11, 6, 8, 1.1), red);
  body.position.y = 3;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 8.4, 4, 1, false, 0, Math.PI), mat(0x5a2a24));
  roof.rotation.z = Math.PI / 2;
  roof.position.y = 6;
  roof.scale.set(1, 1.3, 1);
  roof.castShadow = true;
  g.add(roof);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(3, 4), mat(0xe8e0d0));
  door.position.set(0, 2, 4.02);
  g.add(door);
  return g;
}

// ---- Hero landmarks ----
// Place each landmark on the OUTER hillside beside the road (away from the
// infield), where the valley rise lifts the ground, so it looms over the track
// and is clearly visible while driving rather than hidden in a dip. Spread them
// around the loop and face them back toward the road.
function buildLandmarks(scene, track, heightAt) {
  const makers = [makeLighthouse, makeCastle, makeFerrisWheel, makeGiantCat, makeBigWindmill];
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  makers.forEach((make, k) => {
    // Landmarks are LARGE (castle/ferris wheel footprints reach ~15-20u), so the
    // outward offset from one road point can, on a curvy/folded loop, land the
    // structure near a DIFFERENT road segment. Search out from the nominal spot,
    // pushing further each attempt, until the position clears every road segment
    // by a wide margin (distanceToCenter ≥ 45) so it never intrudes on the track.
    let x = 0, z = 0, fx = 0, fz = 0, ok = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const i = Math.floor(((((k + 0.5) / makers.length) + attempt * 0.045) % 1) * N);
      const p = track._pts[i];
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
      const dist = 82 + rand() * 28 + attempt * 6; // push further out each retry
      const cx = p.x + side.x * outward * dist;
      const cz = p.z + side.z * outward * dist;
      if (track.distanceToCenter(cx, cz) < 45 || _inLake(cx, cz)) continue;
      x = cx; z = cz; fx = p.x; fz = p.z; ok = true; break;
    }
    if (!ok) return; // no clear spot on this map layout — skip rather than intrude
    const obj = make();
    obj.name = make.name; // traceable in the scene census / debug tooling
    obj.position.set(x, heightAt(x, z), z);
    obj.rotation.y = Math.atan2(fx - x, fz - z); // face back toward the road
    scene.add(obj);
  });
}

// A pole with a cloth flag that flutters (registered with _flutterers).
function makeFlag(height = 3, color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, height, 6), mat(0x5d4037));
  pole.position.y = height / 2;
  g.add(pole);
  const pivot = new THREE.Group();
  pivot.position.y = height - 0.4;
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.0),
    mat(color ?? pick([0xd23a2a, 0x2a7ad2, 0x2e9e4a, 0xe0a52a]), { side: THREE.DoubleSide })
  );
  cloth.position.x = 0.8;
  pivot.add(cloth);
  g.add(pivot);
  _flutterers.push({ obj: pivot, phase: rand() * 6.28 });
  return g;
}

function makeLighthouse() {
  const g = new THREE.Group();
  const h = 20;
  const bands = 5;
  // Static structure (striped bands + gallery + roof) bakes into ONE vertex-
  // coloured mesh — same castle pattern — instead of ~7 single-colour meshes.
  // Only the emissive lamp and the sweeping beam stay separate.
  const parts = [];
  for (let i = 0; i < bands; i++) {
    const r0 = 2.4 - (i / bands) * 1.0;
    const r1 = 2.4 - ((i + 1) / bands) * 1.0;
    part(parts, new THREE.CylinderGeometry(r1, r0, h / bands, 16).translate(0, (i + 0.5) * (h / bands), 0), i % 2 ? 0xd23a2a : 0xf5f0e6);
  }
  part(parts, new THREE.CylinderGeometry(1.8, 1.8, 0.6, 16).translate(0, h, 0), 0x37474f);
  part(parts, new THREE.ConeGeometry(1.7, 1.6, 12).translate(0, h + 3.3, 0), 0x2b2b2b);
  const tower = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  tower.castShadow = true;
  g.add(tower);
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 2.2, 12),
    mat(0xfff3c4, { emissive: 0xffe082, emissiveIntensity: 0.9 })
  );
  lamp.position.y = h + 1.4;
  g.add(lamp);
  // A long translucent beam that sweeps around (MeshBasic, so it stays glowing).
  const beamHub = new THREE.Group();
  beamHub.position.y = h + 1.4;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(1.3, 24, 4, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xfff6c0,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  beam.rotation.z = Math.PI / 2;
  beam.position.x = 12;
  beamHub.add(beam);
  g.add(beamHub);
  _spinners.push({ obj: beamHub, ax: "y", speed: 0.8, phase: 0 });
  return g;
}

function makeCastle() {
  const g = new THREE.Group();
  const stone = 0xb9b3a6;
  const stone2 = 0x9c968a;
  const parts = [];
  // Central keep + crenellations.
  part(parts, roundedColumn(10, 9, 10, 1.3).translate(0, 4.5, 0), stone);
  const merlon = (x, z) => part(parts, rbox(1.1, 1.3, 1.1, 0.42).translate(x, 9.65, z), stone2);
  for (let t = -4; t <= 4; t += 2) {
    merlon(t, 5);
    merlon(t, -5);
    merlon(5, t);
    merlon(-5, t);
  }
  // Gatehouse door.
  part(parts, new THREE.BoxGeometry(2.4, 3.4, 0.3).translate(0, 1.7, 5), 0x4a2f1c);
  // Four corner towers.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      part(parts, new THREE.CylinderGeometry(2, 2.2, 12, 10).translate(sx * 6, 6, sz * 6), stone);
  g.add(new THREE.Mesh(mergeGeometries(parts), _solidMat));
  // Conical tower roofs + flags (separate so they keep their colours/animation).
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 3.6, 10), mat(0x4f6e78));
      cone.position.set(sx * 6, 13.8, sz * 6);
      g.add(cone);
      const flag = makeFlag(3);
      flag.position.set(sx * 6, 15.6, sz * 6);
      g.add(flag);
    }
  return g;
}

function makeFerrisWheel() {
  // Was ~30 meshes (12 cab materials for 6 colours among them) = ~30 draws.
  // Everything rigid merges: legs → one steel mesh, rims + all 12 spokes → one
  // steel mesh inside the rotating group, 12 cabs → one vertex-coloured mesh.
  // Total: 3 draws, identical look and animation.
  const g = new THREE.Group();
  const R = 11;
  const steel = mat(0x9099a3);
  // A-frame supports.
  const legGeos = [];
  for (const sx of [-1, 1])
    for (const lean of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.3, 0.35, R * 1.55, 8);
      leg.rotateX(lean * 0.34);
      leg.translate(sx * 4, R * 0.72, lean * 3);
      legGeos.push(leg);
    }
  const legs = new THREE.Mesh(mergeGeometries(legGeos), steel);
  legs.castShadow = true;
  g.add(legs);
  const wheel = new THREE.Group();
  wheel.position.set(0, R + 2, 0);
  const frameGeos = [
    new THREE.TorusGeometry(R, 0.3, 8, 36),
    new THREE.TorusGeometry(R * 0.62, 0.2, 8, 28),
  ];
  const cabParts = [];
  const cabCols = [0xd23a2a, 0x2a7ad2, 0x2e9e4a, 0xe0a52a, 0xab47bc, 0xff8f00];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cx = Math.cos(a) * R;
    const cy = Math.sin(a) * R;
    const spoke = new THREE.CylinderGeometry(0.08, 0.08, R, 6);
    spoke.rotateZ(a - Math.PI / 2);
    spoke.translate(cx / 2, cy / 2, 0);
    frameGeos.push(spoke);
    part(cabParts, rbox(1.6, 1.4, 1.6, 0.35).translate(cx, cy, 0), cabCols[i % cabCols.length]);
  }
  wheel.add(new THREE.Mesh(mergeGeometries(frameGeos), steel));
  wheel.add(new THREE.Mesh(mergeGeometries(cabParts), _solidMat));
  g.add(wheel);
  _spinners.push({ obj: wheel, ax: "z", speed: 0.25, phase: 0 });
  return g;
}

function makeGiantCat() {
  // All the stone (plus the base) bakes into ONE vertex-coloured mesh — was ~12
  // separate meshes/draws. Only the emissive eyes (one merged pair) and glowing
  // collar stay separate.
  const g = new THREE.Group();
  const stoneC = 0xc9c2b4;
  const parts = [];
  part(parts, new THREE.CylinderGeometry(4.5, 5, 1.2, 20).translate(0, 0.6, 0), 0x8a8278);
  part(parts, new THREE.CylinderGeometry(2.4, 3.6, 8, 16).translate(0, 4.8, 0), stoneC);
  part(parts, new THREE.SphereGeometry(2.6, 16, 16).scale(1, 1.2, 0.8).translate(0, 4, 1.4), stoneC);
  part(parts, new THREE.SphereGeometry(2.6, 16, 16).translate(0, 10.2, 0), stoneC);
  for (const sx of [-1, 1]) part(parts, new THREE.ConeGeometry(0.95, 1.9, 4).translate(sx * 1.3, 12.3, 0), stoneC);
  // Tail: rotation.set(PI/2, 0, 0.5) with default XYZ order = Rx·Rz applied to
  // the geometry as rotateZ first, then rotateX.
  part(parts, new THREE.TorusGeometry(2.2, 0.5, 8, 16, Math.PI * 1.2).rotateZ(0.5).rotateX(Math.PI / 2).translate(2.8, 2.0, 1.4), stoneC);
  const statue = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  statue.castShadow = true;
  g.add(statue);
  const eyeGeos = [];
  for (const sx of [-1, 1]) eyeGeos.push(new THREE.SphereGeometry(0.45, 10, 10).translate(sx * 0.95, 10.7, 2.2));
  g.add(new THREE.Mesh(mergeGeometries(eyeGeos), mat(0x2b2b2b, { emissive: 0x0a3a2a, emissiveIntensity: 0.25 })));
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(2.2, 0.32, 8, 16),
    mat(0xe0a52a, { emissive: 0xe0a52a, emissiveIntensity: 0.3 })
  );
  collar.position.y = 8.0;
  collar.rotation.x = Math.PI / 2;
  collar.scale.set(1, 0.9, 1);
  g.add(collar);
  return g;
}

function makeBigWindmill() {
  // Tower + balcony + cap merge to one vertex-coloured mesh, and all four sail
  // arms merge to another inside the rotating hub — 11 draws down to 2 (+flag).
  const g = new THREE.Group();
  const tH = 16;
  const towerParts = [];
  part(towerParts, new THREE.CylinderGeometry(2.6, 4, tH, 12).translate(0, tH / 2, 0), 0xe6dcc6);
  part(towerParts, new THREE.CylinderGeometry(3, 3, 0.4, 12).translate(0, tH * 0.55, 0), 0x5d4037);
  part(towerParts, new THREE.ConeGeometry(3.2, 3, 12).translate(0, tH + 1.2, 0), 0x7a4a36);
  const tower = new THREE.Mesh(mergeGeometries(towerParts), _solidMat);
  tower.castShadow = true;
  g.add(tower);
  const hub = new THREE.Group();
  hub.position.set(0, tH * 0.92, 3.4);
  const armParts = [];
  for (let i = 0; i < 4; i++) {
    const rot = (i / 4) * Math.PI * 2;
    part(armParts, new THREE.BoxGeometry(0.4, 9, 0.3).translate(0, 4.5, 0).rotateZ(rot), 0x6b4a2b);
    part(armParts, new THREE.BoxGeometry(2.2, 8, 0.1).translate(1.3, 4.5, 0).rotateZ(rot), 0xf4efe2);
  }
  hub.add(new THREE.Mesh(mergeGeometries(armParts), _solidMat));
  g.add(hub);
  _spinners.push({ obj: hub, ax: "z", speed: 0.5, phase: rand() * 6.28 });
  const flag = makeFlag(2.6);
  flag.position.y = tH + 2.6;
  g.add(flag);
  return g;
}

// ---- Birds ----
// A few flocks of simple birds circling high in the sky, wings flapping. All the
// wings across every flock render as ONE InstancedMesh (they used to be ~70
// individual meshes — always in frustum on sky-filled vistas, one draw each).
// The flock→bird→wing-pivot group hierarchy still exists and animates exactly as
// before, but the pivots hold invisible markers whose world matrices are copied
// into the instance buffer after the flock update.
// Sky-bird geometry + materials, shared by every bird in every flock (they
// render as two InstancedMeshes) and by the asset viewer. The silhouette is
// corvid — fingered primaries, fan tail — but the COLOUR is a parameter, so
// the same geometry serves ravens (the default near-black), gulls, doves…
// Local axes: the bird flies along +X (beak forward), wings span ±Z. Kept
// deliberately light — these are distant sky silhouettes: a fingered wing
// shape (~16 tris) and a low-poly body/head/beak/fan-tail (~80 tris).
export const SKY_BIRD_COLOR = 0x24272c; // default: raven black
let _skyBirdGeos = null;
const _skyBirdMats = new Map(); // colour → shared material (flocks + viewer)
function skyBirdMaterial(color = SKY_BIRD_COLOR) {
  let m = _skyBirdMats.get(color);
  if (!m) {
    // DoubleSide: the wings are flat shapes, and each LEFT wing is the same
    // geometry mirrored by a negative instance scale (which flips the winding).
    m = mat(color, { flatShading: true, side: THREE.DoubleSide });
    _skyBirdMats.set(color, m);
  }
  return m;
}
function skyBirdGeos() {
  if (_skyBirdGeos) return _skyBirdGeos;

  // One RIGHT wing in (x = chord, y = span), shoulder at the origin: a swept
  // leading edge out to the wrist, splayed primary-feather "fingers" at the
  // tip, and a trailing edge curving back to the body — the raven silhouette.
  const s = new THREE.Shape();
  s.moveTo(0.42, 0);
  s.quadraticCurveTo(0.4, 1.3, 0.16, 2.05); // leading edge, swept back at the wrist
  s.lineTo(0.02, 2.42); // first (leading) finger tip
  s.lineTo(-0.1, 2.02); // notch
  s.lineTo(-0.24, 2.34); // finger
  s.lineTo(-0.32, 1.94); // notch
  s.lineTo(-0.47, 2.18); // finger
  s.lineTo(-0.5, 1.78); // notch
  s.lineTo(-0.66, 1.94); // last (trailing) finger
  s.quadraticCurveTo(-0.62, 1.1, -0.45, 0); // trailing edge back to the flank
  s.closePath();
  // Lay it flat: span along +Z, chord along X (leading edge toward +X = travel).
  const wingGeo = new THREE.ShapeGeometry(s, 3).rotateX(Math.PI / 2);

  // Body: fusiform torso, round head, short beak, and a flat fan tail with a
  // notched trailing edge — merged into one geometry (one instanced draw).
  const tail = new THREE.Shape();
  tail.moveTo(0, 0.07);
  tail.lineTo(-0.72, 0.33);
  tail.lineTo(-0.79, 0.11); // notch between fan feathers
  tail.lineTo(-0.79, -0.11);
  tail.lineTo(-0.72, -0.33);
  tail.lineTo(0, -0.07);
  tail.closePath();
  const bodyGeo = mergeGeometries([
    new THREE.SphereGeometry(0.34, 6, 4).scale(2.0, 0.75, 0.8), // torso, nose +x
    new THREE.SphereGeometry(0.17, 5, 4).translate(0.62, 0.14, 0), // head
    new THREE.ConeGeometry(0.07, 0.34, 4).rotateZ(-Math.PI / 2).translate(0.88, 0.1, 0), // beak
    new THREE.ShapeGeometry(tail, 2).rotateX(Math.PI / 2).translate(-0.5, 0.03, 0), // fan tail
  ]);
  _skyBirdGeos = { wingGeo, bodyGeo };
  return _skyBirdGeos;
}

function buildBirds(scene) {
  const flocks = [];
  const markers = []; // one per wing
  const bodyMarkers = []; // one per bird
  for (let f = 0; f < 6; f++) {
    const flock = new THREE.Group();
    const wings = [];
    const count = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      const bodyMarker = new THREE.Object3D();
      bird.add(bodyMarker);
      bodyMarkers.push(bodyMarker);
      const birdPhase = rand() * 6.28; // per BIRD, so its two wings beat together
      for (const sx of [-1, 1]) {
        const wg = new THREE.Group(); // flap pivot at the shoulder
        const marker = new THREE.Object3D();
        marker.position.z = sx * 0.22; // wing root sits at the body's flank
        marker.scale.z = sx; // one wing geometry, mirrored for the left side
        wg.add(marker);
        bird.add(wg);
        wings.push({ wg, sx, phase: birdPhase });
        markers.push(marker);
      }
      bird.position.set((rand() - 0.5) * 18, (rand() - 0.5) * 8, (rand() - 0.5) * 18);
      bird.scale.setScalar(0.7 + rand() * 0.6);
      flock.add(bird);
    }
    scene.add(flock);
    flocks.push({
      flock,
      wings,
      R: 130 + rand() * 170,
      cx: (rand() - 0.5) * 320,
      cz: (rand() - 0.5) * 320,
      baseY: 85 + rand() * 55,
      speed: (0.05 + rand() * 0.05) * (rand() < 0.5 ? 1 : -1),
      phase: rand() * 6.28,
    });
  }
  // Two draws for every bird in the sky: one instanced mesh of wings, one of
  // bodies (was one draw of wing boxes — the body/tail/beak cost exactly +1).
  const { wingGeo, bodyGeo } = skyBirdGeos();
  const material = skyBirdMaterial();
  const wingMesh = new THREE.InstancedMesh(wingGeo, material, markers.length);
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, material, bodyMarkers.length);
  for (const m of [wingMesh, bodyMesh]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; // flocks span the whole sky; it's 2 draws regardless
    m.layers.set(1);
    scene.add(m);
  }
  return { flocks, wingMesh, markers, bodyMesh, bodyMarkers };
}
// Copy every marker's world matrix into the instance buffers (call after all
// updateFlock calls; one updateMatrixWorld per flock refreshes its whole subtree).
// Half-rate: the birds are tiny specks high in the sky — a 30 Hz wing beat is
// indistinguishable, and it halves the 6 subtree matrix passes + 42 setMatrixAt
// + instance upload this costs per frame.
let _wingFlip = false;
function syncBirdWings(birds) {
  _wingFlip = !_wingFlip;
  if (_wingFlip) return;
  for (const fl of birds.flocks) fl.flock.updateMatrixWorld(true);
  for (let i = 0; i < birds.markers.length; i++) birds.wingMesh.setMatrixAt(i, birds.markers[i].matrixWorld);
  for (let i = 0; i < birds.bodyMarkers.length; i++) birds.bodyMesh.setMatrixAt(i, birds.bodyMarkers[i].matrixWorld);
  birds.wingMesh.instanceMatrix.needsUpdate = true;
  birds.bodyMesh.instanceMatrix.needsUpdate = true;
}

function updateFlock(fl, time) {
  const a = time * fl.speed + fl.phase;
  fl.flock.position.set(
    fl.cx + Math.cos(a) * fl.R,
    fl.baseY + Math.sin(time * 0.3 + fl.phase) * 5,
    fl.cz + Math.sin(a) * fl.R
  );
  fl.flock.rotation.y = -a + (fl.speed > 0 ? -Math.PI / 2 : Math.PI / 2); // face travel
  for (const w of fl.wings) {
    // Negative bias = wings held in a shallow raised V (a corvid's glide);
    // the flap swings around that. Slightly slower beat than the old sparrow
    // boxes — ravens row, they don't flutter.
    w.wg.rotation.x = -w.sx * (0.25 + Math.sin(time * 6.5 + w.phase) * 0.55);
  }
}

// Gentle wander for ground animals: amble toward a roaming target near their
// spawn, turn the nose (local -X) to lead, follow the ground, and bob as they
// go. heightAt is only sampled when a new target is chosen (cheap).
function updateCritter(c, dt, time, heightAt) {
  c.t -= dt;
  if (c.t <= 0) {
    c.t = 2.5 + rand() * 4;
    const a = rand() * Math.PI * 2;
    const r = rand() * c.range;
    c.tx = c.base.x + Math.cos(a) * r;
    c.tz = c.base.z + Math.sin(a) * r;
    c.gy = heightAt(c.tx, c.tz);
  }
  const dx = c.tx - c.obj.position.x;
  const dz = c.tz - c.obj.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.15) {
    const step = Math.min(d, c.speed * dt);
    c.obj.position.x += (dx / d) * step;
    c.obj.position.z += (dz / d) * step;
    let diff = Math.atan2(dz, -dx) - c.ry; // nose = local -X
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    c.ry += diff * Math.min(1, dt * 4);
    c.obj.rotation.y = c.ry;
  }
  const targetY = c.gy ?? c.base.y;
  c.cy = (c.cy ?? c.base.y) + (targetY - (c.cy ?? c.base.y)) * Math.min(1, dt * 2);
  c.obj.position.y = c.cy + Math.abs(Math.sin(time * 3 + c.phase)) * c.bob;
}

// Forest fireflies: a cloud of additive glowing points that drift and twinkle,
// scattered through the wooded biome near the road. Animation lives in the
// shader (position drift + twinkle) so the whole field is one cheap draw call.
function buildFireflies(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const positions = [];
  const phases = [];
  const want = 170; // 260 was crowded, 110 too sparse — a present-but-gentle middle
  let tries = 0;
  while (positions.length / 3 < want && tries < want * 8) {
    tries++;
    const i = Math.floor(rand() * N);
    const p = track._pts[i];
    if (biomeAt(p.x, p.z).name !== "forest") continue;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const dirS = rand() < 0.5 ? 1 : -1;
    const dist = track.halfWidth + 6 + rand() * 42;
    const x = p.x + side.x * dirS * dist + (rand() - 0.5) * 8;
    const z = p.z + side.z * dirS * dist + (rand() - 0.5) * 8;
    if (track.distanceToCenter(x, z) < track.halfWidth + 4) continue;
    if (_inLake(x, z)) continue;
    positions.push(x, heightAt(x, z) + 1.2 + rand() * 2.6, z);
    phases.push(rand() * 6.28);
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
  // TSL node material (WebGPU): green fireflies that drift (positionNode sway) and
  // twinkle (opacity), animated off the global `time`.
  const phase = attribute("aPhase");
  const sway = vec3(
    time.mul(0.6).add(phase).sin().mul(1.3),
    time.mul(0.9).add(phase.mul(1.7)).sin().mul(0.8),
    time.mul(0.5).add(phase.mul(1.3)).cos().mul(1.3)
  );
  const tw = time.mul(3).add(phase.mul(5)).sin().mul(0.5).add(0.5);
  const material = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  material.positionNode = positionLocal.add(sway);
  material.colorNode = tslColor(0xbfff73).mul(tw.add(0.6));
  material.opacityNode = tw;
  material.sizeNode = tw.mul(0.5).add(0.5).mul(3);
  material.uniforms = { uTime: { value: 0 } }; // dummy: keeps the existing uTime write a no-op
  material.userData.skipToon = true;
  const pts = new THREE.Points(geo, material);
  pts.frustumCulled = false; // points are displaced in the shader
  scene.add(pts);
  return { mesh: pts, material };
}

// A butterfly/moth or dragonfly drawn to a canvas — WHITE wings (so the
// per-instance tint fully colours them) with a small wing spot for shape, plus a
// dark thin body. Cached per kind.
let _flyerTex = {};
function flyerTexture(kind) {
  if (_flyerTex[kind]) return _flyerTex[kind];
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const ctx = c.getContext("2d");
  if (kind === "dragonfly") {
    ctx.fillStyle = "#ffffff";
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(24 + sx * 10, 18, 13, 3.5, sx * 0.4, 0, Math.PI * 2);
      ctx.ellipse(24 + sx * 10, 30, 12, 3, sx * -0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(23, 8, 2, 34);
  } else {
    // Two rounded wing pairs spread wide (an open-winged butterfly seen from
    // above), each with a soft darker spot so it reads as wings, not a blob.
    for (const sx of [-1, 1]) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(24 + sx * 10, 17, 10, 11, sx * 0.35, 0, Math.PI * 2);
      ctx.ellipse(24 + sx * 8, 31, 7, 8, sx * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.16)"; // faint wing marking
      ctx.beginPath();
      ctx.arc(24 + sx * 12, 17, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#33260f"; // slim warm-dark body
    ctx.fillRect(23, 12, 2, 23);
  }
  const tex = new THREE.CanvasTexture(c);
  return (_flyerTex[kind] = tex);
}

// Ambient flyers: butterflies over warm, vegetated verges by day; pale moths by
// night. The ENTIRE flight — a wandering loop, a bob, and a banking flutter (the
// sprite rocks back and forth via rotationNode, so the wings visibly flap) — runs
// in the vertex shader off `time`, so each field is ONE draw with zero per-frame
// CPU. Colour comes from a per-instance `aTint` attribute the shader multiplies
// into the white wing texture (the old instanceColor path rendered them black on
// the WebGPU sprite pipeline).
const FLYER_PALETTES = {
  meadow: [0xf5c542, 0xe8912b, 0xf0e0a0, 0xf07a3a],
  blossom: [0xff9fc0, 0xffd9e6, 0xffffff, 0xf0a0d0],
  autumn: [0xe0842a, 0xd0a53a, 0xc25a2a, 0xe8b050],
  savanna: [0xf0e0a0, 0xe8c060, 0xfff0c0, 0xf0b040],
  desert: [0xf0d090, 0xe8b060, 0xf5e0a0],
  forest: null, // gets dragonflies (cool palette), handled below
};
const DRAGONFLY_COLS = [0x66c2e8, 0x8fd6b0, 0x9fb6ff, 0x70d0d0];
function buildAmbientFlyers(scene, track, heightAt, litLevel) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const night = litLevel > 0.8;
  // Two fields so butterflies and (cooler, slimmer) dragonflies read distinctly
  // — still just 2 draws for the whole map. At night both become pale moths.
  const build = (kind) => {
    const isDragon = kind === "dragonfly";
    const bases = [];
    const tints = [];
    const want = night ? 55 : isDragon ? 70 : 130;
    let tries = 0;
    const _c = new THREE.Color();
    while (bases.length / 3 < want && tries < want * 9) {
      tries++;
      const i = Math.floor(rand() * N);
      const p = track._pts[i];
      const b = biomeAt(p.x, p.z);
      // Dragonflies hug the wet forest; butterflies take the other warm biomes.
      // Cold/snow biomes get neither.
      let pal;
      if (night) pal = [0xf2f2e6, 0xe8e8d8, 0xdedecf];
      else if (isDragon) pal = b.name === "forest" ? DRAGONFLY_COLS : null;
      else pal = FLYER_PALETTES[b.name];
      if (!pal) continue;
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const dirS = rand() < 0.5 ? 1 : -1;
      const dist = track.halfWidth + 4 + rand() * 34;
      const x = p.x + side.x * dirS * dist + (rand() - 0.5) * 8;
      const z = p.z + side.z * dirS * dist + (rand() - 0.5) * 8;
      if (track.distanceToCenter(x, z) < track.halfWidth + 3) continue;
      if (_inLake(x, z)) continue;
      bases.push(x, heightAt(x, z) + 0.9 + rand() * 2.3, z);
      _c.set(pal[(rand() * pal.length) | 0]);
      tints.push(_c.r, _c.g, _c.b);
    }
    if (!bases.length) return;
    const count = bases.length / 3;
    const geo = new THREE.PlaneGeometry(isDragon ? 1.2 : 0.85, isDragon ? 1.2 : 0.85);
    geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(new Float32Array(bases), 3));
    geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(tints), 3));
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const tex = texture(flyerTexture(kind), uv());
    // Colour = white-wing texture × per-instance tint; shape from the texture alpha.
    mat.colorNode = tex.mul(attribute("aTint"));
    mat.opacityNode = tex.a.mul(night ? 0.75 : 0.96);
    const b = attribute("aBase");
    const ph = hash(instanceIndex).mul(6.2832);
    const t = time.add(ph);
    // Lazy wandering loop + a slow bob + a quick vertical wingbeat flutter.
    const wander = vec3(
      t.mul(0.5).sin().mul(2.3).add(t.mul(1.3).sin().mul(0.5)),
      t.mul(1.7).sin().mul(0.34).add(t.mul(9.0).sin().mul(0.14)),
      t.mul(0.43).cos().mul(2.3).add(t.mul(1.1).cos().mul(0.5))
    );
    mat.positionNode = b.add(wander);
    // Bank/rock the whole sprite so the wings visibly flap and it never sits
    // stiffly upright — fast rock for butterflies, a quicker shimmer for dragonflies.
    mat.rotationNode = t.mul(isDragon ? 12 : 7).sin().mul(isDragon ? 0.3 : 0.5);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false; // billboards are displaced in the shader
    mesh.castShadow = false;
    mesh.renderOrder = 3;
    mesh.layers.set(1); // keep out of the rear-view mirror
    scene.add(mesh);
  };
  build("butterfly");
  build("dragonfly");
}

// A single grey pigeon (perched, wings foldable). Returns { group, wings }.
let _pigeonMats = null;
function makePigeon() {
  // One shared material set for every pigeon (they're all the same bird) — one
  // toon pipeline per part instead of five fresh materials per pigeon.
  if (!_pigeonMats) {
    _pigeonMats = {
      body: mat(0x9aa3ad), head: mat(0xb0b8c0), beak: mat(0xe0a52a),
      tail: mat(0x7e878f), wing: mat(0x868f98),
    };
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), _pigeonMats.body);
  body.scale.set(1, 0.9, 1.4);
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), _pigeonMats.head);
  head.position.set(0, 0.22, 0.34);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 5), _pigeonMats.beak);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.2, 0.5);
  g.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.4), _pigeonMats.tail);
  tail.position.set(0, 0.02, -0.42);
  g.add(tail);
  const wings = [];
  for (const sx of [-1, 1]) {
    const wg = new THREE.Group();
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), _pigeonMats.wing);
    wing.position.x = sx * 0.3;
    wg.add(wing);
    wg.position.set(sx * 0.1, 0.05, 0);
    g.add(wg);
    wings.push({ wg, sx, phase: rand() * 6.28 });
  }
  return { group: g, wings };
}

// A roadside loft with a flock of pigeons perched on its roof; they all burst
// into the air when the player drives close, then re-perch once you're well past.
function buildPigeons(scene, track, heightAt) {
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const flocks = [];
  // One loft on each half of the lap, so every race actually passes pigeons.
  const makeLoftAt = (tStart) => {
    // Find a roadside spot whose loft footprint clears the WHOLE track, so a fold
    // in the loop doesn't drop this building onto a different stretch of road.
    let bx, bz, px, pz;
    for (let attempt = 0; attempt < 10; attempt++) {
      const i = Math.floor(((tStart + attempt * 0.07) % 1) * N);
      const p = track._pts[i];
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
      const cx = p.x + side.x * outward * (track.halfWidth + 7.5);
      const cz = p.z + side.z * outward * (track.halfWidth + 7.5);
      if (attempt < 9 && track.distanceToCenter(cx, cz) < track.halfWidth + 5) continue;
      bx = cx;
      bz = cz;
      px = p.x; // road point the loft faces
      pz = p.z;
      break;
    }
    const by = heightAt(bx, bz);

    const loft = new THREE.Group();
    const wallH = 4;
    // In the city the pigeons perch on a flat-roofed brick building with a small
    // rooftop coop, instead of the rural cottage (a pitched-roof cottage looked
    // out of place downtown). wallH stays 4 so the birds' perch heights are the
    // same either way.
    if (biomeAt(bx, bz).name === "city") {
      const wall = pick(STORE_WALLS);
      const body = new THREE.Mesh(roundedColumn(5.5, wallH, 5, 0.4), mat(wall));
      body.position.y = wallH / 2;
      body.castShadow = true;
      loft.add(body);
      const parapet = new THREE.Mesh(new THREE.BoxGeometry(5.7, 0.5, 5.2), mat(0x39434f));
      parapet.position.y = wallH + 0.22;
      parapet.castShadow = true;
      loft.add(parapet);
      const store = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.9, 0.14), mat(0x2a3038)); // glass storefront
      store.position.set(0, 1.2, 5 / 2 + 0.02);
      loft.add(store);
      const awning = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.2, 1.0), mat(pick(STORE_ACCENT)));
      awning.position.set(0, 2.35, 5 / 2 + 0.4);
      awning.rotation.x = -0.2;
      loft.add(awning);
      // rooftop pigeon coop
      const coop = new THREE.Mesh(rbox(1.6, 1.0, 1.2, 0.14), mat(0x8a5a3a));
      coop.position.set(1.3, wallH + 0.9, -0.9);
      coop.castShadow = true;
      loft.add(coop);
      const coopRoof = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.16, 1.45), mat(0x5a3a22));
      coopRoof.position.set(1.3, wallH + 1.45, -0.9);
      loft.add(coopRoof);
    } else {
      const body = new THREE.Mesh(roundedColumn(5, wallH, 5, 0.6), mat(0xddc9a0));
      body.position.y = wallH / 2;
      body.castShadow = true;
      loft.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.4, 4), mat(0x9c5a3a));
      roof.rotation.y = Math.PI / 4;
      roof.position.y = wallH + 1.2;
      roof.castShadow = true;
      loft.add(roof);
    }
    loft.position.set(bx, by, bz);
    loft.rotation.y = Math.atan2(px - bx, pz - bz);
    loft.traverse((o) => o.layers.set(1));
    scene.add(loft);

    const flockGroup = new THREE.Group();
    flockGroup.position.set(bx, by, bz);
    scene.add(flockGroup);
    const birds = [];
    const n = 7;
    for (let k = 0; k < n; k++) {
      const pg = makePigeon();
      const home = new THREE.Vector3((k / (n - 1) - 0.5) * 4.2, wallH + 1.0 + rand() * 0.4, (rand() - 0.5) * 1.2);
      pg.group.position.copy(home);
      pg.group.rotation.y = (rand() - 0.5) * 1.2;
      pg.group.scale.setScalar(1.2); // a touch bigger so they read at race speed
      pg.group.traverse((o) => o.layers.set(1));
      flockGroup.add(pg.group);
      for (const w of pg.wings) w.wg.rotation.z = w.sx * 0.12; // folded, so the proxy bakes the perched pose
      birds.push({ group: pg.group, wings: pg.wings, home, homeRy: pg.group.rotation.y, vel: new THREE.Vector3(), phase: rand() * 6.28 });
    }
    // Sleep proxy: a flock is ~42 small meshes, but it perches motionless for
    // almost the whole race. Bake the perched pose into ONE merged mesh (one
    // draw per shared pigeon material) and show THAT by default; the live,
    // articulated birds only swap in when the player is close enough to see
    // them bob / scatter (see updatePigeons). Same pattern as the leaf piles.
    flockGroup.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(flockGroup.matrixWorld).invert();
    const rel = new THREE.Matrix4();
    const matOrder = [];
    const geosByMat = new Map();
    flockGroup.traverse((o) => {
      if (!o.isMesh) return;
      let g = o.geometry.clone();
      g.applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
      if (g.index) g = g.toNonIndexed();
      if (!geosByMat.has(o.material)) { geosByMat.set(o.material, []); matOrder.push(o.material); }
      geosByMat.get(o.material).push(g);
    });
    const perMat = matOrder.map((m) => mergeGeometries(geosByMat.get(m), false));
    const proxy = new THREE.Mesh(mergeGeometries(perMat, true), matOrder);
    proxy.castShadow = true; // stands in for the birds in the one-shot world shadow bake
    proxy.layers.set(1);
    proxy.position.copy(flockGroup.position);
    scene.add(proxy);
    flockGroup.visible = false; // live birds start asleep behind the proxy
    // The trigger must reach the road: the loft sits halfWidth+7.5 off the
    // CENTERLINE, so anything under that radius could never fire from a normal
    // racing line (the old value, 14, was why nobody ever saw them scatter).
    // halfWidth+24 covers the full road width in front of the loft.
    flocks.push({ center: new THREE.Vector3(bx, by, bz), triggerR: track.halfWidth + 24, scattered: false, timer: 0, birds, group: flockGroup, proxy, liveOn: false });
  };
  makeLoftAt(0.08);
  makeLoftAt(0.55);
  return flocks;
}

function updatePigeons(flock, dt, time, playerPos) {
  if (!flock.scattered) {
    // Perched flocks far from the player sleep as the merged proxy mesh — the
    // 4cm idle bob is invisible from distance, and the ~42 live meshes only
    // swap in close up (past the scatter trigger's reach, so the handoff is
    // never visible mid-burst). A scattered flock keeps its live birds until
    // it lands, wherever the player is.
    let near = true;
    if (playerPos) {
      const dx = playerPos.x - flock.center.x;
      const dz = playerPos.z - flock.center.z;
      near = dx * dx + dz * dz < 60 * 60;
    }
    if (near !== flock.liveOn) {
      flock.liveOn = near;
      flock.group.visible = near;
      flock.proxy.visible = !near;
    }
    if (!near) return;
    for (const b of flock.birds) {
      b.group.position.y = b.home.y + Math.sin(time * 2.2 + b.phase) * 0.04;
      for (const w of b.wings) w.wg.rotation.z = w.sx * 0.12; // wings folded
    }
    if (playerPos) {
      const dx = playerPos.x - flock.center.x;
      const dz = playerPos.z - flock.center.z;
      if (dx * dx + dz * dz < flock.triggerR * flock.triggerR) {
        flock.scattered = true;
        flock.timer = 0;
        for (const b of flock.birds) {
          const a = Math.random() * Math.PI * 2;
          b.vel.set(Math.cos(a) * (5 + Math.random() * 5), 8 + Math.random() * 4, Math.sin(a) * (5 + Math.random() * 5));
        }
      }
    }
  } else {
    flock.timer += dt;
    for (const b of flock.birds) {
      b.group.position.addScaledVector(b.vel, dt);
      b.vel.y = Math.max(b.vel.y - 5 * dt, 2.5); // arc up, then keep climbing away
      for (const w of b.wings) w.wg.rotation.z = w.sx * (0.3 + Math.sin(time * 24 + b.phase) * 0.8);
      b.group.rotation.y = Math.atan2(b.vel.x, b.vel.z);
    }
    if (flock.timer > 4 && playerPos) {
      const dx = playerPos.x - flock.center.x;
      const dz = playerPos.z - flock.center.z;
      if (dx * dx + dz * dz > 80 * 80) {
        flock.scattered = false;
        for (const b of flock.birds) {
          b.group.position.copy(b.home);
          b.group.rotation.set(0, b.homeRy, 0);
          b.vel.set(0, 0, 0);
        }
      }
    }
  }
}

// One hot-air balloon: a plump teardrop envelope with alternating vertical
// gores, a skirt at the throat, suspension ropes and a two-tone wicker basket.
// `paletteIndex` picks the main gore colour. Shared by buildBalloons (the
// drifting fleet) and the asset viewer.
const BALLOON_MAINS = [0xe64a3c, 0x2f8fdd, 0xf2b53a, 0x9c4fc4, 0x4caf50, 0xff8a3c];
let _balloonShared = null;
function makeBalloon(paletteIndex = 0) {
  if (!_balloonShared) {
    _balloonShared = {
      cream: new THREE.Color(0xfff3dc),
      // Envelope profile, throat lip -> plump belly -> rounded crown.
      prof: [
        [2.6, 0], [4.4, 1.5], [6.6, 4.0], [7.8, 7.2], [8.0, 9.6],
        [7.3, 12.3], [5.4, 14.5], [2.8, 15.8], [0.01, 16.4],
      ].map(([r, y]) => new THREE.Vector2(r, y)),
      skirtMat: new THREE.MeshStandardMaterial({ color: 0x54432e, roughness: 0.9, side: THREE.DoubleSide }),
      ropeMat: new THREE.MeshStandardMaterial({ color: 0x6e5a40, roughness: 0.85 }),
      wickMat: new THREE.MeshStandardMaterial({ color: 0x9a7440, roughness: 0.95 }),
      wickRimMat: new THREE.MeshStandardMaterial({ color: 0x77552c, roughness: 0.95 }),
      envMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), // colours live in the vertices — one material serves the whole fleet
    };
  }
  const S = _balloonShared;
  const g = new THREE.Group();
  const main = new THREE.Color(BALLOON_MAINS[paletteIndex % BALLOON_MAINS.length]);
  // Crisp gores need per-face colour: un-index the lathe and paint each
  // triangle by its centroid's longitude — 8 panels alternating main/cream.
  const geo = new THREE.LatheGeometry(S.prof, 16).toNonIndexed();
  const pos = geo.getAttribute("position");
  const colAttr = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3);
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    const panel = Math.floor((Math.atan2(cz, cx) / (Math.PI * 2) + 1) * 8);
    const c = panel % 2 === 0 ? main : S.cream;
    colAttr.setXYZ(f, c.r, c.g, c.b);
    colAttr.setXYZ(f + 1, c.r, c.g, c.b);
    colAttr.setXYZ(f + 2, c.r, c.g, c.b);
  }
  geo.setAttribute("color", colAttr);
  const envelope = new THREE.Mesh(geo, S.envMat);
  envelope.position.y = 5.2;
  g.add(envelope);

  // The rigid rig under the envelope — skirt, four ropes, wicker basket with
  // a darker woven rim — bakes into one merged mesh (one draw per material).
  const parts = [];
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 1.7, 1.5, 10, 1, true), S.skirtMat);
  skirt.position.y = 4.55;
  parts.push(skirt);
  const basket = new THREE.Mesh(rbox(3.2, 2.4, 3.2, 0.35), S.wickMat);
  basket.position.y = 1.2;
  parts.push(basket);
  const rim = new THREE.Mesh(rbox(3.5, 0.55, 3.5, 0.2), S.wickRimMat);
  rim.position.y = 2.5;
  parts.push(rim);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = new THREE.Vector3(sx * 1.35, 2.6, sz * 1.35); // rim corner
    const b = new THREE.Vector3(sx * 1.84, 5.35, sz * 1.84); // throat lip
    const dir = b.clone().sub(a);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, dir.length(), 5), S.ropeMat);
    rope.position.copy(a).addScaledVector(dir, 0.5);
    rope.quaternion.setFromUnitVectors(UP_Y, dir.normalize());
    parts.push(rope);
  }
  g.add(mergeMeshes(parts));
  return g;
}

function buildBalloons(scene, heightAt) {
  const balloons = [];
  for (let i = 0; i < 6; i++) {
    const g = makeBalloon(i);
    const a = rand() * Math.PI * 2;
    const r = 150 + rand() * 300;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    g.position.set(x, 0, z);
    scene.add(g);
    // Float above the terrain beneath them, so they clear the high snowy hill.
    const ground = heightAt ? heightAt(x, z) : 0;
    balloons.push({ mesh: g, baseY: ground + 75 + rand() * 45, phase: rand() * 6.28 });
  }
  return balloons;
}

// ===========================================================================
//  Catalog-only makers — art that exists in the world only as instanced/merged
//  buffers (no per-item group to borrow), rebuilt here as one representative
//  item from the SAME geometry dimensions and material recipes as the builders
//  above. If a builder's art changes, change its maker here to match.
// ===========================================================================

// One street lamp (buildStreetLamps instances post/head/bulb across the map).
function makeStreetLampAsset(lit = true) {
  const POST_H = 9;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.7, metalness: 0.3 });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff0c8, emissive: 0xffd98a, emissiveIntensity: lit ? 2.4 : 0.0, roughness: 0.4,
  });
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, POST_H, 7), postMat);
  post.position.y = POST_H / 2;
  g.add(post);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.55, 0.7, 8), postMat);
  head.position.set(0, POST_H + 0.1, 1); // juts toward the road
  g.add(head);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), bulbMat);
  bulb.position.set(0, POST_H - 0.35, 1);
  g.add(bulb);
  return g;
}

// One sky bird in its gliding pose, assembled from the exact geometry the
// flocks instance (see skyBirdGeos/buildBirds). `color` picks the species —
// default raven black; pass e.g. 0xe8ecf0 for a gull, 0xb8a8c8 for a dove.
function makeSkyBirdAsset(color = SKY_BIRD_COLOR) {
  const { wingGeo, bodyGeo } = skyBirdGeos();
  const material = skyBirdMaterial(color);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(bodyGeo, material));
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeo, material);
    wing.position.z = sx * 0.22;
    wing.scale.z = sx; // mirror the left wing
    wing.rotation.x = -sx * 0.25; // gliding V
    g.add(wing);
  }
  return g;
}

// One cloud (scene.js merges 16 of these clusters into a single ring mesh
// high above the map — the exact same cloudClusterGeo builds both).
function makeCloudAsset() {
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(cloudClusterGeo(), cloudMat));
  return g;
}

// One festive string-light span (buildStringLights hangs these over the road
// as an instanced bulb mesh + swinging line; this is a static short garland).
function makeStringLightsAsset() {
  const COLS = [0xff3b30, 0xffd60a, 0x34c759, 0x0a84ff, 0xff9f0a, 0xffffff];
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3829, roughness: 0.92 });
  const span = 16, topY = 8.5, sag = 3.0, per = 12;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, topY + 0.3, 8), postMat);
    post.position.set(sx * span * 0.5, (topY + 0.3) / 2, 0);
    g.add(post);
  }
  const wirePts = [];
  const bulbGeo = new THREE.SphereGeometry(0.34, 8, 8);
  for (let k = 0; k <= per; k++) {
    const t = k / per;
    const x = -span * 0.5 + span * t;
    const y = topY - Math.sin(t * Math.PI) * sag;
    wirePts.push(new THREE.Vector3(x, y, 0));
    if (k > 0 && k < per) {
      const bulbMat = new THREE.MeshBasicMaterial({ color: COLS[k % COLS.length], toneMapped: false, fog: false });
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(x, y - 0.3, 0);
      g.add(bulb);
    }
  }
  const wire = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(wirePts),
    new THREE.LineBasicMaterial({ color: 0x2a2622, transparent: true, opacity: 0.7 })
  );
  g.add(wire);
  return g;
}

// ===========================================================================
//  Asset catalog — the dev asset viewer's window into this module
// ===========================================================================
// Every procedural set piece above is module-private (the game only ever wants
// whole worlds), but the asset viewer (viewer.html) needs to build ONE of each
// to inspect. This registry wraps the makers with representative default args.
// Entries are { group, name, build } where build() returns a fresh Object3D;
// nothing here runs unless the viewer calls it, so the game pays zero cost.
export function assetCatalog() {
  const biome = (name) => BIOMES.find((b) => b.name === name) || BIOMES[0];
  const entries = [];
  const add = (group, name, build) => entries.push({ group, name, build });

  // Trees per biome silhouette (round/pine/acacia/blossom — the distinct shapes).
  for (const bn of ["meadow", "forest", "autumn", "blossom", "savanna", "desert"])
    add("Trees & plants", `Tree — ${bn}`, () => makeTree(biome(bn)));
  add("Trees & plants", "Bush", () => makeBush());
  add("Trees & plants", "Cactus", () => makeCactusProp());
  add("Trees & plants", "Rock", () => makeRockProp());

  add("Animals", "Cow", () => makeCow());
  add("Animals", "Sheep", () => makeSheep());
  add("Animals", "Deer", () => makeDeer());
  add("Animals", "Goat", () => makeGoat());
  add("Animals", "Crab", () => makeCrab());
  add("Animals", "Gull", () => makeGull());
  add("Animals", "Pigeon", () => makePigeon().group); // returns { group, wings }
  add("Animals", "Duck", () => makeDuck());
  add("Animals", "Sky bird", () => makeSkyBirdAsset());

  add("Town & farm", "House", () => makeHouse());
  add("Town & farm", "Building — village", () => makeBuilding(0.4, biome("meadow")));
  add("Town & farm", "Building — snowy", () => makeBuilding(0.4, biome("alpine")));
  add("Town & farm", "Church", () => makeChurch());
  add("Town & farm", "Barn", () => makeBarn());
  add("Town & farm", "Windmill", () => makeWindmill());
  add("Town & farm", "Silo", () => makeSilo());
  add("Town & farm", "Water tower", () => makeWaterTower());
  add("Town & farm", "Hay bale", () => makeHayBale());
  add("Town & farm", "Fence", () => makeFence(0xfafafa));
  add("Town & farm", "Flag", () => makeFlag(3));

  add("City & street", "Tower", () => makeTower(0.8));
  add("City & street", "City store", () => makeCityStore());
  add("City & street", "Market stall", () => makeMarketStall());
  add("City & street", "Planter", () => makePlanter());
  add("City & street", "Bench", () => makeBench());
  add("City & street", "Hydrant", () => makeHydrant());
  add("City & street", "Sign", () => makeSign());
  add("City & street", "Lamp", () => makeLamp());
  add("City & street", "Street lamp", () => makeStreetLampAsset());
  add("City & street", "Traffic light", () => makeTrafficLight());
  add("City & street", "String lights", () => makeStringLightsAsset());
  add("City & street", "Billboard", () => makeBillboard(BILLBOARD_SIGNS[0], true));
  add("City & street", "Parasol", () => makeParasol());

  add("Sky & transit", "Cloud", () => makeCloudAsset());
  add("Sky & transit", "Hot-air balloon", () => makeBalloon(0));
  add("Sky & transit", "Sky train", () => makeTrain());
  add("Sky & transit", "Wind turbine", () => makeWindTurbine().group);

  add("Landmarks", "Lighthouse", () => makeLighthouse());
  add("Landmarks", "Castle", () => makeCastle());
  add("Landmarks", "Ferris wheel", () => makeFerrisWheel());
  add("Landmarks", "Giant cat statue", () => makeGiantCat());
  add("Landmarks", "Big windmill", () => makeBigWindmill());

  return entries;
}
