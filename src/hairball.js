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

  // `charge` (0..1) comes from the player holding the shoot button: a charged
  // shot flies faster, flatter and further.
  spawn(owner, charge = 0) {
    const { pos, dir } = owner.muzzle();
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const speed = 70 + charge * 48;
    this.balls.push({
      mesh,
      vel: dir.clone().multiplyScalar(speed).add(new THREE.Vector3(0, 4 - charge * 1.5, 0)),
      life: 2.2 + charge * 1.1,
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
          const dy = k.position.y + k.y + 1 - b.mesh.position.y;
          if (dx * dx + dz * dz + dy * dy < 12) {
            if (!k.shielding) {
              // Shove the victim in the hairball's travel direction.
              const dir = new THREE.Vector3(b.vel.x, 0, b.vel.z);
              if (dir.lengthSq() > 0.0001) dir.normalize();
              k.spinOut(dir);
            }
            hit = true; // shield blocks & destroys the hairball
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
