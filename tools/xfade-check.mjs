// Headless check for the menu-tour shot transitions (main.js).
// Loads the title screen and waits for one full transition to run, asserting
// via the __zoomies.menuTour debug hook that the overlay reached full cover
// and released (peak ≈ 1 → opacity 0) in the expected mode:
//   default        → "dissolve" (WebGL2 snapshot crossfade)
//   MODE=dip       → "dip" (?xfade=dip: the capture-free navy dip WebGPU uses)
// The hook records the peak itself: SwiftShader stalls through entire fades,
// so sampling from outside can never catch the overlay mid-transition. Small
// viewport for the same reason — at 1280x800 SwiftShader menu frames exceed
// the tour clock's 0.5s dt clamp and a fade never even starts.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8112;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") u = "/index.html";
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: 480, height: 300 } })).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const dip = (process.env.MODE || "dissolve") === "dip" ? "&xfade=dip" : "";
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1${dip}`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 30000 });
// Wait until the render loop ticks steadily (SwiftShader's first frames take
// seconds each while shaders compile — the tour clock clamps those to dt=0).
await page.evaluate(() => { window.__raf = 0; const o = requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => o((t) => { window.__raf++; return cb(t); }); });
for (let t = 0; t < 180; t++) {
  const a = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(2000);
  const b = await page.evaluate(() => window.__raf);
  if (b - a > 20) break; // >10fps sustained: warm
}
// Sample the overlay opacity through at least two transitions (~17s).
let st = null;
for (let t = 0; t < 300; t++) {
  st = await page.evaluate(() => window.__zoomies?.menuTour?.() ?? null);
  if (t % 20 === 0) console.log("tour", JSON.stringify(st));
  // Done once a full fade has run: it reached (near) full cover and released.
  if (st && st.peak > 0.95 && st.phase === "hold" && Number(st.opacity) === 0) break;
  await page.waitForTimeout(100);
}
console.log(JSON.stringify(st));
const want = process.env.MODE || "dissolve";
const ok = st && st.peak > 0.95 && st.mode === want && Number(st.opacity) === 0;
console.log(ok ? "FADE-OK" : "FADE-FAIL");
process.exit(ok ? 0 : 1);
await browser.close();
server.close();
