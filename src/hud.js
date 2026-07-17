// Thin wrapper around the HUD DOM elements.
export class HUD {
  constructor() {
    this.lap = document.getElementById("lap");
    this.place = document.getElementById("place");
    this.speed = document.getElementById("speed");
    this.timer = document.getElementById("timer");
    this.toast = document.getElementById("toast");
    this._lastToast = "";
    this.puShield = document.getElementById("pu-shield");
    this.puTri = document.getElementById("pu-tri");
    this.puCatnip = document.getElementById("pu-catnip");
    this.puYarn = document.getElementById("pu-yarn");
    this.puMilk = document.getElementById("pu-milk");
    this.puLives = document.getElementById("pu-lives");
    this.puLaser = document.getElementById("pu-laser");
    this.shootLock = document.getElementById("shoot-lock");
    this._shootLockText = this.shootLock?.querySelector(".sl-text");
  }

  // Opening grace: while `secs` > 0, show the furball-charging countdown; hide it
  // once furballs are armed.
  setShootLock(secs) {
    if (!this.shootLock) return;
    const on = secs > 0;
    this.shootLock.classList.toggle("hidden", !on);
    if (on && this._shootLockText) {
      const t = `Furballs arm in ${Math.ceil(secs)}s`;
      if (this._shootLockText.textContent !== t) this._shootLockText.textContent = t;
    }
  }

  // Reflect the player's active item-box power-ups as top-left pills. Timed ones
  // (shield / catnip) show whole seconds remaining and blink in the last 3s; the
  // tri-furball shows how many fan-shots are left.
  setPowerups(shieldT, triN, catnipT, yarnN = 0, milkN = 0, livesN = 0, laserT = 0) {
    this._pu(this.puShield, shieldT > 0, Math.ceil(shieldT) + "s", shieldT > 0 && shieldT <= 3);
    this._pu(this.puTri, triN > 0, "×" + triN, false);
    this._pu(this.puCatnip, catnipT > 0, Math.ceil(catnipT) + "s", catnipT > 0 && catnipT <= 3);
    this._pu(this.puYarn, yarnN > 0, "×" + yarnN, false);
    this._pu(this.puMilk, milkN > 0, "×" + milkN, false);
    this._pu(this.puLives, livesN > 0, "×" + livesN, false);
    this._pu(this.puLaser, laserT > 0, Math.ceil(laserT) + "s", laserT > 0 && laserT <= 2);
  }

  _pu(el, on, text, expiring) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
    if (!on) return;
    const v = el.querySelector(".pu-val");
    if (v && v.textContent !== text) v.textContent = text;
    el.classList.toggle("expiring", !!expiring);
  }

  // Change-gated on the coarse values (not the built strings), so an unchanged
  // frame — lap/place change a handful of times per race, speed sits steady on
  // straights, the timer ticks in tenths — costs zero string building and zero
  // DOM writes. Called every racing frame.
  update({ lapNum, totalLaps, place, totalKarts, speedKmh, time }) {
    if (lapNum !== this._lapNum || totalLaps !== this._totalLaps) {
      this._lapNum = lapNum;
      this._totalLaps = totalLaps;
      this.lap.textContent = `Lap ${lapNum}/${totalLaps}`;
    }
    if (place !== this._place || totalKarts !== this._totalKarts) {
      this._place = place;
      this._totalKarts = totalKarts;
      this.place.textContent = `${ordinal(place)} / ${totalKarts}`;
    }
    const kmh = Math.round(speedKmh);
    if (kmh !== this._kmh) {
      this._kmh = kmh;
      this.speed.textContent = `${kmh} km/h`;
    }
    const tenths = Math.floor(time * 10);
    if (tenths !== this._tenths) {
      this._tenths = tenths;
      this.timer.textContent = formatTime(time);
    }
  }

  showToast(text) {
    if (text === this._lastToast) return;
    this._lastToast = text;
    this.toast.textContent = text;
    this.toast.classList.remove("show");
    void this.toast.offsetWidth; // restart animation
    this.toast.classList.add("show");
  }
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${m}:${s.toString().padStart(2, "0")}.${d}`;
}
