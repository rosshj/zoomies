// Compact studio summaries reuse the existing draft controls inside drill-ins.
export function mountStudio({ which, fields, apply, getDraft }) {
  const root = document.getElementById(`flow-${which}-edit`);
  root.classList.add("studio-screen");
  const card = root.querySelector(".racer-card");
  const creator = card.querySelector(".creator");
  const heading = root.querySelector(".flow-h");
  const title = which === "cat" ? "Cat studio" : "Kart studio";
  const overview = document.createElement("div");
  overview.className = "studio-overview";
  creator.before(overview);
  const done = document.createElement("button");
  done.className = "btn-cream studio-detail-done";
  done.textContent = "Back to studio";
  const footer = root.querySelector(".racer-preview-footer");
  const summary = document.getElementById(`${which}-studio-summary`);
  const randomize = document.getElementById(`${which}-randomize`);
  let active = null;
  const close = (focus = true) => {
    if (!active) return false;
    const previous = active;
    active = null;
    root.removeAttribute("data-studio-detail");
    randomize.disabled = false;
    fields.find((field) => field.key === "name").button.disabled = false;
    heading.textContent = title;
    for (const field of fields) field.row.classList.remove("studio-field-active");
    if (focus) previous.button.focus({ preventScroll: true });
    return true;
  };
  done.addEventListener("click", () => {
    document.getElementById(`${which}-name-close`)?.click();
    close();
  });
  for (const field of fields) {
    field.row = document.getElementById(field.control).closest(".creator-row");
    const button = document.createElement("button");
    button.className = "studio-summary";
    button.dataset.studioField = field.key;
    const label = document.createElement("small");
    label.textContent = field.label;
    const value = document.createElement("strong");
    button.append(label, value);
    field.button = button;
    field.value = value;
    if (field.key === "name") {
      button.className = "studio-name-edit";
      button.setAttribute("aria-label", `Edit ${which} name`);
      summary.replaceWith(button);
      button.replaceChildren(summary);
      footer.append(randomize);
    } else overview.append(button);
    if (field.options) {
      field.row.querySelector(".mini-stepper").classList.add("studio-legacy-stepper");
      const grid = document.createElement("div");
      grid.className = "studio-option-grid";
      field.row.append(grid);
      field.options.forEach((option) => {
        const choice = document.createElement("button");
        choice.className = "studio-option";
        choice.textContent = option.label;
        choice.dataset.value = String(option.value);
        choice.addEventListener("click", () => {
          apply(field.patch ? field.patch(option.value) : { [field.key]: option.value });
          close();
        });
        grid.append(choice);
      });
      field.grid = grid;
    }
    field.row.querySelector(".swatch-grid")?.addEventListener("click", (event) => {
      if (event.target.closest(".swatch-dot")) close();
    });
    button.addEventListener("click", () => {
      close(false);
      active = field;
      randomize.disabled = true;
      fields.find((item) => item.key === "name").button.disabled = true;
      root.dataset.studioDetail = field.key;
      heading.textContent = field.label;
      field.row.classList.add("studio-field-active");
      refresh();
      const target = field.row.querySelector(
        '.studio-option[aria-pressed="true"], .swatch-dot.selected, input, .studio-option, .swatch-dot',
      );
      target?.focus({ preventScroll: true });
      scroller.scrollTop = 0;
    });
  }
  // The preview owns naming and randomisation; only choices scroll in drill-ins.
  const scroller = document.createElement("div");
  scroller.className = "studio-scroll";
  const actions = card.querySelector(".racer-actions");
  for (const child of [...card.children]) if (child !== actions) scroller.append(child);
  card.insertBefore(scroller, actions);
  actions.after(done);
  function refresh() {
    const draft = getDraft();
    for (const field of fields) {
      field.button.classList.toggle("hidden", field.available ? !field.available(draft) : false);
      field.value.textContent = field.describe(draft);
      const color = field.color?.(draft);
      field.button.classList.toggle("has-color", !!color);
      if (color) field.button.style.setProperty("--choice-color", color);
      if (field.grid)
        for (const button of field.grid.children) {
          if (field.optionLabel) button.textContent = field.optionLabel(button.dataset.value);
          const selected = button.dataset.value === String(draft[field.key]);
          button.setAttribute("aria-pressed", String(selected));
        }
    }
    const visible = fields.filter((field) => field.key !== "name" && !field.button.classList.contains("hidden"));
    for (const field of fields)
      field.button.classList.toggle("studio-summary-wide", visible.length % 2 === 1 && field === visible.at(-1));
  }
  return { refresh, close };
}
