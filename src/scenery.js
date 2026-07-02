import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { attribute, color as tslColor, mix, smoothstep, float, time, positionLocal, vec3, normalView, positionViewDirection, hash, instanceIndex, uniform } from "three/tsl";
import { rand } from "./rng.js"; // seeded RNG so the world is identical per seed
import { makeLeafGeo } from "./props.js"; // shared leaf silhouette (used by piles + ground scatter)
import { mergeMeshes } from "./models.js"; // bake rigid sub-assemblies (animals) into one mesh

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
  // Cherry-blossom spring: fresh green ground under candy-pink canopies.
  { name: "blossom", weather: "none", ground: 0x6fae4a, ground2: 0x5a9440, foliage: [0.92, 0.6, 0.82], style: "cone", treeShape: "blossom", sx: 1.05, sy: 1.05, treeDensity: 0.8, grassTint: 0xd6f0a8, grassDensity: 0.95, barrier: { a: 0xffd9e6, b: 0xff9fc0 } },
  // Dry golden savanna: tawny earth, sparse wide acacia trees, pale grass.
  { name: "savanna", weather: "none", ground: 0xb89a4e, ground2: 0xa07f3a, foliage: [0.13, 0.45, 0.4], style: "cone", treeShape: "acacia", sx: 1.25, sy: 0.85, treeDensity: 0.35, grassTint: 0xd8c070, grassDensity: 0.5, barrier: { a: 0xc9a86a, b: 0x8a6a3a } },
  // Frosted tundra: pale sage ground, short blue-green pines, light snow.
  { name: "tundra", weather: "snow", ground: 0x9fb0a4, ground2: 0x84988e, foliage: [0.38, 0.32, 0.42], style: "pine", treeShape: "pine", sx: 0.75, sy: 1.2, treeDensity: 0.6, grassTint: 0xc8d8c0, grassDensity: 0.3, barrier: { a: 0xdfeaf0, b: 0x9fb8c0 } },
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
  // per seed (classic keeps its hand-authored fixed order).
  if (_altMode) {
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

// Roadside-barrier colours for the biome at a position (used by the track).
export function biomeBarrierStyle(x, z) {
  return biomeAt(x, z).barrier;
}

// Precipitation the biome at a position brings ("none" / "rain" / "snow").
export function biomeWeatherAt(x, z) {
  return biomeAt(x, z).weather;
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
  blossom: { tint: [1.04, 0.97, 1.02], kind: "asphalt" },
  savanna: { tint: [1.45, 1.28, 0.95], kind: "sand" },
  tundra: { tint: [1.25, 1.32, 1.4], kind: "snow" },
};
export function biomeRoadStyle(x, z) {
  return ROAD_STYLES[biomeAt(x, z).name] || ROAD_STYLES.meadow;
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
    const gi = track.groundInfo(x, z);
    const rise = isOutside(x, z) ? valleyRise(gi.dist) : 0;
    return gi.y - 0.25 + rise + flatten(gi.dist) * detail(x, z);
  };

  // Lakes: a big one in the open infield (the loop wraps right around it) plus a
  // couple of smaller ones out on the hills. Their level matches the ground.
  const lakes = makeLakes(track, baseHeight);
  // Clear props out to the full carve (the shore bank), not just the waterline,
  // so nothing sits on the slope between the road and the lake.
  _inLake = (x, z) => lakes.some((L) => lakeDist(L, x, z) < L.blendR);

  const heightAt = (x, z) => carveLakes(lakes, x, z, baseHeight(x, z));

  buildTerrain(scene, heightAt, litLevel); // night/dusk darkening (snow handled hard inside)
  buildMountains(scene, heightAt, track);
  buildTrees(scene, track, heightAt, flatten);
  const groundLeaves = buildGroundLeaves(scene, track, heightAt); // loose scattered leaves (leafy biomes feel carpeted; kick up in a kart's wake)
  buildBlossomPetals(scene, track, heightAt); // GPU-animated cherry petals drifting down over blossom sectors (no per-frame CPU)
  buildForests(scene, track, heightAt); // dense woods hugging the road in forest/alpine
  buildRocks(scene, track, heightAt, flatten);
  buildCliffs(scene, track, heightAt); // a rocky cliff stretch to drive against
  buildRoadside(scene, track, heightAt); // town & farm zones lining the road
  batchBuildings(scene); // merge the hundreds of static buildings into a few meshes (draw-call slasher)
  batchStaticProps(scene); // same treatment for benches/fences/bushes/stalls etc.
  buildStreetLamps(scene, track, heightAt, lit, litLevel); // roadside lamps (on at dusk/night)
  const stringLights = buildStringLights(scene, track, litLevel, heightAt); // festive bulb strings (swing + glow)
  buildOverheadStructures(scene, track, heightAt, lit, litLevel); // banners + wooden footbridges spanning the road
  buildLandmarks(scene, track, heightAt); // hero structures around the horizon
  const waters = buildWater(scene, lakes, 1 - litLevel * 0.6); // dimmer water at dusk/night
  const grass = buildGrass(scene, track, heightAt);
  const balloons = buildBalloons(scene, heightAt);
  const birds = buildBirds(scene);
  const fireflies = buildFireflies(scene, track, heightAt);
  const pigeonFlocks = buildPigeons(scene, track, heightAt);

  return {
    grass,
    heightAt, // terrain height sampler (incl. road carve) — props use it so piles sit on the ground
    groundLeaves, // { update(karts, camPos) } | null — drives the kart-wake leaf pop
    stringLights, // { update(dt, karts) } — driven from main.js with live kart data
    update(time, dt = 0.016, playerPos = null) {
      for (const b of balloons) {
        b.mesh.position.y = b.baseY + Math.sin(time * 0.5 + b.phase) * 4;
        b.mesh.rotation.y = time * 0.1 + b.phase;
      }
      for (const s of _spinners) s.obj.rotation[s.ax] = time * s.speed + s.phase;
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
      const sh = grass && grass.material.userData.shader;
      if (sh) sh.uniforms.uTime.value = time;
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
    // fold this fails, so we skip it rather than spill water onto the track.
    if (minDist > waterR + track.halfWidth + 5) {
      lakes.push({
        ribbon: true, spine, level: minY - 2,
        floor: minY - 2 - 8,
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
    lakes.push({
      x, z, level,
      floor: level - (6 + rand() * 3),
      waterR, shoreR, blendR,
    });
    placedHill++;
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
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, side: THREE.DoubleSide });
  const shore = attribute("aShore");
  const len = attribute("aLen");
  const deep = tslColor(0x1f6f8c).mul(darken);
  const shallow = tslColor(0x57c6d6).mul(darken);
  const foamCol = tslColor(0xeafcff).mul(0.4 + 0.6 * darken);
  const w1 = len.mul(40).add(shore.mul(8)).add(time.mul(1.4)).sin();
  const w2 = len.mul(26).sub(shore.mul(5)).sub(time.mul(1.0)).sin();
  const ripple = smoothstep(0.55, 0.95, w1.mul(0.5).add(0.5)).mul(0.6)
    .add(smoothstep(0.65, 0.98, w2.mul(0.5).add(0.5)).mul(0.4));
  let col = mix(deep, shallow, smoothstep(0.0, 1.0, shore));
  col = mix(col, col.mul(1.18), ripple.mul(0.5));
  col = mix(col, foamCol, smoothstep(0.84, 0.995, shore));
  mat.colorNode = col;
  // Fresnel: water mirrors much more at grazing angles (looking across it) than
  // looking straight down — the key to a realistic reflective surface. Drive the
  // SSR metalness with it. Foam fringe stays matte so the bank doesn't mirror.
  const fres = normalView.dot(positionViewDirection).clamp(0, 1).oneMinus().pow(3);
  const shoreFade = smoothstep(0.9, 0.7, shore);
  mat.metalnessNode = float(0.35).add(fres.mul(0.55)).mul(shoreFade);
  mat.roughnessNode = float(0.05).add(ripple.mul(0.2)); // ripples shimmer the reflection
  mat.opacityNode = float(0.92);
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
  const pos = [], shore = [], lenA = [], idx = [];
  for (let j = 0; j < n; j++) {
    const s = sp[j], u = j / (n - 1);
    pos.push(s.x - s.sx * half, 0, s.z - s.sz * half); shore.push(1); lenA.push(u);
    pos.push(s.x, 0, s.z); shore.push(0); lenA.push(u);
    pos.push(s.x + s.sx * half, 0, s.z + s.sz * half); shore.push(1); lenA.push(u);
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
    const SEG = 8, start = c + 1;
    for (let k = 0; k <= SEG; k++) {
      const ang = (k / SEG) * Math.PI - Math.PI / 2;
      const dx = Math.cos(ang) * tx + Math.sin(ang) * s.sx;
      const dz = Math.cos(ang) * tz + Math.sin(ang) * s.sz;
      pos.push(s.x + dx * half, 0, s.z + dz * half); shore.push(1); lenA.push(end === 0 ? 0 : 1);
    }
    for (let k = 0; k < SEG; k++) idx.push(c, start + k, start + k + 1);
  };
  cap(0, 1);
  cap(n - 1, n - 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aShore", new THREE.Float32BufferAttribute(shore, 1));
  geo.setAttribute("aLen", new THREE.Float32BufferAttribute(lenA, 1));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = L.level + 0.05; // spine positions are already world x/z
  return mesh;
}

// Instanced grass blades along the roadside, swaying in the wind.
function buildGrass(scene, track, heightAt) {
  const COUNT = 6000;
  const halfW = track.halfWidth;
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);

  const blade = new THREE.PlaneGeometry(0.18, 1.0, 1, 1);
  blade.translate(0, 0.5, 0); // pivot at the base
  // base darker, tip lighter green
  const cols = [];
  const lo = new THREE.Color(0x2f7d32);
  const hi = new THREE.Color(0x86c560);
  const p = blade.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const c = lo.clone().lerp(hi, p.getY(i));
    cols.push(c.r, c.g, c.b);
  }
  blade.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 1,
  });
  mat.userData.skipToon = true; // keep the wind vertex shader
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    // View-space sun direction + colour, updated each frame, for a backlit glow
    // so the meadow lights up when the sun is behind it (atmospheric warmth).
    shader.uniforms.uSunView = { value: new THREE.Vector3(0, 0, 1) };
    shader.uniforms.uSunCol = { value: new THREE.Color(0xffe6b0) };
    shader.vertexShader = "uniform float uTime;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       float ph = instanceMatrix[3][0] * 0.15 + instanceMatrix[3][2] * 0.15;
       transformed.x += sin(uTime * 1.6 + ph) * 0.18 * position.y;
       transformed.z += cos(uTime * 1.3 + ph) * 0.10 * position.y;`
    );
    shader.fragmentShader =
      "uniform vec3 uSunView;\nuniform vec3 uSunCol;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
       // Looking toward the sun through the blade -> warm translucent glow,
       // strongest near the (lighter) tips.
       float backlit = pow(max(dot(normalize(vViewPosition), uSunView), 0.0), 3.0);
       gl_FragColor.rgb += uSunCol * backlit * (0.35 + 0.65 * vColor.g);`
    );
    mat.userData.shader = shader;
  };

  const mesh = new THREE.InstancedMesh(blade, mat, COUNT);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let n = 0;
  let tries = 0;
  while (n < COUNT && tries < COUNT * 4) {
    tries++;
    const i = Math.floor(rand() * N);
    const pt = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const dir = rand() < 0.5 ? 1 : -1;
    const dist = halfW + 2.5 + rand() * 34;
    const x = pt.x + side.x * dir * dist + (rand() - 0.5) * 3;
    const z = pt.z + side.z * dir * dist + (rand() - 0.5) * 3;
    if (track.distanceToCenter(x, z) < halfW + 2) continue;
    if (_inLake(x, z)) continue;
    const biome = biomeAt(x, z);
    if (rand() > biome.grassDensity) continue; // sparse in dry biomes
    dummy.position.set(x, heightAt(x, z), z);
    dummy.rotation.set((rand() - 0.5) * 0.3, rand() * Math.PI, (rand() - 0.5) * 0.3);
    dummy.scale.setScalar(0.7 + rand() * 1.1);
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    mesh.setColorAt(n, tint.set(biome.grassTint)); // tints the blade gradient
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.layers.set(2); // own layer: out of the mirror AND the outline pass
  scene.add(mesh);
  return mesh;
}

function buildTerrain(scene, heightAt, litLevel = 0) {
  // General ground only dims a LITTLE at night (so the scene stays as bright as it
  // was before) — but snow is darkened HARD, because near-white snow reflects the
  // moonlight far more than anything else and is what reads "self-lit".
  const groundDarken = 1 - litLevel * 0.15; // ~0.85 at night
  const SIZE = 1900;
  const SEG = 280;
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

function buildMountains(scene, heightAt, track) {
  const rockN = new THREE.MeshStandardMaterial({ color: 0x6d6253, roughness: 1 });
  const rockDesert = new THREE.MeshStandardMaterial({ color: 0xb07a4a, roughness: 1 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 1 });

  // Peaks never move — collect every cone and bake the lot into ONE
  // multi-material mesh at the end (~50 draw calls → 1). The ring surrounds the
  // camera so half of it is in view from anywhere; per-peak frustum culling
  // bought little, and the whole ring is only a few thousand triangles.
  const peakMeshes = [];
  const peak = (x, z, h, rad, bury) => {
    const desert = biomeAt(x, z).name === "desert";
    const base = heightAt(x, z) + h / 2 - bury;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 18), desert ? rockDesert : rockN);
    m.position.set(x, base, z);
    m.rotation.y = rand() * Math.PI;
    peakMeshes.push(m);
    // No snow caps in the desert — snowy peaks behind cacti look wrong.
    if (!desert) {
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.4, h * 0.3, 18), snow);
      cap.position.set(x, base + h * 0.5 - h * 0.15, z);
      cap.rotation.y = m.rotation.y;
      peakMeshes.push(cap);
    }
  };

  // Distant mountain ring around the whole world. Pushed out far enough that even
  // a max-size, max-curviness loop (which can reach ~900 units out) stays well
  // inside it, so a ring peak never lands on the track.
  const count = 24;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.2;
    const r = 1080 + rand() * 180;
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
        const rad = 50 + rand() * 22;
        const x = p.x + side.x * outward * off;
        const z = p.z + side.z * outward * off;
        // Need the road's nearest approach to clear the cone's base radius.
        if (track.distanceToCenter(x, z) < track.halfWidth + rad + 12) continue;
        peak(x, z, 120 + rand() * 50, rad, 22);
        break;
      }
    }
  }
  if (peakMeshes.length) {
    const merged = mergeMeshes(peakMeshes, { castShadow: false });
    merged.receiveShadow = false;
    merged.frustumCulled = false; // the ring surrounds every viewpoint anyway
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
  const CHUNK = 130;
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
  // Gentle drift + flutter. Geo is baked flat with yaw-only instances, so a local
  // +Y offset is world-up (same trick as the ground leaves).
  const _t = time.mul(1.4).add(_ph);
  const _drift = vec3(_t.sin().mul(0.9), 0, _t.mul(0.8).cos().mul(0.9));
  const _flut = vec3(0, _t.mul(2.3).sin().mul(cfg.tumble), 0);
  mat.positionNode = positionLocal.add(vec3(0, 1, 0).mul(_fall.add(0.6))).add(_drift).add(_flut);

  const CHUNK = 130;
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

function buildTrees(scene, track, heightAt, flatten) {
  // Each candidate spot is tagged with its biome, kept with that biome's tree
  // density, then bucketed by tree style (cone-shaped trees vs desert cacti).
  const spots = scatter(340, track, flatten, 0.55, 1700)
    .filter((s) => !_inLake(s.x, s.z)) // keep forests out of the water
    .map((s) => ({ ...s, y: heightAt(s.x, s.z), b: biomeAt(s.x, s.z) }))
    .filter((s) => s.y <= 30 && rand() < s.b.treeDensity);

  const leafy = spots.filter((s) => s.b.treeShape !== "cactus");
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
  } else {
    // round (deciduous): a single faceted lollipop crown.
    g = new THREE.IcosahedronGeometry(2.3, 1).scale(1, 0.95, 1).translate(0, 2.15, 0);
  }
  _foliageGeoCache[shape] = g;
  return g;
}

// How much taller/shorter the (shared) trunk stretches per shape, so acacias get a
// long bare trunk under their umbrella while the rest keep stocky trunks.
const TRUNK_HMUL = { round: 1.0, pine: 0.9, acacia: 1.85, blossom: 0.95 };

// Biome-diverse trees. One shared brown trunk InstancedMesh for the whole batch,
// plus ONE foliage InstancedMesh per distinct canopy shape present (round / pine /
// acacia / blossom) — each shape its own silhouette, recoloured per-instance from
// the biome's foliage HSL. Draw calls stay tiny: 1 trunk + ≤4 canopy meshes.
function buildShapedTrees(scene, spots, scaleMul = 1) {
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 3, 6); // baked base at y=0..3
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  foliageMat.userData.backlight = true; // glow when backlit by the sun (set in toonify)

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

  // One foliage mesh per shape.
  for (const [shape, arr] of byShape) {
    const foliage = new THREE.InstancedMesh(foliageGeoFor(shape), foliageMat, arr.length);
    foliage.castShadow = true;
    foliage.layers.set(1);
    arr.forEach((spot, i) => {
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

  // Soft halos around each bulb.
  const haloMat = new THREE.SpriteMaterial({
    map: tex, color: 0xffe6b0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85 * level,
  });
  for (const sp of spots) {
    const halo = new THREE.Sprite(haloMat);
    halo.position.set(sp.x + sp.ax, sp.y + POST_H - 0.35, sp.z + sp.az);
    halo.scale.setScalar(7);
    halo.layers.set(1);
    scene.add(halo);
  }
}

// Festive bulb strings strung in a catenary over a few road spans. The bulbs are
// bright un-tonemapped colours, so bloom makes them twinkle/glow at night while
// still reading as little fairy lights by day. One instanced mesh for all bulbs.
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
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const off = track.halfWidth + 4;
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

// Printed street-banner faces: a bold event banner (border, checkered-flag end
// caps, a slogan with paw accents), one design per index. Cached per design.
const BANNER_DESIGNS = [
  { bg: "#d23b34", fg: "#fff7e6", text: "ZOOMIES GP" },
  { bg: "#2f6fb0", fg: "#ffffff", text: "CAT KART CUP" },
  { bg: "#3a9d4e", fg: "#fffceb", text: "WELCOME RACERS" },
  { bg: "#e0a73a", fg: "#3a2410", text: "FURBALL DERBY" },
];
const _bannerTexCache = new Map();
function makeBannerTexture(i) {
  if (_bannerTexCache.has(i)) return _bannerTexCache.get(i);
  const d = BANNER_DESIGNS[i % BANNER_DESIGNS.length];
  const W = 1024, H = 192;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = d.bg; ctx.fillRect(0, 0, W, H);
  // Inner border frame.
  ctx.strokeStyle = d.fg; ctx.lineWidth = 9;
  ctx.strokeRect(14, 14, W - 28, H - 28);
  // Checkered-flag caps at each end (two columns, inset within the frame).
  const sq = 21, cols = 2, top = 26, rows = Math.floor((H - 52) / sq);
  for (const x0 of [26, W - 26 - sq * cols]) {
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        ctx.fillStyle = (r + cc) % 2 ? "#15110d" : "#f3f0e6";
        ctx.fillRect(x0 + cc * sq, top + r * sq, sq, sq);
      }
    }
  }
  // Slogan with paw accents, centred. Auto-shrink so long slogans stay clear of
  // the checkered caps instead of colliding with them.
  ctx.fillStyle = d.fg;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const label = `🐾  ${d.text}  🐾`;
  let fs = 96;
  ctx.font = `bold ${fs}px system-ui, Arial, sans-serif`;
  while (fs > 44 && ctx.measureText(label).width > W - 200) {
    fs -= 4; ctx.font = `bold ${fs}px system-ui, Arial, sans-serif`;
  }
  ctx.fillText(label, W / 2, H / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _bannerTexCache.set(i, t);
  return t;
}

// One street banner: two ground poles, a top + bottom bar holding a taut printed
// banner between them (with a gentle billow), spanning across the road.
function addStreetBanner(scene, track, heightAt, p, sx, sz, yaw, poleMat, barMat, texIndex) {
  const off = track.halfWidth + 3;
  const topY = p.y + 9.6, botY = p.y + 6.2;        // banner band clears the karts below
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
  // The taut banner: a segmented plane with a gentle billow baked in.
  const geo = new THREE.PlaneGeometry(bannerW, bannerH, 24, 1);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    pos.setZ(v, Math.sin((x / bannerW) * Math.PI * 3) * 0.22); // bow in/out across the width
  }
  geo.computeVertexNormals();
  const banner = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: makeBannerTexture(texIndex), roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  );
  banner.position.set(p.x, midY, p.z);
  // Face the readable side at oncoming traffic: the plane's front (+Z) sits along
  // the tangent (the way you drive), so without the flip you'd approach its BACK
  // and read the text mirrored. +π turns the readable face toward the racers.
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

  // --- Printed street banners (2) ---
  [0.2 + rand() * 0.1, 0.66 + rand() * 0.1].forEach((frac, bi) => {
    const { p, sx, sz, yaw } = spanAt(frac);
    addStreetBanner(scene, track, heightAt, p, sx, sz, yaw, poleMat, barMat, bi + ((rand() * BANNER_DESIGNS.length) | 0));
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
  for (let i = 0; i < N; i += 2) {
    const p = track._pts[i];
    const here = biomeAt(p.x, p.z);
    if (here.style !== "pine") continue; // forest + alpine get dense woods
    const reps = here.name === "forest" ? 6 : 3;
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    for (let r = 0; r < reps; r++) {
      const dir = rand() < 0.5 ? 1 : -1;
      const dist = halfW + 5 + rand() * 115;
      const x = p.x + side.x * dir * dist + (rand() - 0.5) * 9;
      const z = p.z + side.z * dir * dist + (rand() - 0.5) * 9;
      if (track.distanceToCenter(x, z) < halfW + 4) continue;
      if (_inLake(x, z)) continue;
      const b = biomeAt(x, z);
      if (b.style !== "pine") continue;
      spots.push({ x, z, y: heightAt(x, z), b });
    }
  }
  if (spots.length) buildShapedTrees(scene, spots, 1.45); // taller, fuller forest trees
}

// A craggy cliff face to drive alongside: rows of big rock chunks stacked up
// the outer hillside over one stretch of track.
function buildCliffs(scene, track, heightAt) {
  const up = new THREE.Vector3(0, 1, 0);
  const ranges = [[0.55, 0.67]]; // one cliff stretch on the outer side
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const col = new THREE.Color();
  const chunks = [];
  for (const [t0, t1] of ranges) {
    const i0 = Math.floor(t0 * track.samples);
    const i1 = Math.floor(t1 * track.samples);
    for (let i = i0; i <= i1; i += 2) {
      const p = track._pts[i];
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
      for (let row = 0; row < 3; row++) {
        // Keep the base row well clear of the tarmac (chunks are ~sx wide, so
        // start far enough out that they don't spill onto the road).
        const off = track.halfWidth + 15 + row * 8 + rand() * 3;
        const x = p.x + side.x * outward * off;
        const z = p.z + side.z * outward * off;
        // Skip chunks that a fold in the loop has brought back over the road.
        if (track.distanceToCenter(x, z) < track.halfWidth + 11) continue;
        chunks.push({ x, z, base: heightAt(x, z), h: 14 + row * 11 + rand() * 10 });
      }
    }
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8076, roughness: 1 });
  const mesh = new THREE.InstancedMesh(geo, mat, chunks.length);
  mesh.castShadow = true;
  chunks.forEach((c, i) => {
    const sy = c.h / 2;
    const sx = 3 + rand() * 3.5;
    const sz = 3 + rand() * 3.5;
    q.setFromEuler(new THREE.Euler(rand() * 0.5, rand() * Math.PI, rand() * 0.5));
    pv.set(c.x, c.base + sy * 0.45, c.z);
    s.set(sx, sy, sz);
    m.compose(pv, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHSL(0.09, 0.12, 0.42 + rand() * 0.12));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.layers.set(1);
  scene.add(mesh);
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
    const prop = builder(biomeAt(x, z)); // biome-aware builders use it; others ignore
    prop.position.set(x, heightAt(x, z), z);
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

    for (const dir of [1, -1]) {
      if (town) {
        // Front shops right by the road.
        if (rand() < 0.62 + density * 0.32)
          place((b) => makeTownStructure(density, b), halfW + 5 + rand() * 2.5, dir, p, side, true);
        // Several rows of houses stacking back up the hillside, thinning with
        // depth so the town recedes into the hills instead of being a thin strip.
        const rows = [13, 24, 36, 50, 66];
        for (let r = 0; r < rows.length; r++) {
          if (rand() < (0.52 + density * 0.4) * (1 - r * 0.15))
            place((b) => makeBuilding(density, b), halfW + rows[r] + rand() * 7, dir, p, side, true);
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
      const v = lit < 0.5 ? Math.floor(150 + rand() * 105) : 22;
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.82)},${Math.floor(v * 0.45)})`;
      ctx.fillRect(8 + col * 18, 7 + r * 18, 11, 12);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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
    emissiveIntensity: 0.5,
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
    emissiveIntensity: 0.5,
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
    const i = Math.floor(((k + 0.5) / makers.length) * N) % N;
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    // Outward = the side that points away from the world centre (the infield).
    const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
    const dist = 78 + rand() * 30;
    const x = p.x + side.x * outward * dist;
    const z = p.z + side.z * outward * dist;
    const obj = make();
    obj.position.set(x, heightAt(x, z), z);
    obj.rotation.y = Math.atan2(p.x - x, p.z - z); // face back toward the road
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
  for (let i = 0; i < bands; i++) {
    const r0 = 2.4 - (i / bands) * 1.0;
    const r1 = 2.4 - ((i + 1) / bands) * 1.0;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(r1, r0, h / bands, 16),
      mat(i % 2 ? 0xd23a2a : 0xf5f0e6)
    );
    seg.position.y = (i + 0.5) * (h / bands);
    seg.castShadow = true;
    g.add(seg);
  }
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.6, 16), mat(0x37474f));
  gallery.position.y = h;
  g.add(gallery);
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 2.2, 12),
    mat(0xfff3c4, { emissive: 0xffe082, emissiveIntensity: 0.9 })
  );
  lamp.position.y = h + 1.4;
  g.add(lamp);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 1.6, 12), mat(0x2b2b2b));
  roof.position.y = h + 3.3;
  g.add(roof);
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
  const g = new THREE.Group();
  const R = 11;
  const steel = mat(0x9099a3);
  // A-frame supports.
  for (const sx of [-1, 1])
    for (const lean of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, R * 1.55, 8), steel);
      leg.position.set(sx * 4, R * 0.72, lean * 3);
      leg.rotation.x = lean * 0.34;
      leg.castShadow = true;
      g.add(leg);
    }
  const wheel = new THREE.Group();
  wheel.position.set(0, R + 2, 0);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.3, 8, 36), steel));
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R * 0.62, 0.2, 8, 28), steel));
  const cabCols = [0xd23a2a, 0x2a7ad2, 0x2e9e4a, 0xe0a52a, 0xab47bc, 0xff8f00];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cx = Math.cos(a) * R;
    const cy = Math.sin(a) * R;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, R, 6), steel);
    spoke.position.set(cx / 2, cy / 2, 0);
    spoke.rotation.z = a - Math.PI / 2;
    wheel.add(spoke);
    const cab = new THREE.Mesh(rbox(1.6, 1.4, 1.6, 0.35), mat(cabCols[i % cabCols.length]));
    cab.position.set(cx, cy, 0);
    wheel.add(cab);
  }
  g.add(wheel);
  _spinners.push({ obj: wheel, ax: "z", speed: 0.25, phase: 0 });
  return g;
}

function makeGiantCat() {
  const g = new THREE.Group();
  const stone = mat(0xc9c2b4);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 5, 1.2, 20), mat(0x8a8278));
  base.position.y = 0.6;
  g.add(base);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, 8, 16), stone);
  body.position.y = 4.8;
  body.castShadow = true;
  g.add(body);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 16), stone);
  chest.position.set(0, 4, 1.4);
  chest.scale.set(1, 1.2, 0.8);
  g.add(chest);
  const head = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 16), stone);
  head.position.y = 10.2;
  g.add(head);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.9, 4), stone);
    ear.position.set(sx * 1.3, 12.3, 0);
    g.add(ear);
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 10, 10),
      mat(0x2b2b2b, { emissive: 0x0a3a2a, emissiveIntensity: 0.25 })
    );
    eye.position.set(sx * 0.95, 10.7, 2.2);
    g.add(eye);
  }
  const tail = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.5, 8, 16, Math.PI * 1.2), stone);
  tail.position.set(2.8, 2.0, 1.4);
  tail.rotation.set(Math.PI / 2, 0, 0.5);
  g.add(tail);
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
  const g = new THREE.Group();
  const tH = 16;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 4, tH, 12), mat(0xe6dcc6));
  tower.position.y = tH / 2;
  tower.castShadow = true;
  g.add(tower);
  const balcony = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.4, 12), mat(0x5d4037));
  balcony.position.y = tH * 0.55;
  g.add(balcony);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(3.2, 3, 12), mat(0x7a4a36));
  cap.position.y = tH + 1.2;
  g.add(cap);
  const hub = new THREE.Group();
  hub.position.set(0, tH * 0.92, 3.4);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9, 0.3), mat(0x6b4a2b));
    spar.position.y = 4.5;
    arm.add(spar);
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 8, 0.1), mat(0xf4efe2));
    cloth.position.set(1.3, 4.5, 0);
    arm.add(cloth);
    arm.rotation.z = (i / 4) * Math.PI * 2;
    hub.add(arm);
  }
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
function buildBirds(scene) {
  const flocks = [];
  const markers = [];
  for (let f = 0; f < 6; f++) {
    const flock = new THREE.Group();
    const wings = [];
    const count = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      for (const sx of [-1, 1]) {
        const wg = new THREE.Group();
        const marker = new THREE.Object3D();
        marker.position.x = sx * 1.1;
        wg.add(marker);
        bird.add(wg);
        wings.push({ wg, sx, phase: rand() * 6.28 });
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
  const birdMat = mat(0x33373d, { flatShading: true });
  const wingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.1, 0.9), birdMat, markers.length);
  wingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wingMesh.frustumCulled = false; // flocks span the whole sky; it's 1 draw regardless
  wingMesh.layers.set(1);
  scene.add(wingMesh);
  return { flocks, wingMesh, markers };
}
// Copy every wing marker's world matrix into the instance buffer (call after all
// updateFlock calls; one updateMatrixWorld per flock refreshes its whole subtree).
function syncBirdWings(birds) {
  for (const fl of birds.flocks) fl.flock.updateMatrixWorld(true);
  for (let i = 0; i < birds.markers.length; i++) birds.wingMesh.setMatrixAt(i, birds.markers[i].matrixWorld);
  birds.wingMesh.instanceMatrix.needsUpdate = true;
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
    w.wg.rotation.z = w.sx * (0.25 + Math.sin(time * 8 + w.phase) * 0.55);
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
    const body = new THREE.Mesh(roundedColumn(5, wallH, 5, 0.6), mat(0xddc9a0));
    body.position.y = wallH / 2;
    body.castShadow = true;
    loft.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.4, 4), mat(0x9c5a3a));
    roof.rotation.y = Math.PI / 4;
    roof.position.y = wallH + 1.2;
    roof.castShadow = true;
    loft.add(roof);
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
      birds.push({ group: pg.group, wings: pg.wings, home, homeRy: pg.group.rotation.y, vel: new THREE.Vector3(), phase: rand() * 6.28 });
    }
    // The trigger must reach the road: the loft sits halfWidth+7.5 off the
    // CENTERLINE, so anything under that radius could never fire from a normal
    // racing line (the old value, 14, was why nobody ever saw them scatter).
    // halfWidth+24 covers the full road width in front of the loft.
    flocks.push({ center: new THREE.Vector3(bx, by, bz), triggerR: track.halfWidth + 24, scattered: false, timer: 0, birds });
  };
  makeLoftAt(0.08);
  makeLoftAt(0.55);
  return flocks;
}

function updatePigeons(flock, dt, time, playerPos) {
  if (!flock.scattered) {
    // Idle flocks the player isn't near don't even bob — a 4cm hop is invisible
    // from 180u, and the scatter trigger only fires within a few units anyway.
    // (A scattered flock keeps animating until it lands, wherever the player is.)
    if (playerPos) {
      const dx = playerPos.x - flock.center.x;
      const dz = playerPos.z - flock.center.z;
      if (dx * dx + dz * dz > 180 * 180) return;
    }
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

function buildBalloons(scene, heightAt) {
  const balloons = [];
  const colors = [0xff5252, 0x42a5f5, 0xffca28, 0xab47bc, 0x66bb6a];
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const color = colors[i % colors.length];
    const envelope = new THREE.Mesh(
      new THREE.SphereGeometry(8, 16, 16),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
    );
    envelope.scale.y = 1.25;
    envelope.position.y = 10;
    g.add(envelope);
    const basket = new THREE.Mesh(
      rbox(3, 3, 3, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x8d6e3a })
    );
    g.add(basket);

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
