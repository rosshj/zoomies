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
      return holder;
    });
  }
  return _kartPromise;
}
