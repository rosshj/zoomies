// Draw-call attribution probe: start a race headlessly, then hide each
// top-level scene object in turn and report how many draw calls it costs.
//
//   node tools/dc-probe.mjs                 # the classic circuit
//   TRACK=city node tools/dc-probe.mjs      # Neon Alley (the heaviest track)
//   QUALITY=high TRACK=city node tools/dc-probe.mjs
//
// Output: baseline draw calls, then one line per object sorted by cost, with
// enough shape (type, geometry, material, instance count, mesh children) to
// find the builder in scenery.js / features.js / track.js.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8098;
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

const TRACKS = {
  city: { mode: "custom", seed: "NEON", size: 0.5, curviness: 0.45, twist: 0.55, hilliness: 0.3, hills: 0.4, biomes: ["city"], timeOfDay: "night" },
  forest: { mode: "custom", seed: "PINE", size: 0.5, curviness: 0.5, twist: 0.5, hilliness: 0.4, hills: 0.5, biomes: ["forest"], timeOfDay: "day" },
};
const track = TRACKS[process.env.TRACK] || null;
const quality = process.env.QUALITY || "";

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await ctx.addInitScript(({ track, quality }) => {
  try { localStorage.setItem("zoomies-fps", "1"); } catch {}
  if (track) try { localStorage.setItem("zoomies-track-v1", JSON.stringify(track)); } catch {}
  if (quality) try { localStorage.setItem("zoomies-quality-v2", quality); } catch {}
}, { track, quality });

await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
console.error("[probe] page loaded"); await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let t = 0; t < 150; t++) {
  const txt = await page.textContent("#fps-counter").catch(() => "");
  if (/\d+\s*FPS/.test(txt || "")) break;
  await page.waitForTimeout(1000);
}
console.error("[probe] race running, counter:", await page.textContent("#fps-counter").catch(() => "")); await page.waitForTimeout(3000);

const report = await page.evaluate(async () => {
  const { scene, renderer } = window.__zoomies.gfx();
  const frames = (n) => new Promise((r) => { let k = 0; const step = () => (++k >= n ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  const sample = async () => {
    let max = 0;
    for (let i = 0; i < 3; i++) { await frames(1); max = Math.max(max, renderer.info.render.drawCalls); }
    return max;
  };
  const hasDrawables = (o) => { let n = 0; o.traverse((c) => { if (c.isMesh || c.isPoints || c.isLine || c.isSprite) n++; }); return n > 0; };
  const describe = (o) => {
    let meshes = 0, inst = 0, instCount = 0, geos = new Set(), mats = new Set();
    o.traverse((c) => {
      if (c.isMesh || c.isPoints || c.isLine) {
        meshes++;
        if (c.isInstancedMesh) { inst++; instCount += c.count; }
        if (c.geometry) geos.add(c.geometry.type);
        const m = Array.isArray(c.material) ? c.material[0] : c.material;
        if (m) mats.add(m.type);
      }
    });
    const p = o.position;
    return `${o.type}${o.name ? " '" + o.name + "'" : ""} meshes=${meshes}${inst ? ` (instanced ${inst}, ${instCount} inst)` : ""} geo=[${[...geos].slice(0, 4).join(",")}] mat=[${[...mats].slice(0, 3).join(",")}] at(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`;
  };
  // Group the top-level objects by SHAPE (type + geometry + material kinds +
  // instanced or not) and hide each group as a whole: a scene can hold
  // hundreds of top-level objects (SwiftShader makes one sample ~0.2s), and a
  // group of many same-shaped meshes is exactly the batching candidate.
  const signature = (o) => {
    const geos = new Set(), mats = new Set();
    let inst = false;
    o.traverse((c) => {
      if (!(c.isMesh || c.isPoints || c.isLine || c.isSprite)) return;
      if (c.isInstancedMesh) inst = true;
      if (c.geometry) geos.add(c.geometry.type);
      const m = Array.isArray(c.material) ? c.material[0] : c.material;
      if (m) mats.add(m.type);
    });
    return `${o.type}${inst ? "+inst" : ""} geo=[${[...geos].sort().join(",")}] mat=[${[...mats].sort().join(",")}]`;
  };
  const baseline = await sample();
  const groups = new Map();
  for (const child of scene.children) {
    if (!child.visible || child.isLight || child.isCamera || !hasDrawables(child)) continue;
    const sig = signature(child);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(child);
  }
  const rows = [];
  for (const [sig, objs] of groups) {
    for (const o of objs) o.visible = false;
    const dc = await sample();
    for (const o of objs) o.visible = true;
    let meshes = 0, instCount = 0;
    for (const o of objs) o.traverse((c) => { if (c.isMesh || c.isPoints || c.isLine || c.isSprite) { meshes++; if (c.isInstancedMesh) instCount += c.count; } });
    rows.push({ cost: baseline - dc, objects: objs.length, meshes, instCount, sig });
  }
  const allHidden = [];
  for (const child of scene.children) { if (child.visible && !child.isLight && !child.isCamera) { child.visible = false; allHidden.push(child); } }
  const rest = await sample();
  for (const c of allHidden) c.visible = true;
  rows.sort((a, b) => b.cost - a.cost);
  return { baseline, rest, counter: document.getElementById("fps-counter")?.textContent, children: scene.children.length, groups: groups.size, rows };
});

console.log(`baseline ${report.baseline} draw calls · with every scene object hidden ${report.rest} (post/HUD) · ${report.children} top-level objects in ${report.groups} shape groups · counter: ${report.counter}`);
console.log("   dc  objs meshes  inst  shape");
for (const r of report.rows) if (r.cost > 0) console.log(String(r.cost).padStart(5), String(r.objects).padStart(5), String(r.meshes).padStart(6), String(r.instCount).padStart(5), " " + r.sig);
if (errors.length) console.log("page errors:", errors);
await browser.close();
server.close();
