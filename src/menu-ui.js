import { installMenuIcons } from "./menu-icons.js";
// Shared DOM behavior for menu surfaces. Game state stays in main.js.
export function initMenuUI() {
  installTextEntry();
  installMenuIcons();
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) document.documentElement.classList.add("keyboard-navigation");
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => document.documentElement.classList.remove("keyboard-navigation"),
    true,
  );
  document.getElementById("track-apply").textContent = "Use this track";
  const catalogTabs = document.querySelector(".catalog-tabs");
  catalogTabs.classList.add("settings-nav");
  document.querySelector("#catalog .flow-body").prepend(catalogTabs);
  for (const screen of document.querySelectorAll("#flow-cat, #flow-kart")) {
    screen.querySelector(".flow-body").prepend(screen.querySelector(".picker-toolbar"));
  }
  const settings = document.getElementById("settings");
  for (const row of settings.querySelectorAll(".setting-row")) {
    row.classList.toggle("setting-row-segmented", !!row.querySelector(".seg-toggle"));
    row.classList.toggle("setting-row-audio", !!row.querySelector('input[type="range"]'));
  }
  const sections = [...settings.querySelectorAll(".settings-list > .settings-card")];
  const groups = ["audio", "display", "controls", "save", "display"];
  sections.forEach((section, i) => (section.dataset.settingsPanel = groups[i]));
  const nav = document.createElement("nav");
  nav.className = "settings-nav seg-toggle";
  nav.setAttribute("aria-label", "Settings categories");
  const names = { audio: "Audio", controls: "Controls", display: "Display", save: "Save data" };
  let category = "audio";
  try {
    const saved = localStorage.getItem("zoomies-settings-category");
    if (names[saved]) category = saved;
  } catch {}
  const select = (key) => {
    category = key;
    for (const section of sections) section.classList.toggle("hidden", section.dataset.settingsPanel !== key);
    for (const button of nav.children) {
      button.classList.toggle("is-active", button.dataset.category === key);
      button.setAttribute("aria-pressed", String(button.dataset.category === key));
    }
    settings.querySelector(".flow-body").scrollTop = 0;
    try {
      localStorage.setItem("zoomies-settings-category", key);
    } catch {}
  };
  for (const [key, label] of Object.entries(names)) {
    const button = document.createElement("button");
    button.className = "seg-btn";
    button.textContent = label;
    button.dataset.category = key;
    button.addEventListener("click", () => select(key));
    nav.append(button);
  }
  settings.querySelector(".flow-body").prepend(nav);
  select(category);

  // Focus is scoped to the currently visible sheet or flow. Keep each surface's
  // last control so closing a picker restores the control that opened it.
  const roots = [...document.querySelectorAll(".overlay"), document.getElementById("menu")];
  const memories = new WeakMap();
  let active = null;
  const visible = (el) => !el.classList.contains("hidden");
  const scope = () =>
    [...document.querySelectorAll(".overlay")].filter(visible).at(-1) ||
    (visible(document.getElementById("menu")) ? document.querySelector(".flow-screen.is-active") : null);
  const controls = (surface) =>
    [...surface.querySelectorAll('button, input, textarea, a[href], [tabindex="0"]')].filter(
      (el) =>
        !el.disabled &&
        !el.closest("[inert]") &&
        el.getBoundingClientRect().width > 0 &&
        getComputedStyle(el).visibility === "visible",
    );
  const sync = () => {
    const next = scope();
    // Keep global actions in the same layout row as Back and the title. Floating
    // chrome applied the safe-area inset twice and collided with picker tools.
    const flow = document.querySelector(".flow-screen.is-active");
    const slot = flow?.querySelector(".flow-head-right");
    const chrome = document.getElementById("menu-chrome");
    if (slot && chrome.parentElement !== slot) slot.append(chrome);
    document.getElementById("menu-chrome").inert = !!next && !next.classList.contains("flow-screen");
    for (const root of roots) root.inert = !!next && root !== next && !root.contains(next);
    for (const screen of document.querySelectorAll(".flow-screen"))
      screen.inert = !screen.classList.contains("is-active");
    if (next === active) return;
    active = next;
    if (!next) {
      document.activeElement?.blur();
      return;
    }
    const remembered = memories.get(next);
    const candidates = controls(next);
    const target =
      candidates.find((el) => next.id === "menu-confirm" && el.id === "confirm-cancel") ||
      candidates.find((el) => next.id === "racer-details" && el.id === "racer-details-close") ||
      candidates.find((el) => el.id === "resume-race-btn" && el.classList.contains("btn-gold")) ||
      (candidates.includes(remembered) ? remembered : null) ||
      candidates.find((el) => el.matches(".btn-gold,.is-current")) ||
      candidates.find((el) => !el.matches(".flow-back,[data-back]")) ||
      candidates[0];
    target?.focus({ preventScroll: true });
  };
  document.addEventListener("focusin", (e) => {
    const surface = scope();
    if (surface?.contains(e.target)) memories.set(surface, e.target);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const current = scope();
    if (!current) return;
    const list = controls(current);
    // Global menu chrome belongs to the active flow screen.
    if (
      current.classList.contains("flow-screen") &&
      !current.contains(document.getElementById("menu-chrome")) &&
      visible(document.getElementById("menu-chrome"))
    )
      list.push(...controls(document.getElementById("menu-chrome")));
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length;
    e.preventDefault();
    list[next].focus({ preventScroll: true });
    // Only scroll the nearest menu content region, never the transformed stage.
    const scroller = list[next].closest(".flow-body,.start-scroll,.results-scroll");
    if (scroller) {
      const region = scroller.getBoundingClientRect(),
        target = list[next].getBoundingClientRect();
      if (target.top < region.top + 8) scroller.scrollTop += target.top - region.top - 8;
      else if (target.bottom > region.bottom - 8) scroller.scrollTop += target.bottom - region.bottom + 8;
    }
  });
  for (const overlay of document.querySelectorAll(".overlay")) {
    if (!overlay.hasAttribute("role")) overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const title = overlay.querySelector("h1,h2");
    if (title) {
      if (!title.id) title.id = overlay.id + "-title";
      overlay.setAttribute("aria-labelledby", title.id);
    }
  }
  const observer = new MutationObserver(sync);
  for (const root of roots) observer.observe(root, { attributes: true, attributeFilter: ["class", "data-step"] });
  sync();

  // Existing game handlers own selected values. Expose their state consistently.
  const selectedObserver = new MutationObserver((records) => {
    for (const { target } of records) {
      if (target.matches("button.seg-btn"))
        target.setAttribute("aria-pressed", String(target.classList.contains("is-active")));
      if (target.matches("button.toggle"))
        target.setAttribute("aria-pressed", String(!target.classList.contains("off")));
    }
  });
  for (const button of document.querySelectorAll("button.seg-btn,button.toggle")) {
    button.setAttribute(
      "aria-pressed",
      String(
        button.classList.contains("seg-btn")
          ? button.classList.contains("is-active")
          : !button.classList.contains("off"),
      ),
    );
    selectedObserver.observe(button, { attributes: true, attributeFilter: ["class"] });
  }
}

// A controller can edit names, seeds and backup codes without a hardware keyboard.
// Physical typing and paste still work; the virtual keys only edit a local draft.
function installTextEntry() {
  const overlay = document.createElement("div");
  overlay.id = "menu-keyboard";
  overlay.className = "overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "keyboard-title");
  overlay.innerHTML = `<div class="menu-card keyboard-card"><h1 id="keyboard-title">Enter text</h1><input id="keyboard-draft" aria-label="Text" data-no-virtual autocomplete="off" spellcheck="false"><div class="keyboard-keys"></div><div class="keyboard-actions"><button id="keyboard-case" class="btn-cream">a ⇄ A</button><button id="keyboard-space" class="btn-cream">Space</button><button id="keyboard-delete" class="btn-cream">⌫ Delete</button></div><div class="keyboard-actions"><button id="keyboard-cancel" class="btn-cream">Cancel</button><button id="keyboard-done" class="btn-gold">Done</button></div></div>`;
  document.getElementById("stage").append(overlay);
  const draft = overlay.querySelector("#keyboard-draft");
  const keys = overlay.querySelector(".keyboard-keys");
  let input = null,
    upper = true;
  const insert = (text) => {
    const start = draft.selectionStart ?? draft.value.length,
      end = draft.selectionEnd ?? start;
    if (draft.maxLength >= 0 && draft.value.length - (end - start) + text.length > draft.maxLength) return;
    draft.setRangeText(text, start, end, "end");
  };
  const render = () => {
    keys.replaceChildren();
    for (const char of "1234567890QWERTYUIOPASDFGHJKLZXCVBNM.-_+/=") {
      const button = document.createElement("button");
      button.className = "btn-cream";
      button.textContent = upper ? char : char.toLowerCase();
      button.addEventListener("click", () => insert(button.textContent));
      keys.append(button);
    }
  };
  const close = () => {
    overlay.classList.add("hidden");
    input?.focus({ preventScroll: true });
  };
  overlay.querySelector("#keyboard-case").addEventListener("click", () => {
    upper = !upper;
    render();
  });
  overlay.querySelector("#keyboard-space").addEventListener("click", () => insert(" "));
  overlay.querySelector("#keyboard-delete").addEventListener("click", () => {
    const start = draft.selectionStart ?? draft.value.length,
      end = draft.selectionEnd ?? start;
    draft.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
  });
  overlay.querySelector("#keyboard-cancel").addEventListener("click", close);
  overlay.querySelector("#keyboard-done").addEventListener("click", () => {
    input.value = draft.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  });
  window.addEventListener("zoomies:text-entry", ({ detail }) => {
    input = detail.input;
    draft.value = input.value;
    if (input.maxLength >= 0) draft.maxLength = input.maxLength;
    else draft.removeAttribute("maxlength");
    draft.setSelectionRange(draft.value.length, draft.value.length);
    document.getElementById("keyboard-title").textContent =
      input.getAttribute("aria-label") || input.placeholder || "Enter text";
    render();
    overlay.classList.remove("hidden");
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!overlay.classList.contains("hidden") && (e.code === "Escape" || e.code === "KeyP")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    },
    true,
  );
}
