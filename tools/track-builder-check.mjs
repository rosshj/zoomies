import assert from "node:assert/strict";
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
const { origin } = await serveRepo();
const browser = await launchArtBrowser();
try {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p.setDefaultTimeout(120000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await p.waitForFunction(() => window.__zoomies?.track);
  await p.locator("#start-btn").click();
  await p.waitForFunction(() => document.getElementById("track-scenery").dataset.ready === "true");
  assert.equal(await p.locator("#menu-map-btn").evaluate((e) => getComputedStyle(e).borderTopWidth), "0px");
  await p.locator("#menu-map-btn").click();
  await p.waitForTimeout(700);
  assert.ok((await p.locator("#track-grid .racer-tap").count()) > 8);
  const previews = p.locator("#track-grid .track-preview-art");
  assert.equal(await previews.count(), 11);
  for (const preview of await previews.all()) {
    await preview.scrollIntoViewIfNeeded();
    await preview.locator("img").evaluate((img) => img.decode());
    assert.equal(await preview.locator("img").evaluate((img) => img.naturalWidth), 640);
    assert.ok(
      await preview.locator("canvas").evaluate((canvas) =>
        canvas
          .getContext("2d")
          .getImageData(0, 0, 300, 300)
          .data.some((v, i) => i % 4 === 3 && v > 0),
      ),
      "Track outline missing",
    );
  }
  await previews.first().scrollIntoViewIfNeeded();
  await p.screenshot({ path: "/tmp/track-picker.png" });
  await p.setViewportSize({ width: 844, height: 390 });
  await p.screenshot({ path: "/tmp/track-picker-landscape.png" });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator("#track-custom-open").click();
  await p.waitForTimeout(500);
  assert.equal(await p.locator("#track-panel .flow-h").textContent(), "Track Builder");
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [320, 568],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(300);
    await p.locator('[data-builder-field="biomes"]').click();
    await p.waitForTimeout(300);
    // Opening a field trades preview height for the choice list, but the
    // preview and the Back action must both stay on screen at every size.
    const preview = await p.locator("#track-preview").boundingBox();
    assert.ok(
      preview && preview.height > 40 && preview.y >= 0 && preview.y + preview.height <= height,
      "Preview left the screen",
    );
    const back = await p.locator(".builder-done").boundingBox();
    assert.ok(back.y + back.height <= height);
    await p.screenshot({ path: `/tmp/track-builder-${width}.png` });
    await p.locator(".builder-done").click();
  }
  await p.locator('[data-builder-field="style"]').click();
  await p.locator('[data-style="wild"]').click();
  await p.locator('[data-builder-field="details"]').click();
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("#track-panel .flow-h").textContent(), "Track Builder");
  assert.match(await p.locator('[data-builder-field="style"] strong').textContent(), /Wild/);
  await p.locator("#track-back").click();
  assert.ok(await p.locator("#track-custom-open").isVisible());
  await p.reload();
  await p.waitForFunction(() => document.getElementById("track-scenery").dataset.cached === "true");
  assert.deepEqual(errors, []);
  console.log("PASS: shared track tiles, border, builder drill-ins, fixed actions, cancel and cached preview reload.");
} finally {
  await browser.close();
}
