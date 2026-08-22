// The world's wind — ONE source of truth for everything that blows.
//
// Grass, canopies, petals and debris each used to wiggle on their own private
// clock, which reads as a lot of independent twitching rather than a place with
// weather in it. They all sample this field instead: a direction, plus a gust
// wave that TRAVELS along that direction, so a single gust visibly sweeps
// across the meadow, on through the trees and away down the road.
//
// It is all node graphs hanging off `time`, so there is no per-frame CPU tick,
// no uniform upload, and nothing anyone can forget to update — the field is
// live the moment a material reads it.
import * as THREE from "three";
import { uniform, time, vec2, vec3, vec4, attribute, positionLocal, positionGeometry, modelWorldMatrix, modelWorldMatrixInverse } from "three/tsl";

export const uWindDir = uniform(new THREE.Vector2(0.82, 0.57)); // unit XZ, points DOWNWIND
export const uWindStr = uniform(1); // force felt by things that BEND
export const uWindAir = uniform(1); // force felt by things that are CARRIED
export const uWindSpeed = uniform(0.9); // how fast gust fronts travel
// Where the player's kart is, and how hard it shoves: (world x, y, z, push),
// where push is ~0.25 at rest rising to ~1.1 flat out.
// Lives here rather than on any one material because more than one thing now
// reacts to the kart — the grass parts around it, the petals flurry up in its
// wake — and they must all read the SAME position. main.js writes it once a
// frame via the handle buildGrass hangs on the roadside-cover group.
export const uKartPos = uniform(new THREE.Vector4(1e6, 0, 1e6, 0));

const _phase = time.mul(uWindSpeed);

// Signed gust strength at a world XZ, -1..1. Two travelling waves — a long slow
// roller and a finer chop — plus a cross-wise term so gust fronts arrive at a
// slight angle instead of as dead-straight ranks.
function gustAt(px, pz) {
  const along = px.mul(uWindDir.x).add(pz.mul(uWindDir.y));
  const across = px.mul(uWindDir.y).sub(pz.mul(uWindDir.x));
  const g1 = along.mul(0.017).add(across.mul(0.006)).sub(_phase).sin();
  const g2 = along.mul(0.071).add(across.mul(0.028)).sub(_phase.mul(2.4)).sin();
  return { gust: g1.mul(0.62).add(g2.mul(0.38)), along };
}

// World-XZ lean for something rooted at (px, pz). `amp` is a FRACTION OF THE
// OBJECT'S OWN HEIGHT, so the same number bends a grass blade and an oak by the
// same angle. Always leans downwind — gusts only vary how hard — with a small
// cross-wind wobble so a field never looks like one rigid shove.
// `maxStr` (optional) caps the force THIS caller feels: a stiff tree doesn't
// respond linearly to a gale the way grass does, so canopies pass ~1.45 and
// keep their ordinary-wind motion while storm-seed peaks (uWindStr can reach
// 2.4) stop flinging the crown around. Capping strength rather than amp keeps
// gust timing and the lean/wobble ratio identical — it only flattens the top.
export function windLean(px, pz, amp, maxStr = null) {
  const str = maxStr != null ? uWindStr.min(maxStr) : uWindStr;
  const { gust, along } = gustAt(px, pz);
  const lean = gust.mul(0.42).add(0.58).mul(str).mul(amp);
  const cross = along.mul(0.043).add(_phase.mul(1.6)).cos().mul(0.2).mul(str).mul(amp);
  return vec2(
    uWindDir.x.mul(lean).sub(uWindDir.y.mul(cross)),
    uWindDir.y.mul(lean).add(uWindDir.x.mul(cross))
  );
}

// World-space drift for something AIRBORNE, hovering around a home point.
// Where windLean BENDS something rooted, this CARRIES something loose: the
// travelling gust shoves the mote downwind and it eases back as the front goes
// by, so a whole field of tumbleweeds surges together instead of each one
// jiggling on its own private clock. Staying anchored to a home point (rather
// than translating forever and wrapping) is what keeps the motion snap-free.
//
// `amp` is in world units. `jitter` is a per-mote 0..1 node (hash the instance
// index) so they aren't in perfect lockstep. `lift` adds a hop on the gust —
// a tumbleweed should bounce when it's actually being shoved.
export function windGustDrift(px, pz, amp, jitter, lift = 0) {
  const { gust } = gustAt(px, pz);
  const ph = jitter.mul(6.2832);
  const own = ph.add(_phase.mul(1.7)).sin(); // the mote's own small wander
  // Airborne motes read uWindAir, not uWindStr. A bend is self-limiting — a
  // tree runs out of tree — but this offset is SIGNED and unbounded, so at
  // storm strength a linear response walked tumbleweeds ~17u off their home
  // point and back. See windToward for the two curves.
  const g = gust.mul(0.72).add(own.mul(0.28)).mul(uWindAir);
  const cross = ph.add(_phase.mul(0.9)).cos().mul(0.38).mul(uWindAir);
  return vec3(
    uWindDir.x.mul(g).sub(uWindDir.y.mul(cross)).mul(amp),
    g.abs().mul(lift),
    uWindDir.y.mul(g).add(uWindDir.x.mul(cross)).mul(amp)
  );
}

// A positionNode for anything PLANTED in the ground: rooted at its base, bowing
// downwind, never stretching. Needs two attributes on the geometry:
//   aBend      per-vertex float — the object's own geometry height, so one
//              shared material can serve several shapes at once
//   aWindRoot  per-instance vec3 — (world x, world z, instance height scale)
//
// Note what is NOT here: any rotation by the instance's yaw. On an
// InstancedMesh three folds the instance matrix into positionLocal BEFORE a
// material's positionNode runs, so an offset added here lands in world space
// already (these meshes sit at the origin) — rotating it would send every tree
// leaning a different way and undo the whole point of a shared wind. For the
// same reason the height has to come off positionGeometry: positionLocal.y is
// the vertex's WORLD height by this point, and squaring that for the bend
// weight throws the object into the distance.
//
// Same length-preserving arc the grass uses: lean a tip out by s and it loses
// ~s²/2 of reach, so the crown bows over its trunk instead of growing taller.
export function windBendNode(amp, maxStr = null) {
  const root = attribute("aWindRoot");
  const w = attribute("aBend");
  const tall = w.mul(root.z).max(0.001); // the object's height in WORLD units
  const norm = positionGeometry.y.div(w.max(0.001)).clamp(0, 1); // 0 base -> 1 crown
  const reach = norm.mul(norm).mul(tall); // world units at amp = 1
  const lean = windLean(root.x, root.y, amp, maxStr); // aWindRoot is (x, z, scale)
  const ox = lean.x.mul(reach);
  const oz = lean.y.mul(reach);
  const oy = ox.mul(ox).add(oz.mul(oz)).mul(-0.5).div(tall);
  return positionLocal.add(vec3(ox, oy, oz));
}

// The same bend for a NON-instanced mesh — a bush, a hedge, anything placed as
// its own object rather than as one of thousands. Two differences follow from
// that, and both are the mirror image of the instanced case:
//   • there is no instance matrix folded into positionLocal, so an offset added
//     here is in the object's LOCAL space and the world-space lean has to be
//     rotated INTO it (w=0 in the vec4 so only the rotation applies, not the
//     translation);
//   • the object's world position comes off its own world matrix rather than a
//     per-instance attribute.
// Still needs `aBend` baked on the geometry. Wire it with userData.swayLoose.
//
// NOT YET USED BY ANYTHING. The obvious customer is the roadside bushes, but
// they never reach the scene as the plain per-object meshes makeBush returns —
// a probe looking for non-instanced geometry carrying aBend found none, so
// something downstream merges or rebuilds them. Finding out what is its own
// pass; until then treat this as untested and verify it renders before
// believing it.
export function windBendLooseNode(amp) {
  const h = attribute("aBend").max(0.001); // geometry height
  const norm = positionGeometry.y.div(h).clamp(0, 1); // 0 base -> 1 crown
  const reach = norm.mul(norm).mul(h);
  const org = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz; // where it stands
  const lean = windLean(org.x, org.z, amp);
  const loc = modelWorldMatrixInverse.mul(vec4(lean.x, 0, lean.y, 0)).xyz;
  const ox = loc.x.mul(reach);
  const oz = loc.z.mul(reach);
  const oy = ox.mul(ox).add(oz.mul(oz)).mul(-0.5).div(h);
  return positionLocal.add(vec3(ox, oy, oz));
}

// Bake the `aBend` attribute a windBendNode material expects: the geometry's
// own height, which the shader normalises positionGeometry.y against. That pins
// the object at its origin — for a canopy that is the trunk top, exactly where
// a tree should pivot — and puts the full lean at its crown.
export function bakeBendWeights(geo) {
  const pos = geo.attributes.position;
  let maxY = 0;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  if (maxY <= 0) maxY = 1;
  geo.setAttribute("aBend", new THREE.BufferAttribute(new Float32Array(pos.count).fill(maxY), 1));
  return geo;
}

// The force in uWindStr is two things multiplied: the track's own prevailing
// wind (drawn from the seed at world build, so worlds differ) and the biome
// factor the player is currently driving through (eased below).
let _base = 1;
let _baseSpeed = 0.9;
let _biome = 1;

// Point the wind somewhere and set the track's prevailing force. Called once
// per world build.
export function setWind({ dirRad, strength, speed } = {}) {
  if (dirRad != null) uWindDir.value.set(Math.sin(dirRad), Math.cos(dirRad));
  if (strength != null) _base = strength;
  if (speed != null) _baseSpeed = speed;
  if (speed != null) uWindSpeed.value = _baseSpeed;
  _write();
}

// Diminishing returns on force. The track's seeded wind MULTIPLIES the biome's,
// so a gusty seed in an alpine pass was reaching ~3.0 — the value the gale A/B
// used as its deliberately-overdone upper bound, except permanently, and only
// on some tracks, which is exactly the "sometimes it goes crazy" this fixes.
// Normalised so ordinary wind (1) still comes out at 1 and only the top end is
// pulled in: 2.5 -> 1.73, and it can never pass 2.4 however the dice fall.
const K = 2.4;
const soften = (x) => (x * (1 + 1 / K)) / (1 + x / K);
function _write() {
  const soft = soften(_base * _biome);
  uWindStr.value = soft;
  // Carried things get the gentler curve again. A bend is self-limiting; a
  // loose mote's displacement is not, so it must not track force one-for-one.
  uWindAir.value = Math.sqrt(soft);
}

// Ease the wind toward whatever the biome under the player asks for, and write
// the combined force. Called every frame from the race loop, right beside the
// weather crossfade — driving out of a still desert into a snowbound pass
// should feel like the weather closing in, which means it has to arrive over
// seconds, not snap at the biome seam. Gusts also travel faster in a blow, so
// the rhythm quickens with the force rather than the field just scaling up.
export function windToward(target, dt) {
  _biome += (target - _biome) * Math.min(1, dt * 0.55);
  _write();
  uWindSpeed.value = _baseSpeed * (0.72 + 0.28 * _biome);
}
