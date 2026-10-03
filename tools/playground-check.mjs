// Feature playground smoke test (playground.html). Boots the page headless,
// visits every area and drives the kart through the thing each one stages:
// smashes a structure (pieces must move and the kart must slow), launches off
// the ramp (the kart must leave the ground and land), fires every power-up,
// and lands on the shipped-props loop — asserting no page errors throughout.
// Screenshots of each area land in $OUT for eyeballing.
//   node tools/playground-check.mjs        (npm run check:playground)
import { launchArtBrowser } from "./art-browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/zoomies-playground";
fs.mkdirSync(OUT, { recursive: true });
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/favicon.ico") return void res.writeHead(204).end();
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) return void res.writeHead(404).end("404 " + u);
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ok  " : "FAIL  ") + name + (extra ? `  (${extra})` : ""));
  if (!cond) failures++;
};

const browser = await launchArtBrowser();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 680 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`http://127.0.0.1:${port}/playground.html?webgl=1&area=smash`, { waitUntil: "load", timeout: 180000 });
await page.waitForFunction(() => window.__playground && window.__playground.area, null, { timeout: 180000 });
check("page boots with the first area built", true);

// Helper: run the sim by hand (frozen live loop) so results don't depend on
// SwiftShader's frame rate.
const run = (js) => page.evaluate(js);
await run(() => window.__playground.freeze(true));

// --- Destructibles: drive flat out into the first station --------------------
{
  const r = await run(() => {
    const P = window.__playground;
    const before = P.area.props._props.filter((p) => p.dormant).length;
    P.teleport(0);
    P.drive(1, 0);
    let launchSpeed = 0,
      smashedAt = -1;
    for (let i = 0; i < 360; i++) {
      P.step(1 / 60);
      if (P.smashed > 0 && smashedAt < 0) {
        smashedAt = i;
        launchSpeed = Math.abs(P.player.speed);
        P.drive(0, 0); // coast: the pieces get their 4s, the next station stays intact
      }
    }
    const st = P.area.props.structures.find((s) => s.broken);
    const moved = st ? st.pieces.filter((p) => p.pos.distanceTo(st.pos) > 1.5).length : 0;
    const dormantNow = P.area.props._props.filter((p) => p.dormant).length;
    return {
      before,
      smashed: P.smashed,
      smashedAt,
      launchSpeed,
      pieces: st?.pieces.length,
      moved,
      dormantNow,
      kind: st?.kind,
    };
  });
  check("structure broke when the kart drove through it", r.smashed >= 1, JSON.stringify(r));
  check("its pieces were released and scattered", r.moved >= 4, `${r.moved}/${r.pieces} moved`);
  check(
    "released pieces are no longer dormant",
    r.dormantNow === r.before - r.pieces,
    `${r.dormantNow} vs ${r.before - r.pieces}`,
  );
  await page.screenshot({ path: path.join(OUT, "smash.png") });
  const rs = await run(() => {
    const P = window.__playground;
    P.resetArea();
    const st = P.area.props.structures[0];
    return {
      broken: P.area.props.structures.some((s) => s.broken),
      dormant: st.pieces.every((p) => p.dormant),
      smashed: P.smashed,
    };
  });
  check("reset re-assembles every structure", !rs.broken && rs.dormant && rs.smashed === 0, JSON.stringify(rs));
}

// --- Autopilot: hands-free driving must line up on stations and smash ---------
{
  const r = await run(() => {
    const P = window.__playground;
    P.resetArea();
    P.setAutoplay(true);
    let offroad = 0;
    for (let i = 0; i < 1500; i++) {
      P.step(1 / 60);
      if (Math.abs(P.player._proj?.lateral ?? 0) > P.area.track.halfWidth) offroad++;
    }
    const out = { smashed: P.smashed, offroad, speed: Math.abs(P.player.speed), t: P.player.trackT };
    P.setAutoplay(false);
    P.resetArea();
    return out;
  });
  check("autopilot smashes stations hands-free", r.smashed >= 2 && r.offroad === 0 && r.speed > 10, JSON.stringify(r));
}

// --- Karts are solid: a piece dropped onto the kart must not pass through ----
{
  const r = await run(() => {
    const P = window.__playground;
    P.resetArea();
    P.drive(0, 0);
    P.player.speed = 0;
    const k = P.player;
    const pr = P.area.props._props.find((p) => p.kind === "crate" && p.mode === "ground");
    pr.asleep = false;
    pr.settle = false;
    pr.vel.set(0, 0, 0);
    pr.angVel.set(0, 0, 0);
    pr.pos.set(k.position.x, k.position.y + 4, k.position.z);
    pr.roadIndex = k._proj.i;
    let minBottom = Infinity,
      bounced = false;
    for (let i = 0; i < 180; i++) {
      P.step(1 / 60);
      const inside = Math.hypot(pr.pos.x - k.position.x, pr.pos.z - k.position.z) < 1.2;
      if (inside) minBottom = Math.min(minBottom, pr.pos.y - pr.rest - k.position.y);
      if (pr.vel.y > 0.5 && pr.pos.y - k.position.y < 3) bounced = true;
    }
    const d = Math.hypot(pr.pos.x - k.position.x, pr.pos.z - k.position.z);
    return { minBottom, bounced, finalDist: d, finalY: pr.pos.y - k.position.y };
  });
  check(
    "a piece dropped on the kart bounces off instead of passing through",
    r.minBottom > -0.6 && (r.bounced || r.finalDist > 1.2),
    JSON.stringify(r),
  );
  // …and never rides along on the roof: drop one on a MOVING kart and it
  // must be off the kart and on the road within a couple of seconds.
  const ride = await run(() => {
    const P = window.__playground;
    P.resetArea();
    P.drive(1, 0);
    const k = P.player;
    const pr = P.area.props._props.find((p) => p.kind === "crate" && p.mode === "ground");
    for (let i = 0; i < 60; i++) P.step(1 / 60);
    pr.asleep = false;
    pr.settle = false;
    pr.vel.set(Math.sin(k.heading) * k.speed, 0, Math.cos(k.heading) * k.speed);
    pr.angVel.set(0, 0, 0);
    pr.pos.set(k.position.x, k.position.y + 2.6, k.position.z);
    pr.roadIndex = k._proj.i;
    let onKart = 0;
    for (let i = 0; i < 180; i++) {
      P.step(1 / 60);
      const dx = pr.pos.x - k.position.x,
        dz = pr.pos.z - k.position.z;
      if (Math.hypot(dx, dz) < 2.2 && pr.pos.y - k.position.y > 1.0) onKart++;
    }
    const d = Math.hypot(pr.pos.x - k.position.x, pr.pos.z - k.position.z);
    P.drive(0, 0);
    P.resetArea();
    return { onKart, finalDist: d, y: pr.pos.y - pr.rest - (pr.groundY ?? 0) };
  });
  check(
    "a piece dropped on a moving kart slides off within a second",
    ride.onKart < 70 && ride.finalDist > 4,
    JSON.stringify(ride),
  );
  // …nor wedged on the nose or flank: a piece pushed INTO the moving kart's
  // box (where the old collider shoved it a radius a frame and kept it,
  // spinning) is out of the box and off to the side within half a second.
  const wedge = await run(() => {
    const P = window.__playground;
    P.resetArea();
    P.drive(1, 0);
    const k = P.player;
    const pr = P.area.props._props.find((p) => p.kind === "crate" && p.mode === "ground");
    for (let i = 0; i < 60; i++) P.step(1 / 60);
    pr.asleep = false;
    pr.settle = false;
    pr.vel.set(Math.sin(k.heading) * k.speed, 0, Math.cos(k.heading) * k.speed);
    pr.angVel.set(0, 0, 0);
    // Centre inside the box, low on the bonnet, a touch off-centre.
    pr.pos.set(
      k.position.x + Math.sin(k.heading) * 1.2 + Math.cos(k.heading) * 0.3,
      k.position.y + 0.7,
      k.position.z + Math.cos(k.heading) * 1.2 - Math.sin(k.heading) * 0.3,
    );
    pr.roadIndex = k._proj.i;
    let inBox = 0,
      near = 0,
      peakSpin = 0;
    for (let i = 0; i < 180; i++) {
      P.step(1 / 60);
      const dx = pr.pos.x - k.position.x,
        dz = pr.pos.z - k.position.z;
      const fx = Math.sin(k.heading),
        fz = Math.cos(k.heading);
      const lz = dx * fx + dz * fz,
        lx = dx * fz - dz * fx;
      if (Math.abs(lx) < 1.25 && Math.abs(lz) < 2.0 && pr.pos.y - k.position.y < 1.6) inBox++;
      if (Math.hypot(dx, dz) < 3.2) near++;
      peakSpin = Math.max(peakSpin, pr.angVel.length());
    }
    const d = Math.hypot(pr.pos.x - k.position.x, pr.pos.z - k.position.z);
    P.drive(0, 0);
    P.resetArea();
    return { inBox, near, peakSpin, finalDist: d };
  });
  check(
    "a piece wedged into the moving kart is shed within half a second",
    wedge.inBox < 12 && wedge.near < 40 && wedge.finalDist > 6,
    JSON.stringify(wedge),
  );
}

// --- Biome scenes: every biome's recipes smash under the autopilot ---------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("scenes");
    P.freeze(true);
    const scenes = P.area.props.sceneCount;
    const proxies = P.area.props.structures.filter((s) => s.proxy && s.proxy.visible).length;
    const hidden = P.area.props._props.filter((p) => p.structure && !p.mesh.visible).length;
    P.setAutoplay(true);
    for (let i = 0; i < 2400; i++) P.step(1 / 60);
    const out = {
      scenes,
      proxies,
      hidden,
      smashed: P.smashed,
      biomes: new Set(P.area.targets.map((t) => t.label.split(" · ")[0])).size,
    };
    P.setAutoplay(false);
    P.resetArea();
    return out;
  });
  check(
    "one scene per biome, drawn as merged proxies while intact",
    r.scenes === 15 && r.proxies === 15 && r.hidden > 100,
    JSON.stringify(r),
  );
  check("autopilot smashes most of the biome scenes in a lap", r.smashed >= 10, `${r.smashed}/${r.scenes}`);
  await page.screenshot({ path: path.join(OUT, "scenes.png") });
}

// --- Road edges: every barrier kind is built, and verges slow the kart ---------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("edges");
    P.freeze(true);
    const tags = {};
    P.area.track.group.traverse((o) => {
      if (o.userData.barrier) tags[o.userData.barrier] = (tags[o.userData.barrier] || 0) + 1;
      if (o.userData.verge) tags.verge = (tags.verge || 0) + 1;
    });
    // Flat out down the back straight on tarmac vs on the sand verge.
    // Start a little way INTO the straight (t=0.5 is still in the bend's
    // tangent) so the kart holds its lane for the whole measurement.
    const speedAfter = (lateral) => {
      P.placeKart(0.512, lateral, 0);
      P.drive(1, 0);
      P.player.speed = 30;
      for (let i = 0; i < 100; i++) P.step(1 / 60);
      return Math.abs(P.player.speed);
    };
    const tarmac = speedAfter(0);
    const verge = speedAfter(12.4);
    // Scrape a hedge vs a rock face at the same pace.
    const scrape = (label) => {
      const tg = P.area.targets.find((t) => t.label === label);
      P.placeKart(tg.t, 0, 20);
      P.player.speed = 30;
      P.drive(1, 1); // hard left (steer + = left) into the wall
      let hits = 0;
      for (let i = 0; i < 150; i++) {
        P.step(1 / 60);
        if (P.player.wallHitPulse > 0) hits++;
      }
      return { speed: Math.abs(P.player.speed), hits };
    };
    const hedge = scrape("Hedgerow");
    const rock = scrape("Granite rock face");
    P.resetArea();
    return { tags, tarmac, verge, hedge, rock };
  });
  const t = r.tags;
  check(
    "every discrete barrier kind built something",
    [
      "boulders",
      "rockface",
      "hedge",
      "hedge-flecks",
      "reeds",
      "snowbank",
      "jersey",
      "tyres",
      "hay",
      "logs",
      "sandbags",
      "lava",
      "beams",
    ].every((k) => t[k] > 0) && t.verge === 1,
    JSON.stringify(t),
  );
  check(
    "the sand verge drags the kart below tarmac pace",
    r.verge < r.tarmac - 4,
    `${r.verge.toFixed(1)} vs ${r.tarmac.toFixed(1)}`,
  );
  check(
    "scraping a hedge costs less than scraping rock",
    r.hedge.hits > 0 && r.rock.hits > 0 && r.hedge.speed > r.rock.speed + 1,
    JSON.stringify({ hedge: r.hedge, rock: r.rock }),
  );
  await page.screenshot({ path: path.join(OUT, "edges.png") });
}

// --- Biome tour: one biome at a time, everything it owns, packed -------------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("tour");
    P.freeze(true);
    const snap = () => {
      const T = P.area.track;
      const tags = {};
      T.group.traverse((o) => {
        if (o.userData.barrier) tags[o.userData.barrier] = 1;
      });
      return {
        biome: P.area.area.biome,
        biomes: new Set(T.biomeNames).size,
        scenes: P.area.props.sceneCount,
        props: P.area.props.count,
        sceneryOn: !!P.area.sceneryOn,
        worldKids: P.area.worldGroup?.children.length || 0,
        leftStyles: new Set(T.edges[1].map((c) => c.style.name || c.style.kind)).size,
        verges: new Set(T.edges[0].map((c) => c.verge).filter(Boolean)).size,
        stations: P.area.targets.length,
        bays: T.bays.length,
        // Every scene stands on an apron: on the full-depth middle of a bay, at
        // most a kerb proud of the old kerb line, inside the widened edge.
        inBays: P.area.props.structures.filter((st) => {
          const pr = T.project(st.pos);
          const ex = T.extraAt(pr.lateral > 0 ? 0 : 1, pr.i);
          const lat = Math.abs(pr.lateral);
          return ex > 4.4 && lat - st.across / 2 > T.halfWidth - 1.7 && lat + st.across / 2 < T.halfWidth + ex + 0.05;
        }).length,
        // The widening is gentle: the steepest step between samples (≈0.8u apart)
        // stays under a 0.3 slope, and no bay is deeper than 6.5u.
        steepest: Math.max(
          ...[0, 1].map((s) => {
            const a = T._extra[s];
            let worst = 0;
            for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - a[(i + 1) % a.length]));
            return worst;
          }),
        ),
        deepest: Math.max(...T.bays.map((b) => b.depth)),
        du: T.length / T.samples,
        // Nothing of the scenery stands on an apron: the bay-aware distance
        // puts every scenery object OFF the drivable width.
        onApron: (() => {
          let n = 0;
          P.area.worldGroup?.traverse((o) => {
            if (!o.isMesh && !o.isInstancedMesh && !o.isPoints) return;
            if (o.isInstancedMesh || o.isPoints) return; // merged/instanced batches have no single spot
            o.updateWorldMatrix(true, false);
            const e = o.matrixWorld.elements;
            const pr = T.project({ x: e[12], y: e[13], z: e[14] });
            const ex = T.extraAt(pr.lateral > 0 ? 0 : 1, pr.i);
            if (ex > 1 && Math.abs(pr.lateral) > T.halfWidth - 0.5 && Math.abs(pr.lateral) < T.halfWidth + ex) n++;
          });
          return n;
        })(),
      };
    };
    const meadow = snap();
    P.setAutoplay(true);
    for (let i = 0; i < 600; i++) P.step(1 / 60);
    const smashed = P.smashed;
    const weatherNone = P.weather.target;
    P.setAutoplay(false);
    await P.setTourBiome("tundra");
    P.freeze(true);
    for (let i = 0; i < 20; i++) P.step(1 / 60);
    const tundra = snap();
    const builtKeys = [...document.querySelectorAll("#biome option")].length;
    return { meadow, smashed, weatherNone, tundra, snow: P.weather.target, builtKeys };
  });
  const m = r.meadow,
    t = r.tundra;
  check(
    "the meadow tour is one biome, packed, with scenery built",
    m.biomes === 1 && m.biome === "meadow" && m.scenes >= 10 && m.props >= 40 && m.sceneryOn && m.worldKids > 10,
    JSON.stringify(m),
  );
  check(
    "every tour scene stands on a bay's apron, out of the lane",
    m.bays >= 10 && m.inBays === m.scenes && m.steepest / m.du < 0.4 && m.deepest <= 6.5 && m.onApron === 0,
    `${m.inBays}/${m.scenes} in ${m.bays} bays, steepest slope ${(m.steepest / m.du).toFixed(2)}, deepest ${m.deepest}, ${m.onApron} scenery on aprons`,
  );
  check(
    "every alternative barrier and verge of the biome is on the lap",
    m.leftStyles >= 4 && m.verges === 1,
    `${m.leftStyles} styles, ${m.verges} verge`,
  );
  check("the autopilot smashes along the packed kerbs", r.smashed >= 3, `${r.smashed}`);
  check(
    "switching biome rebuilds the lap in that biome with its own kit",
    t.biome === "tundra" && t.biomes === 1 && t.scenes >= 10 && t.worldKids > 10 && t.verges === 1,
    JSON.stringify(t),
  );
  check(
    "the biome's weather follows the kart",
    r.weatherNone === "none" && r.snow === "snow",
    `${r.weatherNone} → ${r.snow}`,
  );
  check("the selector lists every biome", r.builtKeys === 15, `${r.builtKeys}`);
  await page.screenshot({ path: path.join(OUT, "tour.png") });
}

// --- Touch driving: pads steer, gas is automatic ------------------------------
{
  const r = await run(() => {
    const P = window.__playground;
    P.resetArea();
    P.setTouchDrive(true);
    const shown = !document.getElementById("touch").classList.contains("hidden");
    for (let i = 0; i < 90; i++) P.step(1 / 60);
    const speed = Math.abs(P.player.speed);
    const h0 = P.player.heading;
    P.pads.left = true;
    for (let i = 0; i < 60; i++) P.step(1 / 60);
    const turned = P.player.heading - h0;
    P.pads.left = false;
    P.setTouchDrive(false);
    P.resetArea();
    return { shown, speed, turned };
  });
  check(
    "touch drive shows the pads, gases automatically and steers on hold",
    r.shown && r.speed > 15 && r.turned > 0.3,
    JSON.stringify(r),
  );
}

// --- Jumps: launch off the ramp and land -------------------------------------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("jumps");
    P.freeze(true);
    const i = P.area.targets.findIndex((t) => t.label === "Launch ramp");
    P.teleport(i);
    P.drive(1, 0);
    let maxY = 0,
      airFrames = 0;
    for (let k = 0; k < 420; k++) {
      P.step(1 / 60);
      if (P.player.airborne) airFrames++;
      maxY = Math.max(maxY, P.player.y);
      if (P.flight.last) break;
    }
    return { last: P.flight.last, maxY, airFrames, y: P.player.y, airborne: P.player.airborne };
  });
  check("the ramp launches the kart", r.airFrames > 25 && r.maxY > 1.2, JSON.stringify(r));
  check(
    "the kart lands again",
    !!r.last && !r.airborne,
    r.last ? `${r.last.air.toFixed(2)}s · ${r.last.dist.toFixed(1)}m` : "no landing",
  );
  const bump = await run(() => {
    const P = window.__playground;
    const i = P.area.targets.findIndex((t) => t.label === "Speed bumps");
    P.teleport(i);
    P.drive(1, 0);
    let peak = 0;
    for (let k = 0; k < 240; k++) {
      P.step(1 / 60);
      peak = Math.max(peak, P.player.y);
    }
    return peak;
  });
  check("speed bumps rattle but do not launch", bump < 0.6, `peak ${bump.toFixed(2)}m`);
  await page.screenshot({ path: path.join(OUT, "jumps.png") });
}

// --- Power-ups: every giver + a shot, a milk drop and a yarn at the dummy --------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("items");
    P.freeze(true);
    const boxes = P.area.props.boxTargets().length; // before the kart can grab one
    P.setDummy(true);
    const k = P.player;
    k.giveShield(10);
    k.giveTriShots(3);
    k.giveLife();
    k.giveMilk();
    k.boostMeter = 1;
    P.drive(1, 0);
    for (let i = 0; i < 90; i++) P.step(1 / 60);
    const shotOK = P.fireShot(k, 0.5);
    const balls = P.scene.children.filter((o) => o.isMesh && o.geometry?.parameters?.radius === 0.45).length;
    for (let i = 0; i < 30; i++) P.step(1 / 60);
    k.milkBottles = 1;
    P.area.items.dropMilk(k);
    k.giveYarn();
    k.shootCooldown = 0;
    const yarnOK = P.fireShot(k, 0);
    for (let i = 0; i < 120; i++) P.step(1 / 60);
    return {
      shotOK,
      balls,
      tri: k.triShots,
      yarnOK,
      yarns: P.area.items.yarns.length + (P.area.items.yarns.length ? 0 : 0),
      puddles: P.area.items.puddles.length,
      boxes,
      shield: k.shieldTimer > 0,
      lives: k.lives,
    };
  });
  check("tri-furball fired a fan and consumed a charge", r.shotOK && r.tri === 2 && r.balls >= 3, JSON.stringify(r));
  check("milk puddle dropped and yarn ball rolling", r.puddles === 1 && r.yarnOK, JSON.stringify(r));
  check("floating power-up boxes present", r.boxes === 4, `${r.boxes}`);
  await page.screenshot({ path: path.join(OUT, "items.png") });
}

// --- Shipped props loop --------------------------------------------------------
{
  const r = await run(async () => {
    const P = window.__playground;
    await P.setArea("props");
    P.freeze(true);
    P.teleport(0);
    P.drive(1, 0);
    for (let i = 0; i < 120; i++) P.step(1 / 60);
    return { count: P.area.props.count, targets: P.area.targets.length };
  });
  check("every shipped road prop is staged", r.count >= 26, `${r.count} props, ${r.targets} stations`);
  await page.screenshot({ path: path.join(OUT, "props.png") });
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
server.close();
console.log(failures ? `\n${failures} playground check(s) failed` : "\nall playground checks passed");
process.exit(failures ? 1 : 0);
