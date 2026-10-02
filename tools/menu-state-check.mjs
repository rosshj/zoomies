import { launchArtBrowser, serveRepo } from "./art-browser.mjs";
import assert from "node:assert/strict";
const { origin, close } = await serveRepo();
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
try {
  await p.goto(`${origin}/?webgl=1&nosw=1&nowd=1`);
  await p.waitForFunction(() => window.__zoomies?.track);
  const cupURL = await p.evaluate(async () => {
    const { CUPS } = await import("/src/progress.js");
    const { encodeWorld } = await import("/src/worldcfg.js");
    const cup = CUPS[0],
      race = cup.races[0];
    sessionStorage.setItem("zoomies-cup-v1", JSON.stringify({ id: cup.id, race: 0, points: {}, diff: "medium" }));
    const url = new URL(location.href);
    url.searchParams.set("cup", cup.id);
    url.searchParams.set("seed", race.seed);
    url.searchParams.set("w", encodeWorld({ cfg: race.cfg, laps: 3, seed: race.seed }));
    return url.toString();
  });
  await p.goto(cupURL);
  await p.waitForFunction(() => window.__zoomies?.track);
  await click("#start-btn");
  await click("#go-btn");
  await p.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
  await p.keyboard.press("p");
  await click("#menu-btn");
  assert.ok(await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1")), "Home erased cup");
  await click("#resume-race-btn");
  assert.equal(await p.evaluate(() => window.__zoomies.state()), 2);
  await p.evaluate(() => window.__zoomies.debugFinish());
  await p.locator("#results:not(.hidden)").waitFor();
  const scored = await p.evaluate(() => JSON.parse(sessionStorage.getItem("zoomies-cup-v1")));
  assert.equal(scored.scored, 0);
  assert.ok(scored.points.You > 0);
  await click("#results-menu-btn");
  await click("#start-btn");
  assert.match(await p.locator("#go-btn").textContent(), /race 2 of/i);
  await click("#go-btn");
  // The reload into race 2 starts the race itself: no Home / setup detour.
  await p.waitForFunction(
    () => window.__zoomies?.track && JSON.parse(sessionStorage.getItem("zoomies-cup-v1")).race === 1,
    null,
    { timeout: 180000 },
  );
  await p.waitForFunction(() => window.__zoomies.state() === 2, null, { timeout: 180000 });
  assert.ok(await p.evaluate(() => document.getElementById("menu").classList.contains("hidden")), "Menu up in race 2");
  assert.deepEqual(
    await p.evaluate(() => JSON.parse(sessionStorage.getItem("zoomies-cup-v1")).points),
    scored.points,
    "Continue lost points",
  );
  await p.keyboard.press("p");
  await click("#menu-btn"); // park race 2, back Home
  assert.match(await p.locator("#start-btn").textContent(), /race setup/i);
  await click("#start-btn");
  await click("#confirm-accept"); // give up the parked race, keep the series
  await step("startline");
  const cupBeforeMap = await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1"));
  await click("#menu-map-btn"); // opening the cup list never prompts…
  await step("cup");
  await click("#cup-list button:nth-child(2)"); // …switching cups does
  await p.locator("#menu-confirm:not(.hidden)").waitFor();
  await click("#confirm-cancel");
  await step("cup");
  await click("#cup-list button:first-child"); // the current cup: straight back, nothing lost
  await step("startline");
  assert.equal(
    await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1")),
    cupBeforeMap,
    "Cup list visit changed cup progress",
  );
  await click("#setup-mode");
  await click("#mode-cup"); // the current mode mid-series: back to setup, no prompt
  await step("startline");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1")), cupBeforeMap);
  await click("#setup-mode");
  await click("#mode-tt");
  await click("#confirm-cancel");
  assert.ok(await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1")), "Cancel abandoned cup");
  await click("#mode-tt");
  await click("#confirm-accept");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("zoomies-cup-v1")), null);
  await step("startline");
  assert.equal(await p.locator("#setup-mode-name").textContent(), "Time Trial");
  // Save a different custom world, then verify Daily does not inherit it.
  await p.evaluate(() =>
    localStorage.setItem(
      "zoomies-track-v1",
      JSON.stringify({
        mode: "custom",
        seed: "NOT-TODAY",
        size: 0.2,
        curviness: 0.1,
        twist: 0.1,
        hilliness: 0,
        hills: 0,
        biomes: ["desert"],
      }),
    ),
  );
  await click("#setup-mode");
  await click("#mode-daily");
  await p.waitForFunction(
    () => window.__zoomies?.track && document.getElementById("menu").dataset.step === "startline",
    null,
    { timeout: 180000 },
  );
  const daily = await p.evaluate(async () => {
    const { getSeed } = await import("/src/rng.js");
    return { world: getSeed(), url: new URL(location.href).searchParams.get("seed") };
  });
  assert.equal(daily.world, daily.url, "Daily inherited saved custom seed");
  await click("#menu-map-btn"); // the list opens without a prompt…
  await step("track");
  await click("#track-grid button:first-child"); // …picking a track (even Classic) asks first
  await p.locator("#menu-confirm:not(.hidden)").waitFor();
  await click("#confirm-cancel");
  await step("track");
  assert.ok(await p.evaluate(() => new URL(location.href).searchParams.get("daily")), "Cancel left the daily");
  await p.locator(".flow-screen.is-active .flow-back").click();
  await step("startline");
  assert.deepEqual(errors, []);
  console.log("PASS: cup park/resume, scoring, next round, abandon/cancel, deterministic daily routing.");
} finally {
  await browser.close();
  await close();
}
