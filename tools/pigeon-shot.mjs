// Visual check for the instanced pigeon flocks: start a race on a city track,
// find a flock, pin the camera a few metres from its loft (the race loop's
// camera.position.copy / lookAt are neutered, as tools/wind-probe.mjs does),
// force the flock live, and screenshot it perched and mid-scatter.
//
//   SHOT=/path/prefix xvfb-run -a node tools/pigeon-shot.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8097;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  fs.readFile(path.join(ROOT, p), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));
const prefix = process.env.SHOT || "/tmp/pigeon";
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("zoomies-mode-v1", "gp");
    localStorage.setItem("zoomies-garage-v1", JSON.stringify({ cat: 0, kart: 0 }));
    localStorage.setItem("zoomies-quality-v2", "high");
    localStorage.setItem("zoomies-track-v1", JSON.stringify({ mode: "custom", seed: "NEON", size: 0.5, curviness: 0.45, twist: 0.55, hilliness: 0.3, hills: 0.4, biomes: ["city"], timeOfDay: "day" }));
  } catch {}
});
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let t = 0; t < 150; t++) {
  const txt = await page.textContent("#fps-counter").catch(() => "");
  if (/\d+\s*FPS/.test(txt || "")) break;
  await page.waitForTimeout(1000);
}
const info = await page.evaluate(() => {
  const { scene, camera } = window.__zoomies.gfx();
  // The flock: a body InstancedMesh with 7 instances under a Group that also holds the 14-wing one.
  let flock = null;
  scene.traverse((o) => { if (!flock && o.isInstancedMesh && o.count === 7 && o.parent?.children?.some((c) => c.isInstancedMesh && c.count === 14)) flock = o.parent; });
  if (!flock) return { err: "no flock found" };
  flock.visible = true; // force live
  for (const c of scene.children) if (c.isGroup && c.position.equals(flock.position) && c !== flock) c.visible = false; // hide its proxy
  const c = flock.position;
  camera.position.copy = () => camera.position; // pin the camera (see wind-probe)
  camera.lookAt = () => {};
  camera.position.set(c.x + 6, c.y + 9, c.z + 7);
  camera.quaternion.setFromRotationMatrix(new (camera.matrix.constructor)().lookAt(camera.position, new (c.constructor)(c.x, c.y + 6.5, c.z), new (c.constructor)(0, 1, 0)));
  return { at: [c.x, c.y, c.z], children: flock.children.length };
});
console.log(JSON.stringify(info));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${prefix}-perched.png` });
// Scatter: the flocks scatter when a player comes within triggerR; fake it by
// teleporting the first kart's position readout isn't exposed, so nudge the
// birds directly for the mid-flight pose.
await page.evaluate(() => {
  const { scene } = window.__zoomies.gfx();
  let flock = null;
  scene.traverse((o) => { if (!flock && o.isInstancedMesh && o.count === 7) flock = o.parent; });
  const rigs = flock.children.filter((c) => !c.isInstancedMesh);
  rigs.forEach((r, i) => { r.position.y += 1.5 + i * 0.4; r.position.x += (i - 3) * 0.8; r.rotation.y = i; r.children.forEach((wg, j) => { wg.rotation.z = (j ? 1 : -1) * 0.9; }); });
  flock.userData.refresh();
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${prefix}-flight.png` });
console.log("shots:", `${prefix}-perched.png`, `${prefix}-flight.png`);
await browser.close();
server.close();
