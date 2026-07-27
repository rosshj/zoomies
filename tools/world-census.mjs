// End-to-end audit of the world-dressing features: does each one actually EXIST
// in a live race, and is it wired to move?
//
// This branch twice shipped a feature that passed every check while being
// invisible — grass thrown out of the world by a bend weight, and bushes whose
// attribute never reached the scene. Both were silent: no console error, no
// failed assertion. So this census asserts on the live scene graph (counts,
// attributes, whether a material actually carries a positionNode) rather than
// on the absence of errors, and samples the wind while driving to prove the
// per-biome force really moves.
//   node tools/world-census.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/census";
const PORT = 8111;
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
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
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

const census = await page.evaluate(() => {
  const Z = window.__zoomies;
  const out = {};
  // Roadside cover: one instanced mesh per biome signature.
  const grass = Z.world.grass;
  out.sprigs = grass.children
    .filter((c) => c.isInstancedMesh)
    .map((c) => ({ kind: c.userData.sprig, n: c.count, node: !!c.material.positionNode, vis: c.visible }));
  out.sprigTotal = out.sprigs.reduce((a, b) => a + b.n, 0);
  // Tree canopies.
  const can = [];
  Z.scene.traverse((o) => {
    if (o.isInstancedMesh && o.geometry.attributes.aWindRoot) {
      can.push({ n: o.count, bend: !!o.geometry.attributes.aBend, node: !!o.material.positionNode });
    }
  });
  out.canopies = { meshes: can.length, instances: can.reduce((a, b) => a + b.n, 0),
    allBend: can.every((c) => c.bend), allNode: can.every((c) => c.node) };
  // Airborne biome signatures.
  const air = [];
  Z.scene.traverse((o) => { if (o.userData && o.userData.debris) air.push({ kind: o.userData.debris, n: o.count, node: !!o.material.positionNode }); });
  out.airborne = air;
  // Falling petals / leaves (the kart-reactive flurry rides on these).
  const fall = [];
  Z.scene.traverse((o) => {
    if (o.isInstancedMesh && !o.geometry.attributes.aBase && !o.geometry.attributes.aWindRoot &&
        !o.geometry.attributes.aRoot && o.material.positionNode && o.renderOrder !== 3) fall.push(o.count);
  });
  out.fallFields = fall.length;
  // Barriers, by the tags _buildWalls stamps.
  const bar = {};
  Z.track.group.traverse((o) => {
    const t = o.userData && o.userData.barrier;
    if (t) bar[t] = (bar[t] || 0) + (o.isInstancedMesh ? o.count : 1);
  });
  out.barriers = bar;
  // Does the per-biome wind actually differ around this map? Sampling the
  // TARGET at points around the loop proves the mapping without having to drive
  // the whole lap in a software renderer running at walking pace.
  const t = Z.track, N = t.samples;
  const w = Z.wind.biomeWindAt;
  const tgt = [];
  for (let i = 0; i < N; i += 25) tgt.push(+w(t._pts[i].x, t._pts[i].z).toFixed(2));
  out.biomeWindTargets = { min: Math.min(...tgt), max: Math.max(...tgt), distinct: [...new Set(tgt)].sort((a, b) => a - b) };
  // The shared kart uniform every reactive effect reads.
  const uk = grass.userData.uKart.value;
  out.kartUniform = { x: Math.round(uk.x), z: Math.round(uk.z), speed01: +uk.w.toFixed(2) };
  return out;
});
console.log(JSON.stringify(census, null, 1));

// Drive a lap-ish and watch the wind respond to the biomes crossed.
await page.keyboard.down("ArrowUp");
const seen = [];
for (let t = 0; t < 40; t++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const Z = window.__zoomies, w = Z.wind || {};
    const uk = Z.world.grass.userData.uKart.value;
    return { bend: +w.uWindStr.value.toFixed(2), air: +w.uWindAir.value.toFixed(2), sp: +uk.w.toFixed(2) };
  });
  seen.push(s);
}
await page.keyboard.up("ArrowUp");
const bends = seen.map((s) => s.bend);
const sps = seen.map((s) => s.sp);
console.log("wind over the drive: min %s max %s  |  kart speed01 min %s max %s",
  Math.min(...bends).toFixed(2), Math.max(...bends).toFixed(2),
  Math.min(...sps).toFixed(2), Math.max(...sps).toFixed(2));
console.log("wind trace:", bends.join(" "));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await page.screenshot({ path: path.join(OUT, "driving.png") });

// The petal flurry is the one NEW behaviour rather than a rewiring, so prove it
// moves: pin the camera on a fall field, freeze the kart uniform on it (the race
// loop rewrites it every frame, so neuter the setter) and shoot push OFF vs ON.
// Only the w component changes between the two frames.
const flurry = await page.evaluate(() => {
  const Z = window.__zoomies;
  const fields = [];
  Z.scene.traverse((o) => {
    if (o.isInstancedMesh && o.material.positionNode && !o.geometry.attributes.aBase &&
        !o.geometry.attributes.aWindRoot && !o.geometry.attributes.aRoot) fields.push(o);
  });
  if (!fields.length) return { fields: 0 };
  const f = fields[(fields.length / 2) | 0];
  const M4 = f.matrix.constructor, m = new M4();
  f.getMatrixAt((f.count / 2) | 0, m);
  const [x, y, z] = [m.elements[12], m.elements[13], m.elements[14]];
  const c = Z.camera;
  c.position.copy = function () { return this; };
  c.lookAt = () => {};
  Object.getPrototypeOf(c.position).set.call(c.position, x + 9, y + 5, z + 9);
  Object.getPrototypeOf(c).lookAt.call(c, x, y + 2.5, z);
  c.updateMatrixWorld(true);
  const uk = Z.world.grass.userData.uKart;
  uk.value.set = () => uk.value; // the race loop can no longer touch it
  window.__flurry = (push) => { uk.value.x = x; uk.value.y = y; uk.value.z = z; uk.value.w = push; };
  return { fields: fields.length, at: [Math.round(x), Math.round(y), Math.round(z)], n: f.count };
});
console.log("flurry field:", JSON.stringify(flurry));
if (flurry.fields) {
  for (const [name, push] of [["flurry-a-still", 0], ["flurry-b-blasting", 1.1]]) {
    await page.evaluate((v) => window.__flurry(v), push);
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
}
await browser.close();
server.close();
