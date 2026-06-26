import * as THREE from "three";

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
    sunCore: [2.3, 2.05, 1.5], sunSize: 48, sunVisible: true, rays: true, rayWeight: 1.05, starI: 0,
    cloud: 0xffffff, sat: 1.3, contrast: 1.02,
  },
  {
    // Sunset: a low, warm sun; golden glow, deep blue overhead, long shadows.
    name: "Sunset", tod: "sunset", weather: "none",
    sunDir: [0.62, 0.15, 0.42], sunColor: 0xffb066, sunI: 2.2,
    skyTop: 0x273a6e, skyHorizon: 0xffb277, skyWarm: 0xffd49a,
    hemiSky: 0xffc79a, hemiGround: 0x4a3a30, hemiI: 0.72,
    bg: 0xf2c79a, fog: 0xf3c193, fogNear: 480, fogFar: 1700, exposure: 1.07,
    sunCore: [2.6, 1.7, 0.9], sunSize: 86, sunVisible: true, rays: true, rayWeight: 1.7, starI: 0.15,
    cloud: 0xffd6ad, sat: 1.36, contrast: 1.03,
  },
  {
    // Night: a cool moon, dark blue sky and stars. Moonlight is kept LOW so the
    // ground stays dark and reads as actually-night — the warm street lamps, string
    // lights and kart headlights (in scenery) are what light the road, not the moon.
    name: "Night", tod: "night", weather: "none",
    sunDir: [-0.34, 0.64, 0.42], sunColor: 0xaab8e6, sunI: 0.5,
    skyTop: 0x060a1a, skyHorizon: 0x17263f, skyWarm: 0x17263f,
    hemiSky: 0x33456a, hemiGround: 0x10151f, hemiI: 0.2,
    bg: 0x0a1226, fog: 0x0c1830, fogNear: 420, fogFar: 1500, exposure: 0.98,
    sunCore: [1.25, 1.35, 1.65], sunSize: 34, sunVisible: true, rays: false, starI: 1,
    cloud: 0x2a3551, sat: 1.08, contrast: 1.06,
  },
];

// The mood for a Time of Day key ("midday" | "sunset" | "night"); defaults Midday.
export function moodForTimeOfDay(tod) {
  return MOODS.find((m) => m.tod === tod) || MOODS[0];
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
  const sunVis = buildSun(scene); // returns { core, coreMat, glows: [...] } (sun by day, moon by night)
  const stars = buildStars(scene); // a star field, faded in at night via applyMood

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe6b8, 2.2);
  sun.position.copy(sunDir).multiplyScalar(320);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // A tight frustum that the game keeps centred on the player (see main loop):
  // same map budget focused around you = crisp, dramatic shadows where they show.
  // Kept fairly small so the 2048 map gives plenty of texels per unit near the
  // kart (crisp edges); distant scenery shadows fall outside it but read tiny.
  const s = 85;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 720;
  // Small biases: a low normalBias keeps contact shadows attached (a high one
  // peter-pans them so objects look like they float); the tighter, higher-res
  // frustum keeps acne away without leaning on it.
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.18;
  sun.shadow.radius = 5; // soft PCF penumbra for the gentle, toy-like look
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
    // Sit them out beyond the playable hills and high up, so they read as
    // distant sky and never clip the track (the alpine hill rises high).
    const a = Math.random() * Math.PI * 2;
    const r = 520 + Math.random() * 440;
    cloud.position.set(Math.cos(a) * r, 150 + Math.random() * 90, Math.sin(a) * r);
    cloud.scale.setScalar(1.6 + Math.random() * 1.2); // bigger since they're farther
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

// A dome of stars just inside the sky sphere. Built once, kept invisible by day
// and faded in at night via the material opacity (set in applyMood). Drawn after
// the sky (renderOrder 0 vs the sky's -1) with no fog so they stay crisp.
function buildStars(scene) {
  const N = 900;
  const R = 2080;
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
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `
      attribute float aSize; varying float vTw;
      void main(){
        vTw = 0.6 + 0.4 * sin(aSize * 12.9);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity; varying float vTw;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vec3(0.9, 0.93, 1.0), a * uOpacity * vTw);
      }`,
  });
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
