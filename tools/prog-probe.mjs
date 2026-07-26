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
  const teased = earnings ? earnings.querySelectorAll(".earn-ach").length : 0;
  const total = earnings ? [...earnings.querySelectorAll(".earn-total span")].map((e) => e.textContent).join(" ") : "";
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("zoomies-profile-v1")); } catch {}
  return {
    finished: ok,
    earningsVisible: earnings && !earnings.classList.contains("hidden"),
    rows, teased, total,
    preClaimTreats: saved ? saved.treats : -1,
    pending: saved ? saved.pendingClaims : [],
    savedRaces: saved ? saved.stats.races : -1,
    achievements: saved ? saved.achievements : [],
    starterUnlocks: saved ? saved.unlocked.length : 0,
  };
});
// Leaving the results must detour through the claim interstitial: cards up,
// Continue hidden until every badge is tapped.
await page.click("#results-menu-btn", { force: true });
await page.waitForTimeout(300);
const inter = await page.evaluate(() => ({
  shown: !document.getElementById("claim-screen")?.classList.contains("hidden"),
  cards: document.querySelectorAll("#claim-list .claim-card").length,
  continueHidden: document.getElementById("claim-continue")?.classList.contains("hidden"),
}));
for (const b of await page.$$("#claim-list .claim-card:not(.claimed)")) await b.click({ force: true }).catch(() => {});
await page.waitForTimeout(300);
const after = await page.evaluate(() => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("zoomies-profile-v1")); } catch {}
  return {
    chip: document.getElementById("treats-balance")?.textContent,
    savedTreats: saved ? saved.treats : -1,
    pendingLeft: saved ? saved.pendingClaims.length : -1,
    sparkled: !!document.querySelector("#claim-list .claim-card.claimed"),
    continueVisible: !document.getElementById("claim-continue")?.classList.contains("hidden"),
  };
});
await page.click("#claim-continue", { force: true }).catch(() => {});
await page.waitForTimeout(400);
const landed = await page.evaluate(() => ({
  claimGone: document.getElementById("claim-screen")?.classList.contains("hidden"),
  menuVisible: !document.getElementById("menu")?.classList.contains("hidden"),
}));
const buy = await page.evaluate(async () => {
  document.getElementById("open-catalog")?.click();
  const tile = document.querySelector("#catalog-prizes .prize-tile.buyable");
  if (!tile) return { step: "no-buyable-tile" };
  const before = JSON.parse(localStorage.getItem("zoomies-profile-v1"));
  tile.click(); // arm the in-tile confirm
  const yes = tile.querySelector(".pc-yes");
  if (!yes) return { step: "no-confirm", treats: before.treats };
  yes.click();
  await new Promise((r) => setTimeout(r, 150));
  const saved = JSON.parse(localStorage.getItem("zoomies-profile-v1"));
  return {
    step: "bought",
    owned: tile.classList.contains("owned"),
    sparkles: tile.querySelectorAll(".sparkle").length > 0,
    spent: before.treats - saved.treats,
    unlockedGrew: saved.unlocked.length > before.unlocked.length,
  };
});
console.log(JSON.stringify({ ...out, inter, ...after, landed, buy }, null, 1));
console.log("errors:", JSON.stringify(errors));
const pass = out.finished && out.earningsVisible && out.rows >= 2 && out.teased >= 1 &&
  out.preClaimTreats > 0 && out.pending.includes("first-race") &&
  out.savedRaces === 1 && out.achievements.includes("first-race") &&
  inter.shown && inter.cards === out.pending.length && inter.continueHidden &&
  after.savedTreats > out.preClaimTreats && after.pendingLeft === 0 && after.sparkled && after.continueVisible &&
  Number(after.chip) === after.savedTreats &&
  landed.claimGone && landed.menuVisible &&
  buy.step === "bought" && buy.owned && buy.sparkles && buy.spent > 0 && buy.unlockedGrew &&
  errors.length === 0;
console.log(pass ? "PROGRESSION PROBE: PASS" : "PROGRESSION PROBE: FAIL");
await browser.close(); server.close(); process.exit(pass ? 0 : 1);
