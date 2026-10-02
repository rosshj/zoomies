// Keep game-owned controls and listeners; change only how choices are presented.
export function mountDisplaySettings(root) {
  const section = root.querySelector("#quality-toggle").closest(".settings-card");
  const nav = root.querySelector(".settings-nav");
  const heading = root.querySelector(".flow-h");
  const overview = document.createElement("div");
  overview.className = "display-overview summary-grid";
  const done = document.createElement("button");
  done.className = "btn-cream";
  done.textContent = "Back to Display";
  const footer = document.createElement("footer");
  footer.className = "menu-fixed-actions hidden";
  footer.append(done);
  root.append(footer);
  let active = null;
  const fields = [
    ["graphics", "Graphics", "quality-toggle", "quality-note"],
    ["frame-rate", "Frame rate", "set-fps-cap-seg", "fps-cap-note"],
    ["battery", "Battery saver", "set-saver-toggle", "saver-note"],
    ["versus", "Versus effects", "set-splitfx-toggle", "splitfx-note"],
    ["compatibility", "Compatibility mode", "set-compat-toggle", "compat-note"],
  ].map(([key, label, id, noteId]) => {
    const control = document.getElementById(id);
    const row = control.closest(".setting-row");
    const note = document.getElementById(noteId);
    const detail = document.createElement("div");
    detail.className = "display-detail hidden";
    detail.append(row, note);
    const button = document.createElement("button");
    button.className = "summary-choice";
    button.dataset.displayField = key;
    const small = document.createElement("small");
    small.textContent = label;
    const value = document.createElement("strong");
    button.append(small, value);
    const refresh = () => {
      value.textContent = control.querySelector(".is-active")?.textContent || control.textContent;
      button.classList.toggle("hidden", row.classList.contains("hidden"));
    };
    new MutationObserver(refresh).observe(control, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    new MutationObserver(refresh).observe(row, { attributes: true, attributeFilter: ["class"] });
    button.addEventListener("click", () => {
      active = { button, detail };
      overview.classList.add("hidden");
      nav.classList.add("hidden");
      detail.classList.remove("hidden");
      footer.classList.remove("hidden");
      root.dataset.displayDetail = key;
      heading.textContent = label;
      root.querySelector(".flow-body").scrollTop = 0;
      (control.querySelector(".is-active") || control.querySelector("button") || control).focus({
        preventScroll: true,
      });
    });
    refresh();
    overview.append(button);
    return detail;
  });
  section.replaceChildren(overview, ...fields);
  function close() {
    if (!active) return false;
    active.detail.classList.add("hidden");
    overview.classList.remove("hidden");
    nav.classList.remove("hidden");
    footer.classList.add("hidden");
    delete root.dataset.displayDetail;
    heading.textContent = "Settings";
    active.button.focus({ preventScroll: true });
    active = null;
    return true;
  }
  done.addEventListener("click", close);
  root.querySelector("#settings-back").addEventListener(
    "click",
    (event) => {
      if (close()) event.stopImmediatePropagation();
    },
    true,
  );
  root.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && close()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  new MutationObserver(() => {
    if (root.classList.contains("hidden")) close();
  }).observe(root, { attributes: true, attributeFilter: ["class"] });
}
