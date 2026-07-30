// One-off A/B probe for the High graphics tier. Boots the game twice with
// zoomies-quality-v2 seeded "medium" then "high", starts a race, pins the
// camera on the exact same world framing, and shoots both — so the fog push,
// the denser grass verges and the real (quad-less) kart shadows can be
// compared with nothing else different. Also samples the tier's knobs
// (camera.far, fog, shadow autoUpdate, grass instance count, kart casters)
// so a silent regression shows up as numbers, not just pixels.
//   node tools/high-ab-probe.mjs   ->  shots + metrics in $OUT (default /tmp/high-ab)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/high-ab";
const PORT = 8117;
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

const results = {};
for (const tier of ["medium", "high"]) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("ERR:", m.text().slice(0, 200)); });
  await ctx.addInitScript((q) => {
    try { localStorage.setItem("zoomies-fps", "1"); } catch {}
    try { localStorage.setItem("zoomies-quality-v2", q); } catch {}
  }, tier);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });

  // Walk the menu flow (title -> mode -> track -> cat -> kart -> start line).
  await page.waitForSelector("#start-btn", { timeout: 60000 });
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
  for (let t = 0; t < 120; t++) {
    const live = await page.evaluate(() =>
      (window.__zoomies?.karts || []).some((k) => !k.isPlayer && Math.abs(k.speed) > 1));
    if (live) break;
    await page.waitForTimeout(1000);
  }

  // Pin the shot: park the camera above the player's grid slot looking down
  // the track — the long sightline is where the fog push and the far plane
  // show. Grass forced on (adaptive quality hides it at SwiftShader rates).
  const metrics = await page.evaluate(() => {
    const Z = window.__zoomies;
    if (Z.world.grass) {
      Object.defineProperty(Z.world.grass, "visible", { get: () => true, set: () => {}, configurable: true });
    }
    const player = Z.karts.find((k) => k.isPlayer);
    const t = player.trackT ?? 0;
    const a = Z.track.getPointAt(t);
    const b = Z.track.getPointAt((t + 0.03) % 1);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const cam = Z.camera;
    cam.position.set(a.x - (dx / l) * 14, a.y + 7, a.z - (dz / l) * 14);
    cam.lookAt(a.x + (dx / l) * 60, a.y + 2, a.z + (dz / l) * 60);
    cam.updateMatrixWorld(true);
    cam.position.copy = function () { return this; }; // the race loop can't move it
    cam.lookAt = () => {};
    // Tier knobs, straight off the live objects.
    let grass = 0;
    Z.world.grass?.traverse((o) => { if (o.isInstancedMesh) grass += o.count; });
    let casters = 0;
    player.group.traverse((o) => { if (o.isMesh && o.castShadow) casters++; });
    const sun = Z.scene.children.find((o) => o.isDirectionalLight && o.castShadow);
    return {
      far: cam.far,
      fogNear: Math.round(Z.scene.fog.near),
      fogFar: Math.round(Z.scene.fog.far),
      shadowAuto: sun ? sun.shadow.autoUpdate : null,
      grass,
      kartCasters: casters,
      quadVisible: player.groundShadow ? player.groundShadow.visible : null,
    };
  });
  await page.waitForTimeout(2500); // let a few pinned frames land
  await page.screenshot({ path: path.join(OUT, `${tier}.png`) });
  console.log(tier, JSON.stringify(metrics));
  results[tier] = metrics;
  await ctx.close();
}

// The contract: High pushes far/fog/density and swaps quad → real casters;
// Medium stays exactly the shipping look.
const m = results.medium, h = results.high;
const checks = [
  ["medium keeps today's draw distance", m.far === 2050 && m.shadowAuto === false],
  ["medium keeps the projected quad", m.quadVisible === true && m.kartCasters === 0],
  ["high pushes the far plane", h.far === 2600],
  ["high pushes the fog out", h.fogFar > m.fogFar * 1.2],
  ["high re-renders the sun shadow per frame", h.shadowAuto === true],
  ["high karts really cast (quad hidden)", h.quadVisible === false && h.kartCasters > 4],
  ["high builds denser grass", h.grass > m.grass * 1.5],
];
let bad = 0;
for (const [name, ok] of checks) { console.log(ok ? "ok:" : "FAIL:", name); if (!ok) bad++; }
console.log("wrote", fs.readdirSync(OUT).sort().join(" "));
await browser.close();
server.close();
process.exit(bad ? 1 : 0);
