// Atlas probe — walks the whole exploration loop headlessly and screenshots
// each screen so it can be LOOKED at: the Explore card, the map, a cell's
// card, the reload into the cell's world, a forced finish, the results rows,
// the naming + hatch ceremony, then the map again (cell won, neighbours open)
// and the cat grid with the found resident selectable.
//   node tools/atlas-probe.mjs      -> shots in $OUT (default /tmp/atlas)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/atlas";
const PORT = 8121;
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
const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 240)); });
const shot = (n) => page.screenshot({ path: path.join(OUT, n + ".png") });
const url = `http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`;
await page.goto(url, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 60000 });
await page.waitForTimeout(1200);
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#start-btn");
await page.waitForTimeout(700);
await shot("1-mode");
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#mode-explore");
await page.waitForTimeout(2500);
await shot("2-atlas");
const card = await page.evaluate(() => ({
  name: document.getElementById("atlas-name")?.textContent, addr: document.getElementById("atlas-addr")?.textContent,
  where: document.getElementById("atlas-where")?.textContent, what: document.getElementById("atlas-what")?.textContent,
  status: document.getElementById("atlas-status")?.textContent, res: document.getElementById("atlas-resident")?.textContent,
  open: document.querySelectorAll(".atlas-cell.open").length, fog: document.querySelectorAll(".atlas-cell.fog").length,
}));
console.log("atlas card:", JSON.stringify(card));
// Race here → saves the cell recipe and reloads into it, resuming at the cat step.
await Promise.all([
  page.waitForNavigation({ waitUntil: "load", timeout: 150000 }),
  page.click("#atlas-race", { force: true }),
]);
await page.waitForSelector("#cat-grid button", { state: "attached", timeout: 90000 });
await page.waitForTimeout(1500);
const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-track-v1")));
console.log("built recipe:", JSON.stringify(cfg));
await shot("3-cat-step");
// Trace every write to the start note (first visit showed it empty once).
await page.evaluate(() => {
  const n = document.getElementById("start-note");
  window.__noteLog = [];
  const proto = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  Object.defineProperty(n, "textContent", { set(v) { window.__noteLog.push([String(v).slice(0, 60), new Error().stack.split("\n")[2]?.trim()]); proto.set.call(this, v); }, get() { return proto.get.call(this); }, configurable: true });
});
// Walk cat → kart → start line, then GO.
for (let step = 0; step < 6; step++) {
  await page.waitForTimeout(600);
  const done = await page.evaluate(() => {
    if (document.querySelector(".flow-screen.is-active")?.id === "flow-startline") return true;
    const screen = document.querySelector(".flow-screen.is-active");
    const pick = [...(screen?.querySelectorAll("button.tap-card") || [])].filter((e) => e.offsetParent)[0];
    if (pick) pick.click();
    return false;
  });
  if (done) break;
}
await page.waitForTimeout(500);
const startNote = await page.evaluate(() => ({ note: document.getElementById("start-note")?.textContent, noteCls: document.getElementById("start-note")?.className, mode: window.__zoomies.garage.raceMode, cell: window.__zoomies.garage.trackConfig.cell, map: document.getElementById("menu-map-label")?.textContent, diff: document.querySelector("#diff-seg .is-active, #diff-seg .seg-btn.active")?.textContent }));
console.log("start line:", JSON.stringify(startNote));
console.log("note writes:", JSON.stringify(await page.evaluate(() => window.__noteLog)));
await shot("4-startline");
await page.evaluate(() => document.getElementById("go-btn").click());
// Wait for the race to be live, then force the finish.
for (let t = 0; t < 60; t++) {
  const live = await page.evaluate(() => typeof window.__zoomies?.debugFinish === "function" && (window.__zoomies?.world?.grass?.userData?.uKart?.value?.x ?? 1e6) < 1e5);
  if (live) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(4500); // through the countdown
await shot("5-racing");
const finished = await page.evaluate(() => window.__zoomies.debugFinish());
console.log("debugFinish:", finished);
await page.waitForSelector("#results:not(.hidden)", { timeout: 40000 });
await page.waitForTimeout(800);
const earn = await page.evaluate(() => [...document.querySelectorAll("#results-earnings .earn-row")].map((r) => r.textContent).join(" | "));
console.log("earnings:", earn);
await shot("6-results");
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#results-menu-btn");
await page.waitForTimeout(800);
const claimUp = await page.evaluate(() => !document.getElementById("atlas-claim").classList.contains("hidden"));
console.log("atlas ceremony shown:", claimUp);
if (claimUp) {
  const hatch = await page.evaluate(() => ({
    title: document.getElementById("atlas-claim-title")?.textContent, name: document.getElementById("atlas-name-input")?.value,
    kicker: document.getElementById("atlas-hatch-kicker")?.textContent, who: document.getElementById("atlas-hatch-name")?.textContent,
    desc: document.getElementById("atlas-hatch-desc")?.textContent, bio: document.getElementById("atlas-hatch-bio")?.textContent,
  }));
  console.log("hatch:", JSON.stringify(hatch));
  await shot("7-ceremony");
  await page.evaluate((sel) => document.querySelector(sel)?.click(), "#atlas-name-pick");
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll("#atlas-name-grid button")[3]?.click());
  await page.waitForTimeout(300);
  await shot("7b-ceremony-named");
  await page.evaluate((sel) => document.querySelector(sel)?.click(), "#atlas-claim-continue");
  await page.waitForTimeout(600);
  // Badge screen may follow (first race / first win / off the map).
  for (let i = 0; i < 8; i++) {
    const on = await page.evaluate(() => !document.getElementById("claim-screen").classList.contains("hidden"));
    if (!on) break;
    await page.evaluate(() => { const c = document.querySelector(".claim-card:not(.claimed)"); if (c) c.click(); else document.getElementById("claim-continue")?.click(); });
    await page.waitForTimeout(400);
  }
}
await page.waitForTimeout(800);
const prof = await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")));
console.log("profile atlas:", JSON.stringify(prof.atlas), "stats:", JSON.stringify({ cellsRaced: prof.stats.cellsRaced, found: prof.stats.found, cellsNamed: prof.stats.cellsNamed }));
// Back to the map: the cell is won and the neighbours are open.
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#start-btn");
await page.waitForTimeout(600);
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#mode-explore");
await page.waitForTimeout(900);
const card2 = await page.evaluate(() => ({
  name: document.getElementById("atlas-name")?.textContent, status: document.getElementById("atlas-status")?.textContent,
  res: document.getElementById("atlas-resident")?.textContent, open: document.querySelectorAll(".atlas-cell.open").length,
  won: document.querySelectorAll(".atlas-cell.won").length, sub: document.getElementById("mode-explore-sub")?.textContent,
}));
console.log("atlas after:", JSON.stringify(card2));
await shot("8-atlas-after");
// Pick a neighbour and look at its card (no race).
await page.evaluate(() => { const cells = [...document.querySelectorAll(".atlas-cell.open.frontier")]; cells[0]?.click(); });
await page.waitForTimeout(600);
await shot("9-neighbour");
// The found resident in the garage grid.
await page.evaluate(() => document.querySelector("#flow-atlas .flow-back")?.click());
await page.waitForTimeout(400);
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#mode-gp");
await page.waitForTimeout(600);
await page.evaluate(() => [...document.querySelectorAll("#track-grid button.tap-card")].find((b) => b.classList.contains("is-current"))?.click());
await page.waitForTimeout(900);
const grid = await page.evaluate(() => [...document.querySelectorAll("#cat-grid .track-name")].map((n) => n.textContent));
console.log("cat grid:", grid.join(", "));
await shot("10-cat-grid");
// Select the found cat (if the prize was a cat) and view the showroom + kart grid.
const pickedFound = await page.evaluate(() => { const cards = [...document.querySelectorAll("#cat-grid button.tap-card")]; const f = cards.find((c) => c.querySelector(".track-sub")?.textContent.startsWith("🗺️")); if (f) { f.click(); return f.querySelector(".track-name").textContent; } return null; });
await page.waitForTimeout(3000);
console.log("picked found cat:", pickedFound);
const gd = await page.evaluate(() => ({ draft: window.__zoomies.garage.draft, key: window.__zoomies.garage.previewKey, look: (() => { const l = window.__zoomies.garage.playerLook(); return { name: l.name, fur: l.catColor.toString(16), g: !!l.catGenome }; })() }));
console.log("garage:", JSON.stringify(gd));
await shot("11-found-picked");
// Through to the start line: the summary tile + the grid tableau wear the found cat.
await page.evaluate(() => document.querySelector("#kart-grid button.tap-card")?.click());
await page.waitForTimeout(2500);
console.log("racer summary:", await page.evaluate(() => document.getElementById("racer-summary")?.textContent));
await shot("11b-startline-found");
await page.evaluate(() => document.querySelector("#flow-startline .flow-back")?.click());
await page.waitForTimeout(400);
// Open the Cat-alog to see the Found section.
await page.evaluate(() => document.querySelector("#flow-kart .flow-back")?.click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector("#flow-cat .flow-back")?.click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector("#flow-track .flow-back")?.click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector("#flow-mode .flow-back")?.click());
await page.waitForTimeout(400);
await page.evaluate((sel) => document.querySelector(sel)?.click(), "#open-catalog");
await page.waitForTimeout(800);
await page.evaluate(() => { const box = document.querySelector("#catalog .flow-body"); if (box) box.scrollTop = box.scrollHeight; });
await page.waitForTimeout(300);
await shot("12-catalog");
console.log(errors.length ? `errors: ${JSON.stringify(errors)}` : "no page errors");
await browser.close();
server.close();
