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
    this._add(pos, dir, charge, owner, false);
  }

  // A network-replicated hairball from a remote player: visual only (the firing
  // client is authoritative over its own shots, so this never collides here).
  spawnAt(pos, dir, charge = 0) {
    this._add(pos, dir, charge, null, true);
  }

  _add(pos, dir, charge, owner, ghost) {
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
      ghost,
    });
  }

  // `remotes` (a Map of RemoteKart) and `onRemoteHit(id, dir)` are supplied in
  // multiplayer: our own hairballs can hit remote ghosts, and we report the hit
  // to that client (shooter-authoritative) so it spins its own kart out.
  update(dt, karts, remotes = null, onRemoteHit = null) {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.life -= dt;
      b.vel.y -= 24 * dt; // arc with gravity
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += dt * 10;
      b.mesh.rotation.y += dt * 7;

      let hit = false;
      // Ghost balls are network-replicated visuals only — they never collide.
      if (b.life > 0 && !b.ghost) {
        for (const k of karts) {
          if (k === b.owner || k.finished) continue;
          if (this._overlaps(b, k)) {
            if (!k.shielding) k.spinOut(this._travelDir(b));
            hit = true; // shield blocks & destroys the hairball
            break;
          }
        }
        // Remote ghosts (multiplayer): report the hit; the target spins itself.
        if (!hit && remotes) {
          for (const r of remotes.values()) {
            if (!r._ready) continue;
            const k = r.kart;
            if (this._overlaps(b, k)) {
              if (!k.shielding && onRemoteHit) onRemoteHit(r.id, this._travelDir(b));
              hit = true;
              break;
            }
          }
        }
      }

      if (hit || b.life <= 0 || b.mesh.position.y < -1) {
        this.scene.remove(b.mesh);
        this.balls.splice(i, 1);
      }
    }
  }

  _overlaps(b, k) {
    const dx = k.position.x - b.mesh.position.x;
    const dz = k.position.z - b.mesh.position.z;
    const dy = k.position.y + k.y + 1 - b.mesh.position.y;
    return dx * dx + dz * dz + dy * dy < 12;
  }

  _travelDir(b) {
    const dir = new THREE.Vector3(b.vel.x, 0, b.vel.z);
    if (dir.lengthSq() > 0.0001) dir.normalize();
    return dir;
  }
}
