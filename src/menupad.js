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
//
// The keyboard rides the same ring: main.js routes the arrow keys + Enter
// through keyNav()/keyActivate() so a keyboard-only player (a Deck in desktop
// mode, a laptop with no mouse) gets the same spatial navigation as a pad.
export class MenuPad {
  constructor() {
    this._prev = []; // last frame's button states (edge detection)
    this._focus = null; // currently ringed element
    this._scopeEl = null; // container the focus lives in
    this._repeatAt = 0; // performance.now() gate for held-direction repeat
    this._heldDir = null; // which direction is being held (repeat resets on change)
    this._kb = false; // the ring was last placed by the keyboard (survives pad-less frames)
    this.hasPad = false; // a connected pad was seen this frame (drives the "Press A" copy + legend)
    this.active = false; // a navigable surface is up this frame (menu or sheet)
  }

  update() {
    const raw = navigator.getGamepads ? navigator.getGamepads() : [];
    const pads = [];
    for (const p of raw) {
      if (p && p.connected && p.buttons?.length) pads.push(p);
    }
    this.hasPad = pads.length > 0;
    this.active = !!this._scope();
    if (!pads.length) {
      this._prev.length = 0;
      // No pad: the ring only lives on if the KEYBOARD placed it, and only
      // while it still points at a live control on the same screen — a
      // screen change drops it until the next arrow key re-seats.
      if (!this._kb || !this._focus || !this._valid(this._focus) || this._scope() !== this._scopeEl) {
        this._setFocus(null);
      }
      return;
    }
    // EVERY connected pad drives the menus, not just the first: on a couch,
    // players 2-4 must be able to move the ring on their own seat pass (and
    // hit Start) without the "pass pad #1 around" ritual. Buttons OR
    // together; each axis takes the largest deflection.
    const pad = pads.length === 1 ? pads[0] : this._merge(pads);

    // First contact: the Gamepad API only exposes a pad after its FIRST
    // input, so that input's edges all read as fresh presses. Seat the ring
    // and swallow them — the first touch should show where focus is, never
    // act on it (an invisible ring "activated" the title button this way).
    if (this._prev.length === 0) {
      const scope = this._scope();
      if (scope) { this._scopeEl = scope; this._seatDefault(scope); }
      this._commit(pad);
      return;
    }

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
    this._kb = false;
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

    // Y opens Settings and Select (back/view) the Cat-alog from any flow
    // screen — the chrome chips ride the top-right corner and are also in
    // the spatial candidates, but a dedicated button means nobody has to
    // hunt for them. Only on the flow: a sheet already up owns Y/Select.
    if (down(3)) this._shortcut(scope, "chrome-gear", "open-settings");
    if (down(8)) this._shortcut(scope, "chrome-treats", "open-catalog");

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

  // Keyboard spatial nav (main.js calls these from its keydown handler). Both
  // return true when the key was consumed, so the caller can preventDefault
  // (arrow keys would otherwise scroll the flow body). Inert during play.
  keyNav(dir) {
    const scope = this._scope();
    if (!scope) return false;
    this._kb = true;
    if (scope !== this._scopeEl || !this._focus || !this._valid(this._focus)) {
      // First arrow on a screen shows where the ring is rather than jumping
      // past the primary action — the same "seat first" rule the pad uses.
      this._scopeEl = scope;
      this._seatDefault(scope);
      return true;
    }
    this._move(dir, scope);
    return true;
  }
  keyActivate() {
    const scope = this._scope();
    if (!scope || !this._focus || !this._valid(this._focus)) return false;
    this._activate(this._focus);
    return true;
  }

  _shortcut(scope, chromeId, flowId) {
    if (!scope.classList.contains("flow-screen") && scope.id !== "menu") return;
    for (const id of [chromeId, flowId]) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains("hidden")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      el.click();
      return;
    }
  }

  _merge(pads) {
    const nb = Math.max(...pads.map((p) => p.buttons.length));
    const buttons = [];
    for (let i = 0; i < nb; i++) {
      buttons.push({ pressed: pads.some((p) => !!p.buttons[i]?.pressed) });
    }
    const axes = [0, 0];
    for (const p of pads) {
      for (let a = 0; a < 2; a++) {
        const v = p.axes?.[a] ?? 0;
        if (Math.abs(v) > Math.abs(axes[a])) axes[a] = v;
      }
    }
    return { buttons, axes };
  }

  _commit(pad) {
    const prev = this._prev;
    prev.length = pad.buttons.length;
    for (let i = 0; i < pad.buttons.length; i++) prev[i] = !!pad.buttons[i]?.pressed;
  }

  // The surface the pad should navigate right now, or null during play.
  // Topmost visible overlay wins — the sheets (settings/catalog/track-panel)
  // come after pause/results in the DOM, matching their stacking — then the
  // active flow screen of the menu.
  _scope() {
    let top = null;
    for (const o of document.querySelectorAll(".overlay:not(.hidden)")) top = o;
    if (top) return top;
    const menu = document.getElementById("menu");
    if (menu && !menu.classList.contains("hidden")) {
      return menu.querySelector(".flow-screen.is-active") || menu;
    }
    return null;
  }

  // The persistent menu chrome (🐟 balance + ⚙ gear) floats OUTSIDE the flow
  // screens but belongs to whichever flow step is up — fold it into that
  // step's candidates so the pad can reach prices' balance and Settings.
  _chrome(scope) {
    if (!scope.classList.contains("flow-screen")) return null;
    const c = document.getElementById("menu-chrome");
    return c && !c.classList.contains("hidden") ? c : null;
  }

  _valid(el) {
    if (!el.isConnected || el.disabled || el.classList.contains("hidden")) return false;
    if (this._scopeEl && !this._scopeEl.contains(el)) {
      const chrome = this._chrome(this._scopeEl);
      if (!chrome || !chrome.contains(el)) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3;
  }

  // Everything the ring may land on: buttons, plus range sliders (which A
  // leaves alone — left/right nudge them instead, see _move).
  _candidates(scope) {
    const out = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll("button, input[type=range]")) {
        if (el.disabled || el.classList.contains("hidden")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue; // display:none/collapsed
        out.push({ el, r });
      }
    };
    collect(scope);
    const chrome = this._chrome(scope);
    if (chrome) collect(chrome);
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
      /(^|-)(back|close)($|-)/.test(el.id) || el.closest("#menu-chrome");
    const pick =
      cands.find((c) => c.el.classList.contains("btn-gold")) ||
      cands.find((c) => !isChrome(c.el) && c.el.tagName === "BUTTON") ||
      cands.find((c) => !isChrome(c.el)) ||
      cands[0];
    this._setFocus(pick.el);
  }

  // Move the ring spatially from the current element.
  _move(dir, scope) {
    // A ringed slider eats left/right: nudge by 5% of its range and fire the
    // same input/change events a drag would, so the volume/knob handlers run.
    if (this._focus && this._focus.type === "range" && (dir === "left" || dir === "right")) {
      this._nudge(this._focus, dir === "left" ? -1 : 1);
      return;
    }
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

  _nudge(range, sign) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const step = Math.max(Number(range.step) || 1, (max - min) * 0.05);
    const v = Math.min(max, Math.max(min, Number(range.value) + sign * step));
    if (v === Number(range.value)) return;
    range.value = String(Math.round(v));
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  }

  _setFocus(el) {
    if (el === this._focus) return;
    this._focus?.classList.remove("pad-focus");
    this._focus = el;
    if (el) {
      el.classList.add("pad-focus");
      this._scrollTo(el);
    } else {
      this._scopeEl = null;
    }
  }

  // Bring the ringed button into view WITHOUT scrollIntoView: that call also
  // scrolls overflow:hidden ancestors, and seating focus while a flow screen
  // is still mid-slide (translateX) dragged #menu sideways PERMANENTLY —
  // cut-off headers and stranded panels on desktop. Scroll only the nearest
  // overflow-y container, only vertically; a mid-slide translateX can't
  // affect scrollTop, so seating during the animation is harmless.
  _scrollTo(el) {
    // Repair any stray sideways drag first (nothing in the menus may ever
    // scroll #menu itself — screens move by transform, bodies scroll in y).
    const menu = document.getElementById("menu");
    if (menu) { menu.scrollLeft = 0; menu.scrollTop = 0; }
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY)) {
        const pr = p.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.top < pr.top + 8) p.scrollTop += er.top - pr.top - 8;
        else if (er.bottom > pr.bottom - 8) p.scrollTop += er.bottom - pr.bottom + 8;
        break;
      }
    }
  }

  _activate(el) {
    if (el.type === "range") return; // sliders are driven by left/right, A is a no-op
    el.click();
    // The click usually changes the screen; the ring re-seats on next input.
    if (!this._valid(el)) this._setFocus(null);
  }

  _key(code) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
  }
}
