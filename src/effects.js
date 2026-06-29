import * as THREE from "three";
import { attribute, texture, color } from "three/tsl";

// Soft particle effects (textured sprites): rainbow toot clouds, boost trail,
// drift/wall sparks, plus reusable tyre skid-mark quads.
//
// All particles render through just TWO instanced meshes (one per texture: soft
// smoke, hot spark), both additive — instead of one THREE.Sprite each. A field of
// karts all boosting/tooting/drifting used to spawn hundreds of individual sprites,
// each its own draw call (they don't batch); now it's 2 draw calls total. Per-
// particle position/colour/scale/opacity are pushed into instanced attributes each
// frame; the simulation (in `parts`) is unchanged.
const _DUST_FALLBACK = new THREE.Color(0xd8c8a8); // warm tan if no biome tint supplied

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

    // Skid marks: ONE continuous ribbon mesh shared by every kart — a ring buffer
    // of quads where each new quad reuses the previous quad's far edge as its near
    // edge, so the trail reads as an unbroken streak (not dashes) and the whole
    // thing is a single draw call (was up to 600 separate meshes). A soft-edged
    // width texture feathers the sides.
    this.skidMax = 1100; // quads in the ring
    this.skidHead = 0;
    this.skidFill = 0;
    this._skidDirty = false;
    const sc = this.skidMax * 6; // 6 verts per quad (2 triangles)
    this.skidPos = new Float32Array(sc * 3);
    this.skidUV = new Float32Array(sc * 2);
    this.skidGeo = new THREE.BufferGeometry();
    this.skidGeo.setAttribute("position", new THREE.BufferAttribute(this.skidPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.skidGeo.setAttribute("uv", new THREE.BufferAttribute(this.skidUV, 2).setUsage(THREE.DynamicDrawUsage));
    this.skidGeo.setDrawRange(0, 0);
    const skidTex = skidTexture();
    this.skidMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    this.skidMat.colorNode = color(0x161616);
    this.skidMat.opacityNode = texture(skidTex).a.mul(0.5); // soft-edged across width
    this.skidMesh = new THREE.Mesh(this.skidGeo, this.skidMat);
    this.skidMesh.frustumCulled = false;
    this.skidMesh.renderOrder = 1;
    this.skidMesh.layers.set(0);
    scene.add(this.skidMesh);
    this._skidPrev = new Map(); // kart -> { c:[Vec3,Vec3], e:[edge|null, edge|null] } per rear wheel
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

  // Dust kicked off the track surface — soft, ground-coloured puffs that splay out
  // low behind the rear wheels and settle. Heavier while skidding/drifting, a faint
  // veil while just driving. Routed through the existing smoke field (no new draw
  // calls) and capped by `amount` so a whole field of karts can't flood the budget.
  dust(kart, color, amount = 1) {
    // Probabilistic emission: `amount` scales both the chance and the puff count,
    // so light cruising dust is a rare single puff and a hard skid is a steady plume.
    if (Math.random() > amount * 0.9) return;
    const n = amount > 0.6 && Math.random() < amount ? 2 : 1;
    const right = new THREE.Vector3(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    const fwd = new THREE.Vector3(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const groundY = (kart.groundY ?? kart.y ?? 0) + 0.15;
    for (let i = 0; i < n; i++) {
      const side = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.7);
      const base = new THREE.Vector3()
        .copy(kart.position)
        .addScaledVector(fwd, -1.7 - Math.random())
        .addScaledVector(right, side)
        .setY(groundY);
      const v = right
        .clone()
        .multiplyScalar(side * (1.4 + Math.random() * 2)) // splay outward from the tyre
        .addScaledVector(fwd, -(1 + Math.random() * 1.8)) // and trail backward
        .add(new THREE.Vector3(0, 0.7 + Math.random() * 1.1, 0));
      const c = (color || _DUST_FALLBACK).clone().multiplyScalar(0.82 + Math.random() * 0.3);
      this._spawn(base, c, {
        size: 1.0 + Math.random() * 1.0,
        life: 0.45 + Math.random() * 0.4,
        grow: 2.4,
        v,
        damp: 2.4,
        gravity: 2.2, // billows up then settles back to the ground
        opacity: (0.32 + Math.random() * 0.22) * (0.6 + amount * 0.5),
      });
    }
  }

  // Lay continuous tyre marks: extend a ribbon from each rear wheel by appending a
  // quad from the previous edge to the new one. Each quad reuses the previous
  // quad's far edge as its near edge, so the trail is one unbroken streak even
  // through a sideways slide, instead of a chain of separate dashes.
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
    let st = this._skidPrev.get(kart);
    if (!st) {
      this._skidPrev.set(kart, { c: [cur[0].clone(), cur[1].clone()], e: [null, null] });
      return;
    }
    const HALF = 0.3; // half the mark width
    for (let i = 0; i < 2; i++) {
      const a = st.c[i];
      const b = cur[i];
      const step = a.distanceToSquared(b);
      if (step < 0.12) continue; // too little movement — let it accumulate (no degenerate quad)
      if (step > 36) {
        // Resumed after a gap (or race reset): start a fresh run, no bridge.
        a.copy(b);
        st.e[i] = null;
        continue;
      }
      // Perpendicular to travel (in XZ) gives the two edge points of the new end.
      const dx = b.x - a.x, dz = b.z - a.z;
      const inv = HALF / Math.hypot(dx, dz);
      const px = dz * inv, pz = -dx * inv;
      const bL = new THREE.Vector3(b.x + px, b.y, b.z + pz);
      const bR = new THREE.Vector3(b.x - px, b.y, b.z - pz);
      // Near edge = the previous quad's far edge (continuous), or seed it at `a`.
      const near = st.e[i] || { L: new THREE.Vector3(a.x + px, a.y, a.z + pz), R: new THREE.Vector3(a.x - px, a.y, a.z - pz) };
      this._appendSkidQuad(near.L, near.R, bL, bR);
      st.e[i] = { L: bL, R: bR };
      a.copy(b);
    }
  }

  // Write one ribbon quad (2 triangles, 6 verts) into the skid ring buffer.
  _appendSkidQuad(aL, aR, bL, bR) {
    const q = this.skidHead;
    const P = this.skidPos, U = this.skidUV;
    const pB = q * 18, uB = q * 12;
    const verts = [aL, aR, bR, aL, bR, bL]; // tri1: aL,aR,bR  tri2: aL,bR,bL
    const uvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]; // U across width (soft edges), V along length
    for (let k = 0; k < 6; k++) {
      P[pB + k * 3] = verts[k].x;
      P[pB + k * 3 + 1] = verts[k].y;
      P[pB + k * 3 + 2] = verts[k].z;
      U[uB + k * 2] = uvs[k * 2];
      U[uB + k * 2 + 1] = uvs[k * 2 + 1];
    }
    this.skidHead = (this.skidHead + 1) % this.skidMax;
    this.skidFill = Math.min(this.skidFill + 1, this.skidMax);
    this.skidGeo.setDrawRange(0, this.skidFill * 6);
    this._skidDirty = true;
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
    // Upload skid-ribbon edits once per frame (batches all this frame's appends).
    if (this._skidDirty) {
      this.skidGeo.attributes.position.needsUpdate = true;
      this.skidGeo.attributes.uv.needsUpdate = true;
      this._skidDirty = false;
    }
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

// Skid-mark width texture: opaque centre feathering to transparent at both edges,
// so the ribbon's sides are soft instead of a hard rectangle (U runs across width).
function skidTexture() {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 4;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 32, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.25, "rgba(255,255,255,1)");
  g.addColorStop(0.75, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 4);
  return new THREE.CanvasTexture(c);
}
