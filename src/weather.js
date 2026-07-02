import * as THREE from "three";
import { attribute, time, uniform, hash, instanceIndex, vec3, float } from "three/tsl";

// Rain / snow precipitation that follows the camera. A single instanced cloud
// lives in a box around the player; particles fall and recycle to the top.
//
// The ENTIRE per-particle simulation (fall, wind drift, snow flutter, wrap +
// per-cycle respawn jitter) runs in the vertex shader off the TSL `time` node —
// the old version integrated 1,400 particles on the CPU and re-uploaded the
// whole position buffer every frame, which made snow scenes one of the worst
// frame-cost spots even while the weather was fading out. Now the CPU work per
// frame is: one uniform write (the camera offset) and the crossfade scalar.
export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.mode = "none";
    this.target = "none"; // desired weather for the player's current biome
    this.current = "none"; // what's actually showing (crossfades toward target)
    this.intensity = 0; // 0..1 fade
    this.count = 1400;
    this.box = { w: 150, h: 95, d: 150 };

    // The cloud's anchor: the camera position (dropped 22u so the box spans from
    // below the road to well overhead). Shared by both fields.
    this._uCam = uniform(new THREE.Vector3());

    const { w, h, d } = this.box;
    // Static per-particle spawn point in box-local space, baked once.
    const base = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      base[i * 3] = (Math.random() - 0.5) * w;
      base[i * 3 + 1] = Math.random() * h;
      base[i * 3 + 2] = (Math.random() - 0.5) * d;
    }

    // Rain and snow each render as a field of instanced, camera-facing sprites.
    // NOTE: THREE.Points + PointsMaterial does NOT render on the WebGPU node
    // pipeline — billboarded instanced quads are the proven path here.
    const mkField = (geo, tex, col, { fall, rainWind }) => {
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: true });
      mat.map = tex;
      mat.color = new THREE.Color(col);
      geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
      const b = attribute("aBase");
      // Per-particle fall-speed variance (85%-115%) so sheets don't move in lockstep.
      const speed = float(fall).mul(hash(instanceIndex).mul(0.3).add(0.85));
      const yRaw = b.y.sub(speed.mul(time));
      // How many times this particle has recycled — feeds the respawn jitter so
      // each cycle lands in a fresh column (the CPU version re-randomised x/z on
      // every wrap; without this the fall pattern repeats every h/fall seconds).
      const cycle = yRaw.div(h).floor();
      const y = yRaw.mod(h).add(h).mod(h); // wrap into [0, h) (mod of negatives)
      let x = b.x.add(hash(instanceIndex.add(cycle.mul(131))).mul(w));
      let z = b.z.add(hash(instanceIndex.add(cycle.mul(37)).add(9999)).mul(d));
      if (rainWind) {
        x = x.sub(time.mul(8)); // wind-blown rain drifts sideways as it falls
      } else {
        // Snow flutter: gentle per-flake sway on both axes.
        const ph = hash(instanceIndex.add(77)).mul(6.28);
        x = x.add(time.mul(0.8).add(ph).sin().mul(0.7));
        z = z.add(time.mul(0.6).add(ph.mul(1.3)).cos().mul(0.7));
      }
      const halfW = w / 2, halfD = d / 2;
      const wx = x.add(halfW).mod(w).add(w).mod(w).sub(halfW); // wrap into [-w/2, w/2)
      const wz = z.add(halfD).mod(d).add(d).mod(d).sub(halfD);
      mat.positionNode = vec3(wx, y, wz).add(this._uCam);
      const mesh = new THREE.InstancedMesh(geo, mat, this.count);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, mat };
    };
    this.rainField = mkField(new THREE.PlaneGeometry(0.16, 1.1), streakTexture(), 0xdaeaff, { fall: 95, rainWind: true });
    this.snowField = mkField(new THREE.PlaneGeometry(0.5, 0.5), dotTexture(), 0xffffff, { fall: 13, rainWind: false });
    this._rainOpacity = 0.85;
    this._snowOpacity = 0.95;
    // Render both fields invisibly for the first few frames so their pipelines
    // compile up front — not as a hitch the first time a rain/snow biome starts.
    this._warm = 3;
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
    // Pipeline warm-up: draw both fields at opacity 0 for the first frames.
    if (this._warm > 0) {
      this._warm--;
      this._uCam.value.set(camPos.x, camPos.y - 22, camPos.z);
      for (const f of [this.rainField, this.snowField]) {
        f.mesh.visible = this._warm > 0;
        f.mat.opacity = 0;
      }
      return;
    }
    // Crossfade toward the target weather.
    if (this.current !== this.target) {
      this.intensity -= dt * 1.6;
      if (this.intensity <= 0) {
        this.intensity = 0;
        this.current = this.target;
      }
    } else {
      const goal = this.current === "none" ? 0 : 1;
      this.intensity += (goal - this.intensity) * Math.min(1, dt * 1.5);
    }

    const rain = this.current === "rain";
    const active = this.current !== "none" && this.intensity > 0.01;
    this.rainField.mesh.visible = active && rain;
    this.snowField.mesh.visible = active && !rain;
    if (!active) return;

    const field = rain ? this.rainField : this.snowField;
    field.mat.opacity = (rain ? this._rainOpacity : this._snowOpacity) * this.intensity;
    // The only per-frame particle work left: recentre the cloud on the camera.
    this._uCam.value.set(camPos.x, camPos.y - 22, camPos.z);
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
