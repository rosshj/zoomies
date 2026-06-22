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
    this._boostQueued = false;
    this.shielding = false; // held, not queued
    this.jumpHeld = false; // held — sustains a drift

    this._neutralRoll = null;
    this._neutralSamples = 0;
    this._sign = -1; // steering sign, fixed at calibrate (see calibrate())
    this._haveMotion = false;
    this._keys = {};
    this._keyboardSteering = false;

    // Maps viewport (clientX, clientY) into the rotated stage's local space.
    // Set by main once the stage layout is known; identity by default.
    this._stageMapper = (x, y) => ({ x, y });

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

  setStageMapper(fn) {
    this._stageMapper = fn;
  }

  // Recalibrate the neutral (centre) steering position to the current tilt, and
  // lock the steering sign to the current orientation. The sign is fixed here
  // (not re-evaluated per motion event) so that if the OS flips orientation
  // mid-steer, steering stays continuous instead of suddenly inverting.
  calibrate() {
    this._neutralRoll = null; // next motion events re-capture neutral
    this._neutralSamples = 0;
    const angle =
      (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 90;
    this._sign = angle === 270 || angle === -90 ? 1 : -1;
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null) return;
    this._haveMotion = true;

    // Roll of the phone within the screen plane. atan2(y, x) tracks the
    // "steering-wheel" tilt regardless of how far the phone is pitched
    // back, which makes it robust to how the player holds the device.
    const roll = Math.atan2(g.y, g.x); // radians

    const shortArc = (a) => {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };

    if (this._neutralRoll === null) {
      this._neutralRoll = roll;
      this._neutralSamples = 1;
      return;
    }
    // Stabilise neutral by averaging the first several samples after calibrate.
    if (this._neutralSamples < 8) {
      this._neutralRoll += shortArc(roll - this._neutralRoll) / (this._neutralSamples + 1);
      this._neutralSamples++;
    }

    const d = shortArc(roll - this._neutralRoll) * this._sign;

    // Very gentle auto-recenter: only near neutral (so it never fights a real
    // turn) and very slowly, to soak up a small calibration bias that would
    // otherwise make the kart curve on its own when you think you're level.
    if (this._neutralSamples >= 8 && Math.abs(d) < 0.15) {
      this._neutralRoll += this._sign * d * 0.005;
    }

    const MAX = 0.5; // ~29° of tilt for full lock
    const DEAD = 0.045;
    let s = d;
    if (Math.abs(s) < DEAD) s = 0;
    else s -= Math.sign(s) * DEAD;

    // Mild expo: still gentle near centre, but responsive overall.
    const norm = Math.max(-1, Math.min(1, s / MAX));
    this._steerTarget = Math.sign(norm) * Math.pow(Math.abs(norm), 1.5);
    this._keyboardSteering = false;
  }

  _bindSlider() {
    const zone = document.getElementById("throttle"); // wide, forgiving target
    const track = document.getElementById("throttle-track"); // geometry ref
    const thumb = document.getElementById("throttle-thumb");
    if (!track || !zone) return;

    let active = false;
    let raf = null;

    const setFromPointer = (clientX, clientY) => {
      // Map both the track centre and the pointer into stage-local space so
      // the slider works correctly even when the stage is rotated.
      const rect = track.getBoundingClientRect();
      const c = this._stageMapper(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const p = this._stageMapper(clientX, clientY);
      const half = track.clientHeight / 2 - 28;
      let v = (c.y - p.y) / half;
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

    const start = (x, y) => {
      active = true;
      if (raf) cancelAnimationFrame(raf), (raf = null);
      setFromPointer(x, y);
    };
    const move = (x, y) => active && setFromPointer(x, y);
    const end = () => {
      if (!active) return;
      active = false;
      if (!raf) raf = requestAnimationFrame(springBack);
    };

    zone.addEventListener("pointerdown", (e) => {
      zone.setPointerCapture(e.pointerId);
      start(e.clientX, e.clientY);
    });
    zone.addEventListener("pointermove", (e) => move(e.clientX, e.clientY));
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  _bindTapZones() {
    const jump = document.getElementById("btn-jump");
    const shoot = document.getElementById("btn-shoot");
    const boost = document.getElementById("btn-boost");

    const flash = (el) => {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 120);
    };

    if (jump) {
      jump.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._jumpQueued = true;
        this.jumpHeld = true;
        jump.setPointerCapture(e.pointerId);
        flash(jump);
      });
      const release = () => (this.jumpHeld = false);
      jump.addEventListener("pointerup", release);
      jump.addEventListener("pointercancel", release);
    }
    if (shoot)
      shoot.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._shootQueued = true;
        flash(shoot);
      });
    if (boost)
      boost.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (boost.classList.contains("disabled")) return;
        this._boostQueued = true;
        flash(boost);
      });

    // Shield: held (press and hold to stay protected).
    const shield = document.getElementById("btn-shield");
    if (shield) {
      const on = (e) => {
        e.preventDefault();
        this.shielding = true;
        shield.classList.add("active");
        shield.setPointerCapture(e.pointerId);
      };
      const off = () => {
        this.shielding = false;
        shield.classList.remove("active");
      };
      shield.addEventListener("pointerdown", on);
      shield.addEventListener("pointerup", off);
      shield.addEventListener("pointercancel", off);
    }
  }

  _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this._keys[e.code] = true;
      if (e.code === "Space") {
        this._jumpQueued = true;
        this.jumpHeld = true;
      }
      if (e.code === "KeyF") this._shootQueued = true;
      if (e.code === "KeyB") this._boostQueued = true;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shielding = true;
    });
    window.addEventListener("keyup", (e) => {
      this._keys[e.code] = false;
      if (e.code === "Space") this.jumpHeld = false;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shielding = false;
    });
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

    // Smooth steering toward target (snappy, so it doesn't feel laggy/stiff).
    const rate = Math.min(1, dt * 16);
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

  consumeBoost() {
    const b = this._boostQueued;
    this._boostQueued = false;
    return b;
  }
}
