// Headless check for local split screen (Versus 2P).
// Boots as the desktop shell (fake zoomiesDesktop bridge + persisted "split"
// mode), starts a race via the race-again shortcut, then drives P1 on a
// stubbed gamepad and P2 on the real keyboard and asserts the whole seam:
// two human karts in a six-kart field, both accelerating independently, the
// per-half chips updating, and the two-humans finish gate reaching a Versus
// results screen with no economy payout.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8114;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (u === "/") u = "/index.html";
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + u); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await ctx.addInitScript(() => {
  try { localStorage.setItem("zoomies-fps", "1"); } catch {}
  try { localStorage.setItem("zoomies-mode-v1", "split"); } catch {}
  // P2's startline pick (persisted): Snow (cat 3) in Clover (kart 2).
  try { localStorage.setItem("zoomies-p2-racer", JSON.stringify({ cat: 3, kart: 2 })); } catch {}
  window.zoomiesDesktop = { quit: () => {} }; // the shell bridge gates the mode
  // P1's controller (visible from boot — the check drives it, not a human).
  window.__pad = {
    id: "Fake Pad (STANDARD GAMEPAD)", index: 0, connected: true,
    mapping: "standard", timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  navigator.getGamepads = () => [window.__pad];
});

await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 60000 });
await page.evaluate(() => document.getElementById("restart-btn").click());

// Wait for ACTUAL racing, not just the HUD (the veil + countdown burn off
// slowly under SwiftShader and controls stay locked until GO): the AI karts
// gunning it off the line is the unambiguous signal.
const WARMUP = Number(process.argv[2] || 240);
let racing = false;
for (let t = 0; t < WARMUP; t++) {
  const moving = await page.evaluate(() =>
    (window.__zoomies.karts || []).some((k) => !k.isPlayer && Math.abs(k.speed) > 1)
  ).catch(() => false);
  if (moving) { racing = true; break; }
  await page.waitForTimeout(1000);
}
if (!racing) errors.push("race never reached GO within " + WARMUP + "s");

const check = (name, ok, dbg) => {
  if (ok) console.log("ok:", name);
  else errors.push(`FAIL ${name}: ${JSON.stringify(dbg)}`);
};

// The split seam is live: two humans in a six-kart field, split HUD up.
const seam = await page.evaluate(() => {
  const z = window.__zoomies;
  const humans = z.karts.filter((k) => k.isPlayer);
  return {
    split: z.split(),
    karts: z.karts.length,
    humans: humans.length,
    names: humans.map((k) => k.name),
    hudSplit: document.getElementById("hud").classList.contains("split"),
    chipsShown: !document.getElementById("split-hud").classList.contains("hidden"),
  };
});
check("split race is active", seam.split.active && seam.split.p2, seam);
check("six karts, two humans", seam.karts === 6 && seam.humans === 2, seam);
check("split HUD is up", seam.hudSplit && seam.chipsShown, seam);
check("P2 wears the startline pick (Snow · Clover)", seam.names.includes("Snow (P2)"), seam);

// Drive: P1 holds RT (pad), P2 holds ArrowUp (keyboard). Both must move —
// independently (P2's key must not budge P1).
await page.evaluate(() => { const b = window.__pad.buttons[7]; b.pressed = true; b.value = 1; });
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(9000);
const drive = await page.evaluate(() => {
  const z = window.__zoomies;
  const p1 = z.karts.find((k) => k.name === "Player 1");
  const p2 = z.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name));
  return { s1: p1.speed, s2: p2.speed, chip1: document.getElementById("split-p1").textContent, chip2: document.getElementById("split-p2").textContent };
});
check("both humans accelerate independently", drive.s1 > 3 && drive.s2 > 3, drive);
check("per-half chips are live", /^P1 · Lap/.test(drive.chip1) && /^P2 · Lap/.test(drive.chip2), drive);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
await page.keyboard.up("ArrowUp");
await page.evaluate(() => { const b = window.__pad.buttons[7]; b.pressed = false; b.value = 0; });

// Finish both humans → Versus results: winner title, both rows lit, no payout.
await page.evaluate(() => window.__zoomies.debugFinish());
await page.waitForTimeout(1500);
const fin = await page.evaluate(() => ({
  results: !document.getElementById("results").classList.contains("hidden"),
  title: document.getElementById("results-title").textContent,
  youRows: document.querySelectorAll("#results-list .you").length,
  earningsHidden: document.getElementById("results-earnings")?.classList.contains("hidden") ?? true,
}));
check("versus results with a winner title", fin.results && /Player [12] Wins/.test(fin.title), fin);
check("both human rows highlighted", fin.youRows === 2, fin);
check("no treats paid for a couch match", fin.earningsHidden, fin);

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
