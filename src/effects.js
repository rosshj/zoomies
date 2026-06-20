import * as THREE from "three";

// Particle puffs for the fart boost and small sparks while drift-charging.
export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.parts = [];
    this.puffGeo = new THREE.SphereGeometry(0.6, 7, 6);
    this.sparkGeo = new THREE.SphereGeometry(0.18, 5, 4);
  }

  _rear(kart, spread = 0.6) {
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    return new THREE.Vector3()
      .copy(kart.position)
      .addScaledVector(fwd, -2.6)
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * spread * 3,
          kart.y + 0.6 + Math.random() * 0.4,
          (Math.random() - 0.5) * spread * 3
        )
      );
  }

  // A big greenish cloud burst — the fart.
  fartBurst(kart) {
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: i % 3 === 0 ? 0xb5c44a : 0x9bbf4d,
        transparent: true,
        opacity: 0.7,
        roughness: 1,
      });
      const mesh = new THREE.Mesh(this.puffGeo, mat);
      mesh.position.copy(this._rear(kart, 0.9));
      const v = fwd
        .clone()
        .multiplyScalar(-(6 + Math.random() * 6))
        .add(new THREE.Vector3((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6));
      this.scene.add(mesh);
      this.parts.push({ mesh, mat, v, life: 0.8 + Math.random() * 0.5, grow: 3 });
    }
  }

  // Continuous trickle while a boost is active.
  trickle(kart) {
    if (Math.random() > 0.6) return;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xa8c24d,
      transparent: true,
      opacity: 0.5,
      roughness: 1,
    });
    const mesh = new THREE.Mesh(this.puffGeo, mat);
    mesh.position.copy(this._rear(kart, 0.5));
    mesh.scale.setScalar(0.6);
    this.scene.add(mesh);
    this.parts.push({ mesh, mat, v: new THREE.Vector3(0, 1.5, 0), life: 0.5, grow: 2.5 });
  }

  // Small sparks at the rear while charging a drift (color hints the tier).
  driftSparks(kart) {
    if (Math.random() > 0.5) return;
    const tier = kart.driftCharge > 1.5 ? 0xff5252 : kart.driftCharge > 0.8 ? 0xffd54f : 0xbfe3ff;
    const mat = new THREE.MeshStandardMaterial({
      color: tier,
      emissive: tier,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(this.sparkGeo, mat);
    mesh.position.copy(this._rear(kart, 0.4));
    const v = new THREE.Vector3((Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8);
    this.scene.add(mesh);
    this.parts.push({ mesh, mat, v, life: 0.3, grow: 0 });
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - Math.min(1, 2 * dt));
      if (p.grow) p.mesh.scale.addScalar(p.grow * dt);
      p.mat.opacity = Math.max(0, p.mat.opacity - dt * 1.4);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
        this.parts.splice(i, 1);
      }
    }
  }
}
