import * as THREE from "three";

// Sets up renderer, scene, lights, sky and a chase camera.
export function createScene() {
  const container = document.getElementById("game");

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fd4ee);
  scene.fog = new THREE.Fog(0x9fd4ee, 320, 1150);

  // Camera (chase cam; positioned each frame by the game loop)
  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    2400
  );
  camera.position.set(0, 12, -18);

  // Lights
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a5f3a, 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff3d6, 1.5);
  sun.position.set(60, 120, 40);
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
