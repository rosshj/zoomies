// Offline smoke test: proves the service worker makes the game load with NO
// network. Loads online (SW installs + caches the shell), reloads so the SW takes
// control and runtime-caches everything, then flips the browser OFFLINE and
// reloads — asserting the app still boots (three.js + all modules served from
// cache) and reaches its world-build log with zero load errors.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8093;
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".mp3": "audio/mpeg", ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  const [rawPath, query] = req.url.split("?");
  let urlPath = decodeURIComponent(rawPath);
  if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  // Mimic Vercel's cleanUrls: /index.html 308-redirects to / (preserving query).
  // This is the exact redirect that poisoned the SW cache and broke iOS offline.
  if (urlPath === "/index.html") {
    res.writeHead(308, { location: "/" + (query ? "?" + query : "") });
    res.end();
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  fs.readFile(path.join(ROOT, urlPath), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
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
const page = await ctx.newPage();
const base = `http://127.0.0.1:${PORT}/index.html?webgl=1`;

// 1) First online load — registers + installs the SW.
await page.goto(base, { waitUntil: "load" });
await page.evaluate(() => navigator.serviceWorker.ready);
// 2) Reload so the SW controls this page and runtime-caches every asset it fetches.
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
await page.waitForTimeout(8000); // let all module + asset fetches populate the cache

const cacheInfo = await page.evaluate(async () => {
  const c = await caches.open("zoomies-v2");
  const keys = await c.keys();
  // No cached navigation/shell response may be a redirect (Safari rejects those).
  const shell = (await c.match("./index.html")) || (await c.match("./"));
  return { count: keys.length, shellRedirected: shell ? shell.redirected : null };
});

// 3) Go OFFLINE and reload from a cold page — everything must come from cache.
await ctx.setOffline(true);
const logs = [];
const errors = [];
const page2 = await ctx.newPage();
page2.on("console", (m) => { logs.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
page2.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
let gotoErr = null;
try {
  await page2.goto(base, { waitUntil: "load", timeout: 30000 });
} catch (e) {
  gotoErr = String(e);
}
// The world-build log only fires once three.js + the module graph have loaded.
let booted = false;
try {
  await page2.waitForFunction(
    () => document.querySelector("#start-btn") && getComputedStyle(document.querySelector("#start-btn")).display !== "none",
    null, { timeout: 20000 }
  );
  booted = true;
} catch { /* leave booted=false */ }
const worldLog = logs.some((l) => /world seed/i.test(l));
const loadErrors = errors.filter((e) => /Failed to load|Importing|module|MIME|404|net::/i.test(e));

console.log(JSON.stringify({
  cachedCount: cacheInfo.count,
  shellRedirected: cacheInfo.shellRedirected, // must be false — Safari rejects redirected nav responses
  offlineGoto: gotoErr ? "FAILED: " + gotoErr : "ok",
  startBtnVisible: booted,
  worldBuilt: worldLog,
  loadErrors,
  pass: !gotoErr && booted && worldLog && loadErrors.length === 0 && cacheInfo.shellRedirected === false,
}, null, 2));

await browser.close();
server.close();
process.exit(0);
