import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
import assert from "node:assert/strict";
const { origin } = await serveRepo();
const browser = await launchArtBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(90000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() =>
  localStorage.setItem("zoomies-profile-v1", JSON.stringify({ treats: 150, stats: { racesCustom: 3 } })),
);
try {
  await page.goto(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await page.waitForFunction(() => window.__zoomies?.track);
  await page.locator("#start-btn").click();
  await page.locator("#setup-kart").click();
  await page.locator('[data-inventory="kart"][data-filter="all"]').click();
  const card = (id) => page.locator(`[data-racer-id="${id}"]`);
  const assertSquare = async (locator) => {
    const box = await locator.boundingBox();
    assert.ok(Math.abs(box.width - box.height) < 1, "Artwork frame must be square");
  };
  await assertSquare(card("kart.0").locator(".racer-shot"));
  assert.equal(await card("kart.0").locator(".track-sub").textContent(), "Equipped");
  assert.equal(await card("kart.1").locator(".track-sub").textContent(), "Owned");
  await card("kart.3").click();
  await page.locator("#racer-details:not(.hidden)").waitFor();
  await page.waitForTimeout(200);
  // Presets render a live portrait canvas; the catalog image only backs non-preset items.
  await assertSquare(page.locator("#racer-details-preview:not([hidden]), #racer-details-image:not([hidden])").first());
  assert.equal(await page.evaluate(() => document.activeElement.id), "racer-details-close");
  assert.match(await page.locator("#racer-details-action").textContent(), /Buy for/);
  await page.screenshot({ path: "/tmp/racer-details-buy.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats), 150);
  await card("kart.3").click();
  await page.locator("#racer-details-action").click();
  // Buying opens a reveal card (src/celebrate.js); tap it away before carrying on.
  await page.locator("#celebrate-reveal.is-open #celebrate-continue").waitFor({ timeout: 30000 });
  await page.locator("#celebrate-continue").click();
  await page.locator("#celebrate-reveal:not(.hidden)").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats), 50);
  assert.equal(await card("kart.3").locator(".track-sub").textContent(), "Owned");
  await card("kart.4").click();
  assert.equal(await page.locator("#racer-details-action").isDisabled(), true);
  await page.locator("#racer-details-close").click();
  const cup = await page.evaluate(async () => {
    const { CATALOG } = await import("/src/progress.js");
    return CATALOG.find((e) => e.id.startsWith("kart.") && e.cup && e.diff)?.id;
  });
  await card(cup).click();
  assert.match(await page.locator("#racer-details-requirement").textContent(), /Expert/);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  // Presets render a live portrait canvas; the catalog image only backs non-preset items.
  await assertSquare(page.locator("#racer-details-preview:not([hidden]), #racer-details-image:not([hidden])").first());
  await page.screenshot({ path: "/tmp/racer-details-cup.png" });
  await page.locator("#racer-details-action").click();
  assert.equal(await page.locator("#menu").getAttribute("data-step"), "cup");
  await page.keyboard.press("Escape");
  await page.locator("#setup-kart").click();
  await card("kart.3").click();
  assert.equal(await page.locator("#menu").getAttribute("data-step"), "startline");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("zoomies-garage-v1")).kart), 3);
  assert.deepEqual(errors, []);
  console.log("PASS: compact statuses, cancel, purchase once, insufficient funds, cup navigation, one-tap equip.");
} finally {
  await browser.close();
}
