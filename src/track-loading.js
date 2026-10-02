const KEY = "zoomies-loading-track";
// The same message is shown immediately and read by the next document before
// loading the renderer. No invented percentage for work we cannot measure.
export function showTrackLoading(name = "Your track") {
  try {
    sessionStorage.setItem(KEY, name);
  } catch {}
  let overlay = document.getElementById("loading");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "loading";
    const title = document.createElement("p");
    title.className = "ls-title";
    title.textContent = "ZOOMIES GP";
    const label = document.createElement("p");
    label.className = "ls-status";
    const note = document.createElement("p");
    note.className = "ls-detail";
    note.textContent = "Building the track and preparing scenery…";
    const ring = document.createElement("div");
    ring.className = "ls-ring";
    ring.setAttribute("aria-hidden", "true");
    overlay.append(title, label, note, ring);
    document.body.append(overlay);
  }
  overlay.classList.remove("done");
  overlay.setAttribute("role", "status");
  const label = overlay.querySelector(".ls-status");
  if (label) label.textContent = `Loading ${name}`;
}
