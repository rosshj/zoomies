// One-off probe for the roadside grass. Lays a dense test plot of blades on the
// verge just ahead of the player (the real scatter is far too sparse to read a
// bend from), re-laying it each capture so it stays in frame, then drives the
// real kart past it under the game's own camera and bow-wave uniform. Answers
// the two questions the deform has to get right: do the bases stay planted, and
// do the blades bend rather than fly apart?
//   node tools/grass-probe.mjs   ->  shots in $OUT (default /tmp/grass)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/grass";
const PORT = 8102;
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
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("ERR:", m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });

// The menu is a multi-screen flow (title -> mode -> track -> cat -> kart ->
// start line), so walk it: take the first real choice on each screen until GO.
await page.waitForSelector("#start-btn", { timeout: 30000 });
await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
await page.click("#start-btn", { force: true });
for (let step = 0; step < 12; step++) {
  await page.waitForTimeout(700);
  const done = await page.evaluate(() => {
    const go = document.getElementById("go-btn");
    if (go && go.offsetParent) { go.click(); return true; }
    const screen = document.querySelector(".flow-screen.is-active");
    if (!screen) return false;
    const pick = [...screen.querySelectorAll("button, .card, [role=button]")]
      .filter((e) => e.offsetParent && !e.classList.contains("flow-back") && !e.hasAttribute("data-back"))[0];
    if (pick) pick.click();
    return false;
  });
  if (done) break;
}

// The race loop writes the player's position into the grass bow-wave uniform
// every frame, so that uniform doubles as the "is the player driving yet" probe
// AND as the player-position feed (main.js keeps `player` module-private).
for (let t = 0; t < 90; t++) {
  const live = await page.evaluate(() => (window.__zoomies?.world?.grass?.userData?.uKart?.value?.x ?? 1e6) < 1e5);
  if (live) break;
  await page.waitForTimeout(1000);
}

// Install the plot layer: re-runnable, so each capture gets fresh blades right
// where the kart is about to be.
await page.evaluate(() => {
  const Z = window.__zoomies;
  const g = Z.world.grass;
  const track = Z.track;
  const uk = g.userData.uKart;
  // Adaptive quality hides the grass outright at SwiftShader framerates.
  Object.defineProperty(g, "visible", { get: () => true, set: () => {}, configurable: true });
  g.frustumCulled = false;
  // three isn't on the debug hook, so borrow the classes off live objects.
  const Matrix4 = g.matrix.constructor, Vector3 = g.position.constructor;
  const a = g.geometry.attributes.aRoot.array;
  const ys = g.geometry.attributes.aYawScale.array;
  const m = new Matrix4(), s = new Vector3();

  window.__lay = (ahead, side, bladeScale, offMul) => {
    const px = uk.value.x, pz = uk.value.z; // live player position
    const N = track.samples;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < N; i++) {
      const p = track._pts[i];
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < bd) { bd = d; bi = i; }
    }
    const ai = (bi + ahead) % N;
    const p = track._pts[ai], tan = track._tans[ai];
    const tl = Math.hypot(tan.x, tan.z) || 1;
    const sx = (-tan.z / tl) * side, sz = (tan.x / tl) * side;
    const off = track.halfWidth * offMul; // on the tarmac when <1: no verge props to hide behind
    const cx = p.x + sx * off, cz = p.z + sz * off;
    // Plot runs ALONG the road x ACROSS it, so the kart ploughs down its edge.
    const SIDE = 30, ALONG = 0.75, ACROSS = 0.24;
    let n = 0;
    for (let ix = 0; ix < SIDE; ix++) {
      for (let iz = 0; iz < SIDE; iz++) {
        const al = (ix - SIDE / 2) * ALONG, ac = (iz - SIDE / 2) * ACROSS;
        const x = cx + (tan.x / tl) * al + sx * ac;
        const z = cz + (tan.z / tl) * al + sz * ac;
        const y = p.y + 0.05; // road-deck height: terrain heightAt buries the plot under a raised roadbed
        const yaw = (((ix * 7 + iz * 13) % 31) / 31) * Math.PI;
        const scale = (0.9 + (((ix * 5 + iz * 3) % 11) / 11) * 0.9) * bladeScale;
        m.makeRotationY(yaw);
        m.scale(s.setScalar(scale));
        m.setPosition(x, y, z);
        g.setMatrixAt(n, m);
        a[n * 3] = x; a[n * 3 + 1] = y; a[n * 3 + 2] = z;
        ys[n * 2] = yaw; ys[n * 2 + 1] = scale;
        n++;
      }
    }
    g.count = n;
    g.instanceMatrix.needsUpdate = true;
    g.geometry.attributes.aRoot.needsUpdate = true;
    g.geometry.attributes.aYawScale.needsUpdate = true;
    window.__c = { x: cx, z: cz };
    const ndc = new Vector3(cx, p.y + 1, cz).project(Z.camera);
    return { n, d: +Math.hypot(cx - px, cz - pz).toFixed(1), push: +uk.value.w.toFixed(2), ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)], vis: g.visible, cnt: g.count, par: g.parent && g.parent.type, pvis: g.parent && g.parent.visible, mask: g.layers.mask, cam: Z.camera.layers.mask, mat: g.material.type, tri: g.geometry.index ? g.geometry.index.count : -1 };
  };
  window.__where = () => ({ d: +Math.hypot(uk.value.x - window.__c.x, uk.value.z - window.__c.z).toFixed(1), push: +uk.value.w.toFixed(2) });
});

// Drive past it: hold the throttle, re-lay the plot just ahead each capture.
await page.keyboard.down("ArrowUp");
const SIDE = Number(process.env.SIDE || 1);
const AHEAD = Number(process.env.AHEAD || 6);
const SCALE = Number(process.env.SCALE || 1);
const OFFMUL = Number(process.env.OFFMUL || 0.55);
const ONCE = process.env.LAYONCE === "1"; // lay the plot once, then drive INTO it
let s = null;
for (let i = 1; i <= 6; i++) {
  if (!ONCE || i === 1) s = await page.evaluate((a) => window.__lay(a.ahead, a.side, a.scale, a.off), { ahead: AHEAD, side: SIDE, scale: SCALE, off: OFFMUL });
  else s = await page.evaluate(() => window.__where());
  await page.waitForTimeout(900);
  console.log("lay", JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, `pass-${String(i).padStart(2, "0")}-d${s.d}-p${s.push}.png`) });
}
await page.keyboard.up("ArrowUp");

// A/B the bow-wave itself: park the kart, lay a fresh plot right in front of
// it, then freeze the uniform on the plot centre (the race loop rewrites it
// every frame, so neuter the setter) and shoot push OFF vs push ON. Only w
// changes between the two frames.
await page.keyboard.down("ArrowDown");
await page.waitForTimeout(2000);
await page.keyboard.up("ArrowDown");
await page.waitForTimeout(5000); // let the kart coast to a stop so the camera settles
await page.evaluate((a) => window.__lay(a.ahead, a.side, a.scale, a.off), { ahead: 2, side: SIDE, scale: SCALE, off: 0.15 });
for (const [name, w] of [["freeze-a-push0", 0], ["freeze-b-push1", 1.1]]) {
  await page.evaluate((push) => {
    const uk = window.__zoomies.world.grass.userData.uKart;
    uk.value.set = () => uk.value; // the race loop can no longer touch it
    const c = window.__c;
    uk.value.x = c.x; uk.value.z = c.z; uk.value.y = 0; uk.value.w = push;
  }, w);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
console.log("wrote", fs.readdirSync(OUT).sort().join(" "));
await browser.close();
server.close();
