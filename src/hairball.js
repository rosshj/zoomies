import * as THREE from "three";

// Manages flying hairballs and their collisions with karts.
export class HairballManager {
  constructor(scene) {
    this.scene = scene;
    this.balls = [];
    this.geo = new THREE.SphereGeometry(0.45, 8, 6);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x8d6e4f,
      roughness: 1,
      flatShading: true,
    });
  }

  spawn(owner) {
    const { pos, dir } = owner.muzzle();
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.balls.push({
      mesh,
      vel: dir.clone().multiplyScalar(70).add(new THREE.Vector3(0, 4, 0)),
      life: 2.2,
      owner,
    });
  }

  update(dt, karts) {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.life -= dt;
      b.vel.y -= 24 * dt; // arc with gravity
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += dt * 10;
      b.mesh.rotation.y += dt * 7;

      let hit = false;
      if (b.life > 0) {
        for (const k of karts) {
          if (k === b.owner || k.finished) continue;
          const dx = k.position.x - b.mesh.position.x;
          const dz = k.position.z - b.mesh.position.z;
          const dy = k.y + 1 - b.mesh.position.y;
          if (dx * dx + dz * dz + dy * dy < 9) {
            k.spinOut();
            hit = true;
            break;
          }
        }
      }

      if (hit || b.life <= 0 || b.mesh.position.y < -1) {
        this.scene.remove(b.mesh);
        this.balls.splice(i, 1);
      }
    }
  }
}
