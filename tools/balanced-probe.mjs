// One-off probe for the Balanced quality tier (between Low and Medium).
// Boots once per tier and samples the levers straight off the live objects:
// Low = bare verge + lean post + 1.25 DPR cap; Balanced = LIVING world
// (grass, motes) + lean post + 1.5 cap; Medium = everything + 2.0 cap.
//   node tools/balanced-probe.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8119;
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
let bad = 0;
const check = (name, ok, dbg) => {
  console.log(ok ? "ok:" : "FAIL:", name, ok ? "" : JSON.stringify(dbg));
  if (!ok) bad++;
};

const out = {};
for (const tier of ["low", "balanced", "medium"]) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.error("PAGEERROR:", e.message); bad++; });
  await ctx.addInitScript((q) => {
    try { localStorage.setItem("zoomies-quality-v2", q); } catch {}
  }, tier);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
  await page.waitForSelector("#start-btn", { timeout: 60000 });
  await page.waitForFunction(() => window.__zoomies?.world && window.__zoomies?.renderer?.getPixelRatio, null, { timeout: 60000 });
  out[tier] = await page.evaluate(() => {
    const Z = window.__zoomies;
    return {
      grass: !!Z.world.grass && Z.world.grass.visible,
      dpr: +Z.renderer.getPixelRatio().toFixed(2),
      active: ["low", "balanced", "medium", "high"].find((q) =>
        document.getElementById(`set-quality-${q}`)?.classList.contains("is-active")),
    };
  });
  console.log(tier, JSON.stringify(out[tier]));
  await ctx.close();
}
check("low keeps the bare verge", out.low.grass === false && out.low.active === "low", out.low);
check("low caps DPR at 1.25", out.low.dpr <= 1.25, out.low);
check("balanced brings the world back", out.balanced.grass === true && out.balanced.active === "balanced", out.balanced);
check("balanced caps DPR at 1.5", out.balanced.dpr <= 1.5 && out.balanced.dpr > 1.25, out.balanced);
check("medium unchanged (grass + full DPR)", out.medium.grass === true && out.medium.dpr === 2 && out.medium.active === "medium", out.medium);
await browser.close();
server.close();
process.exit(bad ? 1 : 0);
