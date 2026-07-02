// Throwaway: census the scene's renderable population to find draw-call hogs.
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8087;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/index.html"; fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("ERR", String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load" });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("#start-btn", { force: true });
await page.waitForTimeout(12000);
const census = await page.evaluate(() => {
  const { scene } = window.__zoomies;
  const byKey = new Map();
  let meshes = 0, instanced = 0, sprites = 0, lines = 0, pts = 0;
  scene.traverse((o) => {
    if (!o.visible) return;
    let kind = null;
    if (o.isInstancedMesh) { instanced++; kind = "Instanced"; }
    else if (o.isMesh) { meshes++; kind = "Mesh"; }
    else if (o.isSprite) { sprites++; kind = "Sprite"; }
    else if (o.isLine || o.isLineSegments) { lines++; kind = "Line"; }
    else if (o.isPoints) { pts++; kind = "Points"; }
    if (!kind) return;
    // Identify by nearest named ancestor + geometry type so builders are traceable.
    let anc = o, name = "";
    while (anc && !name) { name = anc.name || ""; anc = anc.parent; }
    const col = o.material?.color?.getHexString?.() || "-";
    const key = `${kind}|${o.geometry?.type || "-"}|#${col}`;
    if (!window.__samples) window.__samples = {};
    if (!window.__samples[key]) {
      const p = new (o.position.constructor)();
      o.getWorldPosition(p);
      window.__samples[key] = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), mat: o.material?.type, prm: JSON.stringify(o.geometry?.parameters || {}).slice(0, 60) };
    }
    byKey.set(key, (byKey.get(key) || 0) + 1);
  });
  const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28);
  return { meshes, instanced, sprites, lines, pts, top, samples: window.__samples };
});
console.log(JSON.stringify(census, null, 1));
await browser.close(); server.close();
