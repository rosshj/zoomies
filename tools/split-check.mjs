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

const SPLITFX = process.env.SPLITFX === "1";
await ctx.addInitScript((fx) => {
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
  // SPLITFX=1: exercise the full-post-chain split path ("Versus effects").
  if (fx) try { localStorage.setItem("zoomies-splitfx", "1"); } catch {}
}, SPLITFX);

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
// The split cams must SEE what the game camera sees: scenery lives on layer
// 1 and grass on layer 2, and a default-layer camera renders a bare world
// (the 'level looks emptied' bug — trees cast shadows but never drew).
const layers = await page.evaluate(() => {
  const z = window.__zoomies;
  const cams = z.splitCams();
  return { c1: cams.c1.layers.mask, c2: cams.c2.layers.mask, main: z.camera.layers.mask };
});
check("split cams share the game camera's layer mask",
  layers.c1 === layers.main && layers.c2 === layers.main, layers);
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

// The two halves must be DIFFERENT views (a per-frame pass cache once served
// P1's render to both halves). Capture the canvas in the same rAF task as
// the render (post-composite readback is blank) and compare the halves.
const halvesDiff = await page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const gl = window.__zoomies.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = Math.max(64, Math.floor(gl.width / 4));
    c.height = Math.max(64, Math.floor(gl.height / 4));
    const x = c.getContext("2d");
    x.drawImage(gl, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const h = Math.floor(c.height / 2);
    let sum = 0, n = 0;
    for (let y = 8; y < h - 8; y++) {
      for (let px = 10; px < c.width - 10; px++) {
        const a = (y * c.width + px) * 4;
        const b = ((y + h) * c.width + px) * 4;
        sum += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]);
        n++;
      }
    }
    resolve(sum / Math.max(1, n));
  });
}));
check("the two halves show different views", halvesDiff > 4, { halvesDiff: Math.round(halvesDiff * 100) / 100 });
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
await page.keyboard.up("ArrowUp");

// PAIRING: P1's view must be the TOP half. With only P1 (pad) driving, the
// top half's image changes far more over time than idle P2's bottom half —
// a translating chase cam vs a parked one. This is the fence for the
// setViewport y-origin flip (WebGPU measures y from the TOP; GL-convention
// rects rendered every view into the OTHER half, so the player read the
// other seat's chip — the reported "always 6th").
const snap = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const gl = window.__zoomies.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = 160; c.height = 100;
    c.getContext("2d").drawImage(gl, 0, 0, 160, 100);
    resolve([...c.getContext("2d").getImageData(0, 0, 160, 100).data]);
  });
}));
// Let P2 coast to a stop first (only P1's throttle is still held).
for (let t = 0; t < 30; t++) {
  const s2 = await page.evaluate(() =>
    Math.abs(window.__zoomies.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name)).speed));
  if (s2 < 2) break;
  await page.waitForTimeout(1000);
}
const snapA = await snap();
await page.waitForTimeout(3000);
const snapB = await snap();
const tdiff = (y0, y1) => {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let px = 8; px < 152; px++) {
      const a = (y * 160 + px) * 4;
      sum += Math.abs(snapA[a] - snapB[a]) + Math.abs(snapA[a + 1] - snapB[a + 1]);
      n++;
    }
  }
  return sum / Math.max(1, n);
};
const pairing = { top: +tdiff(4, 46).toFixed(2), bottom: +tdiff(54, 96).toFixed(2) };
check("P1's (driving) view is the TOP half", pairing.top > pairing.bottom * 1.25, pairing);
await page.evaluate(() => { const b = window.__pad.buttons[7]; b.pressed = false; b.value = 0; });

// Placement must respond to real progress: warp P2 a third of a lap ahead of
// the pack and the place chip must read 1st (the machinery the 'always 6th'
// report questioned).
// Move the kart bodily along the track (position only — placeAt is a GRID
// call that resets the lap counter). The real per-frame lap detector then
// sees the wrap-around crossing exactly as it would from driving.
const warp = async (dt) => page.evaluate((d) => {
  const z = window.__zoomies;
  const p2 = z.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name));
  const t = ((p2.trackT ?? 0) + d) % 1;
  const a = z.track.getPointAt(t);
  const b = z.track.getPointAt((t + 0.002) % 1);
  p2.position.set(a.x, a.y + 0.5, a.z);
  p2.heading = Math.atan2(b.x - a.x, b.z - a.z);
  p2.speed = 20;
}, dt);
await warp(0.35);
await page.waitForTimeout(1200);
const placed = await page.evaluate(() => {
  const p2 = window.__zoomies.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name));
  return { place: p2.place, prog: +p2.totalProgress.toFixed(2), chip: document.getElementById("split-p2").textContent };
});
check("warped-ahead P2 is ranked 1st", placed.place === 1 && /1st/.test(placed.chip), placed);

// Bring P2 one line-crossing from home (lap preset), then warp it across so
// the NATURAL finish path runs (crossing detector → finished → grace clock
// arms for the still-racing P1; expiry ends the race, P1 scored DNF).
await page.evaluate(() => {
  const z = window.__zoomies;
  const p2 = z.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name));
  p2.lap = z.track.totalLaps - 1;
});
for (let i = 0; i < 30; i++) {
  await warp(0.22);
  await page.waitForTimeout(350);
  const fin = await page.evaluate(() =>
    window.__zoomies.karts.find((k) => k.isPlayer && /\(P2\)$/.test(k.name)).finished);
  if (fin) break;
}
const gr = await page.evaluate(() => window.__zoomies.split());
check("P2 finished naturally and the grace clock armed", gr.grace !== null && gr.grace > 0, gr);
await page.evaluate(() => window.__zoomies.debugGrace(-0.1)); // expire NOW (SwiftShader frames are ~1fps by this point)
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const done = await page.evaluate(() =>
    !document.getElementById("results").classList.contains("hidden"));
  if (done) break;
}
const fin = await page.evaluate(() => ({
  results: !document.getElementById("results").classList.contains("hidden"),
  title: document.getElementById("results-title").textContent,
  rows: [...document.querySelectorAll("#results-list li")].map((li) => li.textContent),
  youRows: document.querySelectorAll("#results-list .you").length,
  earningsHidden: document.getElementById("results-earnings")?.classList.contains("hidden") ?? true,
}));
check("grace expiry ends the race with P2 the winner", fin.results && /Player 2 Wins/.test(fin.title), fin);
check("idle P1 scored DNF", fin.rows.some((r) => /Player 1/.test(r) && /DNF/.test(r)), fin);
check("both human rows highlighted", fin.youRows === 2, fin);
check("no treats paid for a couch match", fin.earningsHidden, fin);

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
