// One-off probe for the shared wind field. Starts a race, leaves the kart on
// the grid so the camera holds dead still, and shoots the same frame with the
// wind OFF, at rest strength, and cranked — so the treeline's lean (and the
// grass under it) can be compared with nothing else moving.
//   node tools/wind-probe.mjs   ->  shots in $OUT (default /tmp/wind)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/wind";
const PORT = 8106;
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
page.on("console", (m) => { if (m.type() === "error") console.error("ERR:", m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });

// Walk the menu flow (title -> mode -> track -> cat -> kart -> start line).
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
  const live = await page.evaluate(() => typeof window.__zoomies?.setWind === "function" && (window.__zoomies?.world?.grass?.userData?.uKart?.value?.x ?? 1e6) < 1e5);
  if (live) break;
  await page.waitForTimeout(1000);
}
// Keep the grass on (adaptive quality hides it outright at SwiftShader rates),
// then park the camera on the nearest tree. The race loop drives the camera
// through exactly two calls, so neutering those pins the shot dead still — and
// a still shot is the only way to tell a lean from a camera move.
const framed = await page.evaluate(() => {
  const Z = window.__zoomies;
  const g = Z.world.grass; // a group of sprig meshes
  Object.defineProperty(g, "visible", { get: () => true, set: () => {}, configurable: true });
  // Canopies are the instanced meshes carrying the wind attribute.
  const canopies = [];
  Z.scene.traverse((o) => { if (o.isInstancedMesh && o.geometry.attributes.aWindRoot) canopies.push(o); });
  const px = g.userData.uKart.value.x, pz = g.userData.uKart.value.z;
  let best = null, bestD = 1e9;
  for (const c of canopies) {
    const a = c.geometry.attributes.aWindRoot.array;
    for (let i = 0; i < c.count; i++) {
      const d = Math.hypot(a[i * 3] - px, a[i * 3 + 1] - pz);
      if (d < 30) continue; // too close to the grid = camera lands inside a building
      if (d < bestD) { bestD = d; best = { x: a[i * 3], z: a[i * 3 + 1], mesh: c, i }; }
    }
  }
  if (!best) return { canopies: canopies.length, found: false };
  // Canopy world Y comes off its own instance matrix.
  const M4 = best.mesh.matrix.constructor, m = new M4();
  best.mesh.getMatrixAt(best.i, m);
  const y = m.elements[13];
  const cam = Z.camera;
  cam.position.set(best.x + 17, y + 8, best.z + 17);
  cam.lookAt(best.x, y + 3, best.z);
  cam.updateMatrixWorld(true);
  cam.position.copy = function () { return this; }; // the race loop can't move it
  cam.lookAt = () => {};
  return { canopies: canopies.length, found: true, dist: +bestD.toFixed(1), tree: [Math.round(best.x), Math.round(y), Math.round(best.z)] };
});
console.log("framed", JSON.stringify(framed));

// Same frame, three winds. The kart is never touched, so anything that moves
// between these shots moved because of the field.
const SHOTS = [
  ["a-calm", { strength: 0, speed: 0.9 }],
  ["b-rest", { strength: 1, speed: 0.9 }],
  ["c-gale", { strength: 3.2, speed: 0.9 }],
  ["d-gale-later", { strength: 3.2, speed: 9 }],
];
for (const [name, cfg] of SHOTS) {
  await page.evaluate((c) => window.__zoomies.setWind(c), cfg);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
console.log("wrote", fs.readdirSync(OUT).sort().join(" "));
await browser.close();
server.close();
