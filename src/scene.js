import * as THREE from "three";

// Time-of-day / weather moods. One is chosen per race; applyMood() restyles the
// sky, sun, lights, fog and exposure to match, then rebakes the environment map.
export const MOODS = [
  {
    name: "Midday", weight: 5, weather: "none",
    sunDir: [0.4, 0.82, 0.55], sunColor: 0xfff4e0, sunI: 2.2,
    skyTop: 0x2f72d6, skyHorizon: 0xdff0f7, skyWarm: 0xffe6ad,
    hemiSky: 0xbfe3ff, hemiGround: 0x4a6f46, hemiI: 0.72,
    bg: 0xbfe3ff, fog: 0xcfe7f2, fogNear: 520, fogFar: 1750, exposure: 1.05,
    sunCore: [2.2, 2.0, 1.5], sunSize: 42, sunVisible: true,
    cloud: 0xffffff, sat: 1.3, contrast: 1.07,
  },
  {
    name: "Golden Hour", weight: 4, weather: "none",
    sunDir: [0.62, 0.4, 0.7], sunColor: 0xffd09a, sunI: 2.4,
    skyTop: 0x3b6fb0, skyHorizon: 0xffd9a8, skyWarm: 0xffbf80,
    hemiSky: 0xffe0c0, hemiGround: 0x5a5036, hemiI: 0.66,
    bg: 0xffd9a8, fog: 0xffd9b0, fogNear: 460, fogFar: 1550, exposure: 1.06,
    sunCore: [2.6, 1.8, 1.05], sunSize: 60, sunVisible: true,
    cloud: 0xffe6cc, sat: 1.35, contrast: 1.08,
  },
  {
    name: "Dusk", weight: 1, weather: "none",
    sunDir: [0.72, 0.26, 0.6], sunColor: 0xffa078, sunI: 2.0,
    skyTop: 0x3c4a86, skyHorizon: 0xffa676, skyWarm: 0xff8a60,
    hemiSky: 0xb495b6, hemiGround: 0x40384c, hemiI: 0.78,
    bg: 0x8474a0, fog: 0xc49aa0, fogNear: 420, fogFar: 1400, exposure: 1.08,
    sunCore: [2.8, 1.2, 0.7], sunSize: 74, sunVisible: true,
    cloud: 0xd2b0c8, sat: 1.3, contrast: 1.07,
  },
  {
    name: "Overcast", weight: 1, weather: "none",
    sunDir: [0.3, 0.7, 0.5], sunColor: 0xdfe4ea, sunI: 1.25,
    skyTop: 0xa6b2be, skyHorizon: 0xd6dce2, skyWarm: 0xd6dce2,
    hemiSky: 0xd6dce2, hemiGround: 0x55604f, hemiI: 1.05,
    bg: 0xc2cad2, fog: 0xccd4da, fogNear: 380, fogFar: 1300, exposure: 1.03,
    sunCore: [1.2, 1.25, 1.3], sunSize: 40, sunVisible: false,
    cloud: 0xb6bcc2, sat: 1.14, contrast: 1.05,
  },
  {
    name: "Rain", weight: 2, weather: "rain",
    sunDir: [0.3, 0.66, 0.5], sunColor: 0xccd2da, sunI: 1.1,
    skyTop: 0x76828e, skyHorizon: 0xa4acb4, skyWarm: 0xa4acb4,
    hemiSky: 0xb4bcc5, hemiGround: 0x49504a, hemiI: 1.0,
    bg: 0x969ea6, fog: 0xa2aab2, fogNear: 320, fogFar: 1100, exposure: 1.0,
    sunCore: [1.1, 1.15, 1.25], sunSize: 38, sunVisible: false,
    cloud: 0x969ca4, sat: 1.08, contrast: 1.04,
  },
  // (Snow is no longer a global mood — it falls only up on the alpine hill,
  // driven by altitude in the main loop, so the rest of the course stays clear.)
];

export function pickMood() {
  const total = MOODS.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  for (const m of MOODS) {
    r -= m.weight;
    if (r <= 0) return m;
  }
  return MOODS[0];
}

// Sets up renderer, scene, lights, sky and a chase camera, and returns an
// applyMood() the game uses to switch time-of-day / weather lighting.
export function createScene() {
  const container = document.getElementById("game");

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe3ff);
  scene.fog = new THREE.Fog(0xcfe7f2, 360, 1300);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(0, 12, -18);

  const sunDir = new THREE.Vector3(0.4, 0.82, 0.55).normalize();

  const sky = buildSky(scene); // returns { mesh, geo }
  const sunVis = buildSun(scene); // returns { core, coreMat, glows: [...] }

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe6b8, 2.2);
  sun.position.copy(sunDir).multiplyScalar(320);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 300;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  // A few clouds for depth.
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  for (let i = 0; i < 16; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(6 + Math.random() * 6, 8, 8), cloudMat);
      puff.position.set((Math.random() - 0.5) * 18, Math.random() * 4, (Math.random() - 0.5) * 10);
      cloud.add(puff);
    }
    const a = Math.random() * Math.PI * 2;
    const r = 220 + Math.random() * 220;
    cloud.position.set(Math.cos(a) * r, 60 + Math.random() * 50, Math.sin(a) * r);
    scene.add(cloud);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;
  const rebakeEnv = () => {
    const next = pmrem.fromScene(scene, 0, 10, 4000);
    scene.environment = next.texture;
    if (envRT) envRT.dispose();
    envRT = next;
  };

  // Apply a mood: restyle everything and rebake the environment map.
  function applyMood(m) {
    sunDir.set(m.sunDir[0], m.sunDir[1], m.sunDir[2]).normalize();
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
    recolorSky(sky.geo, sunDir, m);
    styleSun(sunVis, sunDir, m);
    rebakeEnv();
  }

  applyMood(MOODS[0]);

  return { renderer, scene, camera, sun, applyMood };
}

// Gradient sky dome with a warm glow around the sun direction.
function buildSky(scene) {
  const R = 2200;
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
    if (m.sunVisible && d > 0.5) c.lerp(warm, smoothstep(0.5, 0.98, d) * 0.8);
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
  for (const [size, opacity] of [[1500, 0.55], [700, 0.7]]) {
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
