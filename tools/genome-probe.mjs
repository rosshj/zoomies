// Genome probe — renders a contact sheet of found cats / karts grown from
// seeds so the procedural coat painter, body genes and accessory flair can be
// LOOKED at (the only way to judge a coat). Uses the asset viewer's debug hook.
//   node tools/genome-probe.mjs            -> $OUT/cats.png + karts.png (default /tmp/genome)
//   KIND=cat SEEDS=A1,A2 BIOME=tundra node tools/genome-probe.mjs
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname), PORT = 8097;
const OUT = process.env.OUT || "/tmp/genome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/viewer.html"; if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; } fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
fs.mkdirSync(OUT, { recursive: true });

const kinds = process.env.KIND ? [process.env.KIND] : ["cat", "kart"];
const biome = process.env.BIOME || null;
const seeds = process.env.SEEDS ? process.env.SEEDS.split(",") : Array.from({ length: 12 }, (_, i) => "S" + (i + 1));
const TILE = 240;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: TILE, height: TILE } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/viewer.html?webgl=1&plain=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.showGenome, null, { timeout: 60000 });
await page.evaluate(() => window.__viewer.setGameLook(true));

for (const kind of kinds) {
  const wide = kind === "kart";
  await page.setViewportSize(wide ? { width: 360, height: 240 } : { width: TILE, height: TILE });
  const tiles = [];
  for (const seed of seeds) {
    const info = await page.evaluate(({ kind, seed, biome, wide }) => {
      const v = window.__viewer;
      v.setBackground("#c9d6e3");
      const g = v.showGenome(kind, seed, biome);
      v.freeze(0);
      v.orbit.theta = 0.75;
      if (!wide) { v.orbit.phi = 1.22; v.orbit.radius *= 0.97; v.orbit.target.y -= 0.22; }
      else { v.orbit.phi = 1.13; v.orbit.radius *= 0.82; v.orbit.target.y -= 0.32; }
      return { name: g.name, rarity: g.rarity, desc: kind === "cat" ? `${g.coat.type} w${g.white} ${g.accessory}${g.flair?.extra ? "+" + g.flair.extra : ""}` : `${g.style} ${g.livery.type} ${g.ornament || ""}` };
    }, { kind, seed, biome, wide });
    await page.waitForTimeout(300);
    const file = path.join(OUT, `${kind}-${seed}.png`);
    await page.screenshot({ path: file, type: "png" });
    tiles.push({ file, seed, ...info });
    console.log(`  ${kind} ${seed}: ${info.name} (${info.rarity}) ${info.desc}`);
  }
  // Contact sheet: a labelled grid so one image shows the whole batch.
  const cols = 4, rows = Math.ceil(tiles.length / cols);
  const W = wide ? 360 : TILE, H = wide ? 240 : TILE, LBL = 26;
  const html = `<body style="margin:0;background:#222"><div style="display:grid;grid-template-columns:repeat(${cols},${W}px);gap:2px">` +
    tiles.map((t) => `<div style="position:relative;width:${W}px;height:${H + LBL}px;background:#111"><img src="data:image/png;base64,${fs.readFileSync(t.file).toString("base64")}" style="display:block;width:${W}px;height:${H}px"><div style="color:#eee;font:12px system-ui;padding:4px 6px;white-space:nowrap;overflow:hidden">${t.seed} ${t.name} · ${t.desc}</div></div>`).join("") + `</div></body>`;
  const sheet = await browser.newPage({ viewport: { width: cols * (W + 2), height: rows * (H + LBL + 2) } });
  await sheet.setContent(html, { waitUntil: "load" });
  await sheet.screenshot({ path: path.join(OUT, `${kind}s.png`), type: "png" });
  await sheet.close();
  console.log(`sheet → ${path.join(OUT, `${kind}s.png`)}`);
}
console.log(errors.length ? `errors: ${JSON.stringify(errors)}` : "no page errors");
await browser.close();
server.close();
