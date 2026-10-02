// Regenerate bundled scenery after changing featured recipes or world art.
// Serves the repo itself; run after `npm run check` passes.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
import { FEATURED_TRACKS as featured } from "../src/featured-tracks.js";
const tracks = [{ name: "Classic Circuit", cfg: { mode: "classic" } }, ...featured];
const directory = new URL("../assets/track-previews/", import.meta.url);
await fs.mkdir(directory, { recursive: true });
const { origin } = await serveRepo();
const browser = await launchArtBrowser();
try {
  for (const { name, cfg } of tracks) {
    const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
    page.setDefaultTimeout(180000);
    try {
      await page.addInitScript((cfg) => {
        localStorage.setItem("zoomies-track-v1", JSON.stringify(cfg));
        sessionStorage.clear();
      }, cfg);
      await page.goto(`${origin}/?webgl=1&nosw=1&nowd=1`);
      await page.waitForFunction(() => document.getElementById("track-scenery")?.dataset.ready === "true");
      const data = await page.locator("#track-scenery").evaluate((c) => ({
        url: c.toDataURL("image/jpeg", 0.85),
        clear: c.dataset.clearView,
      }));
      assert.equal(data.clear, "true", `${name}: obstructed camera`);
      await fs.writeFile(
        new URL(`${cfg.seed || "classic"}.jpg`, directory),
        Buffer.from(data.url.split(",")[1], "base64"),
      );
      console.log(`Saved ${name}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
