// Podium ceremony — the in-world half of a cup win. main.js parks the top three
// karts on the steps (their cats already celebrate once finished), dollies the
// camera in, and keeps the cannons popping while the standings come up over it.
//
//   buildPodium(track)  → { group, slots[3], centre, heading, side, forward }
//                          slots are world transforms for places 1..3
//   new WorldConfetti(scene) → .burst(origin, dir, n), .update(dt), .dispose()
//
// The podium sits ON the road just short of the start gate, turned to face the
// approach straight (the gate's printed side faces that way), so the camera
// down the straight sees the champion with the "ZOOMIES GP" banner behind.
import * as THREE from "three";
import { makeNumberTexture } from "./models.js";
import { toonify } from "./toon.js";

const PALETTE = [0xffc64b, 0xff6b6b, 0x5ad1c9, 0x9b8cff, 0xffe7a8, 0xff9f43, 0x7bed9f, 0xf8f3e7];

const STEP_W = 3.9; // across the road (a kart with its tyres is ~2.6)
const STEP_D = 5.4; // along the road (a kart is ~4.2 long)
const STEP_H = [1.5, 1.0, 0.65]; // 1st, 2nd, 3rd
const STEP_X = [0, -4.1, 4.1]; // 1st in the middle, 2nd on the left, 3rd on the right
const STEP_COL = [0xffc64b, 0xd7dde6, 0xc98a4b];
const PODIUM_T = 26; // metres short of the start line

export function buildPodium(track) {
  const t = 1 - PODIUM_T / track.length;
  const p = track.getPointAt(t);
  const tan = track.getTangentAt(t).normalize();
  // `facing` is the way the podium (and the karts on it) face: back down the
  // approach, toward the camera. The viewer's right is the group's local +x.
  const facing = new THREE.Vector3(-tan.x, 0, -tan.z).normalize();
  const side = new THREE.Vector3().crossVectors(facing, new THREE.Vector3(0, 1, 0)).normalize();
  const heading = Math.atan2(facing.x, facing.z);
  const group = new THREE.Group();
  group.position.set(p.x, p.y, p.z);
  group.rotation.y = heading;
  // Local frame: +x is `side`, +z is `forward` (matches a kart's heading frame).
  const base = new THREE.MeshStandardMaterial({ color: 0x2d2640, roughness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xfff3dc, roughness: 0.7 });
  // One plinth under all three steps so the podium reads as a single piece.
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(STEP_W * 3 + 0.6 + 0.4 * 2, 0.22, STEP_D + 0.8), base);
  plinth.position.y = 0.11;
  plinth.receiveShadow = true;
  group.add(plinth);
  const slots = [];
  for (let i = 0; i < 3; i++) {
    const h = STEP_H[i];
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(STEP_W, h, STEP_D),
      new THREE.MeshStandardMaterial({ color: STEP_COL[i], roughness: 0.55, metalness: 0.15 }),
    );
    step.position.set(STEP_X[i], 0.22 + h / 2, 0);
    step.castShadow = true;
    step.receiveShadow = true;
    group.add(step);
    // Cream lip along the top edge, and the place numeral on the front face.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(STEP_W + 0.12, 0.1, STEP_D + 0.12), trim);
    lip.position.set(STEP_X[i], 0.22 + h - 0.05, 0);
    group.add(lip);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(1.2, h * 0.8), Math.min(1.2, h * 0.8)),
      new THREE.MeshStandardMaterial({ map: makeNumberTexture(i + 1), roughness: 0.7, transparent: true }),
    );
    plate.position.set(STEP_X[i], 0.22 + h / 2, STEP_D / 2 + 0.02);
    group.add(plate);
    const local = new THREE.Vector3(STEP_X[i], 0.22 + h, 0);
    slots.push({
      position: local.applyMatrix4(new THREE.Matrix4().makeRotationY(heading)).add(group.position),
      heading,
    });
  }
  // Two cannon mouths on the plinth's front corners.
  const cannonMat = new THREE.MeshStandardMaterial({ color: 0xb3402e, roughness: 0.7 });
  const cannons = [];
  for (const sx of [-1, 1]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.9, 10), cannonMat);
    c.position.set(sx * (STEP_W * 1.5 + 0.9), 0.55, STEP_D / 2 + 0.5);
    c.rotation.z = -sx * 0.35;
    group.add(c);
    cannons.push(
      new THREE.Vector3(c.position.x, 1.0, c.position.z)
        .applyMatrix4(new THREE.Matrix4().makeRotationY(heading))
        .add(group.position),
    );
  }
  toonify(group);
  const centre = new THREE.Vector3(p.x, p.y + 1.5, p.z);
  return { group, slots, centre, heading, side, facing, cannons };
}

// Flat coloured flecks that tumble and flutter down — one InstancedMesh, so a
// shower of hundreds is a single draw.
export class WorldConfetti {
  constructor(scene, cap = 700) {
    this.cap = cap;
    this.parts = [];
    this.pool = [];
    const geo = new THREE.PlaneGeometry(0.22, 0.14);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    // Seed every instance colour once (a dead slot is just scaled to nothing).
    for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, this._c.setHex(PALETTE[i % PALETTE.length]));
    scene.add(this.mesh);
    this.scene = scene;
  }
  // Launch n flecks from `origin` roughly along `dir` (unit), with a spread.
  burst(origin, dir, n = 60, speed = 11) {
    for (let i = 0; i < n && this.parts.length < this.cap; i++) {
      const p = this.pool.pop() || { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3() };
      p.pos.copy(origin);
      p.vel
        .set(
          dir.x + (Math.random() - 0.5) * 0.9,
          dir.y + (Math.random() - 0.5) * 0.5,
          dir.z + (Math.random() - 0.5) * 0.9,
        )
        .normalize()
        .multiplyScalar(speed * (0.6 + Math.random() * 0.7));
      p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.spin = 4 + Math.random() * 8;
      p.phase = Math.random() * 6.28;
      p.life = 3.2 + Math.random() * 1.8;
      p.age = 0;
      p.color = (Math.random() * PALETTE.length) | 0;
      this.parts.push(p);
    }
  }
  update(dt) {
    const parts = this.parts;
    let alive = 0;
    for (const p of parts) {
      p.age += dt;
      if (p.age >= p.life) {
        this.pool.push(p);
        continue;
      }
      // Air drag, then gravity capped at a gentle terminal fall so they flutter.
      const drag = Math.exp(-1.6 * dt);
      p.vel.x *= drag;
      p.vel.z *= drag;
      p.vel.y = Math.max(-2.2, p.vel.y * drag - 9 * dt);
      p.pos.x += (p.vel.x + Math.sin(p.phase + p.age * 5) * 0.9) * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += (p.vel.z + Math.cos(p.phase + p.age * 4) * 0.9) * dt;
      p.rot.x += p.spin * dt;
      p.rot.y += p.spin * 0.6 * dt;
      const fade = Math.min(1, (p.life - p.age) / 0.5);
      this._e.set(p.rot.x, p.rot.y, p.rot.z);
      this._q.setFromEuler(this._e);
      this._s.setScalar(fade);
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(alive, this._m);
      this.mesh.setColorAt(alive, this._c.setHex(PALETTE[p.color]));
      parts[alive++] = p;
    }
    parts.length = alive;
    this.mesh.count = alive;
    if (alive) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
  get active() {
    return this.parts.length > 0;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.parts.length = 0;
  }
}
