// One-off probe for the dynamic-resolution scaler around the race start.
// Walks the menu to the start-line tableau, samples the FPS readout (which
// prints the live render scale) while sitting there, then through the veil and
// into the race — so a resolution drop can be pinned to the screen that caused
// it.  node tools/drs-probe.mjs
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8107;
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
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
await ctx.addInitScript(() => { try { localStorage.setItem("zoomies-fps", "1"); } catch {} });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
// nowd stays OFF here: the watchdog is part of what we're watching.
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1`, { waitUntil: "load", timeout: 150000 });

const sample = async (label, seconds) => {
  const seen = [];
  for (let t = 0; t < seconds * 2; t++) {
    const txt = (await page.textContent("#fps-counter").catch(() => "")) || "";
    const m = txt.match(/([\d.]+)x/);
    // Tag each sample with whether the race loop is actually driving (it writes
    // the player position into the grass uniform every racing frame), so a
    // "1.0x throughout" result can't be a menu that never started a race.
    const racing = await page.evaluate(() => (window.__zoomies?.world?.grass?.userData?.uKart?.value?.x ?? 1e6) < 1e5);
    if (m) seen.push(m[1] + (racing ? "R" : "M"));
    await page.waitForTimeout(500);
  }
  // Collapse runs so the trace shows transitions, not 40 identical samples.
  const runs = [];
  for (const s of seen) {
    if (runs.length && runs[runs.length - 1][0] === s) runs[runs.length - 1][1]++;
    else runs.push([s, 1]);
  }
  console.log(label.padEnd(22), runs.map(([s, n]) => `${s}x×${n}`).join("  ") || "(no readout)");
};

await page.waitForSelector("#start-btn", { timeout: 30000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await sample("menu (title)", 6);

// Walk to the start line but DON'T press GO yet.
await page.click("#start-btn", { force: true });
for (let step = 0; step < 12; step++) {
  await page.waitForTimeout(700);
  const atGo = await page.evaluate(() => {
    if (document.getElementById("go-btn")?.offsetParent) return true;
    const screen = document.querySelector(".flow-screen.is-active");
    const pick = screen && [...screen.querySelectorAll("button, .card, [role=button]")]
      .filter((e) => e.offsetParent && !e.classList.contains("flow-back") && !e.hasAttribute("data-back"))[0];
    if (pick) pick.click();
    return false;
  });
  if (atGo) break;
}
await sample("START LINE tableau", 14); // the screen the player says goes blurry

const clicked = await page.evaluate(() => {
  const b = document.getElementById("go-btn");
  if (!b) return "no go-btn";
  b.click();
  return "clicked";
});
console.log("GO:", clicked);
for (let t = 0; t < 40; t++) {
  const st = await page.evaluate(() => ({
    uk: window.__zoomies?.world?.grass?.userData?.uKart?.value?.x,
    lap: document.getElementById("lap")?.textContent || document.querySelector("#hud")?.className,
    menu: document.getElementById("menu")?.className,
  }));
  if (t % 8 === 0) console.log("  post-GO", t, JSON.stringify(st));
  if (st.uk < 1e5) { console.log("  racing at t=" + t); break; }
  await page.waitForTimeout(1000);
}
await sample("veil + countdown", 14);
await sample("racing", 45);

await browser.close();
server.close();
