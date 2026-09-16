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
  // A saved mode + garage pick make the START button launch a race outright
  // (without them it opens the "How do you want to race?" picker and the
  // probe would measure the menu over the world instead of a race).
  try { localStorage.setItem("zoomies-mode-v1", "gp"); localStorage.setItem("zoomies-garage-v1", JSON.stringify({ cat: 0, kart: 0 })); } catch {}
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

// Exact attribution: wrap the backend's draw() and tally every draw call by
// the object it draws — keyed by the object's TOP-LEVEL scene ancestor's
// shape (type + geometry + material kinds + instanced or not) and, in a
// second table, by the leaf mesh's own shape. Averaged over N frames of a
// live race (the camera moves, so per-frame counts wobble; the ranking
// doesn't). Hiding objects one by one was far too noisy for that.
const FRAMES = Number(process.env.FRAMES || 60);
const report = await page.evaluate(async (FRAMES) => {
  const { scene, renderer } = window.__zoomies.gfx();
  const frames = (n) => new Promise((r) => { let k = 0; const step = () => (++k >= n ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  const shapeOf = (o) => {
    const geos = new Set(), mats = new Set();
    let inst = false;
    o.traverse((c) => {
      if (!(c.isMesh || c.isPoints || c.isLine || c.isSprite)) return;
      if (c.isInstancedMesh) inst = true;
      if (c.geometry) geos.add(c.geometry.type);
      const m = Array.isArray(c.material) ? c.material[0] : c.material;
      if (m) mats.add(m.type);
    });
    return `${o.type}${o.name ? "'" + o.name + "'" : ""}${inst ? "+inst" : ""} geo=[${[...geos].sort().slice(0, 4).join(",")}] mat=[${[...mats].sort().slice(0, 3).join(",")}]`;
  };
  const topOf = (o) => { let t = o; while (t.parent && t.parent !== scene) t = t.parent; return t; };
  const topKey = new Map(); // top-level object → shape key
  const byTop = new Map(); // key → { calls, objs:Set }
  const byLeaf = new Map(); // leaf shape → calls
  let total = 0, offscene = 0;
  const backend = renderer.backend;
  const orig = backend.draw.bind(backend);
  backend.draw = (ro, info) => {
    const obj = ro.object;
    total++;
    const top = topOf(obj);
    if (top.parent !== scene) {
      offscene++;
    } else {
      let key = topKey.get(top);
      if (!key) { key = shapeOf(top); topKey.set(top, key); }
      let e = byTop.get(key);
      if (!e) { e = { calls: 0, objs: new Set(), samples: [], perObj: new Map() }; byTop.set(key, e); }
      e.calls++;
      e.perObj.set(top, (e.perObj.get(top) || 0) + 1);
      if (!e.objs.has(top) && e.samples.length < 3) {
        // Enough to find the builder: where it sits, how big, what colour.
        let verts = 0, meshes = 0, color = "";
        top.traverse((c) => {
          if (!c.isMesh) return;
          meshes++;
          verts += c.geometry?.attributes?.position?.count || 0;
          const m = Array.isArray(c.material) ? c.material[0] : c.material;
          if (!color && m?.color) color = "#" + m.color.getHexString();
        });
        const p = top.position;
        e.samples.push(`at(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) meshes=${meshes} verts=${verts} ${color}${Object.keys(top.userData || {}).length ? " userData:" + Object.keys(top.userData).join(",") : ""}`);
      }
      e.objs.add(top);
    }
    const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const lk = `${obj.type}${obj.isInstancedMesh ? "(" + obj.count + ")" : ""} ${obj.geometry?.type || "?"} ${m?.type || "?"}${m?.name ? " '" + m.name + "'" : ""}`;
    byLeaf.set(lk, (byLeaf.get(lk) || 0) + 1);
    return orig(ro, info);
  };
  await frames(FRAMES);
  backend.draw = orig;
  // Sub-rows for the big buckets: the same-shaped objects split by colour,
  // userData tag and size band, so "209 plain meshes" resolves into "buildings
  // per cell / mountain sectors / prop looks" with a draw-call share each.
  const subrows = (e) => {
    const agg = new Map();
    for (const [top, calls] of e.perObj) {
      let verts = 0, color = "";
      top.traverse((c) => {
        if (!c.isMesh) return;
        verts += c.geometry?.attributes?.position?.count || 0;
        const m = Array.isArray(c.material) ? c.material[0] : c.material;
        if (!color && m?.color) color = "#" + m.color.getHexString();
      });
      const band = verts < 500 ? "<500v" : verts < 2000 ? "<2k v" : verts < 8000 ? "<8k v" : "8k+ v";
      const k = `${color} ${band}${Object.keys(top.userData || {}).length ? " ud:" + Object.keys(top.userData).join(",") : ""}`;
      const s = agg.get(k) || { objs: 0, calls: 0 };
      s.objs++; s.calls += calls;
      agg.set(k, s);
    }
    return [...agg.entries()].map(([k, s]) => ({ k, objs: s.objs, perFrame: s.calls / FRAMES })).sort((a, b) => b.perFrame - a.perFrame).slice(0, 12);
  };
  const tops = [...byTop.entries()].map(([key, e]) => ({ key, perFrame: e.calls / FRAMES, objs: e.objs.size, samples: e.samples, sub: e.calls / FRAMES >= 10 ? subrows(e) : [] })).sort((a, b) => b.perFrame - a.perFrame);
  const leaves = [...byLeaf.entries()].map(([key, n]) => ({ key, perFrame: n / FRAMES })).sort((a, b) => b.perFrame - a.perFrame);
  return { perFrame: total / FRAMES, offscene: offscene / FRAMES, counter: document.getElementById("fps-counter")?.textContent, children: scene.children.length, tops, leaves };
}, FRAMES);

console.log(`${report.perFrame.toFixed(1)} draw calls/frame over ${FRAMES} frames (${report.offscene.toFixed(1)} off-scene: post passes) · ${report.children} top-level objects · counter: ${report.counter}`);
console.log("\n-- by top-level scene object shape --\n   dc/f  objs  shape");
for (const r of report.tops) {
  if (r.perFrame < 0.5) continue;
  console.log(r.perFrame.toFixed(1).padStart(7), String(r.objs).padStart(5), " " + r.key);
  if (r.perFrame >= 2) for (const s of r.samples) console.log("              e.g. " + s);
  for (const s of r.sub) console.log("        " + s.perFrame.toFixed(1).padStart(6) + " dc/f " + String(s.objs).padStart(4) + " objs  " + s.k);
}
console.log("\n-- by drawn mesh shape --\n   dc/f  mesh");
for (const r of report.leaves.slice(0, 40)) if (r.perFrame >= 0.5) console.log(r.perFrame.toFixed(1).padStart(7), " " + r.key);
if (errors.length) console.log("page errors:", errors);
if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT }); console.log("screenshot:", process.env.SHOT); }
await browser.close();
server.close();
