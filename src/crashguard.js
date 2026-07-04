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

// Permanently prefer WebGL2 and reload. Guarded so we can't loop: if the flag is
// already set (we've fallen back before), we don't reload again.
function fallbackToWebGL() {
  let already = false;
  try {
    already = localStorage.getItem(PREFER_WEBGL) === "1";
    if (!already) localStorage.setItem(PREFER_WEBGL, "1");
  } catch {
    /* ignore */
  }
  if (already) return; // already on the fallback — don't reload into a loop
  // Tag the reload so the boot-cause log (main.js) can attribute it — an
  // untagged reload in a device log points at something external (e.g. iOS
  // killing the web process), not us.
  try { sessionStorage.setItem("zoomies-reload-cause", "gpu-crash-fallback"); } catch { /* ignore */ }
  try {
    const u = new URL(location.href);
    u.searchParams.set("webgl", "1");
    location.replace(u.toString());
  } catch {
    location.reload();
  }
}
