import assert from "node:assert/strict";
import { launchArtBrowser } from "./art-browser.mjs";
const browser = await launchArtBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("zoomies-profile-v1", JSON.stringify({ treats: 1000 })));
  await page.goto("http://localhost:8080/?webgl=1&nosw=1&nowd=1");
  await page.waitForFunction(() => window.__zoomies?.track);
  await page.locator("#open-catalog").click();
  const item = page.locator('#catalog [data-prize="cat.3"]');
  await item.click();
  assert.ok(await page.locator("#racer-details").isVisible());
  await page.locator("#racer-details-action").click();
  assert.equal(await page.locator("#racer-details").isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.prize), "cat.3");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats), 900);
  await item.click();
  assert.equal(await item.getAttribute("aria-current"), "true");
  assert.equal(await item.locator(".prize-how").textContent(), "Equipped");
  await page.locator("#catalog-tab-karts").click();
  await page.locator('#catalog [data-prize="kart.3"]').click();
  assert.ok(await page.locator("#racer-details").isVisible());
  await page.locator("#racer-details-close").click();
  // Find a cup reward through the same compact card status the user sees.
  const reward = page
    .locator('#catalog [data-collection="karts"] .racer-tap.locked')
    .filter({ hasText: "Cup reward" })
    .first();
  await reward.click();
  assert.equal(await page.locator("#racer-details-action").textContent(), "Choose cup");
  await page.locator("#racer-details-action").click();
  assert.equal(await page.locator("#catalog").isVisible(), false);
  assert.equal(await page.locator("#menu").getAttribute("data-step"), "cup");
  assert.deepEqual(errors, []);
  console.log("PASS: Collection purchase, balance, equip, scoped focus, details and reward-to-cup navigation.");
} finally {
  await browser.close();
}
