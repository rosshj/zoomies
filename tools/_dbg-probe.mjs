import { chromium } from "playwright-core";
import http from "http";
import { createReadStream, existsSync, statSync } from "fs";
import { join, extname } from "path";
const root = join(process.cwd(), "..");
const OUT = "/tmp/claude-0/-home-user-zoomies/b6c62d34-83a9-549b-98f3-25466087dc21/scratchpad";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = join(root, decodeURIComponent(req.url.split("?")[0]));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 780, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/viewer.html?webgl=1&plain=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForFunction(() => !!window.__viewer, null, { timeout: 60000 });
await page.evaluate(() => {
  const v = window.__viewer;
  v.setGameLook(true);
  v.setBackground("30364a");
  v.showPreset({ kind: "cat", fur: 0x2a2a2a, pattern: "tuxedo" });
  v.freeze(0);
  // hide the two shoulder pivots (front legs)
  v.scene.traverse((o) => {
    if (o.isGroup && Math.abs(Math.abs(o.position.x) - 0.5) < 0.01 && Math.abs(o.position.y - 1.05) < 0.01) o.visible = false;
  });
  v.orbit.target.set(0, 1.2, 0.3);
  v.orbit.radius = 4.6;
  v.orbit.theta = 0.05;
  v.orbit.phi = 1.4;
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/dbg-nolegs.png` });
await browser.close();
server.close();
console.log("done");
