import * as THREE from "three";

// Sets up renderer, scene, lights, sky and a chase camera.
export function createScene() {
  const container = document.getElementById("game");

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic tone mapping for richer, punchier (but still cartoony) color.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe3ff);
  scene.fog = new THREE.Fog(0xcfe7f2, 340, 1200);

  // Camera (chase cam; positioned each frame by the game loop)
  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    3000
  );
  camera.position.set(0, 12, -18);

  // Direction the sunlight comes from (also where the visible sun sits).
  const sunDir = new THREE.Vector3(0.55, 0.42, 0.72).normalize();

  buildSky(scene, sunDir);
  buildSun(scene, sunDir);

  // Lights
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 1.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1cf, 2.0);
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

  // The terrain/ground is built by scenery.buildWorld().

  // A few clouds for depth
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  for (let i = 0; i < 14; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(6 + Math.random() * 6, 8, 8), cloudMat);
      puff.position.set((Math.random() - 0.5) * 18, Math.random() * 4, (Math.random() - 0.5) * 10);
      cloud.add(puff);
    }
    const a = Math.random() * Math.PI * 2;
    const r = 200 + Math.random() * 180;
    cloud.position.set(Math.cos(a) * r, 60 + Math.random() * 50, Math.sin(a) * r);
    scene.add(cloud);
  }

  // Sizing is driven by main.js (layoutStage) so it matches the rotated stage.

  return { renderer, scene, camera, sun };
}

// Gradient sky dome with a warm glow around the sun direction.
function buildSky(scene, sunDir) {
  const R = 2200;
  const geo = new THREE.SphereGeometry(R, 32, 20);
  const top = new THREE.Color(0x2f72d6);
  const horizon = new THREE.Color(0xdff0f7);
  const warm = new THREE.Color(0xffe6ad);
  const colors = [];
  const v = new THREE.Vector3();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const u = Math.max(0, v.y);
    const c = horizon.clone().lerp(top, Math.pow(u, 0.65));
    const d = v.dot(sunDir);
    if (d > 0.5) c.lerp(warm, smoothstep(0.5, 0.98, d) * 0.8);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.renderOrder = -1;
  scene.add(sky);
}

// Visible sun: a bright core plus additive glow sprites (beautiful when you
// drive toward it).
function buildSun(scene, sunDir) {
  const pos = sunDir.clone().multiplyScalar(1900);
  const coreMat = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false });
  coreMat.color.setRGB(2.2, 2.0, 1.5); // over-bright so it blooms
  const core = new THREE.Mesh(new THREE.SphereGeometry(42, 24, 24), coreMat);
  core.position.copy(pos);
  scene.add(core);

  const glowTex = radialGlowTexture();
  const addGlow = (size, opacity) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xfff0c8,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true, // so hills/buildings occlude it — it rises into view
        fog: false,
      })
    );
    s.position.copy(pos);
    s.scale.setScalar(size);
    s.renderOrder = 2;
    scene.add(s);
  };
  addGlow(1500, 0.55);
  addGlow(700, 0.7);
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
