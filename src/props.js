// Knockable roadside props (crates, barrels, leaf piles). These use a small custom
// physics integrator rather than a full engine: each prop is clamped to the actual
// road surface every frame (so it never floats or falls through the curved/sloped
// track), bounces off the ground and the barriers, and tumbles when launched. The
// kart isn't simulated — when it drives near a prop we fling the prop along its
// motion. Cosmetic + local (placement is seeded, so a lobby sees the same props;
// their tumble is local, so multiplayer needs no physics sync).
import * as THREE from "three";
import { makeRng } from "./rng.js";
import { mergeMeshes } from "./models.js";
import { shadowTexture } from "./kart.js"; // same blob the karts project, so shadows match

export async function initProps(scene, track, opts = {}) {
  try {
    return build(scene, track, opts);
  } catch (e) {
    console.warn("[zoomies] knockable props disabled:", e);
    return null;
  }
}

const GRAV = 30;
// Leaves are light: weak gravity so they hang and flutter rather than drop, and
// a wake (wind) that lingers a beat after the kart passes.
const LEAF_GRAV = 8.5; // much gentler than crates/barrels — leaves drift down
const LEAF_AIRDRAG = 2.4; // how strongly the wake carries a leaf toward its wind speed
const WIND_TAU = 0.75; // wake e-folding time (s): ~2s of visible linger

// The crate/barrel art, at module scope so the asset viewer can show the exact
// meshes the game scatters. Materials are shared across every instance (same
// objects build() always used — they just live here now). `rand` is injected:
// build() passes its seeded rng so placement runs stay deterministic; the
// viewer just uses Math.random.
const woodMat = new THREE.MeshStandardMaterial({ color: 0xb5803f, roughness: 0.85 });
const woodTop = new THREE.MeshStandardMaterial({ color: 0xcd9a55, roughness: 0.85 });
const barrelMat = new THREE.MeshStandardMaterial({ color: 0xc24a3a, roughness: 0.6, metalness: 0.15 });
const bandMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.5, metalness: 0.4 });
// Module-lifetime materials: mark them shared so disposeGroup() (models.js)
// never disposes them out from under the next crate/barrel built.
for (const m of [woodMat, woodTop, barrelMat, bandMat]) m.userData.shared = true;

// A wooden crate. The SAME art is used for grounded knockables AND the floating
// power-up boxes — a power-up box is just a crate that hovers. So the only tell
// that a box holds a power-up is that it floats; the ones sitting on the ground
// (which tumble when you hit them) hold nothing.
export const makeCrateProp = (rand = Math.random) => {
  const s = 1.5 + rand() * 0.6;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), woodMat));
  const lid = new THREE.Mesh(new THREE.BoxGeometry(s * 1.02, s * 0.16, s * 1.02), woodTop);
  lid.position.y = s * 0.5;
  g.add(lid);
  // No castShadow: the sun map is baked ONCE, so a knocked/floating crate would
  // leave a ghost shadow at its bake pose. The instanced blob shadow in build()
  // tracks the live prop instead (the viewer's studio has no baked map at all).
  return { mesh: g, rest: s / 2 };
};
export const makeBarrelProp = (rand = Math.random) => {
  // The barrel tumbles as one rigid body, so body + bands bake into a single
  // multi-material mesh (2 draws instead of 3 meshes).
  const r = 0.7 + rand() * 0.2;
  const h = 1.9 + rand() * 0.3;
  const parts = [new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), barrelMat)];
  for (const yy of [-h * 0.3, h * 0.3]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.04, r * 1.04, h * 0.12, 12), bandMat);
    band.position.y = yy;
    parts.push(band);
  }
  const g = new THREE.Group();
  g.add(mergeMeshes(parts, { castShadow: false })); // blob-shadowed, like the crates
  return { mesh: g, rest: h / 2 };
};

// A small leaf silhouette (a pointed oval ~0.48 long) in the XY plane, so callers
// can lay it flat and spin it like the old plane card but it reads as a leaf.
export function makeLeafGeo() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.22);
  s.bezierCurveTo(0.16, -0.12, 0.16, 0.12, 0, 0.26);
  s.bezierCurveTo(-0.16, 0.12, -0.16, -0.12, 0, -0.22);
  const g = new THREE.ShapeGeometry(s, 5);
  g.computeVertexNormals();
  return g;
}

function build(scene, track, opts) {
  const rng = makeRng((opts.seed || "props") + "|props");
  const rand = () => rng();
  // Catnip is special: just one crate on a small track, two on a big one, and it
  // takes longer to come back on a bigger track (you're away from it longer).
  const size = opts.size ?? 0.5;
  // Floating power-up boxes: a fixed pool (more on a bigger track). When one is
  // grabbed it sinks into an ordinary crate and, after a short beat, a roadside
  // crate rises to take its place — so the count holds without anything spawning
  // out of thin air.
  // 5 boxes ≈ a roll every ~40% of a lap for a 6-kart field — items stay in hands
  // without tipping into item spam (was 3/5, which left mid-pack players dry for
  // laps at a time; the 3s per-kart pickup cooldown still stops vacuuming).
  // Battle arenas hand in explicit spots instead of the spline walk below; the
  // floating pool size then matches the designed float spots.
  const spotList = opts.spots || null;
  const boxCount = spotList
    ? spotList.filter((s) => (s.mode || "float") === "float").length
    : size >= 0.55 ? 7 : 5;
  const HOVER = 1.5;           // how high a power-up box floats above its rest spot
  const RISE_TIME = 0.5;       // seconds to rise into / sink out of a floating box
  const PROMOTE_DELAY = 3;     // beat after a pickup before a replacement rises
  const PROMOTE_STAGGER = 0.5; // gap between successive replacements
  let promoteTimer = 0;
  // Whole power-up system on/off (time trial turns it off — no rivals to use items on).
  let itemsEnabled = true;
  // Real terrain height (incl. the road carve). groundInfo() returns the ROAD-CURVE
  // height, which is wrong off the road (terrain rises away from it) — that's why
  // some leaf piles floated. Prefer the terrain sampler when we have it.
  const groundAt = opts.heightAt || ((x, z) => track.groundInfo(x, z).y);

  const group = new THREE.Group();
  scene.add(group);

  const leafCols = [0xb5532a, 0xd07b27, 0xe0a73a, 0x8a6e2f];

  // Warm energy shell that marks a floating crate as a POWER-UP box (playtest:
  // "hovering" alone wasn't an obvious tell that the box holds something). One
  // shared additive material pulsed in update(); a shell mesh is lazily
  // attached per crate the first time it floats — one extra draw call per
  // active box, and there are only 3-5 on a map.
  // Hot pink so the boxes pop against every biome's palette.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff6fd8, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
  glowMat.userData.shared = true;
  let glowT = 0;
  const ensureGlow = (pr) => {
    if (!pr.glow) {
      const gs = pr.rest * 2 * 1.4;
      pr.glow = new THREE.Mesh(new THREE.BoxGeometry(gs, gs, gs), glowMat);
      pr.glow.renderOrder = 5;
      pr.mesh.add(pr.glow);
    }
    return pr.glow;
  };

  const props = []; // { mesh, pos, vel, quat, angVel, rest, half, hit, asleep, settle }
  const leafPiles = []; // { x, z, groundY, r, leaves[], burst }
  const N = track.samples;

  // Crate/barrel art lives at module scope (shared with the asset viewer);
  // bind the seeded rng so sizes stay deterministic per seed.
  const makeCrate = () => makeCrateProp(rand);
  const makeBarrel = () => makeBarrelProp(rand);
  // `o.kind` is "crate" or "barrel"; `o.mode` is the crate lifecycle state
  // ("ground" knockable | "float" power-up | "rising" transition). Which grounded
  // crate gets promoted into a floating box is decided at runtime (any settled,
  // on-road, non-spent crate is eligible — see promoteOne).
  const addProp = (x, z, groundY, built, o = {}) => {
    const mesh = built.mesh;
    const restY = groundY + built.rest;
    mesh.position.set(x, restY, z);
    group.add(mesh);
    const pr = {
      mesh, rest: built.rest, hit: 0, asleep: true, settle: false,
      kind: o.kind || "crate", mode: o.mode || "ground", spent: false,
      groundY, phase: rand() * Math.PI * 2, t: 0,
      pos: new THREE.Vector3(x, restY, z),
      vel: new THREE.Vector3(), angVel: new THREE.Vector3(), quat: new THREE.Quaternion(),
    };
    if (pr.mode === "float") mesh.position.y = restY + HOVER; // start hovering, no pop
    props.push(pr);
  };

  // Leaf piles: a mound of little leaf-shaped cards that BURST upward and scatter
  // when a kart drives through (custom flutter, not one rigid clump). Shared leaf
  // silhouette (a pointed oval) reads as a real leaf rather than a rectangle.
  const leafGeo = makeLeafGeo();
  // One material per palette colour, shared across all leaves (knockable leaves
  // still need their own mesh for individual tumble, but can share materials).
  const leafMats = leafCols.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, side: THREE.DoubleSide, flatShading: true }));
  const addLeafPile = (x, z, groundY) => {
    const g = new THREE.Group();
    g.position.set(x, groundY, z);
    const leaves = [];
    const w = 1.5 + rand() * 0.7;
    const n = 12 + ((rand() * 6) | 0);
    for (let i = 0; i < n; i++) {
      const leaf = new THREE.Mesh(leafGeo, leafMats[(rand() * leafMats.length) | 0]);
      const a = rand() * Math.PI * 2;
      const r = rand() * w;
      leaf.position.set(Math.cos(a) * r, 0.04 + rand() * 0.22, Math.sin(a) * r);
      leaf.rotation.set(-Math.PI / 2 + (rand() - 0.5) * 0.6, rand() * Math.PI, (rand() - 0.5) * 0.6);
      leaf.scale.setScalar(0.6 + rand() * 0.4); // smaller leaves
      g.add(leaf); // no castShadow: piles scatter/resettle, but the sun map bakes once

      // phase/flutF drive the side-to-side flutter as the leaf falls; swirlSign
      // sends roughly half the leaves spiralling each way so a kicked pile reads
      // as turbulence, not a uniform puff; sway* is the per-leaf flutter strength.
      leaves.push({
        mesh: leaf, vel: new THREE.Vector3(), spin: new THREE.Vector3(), hit: 0, asleep: true,
        phase: rand() * Math.PI * 2, flutF: 3 + rand() * 3, swirlSign: rand() < 0.5 ? 1 : -1,
        swayX: 5 + rand() * 5, swayZ: 5 + rand() * 5,
      });
    }
    group.add(g);
    // Each leaf is its own little particle; a pile can be driven through and
    // scattered any number of times (settled leaves just get kicked up again).
    // wind* is a lingering wake the passing kart deposits (see update): it keeps
    // carrying + swirling the airborne leaves for a beat after the kart is gone.
    const lp = { x, z, groundY, r: w, leaves, g, merged: null, dormant: false, windX: 0, windZ: 0, windUp: 0, swirl: 0, windT: 0 };
    _mergePile(lp); // piles start settled — one merged mesh instead of ~15 draws
    leafPiles.push(lp);
  };

  // Draw-call saver: a settled pile renders as ONE merged mesh (per-material
  // groups, so ≤4 draws) instead of ~15 individual leaves. The individual leaf
  // meshes only render while the pile is actually being kicked around; once every
  // leaf sleeps again, the merged proxy is rebaked at the new resting pose. The
  // sim (kick/flutter/settle in update) is untouched — this is purely how the
  // resting state reaches the GPU.
  const _mergePile = (lp) => {
    if (lp.merged) {
      lp.g.remove(lp.merged);
      lp.merged.geometry.dispose(); // materials are the shared leafMats — keep
    }
    for (const lf of lp.leaves) lf.mesh.updateMatrix();
    lp.merged = mergeMeshes(lp.leaves.map((lf) => lf.mesh), { castShadow: false });
    lp.g.add(lp.merged);
    for (const lf of lp.leaves) lf.mesh.visible = false;
    lp.dormant = true;
  };
  const _wakePile = (lp) => {
    if (!lp.dormant) return;
    lp.dormant = false;
    if (lp.merged) lp.merged.visible = false;
    for (const lf of lp.leaves) lf.mesh.visible = true;
  };

  // Seeded placement: walk the track and drop occasional clusters. Crates and
  // barrels are knockable gameplay props, so they ALWAYS sit on the road inside
  // the fence; only leaf piles (ground decor) may sit just off the verge.
  const up = new THREE.Vector3(0, 1, 0);

  // Explicit placement (battle arena): float boxes at the designed spots plus
  // plain ground crates as the promotion pool (a grabbed box sinks spent and a
  // pool crate rises to keep the count, same as on a track).
  if (spotList) {
    for (const s of spotList) {
      addProp(s.x, s.z, track.groundInfo(s.x, s.z).y, makeCrate(), {
        kind: "crate",
        mode: (s.mode || "float") === "float" ? "float" : "ground",
      });
    }
  } else {
  // Floating power-up boxes sit ON the racing line (a row you drive through),
  // evenly spaced around the lap so there's always one coming up. They're plain
  // crates that hover (mode "float"); the bob/spin in update() sells the float.
  for (let b = 0; b < boxCount; b++) {
    const frac = (b + 0.5) / boxCount + (rand() - 0.5) * 0.04;
    const idx = Math.floor(((frac % 1) + 1) % 1 * N) % N;
    const p = track._pts[idx];
    const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
    const lat = (rand() * 2 - 1) * (track.halfWidth * 0.45); // near the centre line
    const x = p.x + side.x * lat, z = p.z + side.z * lat;
    addProp(x, z, track.groundInfo(x, z).y, makeCrate(), { kind: "crate", mode: "float" });
  }

  const MAX = 64;
  const stepSamples = Math.max(6, Math.round((N * 26) / track.length));
  for (let i = 0; i < N && props.length + leafPiles.length < MAX; i += stepSamples) {
    if (rand() < 0.45) continue;
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const fwd = new THREE.Vector3(track._tans[i].x, 0, track._tans[i].z).normalize();
    const cluster = 1 + ((rand() * 3) | 0);
    const kindRoll = rand();
    const isPile = kindRoll >= 0.8;
    const onRoad = isPile ? rand() < 0.5 : true; // crates/barrels never off-road
    const dir = rand() < 0.5 ? 1 : -1;
    for (let c = 0; c < cluster && props.length + leafPiles.length < MAX; c++) {
      const lat = onRoad ? (rand() * 2 - 1) * (track.halfWidth - 3) : dir * (track.halfWidth + 3 + rand() * 7);
      const along = (rand() - 0.5) * 6;
      const x = p.x + side.x * lat + fwd.x * along;
      const z = p.z + side.z * lat + fwd.z * along;
      const groundY = track.groundInfo(x, z).y;
      if (kindRoll < 0.8) {
        if (kindRoll < 0.5) addProp(x, z, groundY, makeCrate(), { kind: "crate" });
        else addProp(x, z, groundY, makeBarrel(), { kind: "barrel" });
      } else addLeafPile(x, z, groundAt(x, z)); // piles sit on the real ground (groundY is road-curve height -> floats off-road)
    }
  }
  } // end spline-walk placement (skipped when opts.spots was given)

  if (!props.length && !leafPiles.length) {
    scene.remove(group);
    return null;
  }

  // Soft blob shadow under EVERY crate/barrel/floating box: one InstancedMesh
  // (a single draw call, no shadow-map cost) using the same projected blob the
  // karts use. The blob stays glued to the ground and SHRINKS as a prop rises,
  // which is the cue that finally sells "this box is floating" — and flung
  // crates read as airborne on the way down too. Browser-only: the blob is a
  // canvas texture, and the box logic also runs under plain Node in
  // tools/items-check.mjs where there's no document.
  const _shadowMesh = typeof document === "undefined" ? null : new THREE.InstancedMesh(
    (() => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; })(),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.8 }),
    props.length
  );
  if (_shadowMesh) {
    _shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _shadowMesh.frustumCulled = false; // instances span the whole lap
    _shadowMesh.renderOrder = 2; // over road decals (crosswalks/pads), under sprites
    group.add(_shadowMesh);
  }
  const _shDummy = new THREE.Object3D();
  function updatePropShadows() {
    if (!_shadowMesh) return;
    let changed = false;
    for (let i = 0; i < props.length; i++) {
      const pr = props[i];
      // A resting prop's shadow matrix is constant — skip it entirely. This used
      // to re-run the FULL terrain sampler (the most expensive query in the game)
      // for all ~64 props every frame, nearly all of them motionless.
      const active = !pr.asleep || pr.settle || pr.mode !== "ground";
      if (!active && pr._shBaked && pr._shVis === pr.mesh.visible) continue;
      const mp = pr.mesh.position;
      // Ground height under the prop: only re-sample when it has moved in XZ.
      if (pr._shGy === undefined || mp.x !== pr._shX || mp.z !== pr._shZ) {
        pr._shGy = groundAt(mp.x, mp.z);
        pr._shX = mp.x;
        pr._shZ = mp.z;
      }
      const gy = pr._shGy;
      const h = Math.max(0, mp.y - pr.rest - gy); // clearance under the prop
      // Footprint from the prop's size, shrinking with height (perspective cue).
      const s = (pr.rest * 3.1) / (1 + h * 0.16);
      _shDummy.position.set(mp.x, gy + 0.07, mp.z);
      _shDummy.scale.setScalar(pr.mesh.visible ? s : 0.0001);
      _shDummy.updateMatrix();
      _shadowMesh.setMatrixAt(i, _shDummy.matrix);
      pr._shVis = pr.mesh.visible;
      pr._shBaked = !active; // one final write after it comes to rest, then skip
      changed = true;
    }
    if (changed) _shadowMesh.instanceMatrix.needsUpdate = true;
  }

  const prevK = [];
  const HIT_R = 4.0;
  // Squared distance from point (px,pz) to segment (ax,az)-(bx,bz). Used so a fast
  // kart that jumps PAST a prop between frames still registers the hit.
  const segDist2 = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
    return ex * ex + ez * ez;
  };
  // scratch
  const _e = new THREE.Euler();
  const _e2 = new THREE.Euler();
  const _qT = new THREE.Quaternion();
  const _wq = new THREE.Quaternion();
  const _moving = []; // pooled swept-kart records (refilled in place each frame)

  // Advance one prop's custom rigid motion: gravity, integrate spin, clamp to the
  // road surface (bounce), bounce off the barriers, then settle upright at rest.
  function stepProp(pr, dt) {
    if (pr.asleep && !pr.settle) return;
    if (pr.settle) {
      _e.setFromQuaternion(pr.quat, "YXZ");
      _qT.setFromEuler(_e2.set(0, _e.y, 0));
      pr.quat.slerp(_qT, Math.min(1, dt * 6));
      const gy = track.groundInfo(pr.pos.x, pr.pos.z).y;
      pr.pos.y = gy + pr.rest;
      if (pr.quat.angleTo(_qT) < 0.02) pr.settle = false;
      pr.mesh.position.copy(pr.pos);
      pr.mesh.quaternion.copy(pr.quat);
      return;
    }
    pr.vel.y -= GRAV * dt;
    pr.vel.x *= 1 - 0.22 * dt;
    pr.vel.z *= 1 - 0.22 * dt;
    pr.pos.addScaledVector(pr.vel, dt);
    // Integrate orientation: q += 0.5 * (0,w) * q * dt.
    _wq.set(pr.angVel.x, pr.angVel.y, pr.angVel.z, 0).multiply(pr.quat);
    pr.quat.x += 0.5 * _wq.x * dt;
    pr.quat.y += 0.5 * _wq.y * dt;
    pr.quat.z += 0.5 * _wq.z * dt;
    pr.quat.w += 0.5 * _wq.w * dt;
    pr.quat.normalize();

    const gi = track.groundInfo(pr.pos.x, pr.pos.z);
    const restY = gi.y + pr.rest;
    if (pr.pos.y <= restY) {
      pr.pos.y = restY;
      if (pr.vel.y < 0) pr.vel.y = -pr.vel.y * 0.42; // bounce off the ground
      pr.vel.x *= 0.66;
      pr.vel.z *= 0.66;
      pr.angVel.multiplyScalar(0.72);
      if (pr.vel.lengthSq() < 1.4 && Math.abs(pr.vel.y) < 1.0 && pr.angVel.lengthSq() < 1.6) {
        pr.asleep = true;
        pr.settle = true; // ease upright onto the road
      }
    }
    // Bounce off the barriers: reflect the outward velocity at the fence and keep
    // the WHOLE prop inside it. The fence's inner face sits at halfWidth + 0.8;
    // rest ≈ the prop's half-extent, so this stops the body clipping through.
    const maxD = track.halfWidth + 0.8 - pr.rest - 0.15;
    if (gi.dist > maxD) {
      const eps = 0.6;
      const nx = track.distanceToCenter(pr.pos.x + eps, pr.pos.z) - track.distanceToCenter(pr.pos.x - eps, pr.pos.z);
      const nz = track.distanceToCenter(pr.pos.x, pr.pos.z + eps) - track.distanceToCenter(pr.pos.x, pr.pos.z - eps);
      const nl = Math.hypot(nx, nz) || 1;
      const ox = nx / nl, oz = nz / nl; // outward (toward increasing distance)
      const vn = pr.vel.x * ox + pr.vel.z * oz;
      if (vn > 0) {
        pr.vel.x -= 1.4 * vn * ox;
        pr.vel.z -= 1.4 * vn * oz;
      }
      // Resolve the full overshoot: dt is capped, so this is at most a few units
      // in the frame the prop crosses the fence — never a visible teleport, and a
      // prop can never come to rest embedded in (or beyond) the fence.
      pr.pos.x -= ox * (gi.dist - maxD);
      pr.pos.z -= oz * (gi.dist - maxD);
    }
    pr.mesh.position.copy(pr.pos);
    pr.mesh.quaternion.copy(pr.quat);
  }

  function update(dt, karts) {
    dt = Math.min(dt, 0.05);
    // Pooled records — no per-frame array/object churn (this runs every frame).
    let movingN = 0;
    const moving = _moving;
    if (karts && karts.length) {
      for (let ki = 0; ki < karts.length; ki++) {
        const k = karts[ki];
        if (!k) continue;
        let prev = prevK[ki];
        if (!prev) prev = prevK[ki] = { x: k.x, z: k.z };
        const ax = prev.x, az = prev.z;
        const vx = (k.x - ax) / Math.max(dt, 1e-3);
        const vz = (k.z - az) / Math.max(dt, 1e-3);
        prev.x = k.x;
        prev.z = k.z;
        const speed = Math.hypot(vx, vz);
        if (speed < 2.5) continue;
        // Extend the swept segment a little past the nose so the kart's length is
        // accounted for (not just its centre point). Carry the kart ref so a
        // floating box can grant the power-up to whoever drove through it.
        let m = moving[movingN];
        if (!m) m = moving[movingN] = { ax: 0, az: 0, bx: 0, bz: 0, dx: 0, dz: 0, speed: 0, kart: null };
        m.ax = ax; m.az = az;
        m.bx = k.x + (vx / speed) * 2.5;
        m.bz = k.z + (vz / speed) * 2.5;
        m.dx = vx / speed; m.dz = vz / speed;
        m.speed = speed;
        m.kart = k.kart;
        movingN++;
      }
    }
    moving.length = movingN;

    // Floating boxes grant a power-up (and sink into an ordinary crate); grounded
    // crates / barrels get FLUNG, scaling hard with speed. Rising/sinking crates
    // are mid-transition and ignore contact.
    for (const mk of moving) {
      for (const pr of props) {
        if (pr.hit > 0) continue;
        if (segDist2(pr.pos.x, pr.pos.z, mk.ax, mk.az, mk.bx, mk.bz) > HIT_R * HIT_R) continue;
        if (pr.kind === "crate" && pr.mode === "float") {
          // onItem returns false when the kart is on its pickup cooldown — leave
          // the box floating for the next eligible kart.
          if (itemsEnabled && opts.onItem && mk.kart && opts.onItem(mk.kart, pr.pos)) {
            // Used: knock it out of the air. It becomes an ordinary crate and
            // tumbles with physics (from its hover height) to rest on the ground —
            // a spent box, no longer floating. A roadside crate rises to replace it.
            pr.quat.copy(pr.mesh.quaternion); // continue from its current spun pose
            pr.pos.y = pr.groundY + pr.rest + HOVER; // fall from the hover height
            pr.mode = "ground";
            pr.spent = true; // a used box never floats again
            pr.asleep = false;
            pr.settle = false;
            const launch = 13 + Math.min(mk.speed, 150) * 0.8;
            const lift = 5 + Math.min(mk.speed, 120) * 0.05;
            pr.vel.set(mk.dx * launch + (Math.random() - 0.5) * 3, lift, mk.dz * launch + (Math.random() - 0.5) * 3);
            const sm = 10 + Math.random() * 9; // tumble end-over-end
            pr.angVel.set(-mk.dz * sm, (Math.random() - 0.5) * 8, mk.dx * sm);
            pr.hit = 0.4;
            promoteTimer = Math.max(promoteTimer, PROMOTE_DELAY);
          }
          continue;
        }
        if (pr.mode !== "ground") continue; // rising / sinking: not knockable
        const launch = 16 + Math.min(mk.speed, 150) * 0.95;
        const lift = 7 + Math.min(mk.speed, 120) * 0.06;
        pr.asleep = false;
        pr.settle = false;
        pr.vel.set(mk.dx * launch + (Math.random() - 0.5) * 3, lift, mk.dz * launch + (Math.random() - 0.5) * 3);
        const sm = 11 + Math.random() * 10; // tumble end-over-end about the across axis
        pr.angVel.set(-mk.dz * sm, (Math.random() - 0.5) * 8, mk.dx * sm);
        pr.hit = 0.4;
      }
    }
    glowT += dt;
    glowMat.opacity = 0.24 + 0.1 * Math.sin(glowT * 2.6); // slow breathing pulse
    for (const pr of props) {
      if (pr.hit > 0) pr.hit -= dt;
      if (pr.glow) pr.glow.visible = pr.kind === "crate" && pr.mode !== "ground" && itemsEnabled;
      // Floating-box lifecycle (crates only): hover, or ride a rise/sink ramp.
      if (pr.kind === "crate" && pr.mode !== "ground") {
        ensureGlow(pr);
        pr.phase += dt;
        const restY = pr.groundY + pr.rest, floatY = restY + HOVER;
        if (pr.mode === "float") {
          // Hover + slow spin in place (never tumbles); a gentle tilt adds life.
          pr.mesh.position.set(pr.pos.x, floatY + Math.sin(pr.phase * 1.8) * 0.22, pr.pos.z);
          pr.mesh.rotation.y += dt * 1.0;
          pr.mesh.rotation.x = Math.sin(pr.phase * 0.9) * 0.1;
        } else {
          // Rising (ground→float) or sinking (float→ground) over RISE_TIME.
          pr.t = Math.min(1, pr.t + dt / RISE_TIME);
          const u = pr.mode === "rising" ? pr.t : 1 - pr.t; // 0 grounded .. 1 floating
          const ease = u * u * (3 - 2 * u);
          pr.mesh.position.set(pr.pos.x, restY + (floatY - restY) * ease, pr.pos.z);
          pr.mesh.rotation.y += dt * 1.0;
          if (pr.t >= 1) {
            if (pr.mode === "rising") { pr.mode = "float"; pr.t = 0; }
            else { // landed — back to an ordinary, upright, knockable crate
              pr.mode = "ground"; pr.t = 0; pr.asleep = true; pr.settle = false;
              pr.quat.identity(); pr.angVel.set(0, 0, 0); pr.vel.set(0, 0, 0);
              pr.pos.y = restY; pr.mesh.position.copy(pr.pos); pr.mesh.rotation.set(0, 0, 0);
            }
          }
        }
        continue;
      }
      stepProp(pr, dt);
    }

    // Keep the floating pool topped up: after a pickup (and a short beat), promote
    // a roadside crate so a used box is replaced by one rising from the ground
    // rather than popping in from nowhere.
    if (promoteTimer > 0) promoteTimer -= dt;
    if (itemsEnabled) {
      let floatingNow = 0;
      for (const pr of props) if (pr.kind === "crate" && (pr.mode === "float" || pr.mode === "rising")) floatingNow++;
      if (floatingNow < boxCount && promoteTimer <= 0 && promoteOne()) promoteTimer = PROMOTE_STAGGER;
    }

    // Re-project every prop's blob shadow now that positions are final.
    updatePropShadows();

    // Leaf piles: each leaf is its own particle. Any kart driving through kicks
    // the leaves it touches (settled ones included), so a pile can be scattered
    // over and over — no one-shot "already burst" state.
    for (const lp of leafPiles) {
      // Kick leaves near a passing kart (cheap pile-level reject first), and
      // deposit a WAKE on the pile: a gust blowing the way the kart went, plus an
      // updraft and a swirl. The wake lingers (decays over ~2s below), so the
      // leaves keep streaming and spiralling after the kart has gone — not an
      // instant pop. Everything scales with kart speed.
      for (const mk of moving) {
        const reach = lp.r + 3.5;
        if (segDist2(lp.x, lp.z, mk.ax, mk.az, mk.bx, mk.bz) > reach * reach) continue;
        _wakePile(lp); // swap the merged resting proxy for the live leaves
        const sp = Math.min(mk.speed, 120);
        // Refresh the wake (set, not add, so repeated frames don't run away). A
        // faster kart drags more air, lifts harder and stirs a tighter swirl.
        lp.windX = mk.dx * (6 + sp * 0.22);
        lp.windZ = mk.dz * (6 + sp * 0.22);
        lp.windUp = 4 + sp * 0.06; // turbulent updraft keeps leaves aloft a beat
        lp.swirl = 3.0 + sp * 0.05; // stronger curl so the gust visibly spirals
        lp.windT = 1.4 + sp * 0.016; // faster pass => the gust lingers longer
        for (const lf of lp.leaves) {
          if (lf.hit > 0) continue;
          const wx = lp.x + lf.mesh.position.x, wz = lp.z + lf.mesh.position.z;
          // The WHOLE pile lifts (not just leaves right under the tyre): nearer
          // leaves get the harder kick, the rest still flutter up — so a pass
          // never leaves lone leaves sitting in a half-scattered pile.
          const dPath = Math.sqrt(segDist2(wx, wz, mk.ax, mk.az, mk.bx, mk.bz));
          const f = Math.max(0.4, 1 - dPath / (reach + 1));
          const blow = (4 + sp * 0.24) * f;
          lf.vel.set(mk.dx * blow + (Math.random() - 0.5) * 6, (6 + Math.random() * 7 + sp * 0.04) * f + 2, mk.dz * blow + (Math.random() - 0.5) * 6);
          lf.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
          lf.hit = 0.25;
          lf.asleep = false;
        }
      }

      // Decay the wake toward zero (exponential, framerate-independent). Once it's
      // out of time, treat it as gone so the wind term costs nothing.
      const windOn = lp.windT > 0;
      if (windOn) {
        const wd = Math.exp(-dt / WIND_TAU);
        lp.windX *= wd; lp.windZ *= wd; lp.windUp *= wd; lp.swirl *= wd;
        lp.windT -= dt;
      }

      // Integrate the leaves that are in motion; settle (and sleep) on the ground.
      for (const lf of lp.leaves) {
        if (lf.hit > 0) lf.hit -= dt;
        if (lf.asleep) continue;
        const pp = lf.mesh.position;
        lf.phase += lf.flutF * dt;
        const sway = Math.sin(lf.phase);

        // Wake: carry the leaf toward the gust's wind speed, lift it on the
        // updraft, and spiral it about the pile centre (sign per leaf => swirl).
        if (windOn) {
          lf.vel.x += (lp.windX - lf.vel.x) * LEAF_AIRDRAG * dt;
          lf.vel.z += (lp.windZ - lf.vel.z) * LEAF_AIRDRAG * dt;
          lf.vel.y += lp.windUp * dt;
          const sw = lp.swirl * lf.swirlSign;
          lf.vel.x += -pp.z * sw * dt; // tangential (perp to radius from centre)
          lf.vel.z += pp.x * sw * dt;
        }

        // Flutter: a leaf doesn't fall straight — it sways side to side and keeps
        // catching the air, so the descent speed pulses. Light gravity + drag.
        lf.vel.x += sway * lf.swayX * dt;
        lf.vel.z += Math.cos(lf.phase) * lf.swayZ * dt;
        lf.vel.y -= LEAF_GRAV * (0.55 + 0.45 * Math.cos(lf.phase)) * dt;
        lf.vel.x *= 1 - 0.6 * dt;
        lf.vel.z *= 1 - 0.6 * dt;
        // Bleed the violent launch spin down to a gentle flutter-rock over ~1s.
        lf.spin.multiplyScalar(1 - 1.4 * dt);

        // Soft containment: a scattered leaf that wanders past its pile radius
        // would orphan itself where a later pass can't reach it — nudge it back
        // toward the pile centre so the pile stays cohesive and re-kickable.
        const rad = Math.hypot(pp.x, pp.z);
        const maxR = lp.r + 3;
        if (rad > maxR) {
          lf.vel.x -= (pp.x / rad) * (rad - maxR) * 6 * dt;
          lf.vel.z -= (pp.z / rad) * (rad - maxR) * 6 * dt;
        }

        pp.addScaledVector(lf.vel, dt);
        // Settle onto the REAL ground under the leaf's CURRENT spot (terrain
        // slopes away from the pile centre), so a drifted leaf never hangs in the
        // air or sinks into a hill. Only sampled near the deck, where it matters.
        const floor = pp.y < 1.5 ? (groundAt(lp.x + pp.x, lp.z + pp.z) - lp.groundY) + 0.05 : 0.05;
        if (pp.y < floor) {
          pp.y = floor;
          lf.vel.set(lf.vel.x * 0.25, 0, lf.vel.z * 0.25);
          lf.spin.multiplyScalar(0.6);
          // Don't sleep while the wake is still blowing — leaves skitter along the
          // ground until the gust dies, then settle (and can be kicked again).
          if (!windOn && lf.vel.lengthSq() < 0.4) lf.asleep = true;
        }
        // Rock the leaf with the flutter (sway-coupled) on top of the launch spin,
        // so it visibly tumbles/flutters rather than spinning rigidly.
        lf.mesh.rotation.x += (lf.spin.x + sway * 3.0) * dt;
        lf.mesh.rotation.y += lf.spin.y * dt;
        lf.mesh.rotation.z += (lf.spin.z + Math.cos(lf.phase) * 3.0) * dt;
      }

      // Fully settled again (wake gone, every leaf asleep) → rebake the merged
      // resting proxy at the new pose and stop rendering the individual leaves.
      if (!lp.dormant && !windOn) {
        let allAsleep = true;
        for (const lf of lp.leaves) if (!lf.asleep) { allAsleep = false; break; }
        if (allAsleep) _mergePile(lp);
      }
    }
  }

  // Promote a roadside crate into a floating box, picking the eligible crate
  // FARTHEST from the existing floating boxes so the pool stays spread around the
  // lap. Returns false if nothing's eligible (the pool just stays a touch short).
  function promoteOne() {
    let best = null, bestScore = -1;
    for (const pr of props) {
      // Any settled, on-the-road crate can rise — EXCEPT a spent box (a used one
      // never floats again). On-road-now also excludes crates knocked into the weeds.
      if (pr.kind !== "crate" || pr.mode !== "ground" || pr.spent || pr.hit > 0) continue;
      if (!pr.asleep) continue; // still tumbling — wait until it has settled
      if (track.distanceToCenter(pr.pos.x, pr.pos.z) > track.halfWidth + 1) continue;
      let d = 1e9;
      for (const q of props) {
        if (q !== pr && q.kind === "crate" && (q.mode === "float" || q.mode === "rising")) {
          d = Math.min(d, Math.hypot(pr.pos.x - q.pos.x, pr.pos.z - q.pos.z));
        }
      }
      if (d > bestScore) { bestScore = d; best = pr; }
    }
    if (!best) return false;
    best.mode = "rising"; best.t = 0; best.asleep = true; best.settle = false;
    best.groundY = track.groundInfo(best.pos.x, best.pos.z).y; // re-anchor: it may have moved
    best.quat.identity(); best.pos.y = best.groundY + best.rest;
    best.mesh.quaternion.identity();
    return true;
  }

  // Current floating-box positions, so the AI drivers can seek them out and grab a
  // power-up instead of ignoring them. Reuses one array + records (called per frame).
  const _boxOut = [];
  function boxTargets() {
    let n = 0;
    for (const pr of props) {
      if (pr.kind !== "crate" || pr.mode !== "float") continue;
      let o = _boxOut[n];
      if (!o) o = _boxOut[n] = { x: 0, y: 0, z: 0 };
      o.x = pr.pos.x;
      o.y = pr.pos.y; // height matters: a box on a deck overhead is not "ahead"
      o.z = pr.pos.z;
      n++;
    }
    _boxOut.length = n;
    return _boxOut;
  }

  // Turn the floating power-up boxes on/off (time trial runs with them off). Off
  // hides the current boxes and stops grants + replenishment; on restores them.
  function setItemsEnabled(on) {
    itemsEnabled = !!on;
    for (const pr of props) {
      if (pr.kind === "crate" && (pr.mode === "float" || pr.mode === "rising")) pr.mesh.visible = itemsEnabled;
    }
  }

  const groundN = props.filter((p) => p.kind === "crate" && p.mode === "ground").length + props.filter((p) => p.kind === "barrel").length;
  console.log(`[zoomies] knockable props: ${groundN} crates/barrels + ${leafPiles.length} leaf piles + ${boxCount} floating power-up boxes`);
  // _props is a debug hook (headless placement/physics probes) — not gameplay API.
  return { update, group, count: props.length + leafPiles.length, boxTargets, setItemsEnabled, _props: props };
}
