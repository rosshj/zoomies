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
  const AudioSession = P.AudioSession; // local plugin: plugins/audio-session
  const App = P.App; // @capacitor/app — native app-state events

  return {
    name, // 'ios' | 'android'
    isNative: true,

    // Native chrome the web can't do: keep a real landscape lock, hide the OS
    // status bar for an immersive full-screen race, then dismiss the splash now
    // that the game is ready to draw (instead of Capacitor's default timeout).
    // Called once at boot.
    async ready() {
      // One diagnostic line so a device log shows exactly which native plugins
      // the bridge actually exposes (false = pod not installed → that capability
      // silently no-ops; fix with `npm install && npx cap sync ios`).
      console.log(
        `[zoomies] native ready (${name}): orientation=${!!ScreenOrientation} statusBar=${!!StatusBar} splash=${!!SplashScreen} haptics=${!!Haptics} audioSession=${!!AudioSession} app=${!!App}`
      );
      try { await ScreenOrientation?.lock({ orientation: "landscape" }); } catch { /* n/a */ }
      try { await StatusBar?.hide(); } catch { /* n/a */ }
      // Ambient + mixWithOthers: game audio coexists with the player's own
      // music/podcast and respects the hardware silent switch.
      try { await AudioSession?.configure(); } catch { /* n/a */ }
      try { await SplashScreen?.hide(); } catch { /* n/a */ }
    },

    haptics: {
      // Bridge takes the style as a plain string ("LIGHT"|"MEDIUM"|"HEAVY"); the
      // ImpactStyle enum from the JS wrapper isn't available without bundling it.
      // NOTE: every bridge call returns a promise — a bare try/catch does NOT
      // catch its async rejection, and one rejected fire-and-forget call was
      // enough to trip the crash guard ("returnResult@user-script" rejection →
      // "Recovered after an unexpected restart"). Always .catch() them.
      impact(style = "medium") {
        try { Haptics?.impact({ style: style.toUpperCase() })?.catch?.(() => {}); } catch { /* n/a */ }
      },
      selection() {
        try { Haptics?.selectionStart()?.catch?.(() => {}); } catch { /* n/a */ }
      },
      // Apple's "success" notification pattern (double tap) — race finish etc.
      success() {
        try { Haptics?.notification({ type: "SUCCESS" })?.catch?.(() => {}); } catch { /* n/a */ }
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

    audio: {
      // "Their audio wins": true when the player already has music/a podcast
      // rolling, so the game should keep its own music silent (SFX still play).
      // configure() first (idempotent): until our ambient session is active,
      // iOS's answer is unreliable — a paused podcast app still holding the
      // session read as "playing" and muted the music for no audible reason.
      async otherAudioPlaying() {
        try {
          await AudioSession?.configure();
          const r = await AudioSession?.isOtherAudioPlaying();
          return !!r?.playing;
        } catch { return false; }
      },
      // Re-establish the (deactivated) session after returning to the app.
      async reactivate() {
        try { await AudioSession?.configure(); } catch { /* n/a */ }
      },
    },

    app: {
      // Native app-state events. The web view's visibilitychange/pagehide are
      // NOT delivered when the app backgrounds (they arrive late, on return —
      // a 31s "frozen frame" in the device log proved it), so everything that
      // must run AT backgrounding (pausing audio, most importantly) has to
      // hang off the native appStateChange instead.
      onStateChange(cb) {
        const fire = (active) => {
          // iOS deactivates our audio session on backgrounding, and it can
          // refuse reactivation for a while after return (a single immediate
          // configure() left the game silent until an app-switcher round trip
          // generated a later retry). Spread reactivation attempts out.
          if (active) {
            const re = () => { try { AudioSession?.configure()?.catch?.(() => {}); } catch { /* n/a */ } };
            re();
            setTimeout(re, 600);
            setTimeout(re, 2000);
          }
          cb(active);
        };
        // addListener also returns a promise (see haptics note).
        try { App?.addListener("appStateChange", (s) => fire(!!s?.isActive))?.catch?.(() => {}); } catch { /* n/a */ }
        // Locking the phone can resign-active WITHOUT a full appStateChange —
        // pause/resume cover that path. All handlers are idempotent.
        try { App?.addListener("pause", () => fire(false))?.catch?.(() => {}); } catch { /* n/a */ }
        try { App?.addListener("resume", () => fire(true))?.catch?.(() => {}); } catch { /* n/a */ }
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
