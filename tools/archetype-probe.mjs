// Archetype probe — paints the generator's loop for every archetype (and a few
// seeds each) on one contact sheet, so the SHAPES can be compared: a speedway
// must read as an oval with straights, a street circuit as a technical knot,
// a rally stage as deep bays. Pure generator, no world build.
//   node tools/archetype-probe.mjs   -> $OUT/archetypes.png (default /tmp/arch)
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname), PORT = 8098;
const OUT = process.env.OUT || "/tmp/arch";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const PAGE = `<!doctype html><html><head><script type="importmap">{"imports":{"three":"./vendor/three/three.webgpu.min.js","three/webgpu":"./vendor/three/three.webgpu.min.js","three/tsl":"./vendor/three/three.tsl.min.js","three/addons/":"./vendor/three/addons/"}}</script></head>
<body style="margin:0;background:#1d2430;color:#eee;font:12px system-ui"><div id="grid" style="display:grid;grid-template-columns:repeat(4,220px);gap:4px"></div>
<script type="module">
import { previewLoopPoints, ARCHETYPE_IDS, ARCHETYPES } from "./src/track.js";
const seeds = (new URLSearchParams(location.search).get("seeds") || "ATLAS1,ATLAS2,ATLAS3,ATLAS4").split(",");
const grid = document.getElementById("grid");
for (const arch of ARCHETYPE_IDS) for (const seed of seeds) {
  const cfg = { mode: "custom", seed, size: 0.5, curviness: 0.5, twist: arch === "figure8" ? 1.0 : arch === "classic" ? 0.3 : 0, hilliness: 0.4, hills: 0.5, biomes: ["meadow", "forest", "city"], archetype: arch };
  const pts = previewLoopPoints(cfg);
  const c = document.createElement("canvas"); c.width = 220; c.height = 200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#2a3444"; ctx.fillRect(0, 0, 220, 200);
  let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  for (const p of pts) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z); }
  const sc = Math.min(200 / (maxx - minx), 180 / (maxz - minz));
  const ox = 110 - (minx + maxx) / 2 * sc, oz = 92 - (minz + maxz) / 2 * sc;
  // Catmull-Rom through the control points, like the real track.
  const P = (i) => pts[((i % pts.length) + pts.length) % pts.length];
  ctx.strokeStyle = "#f4d35e"; ctx.lineWidth = 3; ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let t = 0; t <= 1; t += 0.1) {
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      if (i === 0 && t === 0) ctx.moveTo(x * sc + ox, z * sc + oz); else ctx.lineTo(x * sc + ox, z * sc + oz);
    }
  }
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle = "#eee"; ctx.fillText(ARCHETYPES[arch].label + " · " + seed + " · " + pts.length + "pts" + (pts._xover ? " ×" : ""), 6, 14);
  grid.appendChild(c);
}
window.__done = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/probe.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); });
});
await new Promise((r) => server.listen(PORT, r));
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 7 * 204 + 10 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("ERR:", m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/probe.html${process.env.SEEDS ? "?seeds=" + process.env.SEEDS : ""}`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
await page.screenshot({ path: path.join(OUT, "archetypes.png"), fullPage: true });
console.log("→", path.join(OUT, "archetypes.png"));
await browser.close(); server.close();
