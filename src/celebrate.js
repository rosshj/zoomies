// Celebrations — the DOM side of the game's big moments. One layer inside
// #stage (so it rotates with the phone like every menu) carries:
//
//   confetti()   a 2D-canvas confetti burst over the whole stage
//   banner()     a sticker that slams across the screen ("CHAMPION!", "NEW BEST!")
//   reveal()     a stack of reveal cards: a "?" silhouette bursts open on the
//                live model of the cat/kart you just unlocked, turning on a
//                turntable, name stamped on, NEW ribbon dropped
//   flyTreats()  fish glyphs that fly from a payout row into the balance,
//                which bumps and counts up as each one lands
//   stamp()      a medal stamping down onto a badge row
//
// Tiers, so the rare moments stay rare: the podium ceremony (src/podium.js,
// driven from main.js) is the only "big"; reveal cards are "medium"; banners
// and fly-ins are the "small" pops. Everything respects prefers-reduced-motion:
// no confetti, no slams, cards open at once.
//
// The layer knows nothing about three.js: the live model comes through the
// `renderPortrait`/`spinPortrait` callbacks main.js wires to racer-portrait.js.

const PALETTE = ["#ffc64b", "#ff6b6b", "#5ad1c9", "#9b8cff", "#ffe7a8", "#ff9f43", "#7bed9f", "#f8f3e7"];

let _root = null; // #celebrate
let _canvas = null;
let _ctx = null;
let _banner = null;
let _reveal = null;
let _hooks = { renderPortrait: null, spinPortrait: null, haptic: null, cue: null, stageSize: null };
let _parts = [];
let _raf = 0;
let _lastT = 0;
let _bannerTimer = 0;
let _bannerDone = null;
let _revealQueue = [];
let _revealResolve = null;
let _revealTimer = 0;
let _spinRaf = 0;

export function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Wire the layer. `renderPortrait(canvas, cat, kart, subject)` returns a promise
// that resolves once the still is drawn; `spinPortrait(canvas, yaw)` turns the
// retained model; `stageSize()` returns {w, h} of the stage in CSS px.
export function installCelebrations(hooks) {
  _hooks = { ..._hooks, ...hooks };
  _root = document.getElementById("celebrate");
  if (!_root) return;
  _canvas = document.getElementById("celebrate-confetti");
  _ctx = _canvas?.getContext("2d") || null;
  _banner = document.getElementById("celebrate-banner");
  _reveal = document.getElementById("celebrate-reveal");
  document.getElementById("celebrate-continue")?.addEventListener("click", advanceReveal);
  _reveal?.addEventListener("click", (e) => {
    // A tap on the card itself also advances (the button is the affordance,
    // the whole card is the target); the dim backdrop does nothing.
    if (e.target.closest(".celebrate-card") && !e.target.closest("button")) advanceReveal();
  });
  window.addEventListener("keydown", (e) => {
    if (_reveal && !_reveal.classList.contains("hidden") && (e.key === "Escape" || e.key === "Enter")) {
      e.preventDefault();
      advanceReveal();
    }
  });
}

function stageSize() {
  if (_hooks.stageSize) return _hooks.stageSize();
  const r = _root?.getBoundingClientRect();
  return { w: r?.width || innerWidth, h: r?.height || innerHeight };
}

function showLayer() {
  _root?.classList.remove("hidden");
}
function maybeHideLayer() {
  if (!_root) return;
  const bannerUp = _banner && !_banner.classList.contains("hidden");
  const revealUp = _reveal && !_reveal.classList.contains("hidden");
  if (!_parts.length && !bannerUp && !revealUp) _root.classList.add("hidden");
}

// --- Confetti ---------------------------------------------------------------
// Rectangles that tumble and flutter down under gravity. `x`/`y` are stage
// fractions (0..1); `angle` is the launch direction in degrees (-90 = straight
// up), `spread` the cone around it, `power` the launch speed in px/s.
export function confetti({
  x = 0.5,
  y = 0.45,
  count = 120,
  angle = -90,
  spread = 70,
  power = 900,
  colors = PALETTE,
  gravity = 1500,
  drift = 0,
} = {}) {
  if (!_ctx || reducedMotion()) return;
  const { w, h } = stageSize();
  fitCanvas(w, h);
  const n = Math.min(count, 700 - _parts.length);
  for (let i = 0; i < n; i++) {
    const a = ((angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
    const sp = power * (0.45 + Math.random() * 0.75);
    _parts.push({
      x: x * w,
      y: y * h,
      vx: Math.cos(a) * sp + drift,
      vy: Math.sin(a) * sp,
      w: 6 + Math.random() * 7,
      h: 3 + Math.random() * 4,
      color: colors[(Math.random() * colors.length) | 0],
      rot: Math.random() * Math.PI,
      rotV: (Math.random() - 0.5) * 14,
      phase: Math.random() * Math.PI * 2,
      freq: 5 + Math.random() * 6,
      life: 2.6 + Math.random() * 1.6,
      age: 0,
      g: gravity,
    });
  }
  showLayer();
  if (!_raf) {
    _lastT = performance.now();
    _raf = requestAnimationFrame(tickConfetti);
  }
}

function fitCanvas(w, h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr),
    ph = Math.round(h * dpr);
  if (_canvas.width !== pw || _canvas.height !== ph) {
    _canvas.width = pw;
    _canvas.height = ph;
  }
  _canvas.style.width = `${w}px`;
  _canvas.style.height = `${h}px`;
  _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function tickConfetti(now) {
  const dt = Math.min(0.05, (now - _lastT) / 1000);
  _lastT = now;
  const { w, h } = stageSize();
  fitCanvas(w, h);
  _ctx.clearRect(0, 0, w, h);
  let alive = 0;
  for (const p of _parts) {
    p.age += dt;
    if (p.age >= p.life || p.y > h + 40) continue;
    // Drag, gravity, then the flutter: a leaf-like side-to-side as it falls.
    const drag = Math.exp(-2.2 * dt);
    p.vx *= drag;
    p.vy = p.vy * drag + p.g * dt;
    p.x += p.vx * dt + Math.sin(p.phase + p.age * p.freq) * 40 * dt;
    p.y += p.vy * dt;
    p.rot += p.rotV * dt;
    const fade = Math.min(1, (p.life - p.age) / 0.6);
    _ctx.globalAlpha = fade;
    _ctx.fillStyle = p.color;
    _ctx.save();
    _ctx.translate(p.x, p.y);
    _ctx.rotate(p.rot);
    // The tumble: the rectangle's apparent height breathes with the flutter.
    const sy = 0.35 + 0.65 * Math.abs(Math.cos(p.phase + p.age * p.freq * 0.7));
    _ctx.fillRect(-p.w / 2, (-p.h / 2) * sy, p.w, p.h * sy);
    _ctx.restore();
    _parts[alive++] = p;
  }
  _parts.length = alive;
  _ctx.globalAlpha = 1;
  if (alive) _raf = requestAnimationFrame(tickConfetti);
  else {
    _raf = 0;
    _ctx.clearRect(0, 0, w, h);
    maybeHideLayer();
  }
}

// Fire a cannon from each lower corner toward the middle.
export function confettiCannons(power = 1400, count = 90) {
  confetti({ x: 0.02, y: 1, angle: -62, spread: 32, power, count });
  confetti({ x: 0.98, y: 1, angle: -118, spread: 32, power, count });
}

// --- Banner ----------------------------------------------------------------
// A sticker slams in (big, tilted), holds, then drops away. Resolves when gone.
export function banner({ title, sub = "", emoji = "", hold = 2200, tone = "gold", burst = true } = {}) {
  if (!_banner) return Promise.resolve();
  clearTimeout(_bannerTimer);
  _bannerDone?.();
  _banner.querySelector(".celebrate-banner-emoji").textContent = emoji;
  _banner.querySelector(".celebrate-banner-title").textContent = title;
  const subEl = _banner.querySelector(".celebrate-banner-sub");
  subEl.textContent = sub;
  subEl.classList.toggle("hidden", !sub);
  _banner.dataset.tone = tone;
  _banner.classList.remove("hidden", "is-out", "is-in");
  void _banner.offsetWidth; // restart the slam
  _banner.classList.add("is-in");
  showLayer();
  _hooks.haptic?.("medium");
  if (burst) confetti({ x: 0.5, y: 0.42, count: 80, spread: 360, power: 650, gravity: 1200 });
  return new Promise((resolve) => {
    _bannerDone = resolve;
    _bannerTimer = setTimeout(
      () => {
        _banner.classList.add("is-out");
        _bannerTimer = setTimeout(
          () => {
            _banner.classList.add("hidden");
            _banner.classList.remove("is-in", "is-out");
            _bannerDone = null;
            maybeHideLayer();
            resolve();
          },
          reducedMotion() ? 0 : 420,
        );
      },
      reducedMotion() ? Math.min(hold, 1200) : hold,
    );
  });
}

// --- Reveal cards ------------------------------------------------------------
// cards: [{ kicker, name, sub, subject: "cat"|"kart"|null, cat, kart, emoji,
//           ribbon }] — `cat`/`kart` are the spec objects the portrait renderer
// takes. Resolves once the player has dismissed the last card.
export function reveal(cards) {
  if (!_reveal || !cards?.length) return Promise.resolve();
  return new Promise((resolve) => {
    const prev = _revealResolve;
    _revealQueue.push(...cards);
    _revealResolve = () => {
      prev?.();
      resolve();
    };
    if (_reveal.classList.contains("hidden")) nextReveal();
    else refreshDots();
  });
}

export function revealOpen() {
  return !!_reveal && !_reveal.classList.contains("hidden");
}

function refreshDots() {
  const dots = _reveal.querySelector(".celebrate-dots");
  dots.innerHTML = "";
  const total = _revealQueue.length + 1;
  if (total < 2) return;
  for (let i = 0; i < total; i++) {
    const d = document.createElement("i");
    if (i === 0) d.className = "is-on";
    dots.appendChild(d);
  }
}

function nextReveal() {
  const card = _revealQueue.shift();
  if (!card) {
    closeReveal();
    return;
  }
  clearTimeout(_revealTimer);
  stopSpin();
  const el = _reveal;
  el.querySelector("#celebrate-reveal-kicker").textContent = card.kicker || "Unlocked";
  const nameEl = el.querySelector(".celebrate-name");
  nameEl.textContent = card.name || "";
  const subEl = el.querySelector(".celebrate-sub");
  subEl.textContent = card.sub || "";
  subEl.classList.toggle("hidden", !card.sub);
  const ribbon = el.querySelector(".celebrate-ribbon");
  ribbon.textContent = card.ribbon || "NEW";
  const mystery = el.querySelector(".celebrate-mystery");
  mystery.textContent = card.emoji && !card.subject ? card.emoji : "?";
  const stage = el.querySelector(".celebrate-stage");
  stage.dataset.subject = card.subject || "none";
  stage.style.setProperty("--celebrate-backdrop", card.backdrop || "#a4dedf");
  const canvas = el.querySelector("#celebrate-portrait");
  canvas.dataset.ready = "false";
  canvas.setAttribute("aria-label", card.name || "");
  el.classList.remove("is-open");
  el.classList.remove("hidden");
  refreshDots();
  showLayer();
  document.getElementById("celebrate-continue").textContent = _revealQueue.length ? "Next" : card.cta || "Nice!";
  // The "?" holds for a beat while the model renders; then the box opens.
  const minHold = reducedMotion() ? 0 : 900;
  const rendered =
    card.subject && _hooks.renderPortrait
      ? _hooks.renderPortrait(canvas, card.cat, card.kart, card.subject).catch((e) => {
          console.warn("Reveal portrait unavailable", e);
        })
      : Promise.resolve();
  const started = performance.now();
  let opened = false;
  const open = () => {
    if (opened || el.classList.contains("hidden")) return;
    opened = true;
    el.classList.add("is-open");
    _hooks.cue?.("sparkle");
    _hooks.haptic?.("heavy");
    confetti({ x: 0.5, y: 0.4, count: 110, spread: 360, power: 720, gravity: 1300 });
    if (card.subject && canvas.dataset.ready === "true") startSpin(canvas);
  };
  rendered.then(() => {
    const wait = Math.max(0, minHold - (performance.now() - started));
    _revealTimer = setTimeout(open, wait);
  });
  // Never leave the player staring at a "?" if the render stalls.
  _revealTimer = setTimeout(open, 3500);
  el.querySelector("#celebrate-continue").focus({ preventScroll: true });
}

function advanceReveal() {
  if (!_reveal || _reveal.classList.contains("hidden")) return;
  _hooks.cue?.("press");
  nextReveal();
}

function closeReveal() {
  clearTimeout(_revealTimer);
  stopSpin();
  _reveal.classList.add("hidden");
  _reveal.classList.remove("is-open");
  const done = _revealResolve;
  _revealResolve = null;
  maybeHideLayer();
  done?.();
}

// Turntable: the retained model turns slowly while the card is up.
function startSpin(canvas) {
  if (!_hooks.spinPortrait || reducedMotion()) return;
  let yaw = 0.35;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    yaw += dt * 0.9;
    _hooks.spinPortrait(canvas, yaw);
    _spinRaf = requestAnimationFrame(step);
  };
  _spinRaf = requestAnimationFrame(step);
}
function stopSpin() {
  if (_spinRaf) cancelAnimationFrame(_spinRaf);
  _spinRaf = 0;
}

// --- Treats fly-in -------------------------------------------------------------
// Fish glyphs leave `from`'s centre on a lofted arc into `to`; each landing bumps
// the target and calls onLand(i). Resolves after the last one lands.
export function flyTreats({ from, to, count = 6, onLand = null, delay = 0 } = {}) {
  if (!_root || !from || !to) return Promise.resolve();
  const n = Math.max(1, Math.min(12, count));
  if (reducedMotion()) {
    for (let i = 0; i < n; i++) onLand?.(i, n);
    return Promise.resolve();
  }
  const stage = _root.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  // Rects are physical; the layer is in stage space, which may be rotated.
  // Convert both through the stage's own rect with the stage's rotation.
  const toStage = (px, py) => stagePoint(px, py, stage);
  const p0 = toStage(a.left + a.width / 2, a.top + a.height / 2);
  const p1 = toStage(b.left + b.width / 2, b.top + b.height / 2);
  showLayer();
  return new Promise((resolve) => {
    let landed = 0;
    for (let i = 0; i < n; i++) {
      const fish = document.createElement("span");
      fish.className = "celebrate-fish";
      fish.textContent = "🐟";
      const lift = -60 - Math.random() * 70;
      const dx = (Math.random() - 0.5) * 40;
      fish.style.setProperty("--x0", `${p0.x + dx}px`);
      fish.style.setProperty("--y0", `${p0.y}px`);
      fish.style.setProperty("--x1", `${p1.x}px`);
      fish.style.setProperty("--y1", `${p1.y}px`);
      fish.style.setProperty("--lift", `${lift}px`);
      fish.style.animationDelay = `${delay + i * 90}ms`;
      _root.appendChild(fish);
      fish.addEventListener(
        "animationend",
        () => {
          fish.remove();
          to.classList.remove("celebrate-bump");
          void to.offsetWidth;
          to.classList.add("celebrate-bump");
          onLand?.(i, n);
          if (++landed === n) {
            _hooks.cue?.("chime");
            setTimeout(() => to.classList.remove("celebrate-bump"), 400);
            maybeHideLayer();
            resolve();
          }
        },
        { once: true },
      );
    }
  });
}

// Map a physical (viewport) point into the stage's local, possibly rotated, frame.
function stagePoint(px, py, stage) {
  const cx = stage.left + stage.width / 2;
  const cy = stage.top + stage.height / 2;
  const dx = px - cx,
    dy = py - cy;
  // The stage's own CSS size is what its children lay out in; its rect is the
  // rotated bounding box. Read the rotation off the transform.
  const m = getComputedStyle(_root.parentElement).transform;
  let a = 0,
    b = 0,
    w = stage.width,
    h = stage.height;
  if (m && m !== "none") {
    const v = m
      .match(/matrix\(([^)]+)\)/)?.[1]
      .split(",")
      .map(Number);
    if (v && v.length === 6) {
      a = v[0];
      b = v[1]; // rotation matrix [a b; -b a]
      w = _root.parentElement.clientWidth;
      h = _root.parentElement.clientHeight;
    }
  }
  if (a === 0 && b === 0) return { x: dx + w / 2, y: dy + h / 2 };
  // Inverse rotation: local = R^-1 · physical offset.
  return { x: a * dx + b * dy + w / 2, y: -b * dx + a * dy + h / 2 };
}

// Count a number up (or down) in an element over `ms`, keeping any prefix text.
export function countUp(el, from, to, { ms = 700, prefix = "", suffix = "" } = {}) {
  if (!el) return;
  if (reducedMotion() || from === to) {
    el.textContent = `${prefix}${to}${suffix}`;
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = `${prefix}${Math.round(from + (to - from) * e)}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A medal stamping down onto a row (class-driven; see celebrate.css).
export function stamp(el, delay = 0) {
  if (!el) return;
  el.classList.add("celebrate-stamp");
  el.style.animationDelay = `${delay}ms`;
  el.addEventListener("animationend", () => el.classList.add("celebrate-stamped"), { once: true });
}

// Everything down at once (leaving a race, a reload).
export function clearCelebrations() {
  _parts.length = 0;
  _revealQueue.length = 0;
  clearTimeout(_bannerTimer);
  clearTimeout(_revealTimer);
  stopSpin();
  if (_banner) {
    _banner.classList.add("hidden");
    _banner.classList.remove("is-in", "is-out");
  }
  _bannerDone?.();
  _bannerDone = null;
  if (_reveal && !_reveal.classList.contains("hidden")) closeReveal();
  for (const fish of _root?.querySelectorAll(".celebrate-fish") || []) fish.remove();
  if (_ctx && _canvas) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  maybeHideLayer();
}
