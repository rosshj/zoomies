// Platform capability seam
// =========================
// The ONE place where web and native (iOS/Android) are allowed to differ.
//
// Rule of parity: game code (kart, track, hairball, hud, net, …) must never
// branch on the platform. It imports from here and gets a single adapter whose
// methods do the right thing per platform. Web and native run the identical
// game; only the handful of capabilities below have two implementations.
//
//   getPlatform()  → resolves the adapter for the current runtime (singleton)
//
// Adopt incrementally: today nothing in the game imports this, so it is inert
// scaffolding. Wire capabilities through it one at a time (see ./README.md) —
// e.g. route boot-time chrome through platform.ready(), haptics through
// platform.haptics, and eventual in-app purchases through platform.purchases.

let _platform = null;

// True inside a Capacitor native shell (iOS/Android). On the plain web the
// Capacitor global is absent, so this is false and we never touch native APIs.
function detectNative() {
  const cap = typeof window !== "undefined" ? window.Capacitor : undefined;
  return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

function detectName() {
  const cap = typeof window !== "undefined" ? window.Capacitor : undefined;
  if (cap && typeof cap.getPlatform === "function") return cap.getPlatform(); // 'ios' | 'android' | 'web'
  return "web";
}

// Resolve (and memoise) the adapter for this runtime. Async because the native
// adapter dynamically imports Capacitor plugins that don't exist in a web build.
export async function getPlatform() {
  if (_platform) return _platform;
  const isNative = detectNative();
  const name = detectName();
  if (isNative) {
    const { createNativeAdapter } = await import("./native.js");
    _platform = await createNativeAdapter(name);
  } else {
    const { createWebAdapter } = await import("./web.js");
    _platform = createWebAdapter();
  }
  return _platform;
}

// Synchronous best-effort check for code paths that can't await (e.g. a quick
// branch in a hot loop). Prefer getPlatform() everywhere you can.
export function isNativePlatform() {
  return detectNative();
}
