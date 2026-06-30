// Headless smoke test for Zoomies GP.
// Serves the repo statically, redirects the unpkg three.js imports to the
// npm-vendored copies in node_modules, loads the game with &webgl=1 (headless
// WebGPU renders black, so we use the WebGL2 fallback), pumps a few seconds of
// frames, then reports FPS / backend / draw-calls and any console errors.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8099;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// three.js is now vendored under ./vendor/three/ and served straight from the
// repo, so the harness just serves the working tree — no CDN interception needed.
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(ROOT, urlPath);
  fs.readFile(file, (err, data) => {
    if (err) { if (process.env.DIAG) console.error("NODE404:", urlPath); res.writeHead(404); res.end("not found: " + urlPath); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
if (process.env.DIAG) page.on("console", (m) => console.error("PAGE:", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("response", (r) => { if (r.status() >= 400) console.error("HTTP", r.status(), r.url()); });

// Enable the on-screen FPS/draw-call readout before the app boots.
const seedTT = !!process.env.TT;
const sel = process.env.SEL || ""; // "cat,kart" to seed the garage selection
await ctx.addInitScript(({ seedTT, sel }) => {
  try { localStorage.setItem("zoomies-fps", "1"); } catch {}
  if (sel) {
    const [cat, kart] = sel.split(",").map(Number);
    try { localStorage.setItem("zoomies-garage-v1", JSON.stringify({ cat, kart })); } catch {}
  }
  // Seed a personal-best so the time-trial PB-delta path runs in the test.
  if (seedTT) {
    try { localStorage.setItem("zoomies-timetrial-v2", JSON.stringify([{ time: 42.5, date: 1 }])); } catch {}
    // Seed a small ghost path so setupGhost() builds the translucent ghost kart.
    const samples = [];
    for (let k = 0; k < 24; k++) samples.push(k * 0.5, Math.sin(k) * 20, 0.5, Math.cos(k) * 20, k * 0.2);
    try { localStorage.setItem("zoomies-ttghost-v2", JSON.stringify({ key: "classic", samples })); } catch {}
  }
  window.__raf = 0;
  const o = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => o((t) => { window.__raf++; return cb(t); });
}, { seedTT, sel });

// nosw=1 keeps the service worker out of the gameplay check (a dedicated offline
// test exercises the SW separately).
const target = `http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`;
await page.goto(target, { waitUntil: "load" });

// Start the race.
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {}); // unlock audio gesture
// TT=1 starts a time trial (exercises the lap-timer / PB-delta HUD path) instead
// of a normal race.
const startSel = process.env.TT ? "#time-trial-btn" : "#start-btn";
await page.click(startSel, { force: true });

// Wait for the on-screen readout to populate with a real FPS/draw-call number.
// SwiftShader software-compiles every node material on the first frames, so the
// loop can take ~30s to start ticking; poll generously instead of guessing.
const WARMUP = Number(process.argv[2] || 75);
let populated = false;
for (let t = 0; t < WARMUP; t++) {
  const txt = await page.textContent("#fps-counter").catch(() => "");
  if (/\d+\s*FPS/.test(txt || "")) { populated = true; break; }
  await page.waitForTimeout(1000);
}
// Let it run a few more seconds of real frames once warmed up.
await page.waitForTimeout(4000);
if (!populated) errors.push("fps-counter never populated within " + WARMUP + "s");

if (process.env.DIAG) {
  page.on("console", (m) => console.error("PAGE:", m.type(), m.text()));
}
const diag = await page.evaluate(() => ({
  hudHidden: document.getElementById("hud")?.className,
  fps: document.getElementById("fps-counter")?.textContent,
  canvasCount: document.querySelectorAll("canvas").length,
  raf: window.__raf,
  ttBest: document.getElementById("tt-best")?.textContent,
  ttDelta: document.getElementById("tt-delta")?.textContent,
  ttDeltaClass: document.getElementById("tt-delta")?.className,
  timerClass: document.getElementById("timer")?.className,
  fpsClass: document.getElementById("fps-counter")?.className,
  lsFps: (() => { try { return localStorage.getItem("zoomies-fps"); } catch { return "ERR"; } })(),
})).catch((e) => ({ err: String(e) }));
if (process.env.DIAG) console.error("DIAG:", JSON.stringify(diag));

const fps = await page.textContent("#fps-counter").catch(() => "(no fps el)");
const result = {
  fps: (fps || "").trim(),
  errors,
};
console.log(JSON.stringify(result, null, 2));

await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
