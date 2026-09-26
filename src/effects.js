import * as THREE from "three";
import { attribute, texture, color, vec2, uv, float } from "three/tsl";

import { environmentAtlas, environmentProfile, ENVIRONMENT_LIMITS, emissionCount, debrisLight } from "./environment-particles.js";
import { uWindDir } from "./wind.js";

// Cel particle effects (procedural sprites): rainbow toot clouds, boost trail,
// drift/wall sparks, plus reusable tyre skid-mark quads.
//
// Gameplay particles retain two additive fields. Loose environmental material
// uses one normal-blended atlas field, sharing the same bounded particle pool.
// Shape/rotation data is packed into one attribute to fit the eight-buffer
// minimum supported by WebGPU. Only live instance ranges upload each frame.
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
    this.environmentField = this._makeField(environmentAtlas(), true);
    this.environmentCount = 0;
    this.environmentScale = 1;
    this._emission = new WeakMap();

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

  // Build one instanced billboard field reading per-instance position,
  // colour, scale and opacity from instanced attributes. The texture's painted alpha
  // shapes each particle; the tint comes from aColor.
  _makeField(tex, environment = false) {
    const cap = environment ? ENVIRONMENT_LIMITS.wake : this.maxParts;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mk = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const aPos = mk(3), aColor = mk(3), aScale = mk(environment ? 4 : 1), aOpacity = mk(1);
    geo.setAttribute("aPos", aPos);
    geo.setAttribute("aColor", aColor);
    geo.setAttribute("aScale", aScale);
    geo.setAttribute("aOpacity", aOpacity);
    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: environment ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: environment,
    });
    mat.positionNode = attribute("aPos"); // sprite centre (world space)
    mat.scaleNode = environment ? attribute("aScale","vec4").xy : attribute("aScale");
    mat.colorNode = environment ? attribute("aColor").mul(debrisLight) : attribute("aColor");
    const tile = attribute("aScale","vec4").z;
    const atlasUV = environment ? vec2(uv().x.add(tile.mod(4)).div(4), uv().y.add(float(1).sub(tile.div(4).floor())).div(2)) : uv();
    const sample = texture(tex, atlasUV);
    if(environment)mat.colorNode=attribute("aColor").mul(debrisLight).mul(sample.rgb);
    mat.opacityNode = sample.a.mul(attribute("aOpacity"));
    if(environment) mat.rotationNode = attribute("aScale","vec4").w;
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.count = 0;
    this.scene.add(mesh);
    return { mesh, aPos, aColor, aScale, aOpacity };
  }

  _spawn(pos, color, opts) {
    let p;
    const env = !!opts.env;
    if (this.parts.length >= this.maxParts || (env && this.environmentCount >= ENVIRONMENT_LIMITS.wake)) {
      // Environmental work never evicts a boost/drift particle. Gameplay effects
      // reclaim environmental slots first when the shared 280-slot pool is full.
      let idx = -1, best = Infinity;
      for (let i=0;i<this.parts.length;i++) if(this.parts[i].env && this.parts[i].life<best){best=this.parts[i].life;idx=i;}
      if(idx<0){if(env)return;for(let i=0;i<this.parts.length;i++)if(this.parts[i].life<best){best=this.parts[i].life;idx=i;}}
      p=this.parts[idx];if(p.env)this.environmentCount--;
    } else {
      p=this._pool.pop() || {pos:new THREE.Vector3(),v:new THREE.Vector3()};
      this.parts.push(p);
    }
    p.env=env;if(env)this.environmentCount++;
    p.tile=opts.tile??7;p.angle=opts.angle??0;p.spin=opts.spin??0;p.aspect=opts.aspect??1;
    p.floor=opts.floor??-Infinity;p.initialOpacity=opts.opacity??.9;p.maxLife=opts.life;
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
    // Stay above zero through the warm-up lifetime despite the 1.5/s fade.
    this._spawn(pos, _col, { spark: false, life: 0.12, opacity: 0.2, size: 0.5, v: _vel });
    this._spawn(pos, _col, { spark: true, life: 0.12, opacity: 0.2, size: 0.5, v: _vel });
    this._spawn(pos,_col,{env:true,tile:7,life:.12,opacity:.2,size:.5});
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

  _rate(kart, channel, rate, dt) {
    let state=this._emission.get(kart);
    if(!state){state={};this._emission.set(kart,state);}
    return emissionCount(state,channel,rate*this.environmentScale,dt);
  }

  // Material dust is normally blended and follows daylight/fog, never bloom.
  dust(kart, color, amount = 1, dt = 1/60, biome = 'meadow') {
    const n=this._rate(kart,'dust',Math.max(0,amount)*16,dt);
    _right.set(Math.cos(kart.heading),0,-Math.sin(kart.heading));
    _fwd.set(Math.sin(kart.heading),0,Math.cos(kart.heading));
    for(let i=0;i<n;i++){
      const side=Math.random()<.5?-1:1;
      _pos.copy(kart.position).addScaledVector(_fwd,-1.8).addScaledVector(_right,side*1.25);
      _pos.y=(kart.groundY??kart.position.y)+.18;
      _vel.copy(_right).multiplyScalar(side*(.6+Math.random())).addScaledVector(_fwd,-.7);_vel.y=.35+Math.random()*.5;
      _col.copy(color||_DUST_FALLBACK).multiplyScalar(.85+Math.random()*.1);
      this._spawn(_pos,_col,{env:true,tile:7,size:.65+Math.random()*.35,aspect:.65,life:.65+Math.random()*.2,grow:1.4,
        opacity:.16+Math.min(1,amount)*.15,v:_vel,damp:1.6,gravity:.65,floor:_pos.y-.1,angle:Math.random()*6.28,spin:.15});
    }
  }

  // A few recognisable pieces, with material-specific lift/drag. All use one
  // atlas field; botanical pieces flutter while grains/clumps fall quickly.
  wakeDebris(kart, color, strength = 1, dt = 1/60, biome = 'meadow') {
    const spec=environmentProfile(biome),n=this._rate(kart,'wake',Math.max(0,strength)*10,dt);
    _fwd.set(Math.sin(kart.heading),0,Math.cos(kart.heading));
    _right.set(Math.cos(kart.heading),0,-Math.sin(kart.heading));
    for(let i=0;i<n;i++){
      const side=Math.random()<.5?-1:1,light=spec.tile<3||spec.tile===5;
      _pos.copy(kart.position).addScaledVector(_fwd,-2).addScaledVector(_right,side*(1.1+Math.random()*.4));
      _pos.y=(kart.groundY??kart.position.y)+.15;
      _vel.copy(_fwd).multiplyScalar(-1-Math.random()*2).addScaledVector(_right,side*(.4+Math.random()));
      _vel.y=(.7+Math.random())*spec.lift*2;
      _col.set(spec.colors[(Math.random()*spec.colors.length)|0]);
      this._spawn(_pos,_col,{env:true,tile:spec.tile,size:spec.size*(.8+Math.random()*.6),aspect:light?.8:1,
        life:light?1.0+Math.random()*.4:.4+Math.random()*.25,opacity:.8,v:_vel,damp:light?1.1:2.2,
        gravity:light?2.5:7,floor:_pos.y-.1,angle:Math.random()*6.28,spin:(Math.random()-.5)*(light?5:2)});
    }
  }

  // Tire grit — at the top of the speed range the rear tires flick tiny pale
  // chips backward that arc down under hard gravity. Small, low and short-lived
  // (deliberately unlike the wind streaks), it makes the tarmac itself read as
  // being WORKED at full speed.
  tireGrit(kart, dt = 1/60) {
    const n=this._rate(kart,'grit',3,dt);
    _fwd.set(Math.sin(kart.heading),0,Math.cos(kart.heading));
    for(let i=0;i<n;i++){
      _pos.copy(kart.position).addScaledVector(_fwd,-1.6);_pos.y=(kart.groundY??kart.position.y)+.12;
      _vel.copy(_fwd).multiplyScalar(-3);_vel.y=.7;
      _col.setHex(0x858077);
      this._spawn(_pos,_col,{env:true,tile:3,size:.08,life:.3,opacity:.65,v:_vel,gravity:8,floor:_pos.y-.08});
    }
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
    // Retire fully faded particles too: their old lifetime could keep invisible
    // sprites simulating, uploading and drawing for over a second.
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.gravity) p.v.y -= p.gravity * dt;
      p.pos.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - Math.min(1, p.damp * dt));
      if (p.grow) p.scale += p.grow * dt;
      if(p.env){
        p.angle+=p.spin*dt;
        p.v.x+=uWindDir.value.x*.3*dt;p.v.z+=uWindDir.value.y*.3*dt;
        if(p.pos.y<p.floor){p.pos.y=p.floor;p.v.y=0;p.v.multiplyScalar(Math.exp(-7*dt));p.life=Math.min(p.life,.25);}
        p.opacity=p.initialOpacity*Math.min(1,p.life/.3);
      }else p.opacity = Math.max(0, p.opacity - dt * 1.5);
      if (p.life <= 0 || p.opacity <= 0) {
        // Swap-remove (order doesn't matter — the fields repack every frame);
        // splice() shifted the whole tail per death, O(n²) when a burst fades.
        this.parts[i] = this.parts[this.parts.length - 1];
        this.parts.pop();
        if(p.env)this.environmentCount--;
        this._pool.push(p);
      }
    }
    // Pack live particles into the two glow fields and the material atlas.
    let ns = 0, np = 0, ne = 0;
    for (const p of this.parts) {
      const f = p.env ? this.environmentField : p.spark ? this.sparkField : this.smokeField;
      const idx = p.env ? ne++ : p.spark ? np++ : ns++;
      f.aPos.setXYZ(idx, p.pos.x, p.pos.y, p.pos.z);
      f.aColor.setXYZ(idx, p.r, p.g, p.b);
      if(p.env){
        const flutter=p.tile<3||p.tile===5 ? .45+.55*Math.abs(Math.cos(p.angle*1.7)) : 1;
        f.aScale.setXYZW(idx,p.scale*flutter,p.scale*p.aspect,p.tile,p.angle);
      }else f.aScale.setX(idx, p.scale);
      f.aOpacity.setX(idx, p.opacity);
    }
    this._flush(this.smokeField, ns);
    this._flush(this.sparkField, np);
    this._flush(this.environmentField, ne);
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
    // Upload only the visible instances, not the full 280-slot capacity.
    field.aPos.addUpdateRange(0, count * 3);
    field.aPos.needsUpdate = true;
    field.aColor.addUpdateRange(0, count * 3);
    field.aColor.needsUpdate = true;
    field.aScale.addUpdateRange(0, count * field.aScale.itemSize);
    field.aScale.needsUpdate = true;
    field.aOpacity.addUpdateRange(0, count);
    field.aOpacity.needsUpdate = true;
  }
}

// Round glowing puffs and round hot glints, baked into the same two 64px
// textures. The existing two fields and particle budget stay unchanged.
function softTexture(spark) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (spark) {
    // Round hot glints, matching the circular boost glow without a tail.
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  } else {
    // Production's round additive glow: bright centre and a broad soft halo.
    // Baked once into the existing 64px texture, with no extra field or pass.
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(0.5, "rgba(255,255,255,0.4)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
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
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  for (const x of [9, 15, 21]) ctx.fillRect(x, 0, 1, 4);
  return new THREE.CanvasTexture(c);
}
