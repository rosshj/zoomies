export function mountTrackBuilder(root, getDraft) {
  const body = root.querySelector(".flow-body");
  const preview = root.querySelector(".track-col-map");
  const actions = root.querySelector(".track-actions");
  const title = root.querySelector(".flow-h");
  const overview = document.createElement("div");
  overview.className = "studio-overview";
  const scroll = document.createElement("div");
  scroll.className = "builder-scroll";
  const side = document.createElement("div");
  side.className = "builder-side";
  const done = document.createElement("button");
  done.className = "btn-cream builder-done hidden";
  done.textContent = "Back to builder";
  const fields = [
    ["biomes", "Environment", "track-biomes", (d) => d.biomes.join(", ")],
    ["style", "Style", "track-style", () => root.querySelector("#track-style .on")?.textContent || "Custom"],
    ["size", "Size", "track-sizeseg", () => root.querySelector("#track-sizeseg .on")?.textContent || "Custom"],
    ["time", "Time of day", "track-tod", (d) => d.timeOfDay || "midday"],
    ["details", "Fine-tune", "track-finetune", () => "Shape and set pieces"],
  ];
  let active;
  function close() {
    if (!active) return false;
    for (const f of fields) f.control.classList.add("hidden");
    overview.classList.remove("hidden");
    done.classList.add("hidden");
    actions.classList.remove("hidden");
    scroll.classList.remove("builder-detail");
    title.textContent = "Track Builder";
    active.focus({ preventScroll: true });
    active = null;
    return true;
  }
  for (const field of fields) {
    const [key, label, id] = field;
    field.control = document.getElementById(id);
    const wrap = document.createElement("div");
    wrap.className = "builder-field hidden";
    if (key === "biomes") wrap.append(document.getElementById("biome-max-hint"));
    field.control.classList.remove("hidden");
    wrap.append(field.control);
    field.control = wrap;
    if (["style", "size", "time"].includes(key))
      wrap.addEventListener("click", (event) => {
        if (event.target.closest(".biome-chip")) close();
      });
    const button = document.createElement("button");
    button.className = "studio-summary";
    button.dataset.builderField = key;
    const heading = document.createElement("small");
    heading.textContent = label;
    field.value = document.createElement("strong");
    button.append(heading, field.value);
    button.addEventListener("click", () => {
      active = button;
      overview.classList.add("hidden");
      actions.classList.add("hidden");
      wrap.classList.remove("hidden");
      done.classList.remove("hidden");
      scroll.classList.add("builder-detail");
      title.textContent = label;
      scroll.scrollTop = 0;
    });
    overview.append(button);
    scroll.append(wrap);
  }
  scroll.prepend(overview);
  side.append(scroll, actions, done);
  body.replaceChildren(preview, side);
  body.classList.add("builder-layout");
  done.addEventListener("click", close);
  return {
    close,
    refresh() {
      for (const f of fields) f.value.textContent = f[3](getDraft());
    },
  };
}
