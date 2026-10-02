// Visual audit against a local server: python3 -m http.server 8080
import { launchArtBrowser } from "./art-browser.mjs";
import fs from "node:fs/promises";
const out = new URL("../docs/menu-refresh/review/", import.meta.url);
await fs.mkdir(new URL("screenshots/", out), { recursive: true });
const browser = await launchArtBrowser();
let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(180000);
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
const setupOnly = process.argv.includes("--setup-only");
async function click(sel) {
  await page.locator(sel).click();
  await page.waitForTimeout(600);
}
async function capture(name) {
  const captureSizes = ["setup", "settings-display"].includes(name) ? [...sizes, ["narrow-portrait", 320, 568]] : sizes;
  for (const [device, width, height] of captureSizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(550);
    // Simulate an iPhone notch/home indicator; viewport resizing alone misses
    // the safe-area collision reported on the actual device.
    await page.evaluate(
      (portrait) => {
        const stage = document.getElementById("stage");
        stage.style.setProperty("--safe-top", portrait ? "59px" : "0px", "important");
        stage.style.setProperty("--safe-bottom", portrait ? "34px" : "0px", "important");
      },
      device === "iphone-portrait" && name !== "pause" && name !== "confirmation",
    );
    const headerIssue = await page.evaluate(() => {
      const chrome = document.getElementById("menu-chrome");
      if (chrome.classList.contains("hidden")) return null;
      const head = chrome.closest(".flow-head");
      if (!head) return "Actions are outside the header layout";
      const c = chrome.getBoundingClientRect(),
        h = head.getBoundingClientRect();
      const title = head.querySelector(".flow-head-text").getBoundingClientRect();
      if (c.left < title.right - 1 || c.bottom > h.bottom + 1 || c.right > h.right + 1)
        return "Header actions overlap title or escape header";
      return null;
    });
    if (headerIssue) errors.push(`${device}/${name}: ${headerIssue}`);
    if (name.startsWith("home")) {
      const gridOK = await page.evaluate(() => {
        const grid = document.querySelector(".title-extras");
        return document.getElementById("open-settings").getBoundingClientRect().width < grid.clientWidth * 0.6;
      });
      if (!gridOK) errors.push(`${device}/${name}: Settings breaks the utility grid`);
    }
    if (name.startsWith("setup") || name === "settings-display") {
      const fitIssues = await page.evaluate((name) => {
        const issues = [];
        if (name.startsWith("setup")) {
          const map = document.getElementById("menu-map-btn").getBoundingClientRect();
          if (map.width < 200 || map.height < (innerHeight > innerWidth ? 110 : 100))
            issues.push("Map panel is too small or hidden");
          const portrait = document.getElementById("racer-portrait");
          const bounds = portrait.getBoundingClientRect();
          if (portrait.dataset.ready !== "true" || bounds.width < 100 || bounds.height < 90)
            issues.push("Combined racer portrait missing or too small");
          const mode = document.getElementById("setup-mode").getBoundingClientRect();
          const racer = document.querySelector("#flow-startline .setup-racer-preview").getBoundingClientRect();
          if (mode.bottom > racer.top + 1) issues.push("Mode must appear above your racer");
          const row = document.querySelector(".setup-pickers");
          const rowBounds = row.getBoundingClientRect();
          const choices = [...row.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width);
          if (
            choices.length &&
            (Math.abs(choices[0].left - rowBounds.left) > 1 || Math.abs(choices.at(-1).right - rowBounds.right) > 1)
          )
            issues.push("Summary choices leave a gap at the edge");
          if (choices.some((r) => Math.abs(r.width - choices[0].width) > 1))
            issues.push("Summary choices have unequal widths");
          const go = document.getElementById("go-btn").getBoundingClientRect();
          if (go.bottom > innerHeight || go.right > innerWidth) issues.push("Start action is clipped");
          if (!document.getElementById("stage").classList.contains("menu-portrait")) {
            const topCard = choices.length ? rowBounds : map;
            if (Math.abs(topCard.top - mode.top) > 1 || Math.abs(go.bottom - racer.bottom) > 1)
              issues.push("Landscape columns do not align at top and bottom");
            const gap = parseFloat(getComputedStyle(document.querySelector(".start-side")).gap);
            if (Math.abs(go.top - map.bottom - gap) > 1) issues.push("Track card does not fill the space above Start");
          }
        }
        const root = document.getElementById(name.startsWith("setup") ? "flow-startline" : "settings");
        for (const group of root.querySelectorAll(".seg-toggle")) {
          if (!group.getBoundingClientRect().width) continue;
          const bounds = group.getBoundingClientRect();
          for (const button of group.querySelectorAll("button")) {
            const b = button.getBoundingClientRect();
            if (b.left < bounds.left - 1 || b.right > bounds.right + 1 || b.right > innerWidth)
              issues.push("Option escapes group: " + button.textContent.trim());
          }
        }
        return issues;
      }, name);
      errors.push(...fitIssues.map((issue) => `${device}/${name}: ${issue}`));
    }
    if (["mode", "tracks", "cups", "rivals", "length"].includes(name)) {
      const fitsGutters = await page.evaluate(() => {
        const root = document.querySelector(".flow-screen.is-active");
        const body = root.querySelector(".flow-body");
        const list = body.querySelector(".mode-grid,.track-grid,.cup-grid,.race-detail-inner");
        const b = body.getBoundingClientRect(),
          r = list.getBoundingClientRect(),
          style = getComputedStyle(body);
        return (
          Math.abs(r.left - b.left - parseFloat(style.paddingLeft)) < 1 &&
          Math.abs(b.right - r.right - parseFloat(style.paddingRight)) < 1
        );
      });
      if (!fitsGutters) errors.push(`${device}/${name}: Picker list does not fill shared gutters`);
    }
    const emoji = await page.evaluate(() => {
      const root =
        [...document.querySelectorAll(".overlay:not(.hidden)")].at(-1) ||
        document.querySelector(".flow-screen.is-active");
      return root.innerText.match(/\p{Extended_Pictographic}/gu);
    });
    if (emoji) errors.push(`${device}/${name}: remaining emoji ${emoji.join(" ")}`);
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
            scroll: [root, ...root.querySelectorAll("*")]
              .filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY))
              .map((e) => ({ id: e.id, class: e.className, client: e.clientHeight, scroll: e.scrollHeight })),
          };
        },
        { device, name },
      ),
    );
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    for (const name of ["--safe-top", "--safe-bottom"]) document.getElementById("stage").style.removeProperty(name);
  });
  console.log("captured", name);
}
try {
  await page.addInitScript(() => {
    window.zoomiesDesktop = { quit() {} };
    localStorage.setItem(
      "zoomies-profile-v1",
      JSON.stringify({ unlocked: ["custom.cat", "custom.kart"], treats: 1000 }),
    );
  });
  await page.goto("http://127.0.0.1:8080/?webgl=1&nosw=1&nowd=1");
  await page.waitForFunction(() => window.__zoomies?.track);
  if (setupOnly) {
    await click("#start-btn");
    await page.waitForFunction(() => document.getElementById("racer-portrait").dataset.ready === "true");
    await capture("setup");
    await click("#setup-rivals");
    await capture("rivals");
    await click("#flow-rivals [data-back]");
    await click("#setup-laps");
    await capture("length");
    await click("#flow-length [data-back]");
    await click("#setup-mode");
    await capture("mode");
    await click("#mode-cup");
    await capture("cups");
    await click("#cup-list button:first-child");
    await capture("setup-cup");
    await click("#setup-mode");
    await click("#mode-tt");
    await capture("setup-tt");
    await click("#setup-mode");
    await click("#mode-gp");
    await click("#menu-map-btn");
    await capture("tracks");
    await click("#flow-track [data-back]");
    await click("#setup-mode");
    await click("#mode-split");
    await click("#setup-players");
    await click("#split-count-4");
    await capture("players");
    await click("#players-done");
    await capture("versus-4p");
    const previous = JSON.parse(await fs.readFile(new URL("measurements.json", out), "utf8"));
    measurements.push(
      ...previous.measurements.filter(
        (m) =>
          !["setup", "setup-cup", "setup-tt", "mode", "cups", "tracks", "versus-4p", "rivals", "length"].includes(
            m.name,
          ),
      ),
    );
    errors.push(
      ...previous.errors.filter(
        (e) => !/\/(setup|setup-cup|setup-tt|mode|cups|tracks|versus-4p|rivals|length):/.test(e),
      ),
    );
  } else {
    await capture("home");
    await click("#open-settings");
    for (const category of ["audio", "controls", "display", "save"]) {
      await click(`[data-category="${category}"]`);
      await capture("settings-" + category);
      if (category === "display") {
        await click('[data-display-field="graphics"]');
        await capture("display-graphics");
        await click("#settings .menu-fixed-actions button");
        await click('[data-display-field="frame-rate"]');
        await capture("display-frame-rate");
        await click("#settings .menu-fixed-actions button");
      }
    }
    await click("#settings-back");
    await click("#howto-btn");
    await capture("help");
    await click("#howto-back");
    await click("#open-catalog");
    for (const category of ["prizes", "karts", "creators", "ach"]) {
      await click("#catalog-tab-" + category);
      await capture("collection-" + category);
    }
    await click("#catalog-tab-prizes");
    await click('#catalog [data-prize="cat.3"]');
    await capture("collection-purchase");
    await click("#racer-details-close");
    await click('#catalog [data-prize="cat.12"]');
    await capture("collection-reward");
    await click("#racer-details-close");
    await click("#catalog-back");
    await click("#open-garage");
    await capture("garage");
    await click("#garage-cat");
    await capture("cats-owned");
    await click('[data-inventory="cat"][data-filter="all"]');
    await capture("cats-all");
    await click("#cat-custom-open");
    await capture("cat-studio");
    await click('#flow-cat-edit [data-studio-field="type"]');
    await capture("cat-types");
    await click("#flow-cat-edit .studio-detail-done");
    await click('#flow-cat-edit [data-studio-field="name"]');
    await click("#cat-name-pick");
    await capture("name-picker");
    await click("#cat-name-close");
    await click("#flow-cat-edit .studio-detail-done");
    await click("#cat-edit-use");
    await click("#garage-kart");
    await capture("karts");
    await click("#kart-custom-open");
    await capture("kart-shop");
    await click('#flow-kart-edit [data-studio-field="number"]');
    await capture("kart-numbers");
    await click("#flow-kart-edit .studio-detail-done");
    await click("#kart-edit-use");
    await click("#garage-done");
    await click("#start-btn");
    await page.waitForFunction(() => document.getElementById("racer-portrait").dataset.ready === "true");
    await capture("setup");
    await click("#setup-rivals");
    await capture("rivals");
    await click("#flow-rivals [data-back]");
    await click("#setup-laps");
    await capture("length");
    await click("#flow-length [data-back]");
    await click("#setup-mode");
    await capture("mode");
    await click("#mode-cup");
    await capture("cups");
    await click("#cup-list button:first-child");
    await capture("setup-cup");
    await click("#setup-mode");
    await click("#mode-tt");
    await capture("setup-tt");
    await click("#setup-mode");
    await click("#mode-gp");
    await click("#menu-map-btn");
    await capture("tracks");
    await click("#track-custom-open");
    await capture("track-builder");
    await click('[data-builder-field="details"]');
    await capture("track-builder-details");
    await click(".builder-done");
    await click("#track-back");
    await click("#flow-track [data-back]");
    await click("#setup-mode");
    await click("#mode-split");
    await click("#setup-players");
    await click("#split-count-4");
    await capture("players");
    await click("#players-done");
    await capture("versus-4p");
    await click("#setup-mode");
    await click("#mode-gp");
    await click("#go-btn");
    await page.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
    await page.keyboard.press("p");
    await capture("pause");
    await click("#pause-restart");
    await capture("confirmation");
    await click("#confirm-cancel");
    await click("#menu-btn");
    await capture("home-paused");
    await click("#resume-race-btn");
    await page.evaluate(() => window.__zoomies.debugFinish());
    await page.locator("#results:not(.hidden)").waitFor();
    await capture("results");
    // The actual web shell has Get the app instead of Quit. Verify that layout,
    // not just the simulated desktop bridge used for the Versus coverage above.
    await page.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:8080/?webgl=1&nosw=1&nowd=1", { timeout: 180000 });
    await page.waitForFunction(() => window.__zoomies?.track);
    await capture("home-web");
    // Exercise the iOS help handler; this is not a native install test.
    await page.locator("#install-btn").evaluate((button) => button.click());
    await capture("install-help");
    await click("#install-help-back");
  }
  await fs.writeFile(new URL("measurements.json", out), JSON.stringify({ errors, measurements }, null, 2));
  const files = measurements.map(({ device, name }) => `${device}-${name}.jpg`);
  const cards = files
    .map(
      (f) =>
        `<figure><a href="screenshots/${f}"><img loading="lazy" src="screenshots/${f}" alt="${f}"></a><figcaption>${f.slice(0, -4)}</figcaption></figure>`,
    )
    .join("");
  await fs.writeFile(
    new URL("gallery.html", out),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Menu refresh review</title><style>body{background:#181321;color:#fff6e5;font:16px system-ui;margin:28px}h1{color:#ffc24b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}figure{margin:0;background:#2a2039;padding:12px;border-radius:16px}img{width:100%;height:270px;object-fit:contain}figcaption{padding:10px;font-size:12px}input{padding:12px;margin-bottom:20px;width:280px}</style><h1>Menu refresh · Review</h1><p>Chromium viewport captures with a simulated desktop bridge and unlocked creators, plus the actual web Home screen. Results use synthetic completion. Physical-device testing remains separate.</p><input aria-label="Filter screenshots" placeholder="Filter: portrait, setup, pause…" oninput="document.querySelectorAll('figure').forEach(f=>f.hidden=!f.textContent.includes(this.value))"><div class="grid">${cards}</div></html>`,
  );
  if (errors.length) throw Error(errors.join("\n"));
} finally {
  await browser.close();
}
