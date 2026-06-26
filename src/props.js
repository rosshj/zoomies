// Knockable roadside props (crates, barrels, leaf piles) powered by crashcat, a
// pure-JS rigid-body engine. They're purely COSMETIC and simulated LOCALLY: the
// kart isn't a physics body — when it drives near a prop we shove the prop with
// an impulse based on the kart's motion. Placement is seeded so every client in a
// lobby sees the same props, but their tumble after a hit is local (so we never
// have to sync physics across the network). The whole thing is wrapped so that if
// crashcat fails to load or its API shifts, props simply don't appear and the
// rest of the game is unaffected.
import * as THREE from "three";
import { makeRng } from "./rng.js";

export async function initProps(scene, track, opts = {}) {
  try {
    return await build(scene, track, opts);
  } catch (e) {
    console.warn("[zoomies] knockable props disabled:", e);
    return null;
  }
}

async function build(scene, track, opts) {
  const CC = await import("crashcat");
  // crashcat 0.0.4 exposes some helpers at the top level and some under `layers`
  // / `filter` namespaces depending on build — resolve from either shape so we
  // don't break if the packaging differs from the docs.
  const createWorld = CC.createWorld;
  const createWorldSettings = CC.createWorldSettings;
  const updateWorld = CC.updateWorld;
  const registerAll = CC.registerAll;
  const rigidBody = CC.rigidBody;
  const box = CC.box;
  const MotionType = CC.MotionType;
  const addBroadphaseLayer = CC.addBroadphaseLayer || (CC.layers && CC.layers.addBroadphaseLayer);
  const addObjectLayer = CC.addObjectLayer || (CC.layers && CC.layers.addObjectLayer);
  const enableCollision = CC.enableCollision || (CC.filter && CC.filter.enableCollision);
  for (const [name, fn] of Object.entries({
    createWorld, createWorldSettings, updateWorld, registerAll, addBroadphaseLayer, addObjectLayer, enableCollision,
  })) {
    if (typeof fn !== "function") throw new Error(`crashcat API missing: ${name}`);
  }
  if (!rigidBody || !box || !MotionType) throw new Error("crashcat API missing: rigidBody/box/MotionType");

  registerAll();
  const settings = createWorldSettings();
  settings.gravity = [0, -26, 0]; // a touch heavier than real g for snappy, toy-like falls

  const BP_MOVING = addBroadphaseLayer(settings);
  const BP_STATIC = addBroadphaseLayer(settings);
  const L_MOVING = addObjectLayer(settings, BP_MOVING);
  const L_STATIC = addObjectLayer(settings, BP_STATIC);
  enableCollision(settings, L_MOVING, L_STATIC);
  enableCollision(settings, L_MOVING, L_MOVING);
  const world = createWorld(settings);

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

  const props = []; // crashcat rigid props (crates, barrels): { body, mesh, groundY, hit }
  const leafPiles = []; // custom particle piles: { x, z, leaves[], burst, groundY }
  const N = track.samples;

  // Build one knockable prop with a box collider + a local static floor so a
  // knocked prop has ground to land/slide on near the road.
  const addProp = (x, z, groundY, half, mesh) => {
    mesh.position.set(x, groundY + half[1], z);
    group.add(mesh);
    // Local floor (static), generous so scattered props stay supported.
    rigidBody.create(world, {
      shape: box.create({ halfExtents: [26, 0.5, 26] }),
      motionType: MotionType.STATIC,
      objectLayer: L_STATIC,
      position: [x, groundY - 0.5, z],
    });
    const body = rigidBody.create(world, {
      shape: box.create({ halfExtents: half }),
      motionType: MotionType.DYNAMIC,
      objectLayer: L_MOVING,
      position: [x, groundY + half[1] + 0.02, z],
    });
    props.push({ body, mesh, groundY, hit: 0 });
  };

  const makeCrate = () => {
    const s = 1.5 + rand() * 0.6;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), woodMat);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(s * 1.02, s * 0.16, s * 1.02), woodTop);
    lid.position.y = s * 0.5;
    g.add(body, lid);
    g.traverse((o) => (o.castShadow = true));
    return { mesh: g, half: [s / 2, s / 2, s / 2] };
  };
  const makeBarrel = () => {
    const r = 0.7 + rand() * 0.2;
    const h = 1.9 + rand() * 0.3;
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), barrelMat);
    for (const yy of [-h * 0.3, h * 0.3]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.04, r * 1.04, h * 0.12, 12), bandMat);
      band.position.y = yy;
      g.add(band);
    }
    g.add(b);
    g.traverse((o) => (o.castShadow = true));
    // Box collider approximating the barrel (square footprint).
    return { mesh: g, half: [r, h / 2, r] };
  };
  // Leaf piles are NOT rigid bodies — they're a mound of many little leaf cards
  // that BURST upward and scatter (custom particle physics) when a kart drives
  // through, which reads far better than one tumbling clump.
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
      leaves.push({ mesh: leaf, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    group.add(g);
    leafPiles.push({ x, z, groundY, leaves, burst: false });
  };

  // Seeded placement: walk the track and, at intervals, drop a small cluster of
  // props. Mix ON-ROAD props (so you can plough through them) with ones just off
  // the verge, so they're not all out of reach beyond the barriers.
  const up = new THREE.Vector3(0, 1, 0);
  const MAX_PROPS = 64;
  const stepSamples = Math.max(6, Math.round((N * 26) / track.length)); // ~every 26 units
  for (let i = 0; i < N && props.length < MAX_PROPS; i += stepSamples) {
    if (rand() < 0.45) continue; // gaps, so they're occasional not constant
    const p = track._pts[i];
    const side = new THREE.Vector3().crossVectors(track._tans[i], up).normalize();
    const fwd = new THREE.Vector3(track._tans[i].x, 0, track._tans[i].z).normalize();
    const cluster = 1 + ((rand() * 3) | 0); // 1..3
    const kindRoll = rand();
    const onRoad = rand() < 0.5; // half the clusters sit on the racing surface
    const dir = rand() < 0.5 ? 1 : -1;
    for (let c = 0; c < cluster && props.length < MAX_PROPS; c++) {
      // Lateral position: on-road clusters spread across the lane; off-road ones
      // sit just past the barrier so they're still reachable from a wide line.
      const lat = onRoad
        ? (rand() * 2 - 1) * (track.halfWidth - 3)
        : dir * (track.halfWidth + 3 + rand() * 7);
      const along = (rand() - 0.5) * 6;
      const x = p.x + side.x * lat + fwd.x * along;
      const z = p.z + side.z * lat + fwd.z * along;
      const groundY = track.groundInfo(x, z).y;
      if (kindRoll < 0.8) {
        const built = kindRoll < 0.5 ? makeCrate() : makeBarrel();
        addProp(x, z, groundY, built.half, built.mesh);
      } else {
        addLeafPile(x, z, groundY);
      }
    }
  }

  if (!props.length && !leafPiles.length) {
    scene.remove(group);
    return null;
  }

  // Per-kart previous positions, to estimate velocity for the knock impulse.
  const prevK = [];
  const HIT_R = 3.6; // how close a kart must be to knock a prop
  const PHYS_DT = 1 / 60;
  let acc = 0;

  const GRAV = 30; // leaf-particle gravity (lighter than the rigid sim, so they hang)

  function update(dt, karts) {
    dt = Math.min(dt, 0.05); // clamp big frame gaps so the sim stays stable

    // Per-kart motion this frame (unit heading + speed), shared by both systems.
    const moving = [];
    if (karts && karts.length) {
      for (let ki = 0; ki < karts.length; ki++) {
        const k = karts[ki];
        if (!k) continue;
        const prev = prevK[ki] || { x: k.x, z: k.z };
        const vx = (k.x - prev.x) / Math.max(dt, 1e-3);
        const vz = (k.z - prev.z) / Math.max(dt, 1e-3);
        prevK[ki] = { x: k.x, z: k.z };
        const speed = Math.hypot(vx, vz);
        if (speed < 4) continue; // too slow to knock anything
        moving.push({ x: k.x, z: k.z, dx: vx / speed, dz: vz / speed, speed });
      }
    }

    // Crates / barrels: launch the ones a kart drives into. Velocity scales hard
    // with speed so a fast hit really sends them flying.
    for (const mk of moving) {
      for (const pr of props) {
        if (pr.hit > 0) continue;
        const bx = pr.body.position[0], bz = pr.body.position[2];
        const ddx = bx - mk.x, ddz = bz - mk.z;
        if (ddx * ddx + ddz * ddz > HIT_R * HIT_R) continue;
        const launch = 14 + Math.min(mk.speed, 140) * 0.85;
        const lift = 4 + Math.min(mk.speed, 120) * 0.05;
        const vel = [mk.dx * launch, lift, mk.dz * launch];
        const spin = [mk.dx * 6, 0, mk.dz * 6];
        const at = [bx, pr.body.position[1] - 0.4, bz];
        try {
          rigidBody.setLinearVelocity(world, pr.body, vel);
          if (rigidBody.addImpulseAtPosition) rigidBody.addImpulseAtPosition(world, pr.body, spin, at);
        } catch {
          try { rigidBody.setLinearVelocity(pr.body, vel); } catch { /* ignore */ }
        }
        pr.hit = 0.6;
      }
    }

    // Leaf piles: burst into a flurry that flies up and scatters along the hit.
    for (const lp of leafPiles) {
      if (!lp.burst) {
        for (const mk of moving) {
          const ddx = lp.x - mk.x, ddz = lp.z - mk.z;
          if (ddx * ddx + ddz * ddz > (HIT_R + 1.5) * (HIT_R + 1.5)) continue;
          lp.burst = true;
          for (const lf of lp.leaves) {
            const blow = 4 + Math.min(mk.speed, 90) * 0.22;
            lf.vel.set(
              mk.dx * blow + (Math.random() - 0.5) * 6,
              7 + Math.random() * 7,
              mk.dz * blow + (Math.random() - 0.5) * 6
            );
            lf.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
          }
          break;
        }
      } else {
        for (const lf of lp.leaves) {
          lf.vel.y -= GRAV * dt;
          lf.vel.x *= 1 - 0.9 * dt; // air drag so they flutter, not rocket
          lf.vel.z *= 1 - 0.9 * dt;
          const pp = lf.mesh.position;
          pp.addScaledVector(lf.vel, dt);
          if (pp.y < 0.05) { // settled on the ground (local origin sits at groundY)
            pp.y = 0.05;
            lf.vel.set(lf.vel.x * 0.25, 0, lf.vel.z * 0.25);
            lf.spin.multiplyScalar(0.6);
          }
          lf.mesh.rotation.x += lf.spin.x * dt;
          lf.mesh.rotation.y += lf.spin.y * dt;
          lf.mesh.rotation.z += lf.spin.z * dt;
        }
      }
    }

    acc += dt;
    let steps = 0;
    while (acc >= PHYS_DT && steps < 5) {
      updateWorld(world, undefined, PHYS_DT);
      acc -= PHYS_DT;
      steps++;
    }
    for (const pr of props) {
      if (pr.hit > 0) pr.hit -= dt;
      const q = pr.body.quaternion, p = pr.body.position;
      pr.mesh.position.set(p[0], p[1], p[2]);
      pr.mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    }
  }

  console.log(`[zoomies] knockable props: ${props.length} rigid + ${leafPiles.length} leaf piles`);
  return { update, group, count: props.length + leafPiles.length };
}
