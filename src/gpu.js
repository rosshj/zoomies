// Renderer backend selection.
//
// The whole app runs on three's WebGPURenderer. It DEFAULTS to the actual WebGPU
// backend (far lower draw-call overhead and the headroom for all the dynamic
// objects/effects), and auto-falls back to the WebGL2 backend on devices without
// WebGPU. Force the WebGL2 fallback with ?webgl=1 (e.g. to A/B the two backends,
// or work around a flaky GPU driver).
//
// STICKY FALLBACK: iOS Safari's WebGPU can lose its device under memory pressure
// (a mid-game blank → reload). When the crash guard catches that, it sets the
// flag below so subsequent loads use the more battle-tested WebGL2 backend instead
// of crashing again. ?webgpu=1 clears the flag to retry WebGPU.
const _params = new URLSearchParams(location.search);
let _preferWebGL = false;
try {
  if (_params.has("webgpu")) localStorage.removeItem("zoomies-prefer-webgl"); // explicit retry
  else _preferWebGL = localStorage.getItem("zoomies-prefer-webgl") === "1";
} catch {
  /* storage unavailable — just use the URL/default */
}

// iOS + multiplayer → start on WebGL2 instead of WebGPU. Multiplayer piles two
// extra karts + the realtime client onto an already heavy scene, and iOS's WebGPU
// is the backend that loses its device under that memory pressure (the reported
// guest crash). WebGL2 is the battle-tested path there. Scoped to iOS-in-MP so
// single-player keeps WebGPU's headroom; a guest loads with ?mp=1 in the URL, so
// this resolves before the renderer is created. ?webgpu=1 overrides to retry.
const _isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Shared: iOS gets conservative GPU-memory choices elsewhere (its WebGPU device
// loss under memory pressure is this game's one hard-crash mode).
export const IS_IOS = _isIOS;
const _iosMultiplayer = _isIOS && _params.has("mp") && !_params.has("webgpu");

export const USE_WEBGPU = !_params.has("webgl") && !_preferWebGL && !_iosMultiplayer;
