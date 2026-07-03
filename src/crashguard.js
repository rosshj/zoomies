// Crash guard.
//
// Symptom we're chasing: the screen goes blank mid-game and the app reloads back
// to the menu. That's the signature of a HARD crash (the browser reloads the
// tab), most often an iOS-Safari WebGPU device loss under memory pressure, but it
// can also be an uncaught JS error or an out-of-memory kill.
//
// This module does two things:
//   1. Records the last crash to localStorage so it SURVIVES the reload — on the
//      next load we can surface what happened (otherwise it's an invisible mystery).
//   2. On a GPU device/context loss, permanently falls back to the WebGL2 backend
//      (via gpu.js's sticky flag) and reloads, so an unstable WebGPU driver stops
//      crashing the game over and over.

const LOG_KEY = "zoomies-crashlog";
const PREFER_WEBGL = "zoomies-prefer-webgl";

function record(type, detail) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify({
      type,
      detail: String(detail == null ? "" : detail).slice(0, 600),
      backend: type.startsWith("webgpu") ? "WebGPU" : undefined,
      when: Date.now(),
      ua: navigator.userAgent.slice(0, 120),
    }));
  } catch {
    /* storage full / unavailable — nothing more we can do */
  }
}

// Read + clear any crash recorded before THIS load. Returns the record or null.
export function consumeLastCrash() {
  try {
    const v = localStorage.getItem(LOG_KEY);
    if (!v) return null;
    localStorage.removeItem(LOG_KEY);
    return JSON.parse(v);
  } catch {
    return null;
  }
}

let _installed = false;
// Install global JS error/rejection logging. Call as early as possible so an error
// during startup is still captured. These only WRITE to storage (no console noise).
export function installCrashGuard() {
  if (_installed) return;
  _installed = true;
  window.addEventListener("error", (e) => {
    record("error", `${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno || ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    record("rejection", (r && (r.stack || r.message)) || r);
  });
}

// Watch the live renderer for a GPU loss. Call once the renderer is initialised.
// On WebGPU device loss we record it and reload into the WebGL2 fallback (once),
// turning a recurring hard crash into a one-time graceful downgrade.
export function watchGpu(renderer) {
  try {
    const canvas = renderer && renderer.domElement;
    canvas &&
      canvas.addEventListener &&
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault(); // tell the browser we'll handle it (don't hard-fail)
        record("webglcontextlost", "WebGL2 context lost");
        // We're already on the fallback backend; just record. A reload would loop.
      });

    const onWebGPU = !!(renderer && renderer.backend && renderer.backend.isWebGPUBackend);
    const device = renderer && renderer.backend && renderer.backend.device;
    if (onWebGPU && device && device.lost && typeof device.lost.then === "function") {
      device.lost.then((info) => {
        // `reason === "destroyed"` is a normal teardown, not a crash — ignore it.
        if (info && info.reason === "destroyed") return;
        record("webgpu-devicelost", (info && info.message) || "WebGPU device lost");
        fallbackToWebGL();
      }).catch(() => {});
    }
  } catch {
    /* never let the guard itself throw */
  }
}

// A fatal-but-silent failure the loss watcher can't see: the render loop
// throwing on EVERY frame (frozen picture, audio keeps humming — WebAudio runs
// on its own thread). Record it and reload into the WebGL2 fallback, turning a
// permanent freeze into a one-time recovery. sessionStorage-stamped so a fault
// that survives the reload can't put the tab in a reload loop.
const RELOAD_STAMP = "zoomies-autoreload";
export function reportFatal(type, detail) {
  record(type, detail);
  let recent = 0;
  try { recent = +sessionStorage.getItem(RELOAD_STAMP) || 0; } catch { /* ignore */ }
  if (Date.now() - recent < 120000) return false; // just auto-reloaded — don't loop
  try { sessionStorage.setItem(RELOAD_STAMP, String(Date.now())); } catch { /* ignore */ }
  fallbackToWebGL(true);
  return true;
}

// Permanently prefer WebGL2 and reload. Guarded so we can't loop: if the flag is
// already set (we've fallen back before), we don't reload again — unless `force`
// (reportFatal's freeze recovery, which has its own reload-loop stamp above).
function fallbackToWebGL(force = false) {
  let already = false;
  try {
    already = localStorage.getItem(PREFER_WEBGL) === "1";
    if (!already) localStorage.setItem(PREFER_WEBGL, "1");
  } catch {
    /* ignore */
  }
  if (already && !force) return; // already on the fallback — don't reload into a loop
  try {
    const u = new URL(location.href);
    u.searchParams.set("webgl", "1");
    location.replace(u.toString());
  } catch {
    location.reload();
  }
}
