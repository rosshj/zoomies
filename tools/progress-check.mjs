// Progression economy checks — pure node, dependency-free (runs in CI).
// Covers: profile migration (incl. forward-compat), the unlock catalog + buying,
// race payouts, achievements, cup standings/trophies/exclusives, the daily seed,
// and the backup-token round trip. Run: `npm run check:progress`.
import {
  PROFILE_VERSION, defaultProfile, migrateProfile,
  CATALOG, STARTER_UNLOCKS, isUnlocked, buyUnlock, catalogEntry,
  racePayout, ACHIEVEMENTS, checkAchievements, claimAchievement,
  CUPS, cupPoints, cupStandings, awardCup, cupById,
  dailySeedFor, encodeProfileToken, decodeProfileToken,
} from "../src/progress.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// --- Profile & migration ---
{
  const p = defaultProfile();
  check("fresh profile has the starter set unlocked", STARTER_UNLOCKS.every((id) => p.unlocked.includes(id)));
  check("fresh profile starts broke", p.treats === 0 && p.achievements.length === 0);

  const junk = migrateProfile({ treats: -50, unlocked: "nope", stats: { races: 7, bogus: 9 }, achievements: [3, "first-race"] });
  check("migration heals junk (treats floor, starter restored, stats kept)",
    junk.treats === 0 && STARTER_UNLOCKS.every((id) => junk.unlocked.includes(id)) && junk.stats.races === 7 && junk.achievements.length === 1);
  check("migration coerces the version", junk.v === PROFILE_VERSION);

  const claims = migrateProfile({ achievements: ["first-race"], pendingClaims: ["first-race", "never-earned", 7] });
  check("migration keeps valid pending claims, drops orphans", claims.pendingClaims.length === 1 && claims.pendingClaims[0] === "first-race");

  const future = migrateProfile({ treats: 10, unlocked: [...STARTER_UNLOCKS, "hat.99"], futureField: { a: 1 } });
  check("unknown unlock ids + future fields survive a round trip", future.unlocked.includes("hat.99") && future.futureField && future.futureField.a === 1);
  check("unknown ids read as unlocked (never brick a save)", isUnlocked(future, "hat.99") && isUnlocked(future, "totally.new"));
}

// --- Catalog + buying ---
{
  const p = defaultProfile();
  check("catalog has cats, karts, and the custom creators", catalogEntry("cat.9") && catalogEntry("kart.8") && catalogEntry("custom.cat"));
  check("locked preset reads locked", !isUnlocked(p, "cat.5"));
  check("can't buy while broke", !buyUnlock(p, "cat.3") && !p.unlocked.includes("cat.3"));
  p.treats = 200;
  check("buying deducts and unlocks", buyUnlock(p, "cat.3") && p.treats === 50 && isUnlocked(p, "cat.3"));
  check("can't buy twice", !buyUnlock(p, "cat.3") && p.treats === 50);
  p.treats = 9999;
  check("cup exclusives can't be bought", !buyUnlock(p, "cat.9") && !isUnlocked(p, "cat.9"));
  check("difficulty prizes can't be bought", !buyUnlock(p, "cat.13") && !isUnlocked(p, "cat.13"));
  const cupExclusives = CATALOG.filter((c) => c.cup);
  check("every cup exclusive maps to a real cup", cupExclusives.length === 4 && cupExclusives.every((c) => cupById(c.cup)));
  check("no accessory entries — the creator's wardrobe is ungated", !CATALOG.some((c) => c.id.startsWith("acc.")));
  check("difficulty prizes exist for medium and hard", CATALOG.some((c) => c.diff === "medium") && CATALOG.some((c) => c.diff === "hard"));
}

// --- Payout ---
{
  const win = racePayout({ place: 1, field: 6, laps: 3, difficulty: "hard", stats: { driftBoosts: 5, slipSeconds: 8, milkTrips: 2, zaps: 3, heartSaves: 1 } });
  check("hard win pays the placement base + winner bonus", win.lines[0].amt === 50 && win.lines[1].label === "Winner bonus");
  check("moments itemize (drift, slip, milk, zap, lives)", win.lines.length === 7 && win.total === 50 + 20 + 10 + 8 + 10 + 6 + 3);
  const last = racePayout({ place: 6, field: 6, laps: 3, difficulty: "hard", stats: {} });
  check("last place still pays something", last.total === 15);
  const easy = racePayout({ place: 1, field: 6, laps: 3, difficulty: "easy", stats: {} });
  check("easy pays less than hard", easy.total < win.total && easy.lines[0].amt === 30);
  const capped = racePayout({ place: 1, field: 6, laps: 3, difficulty: "hard", stats: { driftBoosts: 999, slipSeconds: 999, milkTrips: 99, zaps: 99, heartSaves: 99 } });
  check("moment caps hold (no farming)", capped.total === 50 + 20 + 20 + 15 + 25 + 10 + 9);
  const daily = racePayout({ place: 3, field: 6, laps: 3, difficulty: "medium", daily: true, stats: {} });
  check("daily bonus rides the payout", daily.lines.some((l) => l.label === "Daily challenge" && l.amt === 100));
}

// --- Achievements ---
{
  const p = defaultProfile();
  p.stats.races = 1;
  let fresh = checkAchievements(p);
  check("first race earns Out of the Cat Door (pending, unpaid)",
    fresh.length === 1 && fresh[0].id === "first-race" && p.treats === 0 && p.pendingClaims.includes("first-race"));
  const claimed = claimAchievement(p, "first-race");
  check("claiming the badge pays its treats", claimed && claimed.pay === 50 && p.treats === 50 && p.pendingClaims.length === 0);
  check("a badge can't be claimed twice", claimAchievement(p, "first-race") === null && p.treats === 50);
  fresh = checkAchievements(p);
  check("achievements fire only once", fresh.length === 0 && p.treats === 50);
  p.stats.wins = 1; p.stats.winsHard = 1; p.stats.winsNight = 1;
  fresh = checkAchievements(p);
  check("stacked thresholds all fire in one pass", fresh.length === 3);
  const q = defaultProfile();
  for (const c of CUPS) q.trophies[c.id] = "easy";
  const sweep = checkAchievements(q);
  check("cup-sweep needs all four cups", sweep.some((a) => a.id === "cup-sweep"));
  check("all achievement ids unique", new Set(ACHIEVEMENTS.map((a) => a.id)).size === ACHIEVEMENTS.length);
}

// --- Cups ---
{
  check("four cups, unique ids, 3-4 generated races each",
    CUPS.length === 4 && new Set(CUPS.map((c) => c.id)).size === 4 && CUPS.every((c) => c.races.length >= 3 && c.races.length <= 4));
  check("every cup race is a full generated world (custom cfg + seed + biomes + time)",
    CUPS.every((c) => c.races.every((r) => r.seed && r.cfg && r.cfg.mode === "custom" && r.cfg.seed === r.seed && Array.isArray(r.cfg.biomes) && r.cfg.biomes.length >= 1 && r.cfg.timeOfDay)));
  check("cup race seeds unique across all cups",
    (() => { const all = CUPS.flatMap((c) => c.races.map((r) => r.seed)); return new Set(all).size === all.length; })());
  // Must match the BIOMES roster in src/scenery.js (which imports THREE, so it
  // can't be imported here) — catches a typo'd biome name in a cup recipe.
  const KNOWN_BIOMES = ["meadow", "forest", "alpine", "autumn", "desert", "mesa", "blossom", "jungle", "savanna", "tundra", "city", "beach"];
  check("every cup race biome is a real biome name",
    CUPS.every((c) => c.races.every((r) => r.cfg.biomes.every((b) => KNOWN_BIOMES.includes(b)))));
  const THEMES = { meadows: ["meadow", "blossom", "forest", "jungle"], sandypaws: ["desert", "savanna", "mesa"], meowtain: ["forest", "alpine", "tundra"] };
  check("themed cups stay inside their biome family",
    Object.entries(THEMES).every(([id, fam]) => CUPS.find((c) => c.id === id).races.every((r) => r.cfg.biomes.every((b) => fam.includes(b)))));
  check("the midnight finale races mostly after dark",
    CUPS.find((c) => c.id === "zoomies").races.filter((r) => r.cfg.timeOfDay === "night").length >= 3);
  check("points ladder: 1st 10 … 6th 3, 7th+ 1", cupPoints(1) === 10 && cupPoints(6) === 3 && cupPoints(9) === 1);
  const standings = cupStandings({ You: 24, Mittens: 24, Whiskers: 8 });
  check("standings sort by points, name-tiebreak stable", standings[0].name === "Mittens" && standings[1].name === "You" && standings[2].name === "Whiskers");

  const p = defaultProfile();
  const won = awardCup(p, "meadows", cupStandings({ You: 28, Mittens: 20 }), "You", "medium");
  check("first cup win pays treats + trophy + exclusive", won && won.firstWin && p.treats === 200 && p.trophies.meadows === "medium" && p.unlocked.includes("kart.7"));
  check("medium win grants the Medium+ prize but not the Hard one",
    won.extraUnlocks.includes("cat.12") && p.unlocked.includes("cat.12") && !p.unlocked.includes("cat.13"));
  const again = awardCup(p, "meadows", cupStandings({ You: 28, Mittens: 20 }), "You", "hard");
  check("re-win upgrades the trophy but doesn't re-pay", again && !again.firstWin && again.upgraded && p.trophies.meadows === "hard" && p.treats === 200);
  check("a hard re-win still unlocks the Hard prize (once)",
    again.extraUnlocks.includes("cat.13") && p.unlocked.includes("cat.13") &&
    (awardCup(p, "meadows", cupStandings({ You: 28, Mittens: 20 }), "You", "hard").extraUnlocks.length === 0));
  const down = awardCup(p, "meadows", cupStandings({ You: 28, Mittens: 20 }), "You", "easy");
  check("easier re-win never downgrades the trophy", down && !down.upgraded && p.trophies.meadows === "hard");
  const lost = awardCup(p, "sandypaws", cupStandings({ Mittens: 30, You: 20 }), "You", "hard");
  check("losing the cup awards nothing", lost === null && !p.trophies.sandypaws);
}

// --- Daily seed ---
{
  const a = dailySeedFor("2026-07-17"), b = dailySeedFor("2026-07-17"), c = dailySeedFor("2026-07-18");
  check("daily seed is deterministic per day and differs across days", a === b && a !== c && /^[A-Z2-9]{4}$/.test(a));
}

// --- Backup token ---
{
  const p = defaultProfile();
  p.treats = 1234; p.stats.races = 9; p.trophies.tuna = "hard"; p.unlocked.push("cat.5");
  p.customName = "Mr. Wiggles 🐱"; // unicode survives
  const tok = encodeProfileToken(p);
  check("token has the ZP1 envelope", /^ZP1\.[A-Za-z0-9_-]+$/.test(tok));
  const back = decodeProfileToken(tok);
  check("round trip restores treats/stats/trophies/unlocks/unicode",
    back && back.treats === 1234 && back.stats.races === 9 && back.trophies.tuna === "hard" && back.unlocked.includes("cat.5") && back.customName === "Mr. Wiggles 🐱");
  check("garbage tokens are rejected", decodeProfileToken("ZP1.!!!") === null && decodeProfileToken("hello") === null && decodeProfileToken(null) === null);
}

console.log(failures ? `\n${failures} progress check(s) FAILED` : "\nall progress checks passed");
process.exit(failures ? 1 : 0);
