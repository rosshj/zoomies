// Imported hero models (GLB) — the artist/AI-authored replacements for the
// procedural cat/kart, loaded via glTF. Each loader normalizes the model into
// the game's conventions (feet on y=0, centred, facing +z, procedural-model
// size) and returns a template Group that callers CLONE per use.
//
// Current status: the Tripo cat export is an untextured clay mesh (no UVs),
// so it gets an interim single fur tint. The kart export is textured and
// arrives in parts (4 wheels + steering wheel + chassis), which the loader
// tags in userData so callers can spin/steer them.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Feet-on-ground, centred, sized: the shared normalization every import gets.
// axis: which bbox axis the target size measures.
function normalize(root, { size, axis = "y" }) {
  const box = new THREE.Box3().setFromObject(root);
  const dims = box.getSize(new THREE.Vector3());
  root.scale.setScalar(size / dims[axis]);
  const box2 = new THREE.Box3().setFromObject(root);
  const c = box2.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box2.min.y, -c.z);
}

let _catPromise = null;
export function loadCatGLB(url = "./assets/models/cat.glb") {
  if (!_catPromise) {
    _catPromise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      // Match the procedural sitting cat: ~3.3 tall, seat base at the origin.
      root.rotation.y = Math.PI; // Tripo exports facing -z; the game's forward is +z
      normalize(root, { size: 3.3, axis: "y" });
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false; // karts/cats ride the blob shadow, not the sun map
        // Clay (no texture/UVs) → interim fur tint so it reads in previews.
        if (!o.material?.map) {
          o.material = new THREE.MeshStandardMaterial({ color: 0xf0a830, roughness: 0.92 });
        }
      });
      const holder = new THREE.Group();
      holder.add(root);
      return holder;
    });
  }
  return _catPromise;
}

// Plane normal of a flat-ish mesh (a steering wheel disc): the least-spread
// PCA axis of its vertex positions. Power iteration on (trace(C)·I − C) —
// its dominant eigenvector is C's smallest — avoids a full eigen solve.
function discNormal(geometry) {
  const p = geometry.getAttribute("position").array;
  const n = p.length / 3;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < p.length; i += 3) { mx += p[i]; my += p[i + 1]; mz += p[i + 2]; }
  mx /= n; my /= n; mz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - mx, y = p[i + 1] - my, z = p[i + 2] - mz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const tr = xx + yy + zz;
  // M = tr·I − C
  const m = [tr - xx, -xy, -xz, -xy, tr - yy, -yz, -xz, -yz, tr - zz];
  const v = new THREE.Vector3(0.577, 0.577, 0.577);
  for (let it = 0; it < 32; it++) {
    v.set(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z,
    ).normalize();
  }
  return v;
}

let _kartPromise = null;
export function loadKartGLB(url = "./assets/models/kart.glb") {
  if (!_kartPromise) {
    _kartPromise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;

      // Identify the parts from their pivots, in the source space (the Tripo
      // kart faces +x; axles run along z). No name matching — Tripo's part ids
      // change per generation, but the layout is stable: the steering wheel
      // pivots highest, the four road wheels pivot low in ±z pairs, and
      // whatever remains is chassis.
      const parts = [];
      root.traverse((o) => { if (o.isMesh) parts.push(o); });
      const steering = parts.reduce((a, b) => (b.position.y > a.position.y ? b : a));
      const wheels = parts
        .filter((n) => n !== steering && Math.abs(n.position.z) > 0.05)
        .sort((a, b) => b.position.x - a.position.x) // front pair (near the steering wheel, +x) first
        .slice(0, 4);

      root.rotation.y = -Math.PI / 2; // source +x (nose) → game +z
      normalize(root, { size: 4.1, axis: "z" }); // match the procedural kart footprint

      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        // The retopologized shell can have hairline tears (nose cowl);
        // double-sided fill hides them for a trivial cost on one hero model.
        if (o.material) o.material.side = THREE.DoubleSide;
      });

      const holder = new THREE.Group();
      holder.add(root);
      // Wheel spin axis is the source-space z (axle), steering is y — order
      // "YZX" keeps steer as the outer rotation, roll inner. Same contract as
      // the procedural kart's wheels array: fronts first.
      for (const w of wheels) w.rotation.order = "YZX";
      holder.userData.wheels = wheels;
      holder.userData.steering = steering;
      // The steering wheel must turn about its own tilted column, not a world
      // axis. The column axis is the disc's plane normal: the direction of
      // least positional spread (smallest PCA axis) of the rim geometry,
      // in the part's local space. Sign: toward the driver (-x, +y source
      // space), so a positive angle turns the wheel the way the road wheels
      // turn for a left steer.
      holder.userData.steeringAxis = discNormal(steering.geometry).normalize();
      if (holder.userData.steeringAxis.x > 0) holder.userData.steeringAxis.negate();
      return holder;
    });
  }
  return _kartPromise;
}
