// Smoke test for the desktop (Electron) shell: launches desktop/main.cjs for
// real via Playwright's Electron driver, and asserts the app:// protocol
// serves the game — module scripts + import map load, the menu reaches the
// title screen, and no page errors fire. Screenshots to the path in
// SHOT (optional). Needs a display: run under `xvfb-run -a` on headless boxes.
//
//   xvfb-run -a node tools/electron-smoke.mjs
//
// Prereqs: `npm run build:web` at the root, `npm install` in desktop/.
import { _electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("no dist/ build — run `npm run build:web` first");
  process.exit(1);
}

// EXE overrides the target: point it at a PACKAGED build (e.g.
// desktop/out/linux-unpacked/zoomies-gp) to exercise the app.isPackaged
// resources path instead of the dev shell.
const errors = [];
const swArgs = [
  // Same software-GL stack as the browser checks — Xvfb has no GPU.
  "--use-gl=angle", "--use-angle=swiftshader",
  "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox",
];
const app = await _electron.launch({
  executablePath: process.env.EXE || path.join(DESKTOP, "node_modules", ".bin", "electron"),
  args: process.env.EXE ? swArgs : [path.join(DESKTOP, "main.cjs"), ...swArgs],
  env: { ...process.env, ZOOMIES_QUERY: "webgl=1&nowd=1" },
});

const page = await app.firstWindow();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

// The title screen appearing proves the whole serving chain: app:// scheme,
// import-map module loads, vendored three.js, and the boot sequence.
await page.waitForSelector("#start-btn", { timeout: 120000 })
  .catch(() => errors.push("title screen (#start-btn) never appeared"));

const diag = await page.evaluate(() => ({
  url: location.href,
  build: document.querySelector('meta[name="zoomies-build"]')?.content,
  title: document.title,
  quitBtnRevealed: !document.getElementById("quit-btn-title")?.classList.contains("hidden"),
  bridge: typeof window.zoomiesDesktop?.quit === "function",
})).catch((e) => ({ evalErr: String(e) }));

if (!String(diag.url).startsWith("app://game/")) errors.push("not served over app://: " + diag.url);
if (!diag.bridge) errors.push("preload bridge missing (zoomiesDesktop.quit)");
if (!diag.quitBtnRevealed) errors.push("desktop quit button not revealed");

if (process.env.SHOT) {
  await page.waitForTimeout(3000); // let a few real frames land first
  await page.screenshot({ path: process.env.SHOT }).catch((e) => errors.push("screenshot: " + e.message));
}

// Save bridge: the preload mirrors zoomies-* localStorage into userData every
// 5s — wait one period and the file must exist and parse.
const userData = await app.evaluate(({ app: a }) => a.getPath("userData")).catch(() => null);
if (userData) {
  await page.waitForTimeout(7000);
  const saveFile = path.join(userData, "zoomies-save.json");
  if (!fs.existsSync(saveFile)) errors.push("save bridge never wrote " + saveFile);
  else {
    try {
      const s = JSON.parse(fs.readFileSync(saveFile, "utf8"));
      if (typeof s.stamp !== "number" || typeof s.data !== "object") errors.push("save file shape wrong");
    } catch { errors.push("save file is not valid JSON"); }
  }
} else errors.push("could not resolve userData path");

console.log(JSON.stringify({ diag, errors }, null, 2));
await app.close().catch(() => {});

// Window close must have persisted the window state.
if (userData && !fs.existsSync(path.join(userData, "window-state.json"))) {
  errors.push("window-state.json not written on close");
  console.log("late error: window-state.json not written on close");
}
process.exit(errors.length ? 1 : 0);
