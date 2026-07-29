// Headless gamepad check for Zoomies GP.
// The Gamepad API can't be exercised by Playwright directly, so this stubs
// navigator.getGamepads with a controllable fake pad (window.__pad), starts a
// race the same way headless-check.mjs does, then drives the stick/triggers/
// buttons and asserts the Input class responds: steering sign + recentre,
// analog throttle + release-to-neutral, hop hold, shoot charge, and the
// one-action-at-a-time rule (shield press cancels a shoot charge).
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8103;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(ROOT, urlPath);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + urlPath); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
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
  // Controllable fake pad. Standard mapping: buttons[6]/[7] are the analog
  // triggers, so every button carries both `pressed` and `value`.
  window.__pad = {
    id: "Fake Pad (STANDARD GAMEPAD Vendor: beef Product: feed)",
    index: 0, connected: true, mapping: "standard", timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  navigator.getGamepads = () => [window.__pad];
});

const target = `http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`;
await page.goto(target, { waitUntil: "load", timeout: 150000 });

await page.waitForSelector("#start-btn", { timeout: 15000 });
// The title PLAY button only advances the menu flow (mode → track → racer →
// startline), so drive startRace() directly through the race-again button's
// handler — a synthetic click works even while its overlay is hidden.
await page.evaluate(() => document.getElementById("restart-btn").click());

// input.update() only runs once the countdown ends and the race loop is in
// RACING; the HUD un-hiding + FPS readout is the "loop is live" signal
// (SwiftShader warm-up is slow).
const WARMUP = Number(process.argv[2] || 120);
let populated = false;
for (let t = 0; t < WARMUP; t++) {
  const hud = await page.getAttribute("#hud", "class").catch(() => "hidden");
  const txt = await page.textContent("#fps-counter").catch(() => "");
  if (!/hidden/.test(hud ?? "") && /\d+\s*FPS/.test(txt || "")) { populated = true; break; }
  await page.waitForTimeout(1000);
}
if (!populated) errors.push("race never reached RACING (hud stayed hidden) within " + WARMUP + "s");

const setPad = (fn) => page.evaluate(fn);
const readInput = () => page.evaluate(() => {
  const i = window.__zoomies?.input;
  return i ? {
    steer: i.steer, throttle: i.throttle,
    jumpHeld: i.jumpHeld, shootHeld: i.shootHeld, shielding: i.shielding,
  } : null;
});
// Poll until the predicate holds — steering smooths toward its target over a
// few frames, so a fixed sleep would be either flaky or slow.
async function expect(name, pred, ms = 5000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await readInput();
    if (last && pred(last)) { console.log("ok:", name); return; }
    await page.waitForTimeout(100);
  }
  errors.push(`FAIL ${name}: ${JSON.stringify(last)}`);
}

// Stick left → steer positive (the ArrowLeft convention), full lock. Long
// window: update() only runs once the countdown veil lifts and RACING begins,
// and under SwiftShader the shader-compile veil alone takes ~60-90s.
await setPad(() => { window.__pad.axes[0] = -1; });
await expect("stick left steers left", (s) => s.steer > 0.6, 150000);

// Stick right → negative.
await setPad(() => { window.__pad.axes[0] = 1; });
await expect("stick right steers right", (s) => s.steer < -0.6);

// Inside the deadzone → recentres.
await setPad(() => { window.__pad.axes[0] = 0.05; });
await expect("stick release recentres", (s) => Math.abs(s.steer) < 0.1);

// Half deflection lands between deadzone and full lock (analog, not digital).
await setPad(() => { window.__pad.axes[0] = -0.6; });
await expect("stick is analog", (s) => s.steer > 0.2 && s.steer < 0.9);
await setPad(() => { window.__pad.axes[0] = 0; });

// RT → full throttle; release → neutral; LT → reverse.
await setPad(() => { const b = window.__pad.buttons[7]; b.pressed = true; b.value = 1; });
await expect("RT accelerates", (s) => s.throttle === 1);
await setPad(() => { const b = window.__pad.buttons[7]; b.pressed = false; b.value = 0; });
await expect("RT release coasts", (s) => s.throttle === 0);
await setPad(() => { const b = window.__pad.buttons[6]; b.pressed = true; b.value = 0.5; });
await expect("LT is analog brake", (s) => s.throttle === -0.5);
await setPad(() => { const b = window.__pad.buttons[6]; b.pressed = false; b.value = 0; });

// A hold sustains (drift), release lets go.
await setPad(() => { window.__pad.buttons[0].pressed = true; });
await expect("A holds jump", (s) => s.jumpHeld);
await setPad(() => { window.__pad.buttons[0].pressed = false; });
await expect("A release drops jump", (s) => !s.jumpHeld);

// X charges a shot; pressing shield mid-charge cancels it (one-thumb rule).
await setPad(() => { window.__pad.buttons[2].pressed = true; });
await expect("X charges shot", (s) => s.shootHeld);
await setPad(() => { window.__pad.buttons[4].pressed = true; });
await expect("shield cancels charge", (s) => s.shielding && !s.shootHeld);
await setPad(() => { window.__pad.buttons[2].pressed = false; window.__pad.buttons[4].pressed = false; });
await expect("shield release lowers it", (s) => !s.shielding);

// D-pad steers digitally at full lock.
await setPad(() => { window.__pad.buttons[14].pressed = true; });
await expect("d-pad left steers left", (s) => s.steer > 0.6);
await setPad(() => { window.__pad.buttons[14].pressed = false; });

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
