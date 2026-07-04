// Native adapter — implements the platform capability contract on Capacitor
// (iOS today, Android later). It is only ever evaluated inside a native shell;
// a web build never loads it (see ./index.js).
//
// Plugins are reached through Capacitor's injected global bridge,
// `window.Capacitor.Plugins.<Name>`, NOT via `import "@capacitor/..."`. The
// bridge is present whenever a plugin is installed natively and needs no
// bundler — which matters because this project currently serves raw ES modules
// (no bundler; bare specifiers wouldn't resolve, and build-web.mjs doesn't ship
// node_modules). When a bundler (Vite) lands later, the bridge still works, so
// this stays correct. If a plugin isn't installed, its bridge entry is
// undefined and the capability degrades to a no-op instead of throwing.

function plugins() {
  return (typeof window !== "undefined" && window.Capacitor && window.Capacitor.Plugins) || {};
}

export async function createNativeAdapter(name) {
  const P = plugins();
  const SplashScreen = P.SplashScreen;
  const StatusBar = P.StatusBar;
  const ScreenOrientation = P.ScreenOrientation;
  const Haptics = P.Haptics;

  return {
    name, // 'ios' | 'android'
    isNative: true,

    // Native chrome the web can't do: keep a real landscape lock, hide the OS
    // status bar for an immersive full-screen race, then dismiss the splash now
    // that the game is ready to draw (instead of Capacitor's default timeout).
    // Called once at boot.
    async ready() {
      try { await ScreenOrientation?.lock({ orientation: "landscape" }); } catch { /* n/a */ }
      try { await StatusBar?.hide(); } catch { /* n/a */ }
      try { await SplashScreen?.hide(); } catch { /* n/a */ }
    },

    haptics: {
      // Bridge takes the style as a plain string ("LIGHT"|"MEDIUM"|"HEAVY"); the
      // ImpactStyle enum from the JS wrapper isn't available without bundling it.
      impact() {
        try { Haptics?.impact({ style: "MEDIUM" }); } catch { /* n/a */ }
      },
      selection() {
        try { Haptics?.selectionStart(); } catch { /* n/a */ }
      },
    },

    orientation: {
      async lock(orientation = "landscape") {
        try { await ScreenOrientation?.lock({ orientation }); } catch { /* n/a */ }
      },
      async unlock() {
        try { await ScreenOrientation?.unlock(); } catch { /* n/a */ }
      },
    },

    // In-app purchases. Left as a documented stub until the store SDK is wired:
    // the plan is RevenueCat (@revenuecat/purchases-capacitor), which fronts
    // StoreKit on iOS and Google Play Billing on Android with one entitlement
    // model — see IOS_SETUP.md. Until then `available:false` keeps the store UI
    // dormant rather than calling an unconfigured API.
    purchases: {
      available: false,
      async getOfferings() { return []; },
      async purchase() { throw new Error("purchases not configured yet (RevenueCat pending)"); },
      async restore() { return []; },
    },
  };
}
