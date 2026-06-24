import * as THREE from "three";
import { biomeBarrierStyle, biomeRoadStyle } from "./scenery.js";

// Bluish-white tone for the alpine road's icy patches.
const SNOW_PATCH = new THREE.Color(0xdfeaf5);

// Glowing cyan chevron texture for boost pads (arrows point "up" = forward).
let _chevronTex = null;
function chevronTexture() {
  if (_chevronTex) return _chevronTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0bd1e6";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let y = 6; y <= 54; y += 16) {
    ctx.beginPath();
    ctx.moveTo(12, y + 13);
    ctx.lineTo(32, y);
    ctx.lineTo(52, y + 13);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (_chevronTex = t);
}

// An irregular, organic puddle outline (a triangle fan with a noisy radius per
// angle) laid flat in the XZ plane. `aEdge` is 0 at the centre and 1 at the rim
// so the shader can fade the edge softly. `sx`/`sz` stretch it (e.g. along the
// road for the big one).
function puddleGeometry(baseR, sx = 1, sz = 1) {
  const segs = 22;
  const pos = [0, 0, 0];
  const edge = [0];
  const ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28, ph3 = Math.random() * 6.28;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const wob = 1 + 0.32 * Math.sin(a * 2 + ph1) + 0.18 * Math.sin(a * 3 + ph2) + 0.12 * Math.sin(a * 5 + ph3);
    const r = baseR * Math.max(0.45, wob);
    pos.push(Math.cos(a) * r * sx, 0, Math.sin(a) * r * sz);
    edge.push(1);
  }
  const idx = [];
  for (let i = 0; i < segs; i++) idx.push(0, 1 + i, 1 + ((i + 1) % segs));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}

// Wet, reflective puddle shader (Option A): reflects a procedural sky gradient
// plus a sharp sun glint, brightens at grazing angles (Fresnel), and ripples —
// all driven harder by rain. No extra render pass. Sky colours are the fixed
// sunny mood; uTime/uRain/uSunDir are fed each frame from the main loop.
function makePuddleMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // flat decal: visible regardless of triangle winding
    uniforms: {
      uTime: { value: 0 },
      uRain: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.82, 0.55) },
      uSkyTop: { value: new THREE.Color(0x2f74c8) },
      uSkyHorizon: { value: new THREE.Color(0xc4d8ea) },
      uBase: { value: new THREE.Color(0x0c1822) },
    },
    vertexShader: `
      attribute float aEdge;
      varying vec3 vWorld; varying float vEdge;
      void main(){
        vEdge = aEdge;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime; uniform float uRain; uniform vec3 uSunDir;
      uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uBase;
      varying vec3 vWorld; varying float vEdge;
      void main(){
        vec3 V = normalize(cameraPosition - vWorld);
        // Animated ripples perturb the up-normal (stronger in the rain) so the
        // reflection wobbles like real water.
        float amp = 0.09 + 0.16 * uRain;
        vec3 N = normalize(vec3(
          amp * (sin(vWorld.x * 1.6 + uTime * 2.3) + 0.6 * sin(vWorld.z * 1.0 - uTime * 1.7)),
          1.0,
          amp * (sin(vWorld.z * 1.4 + uTime * 1.9) + 0.6 * sin(vWorld.x * 0.9 + uTime * 1.4))
        ));
        vec3 R = reflect(-V, N);
        // Sky: bright pale horizon at grazing angles, deepening to blue overhead
        // (the bright grazing horizon band is the key wet cue).
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.5, clamp(R.y, 0.0, 1.0)));
        // Soft sun disc + a tight glint streak (bases clamped so pow() != NaN).
        float sd = clamp(dot(R, normalize(uSunDir)), 0.0001, 1.0);
        float sun = pow(sd, 16.0) * 0.45 + pow(sd, 140.0) * 1.5;
        // Fresnel: near-mirror at grazing angles, dark water looking straight down.
        float ndv = clamp(dot(vec3(0.0, 1.0, 0.0), V), 0.0, 1.0);
        float fres = pow(clamp(1.0 - ndv, 0.0001, 1.0), 3.0);
        float refl = mix(0.12, 0.97, fres) * (0.7 + 0.3 * uRain);
        vec3 col = mix(uBase, sky, refl) + vec3(1.0, 0.94, 0.8) * sun * (0.7 + 0.5 * uRain);
        float alpha = (1.0 - smoothstep(0.72, 1.0, vEdge)) * 0.92;
        gl_FragColor = vec4(clamp(col, 0.0, 4.0), alpha);
      }`,
  });
}

// Fine grayscale noise used as the road's bump map (asphalt grain).
function noiseTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(64, 64);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 140 + Math.random() * 115;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// A closed race track built from a smooth 3D Catmull-Rom loop. The curve now
// carries elevation (y), so the road climbs and dips. Provides the road mesh,
// barrier walls, start/finish line and helpers for projecting a world position
// onto the track (lap timing, AI, containment, ground height).
export class Track {
  constructor() {
    this.width = 30;
    this.halfWidth = this.width / 2;

    // Control points (x, z, y) — a long, tall, serpentine circuit with two
    // upper lobes and a winding lower half (see the design sketch). It runs
    // counter-clockwise, so it favours left-hand turns, and rolls up and down
    // big hills (two high shoulders on the left and right).
    const pts = [
      [0, -430, 0],
      [120, -400, 4],
      [210, -330, 14],
      [180, -250, 22],
      [250, -160, 30],
      [310, -40, 38],
      [270, 80, 32],
      [320, 200, 22],
      [280, 330, 12],
      [180, 420, 5],
      [80, 400, 6],
      [55, 300, 12],
      [-45, 300, 14],
      [-70, 400, 8],
      [-170, 430, 4],
      [-280, 350, 28],
      [-310, 200, 58],
      [-250, 90, 78],
      [-300, -40, 84],
      [-250, -160, 58],
      [-280, -290, 28],
      [-180, -370, 8],
      [-70, -400, 3],
    ].map(([x, z, y]) => new THREE.Vector3(x, y, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.length = this.curve.getLength();

    // Precompute samples for fast nearest-point lookups.
    this.samples = 1000;
    this._pts = [];
    this._tans = [];
    for (let i = 0; i < this.samples; i++) {
      const t = i / this.samples;
      this._pts.push(this.curve.getPointAt(t));
      this._tans.push(this.curve.getTangentAt(t));
    }

    // Point list for cheap distance/height queries used by scenery.
    this._coarse = [];
    for (let i = 0; i < this.samples; i += 2) this._coarse.push(this._pts[i]);

    this.group = new THREE.Group();
    this._buildRoad();
  }

  _sideAt(i) {
    return new THREE.Vector3().crossVectors(this._tans[i], new THREE.Vector3(0, 1, 0)).normalize();
  }

  _buildRoad() {
    const div = this.samples;
    const cross = 5; // subdivisions across the road, for color variation
    const vpr = cross + 1; // vertices per row
    const positions = [];
    const uvs = [];
    const colors = [];
    const indices = [];
    const base = new THREE.Color(0x53535b); // asphalt
    const c = new THREE.Color();

    const hash = (a, b) => {
      const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      for (let j = 0; j < vpr; j++) {
        const f = j / cross; // 0..1 across the road
        const lat = -this.halfWidth + f * this.width;
        const x = p.x + side.x * lat;
        const z = p.z + side.z * lat;
        positions.push(x, p.y + 0.02, z);
        uvs.push(f, i * 0.1);

        // Asphalt tone: smooth patchy variation + fine grain, with two faint
        // darker "tyre line" bands where karts tend to drive.
        let shade =
          1 +
          0.07 * Math.sin(x * 0.05) * Math.cos(z * 0.045) +
          0.05 * Math.sin(x * 0.013 + z * 0.017) +
          (hash(idx, j) - 0.5) * 0.07;
        const lane = Math.min(Math.abs(f - 0.32), Math.abs(f - 0.68));
        if (lane < 0.08) shade -= 0.06;
        // Biome surface: tint the asphalt and add per-biome speckle so the road
        // changes character as you lap (sandy/cracked desert, snowy/icy alpine,
        // damp forest tarmac, warm autumn).
        const style = biomeRoadStyle(x, z);
        const h2 = hash(idx * 1.7 + 3.1, j * 2.3 + 5.7);
        c.setRGB(base.r * style.tint[0], base.g * style.tint[1], base.b * style.tint[2]).multiplyScalar(shade);
        if (style.kind === "sand" && h2 < 0.05) c.multiplyScalar(0.55); // dark cracks
        else if (style.kind === "snow" && h2 > 0.9) c.lerp(SNOW_PATCH, 0.7); // icy patches
        else if (style.kind === "damp" && h2 > 0.93) c.multiplyScalar(0.7); // wet patches
        colors.push(c.r, c.g, c.b);
      }

      if (i < div) {
        const row = i * vpr;
        const next = (i + 1) * vpr;
        for (let j = 0; j < cross; j++) {
          indices.push(row + j, next + j, row + j + 1);
          indices.push(row + j + 1, next + j, next + j + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const bump = noiseTexture();
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(6, 6);
    bump.anisotropy = 8;
    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        bumpMap: bump,
        bumpScale: 0.25,
      })
    );
    road.receiveShadow = true;
    this.group.add(road);

    this._buildSandTrim();
    this._buildWalls();
    this._buildCenterLine();
    this._buildEdgeLines();
    this._buildBoostPads();
    this._buildPuddles();
    this._buildStartLine();
  }

  // Intentional puddles where water would actually pool: a big one in the LOWEST
  // part of the forest stretch (elongated along the road), and a few smaller ones
  // in other low spots. Odd organic shapes, wet/reflective shader. Centres go in
  // this.puddles so the main loop can splash when driven through in the rain.
  _buildPuddles() {
    this.puddles = [];
    const forest = [];
    for (let i = 0; i < this.samples; i++) {
      const p = this._pts[i];
      if (biomeRoadStyle(p.x, p.z).kind === "damp") forest.push({ i, p });
    }
    if (!forest.length) return;
    forest.sort((a, b) => a.p.y - b.p.y); // lowest first
    this.puddleMaterial = makePuddleMaterial();

    const placed = [];
    const addPuddle = (s, baseR, sx, sz, alignTangent) => {
      const mesh = new THREE.Mesh(puddleGeometry(baseR, sx, sz), this.puddleMaterial);
      mesh.position.set(s.p.x, s.p.y + 0.04, s.p.z);
      if (alignTangent) {
        const t = this._tans[s.i];
        mesh.rotation.y = Math.atan2(t.x, t.z); // stretch runs along the road
      } else {
        mesh.rotation.y = Math.random() * Math.PI * 2;
      }
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.puddles.push({ x: s.p.x, z: s.p.z, r: baseR * Math.max(sx, sz) });
      placed.push(s.p);
    };

    // Big puddle flooding the lowest dip, stretched along the road.
    addPuddle(forest[0], 7.5, 1.0, 1.7, true);
    // A handful of small puddles in other genuinely low, spaced-out spots.
    const minY = forest[0].p.y;
    let count = 0;
    for (let k = 1; k < forest.length && count < 5; k++) {
      const s = forest[k];
      if (s.p.y > minY + 16) break; // only the low areas
      if (placed.some((q) => (q.x - s.p.x) ** 2 + (q.z - s.p.z) ** 2 < 30 * 30)) continue; // keep them apart
      addPuddle(s, 1.8 + Math.random() * 1.8, 1, 1, false);
      count++;
    }
  }

  // Glowing chevron pads painted on the road that kick your speed when driven
  // over. Built as a short ribbon that follows the road samples so the pad lies
  // flush across pitch and curve. Records centres in this.boostPads.
  _buildBoostPads() {
    this.boostPads = [];
    const halfW = 6;
    const ringsHalf = 2; // samples each side of centre (pad ~conforms over its length)
    const mat = new THREE.MeshBasicMaterial({
      map: chevronTexture(),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide, // flat decal: stay visible regardless of winding
    });
    const div = this.samples;
    for (const t of [0.12, 0.38, 0.6, 0.85]) {
      const ci = Math.round(t * div) % div;
      const positions = [];
      const uvs = [];
      const indices = [];
      const nRings = ringsHalf * 2 + 1;
      for (let r = 0; r < nRings; r++) {
        const idx = (((ci - ringsHalf + r) % div) + div) % div;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        positions.push(
          p.x + side.x * halfW, p.y + 0.06, p.z + side.z * halfW,
          p.x - side.x * halfW, p.y + 0.06, p.z - side.z * halfW
        );
        const v = r / (nRings - 1);
        uvs.push(0, v, 1, v);
        if (r < nRings - 1) {
          const a = r * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 1; // draw over the road
      this.group.add(mesh);
      const pc = this._pts[ci];
      this.boostPads.push({ x: pc.x, z: pc.z, r: 6 });
    }
  }

  // Solid painted lines down both edges of the tarmac (just inside the verge).
  _buildEdgeLines() {
    const inset = this.halfWidth - 0.55;
    const hw = 0.22; // half-width of the painted line
    const mat = new THREE.MeshStandardMaterial({
      color: 0xece7da,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    for (const sgn of [1, -1]) {
      const positions = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        const a = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset - hw));
        const b = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset + hw));
        positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
        if (i < this.samples) {
          const k = i * 2;
          indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _buildSandTrim() {
    const div = this.samples;
    const positions = [];
    const colors = [];
    const indices = [];
    const trim = 3.2;
    const sand = new THREE.Color(0xc2a86a);
    const red = new THREE.Color(0xd83a2f);
    const white = new THREE.Color(0xf2f2f2);
    const c = new THREE.Color();
    const tanAng = (k) => {
      const t = this._tans[((k % div) + div) % div];
      return Math.atan2(t.x, t.z);
    };
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      // Local curvature: how much the heading turns over a short look-ahead. On
      // bends the verge becomes a red/white rumble kerb; straights stay sandy.
      let d = tanAng(idx + 10) - tanAng(idx);
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > 0.055) c.copy(Math.floor(i / 2) % 2 === 0 ? red : white);
      else c.copy(sand);
      const lOut = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth + trim);
      const lIn = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const rIn = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);
      const rOut = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth - trim);
      positions.push(lOut.x, lOut.y, lOut.z, lIn.x, lIn.y, lIn.z, rIn.x, rIn.y, rIn.z, rOut.x, rOut.y, rOut.z);
      for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
      if (i < div) {
        const a = i * 4;
        indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        indices.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const wallH = 1.6;
    const off = this.halfWidth + 0.8; // inner face — kept where the old thin wall sat
    const ca = new THREE.Color();
    const cb = new THREE.Color();

    // Cross-section of the barrier, offset OUTWARD from the road (sOff) and UP
    // (yOff): a solid wall with a rounded top, so it reads as a chunky kerb
    // rather than a paper-thin ribbon. Swept along the spine below.
    const W = 0.85; // thickness
    const r = W / 2; // top round radius
    const shoulderY = wallH - r;
    const profile = [[0, 0]];
    const ARC = 5;
    for (let k = 0; k <= ARC; k++) {
      const a = Math.PI * (1 - k / ARC); // inner shoulder -> over the top -> outer shoulder
      profile.push([r + Math.cos(a) * r, shoulderY + Math.sin(a) * r]);
    }
    profile.push([W, 0]);
    const P = profile.length;

    // Continuous barriers (no gaps) down each side of the road. The two
    // alternating colours come from the biome the segment sits in, so the
    // fencing changes as you pass from meadow to forest to desert, etc.
    for (const dirSign of [1, -1]) {
      const positions = [];
      const colors = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx); // horizontal lateral; outward when scaled by dirSign
        const style = biomeBarrierStyle(p.x + side.x * dirSign * off, p.z + side.z * dirSign * off);
        const c = Math.floor(i / 6) % 2 === 0 ? ca.set(style.a) : cb.set(style.b);
        for (const [sOff, yOff] of profile) {
          const d = off + sOff;
          positions.push(p.x + side.x * dirSign * d, p.y + yOff, p.z + side.z * dirSign * d);
          colors.push(c.r, c.g, c.b);
        }
        if (i < this.samples) {
          const a0 = i * P;
          const b0 = (i + 1) * P;
          for (let j = 0; j < P - 1; j++) {
            indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _buildCenterLine() {
    // A continuous painted line down the centre of the road (offset a hair above
    // the surface so it reads as painted on, following the road's pitch/curve).
    const hw = 0.24; // half-width of the line
    const positions = [];
    const indices = [];
    for (let i = 0; i <= this.samples; i++) {
      const idx = i % this.samples;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      const a = new THREE.Vector3().copy(p).addScaledVector(side, -hw);
      const b = new THREE.Vector3().copy(p).addScaledVector(side, hw);
      positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
      if (i < this.samples) {
        const k = i * 2;
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xf4cf3a, roughness: 0.9, side: THREE.DoubleSide })
    );
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildStartLine() {
    const p = this.curve.getPointAt(0);
    const tan = this.curve.getTangentAt(0);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();

    const cols = 11;
    const cellW = this.width / cols;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 2; r++) {
        const cell = new THREE.Mesh(
          new THREE.PlaneGeometry(cellW, 1.6),
          new THREE.MeshStandardMaterial({ color: (c + r) % 2 === 0 ? 0x111111 : 0xffffff })
        );
        const offSide = (c + 0.5) * cellW - this.halfWidth;
        const offFwd = (r - 0.5) * 1.7;
        const pos = new THREE.Vector3().copy(p).addScaledVector(side, offSide).addScaledVector(tan, offFwd);
        cell.position.set(pos.x, pos.y + 0.06, pos.z);
        cell.rotation.x = -Math.PI / 2;
        cell.rotation.z = -Math.atan2(tan.z, tan.x) + Math.PI / 2;
        this.group.add(cell);
      }
    }

    // Archway over the track: a single tube that rises as a post on each side
    // and curves over the road into a rounded arch. The apex is recorded so the
    // finish fireworks can burst from it.
    const up = new THREE.Vector3(0, 1, 0);
    const W = this.halfWidth + 1.6; // post offset from centre
    const postH = 5.5; // straight post height before the arch curves
    const archRise = 5.0; // how high the arch bulges above the posts
    const pt = (s, y) => new THREE.Vector3().copy(p).addScaledVector(side, s).addScaledVector(up, y);
    const archPts = [pt(-W, 0)]; // left base
    const ARCSEG = 16;
    for (let k = 0; k <= ARCSEG; k++) {
      const a = Math.PI * (1 - k / ARCSEG); // left shoulder -> apex -> right shoulder
      archPts.push(pt(W * Math.cos(a), postH + archRise * Math.sin(a)));
    }
    archPts.push(pt(W, 0)); // right base
    const archGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(archPts), 90, 0.55, 12, false);
    const arch = new THREE.Mesh(
      archGeo,
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.55, metalness: 0.1 })
    );
    arch.castShadow = true;
    this.group.add(arch);

    // Golden finials at the apex and shoulders for a fairground gate look.
    const finialMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.5, metalness: 0.3 });
    this.archApex = pt(0, postH + archRise);
    for (const s of [-W, 0, W]) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 12), finialMat);
      ball.position.copy(pt(s, s === 0 ? postH + archRise : postH));
      ball.castShadow = true;
      this.group.add(ball);
    }
  }

  getPointAt(t) {
    return this.curve.getPointAt(((t % 1) + 1) % 1);
  }

  getTangentAt(t) {
    return this.curve.getTangentAt(((t % 1) + 1) % 1);
  }

  // Closest point on the polyline `pts` to (x,z), interpolated *along* the
  // nearest segment so the result (especially height) is continuous — no
  // stair-stepping as you cross sample boundaries.
  _projectArr(pts, x, z) {
    const N = pts.length;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x;
      const dz = pts[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let rDist = Infinity;
    let ry = pts[best].y;
    let ri = best;
    let ru = 0;
    let cx = pts[best].x;
    let cz = pts[best].z;
    for (const di of [-1, 0]) {
      const a = (best + di + N) % N;
      const b = (a + 1) % N;
      const ax = pts[a].x;
      const az = pts[a].z;
      const ex = pts[b].x - ax;
      const ez = pts[b].z - az;
      const len2 = ex * ex + ez * ez || 1;
      let u = ((x - ax) * ex + (z - az) * ez) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = ax + ex * u;
      const pz = az + ez * u;
      const dx = x - px;
      const dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < rDist) {
        rDist = d;
        ry = pts[a].y + (pts[b].y - pts[a].y) * u;
        ri = a;
        ru = u;
        cx = px;
        cz = pz;
      }
    }
    return { dist: Math.sqrt(rDist), y: ry, i: ri, u: ru, cx, cz };
  }

  // Projection onto the centerline with an interpolated ground height:
  // { t, point, tangent, side, lateral, distance, groundY }.
  project(pos) {
    const r = this._projectArr(this._pts, pos.x, pos.z);
    const t = (r.i + r.u) / this.samples;
    const point = new THREE.Vector3(r.cx, r.y, r.cz);
    const tangent = this._tans[r.i];
    const side = this._sideAt(r.i);
    const lateral = (pos.x - r.cx) * side.x + (pos.z - r.cz) * side.z;
    return { t, point, tangent, side, lateral, distance: r.dist, groundY: r.y };
  }

  // Nearest XZ distance + interpolated height (coarse, for scenery).
  groundInfo(x, z) {
    const r = this._projectArr(this._coarse, x, z);
    return { dist: r.dist, y: r.y };
  }

  distanceToCenter(x, z) {
    return this.groundInfo(x, z).dist;
  }

  // World position + heading for a starting grid slot (on the road surface).
  gridSlot(index) {
    const back = 8 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const tApprox = -back / this.length;
    const p = this.getPointAt(tApprox);
    const tan = this.getTangentAt(tApprox);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
    const pos = new THREE.Vector3().copy(p).addScaledVector(side, lateral);
    const heading = Math.atan2(tan.x, tan.z);
    return { position: pos, heading };
  }
}
