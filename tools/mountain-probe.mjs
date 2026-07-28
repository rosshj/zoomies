// One-off probe for the mountain range. Pins the camera (the race loop drives it
// through exactly two calls, so neutering those freezes the shot) and frames
// peaks from a few distances: the far ring on the horizon, one peak side-on
// against the sky where the silhouette has to do the work, and a near-track
// peak up close. Silhouette is the whole point — a cone reads as a cone from
// any angle, so a probe that only shoots one angle proves nothing.
//   node tools/mountain-probe.mjs   ->  shots in $OUT (default /tmp/mtn)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/mtn";
const PORT = 8112;
fs.mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (u === "/") u = "/index.html";
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) { res.writeHead(404); res.end("404 " + u); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });

await page.waitForSelector("#start-btn", { timeout: 30000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let step = 0; step < 12; step++) {
  await page.waitForTimeout(700);
  const done = await page.evaluate(() => {
    const go = document.getElementById("go-btn");
    if (go && go.offsetParent) { go.click(); return true; }
    const screen = document.querySelector(".flow-screen.is-active");
    if (!screen) return false;
    const pick = [...screen.querySelectorAll("button, .card, [role=button]")]
      .filter((e) => e.offsetParent && !e.classList.contains("flow-back") && !e.hasAttribute("data-back"))[0];
    if (pick) pick.click();
    return false;
  });
  if (done) break;
}
for (let t = 0; t < 90; t++) {
  if (await page.evaluate(() => (window.__zoomies?.world?.grass?.userData?.uKart?.value?.x ?? 1e6) < 1e5)) break;
  await page.waitForTimeout(1000);
}

const info = await page.evaluate(() => {
  const Z = window.__zoomies;
  let peaks = null;
  Z.scene.traverse((o) => { if (o.userData && o.userData.mountains) peaks = o.userData.mountains; });
  if (!peaks) return { peaks: 0 };
  const c = Z.camera;
  c.position.copy = function () { return this; }; // pin
  c.lookAt = () => {};
  // Sort by distance from the world centre so we can pick a near one and a far
  // one deliberately rather than whatever comes first.
  const byR = [...peaks].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  window.__peaks = byR;
  window.__aim = (i, dist, up, look) => {
    const p = byR[i];
    const a = Math.atan2(p.z, p.x);
    const cx = p.x + Math.cos(a) * -dist; // stand between the peak and the centre
    const cz = p.z + Math.sin(a) * -dist;
    const cc = Z.camera;
    Object.getPrototypeOf(cc.position).set.call(cc.position, cx, p.y + p.h * up, cz);
    Object.getPrototypeOf(cc).lookAt.call(cc, p.x, p.y + p.h * look, p.z);
    cc.updateMatrixWorld(true);
    return { at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], h: Math.round(p.h), rad: Math.round(p.rad) };
  };
  return { peaks: peaks.length, nearest: Math.round(Math.hypot(byR[0].x, byR[0].z)), farthest: Math.round(Math.hypot(byR[byR.length - 1].x, byR[byR.length - 1].z)) };
});
console.log("range:", JSON.stringify(info));

if (info.peaks) {
  const SHOTS = [
    ["a-near-peak-close", 0, 160, 0.35, 0.5],
    ["b-near-peak-wide", 0, 420, 0.5, 0.45],
    ["c-ring-peak", Math.max(1, info.peaks - 1), 520, 0.45, 0.5],
    ["d-ring-peak-far", Math.max(1, info.peaks - 2), 900, 0.35, 0.4],
  ];
  for (const [name, i, dist, up, look] of SHOTS) {
    const r = await page.evaluate((a) => window.__aim(a.i, a.d, a.u, a.l), { i, d: dist, u: up, l: look });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(" ", name, JSON.stringify(r));
  }
}
await browser.close();
server.close();
