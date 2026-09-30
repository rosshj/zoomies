import { launchArtBrowser } from "./art-browser.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const output = path.join(root, "docs/menu-refresh/after");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const f = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" }[
        path.extname(f)
      ] || "application/octet-stream",
    );
    res.end(await fs.readFile(f));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await launchArtBrowser();
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
p.on("pageerror", (e) => {
  errors.push(e.message);
  console.error(e.message);
});
p.setDefaultTimeout(60000);
p.setDefaultNavigationTimeout(180000);
const step = async (name) => assert.equal(await p.locator("#menu").getAttribute("data-step"), name);
const click = async (selector) => {
  await p.locator(selector).click();
  await p.waitForTimeout(500);
};
const garage = () => p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-garage-v1") || "null"));
async function shot(name) {
  await p.waitForTimeout(550);
  await p.screenshot({ path: path.join(output, name + ".jpg"), quality: 80 });
}
try {
  await p.addInitScript(() => {
    window.zoomiesDesktop = { quit() {} };
  });
  await p.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1`);
  await p.waitForFunction(() => window.__zoomies?.track);
  await p.locator("#start-btn").waitFor();
  await shot("home-deck");
  await click("#start-btn");
  await step("startline");
  await shot("setup-deck");
  await click("#setup-mode");
  await click("#mode-tt");
  await step("startline");
  assert.equal(await p.locator("#setup-mode-name").textContent(), "Time Trial");
  await click("#setup-mode");
  await click("#mode-gp");
  await step("startline");
  await click("#startline-edit");
  await step("cat");
  await shot("cats-deck");
  await click("#cat-grid button:nth-child(2)");
  await step("startline");
  const saved = await garage();
  assert.equal(saved.cat, 1);
  await click("#startline-kart");
  await step("kart");
  await click("#flow-kart [data-back]");
  await step("startline");
  assert.deepEqual(await garage(), saved, "Cancel changed saved racer");
  await click("#startline-edit");
  await click("#cat-custom-open");
  await step("cat-edit");
  await click("#cat-type-next");
  await click("#flow-cat-edit [data-back]");
  await step("cat");
  await click("#flow-cat [data-back]");
  await step("startline");
  assert.deepEqual(await garage(), saved, "Cancelled custom draft leaked");
  await click("#setup-track");
  await step("track");
  await click("#track-grid .is-current");
  await step("startline");
  await click("#flow-startline [data-back]");
  await step("title");
  await click("#open-garage");
  await step("garage");
  await shot("garage-deck");
  await click("#garage-kart");
  await click("#kart-grid button:first-child");
  await step("garage");
  await click("#garage-done");
  await step("title");
  await click("#start-btn");
  await click("#setup-mode");
  await click("#mode-split");
  await click("#split-count-4");
  const beforeSeat = await garage();
  await click("#p2-edit");
  await step("garage");
  await click("#garage-cat");
  await click("#cat-grid button:nth-child(3)");
  await step("garage");
  await click("#garage-done");
  await step("startline");
  assert.deepEqual(await garage(), beforeSeat, "Guest overwrote Player 1");
  await shot("versus-deck");
  await click("#setup-mode");
  await click("#mode-gp");
  for (const [name, width, height] of [
    ["phone", 844, 390],
    ["small-phone", 667, 375],
    ["portrait", 390, 844],
    ["macbook", 1440, 900],
    ["720", 1280, 720],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(300);
    await shot("setup-" + name);
    const visible = await p.locator("#go-btn").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    });
    assert.ok(visible, "Start clipped at " + name);
  }
  await p.setViewportSize({ width: 1280, height: 800 });
  await click("#go-btn");
  await p.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
  await p.keyboard.press("p");
  await p.waitForFunction(() => window.__zoomies.state() === 4);
  assert.equal(await p.locator("#toast").textContent(), "");
  await shot("pause-deck");
  await click("#open-settings-pause");
  await click('[data-category="controls"]');
  await shot("settings-controls");
  await p.keyboard.press("Escape");
  assert.equal(await p.evaluate(() => window.__zoomies.state()), 4);
  await click("#pause-restart");
  await p.keyboard.press("Escape");
  assert.equal(await p.evaluate(() => window.__zoomies.state()), 4);
  await click("#menu-btn");
  await step("title");
  await click("#start-btn");
  await p.locator("#menu-confirm:not(.hidden)").waitFor();
  await click("#confirm-cancel");
  await click("#resume-race-btn");
  assert.equal(await p.evaluate(() => window.__zoomies.state()), 2, "Resume needs another click");
  await p.evaluate(() => window.__zoomies.debugFinish());
  await p.locator("#results:not(.hidden)").waitFor();
  const paid = await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")));
  assert.equal(paid.pendingClaims.length, 0, "Badge payouts still gated");
  await p.evaluate(() => window.__zoomies.debugFinish());
  assert.equal(
    await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats),
    paid.treats,
    "Double badge payment",
  );
  for (const [name, width, height] of [
    ["phone", 844, 390],
    ["small-phone", 667, 375],
    ["deck", 1280, 800],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(200);
    await shot("results-" + name);
    assert.ok(
      await p.locator("#restart-btn").evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
      "Results action clipped at " + name,
    );
  }
  await click("#results-setup-btn");
  await step("startline");
  await click("#chrome-gear");
  await click('[data-category="display"]');
  await shot("settings-display");
  await click("#settings-back");
  await p.setViewportSize({ width: 1280, height: 800 });
  await click("#setup-track");
  await click("#track-grid .track-tap:nth-child(2)");
  await p.waitForFunction(
    () => window.__zoomies?.track && document.getElementById("menu").dataset.step === "startline",
    null,
    { timeout: 180000 },
  );
  assert.equal(
    await p.locator("#setup-track-name").textContent(),
    "Buttercup Run",
    "Track reload lost setup destination",
  );
  // Collection purchase/equip uses a confirmation and the owner's saved loadout.
  await click("#chrome-treats");
  const ownedCount = await p.locator("#catalog-prizes .owned:not(.hidden)").count();
  assert.ok(ownedCount > 0);
  await click("#catalog-tab-karts");
  await click('[data-prize="kart.1"]');
  assert.equal((await garage()).kart, 1);
  await click("#catalog-tab-prizes");
  await click('[data-prize="cat.3"]');
  await p.locator("#menu-confirm:not(.hidden)").waitFor();
  await click("#confirm-cancel");
  const wallet = await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats);
  await click('[data-prize="cat.3"]');
  await click("#confirm-accept");
  assert.equal(
    await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats),
    wallet - 100,
    "Purchase not settled once",
  );
  await click('[data-prize="cat.3"]');
  assert.equal((await garage()).cat, 3, "Owned prize did not equip");
  assert.equal(
    await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).treats),
    wallet - 100,
    "Equipping charged again",
  );
  await click("#catalog-back");
  await click("#chrome-gear");
  await click('[data-category="save"]');
  await p.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("zoomies:text-entry", { detail: { input: document.getElementById("backup-code") } }),
    ),
  );
  await click("#keyboard-case");
  await p.getByRole("button", { name: "z", exact: true }).click();
  await click("#keyboard-done");
  assert.equal(await p.locator("#backup-code").inputValue(), "z");
  await p.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("zoomies:text-entry", { detail: { input: document.getElementById("backup-code") } }),
    ),
  );
  await p.getByRole("button", { name: "x", exact: true }).click();
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("#backup-code").inputValue(), "z", "Cancelled virtual typing leaked");
  for (let i = 0; i < 30; i++) {
    await p.keyboard.press("Tab");
    assert.ok(
      await p.evaluate(() => document.getElementById("settings").contains(document.activeElement)),
      "Tab escaped settings",
    );
  }
  await click("#settings-back");
  // Portrait menus stay upright; entering and resuming a race returns to landscape.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForFunction(() => !document.getElementById("stage").classList.contains("rotated"));
  await click("#go-btn");
  await p.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
  assert.ok(await p.locator("#stage").evaluate((e) => e.classList.contains("rotated")));
  await p.keyboard.press("p");
  await p.waitForFunction(
    () => window.__zoomies.state() === 4 && document.getElementById("stage").classList.contains("rotated"),
  );
  await shot("pause-portrait");
  await click("#resume-btn");
  await p.waitForFunction(() => document.getElementById("stage").classList.contains("rotated"));
  await p.evaluate(() => window.__zoomies.debugFinish());
  await p.waitForFunction(() => !document.getElementById("stage").classList.contains("rotated"));
  await shot("results-portrait");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: setup, independent picks, cancel, garage, guest isolation, rewards, collection, keyboard, focus, portrait race/pause transitions and responsive actions.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
