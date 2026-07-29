import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { attribute, uniform, color as tslColor } from "three/tsl";
import { USE_WEBGPU, IS_IOS } from "./gpu.js";

// Time-of-day moods. The chosen one (from the track's Time of Day setting) drives
// applyMood(), which restyles the sky, sun/moon, lights, fog, stars and exposure,
// then rebakes the environment map. `rays` gates the god-rays / lens-flare / warm
// foliage backlight (on for the sun, off for the moon). `starI` fades the star
// field in. Weather (rain/snow) is separate — dictated by the biome you drive
// through, handled in the main loop.
export const MOODS = [
  {
    // Midday: a bright sunny afternoon (the original look).
    name: "Midday", tod: "midday", weather: "none",
    sunDir: [0.5, 0.54, 0.62], sunColor: 0xfff1da, sunI: 2.5,
    skyTop: 0x357fd6, skyHorizon: 0xe7f1f6, skyWarm: 0xffe3ad,
    hemiSky: 0xcfe6ff, hemiGround: 0x5a7a4e, hemiI: 0.92,
    bg: 0xcde7f7, fog: 0xd8ecf2, fogNear: 560, fogFar: 1850, exposure: 1.08,
    sunCore: [2.3, 2.05, 1.5], sunSize: 40, sunVisible: true, rays: true, rayWeight: 1.05, starI: 0,
    cloud: 0xffffff, sat: 1.3, contrast: 1.02,
  },
  {
    // Sunset: a low, warm sun; golden glow, deep blue overhead, long shadows.
    name: "Sunset", tod: "sunset", weather: "none",
    sunDir: [0.62, 0.15, 0.42], sunColor: 0xffb066, sunI: 2.2,
    skyTop: 0x273a6e, skyHorizon: 0xffb277, skyWarm: 0xffd49a,
    hemiSky: 0xffc79a, hemiGround: 0x4a3a30, hemiI: 0.84,
    bg: 0xf2c79a, fog: 0xf3c193, fogNear: 480, fogFar: 1700, exposure: 1.13,
    sunCore: [2.6, 1.7, 0.9], sunSize: 52, sunVisible: true, rays: true, rayWeight: 1.4, starI: 0.15,
    cloud: 0xffd6ad, sat: 1.36, contrast: 1.03,
  },
  {
    // Night: a cool moon, dark blue sky and stars. Kept "well lit" by moonlight +
    // (in scenery) warm street lamps and kart headlights, not pitch black. Snow is
    // darkened at the albedo level (in buildTerrain) so it doesn't read self-lit.
    name: "Night", tod: "night", weather: "none",
    sunDir: [-0.34, 0.64, 0.42], sunColor: 0xaab8e6, sunI: 1.15,
    skyTop: 0x060a1a, skyHorizon: 0x17263f, skyWarm: 0x17263f,
    hemiSky: 0x33456a, hemiGround: 0x10151f, hemiI: 0.56,
    bg: 0x0a1226, fog: 0x0c1830, fogNear: 420, fogFar: 1500, exposure: 1.16,
    sunCore: [1.25, 1.35, 1.65], sunSize: 28, sunVisible: true, rays: false, starI: 1,
    cloud: 0x2a3551, sat: 1.32, contrast: 1.1,
  },
];

// The mood for a Time of Day key ("midday" | "sunset" | "night"); defaults Midday.
export function moodForTimeOfDay(tod) {
  return MOODS.find((m) => m.tod === tod) || MOODS[0];
}

// Sets up renderer, scene, lights, sky and a chase camera, and returns an
// applyMood() the game uses to switch time-of-day / weather lighting.
// One low-poly cloud cluster: a plume of crumple-jittered icosahedron lumps
// (big head tapering to a tail) with the underside clamped FLAT — the classic
// stylised paper-cloud silhouette. Flat-shaded by the cloud material, so the
// jitter reads as crisp facets. Origin: flat base on y=0, plume along X,
// roughly centred. Shared by the sky ring (createScene) and the asset viewer.
export function cloudClusterGeo(rand = Math.random) {
  const geos = [];
  const n = 4 + Math.floor(rand() * 3); // 4-6 lumps
  const baseR = 7 + rand() * 3;
  let x = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = baseR * (1 - t * 0.5) * (0.8 + rand() * 0.35); // head big, tail small
    // Detail-1 icosahedron (80 faces), WELDED first: PolyhedronGeometry ships
    // un-indexed, so jittering raw verts would tear the faces apart instead
    // of crumpling shared corners. Strip uv/normal BEFORE welding — they
    // differ across the sphere's uv seams, and mergeVertices only welds
    // vertices whose every attribute matches, so keeping them left the seams
    // split and the jitter tore visible slits along them. (No map on the
    // cloud material, and flat shading derives face normals itself.)
    const raw = new THREE.IcosahedronGeometry(r, 1);
    raw.deleteAttribute("normal");
    raw.deleteAttribute("uv");
    const g = mergeVertices(raw);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const jit = 0.85 + rand() * 0.3;
      p.setXYZ(v, p.getX(v) * jit, p.getY(v) * jit, p.getZ(v) * jit);
    }
    g.translate(x, r * 0.3 + (rand() - 0.5) * r * 0.2, (rand() - 0.5) * baseR * 0.4);
    geos.push(g);
    x += r * (1.05 + rand() * 0.35);
  }
  const geo = mergeGeometries(geos);
  // Flat underside: clamp everything that dips below the base plane.
  const p = geo.attributes.position;
  for (let v = 0; v < p.count; v++) if (p.getY(v) < 0) p.setY(v, 0);
  geo.translate(-x / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

export function createScene() {
  const container = document.getElementById("game");

  // WebGPU migration: WebGPURenderer (WebGL2 backend by default, WebGPU with
  // ?webgpu=1). It auto-falls back to WebGL2 if WebGPU is unavailable.
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: !USE_WEBGPU });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // WebGPU shadow flicker: PCFSoftShadowMap's wide soft kernel is temporally
  // unstable on WebGPU (the penumbra shimmers as the frustum follows the player).
  // PCF (non-soft) is stable; the doubled shadow-map resolution below keeps it
  // from looking too hard.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe3ff);
  scene.fog = new THREE.Fog(0xcfe7f2, 360, 1300);

  // Far plane sits just past the farthest fog (max fogFar ~1850): everything beyond
  // is 100% fog anyway, so rendering it to 3000 was pure waste. 2050 culls that
  // invisible distance with zero visual change — a free draw-call cut on open views.
  // Near plane 0.3, not 0.1: depth precision scales with 1/near, and at 0.1
  // the buffer resolved only ~15cm at 500u out — distant road layers and
  // object silhouettes flickered per-pixel as the camera moved (worst in the
  // menus, which stare across the whole map). Nothing flies closer than
  // ~0.3u to the third-person/menu cameras, so the 3× precision is free.
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 2050);
  camera.position.set(0, 12, -18);

  const sunDir = new THREE.Vector3(0.4, 0.82, 0.55).normalize();

  const sky = buildSky(scene); // returns { mesh, geo }
  const sunVis = buildSun(scene); // returns { core, coreMat, glows: [...] } (sun by day, moon by night)
  const stars = buildStars(scene); // a star field, faded in at night via applyMood

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe6b8, 2.2);
  sun.position.copy(sunDir).multiplyScalar(320);
  sun.castShadow = true;
  // The frustum is fitted ONCE around the whole world and the map rendered once
  // per world/mood (fitSunShadow in main.js) — all mapped casters are static
  // scenery, so a static map can't flicker/pop and costs ~zero frames. Since it
  // renders once, resolution is purely a MEMORY choice: 4096 (64MB) keeps edges
  // reasonably crisp over a whole track on High. iOS is capped at 2048 whatever
  // the tier — its WebGPU loses the device under memory pressure (the game's one
  // hard-crash mode; repeated jumps mid-race triggered it on a 4096 map), and
  // 16MB vs 64MB is exactly the kind of headroom that decides it. Low tier gets
  // 2048 everywhere.
  let shadowSz = IS_IOS ? 2048 : 4096;
  try { if (localStorage.getItem("zoomies-quality") === "low") shadowSz = 2048; } catch { /* keep default */ }
  sun.shadow.mapSize.set(shadowSz, shadowSz);
  // Initial bounds are placeholders — fitSunShadow overwrites them on frame one.
  const s = 85;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 720;
  // Shadow bias (WebGPU): the old negative depth bias (-0.0005) was tuned for the
  // WebGL renderer; on the WebGPU depth pipeline it reads differently and the
  // shadows flicker/acne as the tight frustum follows the player. Zero the
  // depth bias and lean on a slightly higher normalBias (offsets along the
  // surface normal, renderer-agnostic) which is the robust anti-acne knob.
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.35; // bumped again to catch any residual acne shimmer
  // The shadow map renders ON DEMAND (see the follow/refresh logic in main.js):
  // every mapped caster is static scenery — karts use projected-quad shadows —
  // so between re-centres the map is bit-frozen and shadows cannot shimmer.
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true; // first frame renders the initial map
  // PCF penumbra width. The WebGPU PCF filter is a fixed 17-tap kernel whose taps
  // spread across ±radius TEXELS — at 5, taps sat up to 2.5 texels apart, so soft
  // edges were built from sparse samples and crawled/flickered on building walls
  // and thin fence rails whenever the (texel-snapped) map re-rendered. At 2 the
  // taps are ≤1 texel apart — a fully-covered, temporally stable kernel — at the
  // cost of a slightly tighter (still soft) penumbra.
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);

  // A few clouds for depth. They ring the whole map high up and never move, so
  // some are in frame from every camera angle — as individual puff meshes that
  // was ~60-75 draw calls every frame. Bake every cluster into ONE merged mesh
  // (they all share cloudMat, which applyMood recolours) for a single draw.
  // flatShading gives the crumpled low-poly facets; the silhouette comes from
  // cloudClusterGeo (jittered icosahedron lumps over a clamped flat base).
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const puffGeos = [];
  for (let i = 0; i < 16; i++) {
    // Sit them out beyond the playable hills and high up, so they read as
    // distant sky and never clip the track (the alpine hill rises high).
    const a = Math.random() * Math.PI * 2;
    const r = 520 + Math.random() * 440;
    // High band: big maps climb past 250u mid-map now, and a cloud UNDER the
    // road reads as a rendering bug rather than sky.
    const cx = Math.cos(a) * r, cy = 310 + Math.random() * 120, cz = Math.sin(a) * r;
    const s = 1.6 + Math.random() * 1.2; // bigger since they're farther
    const geo = cloudClusterGeo();
    geo.rotateY(Math.random() * Math.PI * 2); // plumes drift every which way
    geo.scale(s, s, s);
    geo.translate(cx, cy, cz);
    puffGeos.push(geo);
  }
  const clouds = new THREE.Mesh(mergeGeometries(puffGeos), cloudMat);
  clouds.frustumCulled = false; // the ring spans the sky — it's always partly visible
  scene.add(clouds);

  // M1 WebGPU migration: skip PMREM environment baking (the env reflections add
  // a small spec sheen but PMREM-from-scene on the new backend is unproven; the
  // game reads fine without it). Reinstated as a node env in a later milestone.
  const rebakeEnv = () => {};

  // Apply a mood: restyle everything and rebake the environment map.
  function applyMood(m) {
    sunDir.set(m.sunDir[0], m.sunDir[1], m.sunDir[2]).normalize();
    sun.target.position.set(0, 0, 0); // re-anchor (the game re-centres it on the player)
    sun.target.updateMatrixWorld();
    sun.position.copy(sunDir).multiplyScalar(320);
    sun.color.set(m.sunColor);
    sun.intensity = m.sunI;
    hemi.color.set(m.hemiSky);
    hemi.groundColor.set(m.hemiGround);
    hemi.intensity = m.hemiI;
    scene.background.set(m.bg);
    scene.fog.color.set(m.fog);
    scene.fog.near = m.fogNear;
    scene.fog.far = m.fogFar;
    renderer.toneMappingExposure = m.exposure;
    cloudMat.color.set(m.cloud);
    const starI = m.starI ?? 0;
    stars.visible = starI > 0;
    stars.material.uniforms.uOpacity.value = starI;
    recolorSky(sky.geo, sunDir, m);
    styleSun(sunVis, sunDir, m);
    rebakeEnv();
  }

  applyMood(MOODS[0]);

  // WebGPURenderer initialises asynchronously (it picks/spins up the backend).
  // Expose the promise so the main loop only starts rendering once it's ready.
  const ready = renderer.init ? renderer.init() : Promise.resolve();

  return { renderer, scene, camera, sun, applyMood, ready, skyMesh: sky.mesh, starField: stars };
}

// Gradient sky dome with a warm glow around the sun direction.
function buildSky(scene) {
  // R must stay INSIDE the camera far plane (2050) AND the dome must follow the
  // camera each frame (see the loop) — otherwise the far plane clips the dome in a
  // disc around the view centre and scene.background shows through as a moving
  // "orb" on the horizon. 2000 < 2050 with margin.
  const R = 2000;
  const geo = new THREE.SphereGeometry(R, 32, 20);
  geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  mesh.renderOrder = -1;
  scene.add(mesh);
  return { mesh, geo };
}

function recolorSky(geo, sunDir, m) {
  const top = new THREE.Color(m.skyTop);
  const horizon = new THREE.Color(m.skyHorizon);
  const warm = new THREE.Color(m.skyWarm);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const u = Math.max(0, v.y);
    c.copy(horizon).lerp(top, Math.pow(u, 0.65));
    const d = v.dot(sunDir);
    // Warm glow around the sun. A power curve peaks softly AT the sun and fades out
    // smoothly — the old smoothstep saturated to a flat 80% patch within ~11°, which
    // read as a hard bright "orb" on the sky (esp. low on the horizon behind hills).
    if (m.sunVisible && d > 0) c.lerp(warm, Math.pow(d, 5) * 0.7);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// Visible sun: a bright core plus additive glow sprites.
function buildSun(scene) {
  const coreMat = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false });
  coreMat.color.setRGB(2.2, 2.0, 1.5);
  const core = new THREE.Mesh(new THREE.SphereGeometry(42, 24, 24), coreMat);
  scene.add(core);

  const glowTex = radialGlowTexture();
  const glows = [];
  // Sun halo. The old outer glow was 1500u at ~1900u distance = a ~43° wash across
  // the sky that read as a big "orb"/light smear to the horizon. Tightened to a
  // believable halo: a wide-but-soft outer + a feathered inner around the core.
  for (const [size, opacity] of [[560, 0.4], [260, 0.6]]) {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xfff0c8,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        fog: false,
      })
    );
    sp.scale.setScalar(size);
    sp.renderOrder = 2;
    sp.userData.baseOpacity = opacity;
    scene.add(sp);
    glows.push(sp);
  }
  return { core, coreMat, glows };
}

// A dome of stars just inside the sky sphere. Built once, kept invisible by day
// and faded in at night via the material opacity (set in applyMood). Drawn after
// the sky (renderOrder 0 vs the sky's -1) with no fog so they stay crisp.
function buildStars(scene) {
  const N = 900;
  const R = 1980; // inside the far plane (2050); the dome follows the camera (see loop)
  const pos = new Float32Array(N * 3);
  const siz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Upper hemisphere only (stars below the horizon are hidden by terrain/fog).
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const y = Math.abs(u) * 0.96 + 0.04;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    pos[i * 3] = Math.cos(theta) * r * R;
    pos[i * 3 + 1] = y * R;
    pos[i * 3 + 2] = Math.sin(theta) * r * R;
    siz[i] = 6 + Math.random() * 14;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aSize", new THREE.Float32BufferAttribute(siz, 1));
  // TSL node material (WebGPU): an additive star field faded in at night via the
  // uOpacity uniform (applyMood writes material.uniforms.uOpacity.value). Per-star
  // size comes from the aSize attribute; a cheap per-star twinkle modulates it.
  const uOpacity = uniform(0);
  const aSizeN = attribute("aSize");
  const tw = aSizeN.mul(12.9).sin().mul(0.4).add(0.6);
  const material = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
  });
  material.colorNode = tslColor(0xe6edff);
  material.sizeNode = aSizeN;
  material.opacityNode = uOpacity.mul(tw);
  material.uniforms = { uOpacity }; // so applyMood's uniforms.uOpacity.value write works
  const pts = new THREE.Points(geo, material);
  pts.renderOrder = 0;
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  return pts;
}

function styleSun(sunVis, sunDir, m) {
  const pos = sunDir.clone().multiplyScalar(1900);
  sunVis.core.position.copy(pos);
  sunVis.core.scale.setScalar(m.sunSize / 42);
  sunVis.core.visible = m.sunVisible;
  sunVis.coreMat.color.setRGB(m.sunCore[0], m.sunCore[1], m.sunCore[2]);
  for (const g of sunVis.glows) {
    g.position.copy(pos);
    g.visible = m.sunVisible;
    g.material.opacity = m.sunVisible ? g.userData.baseOpacity : 0;
  }
}

function radialGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,244,214,0.9)");
  g.addColorStop(0.5, "rgba(255,210,140,0.35)");
  g.addColorStop(1, "rgba(255,200,120,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
