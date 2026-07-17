// Cat-alog prize thumbnails — renders every garage preset (plus the two
// creator defaults) in the asset viewer and screenshots each one onto a
// contrasting pastel backdrop. Output: assets/catalog/<id>.jpg, which the
// Cat-alog's Prizes page shows on its tiles.
//
// Run: node tools/catalog-shots.mjs   (needs the pre-installed Chromium)
// Re-run whenever a preset or the cat/kart models change.
import { chromium } from "playwright-core";
import { CAT_PRESETS, KART_PRESETS } from "../src/presets.js";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname), PORT = 8093;
const OUT = path.join(ROOT, "assets", "catalog");
const SIZE = 320; // square tile; displayed at ~100px so this is plenty
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/viewer.html"; if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; } fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));

// --- Contrasting backdrop: pastel complement of the asset's main colour, with
// sensible fixed picks for near-neutral furs (grey/white/black cats).
const hexToHsl = (hex) => {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return { h, s, l };
};
const hslToHex = (h, s, l) => {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
};
function contrastBg(hex) {
  const { h, s, l } = hexToHsl(hex);
  if (s < 0.18) return l >= 0.75 ? "#46568a" : l <= 0.35 ? "#f0e0c2" : "#d99a6c"; // white → slate, black → cream, grey → clay
  return hslToHex((h + 0.5) % 1, l > 0.65 ? 0.42 : 0.48, l > 0.65 ? 0.52 : 0.76); // pastel complement; darker behind light assets
}

// --- The shot list: every catalog id → a viewer preset spec + its backdrop.
const shots = [];
CAT_PRESETS.forEach((c, i) => shots.push({ file: `cat-${i}.jpg`, bg: contrastBg(c.fur), spec: { kind: "cat", name: c.name, fur: c.fur, pattern: c.pattern } }));
KART_PRESETS.forEach((k, i) => shots.push({ file: `kart-${i}.jpg`, bg: contrastBg(k.color), spec: { kind: "kart", name: k.name, color: k.color, style: k.style, number: k.number } }));
// The creator tiles advertise "make your own", so they get a look no preset
// has (the actual creator still opens on the presets.js defaults).
shots.push({ file: "custom-cat.jpg", bg: contrastBg(0xa259ff), spec: { kind: "cat", name: "Custom Cat", fur: 0xa259ff, pattern: "spotted", accessory: "headphones" } });
shots.push({ file: "custom-kart.jpg", bg: contrastBg(0xa259ff), spec: { kind: "kart", name: "Custom Kart", color: 0xa259ff, style: 3, number: 0 } });

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: SIZE, height: SIZE } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/viewer.html?webgl=1&plain=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.showPreset, null, { timeout: 60000 });
await page.evaluate(() => window.__viewer.setGameLook(true)); // ship the in-game look

for (const shot of shots) {
  await page.evaluate(({ spec, bg }) => {
    const v = window.__viewer;
    v.setBackground(bg);
    v.showPreset(spec);
    v.freeze(0); // straight wheels / neutral idle pose
    // Tight three-quarter framing: pull in from the browse-friendly default
    // (0.88 keeps a whisker of headroom — 0.8 clipped the tallest ears).
    v.orbit.theta = 0.75;
    v.orbit.phi = 1.13;
    v.orbit.radius *= 0.88;
  }, shot);
  await page.waitForTimeout(350); // let a few frames render at the new framing
  await page.screenshot({ path: path.join(OUT, shot.file), type: "jpeg", quality: 88 });
  console.log(`  shot ${shot.file}  bg ${shot.bg}`);
}

console.log(errors.length ? `errors: ${JSON.stringify(errors)}` : `all ${shots.length} shots → assets/catalog/`);
await browser.close(); server.close(); process.exit(errors.length ? 1 : 0);
