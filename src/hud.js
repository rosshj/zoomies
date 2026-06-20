// Thin wrapper around the HUD DOM elements.
export class HUD {
  constructor() {
    this.lap = document.getElementById("lap");
    this.place = document.getElementById("place");
    this.speed = document.getElementById("speed");
    this.timer = document.getElementById("timer");
    this.toast = document.getElementById("toast");
    this._lastToast = "";
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
