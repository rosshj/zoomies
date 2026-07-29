// Minimal, explicit bridge. The game runs unmodified in browsers, so this
// only exposes what web code genuinely cannot do for itself in a desktop
// shell. The game treats every field as optional (feature-detect, never
// assume) so the same bundle keeps working on the web and in Capacitor.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zoomiesDesktop", {
  quit: () => ipcRenderer.send("zoomies:quit"),
});
