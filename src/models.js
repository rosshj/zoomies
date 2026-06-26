import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Rounded box helper — the workhorse of the soft, toy-like art direction. Edges
// are chamfered by `r` (auto-clamped so it never exceeds half the smallest side).
function rbox(w, h, d, r = 0.18, seg = 4) {
  const radius = Math.min(r, w / 2, h / 2, d / 2) * 0.98;
  return new RoundedBoxGeometry(w, h, d, seg, radius);
}

// Night mode: when on, karts get bright glowing headlights and a forward beam
// pool. Set once (before karts are built) from the world's time of day.
let _night = false;
export function setNightMode(v) {
  _night = !!v;
}

// Builds a low-poly cat sitting upright (the driver). Returns a Group whose
// origin sits at the seat base. `furColor` tints the fur. The returned group's
// userData.rig holds pivots (ears, whiskers, tail, head) that updateCatRig()
// animates with cornering physics.
export function createCat(furColor = 0xf0a830) {
  const cat = new THREE.Group();
  const baseCol = new THREE.Color(furColor);
  const fur = new THREE.MeshStandardMaterial({ color: furColor, roughness: 0.85 });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: baseCol.clone().multiplyScalar(0.6),
    roughness: 0.85,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xfbfbfb, roughness: 0.5 });
  const iris = new THREE.MeshStandardMaterial({
    color: 0x8fd14f,
    emissive: 0x2e7d32,
    emissiveIntensity: 0.35,
  });

  // Body (sitting torso)
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.88, 0.75, 6, 14), fur);
  body.position.y = 1.0;
  body.castShadow = true;
  cat.add(body);

  // Chest + belly fluff
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 14), white);
  chest.position.set(0, 0.82, 0.55);
  chest.scale.set(1, 1.15, 0.62);
  cat.add(chest);

  // Back stripes (tabby)
  for (let i = 0; i < 3; i++) {
    const stripe = new THREE.Mesh(rbox(1.3, 0.12, 0.34, 0.06), stripeMat);
    stripe.position.set(0, 1.25 - i * 0.02, -0.4 - i * 0.28);
    stripe.rotation.x = 0.5;
    cat.add(stripe);
  }

  // Front paws on the wheel. Each arm hangs off a shoulder pivot so it can be
  // raised for a victory fist-pump; at rest (pivot identity) the pose is
  // unchanged from before.
  const arms = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.5, 1.05, 0.45);
    cat.add(pivot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.6, 4, 8), fur);
    arm.position.set(0, 0, 0.15);
    arm.rotation.x = -1.0;
    pivot.add(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), white);
    paw.position.set(0, 0.15, 0.5);
    pivot.add(paw);
    arms[sx < 0 ? "L" : "R"] = pivot;
  }

  // --- Head (animated for lean/pitch) ---
  const head = new THREE.Group();
  head.position.set(0, 2.05, 0.12);
  cat.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.72, 18, 18), fur);
  skull.scale.set(1.06, 0.96, 0.96);
  skull.castShadow = true;
  head.add(skull);
  // Forehead stripes
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), stripeMat);
    m.position.set((i - 0.5) * 0.34, 0.5, 0.45);
    head.add(m);
  }
  // Cheeks
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 12), white);
    cheek.position.set(sx * 0.34, -0.16, 0.5);
    cheek.scale.set(0.9, 0.7, 0.7);
    head.add(cheek);
  }

  // Ears on pivots so they can flick/lag
  const earGeo = new THREE.ConeGeometry(0.33, 0.62, 5);
  const innerGeo = new THREE.ConeGeometry(0.18, 0.36, 5);
  const ears = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.44, 0.5, -0.02);
    head.add(pivot);
    const ear = new THREE.Mesh(earGeo, fur);
    ear.position.y = 0.28;
    ear.rotation.z = sx * -0.22;
    ear.castShadow = true;
    pivot.add(ear);
    const inner = new THREE.Mesh(innerGeo, pink);
    inner.position.set(0, 0.26, 0.06);
    inner.rotation.z = sx * -0.22;
    pivot.add(inner);
    ears[sx < 0 ? "L" : "R"] = pivot;
  }

  // Eyes (iris + pupil + shine)
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 14), iris);
    eye.position.set(sx * 0.3, 0.12, 0.58);
    eye.scale.set(0.9, 1, 0.7);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), dark);
    pupil.position.set(sx * 0.3, 0.12, 0.71);
    pupil.scale.set(0.45, 1, 1);
    head.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), white);
    shine.position.set(sx * 0.34, 0.2, 0.74);
    head.add(shine);
  }

  // Muzzle + nose
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), white);
  muzzle.position.set(0, -0.16, 0.64);
  muzzle.scale.set(1.1, 0.72, 0.62);
  head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.1, 6), pink);
  nose.rotation.x = Math.PI;
  nose.position.set(0, -0.04, 0.92);
  head.add(nose);

  // Cool-cat sunglasses, hidden until the victory celebration drops them on.
  const glasses = new THREE.Group();
  const shade = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.4 });
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.06), shade);
    lens.position.set(sx * 0.3, 0.12, 0.64);
    glasses.add(lens);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.05), shade);
  bridge.position.set(0, 0.16, 0.64);
  glasses.add(bridge);
  glasses.visible = false;
  head.add(glasses);

  // Whiskers on pivots (sweep with cornering)
  const whiskerMat = new THREE.LineBasicMaterial({ color: 0xf0f0f0 });
  const whiskers = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.18, -0.12, 0.78);
    head.add(pivot);
    for (const dy of [-0.08, 0.0, 0.08]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, dy * 0.4, 0),
        new THREE.Vector3(sx * 0.75, dy, 0.05),
      ]);
      pivot.add(new THREE.Line(g, whiskerMat));
    }
    whiskers[sx < 0 ? "L" : "R"] = pivot;
  }

  // Tail on a base pivot (sways + lifts)
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.05, 0.4, -0.5),
    new THREE.Vector3(0.35, 1.0, -0.45),
    new THREE.Vector3(0.7, 1.4, -0.05),
  ]);
  const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 24, 0.17, 8), fur);
  tail.castShadow = true;
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.6, -0.7);
  tailPivot.add(tail);
  cat.add(tailPivot);

  cat.userData.tail = tailPivot;
  cat.userData.rig = {
    head,
    earL: ears.L,
    earR: ears.R,
    whiskerL: whiskers.L,
    whiskerR: whiskers.R,
    armL: arms.L,
    armR: arms.R,
    glasses,
    celebT: 0,
    tail: tailPivot,
    springs: {
      earSway: { a: 0, v: 0 },
      earBack: { a: 0, v: 0 },
      whisker: { a: 0, v: 0 },
      tailY: { a: 0, v: 0 },
      tailX: { a: 0, v: 0 },
      headLean: { a: 0, v: 0 },
      headPitch: { a: 0, v: 0 },
    },
  };
  return cat;
}

// Animates a cat rig with cornering physics. `lat` is the (signed) cornering
// intensity, `lon` the longitudinal acceleration; both roughly -1..1. The
// appendages lag and overshoot via simple spring-dampers so they whip around
// corners and flatten back under acceleration. `toot` lifts the tail.
// `celebrate` triggers the victory pose: sunglasses drop on and one paw pumps.
export function updateCatRig(rig, dt, lat, lon, toot = false, celebrate = false) {
  if (!rig) return;
  const sp = rig.springs;
  const step = (s, target, k, d) => {
    s.v += (target - s.a) * k * dt;
    s.v *= Math.max(0, 1 - d * dt);
    s.a += s.v * dt;
  };
  step(sp.earSway, -lat * 0.85, 70, 9);
  step(sp.earBack, Math.max(0, lon) * 0.7 + Math.abs(lat) * 0.5, 75, 12);
  step(sp.whisker, -lat * 0.9, 55, 8);
  step(sp.tailY, -lat * 1.9, 42, 6);
  step(sp.tailX, toot ? -1.5 : -Math.max(0, lon) * 0.5, 55, 9);
  step(sp.headLean, -lat * 0.4, 65, 10);
  step(sp.headPitch, lon * 0.2, 70, 11);

  rig.earL.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.earR.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.whiskerL.rotation.y = sp.whisker.a;
  rig.whiskerR.rotation.y = sp.whisker.a;
  rig.tail.rotation.set(sp.tailX.a, sp.tailY.a, 0);
  rig.head.rotation.set(sp.headPitch.a, 0, sp.headLean.a);

  // --- Victory celebration: shades drop on, right paw pumps the air ---
  if (celebrate) {
    rig.celebT += dt;
    if (rig.glasses) {
      rig.glasses.visible = true;
      rig.glasses.position.y = Math.max(0, 1.0 - rig.celebT * 4); // slide on over ~0.25s
    }
    if (rig.armR) {
      const pump = Math.sin(rig.celebT * 9);
      rig.armR.rotation.set(-1.9 + pump * 0.5, 0, -0.2); // paw raised overhead, pumping
    }
  } else {
    rig.celebT = 0;
    if (rig.glasses) rig.glasses.visible = false;
    if (rig.armR) rig.armR.rotation.set(0, 0, 0);
  }
  if (rig.armL) rig.armL.rotation.set(0, 0, 0); // left paw stays on the wheel
}

// Builds a chunky go-kart. Returns { group, wheels:[...] } so wheels can spin.
export function createKartModel(bodyColor = 0xe53935) {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.4, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.9, roughness: 0.2 });
  // Headlights glow much brighter at night (bloom picks them up).
  const glass = new THREE.MeshStandardMaterial({
    color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: _night ? 2.6 : 0.4,
  });

  // Chassis
  const chassis = new THREE.Mesh(rbox(2.4, 0.5, 4.2, 0.24), paint);
  chassis.position.y = 0.7;
  chassis.castShadow = true;
  group.add(chassis);

  // Nose
  const nose = new THREE.Mesh(rbox(2.0, 0.45, 1.4, 0.22), paint);
  nose.position.set(0, 0.62, 2.4);
  nose.castShadow = true;
  group.add(nose);
  // Soft rounded snout instead of a hard pyramid tip.
  const noseTip = new THREE.Mesh(rbox(1.5, 0.5, 1.3, 0.45), paint);
  noseTip.position.set(0, 0.6, 3.15);
  noseTip.castShadow = true;
  group.add(noseTip);

  // Side pods
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(rbox(0.7, 0.6, 2.4, 0.26), paint);
    pod.position.set(sx * 1.45, 0.7, 0.1);
    pod.castShadow = true;
    group.add(pod);
  }

  // Seat well (where the cat sits)
  const seat = new THREE.Mesh(rbox(1.6, 0.7, 1.6, 0.28), dark);
  seat.position.set(0, 1.0, -0.5);
  group.add(seat);

  // Steering wheel
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 8, 16), chrome);
  wheel.position.set(0, 1.35, 0.55);
  wheel.rotation.x = Math.PI / 2.6;
  group.add(wheel);

  // Rear spoiler
  const spoilerPost = new THREE.Mesh(rbox(0.18, 0.7, 0.18, 0.07), dark);
  for (const sx of [-1, 1]) {
    const p = spoilerPost.clone();
    p.position.set(sx * 0.7, 1.2, -2.2);
    group.add(p);
  }
  const wing = new THREE.Mesh(rbox(2.6, 0.16, 0.7, 0.07), paint);
  wing.position.set(0, 1.55, -2.25);
  wing.castShadow = true;
  group.add(wing);

  // Headlights
  for (const sx of [-1, 1]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), glass);
    light.position.set(sx * 0.5, 0.65, 3.0);
    group.add(light);
  }
  // The forward beam that lights the road is NOT parented here (it would tilt with
  // the kart and clip the tarmac during drifts) — it's a ground-projected pool
  // managed per-frame in the main loop (see headlights in main.js).

  // Tail lights: a dim red glow normally, flaring bright when braking/reversing
  // (the kart updates brakeMat.emissiveIntensity). Shared material returned below.
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x6e0d0d, emissive: 0xff2a1e, emissiveIntensity: 0.25, roughness: 0.5,
  });
  for (const sx of [-1, 1]) {
    const tl = new THREE.Mesh(rbox(0.42, 0.3, 0.18, 0.07), brakeMat);
    tl.position.set(sx * 0.72, 0.72, -2.42);
    group.add(tl);
  }

  // Wheels
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.65, 0.65, 0.55, 16);
  const hubGeo = new THREE.CylinderGeometry(0.66, 0.66, 0.2, 8);
  const positions = [
    [1.35, 0.55, 1.5],
    [-1.35, 0.55, 1.5],
    [1.45, 0.6, -1.6],
    [-1.45, 0.6, -1.6],
  ];
  for (const [x, y, z] of positions) {
    const w = new THREE.Group();
    const t = new THREE.Mesh(wheelGeo, tire);
    t.rotation.z = Math.PI / 2;
    t.castShadow = true;
    w.add(t);
    const hub = new THREE.Mesh(hubGeo, chrome);
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    w.position.set(x, y, z);
    group.add(w);
    wheels.push(w);
  }

  // Boost flames out the back — hidden until boosting (the kart shows/flickers
  // them). Bright, un-tonemapped additive cones so bloom makes them roar.
  const flames = new THREE.Group();
  flames.visible = false;
  const flameOuter = new THREE.MeshBasicMaterial({
    color: 0xff7a1e, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  });
  const flameCore = new THREE.MeshBasicMaterial({
    color: 0xfff2c0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  });
  for (const sx of [-0.7, 0.7]) {
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.5, 8), flameOuter);
    outer.rotation.x = -Math.PI / 2; // taper trailing backward (-Z)
    outer.position.set(sx, 0.55, -2.7);
    flames.add(outer);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 8), flameCore);
    core.rotation.x = -Math.PI / 2;
    core.position.set(sx, 0.55, -2.5);
    flames.add(core);
  }
  group.add(flames);

  return { group, wheels, brakeMat, flames };
}
