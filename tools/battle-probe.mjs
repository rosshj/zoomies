// Battle-arena probe (Whisker Junction): boots ?battle=1, starts the session
// and verifies the authored map + ballistic air end-to-end:
//   - spawn → plaza → under the café awning (no level snap) → stopped by the
//     café wall (containment by architecture, not a radial fence),
//   - pad → kicker clears the alley walls with honest ballistic air,
//   - café roof holds at h6, and driving off its lip is a clean drop,
//   - the parkade still works both storeys + the deck-edge drop,
//   - the mega-ramp wedge launches,
//   - the tower's gap cliff can't be climbed,
//   - full combat loop: KO, credit, respawn (authored spawn points), match end.
// Screenshots land in the scratchpad for the look-at-it half of the loop.
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
// Shield the player through the terrain legs so the live AI can't randomize them.
await page.evaluate(() => { window.__zoomies.karts[0].shieldTimer = 9999; });
await page.screenshot({ path: path.join(SHOTS, "battle-1-grid.png") });

const sample = () => page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  return {
    x: +k.position.x.toFixed(2), z: +k.position.z.toFixed(2),
    gy: +k.position.y.toFixed(2), air: +k.y.toFixed(2), speed: +k.speed.toFixed(2),
    wallHit: k.wallHitPulse > 0, lap: k.lap,
  };
});

// Hold throttle, wait out veil + countdown.
await page.keyboard.down("ArrowUp");
const tGo = Date.now();
let unlocked = false;
while (Date.now() - tGo < 90000) {
  unlocked = await page.evaluate(() => window.__zoomies.karts[0].throttleInput > 0);
  if (unlocked) break;
  await page.waitForTimeout(500);
}
if (!unlocked) errors.push("control never unlocked (countdown/veil never finished)");

// Park the AI during the geometry legs (the KO hold keeps them frozen +
// hidden) — they hunt the player and mobbing randomizes pure map tests.
await page.evaluate(() => {
  for (const k of window.__zoomies.karts) if (!k.isPlayer) k._koTimer = 9999;
});

// --- Leg 1: spawn → plaza → under the awning → stopped by the café ---------
let minZ = 99, awningOk = true, sawWall = false, maxSpeed = 0, contained = true, lapLast = -1;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const s = await sample();
  maxSpeed = Math.max(maxSpeed, s.speed);
  minZ = Math.min(minZ, s.z);
  if (s.z < -44 && s.z > -55 && s.gy > 2.5) awningOk = false; // snapped onto the awning
  if (s.wallHit) sawWall = true;
  if (Math.abs(s.x) > 120 || Math.abs(s.z) > 105) contained = false;
  lapLast = s.lap;
  if (i === 8) await page.screenshot({ path: path.join(SHOTS, "battle-2-plaza.png") });
  if (s.z < -46) { await page.screenshot({ path: path.join(SHOTS, "battle-2b-awning.png") }); }
  if (minZ < -48 && sawWall) break;
}
await page.keyboard.up("ArrowUp");
if (maxSpeed < 15) errors.push(`kart barely moved (max speed ${maxSpeed})`);
if (minZ > -44) errors.push(`never reached the café porch (min z ${minZ})`);
if (minZ < -57.5) errors.push(`drove through the café wall (min z ${minZ})`);
if (!awningOk) errors.push("ground snapped onto the awning while driving under it");
if (!sawWall) errors.push("café wall never latched a wall hit");
if (!contained) errors.push("kart escaped the boundary walls");
if (lapLast !== -1) errors.push(`laps advanced in an arena (lap ${lapLast})`);

// --- Leg 2: pad → kicker → ballistic air over the alley --------------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const kick = window.__zoomies.track.kickers[0];
  k.position.x = kick.x - Math.sin(kick.yaw) * 42;
  k.position.z = kick.z - Math.cos(kick.yaw) * 42;
  k.heading = kick.yaw;
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
let sawAir = 0, maxAir = 0, padSpeed = 0;
for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  padSpeed = Math.max(padSpeed, s.speed);
  if (s.speed > 20) {
    maxAir = Math.max(maxAir, s.air);
    if (s.air > 0.7) {
      sawAir++;
      if (sawAir === 2) await page.screenshot({ path: path.join(SHOTS, "battle-4-air.png") });
    }
  }
  if (sawAir >= 2 && maxAir > 2) break;
}
await page.keyboard.up("ArrowUp");
if (sawAir < 2) errors.push("kicker never launched the kart (no ballistic air)");
if (maxAir < 2) errors.push(`air too small (apex ${maxAir})`);
if (padSpeed < 40) errors.push(`boost pad never fired (max speed ${padSpeed})`);

// --- Leg 3: café roof — holds at 6, drops clean off the lip ----------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  k.position.x = 0; k.position.z = -72; k.position.y = 6;
  k.heading = 0; // toward the plaza (the hazard-striped lip)
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
const roof = { held: false, dropAir: 0, landed: false };
// Roof → awning (flush at h6) → off the awning lip → plaza: allow the full run.
for (let i = 0; i < 34; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  if (s.gy > 5.5) roof.held = true;
  roof.dropAir = Math.max(roof.dropAir, s.air);
  if (roof.held && s.air <= 0.05 && s.gy < 2.5) { roof.landed = true; break; }
}
await page.keyboard.up("ArrowUp");
if (!roof.held) errors.push("café roof surface never registered");
if (roof.dropAir < 1.5) errors.push(`café roof lip gave no air (${roof.dropAir})`);
if (!roof.landed) errors.push("never landed in the plaza after the roof drop");

// --- Leg 4: parkade — both storeys + the deck-edge drop --------------------
const parkade = { underMax: 0, deckSeen: false, dropAir: 0, landed: false };
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const P = window.__zoomies.track.parkade;
  k.position.x = P.x; k.position.z = P.z; k.position.y = 0.5;
  k.heading = P.yaw + Math.PI;
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  parkade.underMax = Math.max(parkade.underMax, s.gy);
}
await page.keyboard.up("ArrowUp");
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const P = window.__zoomies.track.parkade;
  k.position.x = P.x; k.position.z = P.z; k.position.y = P.h;
  k.heading = P.yaw + Math.PI;
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
for (let i = 0; i < 18; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  if (s.gy > 7.5) parkade.deckSeen = true;
  parkade.dropAir = Math.max(parkade.dropAir, s.air);
  if (parkade.deckSeen && s.air <= 0.05 && s.gy < 2.5) { parkade.landed = true; break; }
}
await page.keyboard.up("ArrowUp");
await page.screenshot({ path: path.join(SHOTS, "battle-10-parkade.png") });
if (parkade.underMax > 2.5) errors.push(`ground snapped toward the deck underneath (gy ${parkade.underMax})`);
if (!parkade.deckSeen) errors.push("never registered the parkade deck");
if (parkade.dropAir < 1.5) errors.push(`deck-edge drop gave no air (${parkade.dropAir})`);
if (!parkade.landed) errors.push("never landed after the parkade drop");

// --- Leg 5: mega-ramp wedge ------------------------------------------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const M = window.__zoomies.track.megaRamp;
  k.position.x = M.x - Math.sin(M.yaw) * 14;
  k.position.z = M.z - Math.cos(M.yaw) * 14;
  k.position.y = 0.5;
  k.heading = M.yaw;
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
});
await page.keyboard.down("ArrowUp");
let megaAir = 0;
for (let i = 0; i < 22; i++) {
  await page.waitForTimeout(700);
  const s = await sample();
  if (s.speed > 15) megaAir = Math.max(megaAir, s.air);
  if (megaAir > 2) { await page.screenshot({ path: path.join(SHOTS, "battle-11-megaramp.png") }); break; }
}
await page.keyboard.up("ArrowUp");
if (megaAir < 2) errors.push(`mega-ramp never launched (max air ${megaAir})`);

// --- Leg 6: tower gap cliff must not be climbable --------------------------
await page.evaluate(() => {
  const k = window.__zoomies.karts[0];
  const B = window.__zoomies.track.butte;
  k.position.x = B.x + Math.sin(-0.08) * 24;
  k.position.z = B.z + Math.cos(-0.08) * 24;
  k.position.y = 0.5;
  k.heading = Math.atan2(B.x - k.position.x, B.z - k.position.z);
  k.speed = 0; k.knock.set(0, 0, 0); k.y = 0; k.vy = 0; k.airborne = false;
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
if (wallMaxGy > 5.5) errors.push(`climbed the tower cliff (gy ${wallMaxGy})`);
if (!wallSpark) errors.push("tower wall never latched the spark pulse");

// Release the parked AI (they respawn at the authored points).
await page.evaluate(() => {
  for (const k of window.__zoomies.karts) if (!k.isPlayer) k._koTimer = 0.01;
});
await page.waitForTimeout(4000);

// --- Leg 7: combat — shoot an AI to a KO, watch it respawn -----------------
const combat = { ko: false, respawned: false, boxes: 0, aiAlive: false };
combat.boxes = await page.evaluate(() =>
  window.__zoomies.props ? window.__zoomies.props._props.filter((p) => p.kind === "crate" && p.mode === "float").length : -1
);
combat.aiAlive = await page.evaluate(() =>
  window.__zoomies.karts.some((k) => !k.isPlayer && Math.abs(k.throttleInput) > 0.1)
);
await page.evaluate(() => {
  const p = window.__zoomies.karts[0];
  p.shieldTimer = 9999;
  p.position.x = 0; p.position.z = 60; p.position.y = 0.5;
  p.heading = Math.PI; p.speed = 0; p.knock.set(0, 0, 0);
});
for (let round = 0; round < 30; round++) {
  const st = await page.evaluate(() => {
    const z = window.__zoomies;
    const p = z.karts[0];
    const t = z.karts[1];
    const ballsLive = z.hairballs.balls.length > 0;
    if (!ballsLive && t._koTimer <= 0 && t.spinTimer <= 0) {
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      t.position.x = p.position.x + fx * 11;
      t.position.z = p.position.z + fz * 11;
      t.speed = 0;
      t.shieldTimer = 0;
      t.catnipTimer = 0;
      t.lives = 0;
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
    const done = await page.evaluate(() => {
      const z = window.__zoomies;
      return z.hairballs.balls.length === 0 && z.karts[1].spinTimer <= 0;
    });
    if (done) break;
  }
}
if (combat.ko) await page.screenshot({ path: path.join(SHOTS, "battle-8-ko.png") });
for (let i = 0; i < 30 && !combat.respawned; i++) {
  await page.waitForTimeout(1000);
  combat.respawned = await page.evaluate(() => {
    const t = window.__zoomies.karts[1];
    return t._koTimer <= 0 && t.group.visible && t.battleHearts === 3;
  });
}
const myKOs = await page.evaluate(() => window.__zoomies.karts[0].battleKOs);
if (combat.boxes < 8) errors.push(`floating box pool too small (${combat.boxes} of 10)`);
if (!combat.aiAlive) errors.push("battle AI never drove");
if (!combat.ko) errors.push("never KO'd the target AI");
if (combat.ko && !combat.respawned) errors.push("KO'd kart never respawned");
if (combat.ko && myKOs < 1) errors.push(`KO not credited (player KOs ${myKOs})`);

// --- Leg 8: match end ------------------------------------------------------
await page.evaluate(() => { window.__zoomies.battle.left = 5; });
let ended = false;
for (let i = 0; i < 60 && !ended; i++) {
  await page.waitForTimeout(1000);
  ended = await page.evaluate(() => !document.getElementById("results").classList.contains("hidden"));
}
if (!ended) errors.push("match never ended (timer → results flow broken)");
else {
  const resultsTitle = await page.evaluate(() => document.getElementById("results-title").textContent);
  const rows = await page.evaluate(() => document.getElementById("results-list").children.length);
  if (!/KO|Top Cat/.test(resultsTitle)) errors.push(`battle results title looks wrong: "${resultsTitle}"`);
  if (rows !== 4) errors.push(`battle standings should list 4 cats, got ${rows}`);
  await page.screenshot({ path: path.join(SHOTS, "battle-9-results.png") });
  await page.evaluate(() => document.getElementById("results").classList.add("hidden"));
}

// --- Overview shots (pinned camera) ----------------------------------------
for (const [name, px, py, pz] of [
  ["battle-6-overview", 0, 235, 160],
  ["battle-7-low", -190, 70, 125],
]) {
  await page.evaluate(({ px, py, pz }) => {
    const cam = window.__zoomies.camera;
    cam.position.copy = function () { return this; };
    cam.lookAt = () => {};
    cam.position.set(px, py, pz);
    Object.getPrototypeOf(Object.getPrototypeOf(cam)).lookAt.call(cam, 0, 0, -10);
  }, { px, py, pz });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

console.log(JSON.stringify({
  minZ, maxSpeed, maxAir, padSpeed, roof, parkade, megaAir, wallMaxGy, combat, myKOs, errors,
}, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
