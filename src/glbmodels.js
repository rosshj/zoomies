// Imported hero models (GLB) — the artist/AI-authored replacements for the
// procedural cat/kart, loaded via glTF. Each loader normalizes the model into
// the game's conventions (feet on y=0, centred, facing +z, procedural-model
// height) and returns a template Group that callers CLONE per use.
//
// Current status: the Tripo cat export is an untextured clay mesh (no UVs),
// so it gets an interim single fur tint. The textured re-export will carry
// its own baked material and this tint step will be skipped automatically.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

let _catPromise = null;
export function loadCatGLB(url = "./assets/models/cat.glb") {
  if (!_catPromise) {
    _catPromise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      // Normalize scale/origin: match the procedural sitting cat (~3.3 tall,
      // seat base at the origin).
      root.rotation.y = Math.PI; // Tripo exports facing -z; the game's forward is +z
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      root.scale.setScalar(3.3 / size.y);
      const box2 = new THREE.Box3().setFromObject(root);
      const c = box2.getCenter(new THREE.Vector3());
      root.position.set(-c.x, -box2.min.y, -c.z);
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
