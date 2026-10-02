// Live creator migration, picker, save/reload and race appearance checks.
import { launchArtBrowser, artBackends } from "./art-browser.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const f = root + (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
    res.setHeader(
      "content-type",
      f.endsWith(".html")
        ? "text/html"
        : f.endsWith(".js")
          ? "text/javascript"
          : f.endsWith(".css")
            ? "text/css"
            : f.endsWith(".jpg")
              ? "image/jpeg"
              : "application/octet-stream",
    );
    res.end(await fs.readFile(f));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await launchArtBrowser();
try {
  const p = await browser.newPage({ viewport: { width: 1100, height: 700 } }),
    errors = [];
  p.setDefaultNavigationTimeout(180000);
  p.setDefaultTimeout(60000);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    if (!localStorage.getItem("zoomies-profile-v1")) {
      localStorage.setItem(
        "zoomies-profile-v1",
        JSON.stringify({ unlocked: ["custom.cat", ...Array.from({ length: 40 }, (_, i) => "cat." + i)], treats: 0 }),
      );
      localStorage.setItem(
        "zoomies-garage-v1",
        JSON.stringify({
          cat: 14,
          kart: 0,
          customCat: {
            name: "Legacy",
            fur: 0xd4a69c,
            pattern: "solid",
            accessory: "propeller",
            accessoryColor: 0x4393dc,
          },
        }),
      );
      localStorage.setItem("zoomies-quality-v2", "medium");
      localStorage.setItem(
        "zoomies-track-v1",
        JSON.stringify({
          mode: "custom",
          seed: "ROSTER-UI",
          size: 0.5,
          curviness: 0.4,
          twist: 0.3,
          hilliness: 0.25,
          hills: 0.4,
          biomes: ["meadow"],
        }),
      );
    }
  });
  const backend = (await artBackends(browser, server.address().port)).at(-1);
  const url = `http://127.0.0.1:${server.address().port}/?${backend}=1&nosw=1&nowd=1`;
  let loads = 0;
  const load = async () => {
    console.log(`[creator] load ${++loads}: ${backend}`);
    await p.goto(url);
    await p.waitForFunction(() => window.__zoomies?.track, null, { timeout: 180000 });
  };
  const editor = async () => {
    await p.evaluate(() => document.querySelector("#setup-cat").click());
    await p.getByText("Custom Cat", { exact: true }).click();
  };
  await load();
  await editor();
  const result = await p.evaluate(async () => {
    const assert = (x, m) => {
      if (!x) throw Error(m);
    };
    assert(document.querySelector("#cat-custom-name").value === "Legacy", "Legacy custom selection lost");
    assert(document.querySelector("#cat-type-name").textContent === "Classic", "Legacy type default");
    const labels = new Set();
    for (let i = 0; i < 27; i++) {
      labels.add(document.querySelector("#cat-type-name").textContent);
      document.querySelector("#cat-type-next").click();
    }
    assert(labels.size === 27, "Missing creator types");
    while (document.querySelector("#cat-type-name").textContent !== "British Shorthair")
      document.querySelector("#cat-type-next").click();
    document.querySelector("#cat-edit-use").click();
    const save = JSON.parse(localStorage.getItem("zoomies-garage-v1"));
    assert(
      save.v === 3 && save.cat === 40 && save.catId === "custom" && save.customCat.type === "british",
      "New save failed",
    );
    assert(
      save.customCat.accessory === "propeller" && save.customCat.accessoryColor === 0x4393dc,
      "Lost old accessory",
    );
    return { labels: [...labels], save };
  });
  await load();
  await editor();
  if ((await p.locator("#cat-type-name").textContent()) !== "British Shorthair") throw Error("Reload lost type");
  await p.evaluate(() => {
    document.querySelector("#cat-edit-use").click();
    document.querySelector("#go-btn").click();
  });
  await p.waitForFunction(() => window.__zoomies.karts?.length === 6, null, { timeout: 180000 });
  const racers = await p.evaluate(async () => {
    const { CAT_PRESETS } = await import("/src/presets.js"),
      { catType } = await import("/src/cat-types.js");
    const karts = window.__zoomies.karts,
      rows = karts.map((k) => ({
        name: k.name,
        isPlayer: k.isPlayer,
        type: k.group.children.find((c) => c.userData.catType)?.userData.catType,
      }));
    if (rows.find((k) => k.isPlayer).type !== "British Shorthair") throw Error("Race dropped custom type");
    for (const c of rows.filter((k) => !k.isPlayer)) {
      const preset = CAT_PRESETS.find((p) => p.name === c.name);
      if (!preset || catType(preset.type).label !== c.type) throw Error("AI appearance mismatch");
    }
    const save = JSON.parse(localStorage.getItem("zoomies-garage-v1"));
    save.cat = 14;
    save.catId = null;
    localStorage.setItem("zoomies-garage-v1", JSON.stringify(save));
    return rows;
  });
  await load();
  await p.evaluate(() => document.querySelector("#go-btn").click());
  await p.waitForFunction(() => window.__zoomies.karts?.length === 6, null, { timeout: 180000 });
  const presetType = await p.evaluate(
    () =>
      window.__zoomies.karts.find((k) => k.isPlayer).group.children.find((c) => c.userData.catType)?.userData.catType,
  );
  if (presetType !== "Maine Coon") throw Error("Version 2 preset index mistaken for legacy custom");
  // A fresh creator may preview a prize, but cannot use it until its cat is earned.
  await p.evaluate(() => {
    localStorage.setItem("zoomies-profile-v1", JSON.stringify({ unlocked: ["custom.cat"], treats: 0 }));
    const save = JSON.parse(localStorage.getItem("zoomies-garage-v1"));
    save.cat = 0;
    save.catId = null;
    save.customCat.accessory = "none";
    localStorage.setItem("zoomies-garage-v1", JSON.stringify(save));
  });
  await load();
  await editor();
  await p.evaluate(() => {
    for (let i = 0; i < 45 && !document.querySelector("#cat-acc-name").textContent.includes("Unlock Timber"); i++)
      document.querySelector("#cat-acc-next").click();
    if (
      !document.querySelector("#cat-acc-name").textContent.includes("Unlock Timber") ||
      !document.querySelector("#cat-edit-use").disabled
    )
      throw Error("Wardrobe must name its cat and prevent using a locked accessory");
    const profile = JSON.parse(localStorage.getItem("zoomies-profile-v1"));
    profile.unlocked.push("cat.14");
    localStorage.setItem("zoomies-profile-v1", JSON.stringify(profile));
  });
  await load();
  await editor();
  await p.evaluate(() => {
    for (let i = 0; i < 45 && !document.querySelector("#cat-acc-name").textContent.includes("Dragon"); i++)
      document.querySelector("#cat-acc-next").click();
    if (
      document.querySelector("#cat-edit-use").disabled ||
      document.querySelector("#cat-acc-name").textContent.includes("🔒")
    )
      throw Error("Owned cat did not unlock its wardrobe item");
  });
  if (errors.length) throw Error(errors.join("\n"));
  console.log(JSON.stringify({ result, racers, presetType, errors }));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  server.closeAllConnections();
  server.close();
}

process.exit(0);
