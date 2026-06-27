import * as THREE from "three";
import { attribute, texture } from "three/tsl";

// Soft particle effects (textured sprites): rainbow toot clouds, boost trail,
// drift/wall sparks, plus reusable tyre skid-mark quads.
//
// All particles render through just TWO instanced meshes (one per texture: soft
// smoke, hot spark), both additive — instead of one THREE.Sprite each. A field of
// karts all boosting/tooting/drifting used to spawn hundreds of individual sprites,
// each its own draw call (they don't batch); now it's 2 draw calls total. Per-
// particle position/colour/scale/opacity are pushed into instanced attributes each
// frame; the simulation (in `parts`) is unchanged.
export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.parts = []; // { pos, v, r,g,b, life, opacity, scale, grow, damp, gravity, spark }
    // Hard cap on live particles, so a whole field boosting at once can't spike the
    // count. Over budget, the oldest (most-faded) is recycled before spawning.
    this.maxParts = 240;
    this.smokeTex = softTexture(false);
    this.sparkTex = softTexture(true);
    // One instanced billboard field per texture (both additive). Each is sized for
    // the whole budget so an all-smoke or all-spark frame still fits.
    this.smokeField = this._makeField(this.smokeTex);
    this.sparkField = this._makeField(this.sparkTex);

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

  // Build one instanced billboard field (additive) reading per-instance position,
  // colour, scale and opacity from instanced attributes. The texture's radial alpha
  // shapes each particle; the tint comes from aColor.
  _makeField(tex) {
    const cap = this.maxParts;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mk = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const aPos = mk(3), aColor = mk(3), aScale = mk(1), aOpacity = mk(1);
    geo.setAttribute("aPos", aPos);
    geo.setAttribute("aColor", aColor);
    geo.setAttribute("aScale", aScale);
    geo.setAttribute("aOpacity", aOpacity);
    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    mat.positionNode = attribute("aPos"); // sprite centre (world space)
    mat.scaleNode = attribute("aScale");
    mat.colorNode = attribute("aColor");
    mat.opacityNode = texture(tex).a.mul(attribute("aOpacity")); // radial shape × fade
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.count = 0;
    this.scene.add(mesh);
    return { mesh, aPos, aColor, aScale, aOpacity };
  }

  _spawn(pos, color, opts) {
    // Enforce the particle budget: retire the oldest before adding a new one.
    if (this.parts.length >= this.maxParts) this.parts.shift();
    this.parts.push({
      pos: pos.clone(),
      r: color.r, g: color.g, b: color.b,
      opacity: opts.opacity ?? 0.9,
      scale: opts.size ?? 1,
      spark: !!opts.spark,
      v: opts.v ? opts.v.clone() : new THREE.Vector3(),
      life: opts.life,
      grow: opts.grow ?? 0,
      damp: opts.damp ?? 2,
      gravity: opts.gravity ?? 0,
    });
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

  // Boost cloud burst, coloured by how much was charged (matching the drift-
  // charge spark tiers): a solid blue cloud for a light charge, gold for a mid
  // charge, and a full rainbow only at full charge. The toot-meter boost passes
  // the default high charge, so the button toot is always the rainbow one.
  tootBurst(kart, charge = 2, green = false) {
    const rainbow = !green && charge > 1.5;
    const tier = charge > 0.8 ? 0xffd54f : 0xbfe3ff;
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    for (let i = 0; i < 16; i++) {
      const col = green
        ? new THREE.Color().setHSL(0.28, 0.85, 0.4 + Math.random() * 0.2)
        : rainbow
        ? new THREE.Color().setHSL((this._hue + i / 16) % 1, 1, 0.6)
        : new THREE.Color(tier);
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
    if (rainbow) this._hue = (this._hue + 0.13) % 1;
  }

  // Continuous trail while boosting — rainbow normally, green for a catnip boost.
  trickle(kart, green = false) {
    let col;
    if (green) {
      col = new THREE.Color().setHSL(0.28, 0.85, 0.45 + Math.random() * 0.12);
    } else {
      this._hue = (this._hue + 0.05) % 1;
      col = new THREE.Color().setHSL(this._hue, 1, 0.6);
    }
    this._spawn(this._rear(kart, 0.8), col, {
      additive: true,
      size: 1.6,
      life: 0.55,
      grow: 3,
      v: new THREE.Vector3(0, 1.5, 0),
      opacity: 0.8,
    });
  }

  // Drift charge "powers up" toward the rainbow blast you get on release: the
  // sparks emit faster and grow as charge builds, stepping blue -> gold -> and,
  // when fully charged, cycling rainbow hues (shared with the toot trail) so the
  // payoff is telegraphed.
  driftSparks(kart) {
    const charge = kart.driftCharge;
    const maxed = charge > 1.5;
    // Emission rate climbs with charge.
    const rate = maxed ? 0.92 : charge > 0.8 ? 0.7 : 0.42;
    if (Math.random() > rate) return;

    let col;
    let size = 0.6 + Math.min(charge, 2) * 0.18;
    if (maxed) {
      this._hue = (this._hue + 0.07) % 1;
      col = new THREE.Color().setHSL(this._hue, 1, 0.62);
      size += 0.25;
    } else if (charge > 0.8) {
      col = new THREE.Color(0xffd54f);
    } else {
      col = new THREE.Color(0xbfe3ff);
    }
    const v = new THREE.Vector3((Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8);
    this._spawn(this._rear(kart, 0.6), col, {
      additive: true,
      spark: true,
      size,
      life: 0.32,
      v,
      damp: 1,
    });

    // At full charge, add the occasional soft rainbow puff so the kart visibly
    // brims with the colour it's about to unleash.
    if (maxed && Math.random() < 0.3) {
      this._spawn(this._rear(kart, 0.9), col.clone(), {
        additive: true,
        size: 1.3,
        life: 0.4,
        grow: 2,
        v: new THREE.Vector3(0, 1.6, 0),
        opacity: 0.5,
      });
    }
  }

  // A big firework shell bursting at `origin`: a bright flash core, a fat
  // spherical spray of glowing sparks in one colour family, and a few slow
  // trailing comets — all fanning out and arcing back down under gravity.
  fireworkBurst(origin) {
    const baseHue = Math.random();
    // Bright flash core that pops and fades fast (the "glow").
    this._spawn(origin.clone(), new THREE.Color().setHSL(baseHue, 0.5, 0.92), {
      additive: true,
      size: 3.5,
      life: 0.32,
      grow: 16,
      opacity: 1,
      damp: 1,
    });
    // Main spray.
    const n = 46;
    for (let i = 0; i < n; i++) {
      const col = new THREE.Color().setHSL((baseHue + Math.random() * 0.18) % 1, 1, 0.62);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = 14 + Math.random() * 13;
      const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.abs(Math.cos(phi)) * 0.7 + 0.5, // bias the spray upward
        Math.sin(phi) * Math.sin(theta)
      ).multiplyScalar(sp);
      this._spawn(origin.clone(), col, {
        additive: true,
        spark: true,
        size: 1.2 + Math.random() * 0.8,
        life: 1.1 + Math.random() * 0.9,
        v: dir,
        damp: 0.5,
        gravity: 9,
      });
    }
    // A few fat, slow trailing comets for extra drama.
    for (let i = 0; i < 7; i++) {
      const col = new THREE.Color().setHSL((baseHue + 0.5 + Math.random() * 0.2) % 1, 1, 0.66);
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * 6, 9 + Math.random() * 6, Math.sin(a) * 6);
      this._spawn(origin.clone(), col, {
        additive: true,
        size: 2.0 + Math.random(),
        life: 1.4 + Math.random() * 0.8,
        grow: 1.5,
        v,
        damp: 0.4,
        gravity: 11,
        opacity: 0.95,
      });
    }
  }

  // A little burst of water droplets kicked up when driving through a puddle.
  splash(pos) {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 3.5;
      const v = new THREE.Vector3(Math.cos(a) * sp, 2.5 + Math.random() * 2.5, Math.sin(a) * sp);
      this._spawn(pos.clone().setY(pos.y + 0.2), new THREE.Color(0xcfe8ff), {
        size: 0.35 + Math.random() * 0.3,
        life: 0.4,
        v,
        damp: 1.4,
        gravity: 13,
        opacity: 0.8,
      });
    }
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

  // Lay continuous tyre marks by bridging each new rear-wheel position to the
  // previous one (a stretched, travel-aligned segment), so the trail stays
  // unbroken even when the kart is sliding sideways in a drift. `_lastSkid`
  // holds the two previous wheel endpoints per kart.
  skid(kart) {
    const right = new THREE.Vector3(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const cur = [-1.3, 1.3].map((o) =>
      new THREE.Vector3()
        .copy(kart.position)
        .addScaledVector(right, o)
        .addScaledVector(fwd, -1.4)
        .setY(kart.groundY + 0.05)
    );
    const prev = this._lastSkid.get(kart);
    if (!prev) {
      this._lastSkid.set(kart, cur);
      return;
    }
    const step = prev[0].distanceToSquared(cur[0]);
    if (step < 0.16) return; // moved too little — wait so segments aren't degenerate
    if (step > 36) {
      // Resumed after a gap: don't draw a long bridge across the gap, just reset.
      this._lastSkid.set(kart, cur);
      return;
    }
    for (let i = 0; i < 2; i++) {
      const a = prev[i];
      const b = cur[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      let mesh;
      if (this.skids.length < this.skidMax) {
        mesh = new THREE.Mesh(this.skidGeo, this.skidMat);
        this.scene.add(mesh);
        this.skids.push(mesh);
      } else {
        mesh = this.skids[this.skidIdx];
        this.skidIdx = (this.skidIdx + 1) % this.skidMax;
      }
      mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      mesh.rotation.y = Math.atan2(dx, dz); // run the mark along the slide path
      mesh.scale.set(1, 1, (len / 1.3) * 1.15); // stretch to span the gap (slight overlap)
    }
    this._lastSkid.set(kart, cur);
  }

  update(dt) {
    // Advance the simulation and cull dead particles.
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.gravity) p.v.y -= p.gravity * dt;
      p.pos.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - Math.min(1, p.damp * dt));
      if (p.grow) p.scale += p.grow * dt;
      p.opacity = Math.max(0, p.opacity - dt * 1.5);
      if (p.life <= 0) this.parts.splice(i, 1);
    }
    // Pack the live particles into the two instanced fields (by texture).
    let ns = 0, np = 0;
    for (const p of this.parts) {
      const f = p.spark ? this.sparkField : this.smokeField;
      const idx = p.spark ? np++ : ns++;
      f.aPos.setXYZ(idx, p.pos.x, p.pos.y, p.pos.z);
      f.aColor.setXYZ(idx, p.r, p.g, p.b);
      f.aScale.setX(idx, p.scale);
      f.aOpacity.setX(idx, p.opacity);
    }
    this._flush(this.smokeField, ns);
    this._flush(this.sparkField, np);
  }

  _flush(field, count) {
    field.mesh.count = count;
    if (!count) return;
    field.aPos.needsUpdate = true;
    field.aColor.needsUpdate = true;
    field.aScale.needsUpdate = true;
    field.aOpacity.needsUpdate = true;
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
