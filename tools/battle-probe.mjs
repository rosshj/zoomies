// Battle-arena probe (phase 2): boots ?battle=1, starts the solo session and
// verifies the Backyard map end-to-end:
//   - spawn → full throttle crosses the mesa ramp lane, over the paw plateau
//     (position.y climbs past 4.5) and on into the far fence, which pins the
//     kart at exactly radius - kart.radius,
//   - a kicker run gives real air (kart.y ballistic without a jump press),
//   - obstacle colliders push the kart out (yarn ball test) with the wall's
//     spark latch,
//   - laps never advance, no console errors.
// Screenshots (grid, mid-drive, fence, kicker air, two pinned overviews) land
// in the scratchpad for the look-at-it half of the verification loop.
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

// Wait out the veil + countdown until the player kart exists.
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
// Phase 4: AI rivals brawl for real now — shield the player through the
// terrain legs so a stray furball can't randomize the physics assertions.
await page.evaluate(() => { window.__zoomies.karts[0].shieldTimer = 9999; });
await page.screenshot({ path: path.join(SHOTS, "battle-1-grid.png") });

const sample = () => page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const t = window.__zoomies.track;
  return {
    x: +k.position.x.toFixed(2), z: +k.position.z.toFixed(2),
    r: +Math.hypot(k.position.x, k.position.z).toFixed(2),
    gy: +k.position.y.toFixed(2), air: +k.y.toFixed(2), speed: +k.speed.toFixed(2),
    wallHit: k.wallHitPulse > 0, radius: t.radius, lap: k.lap,
  };
});

// Hold throttle first, then wait for control to unlock (veil + countdown can
// take a long time under SwiftShader).
await page.keyboard.down("ArrowUp");
const tGo = Date.now();
let unlocked = false;
while (Date.now() - tGo < 90000) {
  unlocked = await page.evaluate(() => window.__zoomies.karts[0].throttleInput > 0);
  if (unlocked) break;
  await page.waitForTimeout(500);
}
if (!unlocked) errors.push("control never unlocked (countdown/veil never finished)");

// --- Leg 1: spawn → mesa lane → plateau → far field → fence pin -----------
let maxGy = 0, maxR = 0, maxSpeed = 0, sawWall = false, pinned = 0, last = null;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  const s = await sample();
  last = s;
  maxGy = Math.max(maxGy, s.gy);
  maxR = Math.max(maxR, s.r);
  maxSpeed = Math.max(maxSpeed, s.speed);
  if (s.wallHit) sawWall = true;
  if (i === 10) await page.screenshot({ path: path.join(SHOTS, "battle-2-mesa.png") });
  if (s.r > (s.radius || 140) - 3) pinned++;
  if (pinned >= 3) break;
}
await page.screenshot({ path: path.join(SHOTS, "battle-3-fence.png") });
const R = last?.radius || 140;
if (maxSpeed < 15) errors.push(`kart barely moved (max speed ${maxSpeed})`);
if (maxGy < 4.5) errors.push(`never climbed the mesa (max ground y ${maxGy})`);
if (maxR < R - 12) errors.push(`never reached the rim (max r ${maxR} of ${R})`);
if (maxR > R - 1.2) errors.push(`fence clamp failed (max r ${maxR} > ${R - 1.2})`);
if (last && last.lap !== -1) errors.push(`laps advanced in an arena (lap ${last.lap})`);

// --- Leg 2: pad → kicker BIG air — start behind the creek-jump boost pad ---
await page.keyboard.up("ArrowUp");
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const kick = window.__zoomies.track.kickers[0];
  k.position.x = kick.x - Math.sin(kick.yaw) * 42;
  k.position.z = kick.z - Math.cos(kick.yaw) * 42;
  k.heading = kick.yaw;
  k.speed = 0;
  k.knock.set(0, 0, 0);
});
await page.keyboard.down("ArrowUp");
let sawAir = 0, maxAir = 0, padSpeed = 0;
for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  padSpeed = Math.max(padSpeed, s.speed);
  // Only count air earned at speed — the teleport settling also falls.
  if (s.speed > 20) {
    maxAir = Math.max(maxAir, s.air);
    if (s.air > 0.7) {
      sawAir++;
      if (sawAir === 2) await page.screenshot({ path: path.join(SHOTS, "battle-4-air.png") });
    }
  }
  if (sawAir >= 2 && maxAir > 2.2) break;
}
await page.keyboard.up("ArrowUp");
if (sawAir < 2) errors.push("kicker never launched the kart (no ballistic air)");
if (maxAir < 2.2) errors.push(`air too small (apex ${maxAir} — want a real flight)`);
if (padSpeed < 40) errors.push(`boost pad never fired (max speed ${padSpeed})`);

// --- Leg 3: obstacle collider — drive square into a yarn ball --------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const o = window.__zoomies.track.obstacles.find((o) => o.kind === "yarn");
  const a = Math.atan2(o.x - (o.x + 20), o.z - (o.z + 20)); // from +20,+20 toward the ball
  k.position.x = o.x + 20;
  k.position.z = o.z + 20;
  k.heading = a;
  k.speed = 0;
  k.knock.set(0, 0, 0);
  k.y = 0; k.vy = 0; k.airborne = false;
  window.__probeObstacle = o;
});
await page.keyboard.down("ArrowUp");
let minDist = Infinity, obstacleSpark = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => {
    const k = window.__zoomies.karts[0];
    const o = window.__probeObstacle;
    return { d: Math.hypot(k.position.x - o.x, k.position.z - o.z), spark: k.wallHitPulse > 0, or: o.r };
  });
  minDist = Math.min(minDist, s.d);
  if (s.spark) obstacleSpark = true;
  if (i === 12) await page.screenshot({ path: path.join(SHOTS, "battle-5-obstacle.png") });
}
await page.keyboard.up("ArrowUp");
const obstacleR = await page.evaluate(() => window.__probeObstacle.r);
if (minDist < obstacleR + 1.8 - 0.7) errors.push(`obstacle collider leaked (min dist ${minDist.toFixed(2)} vs ${obstacleR + 1.8})`);
if (minDist > obstacleR + 6) errors.push(`kart never reached the obstacle (min dist ${minDist.toFixed(2)})`);
if (!obstacleSpark) errors.push("obstacle hit never latched the spark pulse");

// --- Leg 4: steep-wall rule — the butte's gap cliff must not be climbable --
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  // The 60° gap sector faces local azimuth ≈ -0.08 from the butte centre.
  k.position.x = -32 + Math.sin(-0.08) * 24;
  k.position.z = 30 + Math.cos(-0.08) * 24;
  k.heading = Math.atan2(-32 - k.position.x, 30 - k.position.z); // face the core
  k.speed = 0;
  k.knock.set(0, 0, 0);
  k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
let wallMaxGy = 0, wallSpark = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  wallMaxGy = Math.max(wallMaxGy, s.gy);
  if (s.wallHit) wallSpark = true;
}
await page.keyboard.up("ArrowUp");
await page.screenshot({ path: path.join(SHOTS, "battle-5b-wall.png") });
if (wallMaxGy > 5.5) errors.push(`climbed the butte cliff (ground y ${wallMaxGy} — steep-wall rule failed)`);
if (!wallSpark) errors.push("steep wall never latched the spark pulse");
// Sanity: the butte deck really is the high ground.
const butteTop = await page.evaluate(() => +window.__zoomies.track.heightAt(-32, 30).toFixed(2));
if (butteTop < 8.5) errors.push(`butte deck too low (${butteTop})`);

// --- Leg 5: combat — shoot an AI down to a KO, watch it respawn ------------
const combat = { hits: 0, ko: false, respawned: false, boxes: 0, aiAlive: false };
combat.boxes = await page.evaluate(() =>
  window.__zoomies.props ? window.__zoomies.props._props.filter((p) => p.kind === "crate" && p.mode === "float").length : -1
);
combat.aiAlive = await page.evaluate(() =>
  window.__zoomies.karts.some((k) => !k.isPlayer && Math.abs(k.throttleInput) > 0.1)
);
await page.evaluate(() => {
  const p = window.__zoomies.karts[0];
  p.shieldTimer = 9999; // stay covered while we play executioner
  p.position.x = 0; p.position.z = 60; p.heading = Math.PI; p.speed = 0; p.knock.set(0, 0, 0);
});
for (let round = 0; round < 30; round++) {
  const st = await page.evaluate(() => {
    const z = window.__zoomies;
    const p = z.karts[0];
    const t = z.karts[1];
    // Park the victim square in front of the muzzle each round.
    if (t._koTimer <= 0 && t.spinTimer <= 0) {
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      t.position.x = p.position.x + fx * 11;
      t.position.z = p.position.z + fz * 11;
      t.speed = 0;
      t.shieldTimer = 0;
      t.catnipTimer = 0;
    }
    p.shootCooldown = 0;
    return { hearts: t.battleHearts, ko: t._koTimer > 0, vis: t.group.visible, myKOs: p.battleKOs };
  });
  if (st.ko) { combat.ko = true; break; }
  await page.keyboard.down("KeyF");
  await page.waitForTimeout(250);
  await page.keyboard.up("KeyF");
  await page.waitForTimeout(1800);
}
if (combat.ko) await page.screenshot({ path: path.join(SHOTS, "battle-8-ko.png") });
// Respawn: hearts refill, kart re-appears somewhere on the ring.
for (let i = 0; i < 30 && !combat.respawned; i++) {
  await page.waitForTimeout(1000);
  combat.respawned = await page.evaluate(() => {
    const t = window.__zoomies.karts[1];
    return t._koTimer <= 0 && t.group.visible && t.battleHearts === 3;
  });
}
const myKOs = await page.evaluate(() => window.__zoomies.karts[0].battleKOs);
// The float count breathes during play (a grabbed box sinks spent, a pool
// crate rises after a delay) — just prove the arena pool is live and near cap.
if (combat.boxes < 8) errors.push(`floating box pool too small (${combat.boxes} of 10)`);
if (!combat.aiAlive) errors.push("battle AI never drove");
if (!combat.ko) errors.push("never KO'd the target AI (hearts/latch pipeline broken?)");
if (combat.ko && !combat.respawned) errors.push("KO'd kart never respawned");
if (combat.ko && myKOs < 1) errors.push(`KO not credited to the shooter (player KOs ${myKOs})`);

// --- Overview shots: pin the camera (the race loop re-aims it every frame) --
for (const [name, px, py, pz] of [
  ["battle-6-overview", 30, 210, 190],
  ["battle-7-low", -170, 55, 150],
]) {
  await page.evaluate(({ px, py, pz }) => {
    const cam = window.__zoomies.camera;
    cam.position.copy = function () { return this; }; // neuter the chase cam
    cam.lookAt = () => {};
    cam.position.set(px, py, pz);
    Object.getPrototypeOf(Object.getPrototypeOf(cam)).lookAt.call(cam, 0, 0, 0);
  }, { px, py, pz });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

console.log(JSON.stringify({ maxGy, maxR, maxSpeed, sawWall, sawAir, minDist: +minDist.toFixed(2), combat, myKOs, errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
