// Local split screen (desktop): a self-contained chase camera per player.
//
// main.js's updateCamera() is deliberately NOT reused for the two views — it
// owns a pile of module-level smoothing state (camPos/_camPitch/_spSmooth…)
// and drives global post uniforms (vignette, aberration, speed FOV on the
// shared camera), none of which can serve two viewports at once. Each split
// view instead runs this lean chase cam with its OWN state: the same core
// framing rules (speed-trimmed distance/height, slope-aware lowering, tunnel
// rail, ground + rock clamps, look-ahead) minus the solo-only garnish.
import * as THREE from "three";
import { featureCameraClamp, tunnelCamGuide } from "./features.js";

export class ChaseCam {
  // fov/near/far mirror the shared race camera (scene.js).
  constructor(fov = 62, near = 0.3, far = 2050) {
    this.camera = new THREE.PerspectiveCamera(fov, 2, near, far);
    this._baseFov = fov;
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._spSmooth = 0;
    this._snap = true; // first update after a (re)start teleports, no lerp-in
  }

  // Next update() teleports straight to the desired pose (race start / restart).
  snap() {
    this._snap = true;
  }

  update(kart, track, dt) {
    const snap = this._snap;
    this._snap = false;
    const sp = Math.abs(kart.speed);
    const sn = Math.min(1, sp / kart.maxSpeed);
    this._spSmooth += (sp - this._spSmooth) * Math.min(1, dt * 2.5);
    if (snap) this._spSmooth = sp;

    this._fwd.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    // Same speed framing as the solo cam: lower + longer at speed, with the
    // lowering faded out on real grades so it never fights the ground clamp.
    const slopeK = Math.min(1, Math.abs(kart.slopePitch || 0) / 0.16);
    this._desired.copy(kart.position).addScaledVector(this._fwd, -(13 + sn * 0.7));
    this._desired.y += 7 - sn * 1.3 * (1 - slopeK) + kart.y * 0.5;

    // Tunnel rail: pre-fit the desired eye inside a bore so the hard clamps
    // below never lurch it at a portal (see main.js updateCamera).
    const tg = tunnelCamGuide(track.features, track, this._desired.x, this._desired.z, this._desired.y);
    if (tg) {
      this._desired.x += (tg.x - this._desired.x) * tg.k;
      this._desired.y += (tg.y - this._desired.y) * tg.k;
      this._desired.z += (tg.z - this._desired.z) * tg.k;
    }
    this._look.copy(kart.position).addScaledVector(this._fwd, 6);
    this._look.y += 1.5 + kart.y;

    const lerp = snap ? 1 : 1 - Math.pow(0.001, dt);
    this._pos.lerp(this._desired, lerp);
    this._target.lerp(this._look, lerp);

    // Keep the eye above the road beneath it (strand-aware: bias the height
    // query by the kart's own y so stacked decks pick the right road)…
    const groundY = track.groundYNear(this._pos.x, this._pos.z, kart.position.y);
    if (this._pos.y < groundY + 3) this._pos.y = groundY + 3;
    // …and out of tunnel rock.
    featureCameraClamp(track.features, track, this._pos);

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._target);

    // Speed FOV per view — safe here because each player owns a camera.
    const fovT = this._baseFov + sn * 6 + (kart.boosting ? 5 : 0) + (kart.catnipBoosting ? 4 : 0);
    if (Math.abs(this.camera.fov - fovT) > 0.05) {
      this.camera.fov += (fovT - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }
  }
}
