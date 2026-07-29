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

const errors = [];
const app = await _electron.launch({
  executablePath: path.join(DESKTOP, "node_modules", ".bin", "electron"),
  args: [
    path.join(DESKTOP, "main.cjs"),
    // Same software-GL stack as the browser checks — Xvfb has no GPU.
    "--use-gl=angle", "--use-angle=swiftshader",
    "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox",
  ],
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

console.log(JSON.stringify({ diag, errors }, null, 2));
await app.close().catch(() => {});
process.exit(errors.length ? 1 : 0);
