// Centralised player input: accelerometer steering, the left throttle slider,
// right-side tap zones (jump / shoot) and a desktop keyboard fallback.
export class Input {
  constructor() {
    this.steer = 0; // -1 (left) .. 1 (right)
    this.throttle = 0; // -1 (down/brake/reverse) .. 1 (up/accelerate)

    this._jumpQueued = false;
    this._shootQueued = false;

    this._tiltNeutral = null;
    this._tiltRaw = 0;
    this._keys = {};

    this._bindSlider();
    this._bindTapZones();
    this._bindKeyboard();
  }

  // Ask for orientation permission (iOS 13+) and start listening.
  async enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        const res = await DOE.requestPermission();
        if (res !== "granted") return false;
      } catch (e) {
        return false;
      }
    }
    window.addEventListener("deviceorientation", (e) => this._onOrientation(e), true);
    return true;
  }

  // Recalibrate "neutral" to the phone's current tilt.
  calibrate() {
    this._tiltNeutral = this._tiltRaw;
  }

  _onOrientation(e) {
    if (e.beta === null && e.gamma === null) return;

    // Holding the phone in landscape and tilting it left/right like a steering
    // wheel maps to `gamma` (rotation about the device's long axis). The sign
    // depends on which way the phone was rotated into landscape.
    const angle =
      (screen.orientation && screen.orientation.angle) ??
      window.orientation ??
      90;

    let tilt;
    if (angle === 270 || angle === -90) {
      tilt = -e.gamma;
    } else {
      tilt = e.gamma; // 90 (and a sane default)
    }
    this._tiltRaw = tilt;

    if (this._tiltNeutral === null) this._tiltNeutral = tilt;

    const MAX = 35; // degrees of tilt for full lock
    const DEAD = 3;
    let v = tilt - this._tiltNeutral;
    if (Math.abs(v) < DEAD) v = 0;
    else v = v - Math.sign(v) * DEAD;
    this.steer = Math.max(-1, Math.min(1, v / MAX));
  }

  _bindSlider() {
    const track = document.getElementById("throttle-track");
    const thumb = document.getElementById("throttle-thumb");
    if (!track) return;

    let active = false;
    let raf = null;

    const setFromY = (clientY) => {
      const rect = track.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const half = rect.height / 2 - 28;
      let v = (center - clientY) / half;
      v = Math.max(-1, Math.min(1, v));
      this.throttle = v;
      thumb.style.top = `${50 - v * 42}%`;
      // Tint thumb green up / red down.
      if (v > 0.05) thumb.style.background =
        "radial-gradient(circle at 35% 30%, #fff, #4caf50)";
      else if (v < -0.05) thumb.style.background =
        "radial-gradient(circle at 35% 30%, #fff, #f44336)";
      else thumb.style.background =
        "radial-gradient(circle at 35% 30%, #fff, #ffb300)";
    };

    const springBack = () => {
      this.throttle *= 0.8;
      if (Math.abs(this.throttle) < 0.02) {
        this.throttle = 0;
        thumb.style.top = "50%";
        thumb.style.background = "radial-gradient(circle at 35% 30%, #fff, #ffb300)";
        raf = null;
        return;
      }
      thumb.style.top = `${50 - this.throttle * 42}%`;
      raf = requestAnimationFrame(springBack);
    };

    const start = (y) => {
      active = true;
      if (raf) cancelAnimationFrame(raf), (raf = null);
      setFromY(y);
    };
    const move = (y) => active && setFromY(y);
    const end = () => {
      if (!active) return;
      active = false;
      if (!raf) raf = requestAnimationFrame(springBack);
    };

    track.addEventListener("pointerdown", (e) => {
      track.setPointerCapture(e.pointerId);
      start(e.clientY);
    });
    track.addEventListener("pointermove", (e) => move(e.clientY));
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
  }

  _bindTapZones() {
    const jump = document.getElementById("jump-zone");
    const shoot = document.getElementById("shoot-zone");

    const flash = (el) => {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 120);
    };

    if (jump)
      jump.addEventListener("pointerdown", () => {
        this._jumpQueued = true;
        flash(jump);
      });
    if (shoot)
      shoot.addEventListener("pointerdown", () => {
        this._shootQueued = true;
        flash(shoot);
      });
  }

  _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this._keys[e.code] = true;
      if (e.code === "Space") this._jumpQueued = true;
      if (e.code === "KeyF") this._shootQueued = true;
    });
    window.addEventListener("keyup", (e) => (this._keys[e.code] = false));
  }

  // Called once per frame to fold keyboard state into steer/throttle.
  update() {
    const k = this._keys;
    if (k.ArrowLeft || k.KeyA) this.steer = -1;
    else if (k.ArrowRight || k.KeyD) this.steer = 1;

    if (k.ArrowUp || k.KeyW) this.throttle = 1;
    else if (k.ArrowDown || k.KeyS) this.throttle = -1;
  }

  consumeJump() {
    const j = this._jumpQueued;
    this._jumpQueued = false;
    return j;
  }

  consumeShoot() {
    const s = this._shootQueued;
    this._shootQueued = false;
    return s;
  }
}
