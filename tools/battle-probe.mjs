// Battle FEATURE PROBE (The Courtyard). Checks that each designed thing works;
// tools/battle-audit.mjs separately checks that the map isn't frustrating.
//
//   - you start unarmed (furballs are earned from boxes),
//   - the podium is a pyramid: drivable from a plain approach, roof holds,
//   - driving off the roof at speed is a real ballistic arc that lands,
//   - the shade deck works on BOTH levels (under it, and up its ramp),
//   - the launch ramp throws a proper jump,
//   - the boundary holds (including mid-flight),
//   - full combat: KO → credit → respawn, and the match-end standings.
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
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (p === "/") p = "/index.html";
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); res.end("nope"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(d);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
const errors = [];
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`http://127.0.0.1:${PORT}/index.html?battle=1&webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("#start-btn", { force: true });
const t0 = Date.now();
let live = false;
while (Date.now() - t0 < 120000) {
  live = await page.evaluate(() => !!window.__zoomies?.karts?.[0]).catch(() => false);
  if (live) break;
  await page.waitForTimeout(1000);
}
if (!live) errors.push("player kart never appeared");
await page.evaluate(() => { window.__zoomies.karts[0].shieldTimer = 1e9; });
await page.screenshot({ path: path.join(SHOTS, "battle-1-grid.png") });

const sample = () => page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  return {
    x: +k.position.x.toFixed(2), z: +k.position.z.toFixed(2),
    gy: +k.position.y.toFixed(2), air: +k.y.toFixed(2), vy: +k.vel.y.toFixed(2),
    speed: +k.speed.toFixed(2), grounded: k.grounded, wall: k.wallHitPulse > 0, lap: k.lap,
  };
});
// Peak recorder: arena flights last well under a second, so polling from node
// misses them by luck. Sample in-page at 20 Hz and read the peaks.
const startRec = () => page.evaluate(() => {
  const z = window.__zoomies;
  clearInterval(z.__recT);
  z.__rec = { air: 0, vy: 0, flew: false, landed: false, minGy: 99 };
  z.__recT = setInterval(() => {
    const k = z.karts[0], r = z.__rec;
    if (!k.grounded) {
      r.flew = true;
      r.air = Math.max(r.air, k.y);
      r.vy = Math.max(r.vy, k.vel.y);
    } else if (r.flew) {
      r.landed = true;
      r.minGy = Math.min(r.minGy, k.position.y);
    }
  }, 50);
});
const readRec = () => page.evaluate(() => {
  clearInterval(window.__zoomies.__recT);
  const r = window.__zoomies.__rec;
  return { air: +r.air.toFixed(2), vy: +r.vy.toFixed(2), flew: r.flew, landed: r.landed };
});

const put = (x, z, heading, y = 0.5, speed = 0) => page.evaluate(({ x, z, heading, y, speed }) => {
  const k = window.__zoomies.karts[0];
  k.position.x = x; k.position.z = z; k.position.y = y;
  k.heading = heading; k.speed = speed; k.knock.set(0, 0, 0);
  k.y = 0; k.vel.set(0, 0, 0); k.grounded = true; k.airborne = false; k._wy = y;
}, { x, z, heading, y, speed });

await page.keyboard.down("ArrowUp");
const tGo = Date.now();
let unlocked = false;
while (Date.now() - tGo < 90000) {
  unlocked = await page.evaluate(() => window.__zoomies.karts[0].throttleInput > 0);
  if (unlocked) break;
  await page.waitForTimeout(500);
}
if (!unlocked) errors.push("control never unlocked");
await page.keyboard.up("ArrowUp");

// Unarmed start.
await page.keyboard.down("KeyF");
await page.waitForTimeout(300);
await page.keyboard.up("KeyF");
await page.waitForTimeout(1200);
if (await page.evaluate(() => window.__zoomies.hairballs.balls.length) !== 0) {
  errors.push("fired with zero ammo (unarmed start broken)");
}

// Park the AI far away for the geometry legs.
await page.evaluate(() => {
  const c = [[-50, 50], [50, 50], [-50, -50]];
  let i = 0;
  for (const k of window.__zoomies.karts) {
    if (k.isPlayer) continue;
    const [x, z] = c[i++ % 3];
    k.position.x = x; k.position.z = z; k._koTimer = 9999;
  }
});

// --- Leg 1: the pyramid — plain approach must climb it, roof must hold ------
const POD = await page.evaluate(() => window.__zoomies.track.podium);
await put(0, 46, Math.PI);
await page.keyboard.down("ArrowUp");
const pod = { top: 0, onRoof: false, contained: true };
for (let i = 0; i < 26; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  pod.top = Math.max(pod.top, s.gy);
  if (s.gy > POD.h - 0.4) pod.onRoof = true;
  if (Math.abs(s.x) > 58 || Math.abs(s.z) > 58) pod.contained = false;
  if (i === 6) await page.screenshot({ path: path.join(SHOTS, "battle-2-pyramid.png") });
  if (pod.onRoof) break;
}
await page.keyboard.up("ArrowUp");
if (!pod.onRoof) errors.push(`a straight-on approach never reached the podium roof (max y ${pod.top})`);

// --- Leg 2: off the roof at speed — a real arc that lands ------------------
// Cross the roof over both boost pads and off the coping at speed.
await put(-11, 0, Math.PI / 2, POD.h);
await startRec();
await page.keyboard.down("ArrowUp");
for (let i = 0; i < 20; i++) { // software rendering advances sim time slowly
  await page.waitForTimeout(500);
  if (i === 4) await page.screenshot({ path: path.join(SHOTS, "battle-3-air.png") });
}
await page.keyboard.up("ArrowUp");
await page.waitForTimeout(3000); // let it coast to a stop before judging "came down"
const fly = await readRec();
fly.down = fly.landed || (await page.evaluate(() => window.__zoomies.karts[0].grounded));
if (!fly.flew) errors.push("driving off the podium at speed produced no flight");
if (fly.air < 1.5) errors.push(`podium launch was a token hop (${fly.air}u)`);
if (!fly.down) errors.push("never came back down after leaving the podium");

// --- Leg 3: the shade deck, both levels ------------------------------------
const DECK = await page.evaluate(() => window.__zoomies.track.deck);
await put(DECK.x, DECK.z, 0, 0.5); // underneath, driving out
await page.keyboard.down("ArrowUp");
let underMax = 0;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(600);
  underMax = Math.max(underMax, (await sample()).gy);
}
await page.keyboard.up("ArrowUp");
if (underMax > 2.5) errors.push(`ground snapped up toward the deck while under it (gy ${underMax})`);

await put(DECK.x, DECK.z - 24, Math.PI * 0, 0.5); // approach the deck ramp
await page.keyboard.down("ArrowUp");
let deckTop = 0;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(600);
  deckTop = Math.max(deckTop, (await sample()).gy);
  if (deckTop > DECK.h - 0.4) break;
}
await page.keyboard.up("ArrowUp");
await page.screenshot({ path: path.join(SHOTS, "battle-4-deck.png") });
if (deckTop < DECK.h - 0.4) errors.push(`never got onto the shade deck (max y ${deckTop} of ${DECK.h})`);

// --- Leg 4: the launch ramp ------------------------------------------------
// Start clear of the corner walls with a running start (the corner is too
// tight to build speed from a standstill without leaning on both walls).
await put(-53, -53, Math.PI / 4, 0.5, 30);
await startRec();
await page.keyboard.down("ArrowUp");
for (let i = 0; i < 22; i++) {
  await page.waitForTimeout(500);
  if (i === 10) await page.screenshot({ path: path.join(SHOTS, "battle-5-launch.png") });
}
await page.keyboard.up("ArrowUp");
const mega = await readRec();
const megaAir = mega.air, megaVy = mega.vy;
if (!mega.flew || megaAir < 0.8) errors.push(`the launch ramp never launched (max air ${megaAir})`);

// --- Leg 5: boundary holds, even mid-flight --------------------------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  k.position.x = 40; k.position.z = 0; k.position.y = 6;
  k.heading = Math.PI / 2; k.grounded = false; k.airborne = true;
  k._wy = 14; k.y = 8; k.vel.set(60, 4, 0); // hurled at the east wall in mid-air
});
let escaped = false;
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(400);
  const s = await sample();
  if (Math.abs(s.x) > 58.5 || Math.abs(s.z) > 58.5) escaped = true;
}
if (escaped) errors.push("a mid-air kart escaped the map boundary");

// --- Leg 6: combat — KO, credit, respawn -----------------------------------
await page.evaluate(() => {
  for (const k of window.__zoomies.karts) if (!k.isPlayer) k._koTimer = 0.01;
});
await page.waitForTimeout(3000);
const combat = { ko: false, respawned: false, boxes: 0, aiAlive: false };
combat.boxes = await page.evaluate(() =>
  window.__zoomies.props ? window.__zoomies.props._props.filter((p) => p.kind === "crate" && p.mode === "float").length : -1);
combat.aiAlive = await page.evaluate(() =>
  window.__zoomies.karts.some((k) => !k.isPlayer && Math.abs(k.throttleInput) > 0.1));
await page.evaluate(() => {
  const p = window.__zoomies.karts[0];
  p.shieldTimer = 1e9;
  p.battleAmmo = 99;
  p.position.x = 0; p.position.z = 40; p.position.y = 0.5; p.heading = Math.PI;
  p.speed = 0; p.knock.set(0, 0, 0);
});
for (let round = 0; round < 26; round++) {
  const st = await page.evaluate(() => {
    const z = window.__zoomies;
    const p = z.karts[0], t = z.karts[1];
    if (z.hairballs.balls.length === 0 && t._koTimer <= 0 && t.spinTimer <= 0) {
      t.position.x = p.position.x + Math.sin(p.heading) * 11;
      t.position.z = p.position.z + Math.cos(p.heading) * 11;
      t.speed = 0; t.shieldTimer = 0; t.catnipTimer = 0; t.lives = 0;
      p.shootCooldown = 0;
      return { parked: true, ko: false };
    }
    return { parked: false, ko: t._koTimer > 0 };
  });
  if (st.ko) { combat.ko = true; break; }
  if (st.parked) {
    await page.keyboard.down("KeyF");
    await page.waitForTimeout(300);
    await page.keyboard.up("KeyF");
  }
  for (let w = 0; w < 12; w++) {
    await page.waitForTimeout(500);
    if (await page.evaluate(() => window.__zoomies.hairballs.balls.length === 0 && window.__zoomies.karts[1].spinTimer <= 0)) break;
  }
}
if (combat.ko) await page.screenshot({ path: path.join(SHOTS, "battle-6-ko.png") });
for (let i = 0; i < 26 && !combat.respawned; i++) {
  await page.waitForTimeout(1000);
  combat.respawned = await page.evaluate(() => {
    const t = window.__zoomies.karts[1];
    return t._koTimer <= 0 && t.group.visible && t.battleHearts === 3;
  });
}
const myKOs = await page.evaluate(() => window.__zoomies.karts[0].battleKOs);
// Liveness only — the audit owns pool health; four AI strip boxes constantly.
if (combat.boxes < 3) errors.push(`floating box pool looks dead (${combat.boxes} of 10)`);
if (!combat.aiAlive) errors.push("battle AI never drove");
if (!combat.ko) errors.push("never KO'd the target AI");
if (combat.ko && !combat.respawned) errors.push("KO'd kart never respawned");
if (combat.ko && myKOs < 1) errors.push(`KO not credited (player KOs ${myKOs})`);

// --- Leg 7: match end ------------------------------------------------------
await page.evaluate(() => { window.__zoomies.battle.left = 5; });
let ended = false;
for (let i = 0; i < 50 && !ended; i++) {
  await page.waitForTimeout(1000);
  ended = await page.evaluate(() => !document.getElementById("results").classList.contains("hidden"));
}
if (!ended) errors.push("match never ended");
else {
  const title = await page.evaluate(() => document.getElementById("results-title").textContent);
  const rows = await page.evaluate(() => document.getElementById("results-list").children.length);
  if (!/KO|Top Cat/.test(title)) errors.push(`battle results title looks wrong: "${title}"`);
  if (rows !== 4) errors.push(`standings should list 4 cats, got ${rows}`);
  await page.screenshot({ path: path.join(SHOTS, "battle-7-results.png") });
  await page.evaluate(() => document.getElementById("results").classList.add("hidden"));
}

// --- Overview shots --------------------------------------------------------
for (const [name, px, py, pz] of [["battle-8-overview", 0, 150, 105], ["battle-9-low", -105, 34, 78]]) {
  await page.evaluate(({ px, py, pz }) => {
    const cam = window.__zoomies.camera;
    cam.position.copy = function () { return this; };
    cam.lookAt = () => {};
    cam.position.set(px, py, pz);
    Object.getPrototypeOf(Object.getPrototypeOf(cam)).lookAt.call(cam, 0, 2, 0);
  }, { px, py, pz });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

console.log(JSON.stringify({ pod, fly, underMax, deckTop, megaAir, megaVy, escaped, combat, myKOs, errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
