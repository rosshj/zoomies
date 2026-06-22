import * as THREE from "three";

// Rain / snow precipitation that follows the camera. A single Points cloud lives
// in a box around the player; particles fall and recycle to the top, and the
// whole cloud is recentred on the camera each frame so it's always around you.
export class Weather {
  constructor(scene) {
    this.mode = "none";
    this.count = 1500;
    this.box = { w: 150, h: 95, d: 150 };

    this.pos = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * this.box.w;
      this.pos[i * 3 + 1] = Math.random() * this.box.h;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.d;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));

    this.rainMat = new THREE.PointsMaterial({
      map: streakTexture(),
      color: 0xaecbe6,
      size: 3.2,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
    });
    this.snowMat = new THREE.PointsMaterial({
      map: dotTexture(),
      color: 0xffffff,
      size: 1.7,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
    });

    this.points = new THREE.Points(this.geo, this.rainMat);
    this.points.visible = false;
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  setMode(mode) {
    this.mode = mode;
    this.points.visible = mode !== "none";
    if (mode === "rain") this.points.material = this.rainMat;
    else if (mode === "snow") this.points.material = this.snowMat;
  }

  update(dt, camPos) {
    if (this.mode === "none") return;
    const rain = this.mode === "rain";
    const fall = rain ? 95 : 13;
    const { w, h, d } = this.box;
    const t = performance.now() * 0.001;
    const p = this.pos;
    for (let i = 0; i < this.count; i++) {
      let y = p[i * 3 + 1] - fall * dt;
      let x = p[i * 3];
      let z = p[i * 3 + 2];
      if (!rain) {
        // gentle drift for snow
        x += Math.sin(t * 0.8 + i) * 0.05;
        z += Math.cos(t * 0.6 + i * 1.3) * 0.05;
      } else {
        x -= 8 * dt; // wind-blown rain
      }
      if (y < 0) {
        y += h;
        x = (Math.random() - 0.5) * w;
        z = (Math.random() - 0.5) * d;
      }
      p[i * 3] = x;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = z;
    }
    this.geo.attributes.position.needsUpdate = true;
    // Keep the cloud around the camera (spanning from below to well above it).
    this.points.position.set(camPos.x, camPos.y - 22, camPos.z);
  }
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function streakTexture() {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(220,235,255,0.95)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(6, 0, 4, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}
