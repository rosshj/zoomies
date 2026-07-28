// Battle-arena probe (phase 1): boots the game with ?battle=1, starts the solo
// arena session, drives the kart forward across the bowl into the fence, and
// verifies the arena physics end-to-end:
//   - the kart moves (throttle works on the arena ground profile),
//   - it climbs the banked rim (groundY rises with radius),
//   - the fence clamp holds it inside (r never exceeds radius - kart.radius),
//   - no console errors.
// Screenshots land in the scratchpad (start grid, mid-bowl, pinned on the
// fence) for the look-at-it half of the verification loop.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8097;
const SHOTS = process.env.SHOTS || "/tmp";

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
    if (err) { res.writeHead(404); res.end("not found"); return; }
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

await page.goto(`http://127.0.0.1:${PORT}/index.html?battle=1&webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("#start-btn", { force: true });

// Wait out the veil + countdown until the player kart exists and control is live.
const t0 = Date.now();
let live = false;
while (Date.now() - t0 < 120000) {
  live = await page.evaluate(() => {
    const z = window.__zoomies;
    return !!(z && z.karts && z.karts[0]);
  }).catch(() => false);
  if (live) break;
  await page.waitForTimeout(1000);
}
if (!live) errors.push("player kart never appeared");
await page.screenshot({ path: path.join(SHOTS, "battle-1-grid.png") });

const sample = () => page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const t = window.__zoomies.track;
  return {
    x: +k.position.x.toFixed(2), z: +k.position.z.toFixed(2),
    r: +Math.hypot(k.position.x, k.position.z).toFixed(2),
    y: +k.position.y.toFixed(2), speed: +k.speed.toFixed(2),
    wallHit: k.wallHitPulse > 0, radius: t.radius, lap: k.lap,
  };
});

// Drive forward: the grid faces the centre, so full throttle crosses the bowl
// and runs up the far bank into the fence. Hold the key first, then wait out
// the race veil + countdown (SwiftShader can hold the veil for many seconds)
// until the throttle actually reaches the kart — that's the moment control is
// live.
const before = await sample();
await page.keyboard.down("ArrowUp");
const tGo = Date.now();
let unlocked = false;
while (Date.now() - tGo < 90000) {
  unlocked = await page.evaluate(() => window.__zoomies.karts[0].throttleInput > 0);
  if (unlocked) break;
  await page.waitForTimeout(500);
}
if (!unlocked) errors.push("control never unlocked (countdown/veil never finished)");
const trace = [before];
let maxR = 0, maxSpeed = 0, sawWall = false;
// SwiftShader dilates sim time ~10x vs wall-clock, so allow a long drive and
// bail out once the kart has been pinned on the fence for a few samples.
let pinned = 0;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  const s = await sample();
  trace.push(s);
  maxR = Math.max(maxR, s.r);
  maxSpeed = Math.max(maxSpeed, s.speed);
  if (s.wallHit) sawWall = true;
  if (i === 8) await page.screenshot({ path: path.join(SHOTS, "battle-2-bowl.png") });
  if (s.r > (s.radius || 90) - 3) pinned++;
  if (pinned >= 3) break;
}
await page.screenshot({ path: path.join(SHOTS, "battle-3-fence.png") });
await page.keyboard.up("ArrowUp");
const after = trace[trace.length - 1];

// Assertions.
const R = after.radius || 90;
if (maxSpeed < 15) errors.push(`kart barely moved (max speed ${maxSpeed})`);
if (maxR < R - 12) errors.push(`kart never reached the rim (max r ${maxR} of ${R})`);
if (maxR > R - 1.2) errors.push(`fence clamp failed (max r ${maxR} > ${R - 1.2})`);
if (after.y < 1.0) errors.push(`no bank climb: ground y at r=${after.r} is ${after.y}`);
if (after.lap !== -1) errors.push(`laps advanced in an arena (lap ${after.lap})`);

console.log(JSON.stringify({ trace, maxR, maxSpeed, sawWall, errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
