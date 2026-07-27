// One-off probe for the roadside barriers. Finds a stretch of road in each
// fence style (located via the roadside sprig meshes — flowers only grow where
// the timber fence goes, scrub only where the stone wall does), pins the camera
// beside the barrier looking ALONG it so posts and courses recede, and shoots
// one frame per style.
//   node tools/fence-probe.mjs   ->  shots in $OUT (default /tmp/fence)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/fence";
const PORT = 8110;
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

await page.evaluate(() => {
  const Z = window.__zoomies;
  const cam = Z.camera;
  cam.position.copy = function () { return this; }; // pin: the race loop can't move it
  cam.lookAt = () => {};
  // Aim beside the barrier and look ALONG it, so a run of posts (or courses of
  // stone) recedes into the frame instead of being one flat slab.
  window.__fence = (sprigTag, sideSign) => {
    const m = Z.world.grass.children.find((c) => c.userData.sprig === sprigTag);
    if (!m) return null;
    const a = m.geometry.attributes.aRoot.array;
    const t = Z.track, N = t.samples;
    // Any instance will do — they only exist in the biomes we want.
    const gx = a[0], gz = a[2];
    let bi = 0, bd = 1e9;
    for (let i = 0; i < N; i++) {
      const p = t._pts[i];
      const d = Math.hypot(p.x - gx, p.z - gz);
      if (d < bd) { bd = d; bi = i; }
    }
    const p = t._pts[bi], tan = t._tans[bi];
    const tl = Math.hypot(tan.x, tan.z) || 1;
    const fx = tan.x / tl, fz = tan.z / tl;
    const sx = (-tan.z / tl) * sideSign, sz = (tan.x / tl) * sideSign;
    const off = t.halfWidth + 0.8;
    const c = Z.camera;
    // Stand just inside the road, level with the top of the wall, looking down
    // the barrier line.
    Object.getPrototypeOf(c.position).set.call(
      c.position,
      p.x + sx * (off - 4.5) - fx * 7, p.y + 1.9, p.z + sz * (off - 4.5) - fz * 7
    );
    Object.getPrototypeOf(c).lookAt.call(c, p.x + sx * off + fx * 16, p.y + 0.9, p.z + sz * off + fz * 16);
    c.updateMatrixWorld(true);
    return { at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], sample: bi };
  };
  // Bushes take the LOOSE (non-instanced) bend, which is its own code path and
  // has to be seen rendering — "no console errors" says nothing about whether a
  // positionNode threw the geometry out of the world.
  window.__bush = () => {
    const found = [];
    Z.scene.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh && o.geometry.attributes.aBend) found.push(o);
    });
    if (!found.length) return { bushes: 0 };
    const b = found[(found.length / 2) | 0];
    const w = new (Z.camera.position.constructor)();
    b.getWorldPosition(w);
    const c = Z.camera;
    Object.getPrototypeOf(c.position).set.call(c.position, w.x + 3.4, w.y + 2.0, w.z + 3.4);
    Object.getPrototypeOf(c).lookAt.call(c, w.x, w.y + 0.6, w.z);
    c.updateMatrixWorld(true);
    return { bushes: found.length, at: [Math.round(w.x), Math.round(w.y), Math.round(w.z)] };
  };
});

for (const [name, tag] of [["rail-timber", "flower"], ["stone-dry", "scrub"], ["slat-bamboo", "reed"], ["slat-snow", "tussock"], ["slat-dune", "marram"], ["slat-thorn", "stalk"], ["kerb-city", "blade"]]) {
  for (const sideSign of [1, -1]) {
    const info = await page.evaluate((a) => window.__fence(a.tag, a.s), { tag, s: sideSign });
    if (!info) { console.log(" ", name, "no sprigs of that kind on this map"); break; }
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(OUT, `${name}-side${sideSign > 0 ? "L" : "R"}.png`) });
    console.log(" ", name, sideSign, JSON.stringify(info));
  }
}
const bush = await page.evaluate(() => window.__bush());
console.log("  bush", JSON.stringify(bush));
if (bush.bushes) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "bush-loose-sway.png") });
}
await browser.close();
server.close();
