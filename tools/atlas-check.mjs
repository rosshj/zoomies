// Atlas + genome checks — pure node, dependency-free (runs in CI).
// Covers: determinism (same seed → same cat / same cell), the region fields
// (neighbouring cells share a family), archetype knob ranges, prize split,
// exploration rules (home open, frontier opens on a raced neighbour), the
// race record + naming, and the profile round trip. Run: node tools/atlas-check.mjs
import { catGenome, kartGenome, describeCat, describeFlair, genomeKey, bodyKey, legacyPattern } from "../src/genome.js";
import {
  ATLAS_RADIUS, cellSeed, cellKey, parseCellKey, cellConfig, cellPrize, regrow, cellDefaultName,
  isCellOpen, openCells, recordCellRace, nameCell, cellDisplayName, neighbors,
} from "../src/atlas.js";
import { defaultProfile, migrateProfile, checkAchievements } from "../src/progress.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

// --- Genomes ---
{
  const a = catGenome("A3_M2", "tundra"), b = catGenome("A3_M2", "tundra"), c = catGenome("A3_M2", "desert");
  check("cat genome is deterministic", JSON.stringify(a) === JSON.stringify(b));
  check("biome changes the cat", JSON.stringify(a) !== JSON.stringify(c));
  check("cat genome carries name, bio, coat, body, flair", a.name && a.bio && a.coat.type && a.body.ears > 0 && a.flair && typeof a.white === "number");
  check("legacy pattern is a known id", ["tabby", "spotted", "calico", "tortie", "bengal", "cow", "tuxedo", "mitted", "solid", "point", "snowshoe"].includes(legacyPattern(a)));
  check("look/body keys are short and stable", genomeKey(a) === genomeKey(b) && bodyKey(a) === bodyKey(b) && genomeKey(a).length < 12);
  check("describeCat / describeFlair produce words", describeCat(a).length > 3 && /^an? /.test(describeFlair(a)) || a.accessory === "none");
  const k = kartGenome("A3_M2", "desert");
  check("kart genome has style, blend, livery, trait", k.style >= 0 && k.style < 5 && k.blend.nose > 0 && k.livery.type && ["balanced", "grippy", "zippy"].includes(k.trait));
  // Rarity distribution over a big sample.
  const tally = { common: 0, rare: 0, legendary: 0 };
  const coats = new Set(), accs = new Set();
  for (let i = 0; i < 3000; i++) { const g = catGenome("R" + i, null); tally[g.rarity]++; coats.add(g.coat.type); accs.add(g.accessory); }
  check("rarity split ≈ 80/16/3 (" + JSON.stringify(tally) + ")", tally.common > 2200 && tally.rare > 300 && tally.legendary > 30 && tally.legendary < 200);
  check("every coat type and most accessories appear", coats.size === 6 && accs.size >= 18);
  // Cold biomes read grey/white, not green.
  let mint = 0;
  for (let i = 0; i < 300; i++) if (/mint|blue|lilac|rose|pink/.test(describeCat(catGenome("T" + i, "tundra")))) mint++;
  check("tundra cats are rarely off-palette (" + mint + "/300)", mint < 60);
}

// --- Cells ---
{
  check("cell seed is URL/uppercase safe", /^[A-Z0-9_]+$/.test(cellSeed(3, -2)) && cellSeed(3, -2) !== cellSeed(-3, 2));
  check("cell key round-trips", parseCellKey(cellKey(-7, 12)).join(",") === "-7,12" && parseCellKey("x") === null);
  const c = cellConfig(0, 0), c2 = cellConfig(0, 0);
  check("cell config is deterministic", JSON.stringify(c) === JSON.stringify(c2));
  check("cell config has the track-maker shape + atlas fields",
    c.mode === "custom" && c.seed && c.biomes.length >= 1 && ["midday", "sunset", "night"].includes(c.timeOfDay)
    && c.archetype && c.weather && Array.isArray(c.cell) && c.tier === "easy");
  check("home is easy, the rim is expert", cellConfig(1, 0).tier === "easy" && cellConfig(12, 3).tier === "expert");
  // Knobs within 0..1 everywhere; archetype + headline plausible.
  let ok = true, archs = new Set(), heads = 0, kinds = { cat: 0, kart: 0 }, same = 0, n = 0;
  for (let x = -ATLAS_RADIUS; x <= ATLAS_RADIUS; x += 2) for (let y = -ATLAS_RADIUS; y <= ATLAS_RADIUS; y += 2) {
    const cc = cellConfig(x, y);
    for (const k of ["size", "curviness", "twist", "hilliness", "hills"]) if (!(cc[k] >= 0 && cc[k] <= 1)) ok = false;
    archs.add(cc.archetype);
    if (cc.headline) heads++;
    kinds[cellPrize(x, y).kind]++;
    // Neighbouring cells share a primary biome most of the time (regions).
    const nb = cellConfig(x + 1, y);
    if (nb.biomes[0] === cc.biomes[0]) same++;
    n++;
  }
  check("every sampled cell has knobs in range", ok);
  check("all seven archetypes appear across the map (" + [...archs].join(",") + ")", archs.size === 7);
  check("most cells carry a headline set piece", heads > n * 0.5);
  check("prizes split cats/karts (" + JSON.stringify(kinds) + ")", kinds.cat > kinds.kart && kinds.kart > n * 0.15);
  check("neighbours usually share a biome family (" + same + "/" + n + ")", same > n * 0.45);
  const p = cellPrize(2, 3);
  check("prize regrows from its stub", JSON.stringify(regrow({ kind: p.kind, seed: p.genome.seed, biome: p.biome })) === JSON.stringify(p.genome));
  check("default cell name is two words", cellDefaultName(4, -4).split(" ").length >= 2);
}

// --- Exploration ---
{
  const prof = defaultProfile();
  const A = prof.atlas;
  check("home is open, its neighbours are not", isCellOpen(A, 0, 0) && !isCellOpen(A, 1, 0) && !isCellOpen(A, 0, -1));
  check("open set starts as just home", openCells(A).length === 1);
  const r1 = recordCellRace(A, 0, 0, { won: false, timeMs: 90000 });
  check("a lost race opens the neighbours, no prize", r1.firstRace && !r1.firstWin && r1.prize === null && neighbors(0, 0).every(([x, y]) => isCellOpen(A, x, y)));
  check("open set is home + 4", openCells(A).length === 5);
  const r2 = recordCellRace(A, 0, 0, { won: true, timeMs: 80000 });
  check("first win hatches the resident", r2.firstWin && r2.prize && r2.prize.id && A.found.length === 1 && A.cells["0,0"].best === 80000);
  const r3 = recordCellRace(A, 0, 0, { won: true });
  check("second win: no second prize", !r3.firstWin && A.found.length === 1);
  check("beyond the rim is never open", !isCellOpen(A, ATLAS_RADIUS + 1, 0));
  nameCell(A, 0, 0, "  Whisker Bend  ");
  check("naming trims and shows", cellDisplayName(A, 0, 0) === "Whisker Bend" && cellDisplayName(A, 1, 0) === cellDefaultName(1, 0));
  // Profile round trip keeps it all.
  const back = migrateProfile(JSON.parse(JSON.stringify(prof)));
  check("atlas survives a profile round trip", back.atlas.cells["0,0"].won === 2 && back.atlas.found[0].id === r2.prize.id && back.atlas.cells["0,0"].name === "Whisker Bend");
  // Explorer badges.
  prof.stats.cellsRaced = 1; prof.stats.found = 1;
  const fresh = checkAchievements(prof).map((a) => a.id);
  check("Off the Map badge fires on the first atlas race", fresh.includes("atlas-first"));
}

console.log(failures ? `\n${failures} FAILED` : "\nall atlas checks passed");
process.exit(failures ? 1 : 0);
