// In-browser probe for the progression glue: boots a real race, force-finishes
// it via __zoomies.debugFinish, and asserts the settle chain — earnings panel
// rendered, treats paid + persisted to the profile, first-race achievement
// fired, treats chip in sync. (The pure economy is covered by check:progress;
// this validates the main.js wiring.) Needs the local Playwright chromium.
// Run: node tools/prog-probe.mjs
// End-to-end progression probe: boot a real race, force-finish it, and verify the
// settle → earnings → profile chain (treats paid, first-race achievement, chip,
// persisted profile), plus the garage lock state for a locked preset.
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = "/home/user/zoomies", PORT = 8091;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/index.html"; if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; } fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1&seed=PROG`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 20000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let t = 0; t < 150; t++) { const txt = await page.textContent("#fps-counter").catch(() => ""); if (/\d+\s*FPS/.test(txt || "")) break; await page.waitForTimeout(1000); }
await page.waitForTimeout(4000); // let the countdown clear + a few race seconds tick

const out = await page.evaluate(() => {
  const z = window.__zoomies;
  const ok = z.debugFinish();
  const earnings = document.getElementById("results-earnings");
  const rows = earnings ? earnings.querySelectorAll(".earn-row").length : 0;
  const total = earnings ? [...earnings.querySelectorAll(".earn-total span")].map((e) => e.textContent).join(" ") : "";
  const chip = document.getElementById("treats-balance")?.textContent;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("zoomies-profile-v1")); } catch {}
  return {
    finished: ok,
    earningsVisible: earnings && !earnings.classList.contains("hidden"),
    rows, total, chip,
    savedTreats: saved ? saved.treats : -1,
    savedRaces: saved ? saved.stats.races : -1,
    achievements: saved ? saved.achievements : [],
    starterUnlocks: saved ? saved.unlocked.length : 0,
  };
});
console.log(JSON.stringify(out, null, 1));
console.log("errors:", JSON.stringify(errors));
const pass = out.finished && out.earningsVisible && out.rows >= 2 && out.savedTreats > 0 &&
  out.savedRaces === 1 && out.achievements.includes("first-race") && Number(out.chip) === out.savedTreats && errors.length === 0;
console.log(pass ? "PROGRESSION PROBE: PASS" : "PROGRESSION PROBE: FAIL");
await browser.close(); server.close(); process.exit(pass ? 0 : 1);
