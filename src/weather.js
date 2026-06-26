import * as THREE from "three";

// Rain / snow precipitation that follows the camera. A single Points cloud lives
// in a box around the player; particles fall and recycle to the top, and the
// whole cloud is recentred on the camera each frame so it's always around you.
export class Weather {
  constructor(scene) {
    this.mode = "none";
    this.target = "none"; // desired weather for the player's current biome
    this.current = "none"; // what's actually showing (crossfades toward target)
    this.intensity = 0; // 0..1 fade
    this.count = 2600;
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
      color: 0xdaeaff,
      size: 2.6, // slim streaks
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
    });
    this.snowMat = new THREE.PointsMaterial({
      map: dotTexture(),
      color: 0xffffff,
      size: 0.85, // small flakes
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
    });
    this._rainOpacity = 0.85;
    this._snowOpacity = 0.95;

    this.points = new THREE.Points(this.geo, this.rainMat);
    this.points.visible = false;
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  // Set the desired weather for where the player is now ("none" / "rain" /
  // "snow"). The class crossfades to it smoothly: fade the old out, switch, fade
  // the new in — so weather changes gently as you drive between biomes.
  setWeather(mode) {
    this.target = mode;
  }

  // Current rain intensity (0..1), so the renderer can dim/desaturate for it.
  get rainAmount() {
    return this.current === "rain" ? this.intensity : 0;
  }

  update(dt, camPos) {
    // Crossfade toward the target weather.
    if (this.current !== this.target) {
      this.intensity -= dt * 1.6;
      if (this.intensity <= 0) {
        this.intensity = 0;
        this.current = this.target;
        this.points.material = this.current === "snow" ? this.snowMat : this.rainMat;
      }
    } else {
      const goal = this.current === "none" ? 0 : 1;
      this.intensity += (goal - this.intensity) * Math.min(1, dt * 1.5);
    }

    const active = this.current !== "none" && this.intensity > 0.01;
    this.points.visible = active;
    if (!active) return;

    const rain = this.current === "rain";
    this.points.material.opacity = (rain ? this._rainOpacity : this._snowOpacity) * this.intensity;
    const fall = rain ? 95 : 13;
    const { w, h, d } = this.box;
    const t = performance.now() * 0.001;
    const p = this.pos;
    for (let i = 0; i < this.count; i++) {
      let y = p[i * 3 + 1] - fall * dt;
      let x = p[i * 3];
      let z = p[i * 3 + 2];
      if (!rain) {
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
