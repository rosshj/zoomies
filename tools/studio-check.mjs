import assert from "node:assert/strict";
import { launchArtBrowser } from "./art-browser.mjs";
const browser = await launchArtBrowser();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("zoomies-profile-v1", JSON.stringify({ treats: 1000 })));
  await page.goto("http://localhost:8080/?webgl=1&nosw=1&nowd=1");
  await page.waitForFunction(() => window.__zoomies?.track);
  const homeCamera = await page.evaluate(() => [window.__zoomies.camera.fov, window.__zoomies.camera.position.y]);
  const click = async (selector) => {
    await page.locator(selector).click();
    await page.waitForTimeout(300);
  };
  await click("#open-garage");
  await click("#garage-cat");
  await click("#cat-custom-open");
  await page.waitForFunction(() => document.getElementById("cat-studio-portrait").dataset.ready === "true");
  assert.equal(await page.locator("#cat-edit-use").isVisible(), false);
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [320, 568],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(500);
    const bounds = await page.locator("#cat-edit-buy").boundingBox();
    assert.ok(bounds.y + bounds.height <= height, "Unlock action clipped");
    const canvas = await page.locator("#cat-studio-portrait").boundingBox();
    assert.ok(canvas.height >= 90, "Preview too small");
    assert.deepEqual(
      await page.evaluate(() => [window.__zoomies.camera.fov, window.__zoomies.camera.position.y]),
      homeCamera,
    );
    await page.screenshot({ path: `/tmp/studio-cat-${width}.png` });
  }
  await click('#flow-cat-edit [data-studio-field="type"]');
  assert.equal(await page.locator("#flow-cat-edit .studio-field-active .studio-option").count(), 27);
  await click('#flow-cat-edit .studio-option[data-value="maine"]');
  assert.equal(await page.locator('#flow-cat-edit [data-studio-field="type"] strong').textContent(), "Maine Coon");
  await click('#flow-cat-edit [data-studio-field="name"]');
  await click("#cat-name-pick");
  await page.locator("#cat-name-grid button").first().click();
  await page.locator("#cat-custom-name").fill("Studio Cat");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#flow-cat-edit").getAttribute("data-studio-detail"), null);
  await click("#flow-cat-edit [data-back]");
  await click("#cat-custom-open");
  assert.equal(await page.locator('#flow-cat-edit [data-studio-field="type"] strong').textContent(), "Classic");
  await click("#cat-edit-buy");
  assert.equal(await page.locator("#cat-edit-use").isVisible(), true);
  await click('#flow-cat-edit [data-studio-field="type"]');
  await click('#flow-cat-edit .studio-option[data-value="maine"]');
  await click('#flow-cat-edit [data-studio-field="name"]');
  await page.locator("#cat-custom-name").fill("Studio Cat");
  await click("#flow-cat-edit .studio-detail-done");
  await click("#cat-edit-use");
  assert.equal(await page.locator("#menu").getAttribute("data-step"), "garage");
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-garage-v1")).customCat.name),
    "Studio Cat",
  );
  await click("#garage-kart");
  await click("#kart-custom-open");
  await click('#flow-kart-edit [data-studio-field="number"]');
  await click('#flow-kart-edit .studio-field-active .studio-option[data-value="42"]');
  await click('#flow-kart-edit [data-studio-field="style"]');
  await click('#flow-kart-edit .studio-field-active .studio-option[data-value="6"]');
  await click('#flow-kart-edit [data-studio-field="livery"]');
  await click('#flow-kart-edit .studio-field-active .studio-option[data-value="1"]');
  await click("#kart-edit-buy");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/studio-kart.png" });
  await click("#kart-edit-use");
  const kart = await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-garage-v1")).customKart);
  assert.equal(kart.number, 42);
  assert.equal(kart.style, 6);
  assert.equal(kart.livery, 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: studio drill-ins, Escape, cancel, unlock, saves, preview, orbit continuity and responsive actions.",
  );
} finally {
  await browser.close();
}
