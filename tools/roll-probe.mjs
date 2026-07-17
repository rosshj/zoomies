// In-browser probe for the item-roll distribution: boots a real race, forces a
// kart's place to 1st / 3rd / 6th, drives grantItem 300× each via the __zoomies
// debug hook, and prints the observed percentages next to the design table in
// main.js (ITEM_ROLL). Also asserts the floating-box pool size. Needs the local
// Playwright chromium (like headless-check); not part of CI.
// Run: node tools/roll-probe.mjs
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = "/home/user/zoomies", PORT = 8092;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/index.html"; if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; } fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1&seed=ROLLS`, { waitUntil: "load" });
await page.waitForSelector("#start-btn", { timeout: 20000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let t = 0; t < 150; t++) { const txt = await page.textContent("#fps-counter").catch(() => ""); if (/\d+\s*FPS/.test(txt || "")) break; await page.waitForTimeout(1000); }
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const z = window.__zoomies;
  const k = z.karts[1];
  const run = (place) => {
    k.place = place;
    const c = { shield: 0, milk: 0, yarn: 0, tri: 0, life: 0, laser: 0, catnip: 0 };
    for (let i = 0; i < 300; i++) {
      const b = { s: k.shieldTimer, m: k.milkBottles, y: k.yarnShots, t: k.triShots, l: k.lives, z: k.laserTimer, c: k.catnipTimer };
      k.boxCooldown = 0;
      z.grantItem(k);
      if (k.shieldTimer > b.s) c.shield++;
      else if (k.milkBottles > b.m) c.milk++;
      else if (k.yarnShots > b.y) c.yarn++;
      else if (k.triShots > b.t) c.tri++;
      else if (k.lives > b.l) c.life++;
      else if (k.laserTimer > b.z) c.laser++;
      else if (k.catnipTimer > b.c) c.catnip++;
      k.shieldTimer = 0; k.milkBottles = 0; k.yarnShots = 0; k.triShots = 0; k.lives = 0; k.laserTimer = 0; k.catnipTimer = 0;
    }
    for (const key in c) c[key] = Math.round((c[key] / 300) * 100);
    return c;
  };
  const boxes = z.props ? z.props.boxTargets().length : -1;
  return { boxes, p1: run(1), p3: run(3), p6: run(6) };
});
console.log("floating boxes on classic map:", out.boxes);
console.log("1st:", JSON.stringify(out.p1));
console.log("3rd:", JSON.stringify(out.p3));
console.log("6th:", JSON.stringify(out.p6));
console.log("errors:", JSON.stringify(errors));
const ok = out.boxes === 5 && out.p1.catnip === 0 && out.p1.shield > 20 && out.p6.catnip > 40 && out.p3.laser > 12 && errors.length === 0;
console.log(ok ? "ROLL PROBE: PASS" : "ROLL PROBE: FAIL");
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
