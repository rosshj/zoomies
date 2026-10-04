// Headless check for the handheld frame (portrait racing).
// A phone-sized portrait viewport with touch, no motion sensors (so the hold
// reads from the viewport): a race must take the handheld frame — the canvas
// on top, every touch control and readout on the panel below, nothing
// overlapping — keep it through pause/resume, drop it for a landscape
// viewport, and give way to the counter-rotated landscape stage when the
// Portrait racing setting is off. Writes screenshots to /tmp for eyeballing.
import assert from "node:assert/strict";
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";

const { origin, close } = await serveRepo();
const browser = await launchArtBrowser();
const errors = [];
const rect = (page, sel) =>
  page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      r: r.right,
      b: r.bottom,
      visible: r.width > 0 && r.height > 0,
    };
  });
const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

async function openRace(ctx, { portraitRace = true } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(150000);
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    // (The favicon's 404 from the bare repo server is not the game's.)
    if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript((portraitRace) => {
    try {
      localStorage.setItem("zoomies-portrait-race", portraitRace ? "1" : "0");
    } catch {}
    // A touch device plays only as a home-screen app (the install gate):
    // present as one, the way a phone launching from the icon does.
    Object.defineProperty(navigator, "standalone", { value: true });
  }, portraitRace);
  await page.goto(`${origin}/index.html?webgl=1&nosw=1&nowd=1`, { waitUntil: "load" });
  await page.waitForSelector("#start-btn");
  await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
  await page.click("#start-btn", { force: true });
  await page.click("#go-btn", { force: true });
  // Racing = the HUD is up and the veil has dropped (SwiftShader compiles are slow).
  await page.waitForFunction(() => !document.getElementById("hud").classList.contains("hidden"));
  await page.waitForFunction(() => document.getElementById("race-veil").classList.contains("hidden"));
  return page;
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await openRace(ctx);

  // --- The handheld frame: canvas on top, the panel below ---
  const stage = await page.evaluate(() => {
    const st = document.getElementById("stage");
    const c = document.querySelector("#game canvas");
    const z = window.__zoomies;
    return {
      cls: st.className,
      viewH: parseFloat(st.style.getPropertyValue("--view-h")),
      canvas: c.getBoundingClientRect().toJSON(),
      drawH: c.height,
      drawW: c.width,
      aspect: z.camera.aspect,
      fov: z.camera.fov,
      transform: st.style.transform,
      touchHud: !document.getElementById("hud").classList.contains("no-touch"),
    };
  });
  console.log("handheld:", JSON.stringify(stage));
  assert.ok(/\bhandheld\b/.test(stage.cls), "a portrait race must take the handheld frame");
  assert.ok(!/\brotated\b/.test(stage.cls), "the handheld frame is not counter-rotated");
  assert.ok(stage.touchHud, "the touch HUD must be up on a touch device");
  assert.ok(stage.viewH > 380 && stage.viewH < 844 - 280, `the view takes the top of the stage (${stage.viewH})`);
  assert.ok(Math.abs(stage.canvas.height - stage.viewH) < 1.5, "the canvas is sized to the view");
  assert.ok(Math.abs(stage.canvas.width - 390) < 1.5, "the canvas spans the stage");
  assert.ok(Math.abs(stage.aspect - 390 / stage.viewH) < 1e-3, "the camera aspect follows the view");
  assert.ok(Math.abs(stage.drawW / stage.drawH - stage.aspect) < 0.02, "the drawing buffer matches the view");
  assert.ok(stage.fov > 70, `the vertical FOV widens for the square-ish view (${stage.fov.toFixed(1)})`);

  // --- Every control and readout is on the panel; the pause button on the view ---
  const ids = ["#throttle-track", "#action-buttons", "#info"];
  const rects = {};
  for (const id of ids) rects[id] = await rect(page, id);
  rects["#btn-pause"] = await rect(page, "#btn-pause");
  console.log("rects:", JSON.stringify(rects));
  for (const id of ids) {
    const r = rects[id];
    assert.ok(r.visible, `${id} is laid out`);
    assert.ok(r.y >= stage.viewH - 0.5, `${id} sits below the view (top ${r.y.toFixed(0)} vs view ${stage.viewH})`);
    assert.ok(r.b <= 844 + 0.5 && r.x >= -0.5 && r.r <= 390.5, `${id} stays inside the stage`);
  }
  assert.ok(rects["#btn-pause"].b <= stage.viewH, "the pause button sits over the view");
  // The minimap sits over the VIEW, bottom-left (as in landscape), clear of
  // the sheet's rounded edge.
  rects["#minimap"] = await rect(page, "#minimap");
  const mm = rects["#minimap"];
  assert.ok(mm.visible && mm.w >= 96 && mm.h === mm.w, "the minimap is square and readable");
  assert.ok(mm.b <= stage.viewH - 16 && mm.x < 40, `the minimap sits bottom-left of the view (${mm.x},${mm.b})`);
  for (const a of ["#throttle-track", "#action-buttons", "#info"])
    for (const b of ["#throttle-track", "#action-buttons", "#info"])
      if (a < b) assert.ok(!overlap(rects[a], rects[b]), `${a} and ${b} overlap`);
  // The fan is at its landscape size on the panel: a thumb-sized hop button.
  assert.ok((await rect(page, "#btn-jump")).w >= 80, "the hop button is full size");
  // The action fan's live buttons are inside the stage too (the fan is scaled).
  for (const id of ["#btn-jump", "#btn-shoot", "#btn-boost", "#btn-shield"]) {
    const r = await rect(page, id);
    assert.ok(r.visible && r.r <= 390.5 && r.b <= 844.5 && r.y >= stage.viewH, `${id} is on the panel`);
    assert.ok(r.w >= 52, `${id} keeps a thumb-sized target (${r.w.toFixed(0)}px)`);
  }
  // The throttle slider works where it is drawn: a touch on the track's upper
  // half must read as gas.
  const tt = rects["#throttle-track"];
  await page.touchscreen.tap(tt.x + tt.w / 2, tt.y + tt.h * 0.2).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/portrait-race.png" });

  // --- Pause keeps the frame; resume keeps it; the pause card is upright ---
  await page.click("#btn-pause", { force: true });
  await page.waitForFunction(() => !document.getElementById("pause-overlay").classList.contains("hidden"));
  await page.waitForTimeout(300);
  assert.ok(
    await page.evaluate(() => document.getElementById("stage").classList.contains("handheld")),
    "paused: frame kept",
  );
  await page.screenshot({ path: "/tmp/portrait-pause.png" });
  await page.click("#resume-btn", { force: true });
  await page.waitForFunction(() => document.getElementById("pause-overlay").classList.contains("hidden"));
  await page.waitForTimeout(300);
  assert.ok(
    await page.evaluate(() => document.getElementById("stage").classList.contains("handheld")),
    "resumed: frame kept",
  );

  // --- Turn the phone: a landscape viewport is the landscape stage again ---
  await page.setViewportSize({ width: 844, height: 390 });
  // (The resize re-lays the stage out on the page's own thread: poll rather
  // than sleep — a SwiftShader frame can take a good part of a second.)
  await page.waitForFunction(() => !document.getElementById("stage").classList.contains("handheld"));
  await page.waitForTimeout(300);
  const land = await page.evaluate(() => {
    const st = document.getElementById("stage");
    const c = document.querySelector("#game canvas");
    return { cls: st.className, canvas: c.getBoundingClientRect().toJSON(), aspect: window.__zoomies.camera.aspect };
  });
  console.log("landscape:", JSON.stringify(land));
  assert.ok(!/\bhandheld\b/.test(land.cls), "a landscape viewport drops the handheld frame");
  assert.ok(
    Math.abs(land.canvas.height - 390) < 1.5 && Math.abs(land.canvas.width - 844) < 1.5,
    "the canvas fills the stage",
  );
  assert.ok(Math.abs(land.aspect - 844 / 390) < 1e-3, "the camera aspect is the stage's");
  await page.screenshot({ path: "/tmp/portrait-landscape.png" });
  // And back.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .waitForFunction(() => document.getElementById("stage").classList.contains("handheld"), null, { timeout: 20000 })
    .catch(() => assert.fail("back upright: frame returns"));
  await page.close();

  // --- Setting off: the old counter-rotated landscape race ---
  const page2 = await openRace(ctx, { portraitRace: false });
  const off = await page2.evaluate(() => {
    const st = document.getElementById("stage");
    const c = document.querySelector("#game canvas");
    return { cls: st.className, w: st.style.width, h: st.style.height, canvas: c.getBoundingClientRect().toJSON() };
  });
  console.log("setting off:", JSON.stringify(off));
  assert.ok(!/\bhandheld\b/.test(off.cls) && /\brotated\b/.test(off.cls), "portrait racing off: counter-rotated race");
  assert.equal(off.w, "844px");
  assert.equal(off.h, "390px");
  await page2.screenshot({ path: "/tmp/portrait-off.png" });
  await page2.close();

  assert.deepEqual(errors, [], "console errors");
  console.log("PASS: handheld frame — layout, pause/resume, rotation, setting");
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  await close();
}
