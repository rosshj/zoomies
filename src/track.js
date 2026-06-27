import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { attribute, color as tslColor } from "three/tsl";
import { biomeBarrierStyle, biomeRoadStyle, setBiomeLayout, setHeightSampler } from "./scenery.js";
import { rand, makeRng } from "./rng.js";

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v ?? 0.5));

// The original hand-authored circuit, kept as the "classic" preset. Triples are
// [x, z, y] (y is elevation), mapped to Vector3(x, y, z) at build time.
const CLASSIC_POINTS = [
  [0, -430, 0], [120, -400, 4], [210, -330, 14], [180, -250, 22], [250, -160, 30],
  [310, -40, 38], [270, 80, 32], [320, 200, 22], [280, 330, 12], [180, 420, 5],
  [80, 400, 6], [55, 300, 12], [-45, 300, 14], [-70, 400, 8], [-170, 430, 4],
  [-280, 350, 28], [-310, 200, 58], [-250, 90, 78], [-300, -40, 84], [-250, -160, 58],
  [-280, -290, 28], [-180, -370, 8], [-70, -400, 3],
];

// Procedurally generate a closed loop of control points from a few knobs. Built
// in POLAR coordinates (one radius per monotonically-increasing angle), which
// guarantees the loop never crosses itself — the worst pitfall in track gen.
//   size:      overall scale of the circuit (length)
//   curviness: how wiggly / how many corners (radius variance + point count)
//   hilliness: elevation amplitude (flat -> mountainous)
// Randomness (the loop's specific "personality") comes from the seeded `rand()`
// stream, so the same world seed reproduces the same track.
// Weighted sum of sine harmonics at angle `a`, normalized to ~[-1, 1]. `list` is
// [{k, w}]; one seeded phase per harmonic in `phases`.
function harmSum(list, a, phases) {
  let s = 0;
  let wsum = 0;
  for (let j = 0; j < list.length; j++) {
    s += list[j].w * Math.sin(list[j].k * a + phases[j]);
    wsum += list[j].w;
  }
  return wsum > 0 ? s / wsum : 0;
}

// Does the closed Catmull-Rom through `pts` (XZ plane) avoid crossing itself AND
// keep every corner above `minR`? A pure radius-per-angle loop can't fold or
// snake, so we let the points snake sideways and just validate the result.
function _loopOK(pts, minR) {
  const cv = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
  const S = 260;
  const P = [];
  for (let i = 0; i < S; i++) P.push(cv.getPointAt(i / S));
  const seg = (a, b, c, d) => {
    const ccw = (p, q, r) => (r.z - p.z) * (q.x - p.x) - (q.z - p.z) * (r.x - p.x);
    return (ccw(a, c, d) > 0) !== (ccw(b, c, d) > 0) && (ccw(a, b, c) > 0) !== (ccw(a, b, d) > 0);
  };
  for (let i = 0; i < S; i++) {
    for (let j = i + 2; j < S; j++) {
      if (i === 0 && j === S - 1) continue;
      if (seg(P[i], P[(i + 1) % S], P[j], P[(j + 1) % S])) return false;
    }
  }
  for (let i = 0; i < S; i++) {
    const p0 = P[(i - 1 + S) % S], p1 = P[i], p2 = P[(i + 1) % S];
    const a = p0.distanceTo(p1), b = p1.distanceTo(p2), c = p0.distanceTo(p2);
    const area = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z)) / 2;
    if (area > 1e-3 && (a * b * c) / (4 * area) < minR) return false;
  }
  return true;
}

// `rng` defaults to the shared world stream (so the built track matches the seed),
// but the menu preview passes an isolated stream seeded from the same value to
// draw the identical shape without disturbing the world build.
function generateLoopPoints(cfg, rng = rand) {
  const size = clamp01(cfg.size);
  const curviness = clamp01(cfg.curviness);
  const elevation = clamp01(cfg.hilliness); // how high/low (amplitude)
  const hills = clamp01(cfg.hills ?? 0.5); // how MANY hills (frequency)

  // How many curves the loop has scales with BOTH knobs, but the corner DENSITY
  // is tied to map size: a bigger circuit has room for more (and tighter-packed)
  // curves, a small one gets fewer, gentler bends — so small maps don't pinch the
  // road into corners too sharp for the roadside scenery to fit beside.
  const detail = curviness * (0.55 + 0.45 * size); // effective high-frequency curviness
  const N = 16 + Math.round(curviness * (8 + size * 20)); // ~24 on small maps, ~44 on big
  const baseR = 260 + size * 220;
  const hillAmp = elevation * 155;
  // Tightest centreline corner radius. The road is laid out flat across its width,
  // so a centreline radius below halfWidth (15) folds the inner edge over itself —
  // which looks especially broken where a tight corner also falls on a steep grade.
  // Keep a margin above halfWidth so the inner edge always has room (radius ~7).
  const MIN_CORNER = 22;

  // Elevation profile: number of hills scales with the Hills knob AND map size
  // (bigger maps fit more hills). 1/k weighting keeps the climbs/drops drivable
  // (the amplitude lives in the big low-frequency hill, with smaller bumps on top).
  const hillFreq = Math.max(1, Math.round((0.6 + hills * 5) * (0.6 + size * 0.7)));
  const eH = [];
  for (let k = 1; k <= hillFreq; k++) eH.push({ k, w: 1 / k });
  const ePhase = eH.map(() => rng() * TAU);

  // Build the XZ loop with a radial wobble (lobes/bays) PLUS a smaller tangential
  // snake (the track weaves sideways for S-bends, not just outward bulges).
  // Curviness scales both. Then validate the loop is simple + drivable, rerolling
  // at FULL strength until one passes (most do); a damped pass is a rare fallback.
  // Low harmonics (overall lobe count) follow curviness; the high harmonics that
  // pack in extra wiggles follow `detail`, so they thin out on small maps.
  const rH = [
    { k: 1, w: 0.45 },
    { k: 2, w: 0.85 },
    { k: 3, w: 0.4 + curviness * 0.9 },
    { k: 4, w: detail * 1.1 },
    { k: 5, w: detail * 0.85 },
    { k: 6, w: detail * 0.6 },
    { k: 7, w: detail * 0.4 },
  ];
  const tH = [
    { k: 1, w: 0.4 },
    { k: 2, w: 0.7 + curviness * 0.2 },
    { k: 3, w: 0.5 + detail * 0.8 },
    { k: 4, w: detail * 0.95 },
    { k: 5, w: detail * 0.65 },
  ];
  let best = null;
  for (let attempt = 0; attempt < 48; attempt++) {
    // Full strength for most attempts; only damp as a last resort if nothing valid.
    const damp = attempt < 40 ? 1 : Math.pow(0.85, attempt - 39);
    const radVar = (0.12 + curviness * 0.55 + detail * 0.18) * damp;
    const tangAmp = (curviness * 0.18 + detail * 0.2) * damp;
    const rPhase = rH.map(() => rng() * TAU);
    const tPhase = tH.map(() => rng() * TAU);

    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const r = baseR * (1 + radVar * harmSum(rH, a, rPhase));
      const tg = baseR * tangAmp * harmSum(tH, a, tPhase);
      const x = Math.cos(a) * r - Math.sin(a) * tg;
      const z = Math.sin(a) * r + Math.cos(a) * tg;
      const y = Math.max(0, hillAmp * (0.5 + 0.5 * harmSum(eH, a, ePhase)));
      pts.push(new THREE.Vector3(x, y, z));
    }
    best = pts;
    if (_loopOK(pts, MIN_CORNER)) return pts;
  }
  return best;
}

// Centreline control points a given track config WILL produce, for the menu map
// preview — without building the world or touching the shared RNG stream. Custom
// tracks reproduce the exact shape via an isolated stream seeded from the same
// value; classic returns the hand-authored circuit.
export function previewLoopPoints(config) {
  if (!config || config.mode !== "custom") {
    return CLASSIC_POINTS.map(([x, z, y]) => new THREE.Vector3(x, y, z));
  }
  return generateLoopPoints(config, makeRng(config.seed || "preview"));
}

// Cheap flat "wet sheen" shader for the forest puddles: a dark glossy patch with
// a grazing-angle (Fresnel) sky tint and a faint moving glint so it reads as
// standing water, with no extra render pass or reflection sampling. uBase is the
// dark water tone; uSky is the colour the surface brightens toward at the rim.
const PUDDLE_SHEEN_SHADER = {
  uniforms: {
    uTime: { value: 0 },
    uBase: { value: new THREE.Color(0x0c1822) },
    uSky: { value: new THREE.Color(0x9fb7c8) },
  },
  vertexShader: `
    attribute float aEdge;
    varying vec3 vWorld;
    varying float vEdge;
    void main(){
      vEdge = aEdge;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uBase;
    uniform vec3 uSky;
    varying vec3 vWorld;
    varying float vEdge;
    void main(){
      // Fresnel against the flat (upward) surface: brighter, sky-tinted at grazing angles.
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(clamp(1.0 - max(V.y, 0.0), 0.0001, 1.0), 3.0);
      // Faint moving glint so the water shimmers a little.
      float glint = 0.5 + 0.5 * sin(vWorld.x * 1.3 + vWorld.z * 1.1 + uTime * 1.6);
      vec3 col = mix(uBase, uSky, fres * 0.85) + glint * 0.04;
      float alpha = (1.0 - smoothstep(0.4, 1.0, vEdge)) * 0.9;
      gl_FragColor = vec4(col, alpha);
    }`,
};

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

// An irregular, organic puddle blob built flat in world XZ (y = 0; the mesh is
// lifted to the water level), centred at world (cx, cz). Triangle fan with a
// noisy radius per angle; `aEdge` is 0 at the centre and 1 at the rim for the
// soft edge fade. Multiple blobs merge into one wet-sheen decal mesh.
function puddleBlob(cx, cz, baseR, stretchZ) {
  const segs = 26;
  const pos = [cx, 0, cz];
  const edge = [0];
  const ph0 = Math.random() * 6.28, ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28, ph3 = Math.random() * 6.28;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    // Several harmonics (incl. a low one) for a clearly irregular, organic outline.
    const wob = 1 + 0.28 * Math.sin(a + ph0) + 0.4 * Math.sin(a * 2 + ph1) + 0.24 * Math.sin(a * 3 + ph2) + 0.15 * Math.sin(a * 5 + ph3);
    const r = baseR * Math.max(0.4, wob);
    const wx = cx + Math.cos(a) * r;
    const wz = cz + Math.sin(a) * r * stretchZ;
    pos.push(wx, 0, wz);
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
  // `config` (optional): { mode:"custom", size, curviness, hilliness, width }.
  // Without it (or mode !== "custom") the hand-authored classic circuit is used.
  constructor(config = null) {
    this.width = config && config.width ? config.width : 30;
    this.halfWidth = this.width / 2;

    // Control points (x, y, z). Either the procedural loop from the knobs, or
    // the classic hand-authored serpentine circuit.
    const pts =
      config && config.mode === "custom"
        ? generateLoopPoints(config)
        : CLASSIC_POINTS.map(([x, z, y]) => new THREE.Vector3(x, y, z));

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

    // Biome layout for this track: altitude-driven (alpine on the peaks, warm
    // biomes in the lows) for generated tracks; angular wedges for the classic
    // one. The height sampler lets biomeAt read the local road elevation. Set
    // BEFORE building the road so its biome styling matches the scenery.
    let eMin = Infinity;
    let eMax = -Infinity;
    for (const p of this._pts) {
      if (p.y < eMin) eMin = p.y;
      if (p.y > eMax) eMax = p.y;
    }
    this.elevMin = eMin;
    this.elevMax = eMax;
    setHeightSampler((x, z) => this.groundInfo(x, z).y);
    setBiomeLayout(config && config.biomes, {
      altitude: !!(config && config.mode === "custom"),
      elevMin: eMin,
      elevMax: eMax,
    });

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
  // in other low spots. Odd organic shapes with a cheap flat wet-sheen shader (no
  // extra render pass). Each blob sits flush on its own local ground height.
  // Centres go in this.puddles so the main loop can splash when driven through.
  _buildPuddles() {
    this.puddles = [];
    const forest = [];
    for (let i = 0; i < this.samples; i++) {
      const p = this._pts[i];
      if (biomeRoadStyle(p.x, p.z).kind === "damp") forest.push({ i, p });
    }
    if (!forest.length) return;
    forest.sort((a, b) => a.p.y - b.p.y); // lowest first

    // A hero puddle in the lowest dip plus a few smaller ones in other low forest
    // spots. With a flat decal (no reflection plane) they can spread out: each
    // blob is lifted to its own ground height so it sits flush on the road.
    const placements = [{ cx: forest[0].p.x, cz: forest[0].p.z, gy: forest[0].p.y, baseR: 6, stretch: 1.25 }];
    for (let k = 1; k < forest.length && placements.length < 6; k++) {
      const s = forest[k];
      if (placements.some((q) => (q.cx - s.p.x) ** 2 + (q.cz - s.p.z) ** 2 < 18 * 18)) continue;
      placements.push({ cx: s.p.x, cz: s.p.z, gy: s.p.y, baseR: 2 + Math.random() * 2, stretch: 1 });
    }

    // Merge every blob into one wet-sheen decal mesh.
    const geoms = placements.map((pl) => {
      this.puddles.push({ x: pl.cx, z: pl.cz, r: pl.baseR * pl.stretch });
      const g = puddleBlob(pl.cx, pl.cz, pl.baseR, pl.stretch);
      g.translate(0, pl.gy + 0.04, 0); // sit flush on this puddle's ground
      return g;
    });
    const mesh = new THREE.Mesh(
      mergeGeometries(geoms),
      new THREE.ShaderMaterial({
        ...PUDDLE_SHEEN_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.puddleMesh = mesh;
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
      // WebGPU "fence flicker": dropping received shadows (1st guess) didn't fix
      // it, so take the barriers out of the shadow system entirely — also stop them
      // CASTING, in case the shimmer is their own cast shadow swimming as the tight
      // shadow frustum snaps each frame. Barriers are bright kerbs, so losing their
      // shadow is visually negligible. (If it STILL flickers it's geometry/depth
      // z-fighting on the thin double-sided wall, which is a different fix.)
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
    }
  }

  _buildCenterLine() {
    // The centre line only appears in the built-up town stretches and the alpine
    // (snowy) pass. A per-sample 0/1 visibility field is box-blurred so the line
    // fades in and out over distance instead of stopping abruptly.
    const div = this.samples;
    const ZONES = 6; // matches the town/farm zoning in scenery.buildRoadside
    let vis = new Float32Array(div);
    for (let i = 0; i < div; i++) {
      const kind = biomeRoadStyle(this._pts[i].x, this._pts[i].z).kind;
      const town = Math.floor((i / div) * ZONES) % 2 === 0;
      // Towns get a centre line, but never the forest ("damp") or the snowy
      // alpine pass ("snow").
      vis[i] = town && kind !== "damp" && kind !== "snow" ? 1 : 0;
    }
    const W = 7; // blur half-window; two passes give a gentle ~tens-of-units fade
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(div);
      for (let i = 0; i < div; i++) {
        let s = 0;
        for (let k = -W; k <= W; k++) s += vis[(((i + k) % div) + div) % div];
        out[i] = s / (2 * W + 1);
      }
      vis = out;
    }

    const hw = 0.24; // half-width of the line
    const positions = [];
    const alphas = [];
    const indices = [];
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      const a = new THREE.Vector3().copy(p).addScaledVector(side, -hw);
      const b = new THREE.Vector3().copy(p).addScaledVector(side, hw);
      positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
      alphas.push(vis[idx], vis[idx]);
      if (i < div) {
        const k = i * 2;
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alphas, 1));
    geo.setIndex(indices);
    // TSL node material (WebGPU): yellow centre line whose opacity is the
    // per-vertex aAlpha fade baked above.
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.colorNode = tslColor(0xf4cf3a);
    mat.opacityNode = attribute("aAlpha");
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
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
