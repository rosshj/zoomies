import assert from "node:assert/strict";
import * as T from "three";
import { SceneryLOD, simplifyScenery } from "../src/scenery-lod.js";
import { bakeWorldShelter } from "../src/world-shelter.js";
import { setSeed, rand } from "../src/rng.js";

const geometry = new T.SphereGeometry(3, 32, 20);
geometry.setAttribute(
  "color",
  new T.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(0.8), 3),
);
const original = geometry.attributes.position.array.slice();
const far = simplifyScenery(geometry, 0.6);
assert(far && far.index.count < geometry.index.count * 0.8);
assert.deepEqual(geometry.attributes.position.array, original, "Full-detail source stays intact");
for (const a of Object.values(far.attributes)) assert(a.array.every(Number.isFinite));
for (const i of far.index.array) assert(i < far.attributes.position.count);
assert(
  far.attributes.color.array.every((v) => Math.abs(v - 0.8) < 1e-6),
  "Simplifier preserves baked colors",
);
const nonIndexed = simplifyScenery(geometry.toNonIndexed(), 0.6);
assert(nonIndexed && nonIndexed.index, "Merged structure simplification produces a compact indexed mesh");
const mesh = new T.InstancedMesh(geometry, new T.MeshStandardMaterial(), 2);
mesh.setMatrixAt(0, new T.Matrix4());
mesh.setMatrixAt(1, new T.Matrix4().makeTranslation(12, 0, 0));
geometry.setAttribute("aWindRoot", new T.InstancedBufferAttribute(new Float32Array(6), 3));
const lod = new SceneryLOD();
lod.add(mesh, 0.6, 100);
assert.equal(lod.entries.length, 1);
const nearCamera = { position: new T.Vector3() },
  distant = { position: new T.Vector3(500, 0, 0) };
lod.update([distant]);
assert.notEqual(mesh.geometry, geometry);
assert.equal(mesh.geometry.attributes.aWindRoot, geometry.attributes.aWindRoot);
lod.update([distant, nearCamera]);
assert.equal(mesh.geometry, geometry, "Any split-screen viewer keeps nearby details");
lod.update([{ position: new T.Vector3(114, 0, 0) }]);
assert.equal(mesh.geometry, geometry, "Hysteresis avoids near-boundary toggling");
lod.dispose();
assert.equal(mesh.geometry, geometry);

const scene = new T.Scene(),
  groundGeo = new T.PlaneGeometry(50, 50, 20, 20).rotateX(-Math.PI / 2);
groundGeo.setAttribute(
  "color",
  new T.Float32BufferAttribute(new Float32Array(groundGeo.attributes.position.count * 3).fill(1), 3),
);
const ground = new T.Mesh(groundGeo);
ground.userData.terrainTile = true;
scene.add(ground);
const roof = new T.Mesh(new T.BoxGeometry(10, 0.4, 10), new T.MeshStandardMaterial());
roof.position.y = 3;
const root = new T.Group();
root.userData.staticProp = true;
root.add(roof);
scene.add(root);
setSeed("context");
const expected = rand();
setSeed("context");
bakeWorldShelter(scene);
assert.equal(rand(), expected);
assert(groundGeo.attributes.color.getX(220) < 0.9, "Neighbouring roof shelters ground");
assert(groundGeo.attributes.color.getX(0) > 0.999, "Distant ground stays bright");
const colors = groundGeo.attributes.color.array.slice();
bakeWorldShelter(scene);
assert.deepEqual(groundGeo.attributes.color.array, colors, "No repeated darkening");
assert(scene.userData.worldShelter.shaded > 0);
// Receivers sharing one geometry (roadside canopies come from foliageGeoFor's
// cache) must each get their own copy: the cached buffer stays untouched and no
// tree carries its neighbours' shelter.
{
  const shared = new T.SphereGeometry(2, 8, 6);
  shared.setAttribute(
    "color",
    new T.Float32BufferAttribute(new Float32Array(shared.attributes.position.count * 3).fill(1), 3),
  );
  shared.userData.sharedCache = true;
  const forest = new T.Scene(),
    trees = [];
  for (const x of [-3, 3]) {
    const tree = new T.Group();
    tree.userData.staticProp = true;
    const canopy = new T.Mesh(shared, new T.MeshStandardMaterial({ vertexColors: true }));
    canopy.position.set(x, 4, 0);
    tree.add(canopy);
    forest.add(tree);
    trees.push(canopy);
  }
  const slab = new T.Mesh(new T.BoxGeometry(12, 0.4, 12), new T.MeshStandardMaterial());
  slab.position.y = 8;
  const cover = new T.Group();
  cover.userData.staticProp = true;
  cover.add(slab);
  forest.add(cover);
  bakeWorldShelter(forest);
  assert(
    shared.attributes.color.array.every((v) => v === 1),
    "Shared cached geometry is never darkened in place",
  );
  assert(trees[0].geometry !== shared && trees[1].geometry !== shared, "Each receiver bakes into its own copy");
  assert(trees[0].geometry !== trees[1].geometry, "Copies are per mesh");
  assert(
    trees.every((m) => m.geometry.attributes.color.array.some((v) => v < 0.999)),
    "The copies still receive the slab's shelter",
  );
}
// A moving child must not receive a frozen neighbour bake.
const movingScene = new T.Scene(),
  a = new T.Group();
a.userData.staticProp = true;
const hinge = new T.Group();
hinge.userData.keepLive = true;
const movingGeo = new T.BoxGeometry(2, 2, 2);
movingGeo.setAttribute(
  "color",
  new T.Float32BufferAttribute(new Float32Array(movingGeo.attributes.position.count * 3).fill(1), 3),
);
hinge.add(new T.Mesh(movingGeo, new T.MeshStandardMaterial()));
a.add(hinge);
movingScene.add(a);
const shade = new T.Group();
shade.userData.staticProp = true;
const shadeMesh = new T.Mesh(new T.BoxGeometry(6, 0.5, 6));
shadeMesh.position.y = 2;
shade.add(shadeMesh);
movingScene.add(shade);
bakeWorldShelter(movingScene);
assert(movingGeo.attributes.color.array.every((v) => v === 1));
console.log(
  JSON.stringify({
    checks:
      "LOD reduction, source immutability, finite attributes/indices, baked colors, wind attributes, multiple cameras, hysteresis, disposal, neighbouring shelter, distant exposure, RNG, idempotence",
    world: scene.userData.worldShelter,
  }),
);
