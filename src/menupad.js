// Gamepad navigation for every 2D surface OUTSIDE the race: the menu flow
// screens and the overlay sheets (pause, results, settings, catalog…).
// Racing input lives in input.js — this module goes inert the moment no menu
// surface is up, so the two never fight over the same buttons.
//
// It drives the EXISTING click/keyboard paths instead of duplicating any menu
// logic: A clicks the focused button, B synthesises Escape (which already
// walks back out of sheets and flow steps), Start synthesises P (which
// already pauses/resumes). Focus is spatial — d-pad/stick moves to the
// nearest visible button in that direction — so new screens work without
// registering anything.
export class MenuPad {
  constructor() {
    this._prev = []; // last frame's button states (edge detection)
    this._focus = null; // currently ringed element
    this._scopeEl = null; // container the focus lives in
    this._repeatAt = 0; // performance.now() gate for held-direction repeat
    this._heldDir = null; // which direction is being held (repeat resets on change)
  }

  update() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) {
      if (p && p.connected && p.buttons?.length) { pad = p; break; }
    }
    if (!pad) { this._prev.length = 0; this._setFocus(null); return; }

    const prev = this._prev;
    const down = (i) => !!pad.buttons[i]?.pressed && !prev[i];

    // Start (or the PS options button) pauses/resumes ANYWHERE — the existing
    // P-key handler owns the state logic, including exiting the fly-through.
    if (down(9)) this._key("KeyP");

    const scope = this._scope();
    if (!scope) {
      this._setFocus(null);
      this._commit(pad);
      return;
    }
    if (scope !== this._scopeEl) {
      // New screen/sheet: seat the ring straight onto its primary action —
      // with a pad plugged in (the only way this code runs) the player should
      // always see what A will press, without having to touch a stick first.
      this._scopeEl = scope;
      this._seatDefault(scope);
    } else if (this._focus && !this._valid(this._focus)) {
      // Same screen but the ringed button vanished (grids re-render on
      // selection, buy buttons swap out): re-seat rather than going ringless.
      this._seatDefault(scope);
    }

    // B backs out — same path as Escape (topmost sheet first, then one flow
    // step; resumes when paused).
    if (down(1)) this._key("Escape");

    // A activates the ringed button (auto-seated on entry; the fallback
    // re-seat covers a ring lost to a mid-frame DOM swap).
    if (down(0)) {
      if (this._focus && this._valid(this._focus)) this._activate(this._focus);
      else this._seatDefault(scope);
    }

    // Direction: d-pad, or the left stick past a firm threshold. Held input
    // repeats slowly (350ms first step, 160ms after) so lists are scrollable
    // without skipping.
    const ax = pad.axes?.[0] ?? 0, ay = pad.axes?.[1] ?? 0;
    let dir = null;
    if (pad.buttons[12]?.pressed || ay < -0.55) dir = "up";
    else if (pad.buttons[13]?.pressed || ay > 0.55) dir = "down";
    else if (pad.buttons[14]?.pressed || ax < -0.55) dir = "left";
    else if (pad.buttons[15]?.pressed || ax > 0.55) dir = "right";

    const now = performance.now();
    if (dir) {
      const firstStep = dir !== this._heldDir;
      if (firstStep || now >= this._repeatAt) {
        this._move(dir, scope);
        this._repeatAt = now + (firstStep ? 350 : 160);
      }
    }
    this._heldDir = dir;

    this._commit(pad);
  }

  _commit(pad) {
    const prev = this._prev;
    prev.length = pad.buttons.length;
    for (let i = 0; i < pad.buttons.length; i++) prev[i] = !!pad.buttons[i]?.pressed;
  }

  // The surface the pad should navigate right now, or null during play.
  // Topmost visible overlay wins — the sheets (settings/catalog/track-panel)
  // come after pause/results in the DOM, matching their stacking — then the
  // active flow screen of the menu. #rotate is a passive prompt, never focus.
  _scope() {
    let top = null;
    for (const o of document.querySelectorAll(".overlay:not(.hidden)")) {
      if (o.id !== "rotate") top = o;
    }
    if (top) return top;
    const menu = document.getElementById("menu");
    if (menu && !menu.classList.contains("hidden")) {
      return menu.querySelector(".flow-screen.is-active") || menu;
    }
    return null;
  }

  _valid(el) {
    if (!el.isConnected || el.disabled || el.classList.contains("hidden")) return false;
    if (this._scopeEl && !this._scopeEl.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3;
  }

  _candidates(scope) {
    const out = [];
    for (const el of scope.querySelectorAll("button")) {
      if (el.disabled || el.classList.contains("hidden")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue; // display:none/collapsed
      out.push({ el, r });
    }
    return out;
  }

  // The screen's primary action: the gold button when there is one (Let's
  // Go!, START RACE), else the first button that ISN'T back/close chrome —
  // which lands on the first real choice of every picker screen (Single race,
  // the first track card, Marmalade, Ember, RESUME…).
  _seatDefault(scope) {
    const cands = this._candidates(scope);
    if (!cands.length) { this._setFocus(null); return; }
    const isChrome = (el) =>
      el.classList.contains("flow-back") || el.hasAttribute("data-back") ||
      /(^|-)(back|close)($|-)/.test(el.id);
    const pick =
      cands.find((c) => c.el.classList.contains("btn-gold")) ||
      cands.find((c) => !isChrome(c.el)) ||
      cands[0];
    this._setFocus(pick.el);
  }

  // Move the ring spatially from the current element.
  _move(dir, scope) {
    const cands = this._candidates(scope);
    if (!cands.length) return;
    const cur = this._focus && this._valid(this._focus)
      ? this._focus.getBoundingClientRect()
      : null;

    let next = null;
    if (!cur || !dir) {
      this._seatDefault(scope);
      return;
    } else {
      const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
      let best = Infinity;
      for (const { el, r } of cands) {
        if (el === this._focus) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const dx = x - cx, dy = y - cy;
        // Must lie in the pressed direction; score = distance along it plus a
        // doubled off-axis penalty, so "down" prefers the button below over a
        // nearer one diagonally sideways.
        let fwd, side;
        if (dir === "up") { fwd = -dy; side = Math.abs(dx); }
        else if (dir === "down") { fwd = dy; side = Math.abs(dx); }
        else if (dir === "left") { fwd = -dx; side = Math.abs(dy); }
        else { fwd = dx; side = Math.abs(dy); }
        if (fwd < 4) continue;
        const score = fwd + side * 2;
        if (score < best) { best = score; next = el; }
      }
    }
    if (next) this._setFocus(next);
  }

  _setFocus(el) {
    if (el === this._focus) return;
    this._focus?.classList.remove("pad-focus");
    this._focus = el;
    if (el) {
      el.classList.add("pad-focus");
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } else {
      this._scopeEl = null;
    }
  }

  _activate(el) {
    el.click();
    // The click usually changes the screen; the ring re-seats on next input.
    if (!this._valid(el)) this._setFocus(null);
  }

  _key(code) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  }
}
