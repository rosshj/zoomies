// Visual audit against a local server: python3 -m http.server 8080
import { launchArtBrowser } from "./art-browser.mjs";
import fs from "node:fs/promises";
const out = new URL("../docs/menu-refresh/", import.meta.url);
const browser = await launchArtBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sizes = [
  ["deck", 1280, 800],
  ["macbook", 1440, 900],
  ["iphone-landscape", 844, 390],
  ["iphone-portrait", 390, 844],
  ["small-phone", 667, 375],
  ["laptop-720", 1280, 720],
];
const measurements = [];
async function click(sel) {
  await page.locator(sel).click();
  await page.waitForTimeout(600);
}
async function capture(name) {
  for (const [device, width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    await page.screenshot({ path: new URL(`screenshots/${device}-${name}.jpg`, out).pathname, quality: 75 });
    measurements.push(
      await page.evaluate(
        ({ device, name }) => {
          const root =
            [...document.querySelectorAll(".overlay:not(.hidden)")].at(-1) ||
            document.querySelector(".flow-screen.is-active");
          const stage = document.querySelector("#stage");
          const controls = [...root.querySelectorAll("button,input,textarea")].filter(
            (e) => e.getBoundingClientRect().width && getComputedStyle(e).visibility === "visible",
          );
          return {
            device,
            name,
            stage: {
              width: stage.clientWidth,
              height: stage.clientHeight,
              rotated: stage.classList.contains("rotated"),
            },
            controls: controls.length,
            smallControls: controls
              .filter((e) => e.offsetWidth < 44 || e.offsetHeight < 44)
              .map((e) => ({ id: e.id, text: e.textContent.trim().slice(0, 45), w: e.offsetWidth, h: e.offsetHeight })),
            scroll: [...root.querySelectorAll("*")]
              .filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY))
              .map((e) => ({ id: e.id, class: e.className, client: e.clientHeight, scroll: e.scrollHeight })),
          };
        },
        { device, name },
      ),
    );
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log("captured", name);
}
try {
  if (process.env.DESKTOP)
    await page.addInitScript(() => {
      window.zoomiesDesktop = { quit() {} };
      localStorage.setItem(
        "zoomies-profile-v1",
        JSON.stringify({ unlocked: ["custom.cat", "custom.kart"], treats: 1000 }),
      );
    });
  await page.goto("http://127.0.0.1:8080/?webgl=1&nosw=1&nowd=1");
  await page.waitForFunction(() => window.__zoomies?.track);
  await page.waitForTimeout(2000);
  await capture(process.env.DESKTOP ? "desktop-title" : "title");
  if (process.env.DESKTOP) {
    await click("#start-btn");
    await capture("desktop-mode");
    await click("#mode-split");
    await click("#track-grid .is-current");
    await page.getByText("Custom Cat", { exact: true }).click();
    await capture("cat-studio");
    await click("#cat-name-pick");
    await capture("name-picker");
    await click("#cat-name-close");
    await click("#cat-edit-use");
    await page.getByText("Custom Kart", { exact: true }).click();
    await capture("kart-shop");
    await click("#kart-edit-use");
    await click("#split-count-4");
    await capture("versus-4p");
    await click("#p2-edit");
    await capture("seat-picker");
    await page.keyboard.press("Escape");
    await fs.writeFile(new URL("desktop-measurements.json", out), JSON.stringify({ errors, measurements }, null, 2));
  } else {
    for (const [button, name, close] of [
      ["#open-settings", "settings", "#settings-back"],
      ["#howto-btn", "help", "#howto-back"],
      ["#open-catalog", "catalog", "#catalog-back"],
    ]) {
      await click(button);
      await capture(name);
      await click(close);
    }
    await click("#start-btn");
    await capture("mode");
    await click("#mode-cup");
    await capture("cups");
    await click("#flow-cup [data-back]");
    await click("#mode-gp");
    await capture("tracks");
    await click(".track-maker-card");
    await capture("track-maker");
    await click("#track-back");
    await click("#track-grid .is-current");
    await capture("cats");
    await click("#cat-grid button:first-child");
    await capture("karts");
    await click("#kart-grid button:first-child");
    await capture("startline");
    await click("#go-btn");
    await page.waitForFunction(() => window.__zoomies.state() === 2, {}, { timeout: 180000 });
    await page.keyboard.press("p");
    await capture("pause");
    await click("#open-settings-pause");
    await capture("pause-settings");
    await click("#settings-back");
    await click("#menu-btn");
    await capture("parked-title");
    await click("#resume-race-btn");
    await click("#resume-btn");
    await page.evaluate(() => window.__zoomies.debugFinish());
    await page.waitForSelector("#results:not(.hidden)", { timeout: 60000 });
    await capture("results");
    await click("#results-menu-btn");
    if (await page.locator("#claim-screen").isVisible()) await capture("claims");
    await fs.writeFile(new URL("measurements.json", out), JSON.stringify({ errors, measurements }, null, 2));
  }
} finally {
  await browser.close();
}
