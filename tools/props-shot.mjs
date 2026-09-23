// Close-up visual check of the instanced knockable props (crate + barrel):
// start a race, pin the camera 6u from the first grounded crate and the first
// barrel, screenshot each. SHOT=/path/prefix xvfb-run -a node tools/props-shot.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8096;
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
const prefix = process.env.SHOT || "/tmp/props";
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
  } catch {}
});
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
await page.waitForSelector("#go-btn", { state: "visible", timeout: 120000 });
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById("go-btn")?.click());
for (let t = 0; t < 150; t++) {
  const txt = await page.textContent("#fps-counter").catch(() => "");
  if (/\d+\s*FPS/.test(txt || "")) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(8000);
const pin = async (kind) => page.evaluate((kind) => {
  const { camera } = window.__zoomies.gfx();
  const props = window.__zoomies.props?._props || [];
  const pr = props.find((p) => p.kind === kind && p.mode === "ground");
  if (!pr) return { err: "no " + kind };
  camera.position.copy = () => camera.position; // pin (see wind-probe)
  camera.lookAt = () => {};
  const c = pr.mesh.position;
  camera.position.set(c.x + 4, c.y + 3, c.z + 4);
  const M = camera.matrix.constructor, V = c.constructor;
  camera.quaternion.setFromRotationMatrix(new M().lookAt(camera.position, new V(c.x, c.y, c.z), new V(0, 1, 0)));
  return { kind, at: [c.x, c.y, c.z], scale: pr.scale ? [pr.scale.x, pr.scale.y, pr.scale.z] : null, rest: pr.rest, inst: pr.inst ? pr.inst.i : null, vis: pr.mesh.visible };
}, kind);
for (const kind of ["crate", "barrel"]) {
  const info = await pin(kind);
  console.log(JSON.stringify(info));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${prefix}-${kind}.png` });
  // Knock it: the tumbling pose exercises the instance rotation × scale path.
  await page.evaluate((kind) => {
    const pr = (window.__zoomies.props?._props || []).find((p) => p.kind === kind && p.mode === "ground");
    pr.asleep = false; pr.settle = false; pr.hit = 0.4;
    pr.vel.set(3, 9, 2); pr.angVel.set(5, 1, 7);
  }, kind);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${prefix}-${kind}-tumble.png` });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${prefix}-${kind}-settled.png` });
}
console.log("shots:", `${prefix}-crate.png`, `${prefix}-barrel.png`);
await browser.close();
server.close();
