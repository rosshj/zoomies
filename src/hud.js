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
  }

  // Reflect the player's active item-box power-ups as top-left pills. Timed ones
  // (shield / catnip) show whole seconds remaining and blink in the last 3s; the
  // tri-furball shows how many fan-shots are left.
  setPowerups(shieldT, triN, catnipT) {
    this._pu(this.puShield, shieldT > 0, Math.ceil(shieldT) + "s", shieldT > 0 && shieldT <= 3);
    this._pu(this.puTri, triN > 0, "×" + triN, false);
    this._pu(this.puCatnip, catnipT > 0, Math.ceil(catnipT) + "s", catnipT > 0 && catnipT <= 3);
  }

  _pu(el, on, text, expiring) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
    if (!on) return;
    const v = el.querySelector(".pu-val");
    if (v && v.textContent !== text) v.textContent = text;
    el.classList.toggle("expiring", !!expiring);
  }

  update({ lapNum, totalLaps, place, totalKarts, speedKmh, time }) {
    this.lap.textContent = `Lap ${lapNum}/${totalLaps}`;
    this.place.textContent = `${ordinal(place)} / ${totalKarts}`;
    this.speed.textContent = `${Math.round(speedKmh)} km/h`;
    this.timer.textContent = formatTime(time);
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
