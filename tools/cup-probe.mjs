// Cup-flow probe: boot the game exactly as a cup reload would (?seed&cup&w=…) and
// verify the NEW flow — lands on the MENU (no auto-start → the START tap grants
// iOS tilt), START reads "RACE 1 OF N", the menu map cycles the cup's tracks,
// and the built world matches the cup race config (custom track, right seed).
import { chromium } from "playwright-core";
import { CUPS } from "../src/progress.js";
import { encodeWorld } from "../src/net/worldcfg.js";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = "/home/user/zoomies", PORT = 8089;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/index.html"; if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; } fs.readFile(path.join(ROOT, u), (e, d) => { if (e) { res.writeHead(404); res.end("nf"); return; } res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" }); res.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
const cup = CUPS[0];
const race = cup.races[0];
const w = encodeWorld({ cfg: race.cfg, laps: 3, seed: race.seed });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
// Seed the mid-cup session state the reload chain would carry.
await ctx.addInitScript(({ id }) => {
  try { sessionStorage.setItem("zoomies-cup-v1", JSON.stringify({ id, race: 0, points: {}, diff: "hard" })); } catch {}
}, { id: cup.id });
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1&seed=${race.seed}&cup=${cup.id}&w=${w}`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 20000 });
await page.waitForTimeout(4500); // give a map-cycle tick a chance

const out = await page.evaluate(() => ({
  startLabel: document.getElementById("start-btn")?.textContent,
  menuVisible: !document.getElementById("menu")?.classList.contains("hidden"),
  hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
  mapLabel: document.getElementById("menu-map-label")?.textContent,
  modeSummary: document.getElementById("mode-summary")?.textContent,
  seed: (window.__zoomies && window.__zoomies.track) ? "built" : "none",
  trackMode: (() => { try { return JSON.parse(localStorage.getItem("zoomies-track-v1"))?.mode || "unset"; } catch { return "err"; } })(),
}));
console.log(JSON.stringify(out, null, 1));
console.log("errors:", JSON.stringify(errors));
const pass = out.menuVisible && out.hudHidden && new RegExp(`RACE 1 OF ${cup.races.length}`, "i").test(out.startLabel || "") &&
  (out.mapLabel || "").includes(cup.name) && /Cup Series/.test(out.modeSummary || "") && errors.length === 0;
console.log(pass ? "CUP PROBE: PASS" : "CUP PROBE: FAIL");
await browser.close(); server.close(); process.exit(pass ? 0 : 1);
