import { contrastBg } from "../src/catalog-palette.js";
// Cat-alog prize thumbnails — renders every garage preset (plus the two
// creator defaults) in the asset viewer and screenshots each one onto a
// contrasting pastel backdrop. Output: assets/catalog/<id>.jpg, which the
// Cat-alog's Prizes page shows on its tiles.
//
// Run: node tools/catalog-shots.mjs   (needs the pre-installed Chromium)
// Re-run whenever a preset or the cat/kart models change.
import { launchArtBrowser } from "./art-browser.mjs";
import { CAT_PRESETS, KART_PRESETS } from "../src/presets.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname),
  PORT = 8093;
const OUT = path.join(ROOT, "assets", "catalog");
const SIZE = 480; // square artwork, sharp enough for the expanded unlock sheet
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") u = "/viewer.html";
  if (u === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  fs.readFile(path.join(ROOT, u), (e, d) => {
    if (e) {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(d);
  });
});
await new Promise((r) => server.listen(PORT, r));

// --- Contrasting backdrop: pastel complement of the asset's main colour, with
// sensible fixed picks for near-neutral furs (grey/white/black cats).
// --- The shot list: every catalog id → a viewer preset spec + its backdrop.
// Cat portraits cycle a few camera angles so the grid reads like a photo wall
// — the classic ¾, a low straight-on "selfie", the mirrored ¾, and a low ¾.
// Each angle is fitted to the full model bounds, including its accessories.
const CAT_ANGLES = [
  { theta: 0.75, phi: 1.22 }, // classic ¾
  { theta: 0.06, phi: 1.34 }, // low straight-on selfie
  { theta: -0.65, phi: 1.26 }, // mirrored ¾
  { theta: 0.42, phi: 1.38 }, // low ¾
];
const shots = [];
CAT_PRESETS.forEach((c, i) =>
  shots.push({
    file: `cat-${i}.jpg`,
    bg: contrastBg(c.fur),
    angle: CAT_ANGLES[i % CAT_ANGLES.length],
    spec: { kind: "cat", ...c },
  }),
);
// Cats and karts share square artwork in every picker and detail sheet.
KART_PRESETS.forEach((k, i) =>
  shots.push({
    file: `kart-${i}.jpg`,
    bg: contrastBg(k.color),
    spec: { kind: "kart", name: k.name, color: k.color, style: k.style, number: k.number, livery: k.livery },
  }),
);
// The creator tiles advertise "make your own", so they get a look no preset
// has (the actual creator still opens on the presets.js defaults).
shots.push({
  file: "custom-cat.jpg",
  bg: contrastBg(0xa259ff),
  angle: CAT_ANGLES[1],
  spec: { kind: "cat", name: "Custom Cat", fur: 0xa259ff, pattern: "spotted", accessory: "headphones" },
});
shots.push({
  file: "custom-kart.jpg",
  bg: contrastBg(0xa259ff),
  spec: { kind: "kart", name: "Custom Kart", color: 0xa259ff, style: 3, number: 0 },
});
// Prize accessories (the acc.* Cat-alog entries), each worn by a plain grey cat
// so the accessory is the star. The hex is the accessory's natural default
// colour (ACCESSORY_COLORS[id][0] — mirrored here because models.js pulls in
// THREE, which this node script avoids importing). Headwear shots frame the
// head; neckwear keeps more of the chest in view.
const ACC_SHOTS = [
  ["party", 0xe23b3b, "head"],
  ["crown", 0xf5c518, "head"],
  ["pirate", 0x1a1a1a, "head"],
  ["tophat", 0x1a1a1a, "head"],
  ["cowboy", 0xa9743a, "head"],
  ["aviator", 0x6b4a2f, "head"],
  ["helmet", 0xe23b3b, "head"],
  ["chef", 0xf0f0f0, "head"],
  ["wizard", 0x4b3a8f, "head"],
  ["viking", 0x8a8f98, "head"],
  ["scarf", 0x9aa2a8, "neck"],
  ["charm", 0x7fb3d9, "neck"],
];
for (const [id, hex, zoom] of ACC_SHOTS)
  shots.push({
    file: `acc-${id}.jpg`,
    bg: contrastBg(hex),
    zoom,
    spec: { kind: "cat", name: id, fur: 0x8c9298, pattern: "solid", accessory: id },
  });

fs.mkdirSync(OUT, { recursive: true });
const browser = await launchArtBrowser();
const page = await (await browser.newContext({ viewport: { width: SIZE, height: SIZE } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`http://127.0.0.1:${PORT}/viewer.html?webgl=1&plain=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.showPreset, null, { timeout: 60000 });
await page.evaluate(() => window.__viewer.setGameLook(true)); // ship the in-game look

const selectedShots = shots.filter(
  (s) =>
    (!process.env.ROSTER_ONLY || !s.file.startsWith("acc-")) &&
    (!process.env.CATS_ONLY || s.file.startsWith("cat-")) &&
    (!process.env.KARTS_ONLY || s.file.startsWith("kart-")),
);
for (const shot of selectedShots) {
  await page.setViewportSize({ width: SIZE, height: SIZE });
  await page.evaluate(({ spec, bg, zoom, angle }) => {
    const v = window.__viewer;
    v.setBackground(bg);
    v.showPreset(spec);
    v.freeze(0); // straight wheels / neutral idle pose
    // Accessory close-ups keep their crop; full racers fit their model bounds.
    v.orbit.theta = 0.75;
    if (zoom === "head") {
      v.orbit.phi = 1.08;
      v.orbit.radius *= 0.72;
      v.orbit.target.y += 0.55;
    } else if (zoom === "neck") {
      v.orbit.phi = 1.15;
      v.orbit.radius *= 0.82;
      v.orbit.target.y += 0.3;
    } else if (angle) {
      v.orbit.theta = angle.theta;
      v.orbit.phi = angle.phi;
    } else {
      // Karts: level three-quarter view, fitted below to the square canvas.
      v.orbit.phi = 1.13;
    }
    if (!zoom) v.fitCurrent(1.12);
  }, shot);
  await page.waitForTimeout(350); // let a few frames render at the new framing
  await page.screenshot({ path: path.join(OUT, shot.file), type: "jpeg", quality: 88 });
  console.log(`  shot ${shot.file}  bg ${shot.bg}`);
}

console.log(
  errors.length ? `errors: ${JSON.stringify(errors)}` : `all ${selectedShots.length} shots → assets/catalog/`,
);
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
server.closeAllConnections();
server.close();
process.exit(errors.length ? 1 : 0);
