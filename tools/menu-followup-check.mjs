import assert from "node:assert/strict";
import { launchArtBrowser } from "./art-browser.mjs";
const browser = await launchArtBrowser();
try {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p.setDefaultTimeout(120000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.zoomiesDesktop = { quit() {} };
    localStorage.setItem(
      "zoomies-profile-v1",
      JSON.stringify({ treats: 1000, achievements: ["first-race", "first-win"], pendingClaims: ["first-race"] }),
    );
  });
  await p.goto("http://localhost:8080/?webgl=1&nosw=1&nowd=1");
  await p.waitForFunction(() => window.__zoomies?.track);
  const click = async (s) => {
    await p.locator(s).click();
    await p.waitForTimeout(200);
  };
  await click("#open-settings");
  await click("[data-category=display]");
  assert.ok(await p.locator("[data-display-field=graphics]").isVisible());
  assert.equal(await p.locator("#quality-toggle").isVisible(), false);
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [320, 568],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(300);
    await p.screenshot({ path: `/tmp/display-overview-${width}.png` });
    await click("[data-display-field=graphics]");
    await click("#set-quality-low");
    const bounds = await p.locator("#settings .menu-fixed-actions button").boundingBox();
    assert.ok(bounds.y + bounds.height <= height, "Display back clipped");
    await p.screenshot({ path: `/tmp/display-detail-${width}.png` });
    await p.keyboard.press("Escape");
    assert.equal(await p.locator("[data-display-field=graphics] strong").textContent(), "Low");
    assert.ok(await p.locator("#settings").isVisible(), "Escape closed all Settings");
  }
  await click("[data-display-field=frame-rate]");
  await click('[data-cap="30"]');
  await click("#settings-back");
  assert.equal(await p.locator("[data-display-field=frame-rate] strong").textContent(), "30");
  await click("#settings-back");
  await click("#open-catalog");
  await click("#catalog-tab-ach");
  assert.equal(await p.locator(".award-group-title").count(), 3);
  const balance = await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats);
  await click(".ach-claim");
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats), balance + 50);
  assert.equal(await p.locator(".award-group-title").filter({ hasText: "Ready to collect" }).isVisible(), false);
  await click("#catalog-back");
  await click("#start-btn");
  await click("#setup-mode");
  await click("#mode-split");
  await click("#setup-players");
  await click("#split-count-4");
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [320, 568],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(300);
    const done = await p.locator("#players-done").boundingBox();
    assert.ok(done.y + done.height <= height);
    await p.screenshot({ path: `/tmp/players-${width}.png` });
  }
  await click("#players-done");
  assert.match(await p.locator("#setup-players-name").textContent(), /4 players/);
  assert.equal(await p.locator("#flow-players").getAttribute("inert"), "");
  await click("#go-btn");
  assert.equal(await p.locator("#menu").getAttribute("data-step"), "players", "Missing inputs should open Players");
  await click("#players-done");
  // Exercise the feedback module without navigation so the outgoing state can be inspected.
  await p.evaluate(async () => {
    const { showTrackLoading } = await import("./src/track-loading.js");
    showTrackLoading("Buttercup Run");
  });
  assert.equal(await p.locator("#loading .ls-status").textContent(), "Loading Buttercup Run");
  await p.screenshot({ path: "/tmp/track-loading.png" });
  assert.equal(await p.evaluate(() => sessionStorage.getItem("zoomies-loading-track")), "Buttercup Run");
  assert.deepEqual(errors, []);
  // Stop the heavy renderer import to inspect the next document's first-paint handoff.
  await p.route("**/src/main.js", (route) => route.abort());
  await p.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await p.locator("#loading .ls-status").textContent(), "Loading Buttercup Run");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("zoomies-loading-track")), null);
  console.log(
    "PASS: Display drill-ins and values, Escape/back, award claim regrouping, Players layouts, and loading feedback.",
  );
} finally {
  await browser.close();
}
