import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { attribute, color as tslColor, mix, smoothstep, float, time, positionLocal, vec3 } from "three/tsl";
import { rand } from "./rng.js"; // seeded RNG so the world is identical per seed

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
const BIOMES = [
  { name: "meadow", weather: "none", ground: 0x4f9d3a, ground2: 0x3c7a2e, foliage: [0.3, 0.5, 0.34], style: "cone", sx: 1.0, sy: 1.0, treeDensity: 0.7, grassTint: 0xcfe9b0, grassDensity: 1.0, barrier: { a: 0xfafafa, b: 0x7cb342 } },
  { name: "forest", weather: "rain", ground: 0x356b2c, ground2: 0x244f22, foliage: [0.34, 0.55, 0.24], style: "pine", sx: 0.8, sy: 1.45, treeDensity: 1.0, grassTint: 0x9cc080, grassDensity: 0.9, barrier: { a: 0x6b4a2b, b: 0x3f2c19 } },
  // Alpine sits on the big left-side hill, so its high ground reads as snow.
  { name: "alpine", weather: "snow", ground: 0x6f7e74, ground2: 0x586a62, foliage: [0.4, 0.42, 0.22], style: "pine", sx: 0.7, sy: 1.55, treeDensity: 0.85, grassTint: 0xbcccb0, grassDensity: 0.45, barrier: { a: 0xe53935, b: 0xfafafa } },
  { name: "autumn", weather: "none", ground: 0x7a6a32, ground2: 0x6b5326, foliage: [0.07, 0.7, 0.45], style: "cone", sx: 1.05, sy: 1.0, treeDensity: 0.9, grassTint: 0xd9c070, grassDensity: 0.65, barrier: { a: 0xc8642a, b: 0xf0e0c0 } },
  { name: "desert", weather: "none", ground: 0xcaa56b, ground2: 0xb98e50, foliage: [0.28, 0.45, 0.4], style: "cactus", sx: 1.0, sy: 1.0, treeDensity: 0.3, grassTint: 0xd9c98a, grassDensity: 0.12, barrier: { a: 0xc2a86a, b: 0x9c5a3a } },
];
for (const b of BIOMES) {
  b.groundCol = new THREE.Color(b.ground);
  b.ground2Col = new THREE.Color(b.ground2);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SNOW_WHITE = new THREE.Color(0xeef4fa);

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
};
export function biomeRoadStyle(x, z) {
  return ROAD_STYLES[biomeAt(x, z).name] || ROAD_STYLES.meadow;
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
  buildForests(scene, track, heightAt); // dense woods hugging the road in forest/alpine
  buildRocks(scene, track, heightAt, flatten);
  buildCliffs(scene, track, heightAt); // a rocky cliff stretch to drive against
  buildRoadside(scene, track, heightAt); // town & farm zones lining the road
  buildStreetLamps(scene, track, heightAt, lit, litLevel); // roadside lamps (on at dusk/night)
  buildStringLights(scene, track, litLevel); // festive bulb strings over a few road spans
  buildOverheadStructures(scene, track, lit, litLevel); // banners + a bridge spanning the road
  buildLandmarks(scene, track, heightAt); // hero structures around the horizon
  const waters = buildWater(scene, lakes, 1 - litLevel * 0.6); // dimmer water at dusk/night
  const grass = buildGrass(scene, track, heightAt);
  const balloons = buildBalloons(scene, heightAt);
  const flocks = buildBirds(scene);
  const fireflies = buildFireflies(scene, track, heightAt);
  const pigeonFlocks = buildPigeons(scene, track, heightAt);

  return {
    grass,
    update(time, dt = 0.016, playerPos = null) {
      for (const b of balloons) {
        b.mesh.position.y = b.baseY + Math.sin(time * 0.5 + b.phase) * 4;
        b.mesh.rotation.y = time * 0.1 + b.phase;
      }
      for (const s of _spinners) s.obj.rotation[s.ax] = time * s.speed + s.phase;
      for (const f of _flutterers) f.obj.rotation.y = Math.sin(time * 5 + f.phase) * 0.4;
      for (const fl of flocks) updateFlock(fl, time);
      for (const c of _critters) updateCritter(c, dt, time, heightAt);
      for (const pf of pigeonFlocks) updatePigeons(pf, dt, time, playerPos);
      if (fireflies) fireflies.material.uniforms.uTime.value = time;
      for (const w of waters) w.uniforms.uTime.value = time;
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
  // TSL node material (WebGPU). The water colour is unlit, so dim it directly at
  // dusk/night (the `darken` factor) — otherwise it glows like daylight cyan in
  // the dark. aShore: 0 at the centre/spine -> 1 at the bank. aLen: along the
  // water. Ripples + foam animate off the global TSL `time`.
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
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
  mat.opacityNode = float(0.9);
  // Dummy uniforms bag so the existing `w.uniforms.uTime.value = …` animation
  // write in buildWorld's update stays a harmless no-op (animation is via `time`).
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

  const peak = (x, z, h, rad, bury) => {
    const desert = biomeAt(x, z).name === "desert";
    const base = heightAt(x, z) + h / 2 - bury;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 18), desert ? rockDesert : rockN);
    m.position.set(x, base, z);
    m.rotation.y = rand() * Math.PI;
    scene.add(m);
    // No snow caps in the desert — snowy peaks behind cacti look wrong.
    if (!desert) {
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.4, h * 0.3, 18), snow);
      cap.position.set(x, base + h * 0.5 - h * 0.15, z);
      cap.rotation.y = m.rotation.y;
      scene.add(cap);
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

function buildTrees(scene, track, heightAt, flatten) {
  // Each candidate spot is tagged with its biome, kept with that biome's tree
  // density, then bucketed by tree style (cone-shaped trees vs desert cacti).
  const spots = scatter(340, track, flatten, 0.55, 1700)
    .filter((s) => !_inLake(s.x, s.z)) // keep forests out of the water
    .map((s) => ({ ...s, y: heightAt(s.x, s.z), b: biomeAt(s.x, s.z) }))
    .filter((s) => s.y <= 30 && rand() < s.b.treeDensity);

  const cones = spots.filter((s) => s.b.style !== "cactus");
  const cacti = spots.filter((s) => s.b.style === "cactus");
  if (cones.length) buildConeTrees(scene, cones);
  if (cacti.length) buildCacti(scene, cacti);
}

// Cone-style trees (meadow/forest/autumn/alpine). One shared cone+trunk geometry;
// each biome stretches/narrows and recolours via per-instance matrix + colour.
function buildConeTrees(scene, spots, scaleMul = 1) {
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 3, 6);
  const foliageGeo = new THREE.ConeGeometry(2.4, 6, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  foliageMat.userData.backlight = true; // glow when backlit by the sun (set in toonify)

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, spots.length);
  foliage.castShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();

  spots.forEach((spot, i) => {
    const { y, b } = spot;
    const sc = (0.8 + rand() * 1.4) * scaleMul;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);

    p.set(spot.x, y + 1.5 * sc, spot.z);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);

    // Foliage sits on top of the trunk; pines are taller and narrower.
    p.set(spot.x, y + 3 * sc + 3 * b.sy * sc, spot.z);
    s.set(b.sx * sc, b.sy * sc, b.sx * sc);
    m.compose(p, q, s);
    foliage.setMatrixAt(i, m);

    let h = b.foliage[0];
    if (b.name === "autumn") h += (rand() - 0.5) * 0.12; // mix red/orange/gold
    col.setHSL(h, b.foliage[1], clamp(b.foliage[2] + (rand() - 0.5) * 0.1, 0.14, 0.6));
    if (b.name === "alpine") col.lerp(SNOW_WHITE, 0.45); // snow-dusted pines
    foliage.setColorAt(i, col);
  });
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  trunks.layers.set(1); // excluded from the rear-view mirror render
  foliage.layers.set(1);
  scene.add(trunks);
  scene.add(foliage);

  // Soft contact shadow under each tree — grounds them without the cost of a
  // real shadow pass (reads as the SSAO "occlusion" darkening at the base).
  buildBlobShadows(
    scene,
    spots.map((spot) => {
      const sc = 0.9 * scaleMul;
      return { x: spot.x, y: spot.y, z: spot.z, r: (2.0 + spot.b.sx) * sc };
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
function buildStringLights(scene, track, level = 0) {
  const up = new THREE.Vector3(0, 1, 0);
  const N = track.samples;
  const SPANS = 5;
  const COLS = [0xff3b30, 0xffd60a, 0x34c759, 0x0a84ff, 0xff9f0a, 0xffffff];
  const bulbs = []; // { x, y, z, col }
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2a2622, transparent: true, opacity: 0.7, fog: true });
  for (let s = 0; s < SPANS; s++) {
    const i = Math.floor(((s + 0.5) / SPANS + rand() * 0.12) * N) % N;
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const off = track.halfWidth + 4;
    const ax = p.x + side.x * off, az = p.z + side.z * off, ay = p.y + 8.5;
    const bx = p.x - side.x * off, bz = p.z - side.z * off, by = p.y + 8.5;
    const sag = 3.0;
    const per = 12;
    const pts = [];
    for (let k = 0; k <= per; k++) {
      const t = k / per;
      const dip = Math.sin(t * Math.PI) * sag; // catenary-ish droop
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const y = ay + (by - ay) * t - dip;
      pts.push(new THREE.Vector3(x, y, z));
      if (k > 0 && k < per) bulbs.push({ x, y: y - 0.25, z, col: COLS[(k + s) % COLS.length] });
    }
    const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat);
    wire.layers.set(1);
    scene.add(wire);
  }
  if (!bulbs.length) return;
  const geo = new THREE.SphereGeometry(0.34, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
  const mesh = new THREE.InstancedMesh(geo, mat, bulbs.length);
  const m = new THREE.Matrix4();
  const ID = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  const glow = 0.9 + level * 0.7; // 0.9 by day, brighter toward dusk/night so they bloom
  bulbs.forEach((b, idx) => {
    m.compose(new THREE.Vector3(b.x, b.y, b.z), ID, sc);
    mesh.setMatrixAt(idx, m);
    mesh.setColorAt(idx, c.set(b.col).multiplyScalar(glow));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.layers.set(1);
  scene.add(mesh);
}

// Overhead structures you drive UNDER: cloth welcome banners on posts, and a
// chunky bridge/overpass spanning the road. Seeded placement across the track.
function buildOverheadStructures(scene, track, lit, level = 1) {
  const N = track.samples;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 });
  const clothCols = [0xd9534f, 0x4a90d9, 0x4caf50, 0xe0a73a, 0x9c5ab8];

  const spanAt = (frac) => {
    const i = Math.floor((frac % 1) * N) % N;
    const p = track._pts[i];
    const t = track._tans[i];
    const tl = Math.hypot(t.x, t.z) || 1;
    return { p, sx: -t.z / tl, sz: t.x / tl, yaw: Math.atan2(t.x / tl, t.z / tl) };
  };

  // --- Cloth banners (2) ---
  for (const frac of [0.2 + rand() * 0.1, 0.66 + rand() * 0.1]) {
    const { p, sx, sz, yaw } = spanAt(frac);
    const off = track.halfWidth + 3;
    const postH = 11;
    for (const dir of [1, -1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, postH, 8), postMat);
      post.position.set(p.x + sx * dir * off, p.y + postH / 2, p.z + sz * dir * off);
      post.castShadow = true;
      post.layers.set(1);
      scene.add(post);
    }
    const width = (track.halfWidth + off) * 2;
    const crossbar = new THREE.Mesh(rbox(width, 0.4, 0.4, 0.15), postMat);
    crossbar.position.set(p.x, p.y + postH, p.z);
    crossbar.rotation.y = yaw;
    crossbar.layers.set(1);
    scene.add(crossbar);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(width * 0.86, 3.2),
      new THREE.MeshStandardMaterial({ color: clothCols[(rand() * clothCols.length) | 0], roughness: 1, side: THREE.DoubleSide })
    );
    cloth.position.set(p.x, p.y + postH - 2.0, p.z);
    cloth.rotation.y = yaw;
    cloth.castShadow = true;
    cloth.layers.set(1);
    scene.add(cloth);
  }

  // --- One bridge / overpass you drive under ---
  {
    const { p, sx, sz, yaw } = spanAt(0.42 + rand() * 0.08);
    const stone = new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 1 });
    const deckY = p.y + 13;
    const off = track.halfWidth + 6;
    const span = (track.halfWidth + off) * 2;
    for (const dir of [1, -1]) {
      const pillar = new THREE.Mesh(rbox(3.4, deckY - p.y, 4.2, 0.4), stone);
      pillar.position.set(p.x + sx * dir * off, p.y + (deckY - p.y) / 2, p.z + sz * dir * off);
      pillar.rotation.y = yaw;
      pillar.castShadow = true;
      pillar.layers.set(1);
      scene.add(pillar);
    }
    const deck = new THREE.Mesh(rbox(span, 1.6, 8, 0.3), stone);
    deck.position.set(p.x, deckY, p.z);
    deck.rotation.y = yaw;
    deck.castShadow = true;
    deck.layers.set(1);
    scene.add(deck);
    for (const dz of [-3.4, 3.4]) {
      const rail = new THREE.Mesh(rbox(span, 1.0, 0.4, 0.15), stone);
      rail.position.set(p.x + Math.cos(yaw) * dz, deckY + 1.3, p.z - Math.sin(yaw) * dz);
      rail.rotation.y = yaw;
      rail.layers.set(1);
      scene.add(rail);
    }
    if (lit) {
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.6, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xfff0c8, emissive: 0xffd98a, emissiveIntensity: 2.4 * level })
      );
      lamp.position.set(p.x, deckY - 1.2, p.z);
      lamp.layers.set(1);
      scene.add(lamp);
    }
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
  if (spots.length) buildConeTrees(scene, spots, 1.45); // taller, fuller forest trees
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
  // In the alpine (snow) biome, frost the walls and snow-cover the roof.
  const snow = biome && biome.name === "alpine";
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
  return g;
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
  // sails — a cross of blades at the front that actually turns in the wind
  const sailMat = mat(0xf4efe2);
  const hub = new THREE.Group();
  hub.position.set(0, tH, 1.7);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.1), sailMat);
    blade.position.y = 2;
    const arm = new THREE.Group();
    arm.add(blade);
    arm.rotation.z = (i / 4) * Math.PI * 2;
    hub.add(arm);
  }
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
  const g = new THREE.Group();
  const s = 0.9 + rand() * 1.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 6), mat(0x6b4a2b));
  trunk.position.y = 1.5 * s;
  trunk.scale.setScalar(s);
  trunk.castShadow = true;
  g.add(trunk);
  let h = b.foliage[0];
  if (b.name === "autumn") h += (rand() - 0.5) * 0.12;
  const folCol = new THREE.Color().setHSL(h, b.foliage[1], clamp(b.foliage[2] + (rand() - 0.5) * 0.1, 0.14, 0.6));
  const fol = new THREE.Mesh(new THREE.ConeGeometry(2.4, 6, 7), mat(folCol.getHex(), { flatShading: true }));
  fol.position.y = (3 + 3 * b.sy) * s;
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
  const g = new THREE.Group();
  const white = mat(0xf2f2f2);
  const dark = mat(0x3a2f2a);
  const body = new THREE.Mesh(rbox(3, 1.6, 1.5, 0.45), white);
  body.position.y = 1.5;
  body.castShadow = true;
  g.add(body);
  const patch = new THREE.Mesh(rbox(1.1, 1.62, 1.0, 0.3), dark);
  patch.position.set(0.6, 1.5, 0);
  g.add(patch);
  const head = new THREE.Mesh(rbox(0.9, 0.9, 0.9, 0.28), white);
  head.position.set(-1.7, 1.7, 0);
  g.add(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(rbox(0.3, 1.5, 0.3, 0.12), dark);
      leg.position.set(sx * 1.1, 0.75, sz * 0.5);
      g.add(leg);
    }
  g.userData.wander = { range: 4, speed: 1.1, bob: 0.06 }; // cows graze slowly
  return g;
}

function makeSheep() {
  const g = new THREE.Group();
  const wool = mat(0xf6f4ef, { flatShading: true });
  const dark = mat(0x2b2b2b);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), wool);
  body.position.y = 1.4;
  body.scale.set(1.3, 1, 1);
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(rbox(0.7, 0.7, 0.6, 0.22), dark);
  head.position.set(-1.4, 1.5, 0);
  g.add(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(rbox(0.22, 1.1, 0.22, 0.09), dark);
      leg.position.set(sx * 0.7, 0.55, sz * 0.45);
      g.add(leg);
    }
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
// A few flocks of simple birds circling high in the sky, wings flapping.
function buildBirds(scene) {
  const flocks = [];
  const birdMat = mat(0x33373d, { flatShading: true });
  for (let f = 0; f < 6; f++) {
    const flock = new THREE.Group();
    const wings = [];
    const count = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      for (const sx of [-1, 1]) {
        const wg = new THREE.Group();
        const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.9), birdMat);
        wing.position.x = sx * 1.1;
        wg.add(wing);
        bird.add(wg);
        wings.push({ wg, sx, phase: rand() * 6.28 });
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
  return flocks;
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
  const want = 260;
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
function makePigeon() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), mat(0x9aa3ad));
  body.scale.set(1, 0.9, 1.4);
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), mat(0xb0b8c0));
  head.position.set(0, 0.22, 0.34);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 5), mat(0xe0a52a));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.2, 0.5);
  g.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.4), mat(0x7e878f));
  tail.position.set(0, 0.02, -0.42);
  g.add(tail);
  const wings = [];
  for (const sx of [-1, 1]) {
    const wg = new THREE.Group();
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), mat(0x868f98));
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
  // Find a roadside spot whose loft footprint clears the WHOLE track, so a fold in
  // the loop doesn't drop this building onto a different stretch of road.
  let bx, bz, px, pz;
  for (let attempt = 0; attempt < 10; attempt++) {
    const i = Math.floor(((0.08 + attempt * 0.07) % 1) * N);
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
    const cx = p.x + side.x * outward * (track.halfWidth + 9);
    const cz = p.z + side.z * outward * (track.halfWidth + 9);
    if (attempt < 9 && track.distanceToCenter(cx, cz) < track.halfWidth + 6) continue;
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
    pg.group.traverse((o) => o.layers.set(1));
    flockGroup.add(pg.group);
    birds.push({ group: pg.group, wings: pg.wings, home, homeRy: pg.group.rotation.y, vel: new THREE.Vector3(), phase: rand() * 6.28 });
  }
  return [{ center: new THREE.Vector3(bx, by, bz), triggerR: 14, scattered: false, timer: 0, birds }];
}

function updatePigeons(flock, dt, time, playerPos) {
  if (!flock.scattered) {
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
