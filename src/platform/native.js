// Native adapter — implements the platform capability contract on Capacitor
// (iOS today, Android later). It dynamically imports Capacitor plugins so this
// module is only ever evaluated inside a native shell; a web build never loads
// it (see ./index.js).
//
// Each plugin import is optional-guarded: if a plugin isn't installed yet the
// capability degrades to a no-op instead of throwing, so the game still boots.
// Install the plugins listed in package.json / IOS_SETUP.md to light them up.

async function tryImport(spec) {
  try { return await import(/* @vite-ignore */ spec); } catch { return null; }
}

export async function createNativeAdapter(name) {
  const haptics = await tryImport("@capacitor/haptics");
  const orientationMod = await tryImport("@capacitor/screen-orientation");
  const splash = await tryImport("@capacitor/splash-screen");
  const statusBar = await tryImport("@capacitor/status-bar");

  const ScreenOrientation = orientationMod?.ScreenOrientation;

  return {
    name, // 'ios' | 'android'
    isNative: true,

    // Native chrome the web can't do: keep a real landscape lock, hide the OS
    // status bar for an immersive full-screen race, then dismiss the splash once
    // the game is ready to draw. Called once at boot.
    async ready() {
      try { await ScreenOrientation?.lock({ orientation: "landscape" }); } catch { /* n/a */ }
      try { await statusBar?.StatusBar?.hide(); } catch { /* n/a */ }
      try { await splash?.SplashScreen?.hide(); } catch { /* n/a */ }
    },

    haptics: {
      impact() {
        try { haptics?.Haptics?.impact({ style: haptics.ImpactStyle.Medium }); } catch { /* n/a */ }
      },
      selection() {
        try { haptics?.Haptics?.selectionStart(); } catch { /* n/a */ }
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
