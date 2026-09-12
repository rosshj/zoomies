// The Atlas — Zoomies' world map. Every cell (cx, cy) of an integer grid is a
// place: a seeded track recipe (archetype + knobs + biomes + time + weather +
// headline set piece) and a resident cat or kart grown from the same cell.
// PURE and dependency-free apart from the seeded RNG + genome, so main.js, the
// node checks and the track audit all agree on what lives where, and a friend
// with the same build grows the identical world at the same address — no
// server needed.
//
// Geography comes from a few smoothed noise fields over the grid (temperature,
// wetness, urbanity, relief), so neighbouring cells resemble each other and
// continents emerge: a desert belt, a snowy north, a coastal strip, a city
// cluster. Cells further from the origin race harder rivals.
import { makeRng } from "./rng.js";
import { catGenome, kartGenome } from "./genome.js";

export const ATLAS_RADIUS = 14; // the map spans (-R..R)² cells
export const ATLAS_START = [0, 0];

// ---------------------------------------------------------------------------
// Lattice value noise: a hash per lattice node, cosine-interpolated. `scale`
// is the lattice pitch in cells — regions come out roughly that wide.
// ---------------------------------------------------------------------------
function hash2(ix, iy, salt) {
  let h = (ix * 374761393 + iy * 668265263 + salt * 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, salt, scale) {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = 0.5 - 0.5 * Math.cos(tx * Math.PI), sy = 0.5 - 0.5 * Math.cos(ty * Math.PI);
  const a = hash2(ix, iy, salt), b = hash2(ix + 1, iy, salt), c = hash2(ix, iy + 1, salt), d = hash2(ix + 1, iy + 1, salt);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
// Two octaves so regions have edges that wander.
function field(x, y, salt) {
  return 0.7 * vnoise(x, y, salt, 5.5) + 0.3 * vnoise(x + 31, y - 17, salt + 7, 2.4);
}

export function cellKey(cx, cy) { return `${cx},${cy}`; }
export function cellSeed(cx, cy) {
  // Seeds are uppercased by main.js; keep them letter/digit/underscore/minus.
  return `A${cx}_${cy}`.replace("-", "M").replace("-", "M"); // "A3_M2" = (3,-2)
}
export function parseCellKey(key) {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(key || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ---------------------------------------------------------------------------
// Region → biomes. The fields decide a family; the cell's own RNG picks the
// second biome from the same family so the world stays coherent.
// ---------------------------------------------------------------------------
function biomesFor(temp, wet, urban, r) {
  if (urban > 0.7) return r() < 0.5 ? ["city"] : ["city", temp > 0.6 ? "beach" : "meadow"];
  if (temp < 0.3) {
    const main = wet > 0.5 ? "alpine" : "tundra";
    const second = r() < 0.5 ? (main === "alpine" ? "tundra" : "alpine") : wet > 0.5 ? "forest" : "meadow";
    return r() < 0.35 ? [main] : [main, second];
  }
  if (temp > 0.68) {
    if (wet < 0.38) return r() < 0.4 ? ["desert"] : ["desert", r() < 0.5 ? "mesa" : "savanna"];
    if (wet < 0.62) return r() < 0.5 ? ["mesa", "savanna"] : ["savanna", r() < 0.5 ? "desert" : "meadow"];
    return r() < 0.5 ? ["beach", "jungle"] : r() < 0.5 ? ["jungle"] : ["beach", "savanna"];
  }
  // Temperate belt.
  if (wet < 0.35) return r() < 0.5 ? ["meadow", "savanna"] : ["meadow"];
  if (wet < 0.62) return [["meadow", "autumn", "blossom"][Math.floor(r() * 3)], ["forest", "meadow", "blossom"][Math.floor(r() * 3)]].filter((b, i, a) => a.indexOf(b) === i);
  return r() < 0.5 ? ["forest", "autumn"] : r() < 0.5 ? ["forest"] : ["forest", "jungle"];
}

// Which set pieces a biome list can host (mirrors features.js KIND_SPECS).
const HEADLINE_BIOMES = {
  causeway: ["beach"], tunnel: ["alpine", "desert", "tundra", "mesa"], dam: ["alpine", "forest"], overpass: ["city"],
  canyon: ["desert", "alpine", "tundra", "mesa"], shelf: ["alpine", "desert", "savanna", "mesa"], giant: ["forest", "jungle"],
  bridge: ["meadow", "autumn", "blossom", "savanna", "tundra", "beach", "forest", "jungle"],
};
// Archetype knob ranges: where each personality lives in the slider space.
const ARCH_KNOBS = {
  classic:  { size: [0.4, 0.65], curviness: [0.4, 0.6], twist: [0.2, 0.5], hilliness: [0.25, 0.55], hills: [0.35, 0.6] },
  speedway: { size: [0.55, 0.85], curviness: [0.15, 0.32], twist: [0, 0], hilliness: [0.05, 0.3], hills: [0.2, 0.4] },
  street:   { size: [0.3, 0.5], curviness: [0.7, 0.95], twist: [0, 0], hilliness: [0.1, 0.35], hills: [0.4, 0.7] },
  mountain: { size: [0.5, 0.75], curviness: [0.5, 0.7], twist: [0, 0], hilliness: [0.7, 0.95], hills: [0.4, 0.7] },
  coastal:  { size: [0.5, 0.75], curviness: [0.35, 0.55], twist: [0, 0], hilliness: [0.15, 0.4], hills: [0.3, 0.5] },
  rally:    { size: [0.4, 0.65], curviness: [0.65, 0.9], twist: [0, 0], hilliness: [0.45, 0.75], hills: [0.6, 0.9] },
  figure8:  { size: [0.5, 0.75], curviness: [0.35, 0.55], twist: [0.85, 1], hilliness: [0.2, 0.45], hills: [0.3, 0.5] },
};
const rng01 = (r, [lo, hi]) => +(lo + (hi - lo) * r()).toFixed(2);

// The track recipe for a cell — the same shape the track maker produces, plus
// the atlas-only fields (archetype, headline, weather, cell, tier).
export function cellConfig(cx, cy) {
  const r = makeRng(`atlas|${cx},${cy}`);
  const temp = field(cx, cy, 1);
  const wet = field(cx, cy, 2);
  const urban = field(cx, cy, 3);
  const relief = field(cx, cy, 4);
  const biomes = biomesFor(temp, wet, urban, r);
  const primary = biomes[0];
  // Archetype from the land: relief → mountain, city → street, hot flats →
  // speedway, shores → coastal, woods → rally; the rest split classic/figure8.
  let archetype;
  const roll = r();
  if (relief > 0.68 && roll < 0.7) archetype = "mountain";
  else if (primary === "city") archetype = roll < 0.65 ? "street" : "classic";
  else if ((primary === "desert" || primary === "savanna" || primary === "mesa") && relief < 0.45 && roll < 0.55) archetype = "speedway";
  else if ((primary === "beach" || biomes.includes("beach")) && roll < 0.6) archetype = "coastal";
  else if ((primary === "forest" || primary === "autumn" || primary === "jungle") && roll < 0.5) archetype = "rally";
  else archetype = roll < 0.8 ? "classic" : "figure8";
  const kn = ARCH_KNOBS[archetype];
  // Time of day drifts across the map (a night band, a sunset band).
  const todF = field(cx + 200, cy - 200, 5);
  const timeOfDay = todF < 0.3 ? "night" : todF < 0.52 ? "sunset" : "midday";
  const wr = r();
  const weather = wr < 0.66 ? "clear" : wr < 0.8 ? "misty" : wr < 0.92 ? "stormy" : "still";
  // Headline set piece: one the biomes can host, ~70% of cells.
  const hosts = Object.keys(HEADLINE_BIOMES).filter((k) => HEADLINE_BIOMES[k].some((b) => biomes.includes(b)));
  const headline = hosts.length && r() < 0.72 ? hosts[Math.floor(r() * hosts.length)] : null;
  const dist = Math.max(Math.abs(cx), Math.abs(cy));
  // Rival tier by distance from home: the first ring is easy, the rim expert.
  const tier = dist <= 1 ? "easy" : dist <= 4 ? "medium" : dist <= 8 ? "hard" : "expert";
  return {
    mode: "custom", seed: cellSeed(cx, cy), archetype, headline, weather,
    size: rng01(r, kn.size), curviness: rng01(r, kn.curviness), twist: rng01(r, kn.twist),
    hilliness: rng01(r, kn.hilliness), hills: rng01(r, kn.hills),
    biomes, timeOfDay, cell: [cx, cy], tier,
  };
}

// The cell's resident — what winning there hatches. ~72% cats, the rest karts.
export function cellPrize(cx, cy) {
  const cfg = cellConfig(cx, cy);
  const r = makeRng(`prize|${cx},${cy}`);
  const kind = r() < 0.72 ? "cat" : "kart";
  const genome = kind === "cat" ? catGenome(cellSeed(cx, cy), cfg.biomes[0]) : kartGenome(cellSeed(cx, cy), cfg.biomes[0]);
  return { kind, genome, id: genome.id, biome: cfg.biomes[0] };
}
// Regrow a found genome from its stored stub {kind, seed, biome}.
export function regrow(stub) {
  if (!stub || !stub.seed) return null;
  return stub.kind === "kart" ? kartGenome(stub.seed, stub.biome || null) : catGenome(stub.seed, stub.biome || null);
}

// A default name for an unvisited cell — the biome's word + a seeded flourish,
// so the map isn't a grid of "unknown". The real name is trackTitle() once the
// world is built, or whatever the first winner calls it.
const BIOME_WORDS = {
  meadow: ["Buttercup", "Clover", "Long Grass", "Dandelion"], forest: ["Pinecone", "Tall Pines", "Mossy", "Owl Hollow"], alpine: ["Snowcap", "Ridgeback", "Glacier", "High Pass"],
  autumn: ["Maple", "Amber", "Leafpile", "Harvest"], desert: ["Dune", "Scorch", "Sandpaw", "Mirage"], mesa: ["Red Rock", "Canyon", "Hoodoo", "Rust"],
  blossom: ["Petal", "Cherry", "Bloom", "Pink Hill"], jungle: ["Canopy", "Vine", "Monsoon", "Toucan"], savanna: ["Acacia", "Lion Grass", "Dry Wind", "Baobab"],
  tundra: ["Frostbite", "Blizzard", "Iceberg", "Snowdrift"], city: ["Neon", "Downtown", "Alley", "Rooftop"], beach: ["Tuna Cove", "Sandcastle", "Seashell", "Driftwood"],
};
const ARCH_WORDS = { classic: "Circuit", speedway: "Speedway", street: "Streets", mountain: "Pass", coastal: "Coast", rally: "Stage", figure8: "Loop" };
export function cellDefaultName(cx, cy) {
  const cfg = cellConfig(cx, cy);
  const r = makeRng(`name|${cx},${cy}`);
  const words = BIOME_WORDS[cfg.biomes[0]] || ["Zoomies"];
  return `${words[Math.floor(r() * words.length)]} ${ARCH_WORDS[cfg.archetype] || "Run"}`;
}

// ---------------------------------------------------------------------------
// Exploration rules over the profile's atlas record:
//   atlas.cells[key] = { raced, won, name, best }
// Home (0,0) is always open; a cell opens once any 4-neighbour has been RACED
// (finished, any place) so nobody gets stuck; winning names it and hatches
// its resident.
// ---------------------------------------------------------------------------
export function neighbors(cx, cy) {
  return [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
}
export function cellRecord(atlas, cx, cy) {
  return (atlas && atlas.cells && atlas.cells[cellKey(cx, cy)]) || null;
}
export function isCellOpen(atlas, cx, cy) {
  if (Math.max(Math.abs(cx), Math.abs(cy)) > ATLAS_RADIUS) return false;
  if (cx === 0 && cy === 0) return true;
  const rec = cellRecord(atlas, cx, cy);
  if (rec && rec.raced > 0) return true;
  return neighbors(cx, cy).some(([nx, ny]) => { const n = cellRecord(atlas, nx, ny); return n && n.raced > 0; });
}
export function isCellRaced(atlas, cx, cy) { const r = cellRecord(atlas, cx, cy); return !!(r && r.raced > 0); }
export function isCellWon(atlas, cx, cy) { const r = cellRecord(atlas, cx, cy); return !!(r && r.won > 0); }
export function cellDisplayName(atlas, cx, cy) {
  const r = cellRecord(atlas, cx, cy);
  return (r && r.name) || cellDefaultName(cx, cy);
}
// Every cell currently open (the frontier + everything raced): what the map
// draws lit. Bounded by the raced set, so it stays cheap.
export function openCells(atlas) {
  const out = new Map();
  const consider = (x, y) => { if (isCellOpen(atlas, x, y)) out.set(cellKey(x, y), [x, y]); };
  consider(0, 0);
  for (const k of Object.keys((atlas && atlas.cells) || {})) {
    const c = parseCellKey(k);
    if (!c) continue;
    consider(c[0], c[1]);
    for (const [nx, ny] of neighbors(c[0], c[1])) consider(nx, ny);
  }
  return [...out.values()];
}

// Record a finished race on a cell. Returns what the race unlocked:
//   { firstRace, firstWin, prize } — prize is the resident stub on a first win.
export function recordCellRace(atlas, cx, cy, { won, timeMs = null }) {
  atlas.cells = atlas.cells || {};
  atlas.found = atlas.found || [];
  const key = cellKey(cx, cy);
  const rec = atlas.cells[key] || (atlas.cells[key] = { raced: 0, won: 0, name: "", best: null });
  const firstRace = rec.raced === 0;
  rec.raced++;
  const firstWin = won && rec.won === 0;
  if (won) rec.won++;
  if (timeMs != null && (rec.best == null || timeMs < rec.best)) rec.best = timeMs;
  let prize = null;
  if (firstWin) {
    const p = cellPrize(cx, cy);
    const stub = { id: p.id, kind: p.kind, seed: p.genome.seed, biome: p.biome, cell: [cx, cy] };
    if (!atlas.found.some((f) => f.id === stub.id)) atlas.found.push(stub);
    prize = stub;
  }
  return { firstRace, firstWin, prize };
}
export function nameCell(atlas, cx, cy, name) {
  atlas.cells = atlas.cells || {};
  const key = cellKey(cx, cy);
  const rec = atlas.cells[key] || (atlas.cells[key] = { raced: 0, won: 0, name: "", best: null });
  rec.name = String(name || "").trim().slice(0, 24);
  return rec.name;
}
// A friend's address: "41,-17" round-trips through this and parseCellKey.
export function cellAddress(cx, cy) { return `${cx},${cy}`; }
