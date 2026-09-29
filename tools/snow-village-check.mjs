// Actual seed-4242 race view with a pinned start-straight camera. Screenshots stay outside the tree.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const f = root + (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
    res.setHeader(
      "content-type",
      f.endsWith(".html")
        ? "text/html"
        : f.endsWith(".js")
          ? "text/javascript"
          : f.endsWith(".css")
            ? "text/css"
            : f.endsWith(".jpg")
              ? "image/jpeg"
              : "application/octet-stream",
    );
    res.end(await fs.readFile(f));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const out = process.env.OUT || "/tmp/zoomies-snow-village";
await fs.mkdir(out, { recursive: true });
try {
  const p = await browser.newPage({ viewport: { width: 1100, height: 700 } }),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem("zoomies-quality-v2", "medium");
    localStorage.setItem("zoomies-track-v1", JSON.stringify({ mode: "classic" }));
  });
  await p.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1&seed=4242`, { timeout: 180000 });
  await p.waitForFunction(() => window.__zoomies?.track, null, { timeout: 180000 });
  await p.evaluate(() => document.querySelector("#go-btn").click());
  const result = await p.evaluate(async () => {
    const Z = window.__zoomies,
      { biomeNameAt } = await import("/src/scenery.js");
    const start = Z.track.getPointAt(0),
      ahead = Z.track.getPointAt(0.025);
    const villages = Z.scene.userData.biomePlacements.filter((p) => p.kind === "village");
    const near = villages.filter((p) => Math.hypot(p.x - start.x, p.z - start.z) < 160);
    if (!near.length) throw Error("Seed 4242 lost its start-straight village");
    for (const p of villages) {
      if (!["alpine", "tundra"].includes(biomeNameAt(p.x, p.z))) throw Error("Village escaped snow biome");
      if (Z.track.distanceToCenter(p.x, p.z) < Z.track.halfWidth + 11) throw Error("Village footprint clips road");
    }
    const dx = ahead.x - start.x,
      dz = ahead.z - start.z,
      l = Math.hypot(dx, dz);
    const c = Z.camera;
    c.position.set(start.x - (dx / l) * 14, start.y + 3.5, start.z - (dz / l) * 14);
    c.lookAt(start.x + (dx / l) * 65, start.y + 3, start.z + (dz / l) * 65);
    c.updateMatrixWorld(true);
    c.position.copy = function () {
      return this;
    };
    c.lookAt = () => {};
    return { seed: 4242, biome: biomeNameAt(start.x, start.z), villages: villages.length, nearStart: near.length };
  });
  await p.waitForFunction(() => document.querySelector("#race-veil")?.classList.contains("hidden"), null, {
    timeout: 180000,
  });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(out, "seed-4242-start.png") });
  if (errors.length) throw Error(errors.join("\n"));
  console.log(JSON.stringify({ ...result, errors }));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  server.closeAllConnections();
  server.close();
}
process.exit(0);
