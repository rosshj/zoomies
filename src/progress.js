// Player progression — treats (currency), unlocks, achievements, tournament cups,
// the daily seed, and the backup token. PURE and dependency-free so the whole
// economy unit-tests in node (tools/progress-check.mjs); main.js owns storage,
// DOM, and race-stat collection and calls into here.
//
// Design rules (docs/gameplay-backlog.md has the discussion):
// - Never gate power: everything here is cosmetic / content, equal in every race.
// - Unlocks are string IDs in a versioned profile; new content ships locked by
//   default, unknown IDs are tolerated, fields are only ever added with defaults —
//   so a saved profile survives every future feature.
// - Three lanes: treats buy the catalog; cup trophies award exclusives that money
//   can't buy; (a future paid lane would sit beside these, never above them).

export const PROFILE_VERSION = 1;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// Stats are CUMULATIVE career counters — achievements are thresholds over these,
// which is far more robust than per-race predicates.
export function defaultStats() {
  return {
    races: 0, wins: 0, winsHard: 0, winsNight: 0, racesCustom: 0,
    driftBoosts: 0, slipSeconds: 0, milkTrips: 0, heartSaves: 0,
    boxes: 0, dailies: 0, treatsEarned: 0,
  };
}

export function defaultProfile() {
  return {
    v: PROFILE_VERSION,
    treats: 0,
    unlocked: [...STARTER_UNLOCKS],
    trophies: {}, // cupId -> best difficulty won ("easy" | "medium" | "hard" | "expert")
    achievements: [], // earned achievement ids
    pendingClaims: [], // earned badges whose treats wait for the player's CLAIM tap
    stats: defaultStats(),
    dailyPaid: "", // last YYYY-MM-DD the daily bonus was paid
  };
}

// Coerce anything (missing, old, hand-edited) into a valid current profile.
// Additive-only philosophy: keep unknown top-level fields so a profile written by
// a NEWER build survives a round-trip through this one.
export function migrateProfile(raw) {
  const p = raw && typeof raw === "object" ? { ...raw } : {};
  const d = defaultProfile();
  p.v = PROFILE_VERSION;
  p.treats = Number.isFinite(p.treats) && p.treats >= 0 ? Math.floor(p.treats) : d.treats;
  p.unlocked = Array.isArray(p.unlocked) ? [...new Set(p.unlocked.filter((x) => typeof x === "string"))] : [...d.unlocked];
  for (const id of STARTER_UNLOCKS) if (!p.unlocked.includes(id)) p.unlocked.push(id);
  p.trophies = p.trophies && typeof p.trophies === "object" ? { ...p.trophies } : {};
  p.achievements = Array.isArray(p.achievements) ? [...new Set(p.achievements.filter((x) => typeof x === "string"))] : [];
  // Pending claims must reference earned achievements (drop anything orphaned).
  p.pendingClaims = Array.isArray(p.pendingClaims)
    ? [...new Set(p.pendingClaims.filter((x) => typeof x === "string" && p.achievements.includes(x)))]
    : [];
  const s = p.stats && typeof p.stats === "object" ? p.stats : {};
  p.stats = { ...defaultStats() };
  for (const k of Object.keys(p.stats)) if (Number.isFinite(s[k]) && s[k] >= 0) p.stats[k] = s[k];
  p.dailyPaid = typeof p.dailyPaid === "string" ? p.dailyPaid : "";
  return p;
}

// ---------------------------------------------------------------------------
// Unlock catalog — string IDs against the garage presets in main.js.
// price: treats cost. cup: exclusive, only awarded by winning that cup.
// ---------------------------------------------------------------------------

export const STARTER_UNLOCKS = ["cat.0", "cat.1", "cat.2", "kart.0", "kart.1", "kart.2"];

// Price ladder: a PROGRESSIVE climb totalling ~2,400 treats (was 4,800) — the
// cheapest cats/karts land after a couple of races (100-150), the top of each
// column is a ~400 goal, and the creators sit at 250 each so designing your own
// racer is an early-mid milestone rather than an end-game grind. Cup and
// difficulty exclusives are unchanged (money can't buy them).
export const CATALOG = [
  // Cats (indices into CAT_PRESETS). First three are the free starter set.
  { id: "cat.0", price: 0 }, { id: "cat.1", price: 0 }, { id: "cat.2", price: 0 },
  { id: "cat.3", price: 100 }, { id: "cat.4", price: 100 }, { id: "cat.5", price: 120 },
  { id: "cat.6", price: 140 }, { id: "cat.7", price: 180 },
  { id: "cat.8", cup: "sandypaws" }, // Pepper — Sandy Paws Cup exclusive
  { id: "cat.9", cup: "zoomies" },   // Cocoa — Midnight Zoomies Cup exclusive
  { id: "cat.10", price: 220 },      // Ziggy — golden bengal (rosettes)
  { id: "cat.11", price: 400 },      // Moo — the cow cat
  { id: "cat.12", diff: "medium" },  // Misty — win any cup on Medium or harder
  { id: "cat.13", diff: "hard" },    // Biscuit — win any cup on Hard (or Expert)
  // Karts.
  { id: "kart.0", price: 0 }, { id: "kart.1", price: 0 }, { id: "kart.2", price: 0 },
  { id: "kart.3", price: 100 }, { id: "kart.4", price: 100 }, { id: "kart.5", price: 120 },
  { id: "kart.6", price: 150 },
  { id: "kart.7", cup: "meadows" },  // Comet — Catnip Meadows Cup exclusive
  { id: "kart.8", cup: "meowtain" }, // Nova — Meowtain Cup exclusive
  { id: "kart.9", price: 250 },      // Prowler — the caged off-road buggy
  // (Accessories carry no catalog entries: the whole wardrobe comes with the
  // Custom Cat creator. Old profiles may still hold acc.* ids — harmless.)
  // The custom creators are features you earn — early-mid milestones.
  { id: "custom.cat", price: 250 },
  { id: "custom.kart", price: 250 },
];
const _catalogById = new Map(CATALOG.map((c) => [c.id, c]));

export function catalogEntry(id) { return _catalogById.get(id) || null; }
export function isUnlocked(profile, id) {
  const e = _catalogById.get(id);
  if (!e) return true; // unknown ids never brick a save (forward compatibility)
  return profile.unlocked.includes(id);
}
// Spend treats on a purchasable entry. Returns true and mutates the profile on
// success; false (no mutation) if locked-by-cup, unknown, already owned, or broke.
export function buyUnlock(profile, id) {
  const e = _catalogById.get(id);
  if (!e || typeof e.price !== "number" || e.price < 0) return false;
  if (profile.unlocked.includes(id)) return false;
  if (profile.treats < e.price) return false;
  profile.treats -= e.price;
  profile.unlocked.push(id);
  return true;
}

// ---------------------------------------------------------------------------
// Race payout — treats earned for a finished race, itemized for the results
// screen. `stats` is the per-race moment counters collected by main.js.
// ---------------------------------------------------------------------------

export const DIFF_MULT = { easy: 0.6, medium: 0.8, hard: 1.0, expert: 1.15 };

export function racePayout({ place, field, laps, difficulty, daily = false, stats = {} }) {
  const lines = [];
  const mult = DIFF_MULT[difficulty] ?? 1.0;
  const lapScale = Math.max(1, laps || 3) / 3;
  // Placement: 6th of 6 earns 15, 1st earns 50 (before the win bonus).
  const base = Math.round((15 + Math.max(0, (field || 6) - (place || 6)) * 7) * mult * lapScale);
  lines.push({ label: `${ordinalish(place)} place`, amt: base });
  if (place === 1) lines.push({ label: "Winner bonus", amt: Math.round(20 * mult) });
  // Moments (capped so farming a single mechanic doesn't out-earn racing).
  const drift = Math.min(20, Math.round((stats.driftBoosts || 0) * 2));
  if (drift > 0) lines.push({ label: "Drift boosts", amt: drift });
  const slip = Math.min(15, Math.round(stats.slipSeconds || 0));
  if (slip > 0) lines.push({ label: "Slipstreaming", amt: slip });
  const milk = Math.min(25, (stats.milkTrips || 0) * 5);
  if (milk > 0) lines.push({ label: "Milk mischief", amt: milk });
  const saves = Math.min(9, (stats.heartSaves || 0) * 3);
  if (saves > 0) lines.push({ label: "Nine lives", amt: saves });
  if (daily) lines.push({ label: "Daily challenge", amt: 100 });
  const total = lines.reduce((s, l) => s + l.amt, 0);
  return { total, lines };
}

function ordinalish(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------------------------------------------------------------------
// Achievements — thresholds over the cumulative profile stats. checkAchievements
// marks + pays newly earned ones and returns them for the toast/ceremony.
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  { id: "first-race", name: "Out of the Cat Door", desc: "Finish your first race", pay: 50, test: (s, p) => s.races >= 1 },
  { id: "first-win", name: "Top Cat", desc: "Win a race", pay: 100, test: (s) => s.wins >= 1 },
  { id: "hard-win", name: "Apex Predator", desc: "Win against Hard rivals", pay: 150, test: (s) => s.winsHard >= 1 },
  { id: "night-win", name: "Night Prowler", desc: "Win a race at night", pay: 100, test: (s) => s.winsNight >= 1 },
  { id: "veteran", name: "Road Cat", desc: "Finish 25 races", pay: 200, test: (s) => s.races >= 25 },
  { id: "drift-50", name: "Sideways Cat", desc: "Earn 50 drift boosts", pay: 100, test: (s) => s.driftBoosts >= 50 },
  { id: "slip-120", name: "Draft Dodger", desc: "Slipstream for 2 minutes total", pay: 100, test: (s) => s.slipSeconds >= 120 },
  { id: "milk-10", name: "Cry Over Spilled Milk", desc: "Trip 10 rivals with milk", pay: 100, test: (s) => s.milkTrips >= 10 },
  { id: "lives-5", name: "Lands on Its Feet", desc: "Get saved by 5 hearts", pay: 100, test: (s) => s.heartSaves >= 5 },
  { id: "boxes-50", name: "Box Enthusiast", desc: "Open 50 power-up boxes", pay: 75, test: (s) => s.boxes >= 50 },
  { id: "daily-5", name: "Regular", desc: "Finish 5 daily challenges", pay: 150, test: (s) => s.dailies >= 5 },
  { id: "custom-race", name: "Trailblazer", desc: "Race a track you generated", pay: 50, test: (s) => s.racesCustom >= 1 },
  { id: "cup-first", name: "Silverware", desc: "Win any cup", pay: 150, test: (s, p) => Object.keys(p.trophies).length >= 1 },
  { id: "cup-sweep", name: "Cat-egory Champion", desc: "Win all four cups", pay: 400, test: (s, p) => CUPS.every((c) => p.trophies[c.id]) },
];

// Mark newly earned badges. The treats are NOT paid here — each badge waits in
// profile.pendingClaims for the player's CLAIM tap (claimAchievement), so the
// reward is a moment, not a line item. Pending claims survive reloads and are
// also claimable from the Cat-alog badge list.
export function checkAchievements(profile) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (profile.achievements.includes(a.id)) continue;
    let hit = false;
    try { hit = !!a.test(profile.stats, profile); } catch { hit = false; }
    if (hit) {
      profile.achievements.push(a.id);
      profile.pendingClaims.push(a.id);
      fresh.push(a);
    }
  }
  return fresh;
}

// The CLAIM tap: pays the badge's treats exactly once. Returns the achievement
// paid, or null if it wasn't pending (already claimed / never earned).
export function claimAchievement(profile, id) {
  const i = profile.pendingClaims.indexOf(id);
  if (i < 0) return null;
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) return null;
  profile.pendingClaims.splice(i, 1);
  profile.treats += a.pay;
  profile.stats.treatsEarned += a.pay;
  return a;
}

// ---------------------------------------------------------------------------
// Tournament cups — a cup is a named series of seeded races; classic kart-racer
// points per race; win the cup for treats, a trophy (best difficulty is kept)
// and, on some cups, an exclusive unlock money can't buy.
// ---------------------------------------------------------------------------

export const CUP_POINTS = [10, 8, 6, 5, 4, 3]; // 7th+ scores 1
export function cupPoints(place) { return CUP_POINTS[place - 1] ?? 1; }

// Each cup race is a FULL generated world (mode custom + knobs + biomes + time of
// day), so the series has genuinely distinct track layouts — previewable on the
// menu map — and every player races identical cup tracks regardless of their own
// saved track settings. The cfg shape matches the track creator's.
const R = (seed, size, curviness, hilliness, hills, twist, biomes, timeOfDay) =>
  ({ seed, cfg: { mode: "custom", seed, size, curviness, hilliness, hills, twist, biomes, timeOfDay } });
// Every cup owns a THEME — its races stay inside one family of biomes, so the
// series reads as a place (lush greens, arid dunes, snowy peaks, city nights)
// and the name tells you where you're going.
export const CUPS = [
  { id: "meadows", name: "Catnip Meadows Cup", emoji: "🌿", desc: "Lush and laid-back — rolling greens, cherry blossoms, and a jungle romp",
    winTreats: 200, unlockId: "kart.7", races: [
      R("MDW1", 0.4, 0.35, 0.3, 0.3, 0.3, ["meadow", "blossom"], "midday"),
      R("MDW2", 0.45, 0.45, 0.35, 0.4, 0.35, ["forest", "meadow"], "midday"),
      R("MDW3", 0.5, 0.5, 0.4, 0.45, 0.4, ["jungle", "blossom"], "sunset"),
    ] },
  { id: "sandypaws", name: "Sandy Paws Cup", emoji: "🏜️", desc: "Hot laps around the world's biggest litter box — dunes, savanna, red mesa",
    winTreats: 250, unlockId: "cat.8", races: [
      R("SND1", 0.5, 0.5, 0.4, 0.4, 0.45, ["desert", "savanna"], "midday"),
      R("SND2", 0.55, 0.6, 0.45, 0.5, 0.5, ["savanna", "mesa"], "sunset"),
      R("SND3", 0.6, 0.55, 0.5, 0.55, 0.55, ["mesa", "desert"], "midday"),
    ] },
  { id: "meowtain", name: "Meowtain Cup", emoji: "🏔️", desc: "Steep climbs and snowy switchbacks, way up where the big cats prowl",
    winTreats: 300, unlockId: "kart.8", races: [
      R("MTN1", 0.55, 0.6, 0.65, 0.7, 0.55, ["forest", "alpine"], "midday"),
      R("MTN2", 0.6, 0.65, 0.75, 0.8, 0.6, ["alpine", "tundra"], "sunset"),
      R("MTN3", 0.6, 0.7, 0.85, 0.85, 0.65, ["tundra", "alpine"], "night"),
    ] },
  { id: "zoomies", name: "Midnight Zoomies Cup", emoji: "⚡", desc: "The 3am championship — four races after dark. No mercy",
    winTreats: 400, unlockId: "cat.9", races: [
      R("ZOM1", 0.6, 0.6, 0.55, 0.55, 0.55, ["beach", "city"], "sunset"),
      R("ZOM2", 0.65, 0.7, 0.6, 0.65, 0.65, ["autumn", "forest"], "night"),
      R("ZOM3", 0.65, 0.75, 0.7, 0.7, 0.7, ["mesa", "savanna"], "night"),
      R("ZOM4", 0.7, 0.8, 0.65, 0.7, 0.75, ["city", "desert"], "night"),
    ] },
];
const _cupById = new Map(CUPS.map((c) => [c.id, c]));
export function cupById(id) { return _cupById.get(id) || null; }

// Standings: points map (name -> pts) sorted descending, ties broken by name so
// every client renders the same order.
export function cupStandings(points) {
  return Object.entries(points)
    .map(([name, pts]) => ({ name, pts }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
}

// Did the player win the cup, and is the new trophy an upgrade? Trophy records
// the best DIFFICULTY the cup was won at (expert > hard > medium > easy). The
// "hard" prizes unlock on Expert too — it's harder, not a separate lane.
const DIFF_RANK = { easy: 0, medium: 1, hard: 2, expert: 3 };
export function awardCup(profile, cupId, standings, playerName, difficulty) {
  const winner = standings[0];
  if (!winner || winner.name !== playerName) return null;
  const cup = _cupById.get(cupId);
  if (!cup) return null;
  const prev = profile.trophies[cupId];
  const upgraded = prev === undefined || (DIFF_RANK[difficulty] ?? 0) > (DIFF_RANK[prev] ?? 0);
  if (upgraded) profile.trophies[cupId] = difficulty;
  const firstWin = prev === undefined;
  let treats = 0, unlockId = null;
  if (firstWin) {
    treats = cup.winTreats;
    profile.treats += treats;
    profile.stats.treatsEarned += treats;
    if (cup.unlockId && !profile.unlocked.includes(cup.unlockId)) {
      profile.unlocked.push(cup.unlockId);
      unlockId = cup.unlockId;
    }
  }
  // A cup can have MORE catalog exclusives beyond its headline unlockId (e.g.
  // its accessory prize) — they ride along on the first win, reported via
  // extraUnlocks so the results screen lists every prize.
  const extraUnlocks = [];
  if (firstWin) {
    for (const e of CATALOG) {
      if (e.cup === cupId && e.id !== cup.unlockId && !profile.unlocked.includes(e.id)) {
        profile.unlocked.push(e.id);
        extraUnlocks.push(e.id);
      }
    }
  }
  // Difficulty-gated prizes: catalog entries with `diff` unlock for winning ANY
  // cup at that difficulty or harder. Checked on every win (not just the first),
  // so re-winning an old cup on a harder setting still pays out the prize.
  for (const e of CATALOG) {
    if (!e.diff || profile.unlocked.includes(e.id)) continue;
    if ((DIFF_RANK[difficulty] ?? 0) >= (DIFF_RANK[e.diff] ?? 99)) {
      profile.unlocked.push(e.id);
      extraUnlocks.push(e.id);
    }
  }
  return { firstWin, upgraded, treats, unlockId, extraUnlocks, difficulty };
}

// ---------------------------------------------------------------------------
// Daily challenge — everyone races the same generated seed each day.
// ---------------------------------------------------------------------------

export function dailySeedFor(dateStr) {
  // djb2 over the YYYY-MM-DD string -> 4 chars of A-Z0-9 (the room-code alphabet).
  let h = 5381;
  for (let i = 0; i < dateStr.length; i++) h = ((h << 5) + h + dateStr.charCodeAt(i)) >>> 0;
  const AB = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L look-alikes
  let s = "";
  for (let i = 0; i < 4; i++) { s += AB[h % AB.length]; h = Math.floor(h / AB.length) ^ (h << 7); h = h >>> 0; }
  return s;
}

// ---------------------------------------------------------------------------
// Backup token — the whole profile as a compact copy-paste code (same base64url
// idea as the cup's encoded-world token, but unicode-safe for custom names).
// ---------------------------------------------------------------------------

export function encodeProfileToken(profile) {
  try {
    const json = JSON.stringify(profile);
    const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(json) : Buffer.from(json, "utf8");
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return "ZP1." + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch { return ""; }
}

export function decodeProfileToken(token) {
  if (typeof token !== "string") return null;
  const m = token.trim().match(/^ZP1\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = typeof TextDecoder !== "undefined" ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("utf8");
    const raw = JSON.parse(json);
    return raw && typeof raw === "object" ? migrateProfile(raw) : null;
  } catch { return null; }
}
