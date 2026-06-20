// Centralised player input: accelerometer steering (via DeviceMotion gravity),
// the left throttle slider, right-side tap zones (jump / shoot) and a desktop
// keyboard fallback.
export class Input {
  constructor() {
    this.steer = 0; // -1 (left) .. 1 (right)   (smoothed)
    this.throttle = 0; // -1 (down/brake/reverse) .. 1 (up/accelerate)

    this._steerTarget = 0;
    this._jumpQueued = false;
    this._shootQueued = false;

    this._neutralRoll = null;
    this._haveMotion = false;
    this._keys = {};
    this._keyboardSteering = false;

    this._bindSlider();
    this._bindTapZones();
    this._bindKeyboard();
  }

  // Ask for motion permission (iOS 13+) and start listening to DeviceMotion.
  async enableMotion() {
    const DME = window.DeviceMotionEvent;
    const DOE = window.DeviceOrientationEvent;
    try {
      if (DME && typeof DME.requestPermission === "function") {
        const res = await DME.requestPermission();
        if (res !== "granted") return false;
      }
      if (DOE && typeof DOE.requestPermission === "function") {
        await DOE.requestPermission().catch(() => {});
      }
    } catch (e) {
      return false;
    }
    window.addEventListener("devicemotion", (e) => this._onMotion(e), true);
    return true;
  }

  // Recalibrate the neutral (centre) steering position to the current tilt.
  calibrate() {
    this._neutralRoll = null; // next motion event re-captures neutral
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null) return;
    this._haveMotion = true;

    // Roll of the phone within the screen plane. atan2(y, x) tracks the
    // "steering-wheel" tilt regardless of how far the phone is pitched
    // back, which makes it robust to how the player holds the device.
    let roll = Math.atan2(g.y, g.x); // radians

    if (this._neutralRoll === null) {
      this._neutralRoll = roll;
      return;
    }

    let d = roll - this._neutralRoll;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    // Sign so that tilting the phone right turns right (depends on which way
    // the device was rotated into landscape).
    const angle =
      (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 90;
    if (angle === 270 || angle === -90) d = -d;

    const MAX = 0.5; // ~28° of tilt for full lock
    const DEAD = 0.04;
    if (Math.abs(d) < DEAD) d = 0;
    else d -= Math.sign(d) * DEAD;

    this._steerTarget = Math.max(-1, Math.min(1, d / MAX));
    this._keyboardSteering = false;
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

  // Called once per frame: folds keyboard state in and smooths steering.
  update(dt = 0.016) {
    const k = this._keys;

    if (k.ArrowLeft || k.KeyA) {
      this._steerTarget = -1;
      this._keyboardSteering = true;
    } else if (k.ArrowRight || k.KeyD) {
      this._steerTarget = 1;
      this._keyboardSteering = true;
    } else if (this._keyboardSteering) {
      this._steerTarget = 0;
    }

    if (k.ArrowUp || k.KeyW) this.throttle = 1;
    else if (k.ArrowDown || k.KeyS) this.throttle = -1;

    // Smooth steering toward target to keep it from feeling twitchy.
    const rate = Math.min(1, dt * 10);
    this.steer += (this._steerTarget - this.steer) * rate;
  }

  get hasMotion() {
    return this._haveMotion;
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
