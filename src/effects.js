import * as THREE from "three";

// Soft particle effects (textured sprites): rainbow fart clouds, boost trail,
// drift/wall sparks, plus reusable tyre skid-mark quads.
export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.parts = [];
    this.smokeTex = softTexture(false);
    this.sparkTex = softTexture(true);

    // Skid marks: a ring buffer of flat quads reused as the trail grows.
    this.skids = [];
    this.skidIdx = 0;
    this.skidMax = 600;
    this.skidGeo = new THREE.PlaneGeometry(0.45, 1.3);
    this.skidGeo.rotateX(-Math.PI / 2);
    this.skidMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this._lastSkid = new Map();
    this._hue = 0;
  }

  _spawn(pos, color, opts) {
    const mat = new THREE.SpriteMaterial({
      map: opts.spark ? this.sparkTex : this.smokeTex,
      color,
      transparent: true,
      opacity: opts.opacity ?? 0.9,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: !opts.additive,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(opts.size ?? 1);
    this.scene.add(s);
    this.parts.push({
      s,
      mat,
      v: opts.v || new THREE.Vector3(),
      life: opts.life,
      grow: opts.grow ?? 0,
      damp: opts.damp ?? 2,
    });
    return s;
  }

  _rear(kart, spread) {
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    return new THREE.Vector3()
      .copy(kart.position)
      .addScaledVector(fwd, -2.6)
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * spread,
          kart.y + 0.7 + Math.random() * 0.3,
          (Math.random() - 0.5) * spread
        )
      );
  }

  // Big rainbow cloud burst — the fart.
  fartBurst(kart) {
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    for (let i = 0; i < 16; i++) {
      const col = new THREE.Color().setHSL((this._hue + i / 16) % 1, 1, 0.6);
      const v = fwd
        .clone()
        .multiplyScalar(-(5 + Math.random() * 6))
        .add(new THREE.Vector3((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6));
      this._spawn(this._rear(kart, 1.6), col, {
        additive: true,
        size: 2.2 + Math.random(),
        life: 0.7 + Math.random() * 0.5,
        grow: 4,
        v,
        opacity: 0.85,
      });
    }
    this._hue = (this._hue + 0.13) % 1;
  }

  // Continuous rainbow trail while boosting.
  trickle(kart) {
    this._hue = (this._hue + 0.05) % 1;
    const col = new THREE.Color().setHSL(this._hue, 1, 0.6);
    this._spawn(this._rear(kart, 0.8), col, {
      additive: true,
      size: 1.6,
      life: 0.55,
      grow: 3,
      v: new THREE.Vector3(0, 1.5, 0),
      opacity: 0.8,
    });
  }

  driftSparks(kart) {
    if (Math.random() > 0.6) return;
    const tier = kart.driftCharge > 1.5 ? 0xff5252 : kart.driftCharge > 0.8 ? 0xffd54f : 0xbfe3ff;
    const v = new THREE.Vector3((Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8);
    this._spawn(this._rear(kart, 0.6), new THREE.Color(tier), {
      additive: true,
      spark: true,
      size: 0.7,
      life: 0.3,
      v,
      damp: 1,
    });
  }

  wallSparks(kart) {
    const n = 4 + Math.floor(Math.random() * 4);
    const along = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const base = new THREE.Vector3()
      .copy(kart.position)
      .addScaledVector(kart.wallHitDir, kart.radius)
      .setY(kart.position.y + 0.6);
    for (let i = 0; i < n; i++) {
      const col = new THREE.Color(Math.random() < 0.5 ? 0xffe082 : 0xff8a3d);
      const v = along
        .clone()
        .multiplyScalar(-(Math.random() * 6))
        .addScaledVector(kart.wallHitDir, 4 + Math.random() * 6)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3));
      this._spawn(base.clone(), col, { additive: true, spark: true, size: 0.6, life: 0.3, v, damp: 1 });
    }
  }

  skid(kart) {
    const last = this._lastSkid.get(kart);
    if (last && last.distanceToSquared(kart.position) < 0.45) return;
    this._lastSkid.set(kart, kart.position.clone());
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const right = new THREE.Vector3(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    for (const o of [-1.3, 1.3]) {
      let mesh;
      if (this.skids.length < this.skidMax) {
        mesh = new THREE.Mesh(this.skidGeo, this.skidMat);
        this.scene.add(mesh);
        this.skids.push(mesh);
      } else {
        mesh = this.skids[this.skidIdx];
        this.skidIdx = (this.skidIdx + 1) % this.skidMax;
      }
      const pos = new THREE.Vector3().copy(kart.position).addScaledVector(right, o).addScaledVector(fwd, -1.4);
      mesh.position.set(pos.x, kart.groundY + 0.05, pos.z);
      mesh.rotation.y = kart.heading;
    }
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.s.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - Math.min(1, p.damp * dt));
      if (p.grow) p.s.scale.addScalar(p.grow * dt);
      p.mat.opacity = Math.max(0, p.mat.opacity - dt * 1.5);
      if (p.life <= 0) {
        this.scene.remove(p.s);
        p.mat.dispose();
        this.parts.splice(i, 1);
      }
    }
  }
}

// Soft radial sprite texture (smoke = soft falloff; spark = tight hot core).
function softTexture(spark) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  if (spark) {
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
  } else {
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(0.5, "rgba(255,255,255,0.4)");
    g.addColorStop(1, "rgba(255,255,255,0)");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
