// Original, filled 24px menu pictograms. No platform emoji or external icon font.
const paths = {
  back: "M22 10H9l5-5-3-3L1 12l10 10 3-3-5-5h13z",
  up: "M10 22V9l-5 5-3-3L12 1l10 10-3 3-5-5v13z",
  menu: "M2 4h20v3H2zm0 7h20v3H2zm0 7h20v3H2z",

  pause: "M5 3h5v18H5zm9 0h5v18h-5z",
  cat: "M3 3 9 7h6l6-4v13c0 9-18 9-18 0zm4 9v3h3v-3zm7 0v3h3v-3zm-4 5 2 3 2-3z",
  kart: "M5 7 8 2h8l3 5h3v11h-3v4h-4v-4H9v4H5v-4H2V7zm3 0h8l-2-3h-4zm-3 5v3h4v-3zm10 0v3h4v-3z",
  keyboard:
    "M1 5h22v15H1zm3 3v2h2V8zm4 0v2h2V8zm4 0v2h2V8zm4 0v2h4V8zM4 12v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm4 0v2h4v-2zM6 16v2h12v-2z",
  screen: "M1 2h22v16h-9v3h5v2H5v-2h5v-3H1zm3 3v10h16V5z",
  save: "M2 2h16l4 4v16H2zm4 0v8h12V2zm1 12v6h10v-6z",
  copy: "M3 2h13v3H6v14H3zm5 5h13v16H8z",
  random: "M3 3h18v18H3zm3 3v3h3V6zm9 0v3h3V6zm-5 4v4h4v-4zm-4 5v3h3v-3zm9 0v3h3v-3z",
  world: "M17 1a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM1 21 9 7l5 8 3-4 6 10z",
  calendar: "M5 1h3v3h8V1h3v3h3v18H2V4h3zm0 9v9h14v-9z",
  camera: "M8 3h8l2 3h5v15H1V6h5zm4 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  tool: "M14 1v6h6V1c6 4 4 12-3 13L7 24l-7-7L10 7c-1-3 1-5 4-6z",
  shield: "M12 1 22 5v7c0 6-5 10-10 12C7 22 2 18 2 12V5zm0 5v13c4-2 6-5 6-8V8z",
  heart: "M12 22 2 12C-5 3 7-2 12 5 17-2 29 3 22 12z",
  bolt: "M13 0 2 14h8l-1 10 13-15h-9z",
  warning: "M12 1 24 22H0zm-1 7v7h2V8zm0 9v2h2v-2z",

  race: "M4 3h2v18H4z M7 4h13v10H7z M7 4v3h3V4zm6 0v3h3V4zm-3 3v3h3V7zm6 0v3h4V7zm-9 3v4h3v-4zm6 0v4h3v-4z",
  play: "M7 4a1 1 0 0 1 1.5-.9l12 8a1 1 0 0 1 0 1.8l-12 8A1 1 0 0 1 7 20z",
  garage: "M2 10 12 3l10 7v11h-5v-8H7v8H2z M9 15h6v2H9zm0 4h6v2H9z",
  collection: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z",
  settings: "m9 2-1 3-3 1-3 3v6l3 3 3 1 1 3h6l1-3 3-1 3-3V9l-3-3-3-1-1-3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
  help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4c5 0 5 5 2 7l-1 1h-2v-2l2-2c1-2-2-3-3-1H8c0-2 2-3 4-3zm-1 10h2v2h-2z",
  download: "M10 2h4v10l4-4 3 3-9 9-9-9 3-3 4 4zM3 21h18v2H3z",
  quit: "M10 1h4v12h-4zM6 5l2 3a6 6 0 1 0 8 0l2-3a10 10 0 1 1-12 0z",
  fish: "M2 7v10l5-3c5 7 13 2 15-2-2-4-10-9-15-2zm15 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  trophy:
    "M7 2h10v3h5v4c0 4-3 6-6 6l-2 2v3h4v3H6v-3h4v-3l-2-2c-3 0-6-2-6-6V5h5zm-3 5v2c0 2 1 3 3 3V7zm13 0v5c2 0 3-1 3-3V7z",
  pad: "M7 5h10c4 0 7 13 4 15-2 1-5-3-6-4H9c-1 1-4 5-6 4C0 18 3 5 7 5zm0 3v2H5v2h2v2h2v-2h2v-2H9V8zm10 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm3 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  sound: "M2 9h5l6-5v16l-6-5H2zm14-3c5 3 5 9 0 12v-3c2-2 2-4 0-6z",
  check: "m2 12 4-4 4 4L20 2l4 4-14 14z",
  lock: "M6 10V7a6 6 0 0 1 12 0v3h3v12H3V10zm3 0h6V7a3 3 0 0 0-6 0zm2 5v4h2v-4z",
  spark: "m12 1 3 8 8 3-8 3-3 8-3-8-8-3 8-3z",
  track:
    "M7 2h10a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H7a6 6 0 0 1-6-6V8a6 6 0 0 1 6-6zm0 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z",
  time: "M9 1h6v3H9zm3 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-1 3h2v5l4 3-2 2-4-4z",
  arrow: "M2 10h13l-5-5 3-3 10 10-10 10-3-3 5-5H2z",
  // A one-litre jug: cap, short neck, shoulders, squared body (the HUD's milk
  // button paints the same silhouette in two tones — see index.html).
  milk: "M9 1h6a1 1 0 0 1 1 1v1.5h-1.5V6l4 3v11a2 2 0 0 1-2 2H7.5a2 2 0 0 1-2-2V9l4-3V3.5H8V2a1 1 0 0 1 1-1z",
  paw: "M12 12c-3.5 0-6.5 2.6-6.5 5.6 0 2 1.8 3.4 6.5 3.4s6.5-1.4 6.5-3.4C18.5 14.6 15.5 12 12 12zM3.5 9a2 2.6 0 1 0 4 0a2 2.6 0 1 0-4 0zm13 0a2 2.6 0 1 0 4 0a2 2.6 0 1 0-4 0zM6.9 4.6a2.1 2.8 0 1 0 4.2 0a2.1 2.8 0 1 0-4.2 0zm6 0a2.1 2.8 0 1 0 4.2 0a2.1 2.8 0 1 0-4.2 0z",
  gauge: "M3 14a9 9 0 0 1 18 0h-3a6 6 0 0 0-12 0zm8.3-.7 4.2-5.6-2 6.6a1.6 1.6 0 1 1-2.2-1zM4 16h16v3H4z",
  leaf: "M21 3C9 3 3 9 3 19c0 1 0 2 1 2 1-8 5-12 11-14C9 10 6 14 5 20c10 1 16-6 16-17z",
  yarn: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM4.6 7.2 14 14.8l-1.2 1.4L3.6 8.8zm2.4-2.8 9.4 7.6-1.2 1.4L5.8 5.8zM15 18c3 .6 5.2 1.4 7 3l-1.4 1.6c-1.6-1.4-3.6-2.2-6.2-2.6z",
  wind: "M2 6h12a3 3 0 1 0-3-3h2a1 1 0 1 1 1 1H2zm0 5h17a3 3 0 1 0-3-3h2a1 1 0 1 1 1 1H2zm0 5h12a3 3 0 1 1-3 3h2a1 1 0 1 0 1-1H2z",
};
export function menuIcon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" ${name === "fish" ? 'role="img" aria-label="Treats"' : 'aria-hidden="true"'} focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${paths[name] || paths.spark}"/></svg>`;
}
const names = {
  "◀": "back",
  "☰": "menu",
  "⬜": "lock",
  "🛋": "pad",
  "⏸": "pause",
  "🐱": "cat",
  "😻": "cat",
  "🐾": "paw",
  "🏎": "kart",
  "⌨": "keyboard",
  "🕹": "pad",
  "🖥": "screen",
  "📱": "screen",
  "💾": "save",
  "📋": "copy",
  "📥": "download",
  "⬆": "up",
  "🎲": "random",
  "📅": "calendar",
  "🎥": "camera",
  "✏": "tool",
  "🛠": "tool",
  "🛡": "shield",
  "❤": "heart",
  "⚡": "bolt",
  "⚠": "warning",
  "🌳": "world",
  "🌲": "world",
  "🏔": "world",
  "🍂": "world",
  "🏜": "world",
  "🪨": "world",
  "🌸": "world",
  "🌴": "world",
  "🦒": "world",
  "❄": "world",
  "🏙": "world",
  "🏖": "world",
  "🪻": "world",
  "🦆": "world",
  "🌋": "world",
  "🍃": "world",
  "🌪": "world",
  "☀": "world",
  "🌇": "world",
  "🌙": "world",
  "🌉": "track",
  "⛰": "world",
  "🚇": "track",
  "🛣": "track",
  "🧗": "world",
  "💧": "world",
  "🌊": "world",
  "🌧": "world",
  "🌿": "leaf",
  "🎖": "trophy",
  "🎁": "collection",
  "↩": "back",

  "🏁": "race",
  "▶": "play",
  "🐟": "fish",
  "🎮": "pad",
  "⚙": "settings",
  "❓": "help",
  "⬇": "download",
  "📲": "download",
  "⏻": "quit",
  "🏆": "trophy",
  "🏅": "trophy",
  "🥇": "trophy",
  "🥈": "trophy",
  "🥉": "trophy",
  "🔒": "lock",
  "🔊": "sound",
  "🔈": "sound",
  "🎵": "sound",
  "🎶": "sound",
  "⏱": "time",
  "⏰": "time",
  "✓": "check",
  "✔": "check",
  "✅": "check",
  "✦": "spark",
  "✨": "spark",
  "⭐": "spark",
  "🌟": "spark",
  "🥛": "milk",
  "🧶": "yarn",
  "💨": "wind",
  "🌀": "wind",
  "🌼": "world",
  "🌆": "world",
  "🚂": "track",
};
const symbols = /(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*|[▶⏻✓✦])/gu;
export function installMenuIcons() {
  // The HUD and the pickup pill take the same pictograms as the menus (the
  // action fan's paw, hop, shield, boost; the power-up pills; the pause
  // button), so the race never shows a platform emoji either.
  const roots = [...document.querySelectorAll("#menu,.overlay,#menu-chrome,#hud,#pickup-toast")];
  const decorate = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walk.nextNode()) {
      const node = walk.currentNode;
      if (!node.parentElement.closest("svg,textarea,input,script,style") && node.data.match(symbols)) texts.push(node);
    }
    for (const text of texts) {
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of text.data.matchAll(symbols)) {
        fragment.append(text.data.slice(last, match.index));
        const holder = document.createElement("span");
        holder.innerHTML = menuIcon(names[match[0].replace(/\uFE0F/g, "")] || "spark");
        fragment.append(holder.firstElementChild);
        last = match.index + match[0].length;
      }
      fragment.append(text.data.slice(last));
      text.replaceWith(fragment);
    }
    for (const button of root.querySelectorAll("[data-menu-icon]")) {
      if (!button.querySelector(".ui-icon")) button.insertAdjacentHTML("afterbegin", menuIcon(button.dataset.menuIcon));
    }
  };
  for (const root of roots) {
    decorate(root);
    new MutationObserver(() => decorate(root)).observe(root, { childList: true, characterData: true, subtree: true });
  }
  document.getElementById("chrome-gear").innerHTML = menuIcon("settings");
}
