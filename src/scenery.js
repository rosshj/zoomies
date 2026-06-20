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
  buildTown(scene, track, heightAt);
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
  const SEG = 220;
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
  const spots = scatter(260, track, flatten, 0.55, 1300)
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
