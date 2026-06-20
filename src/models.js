import * as THREE from "three";

// Builds a low-poly cat sitting upright (the driver). Returns a Group whose
// origin sits at the seat base. `furColor` tints the fur.
export function createCat(furColor = 0xf0a830) {
  const cat = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: furColor, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.5 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const green = new THREE.MeshStandardMaterial({
    color: 0x9ccc65,
    emissive: 0x33691e,
    emissiveIntensity: 0.3,
  });

  // Body (sitting torso)
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.85, 0.7, 6, 12), fur);
  body.position.y = 1.0;
  body.castShadow = true;
  cat.add(body);

  // Chest fluff
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 12), white);
  chest.position.set(0, 0.85, 0.55);
  chest.scale.set(1, 1.1, 0.6);
  cat.add(chest);

  // Head
  const head = new THREE.Group();
  head.position.set(0, 2.05, 0.1);
  cat.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 16), fur);
  skull.scale.set(1, 0.95, 0.95);
  skull.castShadow = true;
  head.add(skull);

  // Ears
  const earGeo = new THREE.ConeGeometry(0.32, 0.55, 5);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, fur);
    ear.position.set(sx * 0.42, 0.6, -0.05);
    ear.rotation.z = sx * -0.25;
    head.add(ear);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 5), pink);
    inner.position.set(sx * 0.42, 0.58, 0.04);
    inner.rotation.z = sx * -0.25;
    head.add(inner);
  }

  // Eyes
  const eyeGeo = new THREE.SphereGeometry(0.15, 12, 12);
  const pupilGeo = new THREE.SphereGeometry(0.07, 8, 8);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, green);
    eye.position.set(sx * 0.28, 0.1, 0.6);
    head.add(eye);
    const pupil = new THREE.Mesh(pupilGeo, dark);
    pupil.position.set(sx * 0.28, 0.1, 0.72);
    pupil.scale.set(0.5, 1, 1);
    head.add(pupil);
  }

  // Nose + muzzle
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 12), white);
  muzzle.position.set(0, -0.12, 0.62);
  muzzle.scale.set(1.1, 0.7, 0.6);
  head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), pink);
  nose.position.set(0, -0.02, 0.92);
  head.add(nose);

  // Whiskers
  const whiskerMat = new THREE.LineBasicMaterial({ color: 0xffffff });
  for (const sx of [-1, 1]) {
    for (const dy of [-0.08, 0.04]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(sx * 0.2, -0.1 + dy, 0.85),
        new THREE.Vector3(sx * 0.9, -0.1 + dy * 2, 0.8),
      ]);
      head.add(new THREE.Line(g, whiskerMat));
    }
  }

  // Front paws on the wheel
  const pawGeo = new THREE.SphereGeometry(0.22, 10, 10);
  for (const sx of [-1, 1]) {
    const paw = new THREE.Mesh(pawGeo, fur);
    paw.position.set(sx * 0.45, 1.05, 0.85);
    cat.add(paw);
  }

  // Tail
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.6, -0.6),
    new THREE.Vector3(0.1, 0.9, -1.1),
    new THREE.Vector3(0.5, 1.5, -1.0),
    new THREE.Vector3(0.9, 1.9, -0.5),
  ]);
  const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 20, 0.18, 8), fur);
  tail.castShadow = true;
  cat.add(tail);

  return cat;
}

// Builds a chunky go-kart. Returns { group, wheels:[...] } so wheels can spin.
export function createKartModel(bodyColor = 0xe53935) {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.4, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.9, roughness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xffeb3b, emissive: 0xffc107, emissiveIntensity: 0.4 });

  // Chassis
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 4.2), paint);
  chassis.position.y = 0.7;
  chassis.castShadow = true;
  group.add(chassis);

  // Nose cone
  const nose = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.45, 1.4), paint);
  nose.position.set(0, 0.62, 2.4);
  nose.castShadow = true;
  group.add(nose);
  const noseTip = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.0, 4), paint);
  noseTip.rotation.x = Math.PI / 2;
  noseTip.rotation.y = Math.PI / 4;
  noseTip.position.set(0, 0.62, 3.2);
  group.add(noseTip);

  // Side pods
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 2.4), paint);
    pod.position.set(sx * 1.45, 0.7, 0.1);
    pod.castShadow = true;
    group.add(pod);
  }

  // Seat well (where the cat sits)
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 1.6), dark);
  seat.position.set(0, 1.0, -0.5);
  group.add(seat);

  // Steering wheel
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 8, 16), chrome);
  wheel.position.set(0, 1.35, 0.55);
  wheel.rotation.x = Math.PI / 2.6;
  group.add(wheel);

  // Rear spoiler
  const spoilerPost = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.7, 0.15), dark);
  for (const sx of [-1, 1]) {
    const p = spoilerPost.clone();
    p.position.set(sx * 0.7, 1.2, -2.2);
    group.add(p);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.7), paint);
  wing.position.set(0, 1.55, -2.25);
  wing.castShadow = true;
  group.add(wing);

  // Headlights
  for (const sx of [-1, 1]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), glass);
    light.position.set(sx * 0.5, 0.65, 3.0);
    group.add(light);
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

  return { group, wheels };
}
