const KEY = "zoomies-track-images-v1";
export const trackImageKey = (cfg) =>
  cfg.mode !== "custom"
    ? "classic"
    : JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))));
export function cachedTrackImage(cfg) {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "{}")[trackImageKey(cfg)] || null;
  } catch {
    return null;
  }
}
export function cacheTrackImage(cfg, canvas) {
  try {
    const images = JSON.parse(sessionStorage.getItem(KEY) || "{}");
    const key = trackImageKey(cfg);
    delete images[key];
    images[key] = canvas.toDataURL("image/jpeg", 0.8);
    sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(images).slice(-8))));
  } catch {
    /* Storage limits must not prevent track selection. */
  }
}
