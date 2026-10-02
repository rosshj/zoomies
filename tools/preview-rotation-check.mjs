import assert from "node:assert/strict";
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
const { origin } = await serveRepo();
const browser = await launchArtBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?webgl=1&nosw=1&nowd=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__zoomies?.track);
  const click = async (selector) => {
    await page.locator(selector).click();
    await page.waitForTimeout(250);
  };
  await click("#open-garage");
  const verify = async (id) => {
    const canvas = page.locator(id);
    await canvas.waitFor();
    await page.waitForFunction((id) => document.querySelector(id).dataset.ready === "true", id);
    const before = await canvas.evaluate((el) => el.toDataURL());
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((id) => Math.abs(Number(document.querySelector(id).dataset.yaw)) > 0.3, id);
    assert.notEqual(await canvas.evaluate((el) => el.toDataURL()), before, "Drag must change rendered model");
    const yaw = await canvas.getAttribute("data-yaw");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 40, { steps: 5 });
    await page.mouse.up();
    assert.equal(await canvas.getAttribute("data-yaw"), yaw, "Vertical gesture must not orbit");
    assert.equal(await canvas.evaluate((el) => getComputedStyle(el).touchAction), "pan-y");
    await canvas.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction((id) => Number(document.querySelector(id).dataset.yaw) === 0, id);
    for (let i = 0; i < 44; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction((id) => Number(document.querySelector(id).dataset.yaw) < -6.28, id);
  };
  await verify("#garage-portrait");
  await click("#garage-cat");
  await click("#cat-custom-open");
  await verify("#cat-studio-portrait");
  const yaw = await page.locator("#cat-studio-portrait").getAttribute("data-yaw");
  await click('#flow-cat-edit [data-studio-field="type"]');
  await click('#flow-cat-edit .studio-option[data-value="maine"]');
  await page.waitForFunction(() => document.getElementById("cat-studio-portrait").dataset.ready === "true");
  assert.equal(await page.locator("#cat-studio-portrait").getAttribute("data-yaw"), yaw, "Draft edits retain rotation");
  await page.screenshot({ path: "/tmp/rotation-cat.png" });
  await click("#flow-cat-edit [data-back]");
  await click("#flow-cat [data-back]");
  await click("#garage-kart");
  await click("#kart-custom-open");
  await verify("#kart-studio-portrait");
  await page.screenshot({ path: "/tmp/rotation-kart.png" });
  await click("#flow-kart-edit [data-back]");
  await click('[data-inventory="kart"][data-filter="all"]');
  await page.locator("#kart-grid .racer-tap.locked").first().click();
  await verify("#racer-details-preview");
  await page.screenshot({ path: "/tmp/rotation-detail.png" });
  await click("#racer-details-close");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Garage and studio drag rotation, full 360, vertical gesture isolation, keyboard reset, and draft persistence.",
  );
} finally {
  await browser.close();
}
