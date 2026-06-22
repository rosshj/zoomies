import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Registries of animated parts, filled in as the world is built and driven from
// buildWorld's update(): continuous spinners (windmill sails, Ferris wheel,
// lighthouse beam) and gentle flutterers (flags).
const _spinners = []; // { obj, ax:'x'|'y'|'z', speed, phase }
const _flutterers = []; // { obj, phase }
// Set per build: true where a lake basin sits, so scatter/grass/props avoid it.
let _inLake = () => false;

// ---- Biomes ----
// Five themed sectors radiating around the map. Since the track loops through
// every angle, you drive through each biome as you lap. Cheap to evaluate
// (just atan2), so terrain, trees and grass can all be themed per position.
const BIOMES = [
  { name: "meadow", ground: 0x4f9d3a, ground2: 0x3c7a2e, foliage: [0.3, 0.5, 0.34], style: "cone", sx: 1.0, sy: 1.0, treeDensity: 0.7, grassTint: 0xcfe9b0, grassDensity: 1.0, barrier: { a: 0xfafafa, b: 0x7cb342 } },
  { name: "forest", ground: 0x356b2c, ground2: 0x244f22, foliage: [0.34, 0.55, 0.24], style: "pine", sx: 0.8, sy: 1.45, treeDensity: 1.0, grassTint: 0x9cc080, grassDensity: 0.9, barrier: { a: 0x6b4a2b, b: 0x3f2c19 } },
  { name: "autumn", ground: 0x7a6a32, ground2: 0x6b5326, foliage: [0.07, 0.7, 0.45], style: "cone", sx: 1.05, sy: 1.0, treeDensity: 0.9, grassTint: 0xd9c070, grassDensity: 0.65, barrier: { a: 0xc8642a, b: 0xf0e0c0 } },
  { name: "alpine", ground: 0x6f7e74, ground2: 0x586a62, foliage: [0.4, 0.42, 0.22], style: "pine", sx: 0.7, sy: 1.55, treeDensity: 0.85, grassTint: 0xbcccb0, grassDensity: 0.45, barrier: { a: 0xe53935, b: 0xfafafa } },
  { name: "desert", ground: 0xcaa56b, ground2: 0xb98e50, foliage: [0.28, 0.45, 0.4], style: "cactus", sx: 1.0, sy: 1.0, treeDensity: 0.3, grassTint: 0xd9c98a, grassDensity: 0.12, barrier: { a: 0xc2a86a, b: 0x9c5a3a } },
];
for (const b of BIOMES) {
  b.groundCol = new THREE.Color(b.ground);
  b.ground2Col = new THREE.Color(b.ground2);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function biomeAt(x, z) {
  const u = (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1;
  return BIOMES[Math.floor(u * BIOMES.length) % BIOMES.length];
}

// Roadside-barrier colours for the biome at a position (used by the track).
export function biomeBarrierStyle(x, z) {
  return biomeAt(x, z).barrier;
}

// Terrain rises as you move away from the road, so the track sits in a shallow
// valley with hillsides climbing on both sides — that way the scenery and
// landmarks on those slopes are visible from the road instead of hidden in
// dips. Ramps from 0 at the verge up to a plateau by ~150 units out.
function valleyRise(dist) {
  const u = clamp((dist - 18) / 132, 0, 1);
  return 38 * u * u * (3 - 2 * u);
}

// Ground colour with a short blended seam between sectors (crisp biomes, soft
// borders). Writes into `out` and returns it.
function biomeGround(x, z, out) {
  const n = BIOMES.length;
  const s = ((Math.atan2(z, x) / (Math.PI * 2) + 1) % 1) * n;
  const i0 = Math.floor(s) % n;
  const frac = s - Math.floor(s);
  const a = BIOMES[i0];
  const b = BIOMES[(i0 + 1) % n];
  const w = frac < 0.82 ? 0 : (frac - 0.82) / 0.18;
  return out.copy(a.groundCol).lerp(b.groundCol, w * w * (3 - 2 * w));
}

// Builds the world around the track: rolling hills, distant mountains, a small
// town of buildings, forests, rocks, hero landmarks, hot-air balloons and birds.
// Returns { grass, update(time) } for the animated bits.
export function buildWorld(scene, track) {
  _spinners.length = 0;
  _flutterers.length = 0;
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
  _inLake = (x, z) => lakes.some((L) => Math.hypot(x - L.x, z - L.z) < L.shoreR);

  const heightAt = (x, z) => carveLakes(lakes, x, z, baseHeight(x, z));

  buildTerrain(scene, heightAt);
  buildMountains(scene, heightAt, track);
  buildTrees(scene, track, heightAt, flatten);
  buildForests(scene, track, heightAt); // dense woods hugging the road in forest/alpine
  buildRocks(scene, track, heightAt, flatten);
  buildCliffs(scene, track, heightAt); // a rocky cliff stretch to drive against
  buildRoadside(scene, track, heightAt); // town & farm zones lining the road
  buildLandmarks(scene, track, heightAt); // hero structures around the horizon
  const waters = buildWater(scene, lakes);
  const grass = buildGrass(scene, track, heightAt);
  const balloons = buildBalloons(scene);
  const flocks = buildBirds(scene);

  return {
    grass,
    update(time) {
      for (const b of balloons) {
        b.mesh.position.y = b.baseY + Math.sin(time * 0.5 + b.phase) * 4;
        b.mesh.rotation.y = time * 0.1 + b.phase;
      }
      for (const s of _spinners) s.obj.rotation[s.ax] = time * s.speed + s.phase;
      for (const f of _flutterers) f.obj.rotation.y = Math.sin(time * 5 + f.phase) * 0.4;
      for (const fl of flocks) updateFlock(fl, time);
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
  const specs = [
    { x: 80, z: -120, waterR: 78, shoreR: 98, blendR: 120, depth: 9 }, // big lake where the loop passes closest
    { x: -430, z: 250, waterR: 40, shoreR: 52, blendR: 82, depth: 7 },
    { x: 430, z: -380, waterR: 48, shoreR: 62, blendR: 96, depth: 7 },
  ];
  const lakes = [];
  for (const s of specs) {
    const gi = track.groundInfo(s.x, s.z);
    if (gi.dist < track.halfWidth + s.blendR + 8) continue; // would touch the road
    if (lakes.some((L) => Math.hypot(s.x - L.x, s.z - L.z) < s.blendR + L.blendR + 6)) continue;
    const level = baseHeight(s.x, s.z);
    lakes.push({
      x: s.x, z: s.z, level,
      floor: level - s.depth,
      waterR: s.waterR,
      shoreR: s.shoreR,
      blendR: s.blendR,
    });
  }
  return lakes;
}

function carveLakes(lakes, x, z, h) {
  for (const L of lakes) {
    const d = Math.hypot(x - L.x, z - L.z);
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

// Stylised toon water: flat saturated plane with hard-stepped concentric
// ripples, a sparkle band, and a foamy shoreline. Animated via uTime.
function buildWater(scene, lakes) {
  const mats = [];
  for (const L of lakes) {
    const geo = new THREE.CircleGeometry(L.waterR, 56);
    geo.rotateX(-Math.PI / 2);
    const matW = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x1f6f8c) },
        uShallow: { value: new THREE.Color(0x57c6d6) },
        uFoam: { value: new THREE.Color(0xeafcff) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
        varying vec2 vUv;
        void main(){
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;           // 0 centre .. 1 edge
          float ang = atan(p.y, p.x);
          // Hard-stepped concentric ripples drifting outward.
          float ripple = step(0.5, sin(r * 22.0 - uTime * 1.5) * 0.5 + 0.5);
          // Rotating sparkle near the middle.
          float glint = step(0.86, sin(ang * 9.0 + uTime * 0.7) * 0.5 + 0.5) * (1.0 - r);
          vec3 col = mix(uShallow, uDeep, smoothstep(0.0, 1.0, r));
          col = mix(col, col * 1.22, ripple * 0.35);
          col = mix(col, uFoam, glint * 0.5);
          float foam = smoothstep(0.82, 0.99, r);  // shoreline foam ring
          col = mix(col, uFoam, foam);
          gl_FragColor = vec4(col, 0.88);
        }`,
    });
    const mesh = new THREE.Mesh(geo, matW);
    mesh.position.set(L.x, L.level + 0.05, L.z);
    scene.add(mesh);
    mats.push(matW);
  }
  return mats;
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
    shader.vertexShader = "uniform float uTime;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       float ph = instanceMatrix[3][0] * 0.15 + instanceMatrix[3][2] * 0.15;
       transformed.x += sin(uTime * 1.6 + ph) * 0.18 * position.y;
       transformed.z += cos(uTime * 1.3 + ph) * 0.10 * position.y;`
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
    const i = Math.floor(Math.random() * N);
    const pt = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const dir = Math.random() < 0.5 ? 1 : -1;
    const dist = halfW + 2.5 + Math.random() * 34;
    const x = pt.x + side.x * dir * dist + (Math.random() - 0.5) * 3;
    const z = pt.z + side.z * dir * dist + (Math.random() - 0.5) * 3;
    if (track.distanceToCenter(x, z) < halfW + 2) continue;
    if (_inLake(x, z)) continue;
    const biome = biomeAt(x, z);
    if (Math.random() > biome.grassDensity) continue; // sparse in dry biomes
    dummy.position.set(x, heightAt(x, z), z);
    dummy.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI, (Math.random() - 0.5) * 0.3);
    dummy.scale.setScalar(0.7 + Math.random() * 1.1);
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

function buildTerrain(scene, heightAt) {
  const SIZE = 1900;
  const SEG = 280;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];
  const cRock = new THREE.Color(0x7a6f5d);
  const cSnow = new THREE.Color(0xf4f7fb);
  const base = new THREE.Color();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);

    // Biome ground colour at low/mid elevation, fading to rock then snow up high
    // so the distant peaks stay rocky/snowy regardless of biome.
    biomeGround(x, z, base);
    const b = biomeAt(x, z);
    base.lerp(b.ground2Col, Math.random() * 0.35); // subtle dappling
    if (y < 30) c.copy(base);
    else if (y < 50) c.copy(base).lerp(cRock, (y - 30) / 20);
    else c.copy(cRock).lerp(cSnow, Math.min(1, (y - 50) / 14));
    colors.push(c.r, c.g, c.b);
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
  const mat = new THREE.MeshStandardMaterial({ color: 0x6d6253, flatShading: true, roughness: 1 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, flatShading: true, roughness: 1 });

  const peak = (x, z, h, rad, bury) => {
    const base = heightAt(x, z) + h / 2 - bury;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), mat);
    m.position.set(x, base, z);
    m.rotation.y = Math.random() * Math.PI;
    scene.add(m);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.4, h * 0.3, 7), snow);
    cap.position.set(x, base + h * 0.5 - h * 0.15, z);
    cap.rotation.y = m.rotation.y;
    scene.add(cap);
  };

  // Distant mountain ring around the whole world.
  const count = 24;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
    const r = 840 + Math.random() * 160;
    peak(Math.cos(a) * r, Math.sin(a) * r, 170 + Math.random() * 150, 90 + Math.random() * 70, 30);
  }

  // A few peaks brought in close beside the track, so you race right up against
  // a mountainside on those stretches.
  if (track) {
    const up = new THREE.Vector3(0, 1, 0);
    for (const tt of [0.24, 0.58, 0.9]) {
      const i = Math.floor(tt * track.samples);
      const p = track._pts[i];
      const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
      const outward = side.x * p.x + side.z * p.z >= 0 ? 1 : -1;
      const off = 165 + Math.random() * 55;
      peak(p.x + side.x * outward * off, p.z + side.z * outward * off, 120 + Math.random() * 50, 50 + Math.random() * 22, 22);
    }
  }
}

// Helper: scatter `count` valid positions away from the road.
function scatter(count, track, flatten, minFlat, range) {
  const out = [];
  let tries = 0;
  while (out.length < count && tries < count * 30) {
    tries++;
    const x = (Math.random() - 0.5) * range;
    const z = (Math.random() - 0.5) * range;
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
    .filter((s) => s.y <= 30 && Math.random() < s.b.treeDensity);

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
    const sc = (0.8 + Math.random() * 1.4) * scaleMul;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);

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
    if (b.name === "autumn") h += (Math.random() - 0.5) * 0.12; // mix red/orange/gold
    foliage.setColorAt(i, col.setHSL(h, b.foliage[1], clamp(b.foliage[2] + (Math.random() - 0.5) * 0.1, 0.14, 0.6)));
  });
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  trunks.layers.set(1); // excluded from the rear-view mirror render
  foliage.layers.set(1);
  scene.add(trunks);
  scene.add(foliage);
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
    const sc = 0.9 + Math.random() * 0.9;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
    p.set(spot.x, spot.y, spot.z);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    cacti.setMatrixAt(i, m);
    cacti.setColorAt(i, col.setHSL(0.28, 0.4, 0.34 + Math.random() * 0.12));
  });
  cacti.instanceMatrix.needsUpdate = true;
  if (cacti.instanceColor) cacti.instanceColor.needsUpdate = true;
  cacti.layers.set(1);
  scene.add(cacti);
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
      const dir = Math.random() < 0.5 ? 1 : -1;
      const dist = halfW + 5 + Math.random() * 115;
      const x = p.x + side.x * dir * dist + (Math.random() - 0.5) * 9;
      const z = p.z + side.z * dir * dist + (Math.random() - 0.5) * 9;
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
        const off = track.halfWidth + 15 + row * 8 + Math.random() * 3;
        const x = p.x + side.x * outward * off;
        const z = p.z + side.z * outward * off;
        chunks.push({ x, z, base: heightAt(x, z), h: 14 + row * 11 + Math.random() * 10 });
      }
    }
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8076, roughness: 1, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, chunks.length);
  mesh.castShadow = true;
  chunks.forEach((c, i) => {
    const sy = c.h / 2;
    const sx = 3 + Math.random() * 3.5;
    const sz = 3 + Math.random() * 3.5;
    q.setFromEuler(new THREE.Euler(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.5));
    pv.set(c.x, c.base + sy * 0.45, c.z);
    s.set(sx, sy, sz);
    m.compose(pv, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHSL(0.09, 0.12, 0.42 + Math.random() * 0.12));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.layers.set(1);
  scene.add(mesh);
}

function buildRocks(scene, track, heightAt, flatten) {
  const spots = scatter(140, track, flatten, 0.4, 1700).filter((s) => !_inLake(s.x, s.z));
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  spots.forEach((spot, i) => {
    const y = heightAt(spot.x, spot.z);
    const sc = 1 + Math.random() * 3;
    q.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
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
      x: townCenter.x + (Math.random() - 0.5) * 240,
      z: townCenter.z + (Math.random() - 0.5) * 240,
    });
  }
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 300 + Math.random() * 260;
    placements.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }

  for (const pl of placements) {
    if (track.distanceToCenter(pl.x, pl.z) < track.halfWidth + 30) continue;
    const y = heightAt(pl.x, pl.z);
    const w = 8 + Math.random() * 10;
    const d = 8 + Math.random() * 10;
    const floors = 1 + Math.floor(Math.random() * 4);
    const h = floors * 5;
    const mat = new THREE.MeshStandardMaterial({
      color: palette[Math.floor(Math.random() * palette.length)],
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
    b.rotation.y = Math.random() * Math.PI;
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
      ? Math.atan2(-side.x * dir, -side.z * dir) + (Math.random() - 0.5) * 0.4
      : Math.random() * Math.PI * 2;
    prop.traverse((o) => o.layers.set(1)); // keep out of the mirror render
    scene.add(prop);
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
        if (Math.random() < 0.62 + density * 0.32)
          place(() => makeTownStructure(density), halfW + 5 + Math.random() * 2.5, dir, p, side, true);
        // Several rows of houses stacking back up the hillside, thinning with
        // depth so the town recedes into the hills instead of being a thin strip.
        const rows = [13, 24, 36, 50, 66];
        for (let r = 0; r < rows.length; r++) {
          if (Math.random() < (0.52 + density * 0.4) * (1 - r * 0.15))
            place(() => makeBuilding(density), halfW + rows[r] + Math.random() * 7, dir, p, side, true);
        }
        if (Math.random() < 0.5)
          place(makeStreetProp, halfW + 3.2 + Math.random() * 1.4, dir, p, side, true);
      } else if (Math.random() < 0.4) {
        place(makeFarmProp, halfW + 6 + Math.random() * 18, dir, p, side, false);
      }
    }
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
      const lit = Math.random();
      const v = lit < 0.5 ? Math.floor(150 + Math.random() * 105) : 22;
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

// Add a positioned geometry to `parts` with a baked vertex colour.
function part(parts, geo, color) {
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
function makeBuilding(density) {
  const g = new THREE.Group();
  const w = 4 + Math.random() * 3.5;
  const d = 4 + Math.random() * 3.5;
  let floors = 1;
  if (Math.random() < 0.45 + density * 0.2) floors = 2;
  if (floors === 2 && Math.random() < 0.15) floors = 3;
  const h = floors * 2.7;
  const base = 0.6;
  const top = base + h;
  const wall = pick(BUILDING_PALETTE);
  const roofCol = pick(ROOF_PALETTE);
  const trim = pick(TRIM_PALETTE);

  // Window-lit body (+ optional wing), merged into one emissive mesh.
  const bodyParts = [new THREE.BoxGeometry(w, h, d).translate(0, base + h / 2, 0)];
  let wing = null;
  if (Math.random() < 0.4) {
    const ww = w * 0.6;
    const wd = d * 0.62;
    const wh = h * (floors > 1 ? 0.6 : 0.92);
    const wx = (w / 2 + ww / 2 - 0.2) * (Math.random() < 0.5 ? 1 : -1);
    const wz = (Math.random() - 0.5) * d * 0.3;
    bodyParts.push(new THREE.BoxGeometry(ww, wh, wd).translate(wx, base + wh / 2, wz));
    wing = { ww, wd, wh, wx, wz };
  }
  const body = new THREE.Mesh(mergeGeometries(bodyParts), bodyMaterial(wall));
  body.receiveShadow = true;
  g.add(body);

  // Everything else: solid vertex-coloured detail.
  const parts = [];
  part(parts, new THREE.BoxGeometry(w + 0.5, base, d + 0.5).translate(0, base / 2, 0), 0x5a4f44); // foundation
  part(parts, new THREE.BoxGeometry(w + 0.12, 0.18, d + 0.12).translate(0, top - 0.1, 0), trim); // eave band

  const flat = Math.random() < 0.25;
  if (flat) {
    part(parts, new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3).translate(0, top + 0.25, 0), roofCol);
    part(parts, new THREE.BoxGeometry(w + 0.4, 0.5, 0.3).translate(0, top + 0.6, d / 2 + 0.05), trim); // front parapet
  } else {
    const roofH = 1.4 + floors * 0.45;
    const rad = Math.max(w, d) * 0.82 + 0.5;
    part(parts, new THREE.ConeGeometry(rad, roofH, 4).rotateY(Math.PI / 4).translate(0, top + roofH / 2, 0), roofCol);
    if (Math.random() < 0.75) {
      const cx = w * 0.25;
      const cz = d * 0.2;
      part(parts, new THREE.BoxGeometry(0.5, 1.6, 0.5).translate(cx, top + roofH * 0.4, cz), 0x8a5a44);
      part(parts, new THREE.BoxGeometry(0.7, 0.22, 0.7).translate(cx, top + roofH * 0.4 + 0.9, cz), 0x333333);
    }
    if (floors >= 2 && Math.random() < 0.5) {
      part(parts, new THREE.BoxGeometry(1.3, 1.1, 1.0).translate(0, top + 0.35, d / 2 - 0.3), wall);
      part(parts, new THREE.ConeGeometry(1.1, 0.8, 4).rotateY(Math.PI / 4).translate(0, top + 1.2, d / 2 - 0.3), roofCol);
    }
  }

  // Framed door (+ step).
  const dx = (Math.random() - 0.5) * (w - 2.2);
  part(parts, new THREE.BoxGeometry(1.4, 2.1, 0.18).translate(dx, base + 1.0, d / 2 + 0.02), trim);
  part(parts, new THREE.BoxGeometry(0.95, 1.65, 0.12).translate(dx, base + 0.82, d / 2 + 0.12), 0x4a2f1c);
  part(parts, new THREE.BoxGeometry(1.6, 0.2, 0.7).translate(dx, base, d / 2 + 0.35), 0x7a6b58); // step
  if (Math.random() < 0.4) {
    const awn = new THREE.BoxGeometry(2.2, 0.22, 1.1);
    awn.rotateX(-0.32);
    awn.translate(dx, base + 2.0, d / 2 + 0.55);
    part(parts, awn, pick([0xd23a2a, 0x2a7ad2, 0x2e9e4a, 0xe0a52a]));
  }

  const solid = new THREE.Mesh(mergeGeometries(parts), _solidMat);
  solid.receiveShadow = true;
  g.add(solid);
  return g;
}

// Pick a town structure — mostly houses, occasionally a landmark.
function makeTownStructure(density) {
  const r = Math.random();
  if (r < 0.05) return makeChurch();
  if (r < 0.09) return makeWaterTower();
  return makeBuilding(density);
}

function makeChurch() {
  const g = new THREE.Group();
  const wall = 0xeae0cf;
  const roofCol = 0x4f6e78;
  const parts = [];
  const naveH = 6;
  part(parts, new THREE.BoxGeometry(6, naveH, 9).translate(0, naveH / 2, 0), wall);
  part(parts, new THREE.ConeGeometry(5, 3, 4).rotateY(Math.PI / 4).translate(0, naveH + 1.5, 0), roofCol);
  // bell tower
  const tH = 10;
  part(parts, new THREE.BoxGeometry(3, tH, 3).translate(0, tH / 2, 5), wall);
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
  _spinners.push({ obj: hub, ax: "z", speed: 0.6, phase: Math.random() * 6.28 });
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
  const r = Math.random();
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
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.4), mat(0x8d6e3a));
  box.position.y = 0.3;
  g.add(box);
  const m = mat(0x4caf50, { flatShading: true });
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), m);
    b.position.set((Math.random() - 0.5) * 0.8, 0.8, (Math.random() - 0.5) * 0.8);
    g.add(b);
  }
  return g;
}

function makeMarketStall() {
  const g = new THREE.Group();
  const wood = mat(0x9c6b3f);
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, 1.4), wood);
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
  const stripe = Math.random() < 0.5 ? 0xd23a2a : 0x2a7ad2;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 1.9), mat(stripe));
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
    mat([0x2e7d32, 0xc62828, 0x1565c0, 0xf9a825][Math.floor(Math.random() * 4)])
  );
  board.position.y = 1.9;
  g.add(board);
  return g;
}

function makeBench() {
  const g = new THREE.Group();
  const wood = mat(0x8d6e3a);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 0.7), wood);
  seat.position.y = 0.6;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 0.15), wood);
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
  const r = Math.random();
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
  c.scale.setScalar(0.9 + Math.random() * 0.8);
  c.castShadow = true;
  g.add(c);
  return g;
}

function makeRockProp() {
  const g = new THREE.Group();
  const m = mat(0x9a8a6a, { flatShading: true });
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6 + Math.random() * 1.0, 0), m);
    r.position.set((Math.random() - 0.5) * 2, 0.4, (Math.random() - 0.5) * 2);
    r.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    r.castShadow = true;
    g.add(r);
  }
  return g;
}

function makeHouse() {
  const g = new THREE.Group();
  const palette = [0xd9776a, 0xe0b15a, 0x7aa6c2, 0x9ccc8f, 0xc9bfa8, 0xb98ec2, 0xe8e0d0];
  const w = 5 + Math.random() * 4;
  const d = 5 + Math.random() * 4;
  const floors = 1 + Math.floor(Math.random() * 3);
  const h = floors * 3.2;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(pick(palette)));
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
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.2), m);
    post.position.set(-len / 2 + (i / 3) * len, 0.7, 0);
    g.add(post);
  }
  for (const ry of [0.5, 1.05]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.12), m);
    rail.position.set(0, ry, 0);
    g.add(rail);
  }
  return g;
}

function makeTree(biome) {
  const b = biome || BIOMES[0];
  const g = new THREE.Group();
  const s = 0.9 + Math.random() * 1.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 6), mat(0x6b4a2b));
  trunk.position.y = 1.5 * s;
  trunk.scale.setScalar(s);
  trunk.castShadow = true;
  g.add(trunk);
  let h = b.foliage[0];
  if (b.name === "autumn") h += (Math.random() - 0.5) * 0.12;
  const folCol = new THREE.Color().setHSL(h, b.foliage[1], clamp(b.foliage[2] + (Math.random() - 0.5) * 0.1, 0.14, 0.6));
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
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + Math.random() * 0.6, 0), m);
    b.position.set((Math.random() - 0.5) * 2, 0.7, (Math.random() - 0.5) * 2);
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

function makeCow() {
  const g = new THREE.Group();
  const white = mat(0xf2f2f2);
  const dark = mat(0x3a2f2a);
  const body = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 1.5), white);
  body.position.y = 1.5;
  body.castShadow = true;
  g.add(body);
  const patch = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.62, 1.0), dark);
  patch.position.set(0.6, 1.5, 0);
  g.add(patch);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), white);
  head.position.set(-1.7, 1.7, 0);
  g.add(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), dark);
      leg.position.set(sx * 1.1, 0.75, sz * 0.5);
      g.add(leg);
    }
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
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.6), dark);
  head.position.set(-1.4, 1.5, 0);
  g.add(head);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.1, 0.22), dark);
      leg.position.set(sx * 0.7, 0.55, sz * 0.45);
      g.add(leg);
    }
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
  const body = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 8), red);
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
    const dist = 78 + Math.random() * 30;
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
  _flutterers.push({ obj: pivot, phase: Math.random() * 6.28 });
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
  part(parts, new THREE.BoxGeometry(10, 9, 10).translate(0, 4.5, 0), stone);
  const merlon = (x, z) => part(parts, new THREE.BoxGeometry(1.1, 1.3, 1.1).translate(x, 9.65, z), stone2);
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
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.6), mat(cabCols[i % cabCols.length]));
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
  _spinners.push({ obj: hub, ax: "z", speed: 0.5, phase: Math.random() * 6.28 });
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
  for (let f = 0; f < 3; f++) {
    const flock = new THREE.Group();
    const wings = [];
    const count = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      for (const sx of [-1, 1]) {
        const wg = new THREE.Group();
        const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.9), birdMat);
        wing.position.x = sx * 1.1;
        wg.add(wing);
        bird.add(wg);
        wings.push({ wg, sx, phase: Math.random() * 6.28 });
      }
      bird.position.set((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 18);
      bird.scale.setScalar(0.7 + Math.random() * 0.6);
      flock.add(bird);
    }
    scene.add(flock);
    flocks.push({
      flock,
      wings,
      R: 130 + Math.random() * 170,
      cx: (Math.random() - 0.5) * 320,
      cz: (Math.random() - 0.5) * 320,
      baseY: 85 + Math.random() * 55,
      speed: (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? 1 : -1),
      phase: Math.random() * 6.28,
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

function buildBalloons(scene) {
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
      new THREE.BoxGeometry(3, 3, 3),
      new THREE.MeshStandardMaterial({ color: 0x8d6e3a })
    );
    g.add(basket);

    const a = Math.random() * Math.PI * 2;
    const r = 150 + Math.random() * 300;
    g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    scene.add(g);
    balloons.push({ mesh: g, baseY: 70 + Math.random() * 50, phase: Math.random() * 6.28 });
  }
  return balloons;
}
