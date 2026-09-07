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
// Scratch objects reused by every emitter, so spawning particles allocates
// nothing per call: _spawn clones pos/v and unpacks the colour into scalars, so
// none of these are ever retained. (_rearPos/_rearFwd are _rear()'s own pair so
// callers can keep using _fwd/_vel across a _rear call.)
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _col = new THREE.Color();
const _rearFwd = new THREE.Vector3();
const _rearPos = new THREE.Vector3();
const _skidCur = [new THREE.Vector3(), new THREE.Vector3()]; // per-wheel contact scratch
// Constant UVs for one skid quad (U across the width for soft edges, V along it).
const _SKID_UVS = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
const _skidVerts = new Array(6); // scratch vert list for one quad

export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.parts = []; // { pos, v, r,g,b, life, opacity, scale, grow, damp, gravity, spark }
    // Hard cap on live particles, so a whole field boosting at once can't spike the
    // count. Over budget, the oldest (most-faded) is recycled before spawning.
    // (240 -> 280 when the wake-wash/tire-grit emitters landed — both are
    // rate-limited, but flat-out driving now runs dust + wash + grit + streaks
    // together and the old cap made bursts steal each other's particles.)
    this.maxParts = 280;
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
    // Dirty window for partial uploads: this frame's appends are consecutive ring
    // slots, so one (start, count) pair — split in two if it wraps — covers them.
    this._skidDirtyFrom = 0;
    this._skidDirtyN = 0;
    const sc = this.skidMax * 6; // 6 verts per quad (2 triangles)
    this.skidPos = new Float32Array(sc * 3);
    this.skidUV = new Float32Array(sc * 2);
    // Every quad slot uses the same UVs, so fill them ALL once and keep the
    // attribute static — appends then only ever touch (and upload) positions.
    for (let q = 0; q < this.skidMax; q++) this.skidUV.set(_SKID_UVS, q * 12);
    this.skidGeo = new THREE.BufferGeometry();
    this.skidGeo.setAttribute("position", new THREE.BufferAttribute(this.skidPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.skidGeo.setAttribute("uv", new THREE.BufferAttribute(this.skidUV, 2));
    // Flat-on-road decals: normals are straight up. The material is unlit, but
    // the SSR normal pre-pass samples normals from EVERY rendered mesh, so a
    // missing attribute logs a TSL.NormalNode warning per shader compile.
    const skidNrm = new Float32Array(sc * 3);
    for (let i = 1; i < skidNrm.length; i += 3) skidNrm[i] = 1;
    this.skidGeo.setAttribute("normal", new THREE.BufferAttribute(skidNrm, 3));
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
    // kart -> { c:[Vec3,Vec3], e:[edge|null,…], s:[edge, edge] } per rear wheel.
    // WeakMap: karts are rebuilt every race, so a strong Map would pin each old
    // field's entries (and their vectors) for the whole session.
    this._skidPrev = new WeakMap();
    this._hue = 0;
    // Retired particle objects, reused by _spawn — steady-state racing (dust,
    // sparks, trails every frame) allocates nothing once the pool has warmed up.
    this._pool = [];
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
    let p;
    if (this.parts.length >= this.maxParts) {
      // Over budget: recycle the particle closest to death in place (the old
      // shift() moved the whole array per eviction — O(n) each, spiky in bursts).
      let idx = 0, best = Infinity;
      for (let i = 0; i < this.parts.length; i++) {
        if (this.parts[i].life < best) { best = this.parts[i].life; idx = i; }
      }
      p = this.parts[idx];
    } else {
      p = this._pool.pop();
      if (!p) p = { pos: new THREE.Vector3(), v: new THREE.Vector3(), r: 0, g: 0, b: 0, life: 0, opacity: 0, scale: 1, spark: false, grow: 0, damp: 2, gravity: 0 };
      this.parts.push(p);
    }
    p.pos.copy(pos);
    p.r = color.r; p.g = color.g; p.b = color.b;
    p.opacity = opts.opacity ?? 0.9;
    p.scale = opts.size ?? 1;
    p.spark = !!opts.spark;
    if (opts.v) p.v.copy(opts.v); else p.v.set(0, 0, 0);
    p.life = opts.life;
    p.grow = opts.grow ?? 0;
    p.damp = opts.damp ?? 2;
    p.gravity = opts.gravity ?? 0;
  }

  // Force one particle of each texture field and one (degenerate) skid quad so
  // their GPU pipelines compile NOW. Called during the race countdown — where a
  // stalled frame is invisible — instead of on each effect's first mid-race
  // use, which showed up as 0.5-1s freezes on iOS/WebGPU. The particles are
  // near-transparent, short-lived and spawned underground; the skid quad is
  // all-zero (degenerate triangles draw no fragments).
  warmup(pos) {
    _col.setHex(0xffffff);
    _vel.set(0, 0, 0);
    this._spawn(pos, _col, { spark: false, life: 0.12, opacity: 0.01, size: 0.5, v: _vel });
    this._spawn(pos, _col, { spark: true, life: 0.12, opacity: 0.01, size: 0.5, v: _vel });
    if (this.skidFill === 0) {
      this.skidFill = 1;
      this.skidHead = 1;
      this.skidGeo.setDrawRange(0, 6);
      this._skidDirtyFrom = 0;
      this._skidDirtyN = 1;
    }
  }

  // Returns a shared scratch vector — callers hand it straight to _spawn (which
  // clones) and must not retain it.
  _rear(kart, spread) {
    _rearFwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    _rearPos.copy(kart.position).addScaledVector(_rearFwd, -2.6);
    _rearPos.x += (Math.random() - 0.5) * spread;
    _rearPos.y += kart.y + 0.7 + Math.random() * 0.3;
    _rearPos.z += (Math.random() - 0.5) * spread;
    return _rearPos;
  }

  // Boost cloud burst, coloured by how much was charged (matching the drift-
  // charge spark tiers): a solid blue cloud for a light charge, gold for a mid
  // charge, and a full rainbow only at full charge. The toot-meter boost passes
  // the default high charge, so the button toot is always the rainbow one.
  tootBurst(kart, charge = 2, green = false) {
    const rainbow = !green && charge > 1.5;
    const tier = charge > 0.8 ? 0xffd54f : 0xbfe3ff;
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    for (let i = 0; i < 16; i++) {
      if (green) _col.setHSL(0.28, 0.85, 0.4 + Math.random() * 0.2);
      else if (rainbow) _col.setHSL((this._hue + i / 16) % 1, 1, 0.6);
      else _col.setHex(tier);
      _vel
        .set((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6)
        .addScaledVector(_fwd, -(5 + Math.random() * 6));
      this._spawn(this._rear(kart, 1.6), _col, {
        additive: true,
        size: 2.2 + Math.random(),
        life: 0.7 + Math.random() * 0.5,
        grow: 4,
        v: _vel,
        opacity: 0.85,
      });
    }
    if (rainbow) this._hue = (this._hue + 0.13) % 1;
  }

  // Continuous trail while boosting — rainbow normally, green for a catnip boost.
  trickle(kart, green = false) {
    if (green) {
      _col.setHSL(0.28, 0.85, 0.45 + Math.random() * 0.12);
    } else {
      this._hue = (this._hue + 0.05) % 1;
      _col.setHSL(this._hue, 1, 0.6);
    }
    this._spawn(this._rear(kart, 0.8), _col, {
      additive: true,
      size: 1.6,
      life: 0.55,
      grow: 3,
      v: _vel.set(0, 1.5, 0),
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

    let size = 0.6 + Math.min(charge, 2) * 0.18;
    if (maxed) {
      this._hue = (this._hue + 0.07) % 1;
      _col.setHSL(this._hue, 1, 0.62);
      size += 0.25;
    } else if (charge > 0.8) {
      _col.setHex(0xffd54f);
    } else {
      _col.setHex(0xbfe3ff);
    }
    _vel.set((Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8);
    this._spawn(this._rear(kart, 0.6), _col, {
      additive: true,
      spark: true,
      size,
      life: 0.32,
      v: _vel,
      damp: 1,
    });

    // At full charge, add the occasional soft rainbow puff so the kart visibly
    // brims with the colour it's about to unleash.
    if (maxed && Math.random() < 0.3) {
      this._spawn(this._rear(kart, 0.9), _col, {
        additive: true,
        size: 1.3,
        life: 0.4,
        grow: 2,
        v: _vel.set(0, 1.6, 0),
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
    this._spawn(origin, _col.setHSL(baseHue, 0.5, 0.92), {
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
      _col.setHSL((baseHue + Math.random() * 0.18) % 1, 1, 0.62);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = 14 + Math.random() * 13;
      _vel.set(
        Math.sin(phi) * Math.cos(theta),
        Math.abs(Math.cos(phi)) * 0.7 + 0.5, // bias the spray upward
        Math.sin(phi) * Math.sin(theta)
      ).multiplyScalar(sp);
      this._spawn(origin, _col, {
        additive: true,
        spark: true,
        size: 1.2 + Math.random() * 0.8,
        life: 1.1 + Math.random() * 0.9,
        v: _vel,
        damp: 0.5,
        gravity: 9,
      });
    }
    // A few fat, slow trailing comets for extra drama.
    for (let i = 0; i < 7; i++) {
      _col.setHSL((baseHue + 0.5 + Math.random() * 0.2) % 1, 1, 0.66);
      const a = Math.random() * Math.PI * 2;
      _vel.set(Math.cos(a) * 6, 9 + Math.random() * 6, Math.sin(a) * 6);
      this._spawn(origin, _col, {
        additive: true,
        size: 2.0 + Math.random(),
        life: 1.4 + Math.random() * 0.8,
        grow: 1.5,
        v: _vel,
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
      _vel.set(Math.cos(a) * sp, 2.5 + Math.random() * 2.5, Math.sin(a) * sp);
      _pos.copy(pos);
      _pos.y += 0.2;
      this._spawn(_pos, _col.setHex(0xcfe8ff), {
        size: 0.35 + Math.random() * 0.3,
        life: 0.4,
        v: _vel,
        damp: 1.4,
        gravity: 13,
        opacity: 0.8,
      });
    }
  }

  wallSparks(kart) {
    const n = 4 + Math.floor(Math.random() * 4);
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    _pos.copy(kart.position).addScaledVector(kart.wallHitDir, kart.radius);
    _pos.y = kart.position.y + 0.6;
    for (let i = 0; i < n; i++) {
      _col.setHex(Math.random() < 0.5 ? 0xffe082 : 0xff8a3d);
      _vel
        .set((Math.random() - 0.5) * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3)
        .addScaledVector(_fwd, -(Math.random() * 6))
        .addScaledVector(kart.wallHitDir, 4 + Math.random() * 6);
      this._spawn(_pos, _col, { additive: true, spark: true, size: 0.6, life: 0.3, v: _vel, damp: 1 });
    }
  }

  // Slipstream wind — rushing speed-lines past a kart tucked in a rival's wake; the
  // "it's working" cue for the faster boost charge. Rate/brightness/length scale
  // with the draft strength (0..1). Streaks stream BACKWARD relative to the kart
  // (spark particles stretch along their velocity) so they read as wind whipping by.
  slipstreamWind(kart, strength) {
    if (Math.random() > 0.4 + strength * 0.5) return;
    const fwx = Math.sin(kart.heading), fwz = Math.cos(kart.heading);
    const rx = Math.cos(kart.heading), rz = -Math.sin(kart.heading); // kart's right
    const sp = 26 + Math.abs(kart.speed) * 0.6;
    const n = strength > 0.6 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const side = (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 1.2);
      const fore = 1.2 + Math.random() * 1.6;
      _pos.copy(kart.position);
      _pos.x += rx * side + fwx * fore;
      _pos.z += rz * side + fwz * fore;
      _pos.y += kart.y + 0.6 + Math.random() * 0.7;
      _vel.set(-fwx * sp, (Math.random() - 0.5) * 2, -fwz * sp);
      _col.setHex(0xdff1ff);
      this._spawn(_pos, _col, {
        additive: true, spark: true, size: 0.5 + strength * 0.45,
        life: 0.18, v: _vel, opacity: 0.22 + strength * 0.4, damp: 0.5,
      });
    }
  }

  // Wind streaks at sustained near-top speed and under boosts — the classic
  // "speed lines" trick: short-lived bright specks spawned wide of the kart and
  // ahead of the camera, flung backward faster than the kart moves so they whip
  // past the edges of the frame. Same recipe as slipstreamWind but wider and
  // higher (framing the screen, not hugging a rival's wake) so it reads as raw
  // velocity anywhere on track. `strength` 0..1 ramps rate/brightness/size.
  windStreaks(kart, strength) {
    // Deliberately sparse and faint (playtested down from a denser first cut —
    // bright dots floating over the kart read as clutter, not wind): one low,
    // dim speck at a time, kept wide of the kart so it skims the frame edges.
    if (Math.random() > 0.22 + strength * 0.42) return;
    const fwx = Math.sin(kart.heading), fwz = Math.cos(kart.heading);
    const rx = Math.cos(kart.heading), rz = -Math.sin(kart.heading); // kart's right
    const sp = 30 + Math.abs(kart.speed) * 0.9;
    // Wide of the racing line so streaks frame the view instead of crossing it.
    const side = (Math.random() < 0.5 ? -1 : 1) * (3.4 + Math.random() * 2.2);
    const fore = 4 + Math.random() * 7;
    _pos.copy(kart.position);
    _pos.x += rx * side + fwx * fore;
    _pos.z += rz * side + fwz * fore;
    _pos.y += kart.y + 0.3 + Math.random() * 1.1; // hug the road — never over the kart's head
    _vel.set(-fwx * sp, (Math.random() - 0.5) * 1.5, -fwz * sp);
    _col.setHex(0xf2f8ff);
    this._spawn(_pos, _col, {
      additive: true, spark: true, size: 0.28 + strength * 0.18,
      life: 0.18, v: _vel, opacity: 0.06 + strength * 0.15, damp: 0.3,
    });
  }

  // A faint wake trailing a kart that's BEING drafted, so the sweet spot behind it
  // is visible to aim for. Subtle by design — it shouldn't compete with drift/boost.
  slipstreamWake(kart, strength) {
    if (Math.random() > 0.28 * strength) return;
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    _pos.copy(kart.position).addScaledVector(_fwd, -2.6);
    _pos.y += kart.y + 0.6;
    _vel.set(-_fwd.x * 3, 0.3, -_fwd.z * 3);
    _col.setHex(0xcfe6ff);
    this._spawn(_pos, _col, { additive: true, size: 1.1, life: 0.4, grow: 1.6, v: _vel, opacity: 0.12 });
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
    _right.set(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const groundY = (kart.groundY ?? kart.y ?? 0) + 0.15;
    for (let i = 0; i < n; i++) {
      const side = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.7);
      _pos
        .copy(kart.position)
        .addScaledVector(_fwd, -1.7 - Math.random())
        .addScaledVector(_right, side);
      _pos.y = groundY;
      _vel
        .set(0, 0.7 + Math.random() * 1.1, 0)
        .addScaledVector(_right, side * (1.4 + Math.random() * 2)) // splay outward from the tyre
        .addScaledVector(_fwd, -(1 + Math.random() * 1.8)); // and trail backward
      _col.copy(color || _DUST_FALLBACK).multiplyScalar(0.82 + Math.random() * 0.3);
      this._spawn(_pos, _col, {
        size: 1.0 + Math.random() * 1.0,
        life: 0.45 + Math.random() * 0.4,
        grow: 2.4,
        v: _vel,
        damp: 2.4,
        gravity: 2.2, // billows up then settles back to the ground
        opacity: (0.32 + Math.random() * 0.22) * (0.6 + amount * 0.5),
      });
    }
  }

  // Wake wash — flecks of the local biome's loose debris (leaves, petals, sand,
  // paper scraps) yanked into the air by the kart's slipstream and arcing back
  // down behind it. Complements the static ground-leaf pop (scenery.js
  // buildGroundLeaves lifts the carpet in place) with airborne matter, so the
  // world visibly REACTS to your velocity — the strongest speed cue there is.
  // `color` comes from biomeDebrisColor; `strength` 0..1 ramps rate and count.
  wakeDebris(kart, color, strength = 1) {
    if (Math.random() > 0.22 + strength * 0.5) return;
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const n = strength > 0.8 && Math.random() < 0.4 ? 2 : 1;
    const groundY = (kart.groundY ?? kart.position.y) + 0.25;
    for (let i = 0; i < n; i++) {
      _pos
        .copy(kart.position)
        .addScaledVector(_fwd, -(2 + Math.random() * 1.5));
      _pos.x += (Math.random() - 0.5) * 2.4;
      _pos.z += (Math.random() - 0.5) * 2.4;
      _pos.y = groundY;
      _vel
        .set((Math.random() - 0.5) * 5, 2.5 + Math.random() * 3.5, (Math.random() - 0.5) * 5)
        .addScaledVector(_fwd, -(4 + Math.random() * 7)); // flung backward in the wake
      _col.copy(color).multiplyScalar(0.85 + Math.random() * 0.3);
      this._spawn(_pos, _col, {
        spark: Math.random() < 0.35, // a few tight flecks among the soft ones
        size: 0.24 + Math.random() * 0.2,
        life: 0.55 + Math.random() * 0.35,
        v: _vel,
        damp: 1.6,
        gravity: 10, // arcs up then settles — debris, not smoke
        opacity: 0.75,
      });
    }
  }

  // Tire grit — at the top of the speed range the rear tires flick tiny pale
  // chips backward that arc down under hard gravity. Small, low and short-lived
  // (deliberately unlike the wind streaks), it makes the tarmac itself read as
  // being WORKED at full speed.
  tireGrit(kart) {
    if (Math.random() > 0.55) return;
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    _right.set(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    const side = Math.random() < 0.5 ? -1.3 : 1.3; // one rear wheel or the other
    _pos
      .copy(kart.position)
      .addScaledVector(_fwd, -1.5)
      .addScaledVector(_right, side);
    _pos.y = (kart.groundY ?? kart.position.y) + 0.2;
    _vel
      .set(0, 2.5 + Math.random() * 2.5, 0)
      .addScaledVector(_fwd, -(9 + Math.random() * 8))
      .addScaledVector(_right, side * (0.6 + Math.random() * 1.4)); // splays off the tyre's outside edge
    _col.setHex(0xd8cdb4).multiplyScalar(0.8 + Math.random() * 0.4);
    this._spawn(_pos, _col, {
      spark: true,
      size: 0.15 + Math.random() * 0.1,
      life: 0.3 + Math.random() * 0.15,
      v: _vel,
      damp: 0.6,
      gravity: 20,
      opacity: 0.55,
    });
  }

  // Lay continuous tyre marks: extend a ribbon from each rear wheel by appending a
  // quad from the previous edge to the new one. Each quad reuses the previous
  // quad's far edge as its near edge, so the trail is one unbroken streak even
  // through a sideways slide, instead of a chain of separate dashes.
  skid(kart) {
    _right.set(Math.cos(kart.heading), 0, -Math.sin(kart.heading));
    _fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    // Current contact point behind each rear wheel (shared scratch pair).
    for (let i = 0; i < 2; i++) {
      _skidCur[i]
        .copy(kart.position)
        .addScaledVector(_right, i === 0 ? -1.3 : 1.3)
        .addScaledVector(_fwd, -1.4)
        .setY(kart.groundY + 0.05);
    }
    let st = this._skidPrev.get(kart);
    if (!st) {
      // Per-kart state keeps its own vectors (they persist across frames): the
      // live far edge `e` and a spare pair `s` that swaps with it each quad, so
      // laying marks allocates nothing after this first touch.
      const edge = () => ({ L: new THREE.Vector3(), R: new THREE.Vector3() });
      this._skidPrev.set(kart, { c: [_skidCur[0].clone(), _skidCur[1].clone()], e: [null, null], s: [edge(), edge()] });
      return;
    }
    const HALF = 0.3; // half the mark width
    for (let i = 0; i < 2; i++) {
      const a = st.c[i];
      const b = _skidCur[i];
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
      // Near edge = the previous quad's far edge (continuous), or seed it at `a`.
      if (!st.e[i]) {
        st.e[i] = st.s[i];
        st.e[i].L.set(a.x + px, a.y, a.z + pz);
        st.e[i].R.set(a.x - px, a.y, a.z - pz);
        st.s[i] = { L: new THREE.Vector3(), R: new THREE.Vector3() };
      }
      const near = st.e[i];
      const far = st.s[i];
      far.L.set(b.x + px, b.y, b.z + pz);
      far.R.set(b.x - px, b.y, b.z - pz);
      this._appendSkidQuad(near.L, near.R, far.L, far.R);
      st.s[i] = near; // recycle the consumed near edge as the next spare
      st.e[i] = far;
      a.copy(b);
    }
  }

  // Write one ribbon quad (2 triangles, 6 verts) into the skid ring buffer.
  // (UVs are constant per slot and prefilled at construction — positions only.)
  _appendSkidQuad(aL, aR, bL, bR) {
    const q = this.skidHead;
    const P = this.skidPos;
    const pB = q * 18;
    // tri1: aL,aR,bR  tri2: aL,bR,bL — written via the module scratch list.
    _skidVerts[0] = aL; _skidVerts[1] = aR; _skidVerts[2] = bR;
    _skidVerts[3] = aL; _skidVerts[4] = bR; _skidVerts[5] = bL;
    for (let k = 0; k < 6; k++) {
      P[pB + k * 3] = _skidVerts[k].x;
      P[pB + k * 3 + 1] = _skidVerts[k].y;
      P[pB + k * 3 + 2] = _skidVerts[k].z;
    }
    if (this._skidDirtyN === 0) this._skidDirtyFrom = q;
    this._skidDirtyN++;
    this.skidHead = (this.skidHead + 1) % this.skidMax;
    this.skidFill = Math.min(this.skidFill + 1, this.skidMax);
    this.skidGeo.setDrawRange(0, this.skidFill * 6);
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
      if (p.life <= 0) {
        // Swap-remove (order doesn't matter — the fields repack every frame);
        // splice() shifted the whole tail per death, O(n²) when a burst fades.
        this.parts[i] = this.parts[this.parts.length - 1];
        this.parts.pop();
        this._pool.push(p);
      }
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
    // Upload skid-ribbon edits once per frame — but only the quads appended this
    // frame (two ranges if the ring wrapped), not the whole ~80 KB buffer. A bare
    // needsUpdate re-uploaded every byte of the ring on every frame any kart was
    // laying marks, which is most of the race.
    if (this._skidDirtyN > 0) {
      const pos = this.skidGeo.attributes.position;
      const first = Math.min(this._skidDirtyN, this.skidMax - this._skidDirtyFrom);
      pos.addUpdateRange(this._skidDirtyFrom * 18, first * 18);
      if (this._skidDirtyN > first) pos.addUpdateRange(0, (this._skidDirtyN - first) * 18);
      pos.needsUpdate = true;
      this._skidDirtyN = 0;
    }
  }

  _flush(field, count) {
    field.mesh.count = count;
    if (!count) return;
    // Upload only the live instances, not the full 240-slot capacity.
    field.aPos.addUpdateRange(0, count * 3);
    field.aPos.needsUpdate = true;
    field.aColor.addUpdateRange(0, count * 3);
    field.aColor.needsUpdate = true;
    field.aScale.addUpdateRange(0, count);
    field.aScale.needsUpdate = true;
    field.aOpacity.addUpdateRange(0, count);
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
