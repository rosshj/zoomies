// Battle PATHOLOGY AUDIT.
//
// The probe checks that features work; this checks that the map isn't
// FRUSTRATING — the thing that kept shipping broken because "does the kart
// reach height X" passes green while the game plays badly. It drives the whole
// field around for minutes of sim time and counts the things that actually
// ruin a match:
//
//   stuck      — full throttle, near-zero speed, sustained (caught on geometry)
//   grind      — % of driving time in wall contact (sticky/clippy architecture)
//   rocket     — take-off vertical speed outside the physically sane band
//   slam       — a landing that dumps most of your speed
//   airtime    — how much of the match is spent flying (too much = trampoline)
//
// Plus a REACHABILITY flood-fill over the drivable surface: every item box,
// ramp top and respawn point must be reachable from the start grid by driving
// (climbing only slopes a kart can actually climb). That catches "you can't
// get up this thing" analytically instead of waiting for a playtest.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8092;
const SHOTS = process.env.SHOTS || "/tmp";
const DRIVE_SECONDS = Number(process.env.DRIVE || 150);

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
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/index.html?battle=1&webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
await page.waitForSelector("#start-btn", { timeout: 15000 });
await page.click("#start-btn", { force: true });
for (let i = 0; i < 120; i++) {
  if (await page.evaluate(() => !!window.__zoomies?.karts?.[0]).catch(() => false)) break;
  await page.waitForTimeout(1000);
}
for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => window.__zoomies.karts[0].throttleInput > 0 || window.__zoomies.karts[1]?.throttleInput > 0)) break;
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(500);
}
await page.keyboard.up("ArrowUp");

// --- Reachability: flood-fill the drivable surface from the start grid ------
const reach = await page.evaluate(() => {
  const t = window.__zoomies.track;
  const H = t.half;
  const STEP = 1.5;
  const MAX_CLIMB = STEP * 0.62; // ~32° — what a kart can actually drive up
  const N = Math.floor((H * 2) / STEP);
  const xz = (i, j) => [-H + i * STEP, -H + j * STEP];
  // MULTI-LEVEL fill: a cell can carry two drivable surfaces (the ground, and
  // a deck above it). Flooding only the base would call every drive-under deck
  // unreachable — which is exactly what the first audit run reported.
  const layersAt = (x, z) => {
    const base = t.heightAt(x, z);
    const deck = t._deckSurface(x, z);
    return deck == null ? [base] : [base, deck];
  };
  const id = (i, j, l) => (i * N + j) * 2 + l;
  const seen = new Uint8Array(N * N * 2);
  const start = t.gridSlot(0).position;
  const si = Math.round((start.x + H) / STEP), sj = Math.round((start.z + H) / STEP);
  const q = [id(si, sj, 0)];
  seen[id(si, sj, 0)] = 1;
  let visited = 0;
  while (q.length) {
    const cur = q.pop();
    visited++;
    const l = cur % 2, cell = (cur - l) / 2;
    const i = Math.floor(cell / N), j = cell % N;
    const [x, z] = xz(i, j);
    const h = layersAt(x, z)[l];
    if (h === undefined) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const [nx, nz] = xz(ni, nj);
      const ls = layersAt(nx, nz);
      for (let nl = 0; nl < ls.length; nl++) {
        const nid = id(ni, nj, nl);
        if (seen[nid]) continue;
        if (ls[nl] - h > MAX_CLIMB) continue; // too steep to climb from here
        if (h - ls[nl] > 14) continue; // a sheer plunge is not a driving route
        let blocked = false;
        for (const o of t.obstacles) {
          if (o.h < 1) continue;
          if (Math.hypot(nx - o.x, nz - o.z) < o.r + 1.2 && ls[nl] < o.h - 0.5) { blocked = true; break; }
        }
        if (blocked) continue;
        seen[nid] = 1;
        q.push(nid);
      }
    }
  }
  const canReach = (x, z, y) => {
    const i = Math.round((x + H) / STEP), j = Math.round((z + H) / STEP);
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const [px, pz] = xz(ii, jj);
        const ls = layersAt(px, pz);
        for (let l = 0; l < ls.length; l++) {
          if (!seen[id(ii, jj, l)]) continue;
          if (y == null || Math.abs(ls[l] - y) < 2.5) return true;
        }
      }
    }
    return false;
  };
  const badBoxes = t.itemSpots().filter((s) => !canReach(s.x, s.z, s.y != null ? s.y : null))
    .map((s) => `${s.x},${s.z}${s.y != null ? "@" + s.y : ""}`);
  const badRamps = t.ramps.filter((rp) => {
    const hx = rp.x + Math.sin(rp.yaw) * (rp.L - 1), hz = rp.z + Math.cos(rp.yaw) * (rp.L - 1);
    return !canReach(hx, hz, rp.h1);
  }).map((rp) => `ramp@${rp.x},${rp.z}`);
  const badSpawns = t.respawns.filter((s) => !canReach(s.x, s.z, null)).map((s) => `${s.x},${s.z}`);
  // Placement sanity: a pickup jammed against a building makes every AI that
  // wants it grind on that wall. Anything the karts are drawn to must sit in
  // open ground.
  const tooClose = (x, z, y) => {
    for (const b of t.solids || []) {
      if (b.bound > 30) continue; // perimeter walls
      if (y != null && y > b.h - 0.5) continue; // on top of it is fine
      const dx = x - b.x, dz = z - b.z;
      const u = Math.abs(dx * b.sin + dz * b.cos) - b.d / 2;
      const v = Math.abs(dx * b.cos - dz * b.sin) - b.w / 2;
      if (Math.max(u, v) < 6) return `${b.x},${b.z}`;
    }
    for (const o of t.obstacles) {
      if (o.h < 1) continue;
      if (y != null && y > o.h - 0.5) continue;
      if (Math.hypot(x - o.x, z - o.z) < o.r + 6) return `obstacle ${o.x},${o.z}`;
    }
    return null;
  };
  const crowdedSpots = [];
  for (const s of t.itemSpots()) {
    const near = tooClose(s.x, s.z, s.y);
    if (near) crowdedSpots.push(`box ${s.x},${s.z} vs ${near}`);
  }
  for (const p of t.boostPads) {
    const near = tooClose(p.x, p.z, p.y);
    if (near) crowdedSpots.push(`pad ${p.x},${p.z} vs ${near}`);
  }
  return {
    cells: N * N, visited, coverage: +(visited / (N * N)).toFixed(3), // >1 where decks stack

    podiumTop: canReach(0, 0, t.podium.h), deckTop: canReach(t.deck.x, t.deck.z, t.deck.h),
    badBoxes, badRamps, badSpawns, crowdedSpots,
  };
});

// --- Chaos drive: let the field brawl and watch for pathologies -------------
await page.evaluate(() => {
  const z = window.__zoomies;
  z.__audit = {
    stuck: 0, stuckAt: [], grindFrames: 0, frames: 0, airFrames: 0,
    rockets: 0, rocketAt: [], slams: 0, maxVy: 0, maxAir: 0, landings: 0,
  };
  const A = z.__audit;
  const prev = new Map();
  z.__auditTimer = setInterval(() => {
    for (const k of z.karts) {
      if (k._koTimer > 0) continue;
      A.frames++;
      const p = prev.get(k) || {};
      if (k.wallHitPulse > 0) A.grindFrames++;
      if (!k.grounded) {
        A.airFrames++;
        A.maxAir = Math.max(A.maxAir, +k.y.toFixed(2));
      }
      // Take-off: grounded → airborne. The ceiling for a LEGITIMATE launch is
      // boost speed (~60) on the steepest authored ramp (~21°) ≈ 21 u/s
      // vertical. Anything past that means the sampler read a wall face.
      if (p.grounded === true && !k.grounded) {
        const vy = k.vel.y;
        A.maxVy = Math.max(A.maxVy, +vy.toFixed(2));
        if (vy > 23) {
          A.rockets++;
          A.rocketAt.push(`${k.position.x.toFixed(0)},${k.position.z.toFixed(0)} vy=${vy.toFixed(1)}`);
        }
      }
      // Landing: airborne → grounded, with a big speed loss.
      if (p.grounded === false && k.grounded) {
        A.landings++;
        if (p.speed > 18 && Math.abs(k.speed) < p.speed * 0.45) A.slams++;
      }
      // Stuck = DISPLACEMENT, not speed. A kart crawling through a four-way
      // scrum is playing the game; a kart that wants to go forward and has
      // covered no ground in seconds is wedged on geometry. (Reversing is
      // legitimate recovery, so only forward intent counts.)
      // A kart being SHOVED by a rival isn't wedged, it's playing — only count
      // it when nothing is touching it, so this measures the map and not the
      // brawl. (The start grid is deliberately packed, hence the warm-up skip.)
      let crowded = false;
      for (const other of z.karts) {
        if (other === k || other._koTimer > 0) continue;
        if (Math.hypot(other.position.x - k.position.x, other.position.z - k.position.z) < 6.5) { crowded = true; break; }
      }
      A.t = (A.t || 0) + 0.025; // 4 karts × 10 Hz
      // spinTimer > 0 means it just took a hit and is sliding it off — the
      // throttle is still down but the kart isn't driving. That's combat, not
      // a wedge.
      if (k.throttleInput > 0.5 && k.grounded && !crowded && k.spinTimer <= 0 && A.t > 15) {
        if (!k._stuckAnchor) k._stuckAnchor = { x: k.position.x, z: k.position.z, t: 0 };
        k._stuckAnchor.t += 0.1;
        const moved = Math.hypot(k.position.x - k._stuckAnchor.x, k.position.z - k._stuckAnchor.z);
        if (moved > 4) k._stuckAnchor = { x: k.position.x, z: k.position.z, t: 0 };
        else if (k._stuckAnchor.t > 2.5) {
          A.stuck++;
          A.stuckAt.push(`${k.position.x.toFixed(0)},${k.position.z.toFixed(0)}@${A.t.toFixed(0)}s`);
          k._stuckAnchor = null;
        }
      } else {
        k._stuckAnchor = null;
      }
      prev.set(k, { grounded: k.grounded, speed: Math.abs(k.speed) });
    }
  }, 100);
});

// Drive the player too: a wandering bot, so all four karts stress the map.
await page.evaluate(() => {
  const z = window.__zoomies;
  const p = z.karts[0];
  p.shieldTimer = 1e9; // stay alive; we're auditing geometry, not combat
  let t = 0;
  z.__driveTimer = setInterval(() => {
    t += 0.25;
    p.throttleInput = 1;
    p.steerInput = Math.sin(t * 0.7) * 0.8 + Math.sin(t * 0.23) * 0.5;
    if (Math.random() < 0.01) p.jump(); // occasional hop, like a player — not a pogo stick
  }, 250);
});

const t0 = Date.now();
let lastLog = 0;
while ((Date.now() - t0) / 1000 < DRIVE_SECONDS) {
  await page.waitForTimeout(5000);
  const el = Math.round((Date.now() - t0) / 1000);
  if (el - lastLog >= 30) {
    lastLog = el;
    const a = await page.evaluate(() => window.__zoomies.__audit);
    console.error(`  ${el}s · stuck ${a.stuck} · grind ${(a.grindFrames / Math.max(1, a.frames) * 100).toFixed(1)}% · rockets ${a.rockets} · slams ${a.slams}`);
  }
}
await page.evaluate(() => {
  clearInterval(window.__zoomies.__auditTimer);
  clearInterval(window.__zoomies.__driveTimer);
});
const audit = await page.evaluate(() => window.__zoomies.__audit);
await page.screenshot({ path: path.join(SHOTS, "audit-end.png") });

const grindPct = +(audit.grindFrames / Math.max(1, audit.frames) * 100).toFixed(1);
const airPct = +(audit.airFrames / Math.max(1, audit.frames) * 100).toFixed(1);

// Gates. These are the numbers that mean "not frustrating".
// A TRAP is a place that catches karts over and over; isolated events in a
// dense four-way brawl are just bad luck. Gate on repeats at one spot (5u
// buckets) and on the overall rate.
const buckets = new Map();
for (const s of audit.stuckAt) {
  const [xy] = s.split("@");
  const [x, z] = xy.split(",").map(Number);
  const key = `${Math.round(x / 5) * 5},${Math.round(z / 5) * 5}`;
  buckets.set(key, (buckets.get(key) || 0) + 1);
}
const traps = [...buckets.entries()].filter(([, n]) => n >= 3);
if (traps.length) errors.push(`geometry trap(s) — repeated wedging at ${traps.map(([k, n]) => `${k} x${n}`).join(" | ")}`);
if (audit.stuck > 20) errors.push(`${audit.stuck} stuck events in ${DRIVE_SECONDS}s (too frequent): ${audit.stuckAt.slice(0, 6).join(" | ")}`);
if (grindPct > 12) errors.push(`wall grind ${grindPct}% of driving time (sticky architecture)`);
if (audit.rockets > 0) errors.push(`${audit.rockets} absurd launch(es): ${audit.rocketAt.slice(0, 4).join(" | ")}`);
if (airPct > 30) errors.push(`airborne ${airPct}% of the time (trampoline map)`);
if (audit.landings >= 15 && audit.slams / audit.landings > 0.35) errors.push(`${audit.slams}/${audit.landings} landings dumped most of the speed`);
if (reach.coverage < 0.55) errors.push(`only ${(reach.coverage * 100).toFixed(0)}% of the map is reachable by driving`);
if (!reach.podiumTop) errors.push("the podium roof is NOT reachable by driving");
if (!reach.deckTop) errors.push("the shade deck is NOT reachable by driving");
if (reach.badBoxes.length) errors.push(`unreachable item boxes: ${reach.badBoxes.join(" | ")}`);
if (reach.badRamps.length) errors.push(`unreachable ramp tops: ${reach.badRamps.join(" | ")}`);
if (reach.badSpawns.length) errors.push(`unreachable respawn points: ${reach.badSpawns.join(" | ")}`);
if (reach.crowdedSpots.length) errors.push(`pickups jammed against geometry: ${reach.crowdedSpots.join(" | ")}`);

console.log(JSON.stringify({ drive: DRIVE_SECONDS, audit: { ...audit, grindPct, airPct }, reach, errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
