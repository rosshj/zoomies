// Web adapter — implements the platform capability contract using plain web
// APIs. This is what runs in the browser and (for now) is the reference
// behaviour every native adapter must match.

// iOS Safari never implemented navigator.vibrate — but toggling an
// <input type="checkbox" switch> (the native-styled switch, Safari 17.4+) fires
// the system haptic tick as a side effect, and a label.click() toggles it from
// script. That's the trick behind haptics.lochie.me / the ios-haptics library:
// a hidden switch + label pair becomes a poor man's taptic engine. Strictly
// best-effort — Apple has been narrowing programmatic triggering in newer iOS
// releases, and where it does nothing it costs nothing (the real taptics live
// in the native app's adapter). Built lazily so a desktop tab never touches it.
function makeIosSwitchTick() {
  try {
    const isIOS =
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!isIOS || typeof document === "undefined") return null;
    const probe = document.createElement("input");
    if (!("switch" in probe)) return null; // no switch support → no haptic side effect
    let label = null;
    return () => {
      if (!label) {
        if (!document.body) return;
        const wrap = document.createElement("div");
        // Kept out of sight and out of the way — but NOT display:none, which
        // would make the label unclickable.
        wrap.setAttribute("aria-hidden", "true");
        wrap.style.cssText = "position:fixed;left:-999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("switch", "");
        input.id = "zoomies-haptic-switch";
        label = document.createElement("label");
        label.htmlFor = input.id;
        wrap.append(input, label);
        document.body.appendChild(wrap);
      }
      label.click(); // toggle the switch → system haptic tick
    };
  } catch {
    return null;
  }
}

export function createWebAdapter() {
  const iosTick = makeIosSwitchTick();
  // One tap = one switch toggle; heavier styles stack a few in quick succession
  // (the switch tick has a single fixed strength, so count is the only dial).
  const burst = (n, gap = 45) => {
    if (!iosTick) return false;
    for (let i = 0; i < n; i++) (i === 0 ? iosTick() : setTimeout(iosTick, i * gap));
    return true;
  };
  const vibrate = (pattern) => {
    try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
  };

  return {
    name: "web",
    isNative: false,

    // Boot-time native chrome (splash/status bar/orientation lock) has no web
    // equivalent — the PWA handles all of that via the manifest and the game's
    // own counter-rotation. No-op keeps the boot path identical across targets.
    async ready() {},

    haptics: {
      // Android Chrome: navigator.vibrate. iOS Safari: the switch-toggle trick
      // above. Elsewhere: silently nothing — the native adapter has real taptics.
      impact(style = "medium") {
        if (burst(style === "heavy" ? 3 : style === "medium" ? 2 : 1)) return;
        vibrate(style === "heavy" ? 25 : style === "light" ? 6 : 12);
      },
      selection() {
        if (burst(1)) return;
        vibrate(5);
      },
      success() {
        if (burst(3, 90)) return;
        vibrate([12, 60, 18]);
      },
    },

    orientation: {
      // Best-effort; most mobile browsers reject lock() outside fullscreen, which
      // is exactly why the game counter-rotates its own UI. Native gets a real lock.
      async lock(orientation = "landscape") {
        try { await screen.orientation?.lock?.(orientation); } catch { /* rejected */ }
      },
      async unlock() {
        try { screen.orientation?.unlock?.(); } catch { /* unsupported */ }
      },
    },

    audio: {
      // The web has no API for "is other audio playing", so the policy gate
      // never engages here — game music behaves exactly as it always has.
      async otherAudioPlaying() { return false; },
      async reactivate() { /* no session concept on the web */ },
    },

    app: {
      // On the web, visibilitychange IS the app-state signal.
      onStateChange(cb) {
        document.addEventListener("visibilitychange", () => cb(!document.hidden));
      },
    },

    // In-app purchases don't exist on the web build. Report unavailable so the
    // store UI can hide/disable itself rather than call an API that isn't there.
    // (Web monetisation, if ever wanted, would be a separate Stripe-backed impl.)
    purchases: {
      available: false,
      async getOfferings() { return []; },
      async purchase() { throw new Error("purchases unavailable on web"); },
      async restore() { return []; },
    },
  };
}
