// Headless check for gamepad MENU navigation (src/menupad.js).
// Stubs navigator.getGamepads with a controllable pad and walks the real menu
// flow: A seats the focus ring on the primary action then activates it, the
// d-pad moves the ring spatially, B backs out of flow steps and sheets, and
// the desktop quit buttons appear when the Electron preload bridge exists.
// Runs entirely in the menus — no race, so no SwiftShader shader warm-up.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8107;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (urlPath === "/") urlPath = "/index.html";
  fs.readFile(path.join(ROOT, urlPath), (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + urlPath); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(urlPath)] || "application/octet-stream" });
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
  window.__pad = {
    id: "Fake Pad (STANDARD GAMEPAD)", index: 0, connected: true,
    mapping: "standard", timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  // Model the real API: a pad is INVISIBLE to getGamepads until its first
  // input (Chrome's gesture rule) — the check flips __padVisible on the
  // first press, exactly like a player picking the pad up.
  window.__padVisible = false;
  navigator.getGamepads = () => (window.__padVisible ? [window.__pad] : []);
  // Fake Electron preload bridge: the quit buttons must reveal themselves.
  window.__quitCalls = 0;
  window.zoomiesDesktop = { quit: () => { window.__quitCalls++; } };
  // Frame counter: presses must span real frames — under SwiftShader the
  // menu's first frames take SECONDS while shaders software-compile.
  window.__raf = 0;
  const o = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => o((t) => { window.__raf++; return cb(t); });
});

await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });

// Wait for N MORE rendered frames (not wall time): the menu's first frames
// take seconds under SwiftShader while shaders software-compile, and a
// press only registers if the loop actually ticks while it's down.
async function frames(n, timeoutMs = 120000) {
  const start = await page.evaluate(() => window.__raf);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await page.evaluate(() => window.__raf)) >= start + n) return;
    await page.waitForTimeout(100);
  }
  errors.push(`timeout waiting for ${n} frames`);
}
await frames(10); // menu loop is live and warm

// One press = set, hold across ≥2 real frames, release, settle ≥2 more.
// The first press also EXPOSES the pad, as the real Gamepad API does.
async function press(button) {
  await page.evaluate((b) => {
    window.__padVisible = true;
    window.__pad.buttons[b].pressed = true;
  }, button);
  await frames(2);
  await page.evaluate((b) => { window.__pad.buttons[b].pressed = false; }, button);
  await frames(2);
}
async function check(name, fn, arg) {
  const ok = await page.evaluate(fn, arg);
  if (ok) console.log("ok:", name);
  else {
    const dbg = await page.evaluate(() => ({
      step: document.getElementById("menu")?.dataset.step,
      active: document.querySelector(".flow-screen.is-active")?.id,
      focus: document.querySelector(".pad-focus")?.id || document.querySelector(".pad-focus")?.className,
    }));
    errors.push(`FAIL ${name}: ${JSON.stringify(dbg)}`);
  }
}

// Desktop bridge → quit buttons revealed and wired.
await check("quit buttons revealed for desktop shell", () =>
  !document.getElementById("quit-btn-title").classList.contains("hidden") &&
  !document.getElementById("quit-btn-pause").classList.contains("hidden"));
await page.evaluate(() => document.getElementById("quit-btn-title").click());
await check("quit button calls the bridge", () => window.__quitCalls === 1);

// Before the pad's first input the API hides it — no ring anywhere.
await check("no ring before the pad is touched", () =>
  !document.querySelector(".pad-focus"));

// The pad's FIRST press exposes it. That press must only reveal the ring on
// the title's primary action — never activate an invisible focus.
await press(0);
await check("first pad touch seats the ring on Let's Go! (and only seats it)", () =>
  document.getElementById("start-btn").classList.contains("pad-focus") &&
  document.getElementById("flow-title").classList.contains("is-active"));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});

// Now A presses it: the mode screen slides in…
await press(0);
await check("A advances to the mode screen", () =>
  document.getElementById("flow-mode").classList.contains("is-active"));

// …and the ring is ALREADY on Single race (first non-back button), not the
// back arrow.
await frames(2);
await check("mode screen auto-seats on Single race", () =>
  document.getElementById("mode-gp").classList.contains("pad-focus"));

// Walk down: the ring must MOVE (spatial nav, not stuck).
const before = await page.evaluate(() => document.querySelector("#flow-mode .pad-focus")?.id ?? "");
await press(13);
const after = await page.evaluate(() => document.querySelector("#flow-mode .pad-focus")?.id ?? "");
if (after && after !== before) console.log("ok: d-pad moves focus (", before, "→", after, ")");
else errors.push(`FAIL d-pad moves focus: stayed on '${before}'`);

// A on Single race → the track screen, auto-seated on the FIRST track card
// (Classic circuit).
await page.evaluate(() => document.getElementById("mode-gp").click());
await frames(2);
await check("track screen auto-seats on the first card", () => {
  const f = document.querySelector("#flow-track .pad-focus");
  const first = document.querySelector("#track-grid button");
  return !!f && f === first;
});

// Seating focus mid-slide must never drag the flow sideways: #menu is
// overflow:hidden and a scrollIntoView on a still-translated button scrolls
// it permanently (cut-off headers, stranded panels — the desktop bug).
await frames(6); // let the slide finish
await check("menu container never scrolls sideways", () => {
  const menu = document.getElementById("menu");
  const scr = document.querySelector(".flow-screen.is-active").getBoundingClientRect();
  return menu.scrollLeft === 0 && menu.scrollTop === 0 && Math.abs(scr.left) < 2;
});

// B backs out to the mode screen, then the title.
await press(1);
await press(1);
await check("B backs out to the title", () =>
  document.getElementById("flow-title").classList.contains("is-active"));

// Sheets: open settings — focus auto-seats INSIDE the sheet (on its first
// real control, not the ✕), and B closes it.
await page.evaluate(() => document.getElementById("open-settings").click());
await frames(2);
await check("focus auto-seats in the open sheet", () => {
  const f = document.querySelector("#settings .pad-focus");
  return !!f && f.id !== "settings-back";
});
await press(1);
await check("B closes the sheet", () =>
  document.getElementById("settings").classList.contains("hidden"));

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
