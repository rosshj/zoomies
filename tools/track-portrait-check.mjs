import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
import { FEATURED_TRACKS as featured } from "../src/featured-tracks.js";
const { origin } = await serveRepo();
const browser = await launchArtBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning") console.log(m.text());
  });
  for (const name of process.env.TRACK_CASE
    ? [process.env.TRACK_CASE]
    : ["Classic Circuit", "Snowcap Sprint", "Basalt Blast"]) {
    const cfg = featured.find((t) => t.name === name)?.cfg || { mode: "classic" };
    await page.addInitScript((cfg) => localStorage.setItem("zoomies-track-v1", JSON.stringify(cfg)), cfg);
    await page.goto(`${origin}/?${process.env.BACKEND === "webgpu" ? "webgpu" : "webgl"}=1&nosw=1&nowd=1`);
    await page.waitForFunction(() => window.__zoomies?.track);
    await page.locator("#start-btn").click();
    await page.waitForFunction(() => document.getElementById("track-scenery").dataset.ready === "true");
    const data = await page.locator("#track-scenery").evaluate((c) => ({
      url: c.toDataURL(),
      camera: +c.dataset.cameraHeight,
      road: +c.dataset.roadHeight,
      clear: c.dataset.clearView,
    }));
    assert.ok(data.camera >= data.road + 5 && data.camera <= data.road + 14, "Camera is not close to the road");
    assert.equal(data.clear, "true", "Scenery blocks the camera");
    assert.equal(
      await page.locator("#track-scenery").getAttribute("data-scenery-layers"),
      "7",
      "Scenery layers missing",
    );
    assert.ok(
      +(await page.locator("#track-scenery").getAttribute("data-road-offset")) > 8,
      "Camera stayed on the racing line",
    );
    await fs.writeFile(`/tmp/track-${cfg.seed || "classic"}.png`, Buffer.from(data.url.split(",")[1], "base64"));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `/tmp/track-card-${cfg.seed || "classic"}.png` });
    await page.waitForTimeout(700);
    assert.equal(
      await page.locator("#track-scenery").evaluate((c) => c.toDataURL()),
      data.url,
      "Still changed on animation frames",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/track-card-portrait-${cfg.seed || "classic"}.png` });
    await page.setViewportSize({ width: 844, height: 390 });
    console.log(
      name,
      data.camera,
      data.road,
      await page.evaluate(() => (window.__zoomies.renderer.backend.isWebGPUBackend ? "WebGPU" : "WebGL")),
    );
  }
  assert.deepEqual(errors, []);
  console.log("PASS: track stills, static cache, and close road framing and clear sightlines.");
} finally {
  await browser.close();
}
