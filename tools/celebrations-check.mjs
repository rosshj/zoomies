// Celebrations: the podium ceremony on a cup win, the results fly-in and reveal
// cards, and the purchase reveal in the Collection. Drives the real flows with
// the debug finish hooks (no three real laps) and screenshots each beat when
// SHOTS=<dir> is set.
import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const SHOTS = process.env.SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const { origin, close } = await serveRepo();
const browser = await launchArtBrowser();
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
p.on("pageerror", (e) => {
  errors.push(e.message);
  console.error(e.message);
});
p.setDefaultTimeout(90000);
p.setDefaultNavigationTimeout(180000);
const shot = async (name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.jpg`, quality: 70 });
};
const click = async (selector) => {
  await p.locator(selector).click();
  await p.waitForTimeout(400);
};
const boot = async (url) => {
  await p.goto(url);
  await p.waitForFunction(() => window.__zoomies?.track, null, { timeout: 180000 });
};
const race = async () => {
  await click("#start-btn");
  await click("#go-btn");
  await p.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
};
const revealOpen = () => p.locator("#celebrate-reveal:not(.hidden)");
const dismissReveals = async () => {
  for (let i = 0; i < 8 && (await revealOpen().count()); i++) {
    await p.locator("#celebrate-reveal.is-open #celebrate-continue").waitFor();
    await click("#celebrate-continue");
  }
  assert.equal(await revealOpen().count(), 0, "Reveal stack did not close");
};
try {
  // --- Cup final, player leads: the podium ceremony, then results with a trophy
  // card and the cup's exclusive unlock card.
  await boot(`${origin}/?webgl=1&nosw=1&nowd=1`);
  const cupURL = await p.evaluate(async () => {
    const { CUPS } = await import("/src/progress.js");
    const { encodeWorld } = await import("/src/worldcfg.js");
    const cup = CUPS[0];
    const last = cup.races.length - 1;
    const race = cup.races[last];
    sessionStorage.setItem(
      "zoomies-cup-v1",
      JSON.stringify({ id: cup.id, race: last, points: { You: 40 }, diff: "medium", scored: last - 1 }),
    );
    const url = new URL(location.href);
    url.searchParams.set("cup", cup.id);
    url.searchParams.set("seed", race.seed);
    url.searchParams.set("w", encodeWorld({ cfg: race.cfg, laps: 3, seed: race.seed }));
    return url.toString();
  });
  await boot(cupURL);
  await race();
  assert.ok(await p.evaluate(() => window.__zoomies.debugFinishSequence()), "finish sequence did not start");
  await p.waitForFunction(() => !!window.__zoomies.podium, null, { timeout: 30000 });
  // Sim time runs behind wall time under a software renderer (frame deltas are
  // clamped), so wait on the ceremony's own state, never a fixed sleep.
  await p.waitForFunction(() => window.__zoomies.podium?.confetti.active, null, { timeout: 90000 });
  const podium = await p.evaluate(() => {
    const P = window.__zoomies.podium;
    return {
      parked: P.parked.size,
      banner: document.getElementById("celebrate-banner").className,
      bannerText: document.querySelector("#celebrate-banner .celebrate-banner-title").textContent,
      confetti: P.confetti.active,
      results: document.getElementById("results").classList.contains("hidden"),
    };
  });
  assert.equal(podium.parked, 3, "Three karts should stand on the podium");
  assert.match(podium.banner, /is-in/, "Champion banner did not slam in");
  assert.equal(podium.bannerText, "Champion!");
  assert.ok(podium.confetti, "Cannons did not fire");
  assert.ok(podium.results, "Results came up before the ceremony");
  await shot("podium-ceremony");
  await p.locator("#results:not(.hidden)").waitFor({ timeout: 240000 });
  assert.ok(await p.evaluate(() => !!window.__zoomies.podium), "Podium should stay behind the results");
  assert.match(await p.locator("#results-title").textContent(), /Champion/);
  await shot("podium-results");
  await revealOpen().waitFor({ timeout: 15000 });
  await p.locator("#celebrate-reveal.is-open").waitFor({ timeout: 15000 });
  await p.waitForTimeout(700);
  const trophy = await p.evaluate(() => ({
    kicker: document.getElementById("celebrate-reveal-kicker").textContent,
    name: document.querySelector(".celebrate-name").textContent,
    dots: document.querySelectorAll(".celebrate-dots i").length,
  }));
  assert.equal(trophy.kicker, "Cup won");
  assert.ok(trophy.dots >= 2, "Trophy card should be followed by the cup's unlock card");
  await shot("reveal-trophy");
  await click("#celebrate-continue");
  await p.locator("#celebrate-reveal.is-open").waitFor({ timeout: 15000 });
  await p.waitForFunction(() => document.getElementById("celebrate-portrait").dataset.ready === "true", null, {
    timeout: 60000,
  });
  await p.waitForTimeout(900);
  const unlock = await p.evaluate(() => ({
    kicker: document.getElementById("celebrate-reveal-kicker").textContent,
    name: document.querySelector(".celebrate-name").textContent,
    subject: document.querySelector(".celebrate-stage").dataset.subject,
  }));
  assert.equal(unlock.kicker, "New kart", "Catnip Meadows unlocks a kart");
  assert.equal(unlock.subject, "kart");
  assert.ok(unlock.name.length > 0);
  await shot("reveal-unlock");
  await dismissReveals();
  assert.equal(await p.locator("#results:not(.hidden)").count(), 1, "Results should remain after the reveals");
  const trophies = await p.evaluate(() => JSON.parse(localStorage.getItem("zoomies-profile-v1")).trophies);
  assert.equal(trophies.meadows, "medium");
  await click("#results-menu-btn");
  assert.equal(await p.evaluate(() => !!window.__zoomies.podium), false, "Home should tear the podium down");
  assert.equal(await p.locator("#celebrate:not(.hidden)").count(), 0, "Layer should be cleared on Home");
  assert.deepEqual(errors, []);

  // --- A plain first race: the payout rows fly into the total, the badge rows
  // stamp, and the very first win gets its banner.
  await boot(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await p.evaluate(() => localStorage.removeItem("zoomies-profile-v1"));
  await boot(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await race();
  await p.evaluate(() => window.__zoomies.debugFinish());
  await p.locator("#results:not(.hidden)").waitFor();
  await p.waitForTimeout(600);
  assert.equal(
    await p.locator("#celebrate-banner .celebrate-banner-title").textContent(),
    "First win!",
    "First win banner missing",
  );
  await shot("first-win");
  await p.waitForTimeout(4500);
  const ledger = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("#results-earnings .earn-row:not(.earn-ach):not(.earn-total)")];
    const sum = rows.reduce((n, r) => n + Number(r.lastElementChild.textContent.replace(/[^\d]/g, "")), 0);
    const total = Number(
      document.querySelector("#results-earnings .earn-total").lastElementChild.textContent.replace(/[^\d]/g, ""),
    );
    const badges = [...document.querySelectorAll("#results-earnings .earn-badge")].map((r) => r.className);
    return { sum, total, badges, fish: document.querySelectorAll(".celebrate-fish").length };
  });
  assert.equal(ledger.total, ledger.sum, "Total did not count up to the payout");
  assert.equal(ledger.fish, 0, "Fish should land and clear");
  for (const cls of ledger.badges) assert.match(cls, /celebrate-stamp/, "Badge row did not stamp");
  await shot("results-ledger");
  await dismissReveals();
  await click("#results-menu-btn");
  assert.deepEqual(errors, []);

  // --- Buying a prize in the Collection reveals it.
  await p.evaluate(() => {
    const prof = JSON.parse(localStorage.getItem("zoomies-profile-v1"));
    prof.treats = 500;
    localStorage.setItem("zoomies-profile-v1", JSON.stringify(prof));
  });
  await boot(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await click("#chrome-treats");
  await click('[data-prize="cat.3"]');
  await p.locator("#racer-details:not(.hidden)").waitFor();
  await click("#racer-details-action");
  await p.locator("#celebrate-reveal.is-open").waitFor({ timeout: 15000 });
  await p.waitForFunction(() => document.getElementById("celebrate-portrait").dataset.ready === "true", null, {
    timeout: 60000,
  });
  await p.waitForTimeout(900);
  const bought = await p.evaluate(() => ({
    kicker: document.getElementById("celebrate-reveal-kicker").textContent,
    ribbon: document.querySelector(".celebrate-ribbon").textContent,
    subject: document.querySelector(".celebrate-stage").dataset.subject,
    yaw: document.getElementById("celebrate-portrait").dataset.yaw,
  }));
  assert.equal(bought.kicker, "Yours!");
  assert.equal(bought.ribbon, "BOUGHT");
  assert.equal(bought.subject, "cat");
  assert.ok(Number(bought.yaw) > 0.35, "Turntable is not turning the bought cat");
  await shot("reveal-bought");
  await dismissReveals();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: podium ceremony, trophy + unlock reveals, results fly-in and stamps, first-win banner, purchase reveal.",
  );
} finally {
  await browser.close();
  await close();
}
