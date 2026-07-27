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
import { uniform, time, vec2, vec3, attribute, positionLocal, positionGeometry } from "three/tsl";

export const uWindDir = uniform(new THREE.Vector2(0.82, 0.57)); // unit XZ, points DOWNWIND
export const uWindStr = uniform(1); // overall force; weather scales it
export const uWindSpeed = uniform(0.9); // how fast gust fronts travel

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
export function windLean(px, pz, amp) {
  const { gust, along } = gustAt(px, pz);
  const lean = gust.mul(0.42).add(0.58).mul(uWindStr).mul(amp);
  const cross = along.mul(0.043).add(_phase.mul(1.6)).cos().mul(0.2).mul(uWindStr).mul(amp);
  return vec2(
    uWindDir.x.mul(lean).sub(uWindDir.y.mul(cross)),
    uWindDir.y.mul(lean).add(uWindDir.x.mul(cross))
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
export function windBendNode(amp) {
  const root = attribute("aWindRoot");
  const w = attribute("aBend");
  const tall = w.mul(root.z).max(0.001); // the object's height in WORLD units
  const norm = positionGeometry.y.div(w.max(0.001)).clamp(0, 1); // 0 base -> 1 crown
  const reach = norm.mul(norm).mul(tall); // world units at amp = 1
  const lean = windLean(root.x, root.y, amp); // aWindRoot is (x, z, scale)
  const ox = lean.x.mul(reach);
  const oz = lean.y.mul(reach);
  const oy = ox.mul(ox).add(oz.mul(oz)).mul(-0.5).div(tall);
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

// Point the wind somewhere and set its force. Called once per world build (each
// track gets its own prevailing wind from the seed); weather can lean on it too.
export function setWind({ dirRad, strength, speed } = {}) {
  if (dirRad != null) uWindDir.value.set(Math.sin(dirRad), Math.cos(dirRad));
  if (strength != null) uWindStr.value = strength;
  if (speed != null) uWindSpeed.value = speed;
}
