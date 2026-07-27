// One-off probe for the per-biome roadside cover. Each sprig kind is its own
// instanced mesh, so this walks them, pins the camera on a real instance of
// each (neutering the two calls the race loop uses to move the camera) and
// shoots it — one frame per biome signature.
//   node tools/sprig-probe.mjs   ->  shots in $OUT (default /tmp/sprig)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/sprig";
const PORT = 8109;
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

const kinds = await page.evaluate(() => {
  const Z = window.__zoomies, g = Z.world.grass;
  Object.defineProperty(g, "visible", { get: () => true, set: () => {}, configurable: true });
  const cam = Z.camera;
  cam.position.copy = function () { return this; }; // pin: the race loop can't move it
  cam.lookAt = () => {};
  window.__bisect = (mode) => {
    const m0 = Z.world.grass.children[0].material;
    if (mode === "nopos") m0.positionNode = null;
    if (mode === "noemis") m0.emissiveNode = null;
    m0.needsUpdate = true;
    return mode;
  };
  window.__aim = (tag) => {
    let m = Z.world.grass.children.find((c) => c.userData.sprig === tag);
    let attr = "aRoot";
    if (!m) { // airborne fields (tumbleweed / fluff / spindrift / litter)
      Z.scene.traverse((o) => { if (o.userData && o.userData.debris === tag) m = o; });
      attr = "aBase";
    }
    if (!m) return null;
    const a = m.geometry.attributes[attr].array;
    // Densest instance: the sprig with the most neighbours inside 4u.
    let bi = 0, bn = -1;
    for (let i = 0; i < m.count; i += Math.max(1, (m.count / 400) | 0)) {
      let n = 0;
      for (let j = 0; j < m.count; j += Math.max(1, (m.count / 400) | 0)) {
        const dx = a[j * 3] - a[i * 3], dz = a[j * 3 + 2] - a[i * 3 + 2];
        if (dx * dx + dz * dz < 16) n++;
      }
      if (n > bn) { bn = n; bi = i; }
    }
    const x = a[bi * 3], y = a[bi * 3 + 1], z = a[bi * 3 + 2];
    const c = Z.camera;
    const far = attr === "aBase"; // motes are spread over metres, sprigs over centimetres
    const d = far ? 11 : 1.7;
    Object.getPrototypeOf(c.position).set.call(c.position, x + d, y + (far ? 4.5 : 1.05), z + d);
    Object.getPrototypeOf(c).lookAt.call(c, x, y + (far ? 1.2 : 0.45), z);
    c.updateMatrixWorld(true);
    const V3 = c.position.constructor;
    const ndc = new V3(x, y + 0.5, z).project(c);
    m.computeBoundingSphere?.();
    const bs = m.boundingSphere || m.geometry.boundingSphere;
    return { at: [Math.round(x), Math.round(y), Math.round(z)], count: m.count,
      vis: m.visible, groupVis: Z.world.grass.visible, inScene: !!Z.world.grass.parent,
      verts: m.geometry.attributes.position.count, idx: m.geometry.index?.count,
      bs: bs ? [Math.round(bs.radius), Math.round(bs.center.x)] : null,
      ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2), +ndc.z.toFixed(3)],
      cam: c.position.toArray().map(Math.round), frust: m.frustumCulled };
  };
  const tags = Z.world.grass.children.map((c) => c.userData.sprig);
  Z.scene.traverse((o) => { if (o.userData && o.userData.debris) tags.push(o.userData.debris); });
  return tags;
});
console.log("kinds", JSON.stringify(kinds));
const BISECT = process.env.BISECT || "";
if (BISECT) await page.evaluate((m) => window.__bisect(m), BISECT);
for (const tag of kinds) {
  if (tag === "flower-head") continue; // framed together with its stems
  const info = await page.evaluate((t) => window.__aim(t), tag);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  console.log(" ", tag, JSON.stringify(info));
}
await browser.close();
server.close();
