// Independent mesh-ray probes check actual art, including lids/bands, on curved
// and sloped road triangles. Run under Node; no browser or physics engine needed.
import assert from 'node:assert/strict';
import * as T from 'three';
import { PropPhysics } from '../src/prop-physics.js';
import { makeCrateProp, makeBarrelProp } from '../src/props.js';
function trackFixture(hills = true, crossing = false) {
  const samples = 240, halfWidth = 9, radius = 70, _pts = [], _tans = [];
  for (let i = 0; i < samples; i++) {
    const a = i / samples * Math.PI * 2;
    _pts.push(new T.Vector3(Math.sin(a) * radius, crossing ? 12 * Math.cos(a) : hills ? 8 * Math.sin(a * 3) : 0,
      crossing ? Math.sin(a * 2) * radius : Math.cos(a) * radius));
  }
  for (let i = 0; i < samples; i++) _tans.push(_pts[(i + 1) % samples].clone().sub(_pts[(i - 1 + samples) % samples]).normalize());
  const positions = [], index = [];
  for (let i = 0; i <= samples; i++) {
    const p = _pts[i % samples], side = new T.Vector3().crossVectors(_tans[i % samples], new T.Vector3(0, 1, 0)).normalize();
    for (let j = 0; j <= 10; j++) { const v = p.clone().addScaledVector(side, -halfWidth + j / 10 * halfWidth * 2); positions.push(v.x, v.y + .02, v.z); }
    if (i < samples) for (let j = 0; j < 10; j++) { const a = i * 11 + j, b = a + 11; index.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setIndex(index); geometry.computeVertexNormals();
  const length = _pts.reduce((v, p, i) => v + p.distanceTo(_pts[(i + 1) % samples]), 0);
  return { samples, length, halfWidth, _pts, _tans, roadSurface: { geometry, rowWidth: 11 } };
}
const ray = new T.Raycaster(), origin = new T.Vector3(), down = new T.Vector3(0, -1, 0);
let poses = 0, vertices = 0, sideLandings = 0, worstStepMs = 0;
const restingPoses = new Map();
for (const crossing of [false, true]) for (const hills of [false, true]) {
  if (crossing && !hills) continue;
  const track = trackFixture(hills, crossing), physics = new PropPhysics(track);
  const road = new T.Mesh(track.roadSurface.geometry, new T.MeshBasicMaterial({ side: T.DoubleSide })); road.updateMatrixWorld();
  for (const kind of ['crate', 'barrel']) for (const dt of [1 / 30, 1 / 60, 1 / 120]) for (const start of [0, 59, 120, 238]) {
    const built = (kind === 'crate' ? makeCrateProp : makeBarrelProp)(() => .6), pos = track._pts[start].clone();
    const pr = { mesh: built.mesh, pos, quat: new T.Quaternion(), vel: new T.Vector3(), angVel: new T.Vector3(), asleep: false, settle: false, kind };
    physics.prepare(pr, built.hull, start);
    const art = [];
    built.mesh.updateMatrixWorld(true);
    // Preserve model-local vertices for an independent art-vs-road check.
    built.mesh.traverse(o => { if (o.isMesh) { o.updateMatrix(); const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i++) art.push(new T.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrix)); } });
    const unique = [...new Map(art.map(p => [p.toArray().map(v => v.toFixed(5)).join(','), p])).values()];
    const verify = () => {
      // Narrow the independent raycast to this strand's nearby rendered faces.
      const indices = [], full = track.roadSurface.geometry.index;
      for (let row = pr.roadIndex - 3; row <= pr.roadIndex + 3; row++) {
        const start = ((row + track.samples) % track.samples) * 60;
        for (let i = start; i < start + 60; i++) indices.push(full.getX(i));
      }
      const localGeo = new T.BufferGeometry();
      localGeo.setAttribute('position', track.roadSurface.geometry.attributes.position); localGeo.setIndex(indices);
      road.geometry = localGeo;
      poses++;
      for (const p of unique) {
        const v = p.clone().applyQuaternion(pr.quat).add(pr.pos);
        // Bound the ray to this road level, excluding a crossing's upper deck.
        origin.set(v.x, track._pts[pr.roadIndex].y + 5, v.z); ray.set(origin, down); ray.far = 12;
        const hits = ray.intersectObject(road);
        if (hits.length) { assert(v.y >= hits[0].point.y - .003, `${kind} road penetration ${hits[0].point.y - v.y}, row ${pr.roadIndex}`); vertices++; }
        const local = physics.locate(pr, v.x, v.z);
        assert(Math.abs(local.lateral) < track.halfWidth + .02, `${kind} crossed fence`);
      }
      localGeo.dispose();
      assert(Number.isFinite(pr.pos.y) && Math.abs(pr.quat.length() - 1) < 1e-6);
    };
    verify();
    // High-speed diagonal launch into the fence, with an arbitrary tumble.
    const side = new T.Vector3().crossVectors(track._tans[start], new T.Vector3(0, 1, 0)).normalize();
    pr.vel.copy(track._tans[start]).multiplyScalar(65).addScaledVector(side, 95); pr.vel.y = 12;
    pr.angVel.set(14, 7, -18); pr.asleep = false;
    for (let f = 0; f < Math.ceil(12 / dt); f++) {
      const before = performance.now(); physics.step(pr, dt); worstStepMs = Math.max(worstStepMs, performance.now() - before);
      if (f % 16 === 0 || pr.asleep) verify();
      if (pr.asleep) break;
    }
    assert(pr.asleep && !pr.settle, `${kind} failed to sleep at ${dt}, v=${pr.vel.length()}, spin=${pr.angVel.length()}`);
    if (kind === 'barrel' && Math.abs(new T.Vector3(0, 1, 0).applyQuaternion(pr.quat).dot(physics.normal)) < .2) sideLandings++;
    const poseKey = `${crossing}:${hills}:${kind}:${start}`, previous = restingPoses.get(poseKey);
    if (previous) {
      assert(pr.pos.distanceTo(previous.pos) < .001 && pr.quat.angleTo(previous.quat) < .001, 'Frame rate changed resting pose');
    } else restingPoses.set(poseKey, { pos: pr.pos.clone(), quat: pr.quat.clone() });
    const resting = pr.pos.clone(), rotation = pr.quat.clone();
    physics.height = new Proxy(physics.height, { apply() { throw Error('Sleeping prop queried road'); } });
    physics.step(pr, dt); assert(pr.pos.equals(resting) && pr.quat.equals(rotation));
    delete physics.height;
  }
}
assert(sideLandings > 0, 'Barrels never rest on their sides');
console.log(JSON.stringify({ poses, checkedArtVertices: vertices, sideLandings, worstSingleStepMs: worstStepMs, checks: 'slopes, curves, lap seam, stacked strands, high-speed fence impacts, 30/60/120 Hz, stable sleep, full art bounds' }));
const workloads = [];
for (const count of [1, 8, 64]) {
  const track = trackFixture(), physics = new PropPhysics(track), bodies = [];
  for (let i = 0; i < count; i++) {
    const built = (i % 2 ? makeBarrelProp : makeCrateProp)(() => .5), start = Math.floor(i * track.samples / count);
    const pr = { mesh: built.mesh, pos: track._pts[start].clone(), quat: new T.Quaternion(), vel: new T.Vector3(), angVel: new T.Vector3(), asleep: false, settle: false, kind: i % 2 ? 'barrel' : 'crate' };
    physics.prepare(pr, built.hull, start); bodies.push(pr);
  }
  const times = [];
  for (let frame = 0; frame < 360; frame++) {
    if (frame % 60 === 0) for (const pr of bodies) { pr.asleep = pr.settle = false; pr.quiet = 0; pr.vel.set(25, 10, 40); pr.angVel.set(14, 7, -18); }
    const t = performance.now(); for (const pr of bodies) physics.step(pr, 1 / 60);
    if (frame >= 60) times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  workloads.push({ forcedActive: count, medianMs: times[times.length >> 1], p99Ms: times[Math.floor(times.length * .99)] });
}
console.log(JSON.stringify({ workloads, note: 'Node solver-only stress timing, excludes rendering; all bodies relaunched every second' }));
