// Web adapter — implements the platform capability contract using plain web
// APIs. This is what runs in the browser and (for now) is the reference
// behaviour every native adapter must match.

export function createWebAdapter() {
  return {
    name: "web",
    isNative: false,

    // Boot-time native chrome (splash/status bar/orientation lock) has no web
    // equivalent — the PWA handles all of that via the manifest and the game's
    // own counter-rotation. No-op keeps the boot path identical across targets.
    async ready() {},

    haptics: {
      // navigator.vibrate is a rough web stand-in; absent on iOS Safari, so this
      // silently does nothing there — the native adapter provides real haptics.
      impact() {
        try { navigator.vibrate?.(10); } catch { /* unsupported */ }
      },
      selection() {
        try { navigator.vibrate?.(5); } catch { /* unsupported */ }
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
