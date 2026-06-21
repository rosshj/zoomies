import * as THREE from "three";

// Builds the world around the track: rolling hills, distant mountains, a small
// town of buildings, forests, rocks and a few drifting hot-air balloons.
// Returns { update(time) } for the animated bits.
export function buildWorld(scene, track) {
  const roadClear = track.halfWidth + 10; // keep scenery off the tarmac

  // Big rolling hills.
  const rawHeight = (x, z) =>
    40 * Math.sin(x * 0.004 + 0.5) * Math.cos(z * 0.0035) +
    22 * Math.sin(x * 0.011 - 1.2) * Math.cos(z * 0.013 + 0.7) +
    9 * Math.sin(x * 0.03) * Math.sin(z * 0.025 + 2.1);

  const flatten = (d) => {
    const start = roadClear;
    const end = roadClear + 55;
    if (d <= start) return 0;
    if (d >= end) return 1;
    const u = (d - start) / (end - start);
    return u * u * (3 - 2 * u); // smoothstep
  };

  // The track now has elevation, so blend the terrain from the road's height
  // (right next to the tarmac) out to the big hills, instead of to a flat 0.
  const heightAt = (x, z) => {
    const gi = track.groundInfo(x, z);
    const f = flatten(gi.dist);
    // Sit just below the road/shoulder near the track to avoid z-fighting.
    return gi.y * (1 - f) + rawHeight(x, z) * f - 0.25;
  };

  buildTerrain(scene, heightAt);
  buildMountains(scene, heightAt);
  buildTrees(scene, track, heightAt, flatten);
  buildRocks(scene, track, heightAt, flatten);
  buildRoadside(scene, track, heightAt); // town & farm zones lining the road
  const balloons = buildBalloons(scene);

  return {
    update(time) {
      for (const b of balloons) {
        b.mesh.position.y = b.baseY + Math.sin(time * 0.5 + b.phase) * 4;
        b.mesh.rotation.y = time * 0.1 + b.phase;
      }
    },
  };
}

function buildTerrain(scene, heightAt) {
  const SIZE = 1500;
  const SEG = 256;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];
  const cGrass = new THREE.Color(0x4f9d3a);
  const cGrass2 = new THREE.Color(0x3c7a2e);
  const cRock = new THREE.Color(0x7a6f5d);
  const cSnow = new THREE.Color(0xf4f7fb);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);

    let c;
    if (y < 3) c = cGrass.clone().lerp(cGrass2, Math.random() * 0.4);
    else if (y < 32) c = cGrass2.clone().lerp(cRock, (y - 3) / 29);
    else if (y < 52) c = cRock.clone();
    else c = cRock.clone().lerp(cSnow, Math.min(1, (y - 52) / 14));
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

function buildMountains(scene, heightAt) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x6d6253, flatShading: true, roughness: 1 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, flatShading: true, roughness: 1 });
  const count = 18;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
    const r = 640 + Math.random() * 140;
    const h = 170 + Math.random() * 150;
    const rad = 90 + Math.random() * 70;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const base = heightAt(x, z) + h / 2 - 30; // bury the base in the terrain
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), mat);
    m.position.set(x, base, z);
    m.rotation.y = Math.random() * Math.PI;
    scene.add(m);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.4, h * 0.3, 7), snow);
    cap.position.set(x, base + h * 0.5 - h * 0.15, z);
    cap.rotation.y = m.rotation.y;
    scene.add(cap);
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
  const spots = scatter(170, track, flatten, 0.55, 1300)
    .map((s) => ({ ...s, y: heightAt(s.x, s.z) }))
    .filter((s) => s.y <= 28); // no trees on the snowy peaks
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 3, 6);
  const foliageGeo = new THREE.ConeGeometry(2.4, 6, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 1, flatShading: true });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, spots.length);
  foliage.castShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const foliageColor = new THREE.Color();

  spots.forEach((spot, i) => {
    const y = spot.y;
    const scale = 0.8 + Math.random() * 1.4;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);

    p.set(spot.x, y + 1.5 * scale, spot.z);
    s.set(scale, scale, scale);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);

    p.set(spot.x, y + (3 + 3) * scale, spot.z);
    m.compose(p, q, s);
    foliage.setMatrixAt(i, m);
    foliage.setColorAt(i, foliageColor.setHSL(0.32, 0.5, 0.3 + Math.random() * 0.18));
  });
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  trunks.layers.set(1); // excluded from the rear-view mirror render
  foliage.layers.set(1);
  scene.add(trunks);
  scene.add(foliage);
}

function buildRocks(scene, track, heightAt, flatten) {
  const spots = scatter(90, track, flatten, 0.4, 1300);
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
    const prop = builder();
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
        if (Math.random() < 0.55 + density * 0.4)
          place(() => makeBuilding(false, density), halfW + 5 + Math.random() * 2.5, dir, p, side, true);
        if (Math.random() < 0.25 + density * 0.4)
          place(() => makeBuilding(true, density), halfW + 15 + Math.random() * 9, dir, p, side, true);
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
  const cols = 6;
  const rows = 9;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const lit = Math.random();
      const v = lit < 0.45 ? Math.floor(120 + Math.random() * 135) : 18;
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.85)},${Math.floor(v * 0.5)})`;
      ctx.fillRect(4 + col * 10, 4 + r * 8, 6, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (_windowTex = t);
}

const BUILDING_PALETTE = [0xc7b9a6, 0xd9a77a, 0xb7c2cf, 0x9fb6a0, 0xcabfb0, 0xb59fb0, 0xd8cbb0];

function makeBuilding(tall, density) {
  const g = new THREE.Group();
  const w = 5 + Math.random() * 4;
  const d = 5 + Math.random() * 4;
  let floors = 1 + Math.floor(Math.random() * (tall ? 4 : 2) + density * 2.5);
  floors = Math.min(floors, tall ? 8 : 4);
  const h = floors * 3.0;

  const wall = BUILDING_PALETTE[Math.floor(Math.random() * BUILDING_PALETTE.length)];
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color: wall,
      roughness: 0.92,
      emissive: 0xffd27a,
      emissiveMap: windowTexture(),
      emissiveIntensity: 0.9,
    })
  );
  body.position.y = h / 2;
  body.receiveShadow = true; // not castShadow: too many to be worth the pass
  g.add(body);

  if (tall) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.7, d * 1.04), mat(0x4a4a52));
    cap.position.y = h + 0.35;
    g.add(cap);
  } else {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.8, 2.4, 4), mat(0x6d4c41));
    roof.position.y = h + 1.2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);
  }
  return g;
}

function makeStreetProp() {
  const r = Math.random();
  if (r < 0.45) return makeLamp();
  if (r < 0.7) return makeBench();
  if (r < 0.88) return makeHydrant();
  return makeBush();
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

function makeFarmProp() {
  const r = Math.random();
  if (r < 0.22) return makeTree();
  if (r < 0.42) return makeBush();
  if (r < 0.56) return makeCow();
  if (r < 0.7) return makeSheep();
  if (r < 0.82) return makeHayBale();
  if (r < 0.92) return makeFence(0x8d6e3a);
  return makeBarn();
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

function makeTree() {
  const g = new THREE.Group();
  const s = 0.9 + Math.random() * 1.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 6), mat(0x6b4a2b));
  trunk.position.y = 1.5 * s;
  trunk.scale.setScalar(s);
  trunk.castShadow = true;
  g.add(trunk);
  const fol = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, 6, 7),
    mat(0x2e7d32, { flatShading: true })
  );
  fol.position.y = 6 * s;
  fol.scale.setScalar(s);
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
