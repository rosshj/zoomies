// Minimal, explicit bridge. The game runs unmodified in browsers, so this
// only adds what web code genuinely cannot do for itself in a desktop shell.
// The game treats every field as optional (feature-detect, never assume) so
// the same bundle keeps working on the web and in Capacitor.
const { contextBridge, ipcRenderer } = require("electron");

// --- Steam Cloud save bridge ------------------------------------------------
// The game saves through localStorage (zoomies-* keys), which works in the
// shell too (app:// is a stable origin) — but Steam Cloud syncs FILES. So the
// preload mirrors the PROFILE keys into userData/zoomies-save.json via the
// main process, and hydrates them back at boot when the file is newer.
//
// Allowlist, not "every zoomies-* key": a cloud save follows the PLAYER, so
// it carries what the player earned and chose — profile, garage, custom
// track, time-trial bests + ghost, sound, lap count, difficulty, mode, cup.
// Per-DEVICE state (quality tier, WebGL preference, fps overlay, dev flags,
// crash log, rumble, split-screen seat picks, track view, …) stays local:
// syncing it would drag a Deck's low quality tier onto a desktop GPU, or a
// crash-recovery flag onto a machine that never crashed. Add a key here only
// if it should follow the player to another machine.
const SYNC_KEYS = [
  "zoomies-profile-v1",
  "zoomies-garage-v1",
  "zoomies-track-v1",
  "zoomies-timetrial-v2",
  "zoomies-ttghost-v2",
  "zoomies-audio-v2",
  "zoomies-laps",
  "zoomies-difficulty",
  "zoomies-mode-v1",
  "zoomies-cup-choice",
];

// Newer side wins, decided by a MONOTONIC COUNTER, not the wall clock: each
// write stamps max(file stamp, local stamp) + 1, so a machine with a skewed
// clock can't produce a "future" save that wins over every real one forever.
// The stamp lives in the file AND alongside the keys in localStorage, so a
// cloud-synced file from another machine hydrates an older local profile —
// never the reverse.
const STAMP_KEY = "zoomies-savefile-stamp";
// Only the game page carries a profile — the inline crash page (a data: URL,
// see main.cjs) has an opaque origin with no localStorage to mirror.
const onGamePage = location.protocol === "app:";

let _stamp = 0; // highest stamp seen on either side; the next write is +1
let _lastJson = null; // what the file holds (or would after the last write)
let _fileHasData = false;

function collect() {
  const data = {};
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (typeof v === "string") data[k] = v;
  }
  return data;
}

if (onGamePage) {
  try {
    const file = ipcRenderer.sendSync("zoomies:load-save"); // {stamp, data} | null
    const local = Number(localStorage.getItem(STAMP_KEY) || 0) || 0;
    const fileStamp = Number(file?.stamp || 0) || 0;
    _stamp = Math.max(local, fileStamp);
    if (file && file.data && typeof file.data === "object") {
      _fileHasData = true;
      if (fileStamp > local) {
        for (const k of SYNC_KEYS) {
          const v = file.data[k];
          if (typeof v === "string") localStorage.setItem(k, v);
        }
        localStorage.setItem(STAMP_KEY, String(fileStamp));
      }
    }
    // Baseline for change detection: what would be written right now. When
    // the file already matches (the usual boot), the first tick writes
    // nothing — a save that hasn't changed doesn't earn a new stamp.
    _lastJson = JSON.stringify(collect());
  } catch (err) {
    console.warn("[save-bridge] hydrate failed:", err);
  }
}

function sync(final) {
  if (!onGamePage) return;
  try {
    const data = collect();
    const json = JSON.stringify(data);
    // Write when the content changed, or when there is no file yet at all
    // (first launch: give Steam Cloud something to sync even before the
    // player has earned anything).
    if (json === _lastJson && _fileHasData) return;
    _lastJson = json;
    _fileHasData = true;
    _stamp += 1;
    localStorage.setItem(STAMP_KEY, String(_stamp));
    const payload = { stamp: _stamp, data };
    // The closing flush blocks the renderer until the file is on disk —
    // that's the point: quit must not race the last write.
    if (final) ipcRenderer.sendSync("zoomies:save-flush", payload);
    else ipcRenderer.send("zoomies:save", payload);
  } catch { /* best-effort */ }
}
if (onGamePage) {
  sync(false); // seeds the file on a first launch; a no-op when it matches
  setInterval(() => sync(false), 30000);
  window.addEventListener("pagehide", () => sync(true));
}

// --- Focus / fullscreen / Deck ---------------------------------------------
// The main process pushes blur/focus; they surface both as window events
// (`zoomies:blur` / `zoomies:focus`) and as onBlur/onFocus subscriptions, so
// the game can pause when the player alt-tabs away.
const listeners = { blur: new Set(), focus: new Set() };
for (const kind of ["blur", "focus"]) {
  ipcRenderer.on(`zoomies:${kind}`, () => {
    window.dispatchEvent(new Event(`zoomies:${kind}`));
    for (const cb of listeners[kind]) { try { cb(); } catch (err) { console.warn(`[bridge] on${kind} listener failed:`, err); } }
  });
}
const subscribe = (kind) => (cb) => {
  if (typeof cb !== "function") return () => {};
  listeners[kind].add(cb);
  return () => listeners[kind].delete(cb);
};

let deck = false;
try { deck = !!ipcRenderer.sendSync("zoomies:deck"); } catch { /* default: not a Deck */ }

contextBridge.exposeInMainWorld("zoomiesDesktop", {
  quit: () => ipcRenderer.send("zoomies:quit"),
  deck,
  isFullscreen: () => { try { return !!ipcRenderer.sendSync("zoomies:is-fullscreen"); } catch { return false; } },
  setFullscreen: (on) => ipcRenderer.send("zoomies:set-fullscreen", !!on),
  onBlur: subscribe("blur"),
  onFocus: subscribe("focus"),
});
