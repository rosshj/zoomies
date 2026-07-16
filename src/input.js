// Centralised player input: accelerometer steering (via DeviceMotion gravity),
// the left throttle slider, right-side tap zones (jump / shoot) and a desktop
// keyboard fallback.
export class Input {
  constructor() {
    this.steer = 0; // -1 (left) .. 1 (right)   (smoothed)
    this.throttle = 0; // -1 (down/brake/reverse) .. 1 (up/accelerate)

    this._steerTarget = 0;
    this._jumpQueued = false;
    this.shootHeld = false; // shoot button held (charging)
    this._shootRelease = false; // a press→release happened (fire request)
    this._boostQueued = false;
    this._milkQueued = false;
    this.shielding = false; // held, not queued
    this._shieldEngaged = false; // rising edge (drift-forfeit signal)
    this.jumpHeld = false; // held — sustains a drift

    this._g = null; // last gravity vector (for the tilt-debug readout)
    this._neutralRoll = null;
    this._neutralSamples = 0;
    this._calNeutral = 0; // baseline neutral captured at calibrate; clamp anchor
    this._sign = -1; // steering sign, fixed at calibrate (see calibrate())
    this._haveMotion = false;
    this._motionBound = false; // devicemotion listener attached (idempotent guard)
    this._keys = {};
    this._keyboardSteering = false;
    this._keyboardThrottle = false; // gas/brake key held → so release can return to neutral

    // Maps viewport (clientX, clientY) into the rotated stage's local space.
    // Set by main once the stage layout is known; identity by default.
    this._stageMapper = (x, y) => ({ x, y });

    this._bindSlider();
    this._bindTapZones();
    this._bindKeyboard();
  }

  // Ask for motion permission (iOS 13+) and start listening to DeviceMotion.
  // Idempotent: the listener is attached at most once per page load, so this can
  // be called from several gestures (host START, lobby "enable tilt", a guest's
  // first lobby touch, race start) without stacking duplicate handlers.
  async enableMotion() {
    if (this._motionBound) return true;
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
    this._motionBound = true;
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
    this._calNeutral = 0; // re-anchored once the new neutral settles
    const angle =
      (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 90;
    this._sign = angle === 270 || angle === -90 ? 1 : -1;
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null) return;
    this._haveMotion = true;
    this._g = { x: g.x, y: g.y, z: g.z ?? 0 };

    // True left/right roll of the phone, measured against the FULL down vector
    // (hypot of the two non-lateral axes), so it's the actual tilt angle in
    // radians and — crucially — independent of how far forward/back the phone is
    // pitched. The old atan2(g.y, g.x) used only the in-plane projection, whose
    // gain scaled with 1/|in-plane gravity|: tilt forward (that projection
    // shrinks) and steering got hyper-sensitive + s-curvy; tilt back and it went
    // numb. atan2(lateral, hypot(other two)) has a clean 1:1 gain at every pitch,
    // so the feel the player dialled in at ~-56° now holds whatever the tilt.
    // Lateral is negated to keep the SAME steering polarity as the old measure:
    // the old denominator (g.x) is negative in the landscape hold, which flipped
    // the sign — switching to the always-positive hypot would otherwise invert it.
    const roll = Math.atan2(-g.y, Math.hypot(g.x, g.z ?? 0)); // radians, pitch-independent

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
    // Stabilise neutral by averaging the first several samples after calibrate,
    // then lock that value in as the baseline the auto-centre can't stray far from.
    if (this._neutralSamples < 8) {
      this._neutralRoll += shortArc(roll - this._neutralRoll) / (this._neutralSamples + 1);
      this._neutralSamples++;
      if (this._neutralSamples === 8) this._calNeutral = this._neutralRoll;
    }

    const d = shortArc(roll - this._neutralRoll) * this._sign;

    // Gentle auto-centre to soak up a small resting bias — but CLAMPED so it can
    // never accumulate into a real lean. On a turn-heavy track holding a steady
    // tilt would otherwise drag "neutral" along with it; the clamp caps that, and
    // straights (where you hold level) pull it back toward the calibrated value.
    if (this._neutralSamples >= 8 && Math.abs(d) < 0.064) {
      this._neutralRoll += this._sign * d * 0.004;
      const drift = shortArc(this._neutralRoll - this._calNeutral);
      const CLAMP = 0.037; // ~2°, well inside a deliberate turn
      if (Math.abs(drift) > CLAMP) {
        this._neutralRoll = this._calNeutral + Math.sign(drift) * CLAMP;
      }
    }

    // Tuned to the feel the player locked in at pitch ~-56°: full lock at ~15° of
    // real roll. Because `roll` is now pitch-independent, this gain holds at any
    // forward/back tilt (the old constants were ~1.9x larger, in projection units).
    const MAX = 0.27; // ~15° of roll for full lock
    const DEAD = 0.024;
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

  // ONE ACTION AT A TIME: the right thumb can only physically press one button,
  // so the inputs enforce it — engaging any action releases every other held
  // one. That single rule IS the risk/reward system: let go of the shield to
  // shoot or hop, give up the drift (jump-hold) to defend. A shoot-charge
  // interrupted by another press cancels WITHOUT firing (the thumb slid off).
  _releaseOthers(except) {
    if (except !== "jump" && this.jumpHeld) this.jumpHeld = false;
    if (except !== "shoot" && this.shootHeld) {
      this.shootHeld = false; // cancelled, not fired
      this._shootBtn?.classList.remove("charging");
    }
    if (except !== "shield" && this.shielding) {
      this.shielding = false;
      this._shieldBtn?.classList.remove("active");
    }
  }

  _bindTapZones() {
    const jump = document.getElementById("btn-jump");
    const shoot = document.getElementById("btn-shoot");
    const boost = document.getElementById("btn-boost");
    const milk = document.getElementById("btn-milk");
    this._shootBtn = shoot;
    this._shieldBtn = document.getElementById("btn-shield");

    const flash = (el) => {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 120);
    };

    if (jump) {
      jump.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._releaseOthers("jump");
        this._jumpQueued = true;
        this.jumpHeld = true;
        jump.setPointerCapture(e.pointerId);
        flash(jump);
      });
      const release = () => (this.jumpHeld = false);
      jump.addEventListener("pointerup", release);
      jump.addEventListener("pointercancel", release);
    }
    if (shoot) {
      // Hold to charge (shoots faster/further); fires on release. A quick tap is
      // just a tiny hold, so it fires a normal shot.
      const press = (e) => {
        e.preventDefault();
        this._releaseOthers("shoot");
        this.shootHeld = true;
        shoot.setPointerCapture?.(e.pointerId);
        shoot.classList.add("charging");
      };
      const release = () => {
        if (!this.shootHeld) return;
        this.shootHeld = false;
        this._shootRelease = true;
        shoot.classList.remove("charging");
      };
      shoot.addEventListener("pointerdown", press);
      shoot.addEventListener("pointerup", release);
      shoot.addEventListener("pointercancel", release);
    }
    if (boost)
      boost.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (boost.classList.contains("disabled")) return;
        this._releaseOthers(null); // a tap still moves the thumb
        this._boostQueued = true;
        flash(boost);
      });
    if (milk)
      milk.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._releaseOthers(null);
        this._milkQueued = true;
        flash(milk);
      });

    // Shield: held (press and hold to stay protected).
    const shield = this._shieldBtn;
    if (shield) {
      const on = (e) => {
        e.preventDefault();
        this._releaseOthers("shield");
        this.shielding = true;
        this._shieldEngaged = true;
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
        this._releaseOthers("jump");
        this._jumpQueued = true;
        this.jumpHeld = true;
      }
      if (e.code === "KeyF") {
        this._releaseOthers("shoot");
        this.shootHeld = true; // hold to charge
      }
      if (e.code === "KeyB") {
        this._releaseOthers(null);
        this._boostQueued = true;
      }
      if (e.code === "KeyM") {
        this._releaseOthers(null);
        this._milkQueued = true;
      }
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        this._releaseOthers("shield");
        this.shielding = true;
        this._shieldEngaged = true;
      }
    });
    window.addEventListener("keyup", (e) => {
      this._keys[e.code] = false;
      if (e.code === "Space") this.jumpHeld = false;
      if (e.code === "KeyF" && this.shootHeld) {
        this.shootHeld = false;
        this._shootRelease = true;
      }
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shielding = false;
    });
  }

  // Called once per frame: folds keyboard state in and smooths steering.
  update(dt = 0.016) {
    const k = this._keys;

    if (k.ArrowLeft || k.KeyA) {
      this._steerTarget = 1;
      this._keyboardSteering = true;
    } else if (k.ArrowRight || k.KeyD) {
      this._steerTarget = -1;
      this._keyboardSteering = true;
    } else if (this._keyboardSteering) {
      this._steerTarget = 0;
    }

    // Gas/brake: hold sets full throttle; RELEASE must return to neutral (foot off
    // the pedal) so the kart coasts + engine-brakes to a stop. Without the release
    // branch, throttle latched at ±1 forever after the first tap (the desktop
    // "keeps going after you let go" bug). Guarded by a flag so it only zeroes the
    // frame the key comes up — never fighting the touch slider's own throttle.
    if (k.ArrowUp || k.KeyW) { this.throttle = 1; this._keyboardThrottle = true; }
    else if (k.ArrowDown || k.KeyS) { this.throttle = -1; this._keyboardThrottle = true; }
    else if (this._keyboardThrottle) { this.throttle = 0; this._keyboardThrottle = false; }

    // Smooth steering toward target (snappy, so it doesn't feel laggy/stiff).
    const rate = Math.min(1, dt * 16);
    this.steer += (this._steerTarget - this.steer) * rate;
  }

  get hasMotion() {
    return this._haveMotion;
  }

  // Live tilt diagnostics for the on-screen debug readout. `pitch` is how far the
  // phone is tilted forward/back from upright (deg). `mag` is the in-plane gravity
  // (hypot(gx,gy)) — the smaller it gets (phone tilted flat), the more sensitive
  // atan2 steering becomes, which is the s-curving the player feels. `roll` is the
  // raw steering-wheel angle (deg) and `steer` the smoothed output. This is the
  // data we need to pick a tilt to normalise against and lock the feel in.
  debugTilt() {
    const g = this._g;
    if (!g) return null;
    const RAD = 180 / Math.PI;
    const mag = Math.hypot(g.x, g.y);
    return {
      pitch: Math.atan2(g.z, mag) * RAD, // 0 = upright, ~90 = flat
      roll: Math.atan2(g.y, g.x) * RAD,
      mag,
      steer: this.steer,
    };
  }

  consumeJump() {
    const j = this._jumpQueued;
    this._jumpQueued = false;
    return j;
  }

  // True once when the shoot button is released (request to fire).
  consumeShootRelease() {
    const s = this._shootRelease;
    this._shootRelease = false;
    return s;
  }

  consumeBoost() {
    const b = this._boostQueued;
    this._boostQueued = false;
    return b;
  }

  consumeMilk() {
    const m = this._milkQueued;
    this._milkQueued = false;
    return m;
  }

  // True once when the shield was just engaged (rising edge). Raising the
  // shield mid-drift forfeits the drift's charge — the caller needs the edge.
  consumeShieldEngage() {
    const s = this._shieldEngaged;
    this._shieldEngaged = false;
    return s;
  }
}
