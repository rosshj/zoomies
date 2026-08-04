// Headless check for 3- and 4-player split screen (Versus quadrants).
// Boots as the desktop shell twice — once with a persisted seat count of 3,
// once with 4 — starts a race via the race-again shortcut, and asserts the
// quadrant seam: the roster (6 karts, N humans wearing their seat picks), the
// per-quadrant cams (layer parity, quadrant aspect, reined-in far plane), the
// N-seat HUD (panels, chips, spectator corner / shared map), the lean perf
// posture (DPR cap), and that the visible quadrants actually show different
// views. The 2P flow (grace clock, finish, results) is split-check.mjs's job.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8118;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (u === "/") u = "/index.html";
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + u); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const errors = [];
const check = (name, ok, dbg) => {
  if (ok) console.log("ok:", name);
  else errors.push(`FAIL ${name}: ${JSON.stringify(dbg)}`);
};

for (const COUNT of [3, 4]) {
  console.log(`--- ${COUNT} players ---`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await ctx.addInitScript((count) => {
    try { localStorage.setItem("zoomies-fps", "1"); } catch {}
    try { localStorage.setItem("zoomies-mode-v1", "split"); } catch {}
    try { localStorage.setItem("zoomies-split-count", String(count)); } catch {}
    // Distinct persisted picks per seat so name assertions are deterministic.
    try { localStorage.setItem("zoomies-p2-racer", JSON.stringify({ cat: 3, kart: 2 })); } catch {}
    try { localStorage.setItem("zoomies-p3-racer", JSON.stringify({ cat: 4, kart: 4 })); } catch {}
    try { localStorage.setItem("zoomies-p4-racer", JSON.stringify({ cat: 5, kart: 5 })); } catch {}
    window.zoomiesDesktop = { quit: () => {} }; // the shell bridge gates the mode
    // Two fake pads: P1 + P2 on pads, P3 keyboard, P4 (if present) seatless.
    const mkPad = (i) => ({
      id: `Fake Pad ${i} (STANDARD GAMEPAD)`, index: i, connected: true,
      mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    });
    window.__pads = [mkPad(0), mkPad(1)];
    navigator.getGamepads = () => window.__pads;
  }, COUNT);

  await page.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load", timeout: 150000 });
  await page.waitForSelector("#start-btn", { timeout: 60000 });
  await page.evaluate(() => document.getElementById("restart-btn").click());

  const WARMUP = Number(process.argv[2] || 300);
  let racing = false;
  for (let t = 0; t < WARMUP; t++) {
    const moving = await page.evaluate(() =>
      (window.__zoomies.karts || []).some((k) => !k.isPlayer && Math.abs(k.speed) > 1)
    ).catch(() => false);
    if (moving) { racing = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!racing) { errors.push(`${COUNT}P race never reached GO within ${WARMUP}s`); await ctx.close(); continue; }

  const seam = await page.evaluate(() => {
    const z = window.__zoomies;
    const humans = z.karts.filter((k) => k.isPlayer);
    const cams = z.splitCams().cams;
    const hud = document.getElementById("hud");
    return {
      split: z.split(),
      karts: z.karts.length,
      humans: humans.length,
      names: humans.map((k) => k.name),
      classes: [...hud.classList].filter((c) => c.startsWith("split")),
      camMasks: cams.map((c) => c.layers.mask),
      mainMask: z.camera.layers.mask,
      camAspects: cams.map((c) => +c.aspect.toFixed(2)),
      camFars: cams.map((c) => c.far),
      dpr: +z.renderer.getPixelRatio().toFixed(2),
      panels: [1, 2, 3, 4].map((n) => {
        const el = document.getElementById(`split-panel${n}`);
        return el && getComputedStyle(el).display !== "none";
      }),
      spect: getComputedStyle(document.getElementById("split-spect")).display !== "none",
      map2Shown: getComputedStyle(document.getElementById("minimap2")).display !== "none",
    };
  });
  check(`${COUNT}P: split race with ${COUNT} humans in a 6-kart field`,
    seam.split.active && seam.split.count === COUNT && seam.karts === 6 && seam.humans === COUNT, seam);
  check(`${COUNT}P: seats wear their startline picks`,
    seam.names.some((n) => /\(P2\)$/.test(n)) && seam.names.some((n) => /\(P3\)$/.test(n)) &&
    (COUNT < 4 || seam.names.some((n) => /\(P4\)$/.test(n))), seam);
  check(`${COUNT}P: hud carries the split-${COUNT} layout class`, seam.classes.includes(`split-${COUNT}`), seam);
  check(`${COUNT}P: all cams share the game camera's layer mask`,
    seam.camMasks.length === COUNT && seam.camMasks.every((m) => m === seam.mainMask), seam);
  // Quadrant aspect = (W/2)/(H/2) = W/H = 1.6 at 1280x800.
  check(`${COUNT}P: quadrant aspect on every cam`, seam.camAspects.every((a) => Math.abs(a - 1.6) < 0.05), seam);
  check(`${COUNT}P: far plane reined in for quadrants`, seam.camFars.every((f) => f <= 1800), seam);
  check(`${COUNT}P: DPR capped for the multi-view fill bill`, seam.dpr <= 1.5, seam);
  check(`${COUNT}P: the right panels are up`,
    seam.panels[0] && seam.panels[1] && seam.panels[2] && (COUNT === 4 ? seam.panels[3] : !seam.panels[3]), seam);
  check(`${COUNT}P: spectator corner only in 3P`, seam.spect === (COUNT === 3), seam);
  check(`${COUNT}P: the 2P minimap copy is hidden`, !seam.map2Shown, seam);

  // Drive P1 (pad 0) + P3 (keyboard, first padless seat) and check
  // independence. SwiftShader crawls under 3-4 scene passes (sim seconds
  // accrue far slower than wall seconds), so poll with patience instead of
  // sampling at a fixed instant.
  await page.evaluate(() => { const b = window.__pads[0].buttons[7]; b.pressed = true; b.value = 1; });
  await page.keyboard.down("ArrowUp");
  let drive = null;
  for (let t = 0; t < 45; t++) {
    await page.waitForTimeout(2000);
    drive = await page.evaluate(() => {
      const z = window.__zoomies;
      const h = z.karts.filter((k) => k.isPlayer);
      return {
        speeds: h.map((k) => +k.speed.toFixed(1)),
        chips: [1, 2, 3].map((n) => document.getElementById(`split-p${n}`).textContent),
      };
    });
    if (drive.speeds[0] > 3 && drive.speeds[2] > 3) break;
  }
  check(`${COUNT}P: P1 (pad) and P3 (keyboard) drive; P2 (idle pad) doesn't`,
    drive.speeds[0] > 3 && drive.speeds[2] > 3 && Math.abs(drive.speeds[1]) < 1, drive);
  check(`${COUNT}P: per-quadrant chips are live`,
    /^P1 · Lap/.test(drive.chips[0]) && /^P3 · Lap/.test(drive.chips[2]), drive);
  await page.keyboard.up("ArrowUp");
  await page.evaluate(() => { const b = window.__pads[0].buttons[7]; b.pressed = false; b.value = 0; });

  // The rendered quadrants must be DIFFERENT views (each seat its own cam).
  const quads = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const gl = window.__zoomies.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = Math.max(64, Math.floor(gl.width / 4));
      c.height = Math.max(64, Math.floor(gl.height / 4));
      const x = c.getContext("2d");
      x.drawImage(gl, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const hw = Math.floor(c.width / 2), hh = Math.floor(c.height / 2);
      const diff = (x0, y0, x1, y1) => {
        let sum = 0, n = 0;
        for (let y = 6; y < hh - 6; y++) {
          for (let px = 6; px < hw - 6; px++) {
            const a = ((y0 + y) * c.width + x0 + px) * 4;
            const b = ((y1 + y) * c.width + x1 + px) * 4;
            sum += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]);
            n++;
          }
        }
        return sum / Math.max(1, n);
      };
      resolve({
        tlVsTr: +diff(0, 0, hw, 0).toFixed(2),   // P1 vs P2
        tlVsBl: +diff(0, 0, 0, hh).toFixed(2),   // P1 vs P3
      });
    });
  }));
  check(`${COUNT}P: quadrants show different views`, quads.tlVsTr > 4 && quads.tlVsBl > 4, quads);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${COUNT}p.png` }).catch(() => {});
  await ctx.close();
}

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
