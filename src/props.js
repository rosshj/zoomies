// Knockable roadside props (crates, barrels, leaf piles). These use a small custom
// physics integrator rather than a full engine: each prop is clamped to the actual
// road surface every frame (so it never floats or falls through the curved/sloped
// track), bounces off the ground and the barriers, and tumbles when launched. The
// kart isn't simulated — when it drives near a prop we fling the prop along its
// motion. Cosmetic + local (placement is seeded, so a lobby sees the same props;
// their tumble is local, so multiplayer needs no physics sync).
import * as THREE from "three";
import { makeRng } from "./rng.js";

export async function initProps(scene, track, opts = {}) {
  try {
    return build(scene, track, opts);
  } catch (e) {
    console.warn("[zoomies] knockable props disabled:", e);
    return null;
  }
}

const GRAV = 30;

function build(scene, track, opts) {
  const rng = makeRng((opts.seed || "props") + "|props");
  const rand = () => rng();

  const group = new THREE.Group();
  scene.add(group);

  // Shared materials (toy/cel style).
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xb5803f, roughness: 0.85 });
  const woodTop = new THREE.MeshStandardMaterial({ color: 0xcd9a55, roughness: 0.85 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0xc24a3a, roughness: 0.6, metalness: 0.15 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.5, metalness: 0.4 });
  const leafCols = [0xb5532a, 0xd07b27, 0xe0a73a, 0x8a6e2f];

  const props = []; // { mesh, pos, vel, quat, angVel, rest, half, hit, asleep, settle }
  const leafPiles = []; // { x, z, groundY, r, leaves[], burst }
  const N = track.samples;

  const makeCrate = () => {
    const s = 1.5 + rand() * 0.6;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), woodMat));
    const lid = new THREE.Mesh(new THREE.BoxGeometry(s * 1.02, s * 0.16, s * 1.02), woodTop);
    lid.position.y = s * 0.5;
    g.add(lid);
    g.traverse((o) => (o.castShadow = true));
    return { mesh: g, rest: s / 2 };
  };
  const makeBarrel = () => {
    const r = 0.7 + rand() * 0.2;
    const h = 1.9 + rand() * 0.3;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), barrelMat));
    for (const yy of [-h * 0.3, h * 0.3]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.04, r * 1.04, h * 0.12, 12), bandMat);
      band.position.y = yy;
      g.add(band);
    }
    g.traverse((o) => (o.castShadow = true));
    return { mesh: g, rest: h / 2 };
  };
  const addProp = (x, z, groundY, built) => {
    const mesh = built.mesh;
    mesh.position.set(x, groundY + built.rest, z);
    group.add(mesh);
    props.push({
      mesh, rest: built.rest, hit: 0, asleep: true, settle: false,
      pos: new THREE.Vector3(x, groundY + built.rest, z),
      vel: new THREE.Vector3(), angVel: new THREE.Vector3(), quat: new THREE.Quaternion(),
    });
  };

  // Leaf piles: a mound of little leaf cards that BURST upward and scatter when a
  // kart drives through (custom flutter, not one rigid clump).
  const leafGeo = new THREE.PlaneGeometry(0.7, 0.5);
  const addLeafPile = (x, z, groundY) => {
    const g = new THREE.Group();
    g.position.set(x, groundY, z);
    const leaves = [];
    const w = 1.8 + rand() * 0.8;
    const n = 14 + ((rand() * 8) | 0);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: leafCols[(rand() * leafCols.length) | 0], roughness: 1, side: THREE.DoubleSide, flatShading: true,
      });
      const leaf = new THREE.Mesh(leafGeo, mat);
      const a = rand() * Math.PI * 2;
      const r = rand() * w;
      leaf.position.set(Math.cos(a) * r, 0.05 + rand() * 0.3, Math.sin(a) * r);
      leaf.rotation.set(-Math.PI / 2 + (rand() - 0.5) * 0.6, rand() * Math.PI, (rand() - 0.5) * 0.6);
      leaf.scale.setScalar(0.7 + rand() * 0.6);
      leaf.castShadow = true;
      g.add(leaf);
      leaves.push({ mesh: leaf, vel: new THREE.Vector3(), spin: new THREE.Vector3(), hit: 0, asleep: true });
    }
    group.add(g);
    // Each leaf is its own little particle; a pile can be driven through and
    // scattered any number of times (settled leaves just get kicked up again).
    leafPiles.push({ x, z, groundY, r: w, leaves });
  };

  // Seeded placement: walk the track and drop occasional clusters, mixing ON-ROAD
  // props with ones just off the verge.
  const up = new THREE.Vector3(0, 1, 0);
  const MAX = 64;
  const stepSamples = Math.max(6, Math.round((N * 26) / track.length));
  for (let i = 0; i < N && props.length + leafPiles.length < MAX; i += stepSamples) {
    if (rand() < 0.45) continue;
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const fwd = new THREE.Vector3(track._tans[i].x, 0, track._tans[i].z).normalize();
    const cluster = 1 + ((rand() * 3) | 0);
    const kindRoll = rand();
    const onRoad = rand() < 0.5;
    const dir = rand() < 0.5 ? 1 : -1;
    for (let c = 0; c < cluster && props.length + leafPiles.length < MAX; c++) {
      const lat = onRoad ? (rand() * 2 - 1) * (track.halfWidth - 3) : dir * (track.halfWidth + 3 + rand() * 7);
      const along = (rand() - 0.5) * 6;
      const x = p.x + side.x * lat + fwd.x * along;
      const z = p.z + side.z * lat + fwd.z * along;
      const groundY = track.groundInfo(x, z).y;
      if (kindRoll < 0.8) addProp(x, z, groundY, kindRoll < 0.5 ? makeCrate() : makeBarrel());
      else addLeafPile(x, z, groundY);
    }
  }

  if (!props.length && !leafPiles.length) {
    scene.remove(group);
    return null;
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
  const _qT = new THREE.Quaternion();
  const _wq = new THREE.Quaternion();

  // Advance one prop's custom rigid motion: gravity, integrate spin, clamp to the
  // road surface (bounce), bounce off the barriers, then settle upright at rest.
  function stepProp(pr, dt) {
    if (pr.asleep && !pr.settle) return;
    if (pr.settle) {
      _e.setFromQuaternion(pr.quat, "YXZ");
      _qT.setFromEuler(new THREE.Euler(0, _e.y, 0));
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
    // Bounce off the barriers: reflect the outward velocity at the road edge.
    if (gi.dist > track.halfWidth + 1.5) {
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
      const over = Math.min(gi.dist - (track.halfWidth + 1.5), 1.5); // gentle, no teleport
      pr.pos.x -= ox * over;
      pr.pos.z -= oz * over;
    }
    pr.mesh.position.copy(pr.pos);
    pr.mesh.quaternion.copy(pr.quat);
  }

  function update(dt, karts) {
    dt = Math.min(dt, 0.05);
    const moving = [];
    if (karts && karts.length) {
      for (let ki = 0; ki < karts.length; ki++) {
        const k = karts[ki];
        if (!k) continue;
        const prev = prevK[ki] || { x: k.x, z: k.z };
        const ax = prev.x, az = prev.z;
        const vx = (k.x - ax) / Math.max(dt, 1e-3);
        const vz = (k.z - az) / Math.max(dt, 1e-3);
        prevK[ki] = { x: k.x, z: k.z };
        const speed = Math.hypot(vx, vz);
        if (speed < 2.5) continue;
        // Extend the swept segment a little past the nose so the kart's length is
        // accounted for (not just its centre point).
        moving.push({ ax, az, bx: k.x + (vx / speed) * 2.5, bz: k.z + (vz / speed) * 2.5, dx: vx / speed, dz: vz / speed, speed });
      }
    }

    // Crates / barrels: fling the ones a kart drives into, scaling hard with speed.
    for (const mk of moving) {
      for (const pr of props) {
        if (pr.hit > 0) continue;
        if (segDist2(pr.pos.x, pr.pos.z, mk.ax, mk.az, mk.bx, mk.bz) > HIT_R * HIT_R) continue;
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
    for (const pr of props) {
      if (pr.hit > 0) pr.hit -= dt;
      stepProp(pr, dt);
    }

    // Leaf piles: each leaf is its own particle. Any kart driving through kicks
    // the leaves it touches (settled ones included), so a pile can be scattered
    // over and over — no one-shot "already burst" state.
    for (const lp of leafPiles) {
      // Kick leaves near a passing kart (cheap pile-level reject first).
      for (const mk of moving) {
        const reach = lp.r + 3.5;
        if (segDist2(lp.x, lp.z, mk.ax, mk.az, mk.bx, mk.bz) > reach * reach) continue;
        for (const lf of lp.leaves) {
          if (lf.hit > 0) continue;
          const wx = lp.x + lf.mesh.position.x, wz = lp.z + lf.mesh.position.z;
          if (segDist2(wx, wz, mk.ax, mk.az, mk.bx, mk.bz) > 10) continue; // ~3-unit kick radius
          const blow = 4 + Math.min(mk.speed, 90) * 0.24;
          lf.vel.set(mk.dx * blow + (Math.random() - 0.5) * 6, 7 + Math.random() * 7, mk.dz * blow + (Math.random() - 0.5) * 6);
          lf.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
          lf.hit = 0.25;
          lf.asleep = false;
        }
      }
      // Integrate the leaves that are in motion; settle (and sleep) on the ground.
      for (const lf of lp.leaves) {
        if (lf.hit > 0) lf.hit -= dt;
        if (lf.asleep) continue;
        lf.vel.y -= GRAV * dt;
        lf.vel.x *= 1 - 0.9 * dt;
        lf.vel.z *= 1 - 0.9 * dt;
        const pp = lf.mesh.position;
        pp.addScaledVector(lf.vel, dt);
        if (pp.y < 0.05) {
          pp.y = 0.05;
          lf.vel.set(lf.vel.x * 0.25, 0, lf.vel.z * 0.25);
          lf.spin.multiplyScalar(0.6);
          if (lf.vel.lengthSq() < 0.4) lf.asleep = true; // resting; can be kicked again later
        }
        lf.mesh.rotation.x += lf.spin.x * dt;
        lf.mesh.rotation.y += lf.spin.y * dt;
        lf.mesh.rotation.z += lf.spin.z * dt;
      }
    }
  }

  console.log(`[zoomies] knockable props: ${props.length} crates/barrels + ${leafPiles.length} leaf piles`);
  return { update, group, count: props.length + leafPiles.length };
}
