// Minimal, explicit bridge. The game runs unmodified in browsers, so this
// only adds what web code genuinely cannot do for itself in a desktop shell.
// The game treats every field as optional (feature-detect, never assume) so
// the same bundle keeps working on the web and in Capacitor.
const { contextBridge, ipcRenderer } = require("electron");

// --- Steam Cloud save bridge ------------------------------------------------
// The game saves through localStorage (zoomies-* keys), which works in the
// shell too (app:// is a stable origin) — but Steam Cloud syncs FILES. So the
// preload mirrors those keys into userData/zoomies-save.json via the main
// process. Newer side wins: every write bumps a stamp stored in the file AND
// alongside the keys, so a cloud-synced file from another machine hydrates an
// older local profile — never the reverse.
const STAMP_KEY = "zoomies-savefile-stamp";
try {
  const file = ipcRenderer.sendSync("zoomies:load-save"); // {stamp, data} | null
  if (file && file.data) {
    const local = Number(localStorage.getItem(STAMP_KEY) || 0);
    if (Number(file.stamp || 0) > local) {
      for (const [k, v] of Object.entries(file.data)) {
        if (k.startsWith("zoomies-") && typeof v === "string") localStorage.setItem(k, v);
      }
      localStorage.setItem(STAMP_KEY, String(file.stamp));
    }
  }
} catch (err) {
  console.warn("[save-bridge] hydrate failed:", err);
}

function collect() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("zoomies-") && k !== STAMP_KEY) data[k] = localStorage.getItem(k);
  }
  return data;
}
let _lastJson = "";
function sync(final) {
  try {
    const data = collect();
    const json = JSON.stringify(data);
    if (json === _lastJson) return;
    _lastJson = json;
    const stamp = Date.now();
    localStorage.setItem(STAMP_KEY, String(stamp));
    // The closing flush blocks the renderer until the file is on disk —
    // that's the point: quit must not race the last write.
    if (final) ipcRenderer.sendSync("zoomies:save-flush", { stamp, data });
    else ipcRenderer.send("zoomies:save", { stamp, data });
  } catch { /* best-effort */ }
}
setInterval(() => sync(false), 5000);
window.addEventListener("pagehide", () => sync(true));

contextBridge.exposeInMainWorld("zoomiesDesktop", {
  quit: () => ipcRenderer.send("zoomies:quit"),
});
