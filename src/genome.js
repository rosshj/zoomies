// Genomes — every "found" cat and kart in Zoomies is grown from a seed string
// (usually the atlas cell it lives in), the way a world is grown from a track
// seed. PURE and dependency-free apart from the seeded RNG: main.js, models.js,
// progress.js and the node checks all share this one definition, so the same
// seed hatches the same cat on every device — which is what lets a friend's
// "go to 41,-17 for the cat in the propeller beanie" work with no server.
//
// Design: continuous GENES, not a menu. Real cat genetics is already a small
// set of knobs (base colour + dilution, tabby type + density, white-spotting
// grade, colourpoint, tortie mosaic), and combining them continuously yields
// every real cat plus the impossible ones. Body genes and accessory FLAIR add
// the silhouette and the joke. models.js reads the genome; nothing here knows
// about THREE.
import { makeRng } from "./rng.js";

// ---------------------------------------------------------------------------
// Small colour helpers (hex <-> hsl) — kept local so the module stays pure.
// ---------------------------------------------------------------------------
export function hslToHex(h, s, l) {
  h = ((h % 1) + 1) % 1;
  s = clamp01(s); l = clamp01(l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
export function hexToHsl(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return { h, s, l };
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
// Triangular-ish sample between lo..hi biased toward mid (two draws averaged).
const tri = (r, lo, hi) => lo + (hi - lo) * ((r() + r()) / 2);

// ---------------------------------------------------------------------------
// Biome flavour: where a cat is found nudges its genes — tundra cats run pale
// and fluffy, desert cats sandy and ticked, city cats are tuxedos in shades.
// Weights are soft (0..1 pulls), never hard rules, so every biome still
// surprises.
// ---------------------------------------------------------------------------
const BIOME_FLAVOR = {
  meadow:  { hue: 0.08, sat: 0.75, light: 0.6, coat: ["classic", "mackerel", "spotted"], fluff: 0.4, white: 3, acc: ["cap", "flower", "bandana", "collar"] },
  forest:  { hue: 0.07, sat: 0.45, light: 0.35, coat: ["mackerel", "rosette", "classic"], fluff: 0.5, white: 2, acc: ["beanie", "scarf", "fedora", "charm"] },
  alpine:  { hue: 0.6, sat: 0.08, light: 0.8, coat: ["solid", "ticked", "mackerel"], fluff: 0.85, white: 6, acc: ["beanie", "scarf", "aviator", "viking"] },
  autumn:  { hue: 0.06, sat: 0.7, light: 0.45, coat: ["classic", "mackerel", "spotted"], fluff: 0.55, white: 2, tortie: 0.5, acc: ["scarf", "fedora", "beanie", "bow"] },
  desert:  { hue: 0.1, sat: 0.55, light: 0.68, coat: ["ticked", "spotted", "solid"], fluff: 0.15, white: 4, acc: ["cowboy", "sunglasses", "bandana", "aviator"] },
  mesa:    { hue: 0.05, sat: 0.6, light: 0.5, coat: ["ticked", "rosette", "classic"], fluff: 0.2, white: 3, acc: ["cowboy", "bandana", "pirate", "sunglasses"] },
  blossom: { hue: 0.93, sat: 0.35, light: 0.82, coat: ["solid", "spotted", "classic"], fluff: 0.6, white: 7, acc: ["flower", "bow", "crown", "collar"] },
  jungle:  { hue: 0.09, sat: 0.65, light: 0.4, coat: ["rosette", "spotted", "mackerel"], fluff: 0.2, white: 1, acc: ["pirate", "aviator", "charm", "bandana"] },
  savanna: { hue: 0.1, sat: 0.6, light: 0.6, coat: ["ticked", "spotted", "rosette"], fluff: 0.2, white: 2, acc: ["aviator", "sunglasses", "cowboy", "crown"] },
  tundra:  { hue: 0.58, sat: 0.06, light: 0.88, coat: ["solid", "ticked", "mackerel"], fluff: 0.95, white: 8, acc: ["viking", "beanie", "scarf", "headphones"] },
  city:    { hue: 0.62, sat: 0.1, light: 0.18, coat: ["solid", "mackerel", "spotted"], fluff: 0.25, white: 5, acc: ["sunglasses", "headphones", "tophat", "fedora", "helmet"] },
  beach:   { hue: 0.08, sat: 0.8, light: 0.65, coat: ["spotted", "classic", "solid"], fluff: 0.2, white: 4, acc: ["sunglasses", "flower", "party", "charm"] },
};
const ALL_ACC = ["cap", "headphones", "beanie", "flower", "fedora", "sunglasses", "bandana", "collar", "bow", "party", "crown", "pirate", "tophat", "cowboy", "aviator", "helmet", "chef", "wizard", "viking", "scarf", "charm"];
const COAT_TYPES = ["mackerel", "classic", "spotted", "ticked", "rosette", "solid"];
// Extras bolted onto an accessory — the joke. Each names what models.js builds.
export const FLAIR_EXTRAS = ["propeller", "feather", "googly", "sticker", "bell", "antenna", "tinyhat", "sprout"];
export const FLAIR_LABELS = {
  propeller: "propeller", feather: "a feather", googly: "googly eyes", sticker: "a sticker",
  bell: "a bell", antenna: "an antenna", tinyhat: "a tiny hat on the hat", sprout: "a sprout",
};

// ---------------------------------------------------------------------------
// Names + bios — seeded so a cat's name is part of its genome (share the seed,
// share the name). Syllable names keep the pool effectively infinite; the
// curated list makes about a third of cats sound like someone's actual cat.
// ---------------------------------------------------------------------------
const CAT_NAME_POOL = ["Biscuit", "Mochi", "Pumpkin", "Waffles", "Bandit", "Noodle", "Mittens", "Gizmo", "Tofu", "Pixel", "Luna", "Oreo",
  "Peanut", "Nacho", "Boots", "Sushi", "Muffin", "Toffee", "Olive", "Maple", "Sprout", "Truffle", "Widget", "Dumpling",
  "Pretzel", "Crumpet", "Marbles", "Pudding", "Gravy", "Tater", "Meatball", "Jellybean", "Pickles", "Bagel", "Churro", "Cheddar",
  "Ravioli", "Nugget", "Wasabi", "Pancake", "Clementine", "Gnocchi", "Hobbes", "Ziggy", "Figgy", "Tuna", "Salem", "Beans"];
const SYL_A = ["Mo", "Pip", "Zu", "Ki", "Ba", "Ro", "Fi", "Lu", "Ta", "Wo", "Ne", "Ju", "Ka", "Do", "Sni", "Bo", "Po", "Whi", "Flo", "Ma"];
const SYL_B = ["bble", "ppet", "nkin", "sker", "ffle", "zzle", "mbo", "nket", "ckle", "ttle", "boo", "dge", "sh", "ngo", "ppy", "ss", "lla", "mp", "rble", "nut"];
const CAT_TITLES = ["", "", "", "", "", "Sir ", "Lady ", "Captain ", "Professor ", "Little ", "Big ", "Baron ", "Dr. "];
const LIKES = ["the tunnel", "sunbeams", "boxes", "a good nap", "hairballs", "the smell of rain", "tuna Tuesdays", "long straights", "cheese", "puddles",
  "hairpins", "yarn", "the 3am zoomies", "sitting on maps", "birds (from indoors)", "warm laptops", "drifting", "a fast start", "snow", "the ocean"];
const HATES = ["Mondays", "cucumbers", "the vacuum", "being second", "wet paws", "sand in the kart", "loud engines", "bath day", "the vet", "closed doors",
  "slow corners", "wind", "hats (ironically)", "surprises", "being photographed", "early mornings", "the mesa heat", "sharing", "waiting", "brakes"];
const QUIRKS = ["only turns left on purpose", "chirps at the finish line", "sleeps in the kart", "has never lost a staring contest", "knocked the trophy off the shelf once",
  "insists the tail is a spoiler", "purrs on the podium", "won't race without the hat", "counts laps out loud", "hums during pit stops", "hides snacks in the seat",
  "thinks it is a dog", "has a rival it refuses to name", "meows at billboards", "is scared of its own reflection", "always lands on its feet, mostly"];

function catName(r) {
  if (r() < 0.38) return pick(r, CAT_NAME_POOL);
  let n = pick(r, SYL_A) + pick(r, SYL_B);
  if (r() < 0.25) n = pick(r, CAT_TITLES) + n;
  return n.trim();
}
function catBio(r, biome) {
  const where = biome ? BIOME_BIO[biome] || "" : "";
  const forms = [
    () => `Likes ${pick(r, LIKES)}. Hates ${pick(r, HATES)}.`,
    () => `${cap(pick(r, QUIRKS))}. Likes ${pick(r, LIKES)}.`,
    () => `Hates ${pick(r, HATES)}, ${pick(r, QUIRKS)}.`,
    () => `${where}${cap(pick(r, QUIRKS))}.`,
  ];
  return pick(r, forms)();
}
const BIOME_BIO = {
  meadow: "Born in the long grass. ", forest: "Raised under the tall pines. ", alpine: "Came down from the peaks. ", autumn: "Found in a pile of leaves. ",
  desert: "Hatched in the dunes. ", mesa: "A red-rock local. ", blossom: "Napped under the cherry trees. ", jungle: "Swung in from the canopy. ",
  savanna: "Prowled the dry grass. ", tundra: "Fur made for blizzards. ", city: "A downtown alley legend. ", beach: "Sand between the toe beans. ",
};
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Rarity — decided FIRST from the seed so it can push the rest of the genome
// (a legendary gets the odd eyes + the flair + a saturated coat, not just a
// badge). Roughly 1 in 6 rare, 1 in 40 legendary.
// ---------------------------------------------------------------------------
function rollRarity(r) {
  const v = r();
  return v < 0.025 ? "legendary" : v < 0.19 ? "rare" : "common";
}
export const RARITY_LABEL = { common: "", rare: "★ Rare", legendary: "✨ Legendary" };

// ---------------------------------------------------------------------------
// The cat genome.
// ---------------------------------------------------------------------------
export function catGenome(seed, biome = null) {
  const r = makeRng("cat|" + String(seed));
  const fl = BIOME_FLAVOR[biome] || null;
  const rarity = rollRarity(r);
  const wild = rarity === "legendary" ? 1 : rarity === "rare" ? 0.5 : 0.15; // how far off the natural palette

  // --- Coat colour genes. Natural cats live in the orange/brown/grey/black band;
  // the biome pulls the hue/lightness; `wild` lets rare cats drift to lilac,
  // mint or a flat blue that no real cat wears.
  // Hue blends along the SHORT arc of the wheel (a straight lerp from orange
  // toward a cold biome's blue lands on green — the "mint tundra cat" bug).
  let hue = tri(r, 0.02, 0.12);
  if (fl) { let d = fl.hue - hue; d -= Math.round(d); hue = ((hue + d * 0.5) % 1 + 1) % 1; }
  // Cold biomes (tundra, alpine, city) are GREY families: pull saturation hard.
  let sat = fl ? lerp(tri(r, 0.2, 0.85), fl.sat, fl.sat < 0.15 ? 0.88 : 0.6) : tri(r, 0.2, 0.85);
  let light = fl ? lerp(tri(r, 0.18, 0.85), fl.light, 0.6) : tri(r, 0.18, 0.85);
  if (r() < wild * 0.35) { hue = r(); sat = tri(r, 0.25, 0.6); light = tri(r, 0.4, 0.8); } // off-palette coat
  const dilute = r() < 0.3 ? tri(r, 0.3, 0.9) : 0; // dilution washes toward pastel (blue/cream/lilac)
  if (dilute) { sat *= 1 - dilute * 0.5; light = lerp(light, 0.72, dilute * 0.6); }
  let fur = hslToHex(hue, sat, light);
  // Markings colour: darker, a touch more saturated version of the base; very
  // dark coats mark in near-black (a black tabby is "ghost striped").
  const markL = light > 0.35 ? light * lerp(0.45, 0.62, r()) : Math.max(0.04, light * 0.5);
  const stripeColor = hslToHex(hue + (r() - 0.5) * 0.03, Math.min(1, sat * 1.1), markL);

  // --- Tabby type + density. Solid coats are their own type (no marking).
  let coatType = fl && r() < 0.6 ? pick(r, fl.coat) : pick(r, COAT_TYPES);
  if (light < 0.14 && r() < 0.6) coatType = "solid"; // black cats mostly read solid
  const coat = {
    type: coatType,
    density: tri(r, 0.3, 1),   // how many stripes / spots
    wave: tri(r, 0, 1),        // mackerel → wobbly bands; classic → swirl amount
    scale: tri(r, 0.6, 1.4),   // spot / rosette size
    contrast: rarity === "legendary" ? tri(r, 0.7, 1) : tri(r, 0.35, 1),
    stripeColor,
  };
  // --- White spotting: grade 0 (none) .. 10 (nearly all white). Real cats: the
  // white floods from the belly/chest/paws upward — the painter uses the grade.
  let white = 0;
  const wRoll = r();
  if (wRoll < 0.5) white = 0;
  else if (wRoll < 0.85) white = Math.round(tri(r, 1, 6));
  else white = Math.round(tri(r, 6, 10));
  if (fl && r() < 0.35) white = Math.round(lerp(white, fl.white, 0.6));
  if (light > 0.86) white = Math.min(white, 2); // an already-white cat needs no white
  // --- Colourpoint (Siamese): mask + dark extremities on a pale body.
  const point = r() < 0.16 ? tri(r, 0.4, 1) : 0;
  if (point) { light = Math.max(light, 0.7); sat = Math.min(sat, 0.5); fur = hslToHex(hue, sat, light); }
  // --- Tortie mosaic: patches of a second (ginger/cream) colour over the coat.
  const tortie = (fl?.tortie && r() < fl.tortie) || r() < 0.14 ? tri(r, 0.3, 1) : 0;

  // --- Eyes. Coat-linked defaults (pointed → blue, white → odd eyes often) with
  // rares more likely to be odd-eyed.
  const EYE = [0x8bc34a, 0xffb300, 0x4fc3f7, 0x66bb6a, 0xffca28, 0x29b6f6, 0x8d6e63, 0xab47bc];
  let eye = point ? 0x4fc3f7 : pick(r, EYE);
  const oddChance = (white >= 7 ? 0.25 : 0.06) + (rarity === "legendary" ? 0.5 : rarity === "rare" ? 0.15 : 0);
  const odd = r() < oddChance;
  let eye2 = odd ? pick(r, EYE.filter((e) => e !== eye)) : eye;
  const eyes = { color: eye, odd, color2: eye2 };

  // --- Body genes (multipliers on the base model; 1 = the classic cat).
  const fluffBase = fl ? lerp(tri(r, 0, 1), fl.fluff, 0.5) : tri(r, 0, 1);
  const body = {
    ears: +tri(r, 0.78, 1.35).toFixed(3),
    fold: r() < 0.14 ? tri(r, 0.5, 1) : 0,          // Scottish fold
    tail: r() < 0.1 ? tri(r, 0.15, 0.4) : tri(r, 0.75, 1.3), // bobtail / long
    fluff: +fluffBase.toFixed(3),                      // ruff + cheek floof
    chonk: +tri(r, 0.88, 1.22).toFixed(3),             // body width
    face: +tri(r, 0.9, 1.15).toFixed(3),               // head width
    whiskers: +tri(r, 0.7, 1.45).toFixed(3),
    brow: +tri(r, -1, 1).toFixed(3),                   // eye tilt: grumpy ↔ sweet
  };

  // --- Accessory + flair (the joke).
  const accPool = fl && r() < 0.65 ? fl.acc : ALL_ACC;
  const accessory = r() < 0.06 ? "none" : pick(r, accPool);
  const accHue = r(), accSat = tri(r, 0.55, 0.95), accLight = tri(r, 0.35, 0.65);
  const accessoryColor = hslToHex(accHue, accSat, accLight);
  const flairChance = rarity === "legendary" ? 1 : rarity === "rare" ? 0.75 : 0.42;
  const flair = {
    tilt: r() < 0.45 ? +((r() - 0.5) * 0.7).toFixed(3) : 0,   // rad, side lean
    yaw: r() < 0.25 ? +((r() - 0.5) * 0.9).toFixed(3) : 0,    // rad, swivelled
    scale: r() < 0.3 ? +(r() < 0.5 ? tri(r, 0.6, 0.8) : tri(r, 1.2, 1.5)).toFixed(3) : 1, // comically small / huge
    backwards: r() < 0.15,
    extra: accessory !== "none" && r() < flairChance ? pick(r, FLAIR_EXTRAS) : null,
  };
  const shiny = rarity === "legendary" || (rarity === "rare" && r() < 0.3);

  const name = catName(r);
  const bio = catBio(r, biome);
  const g = {
    kind: "cat", v: 1, seed: String(seed), id: "gcat." + String(seed), biome: biome || null,
    name, bio, rarity, shiny,
    fur, dilute: +dilute.toFixed(3), coat, white, point: +point.toFixed(3), tortie: +tortie.toFixed(3),
    eyes, body, accessory, accessoryColor, flair,
  };
  g.pattern = legacyPattern(g);
  return g;
}

// The closest classic pattern id — for anything that still speaks the old
// {fur, pattern, accessory} language (AI recolours, the roster summary line).
export function legacyPattern(g) {
  if (g.point > 0.3) return g.white >= 4 ? "snowshoe" : "point";
  if (g.tortie > 0.3) return g.white >= 4 ? "calico" : "tortie";
  if (g.white >= 8) return "cow";
  if (g.white >= 5) return "tuxedo";
  if (g.white >= 2 && g.coat.type === "solid") return "mitted";
  switch (g.coat.type) {
    case "spotted": return "spotted";
    case "rosette": return "bengal";
    case "solid": return "solid";
    default: return "tabby";
  }
}

// A one-line description of the coat in plain words ("dilute grey classic
// tabby with white socks") — the Cat-alog's caption and the hatch ceremony.
export function describeCat(g) {
  const { l, s, h } = hexToHsl(g.fur);
  let col = s < 0.17 ? (l < 0.2 ? "black" : l < 0.5 ? "grey" : l < 0.85 ? "silver" : "white")
    : h < 0.04 || h > 0.93 ? (l > 0.6 ? "pink" : "russet") : h < 0.13 ? (l > 0.7 ? "cream" : l > 0.45 ? "ginger" : "brown")
    : h < 0.2 ? "golden" : h < 0.45 ? "mint" : h < 0.6 ? "blue" : h < 0.8 ? "lilac" : "rose";
  if (g.dilute > 0.3 && !["white", "cream", "pink"].includes(col)) col = "dilute " + col;
  const type = g.point > 0.3 ? "colourpoint" : g.tortie > 0.3 ? "tortie" : {
    mackerel: "mackerel tabby", classic: "classic tabby", spotted: "spotted tabby", ticked: "ticked tabby", rosette: "rosetted", solid: "",
  }[g.coat.type];
  const white = g.white >= 8 ? "mostly white" : g.white >= 5 ? "with a white bib" : g.white >= 2 ? "with white socks" : "";
  const extras = [];
  if (g.body.fold > 0) extras.push("folded ears");
  if (g.body.tail < 0.5) extras.push("bobtail");
  if (g.body.fluff > 0.75) extras.push("very fluffy");
  if (g.eyes.odd) extras.push("odd-eyed");
  return [col, type, white].filter(Boolean).join(" ") + (extras.length ? " · " + extras.join(", ") : "");
}

// The flair in words for the ceremony ("a backwards cowboy hat with a propeller").
const ACC_WORDS = {
  cap: "cap", headphones: "pair of headphones", beanie: "beanie", flower: "flower", fedora: "fedora", sunglasses: "pair of sunglasses",
  bandana: "bandana", collar: "collar", bow: "bow tie", party: "party hat", crown: "crown", pirate: "pirate hat", tophat: "top hat",
  cowboy: "cowboy hat", aviator: "aviator cap", helmet: "racing helmet", chef: "chef hat", wizard: "wizard hat", viking: "viking helmet", scarf: "scarf", charm: "fish charm",
};
export function describeFlair(g) {
  if (g.accessory === "none") return "no accessory at all";
  const bits = [];
  if (g.flair.backwards) bits.push("backwards");
  if (g.flair.scale < 1) bits.push("tiny");
  if (g.flair.scale > 1) bits.push("oversized");
  if (Math.abs(g.flair.tilt) > 0.2) bits.push("tilted");
  const base = (bits.length ? bits.join(", ") + " " : "") + ACC_WORDS[g.accessory] || g.accessory;
  const art = /^[aeiou]/i.test(base) ? "an " : "a ";
  return art + base + (g.flair.extra ? " with " + FLAIR_LABELS[g.flair.extra] : "");
}

// ---------------------------------------------------------------------------
// The kart genome. Body silhouette is one of the five hand-built styles; the
// BLEND genes stretch it (nose, fins, wheels, ride height) and the livery is
// painted on, so two finned speedsters never look like the same kart.
// ---------------------------------------------------------------------------
export const LIVERY_TYPES = ["none", "stripes", "flames", "checker", "dots", "lightning", "paws"];
export const ORNAMENTS = ["fish", "bell", "star", "antenna", "duck", "horn", "crown"];
const KART_NAME_POOL = ["Bolt", "Zephyr", "Rascal", "Turbo", "Pounce", "Dash", "Rocket", "Maverick", "Blaze", "Whirl", "Nitro", "Vortex",
  "Jet", "Streak", "Zoom", "Rumble", "Thunder", "Flash", "Meteor", "Skitter", "Sprocket", "Piston", "Drifter", "Tornado",
  "Scrambler", "Hornet", "Wombat", "Kestrel", "Comet", "Pebble", "Grumble", "Biscuit Tin", "Sardine", "Moth", "Sprinter", "Snoozer"];
const KART_ADJ = ["Rusty", "Sleek", "Tiny", "Mighty", "Wobbly", "Golden", "Sneaky", "Lucky", "Grumpy", "Fizzy", "Turbo", "Cosmic", "Muddy", "Salty", "Frosty", "Neon"];
const KART_NOUN = ["Sardine", "Pounce", "Hairball", "Whisker", "Furball", "Zoomer", "Biscuit", "Nugget", "Purr", "Paw", "Yowl", "Tuna", "Mouser", "Scratch", "Kitten", "Tabby"];
const KART_BIOME_TRAIT = { alpine: "grippy", tundra: "grippy", forest: "grippy", jungle: "grippy", desert: "zippy", savanna: "zippy", beach: "zippy", city: "zippy", mesa: "zippy" };
export const TRAIT_LABEL = { balanced: "Balanced", grippy: "Grippy · sticks in corners", zippy: "Zippy · quicker on the straights" };

export function kartGenome(seed, biome = null) {
  const r = makeRng("kart|" + String(seed));
  const rarity = rollRarity(r);
  const style = Math.floor(r() * 5);
  // Colour: full hue wheel; rares go two-tone with a real accent.
  const hue = r();
  const color = hslToHex(hue, tri(r, 0.6, 0.95), tri(r, 0.38, 0.6));
  const accentHue = r() < 0.5 ? hue + 0.5 : hue + (r() < 0.5 ? 0.12 : -0.12);
  const accent = r() < 0.2 ? (r() < 0.5 ? 0xf5f5f5 : 0x16181d) : hslToHex(accentHue, tri(r, 0.6, 0.95), tri(r, 0.4, 0.7));
  const blend = {
    nose: +tri(r, 0.82, 1.28).toFixed(3),   // longitudinal stretch of the front
    fin: +tri(r, 0, 1).toFixed(3),          // spoiler / fin height
    wheel: +tri(r, 0.85, 1.22).toFixed(3),  // wheel radius
    ride: +tri(r, -0.06, 0.12).toFixed(3),  // ride height (world units)
    width: +tri(r, 0.92, 1.12).toFixed(3),  // track width
  };
  const liveryType = r() < 0.22 ? "none" : pick(r, LIVERY_TYPES.slice(1));
  const livery = { type: liveryType, color: accent, scale: +tri(r, 0.7, 1.4).toFixed(3) };
  const ornament = r() < (rarity === "common" ? 0.3 : 0.8) ? pick(r, ORNAMENTS) : null;
  const trait = biome && KART_BIOME_TRAIT[biome] && r() < 0.6 ? KART_BIOME_TRAIT[biome] : pick(r, ["balanced", "balanced", "grippy", "zippy"]);
  const number = Math.floor(r() * 100);
  const name = r() < 0.5 ? pick(r, KART_NAME_POOL) : pick(r, KART_ADJ) + " " + pick(r, KART_NOUN);
  const bio = pick(r, [
    () => `Built in ${BIOME_GARAGE[biome] || "a shed"}. ${cap(pick(r, KART_QUIRK))}.`,
    () => `${cap(pick(r, KART_QUIRK))}. ${cap(pick(r, KART_QUIRK))}.`,
  ])();
  const shiny = rarity === "legendary" || (rarity === "rare" && r() < 0.3);
  return {
    kind: "kart", v: 1, seed: String(seed), id: "gkart." + String(seed), biome: biome || null,
    name, bio, rarity, shiny,
    color, accent, style, number, blend, livery, ornament, trait,
  };
}
const BIOME_GARAGE = { meadow: "a barn", forest: "a log cabin", alpine: "a ski hut", autumn: "a leaf pile", desert: "an old gas station", mesa: "a canyon garage",
  blossom: "a teahouse", jungle: "a treehouse", savanna: "a safari camp", tundra: "an igloo", city: "a downtown lock-up", beach: "a surf shack" };
const KART_QUIRK = ["the horn plays a meow", "one wheel squeaks on purpose", "smells faintly of tuna", "the seat is a cushion", "held together with yarn",
  "rattles above 60", "has a secret snack drawer", "the exhaust pops on downshift", "was a lawnmower once", "hums a tune when idling", "the paint is still wet",
  "sponsored by nobody", "only starts after a head-boop", "has never been washed", "faster downhill, somehow", "the number keeps changing"];

export function describeKart(g) {
  const styleName = ["GP", "roadster", "buggy", "finned speedster", "cage buggy"][g.style] || "kart";
  const liv = g.livery.type === "none" ? "" : ` with ${g.livery.type}`;
  const orn = g.ornament ? ` and a ${g.ornament} on the hood` : "";
  return `${styleName}${liv}${orn}`;
}

// Bring a genome (or an old-style preset) to the {fur, pattern, accessory,...}
// shape that every existing garage/roster path understands — the genome rides
// along as `genome` so createCat/createKartModel can read the real thing.
export function catSpecFromGenome(g) {
  return { name: g.name, fur: g.fur, pattern: g.pattern, accessory: g.accessory, accessoryColor: g.accessoryColor, genome: g };
}
export function kartSpecFromGenome(g) {
  return { name: g.name, color: g.color, style: g.style, number: g.number, genome: g };
}

// Hash of everything that moves a VERTEX (body proportions, accessory flair,
// eye tilt) — the merged-geometry caches in models.js key on this so two cats
// with different silhouettes never share one baked body.
export function bodyKey(g) {
  if (!g || g.kind !== "cat") return "";
  const b = g.body, f = g.flair;
  const s = [b.ears, b.fold, b.tail, b.fluff, b.chonk, b.face, b.whiskers, b.brow, f.tilt, f.yaw, f.scale, f.backwards ? 1 : 0, f.extra || "", g.white, g.point, g.eyes.odd ? 1 : 0].join(",");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

// A compact stable hash of the genome's LOOK (not its name/bio) so material and
// texture caches key per distinct appearance rather than per seed.
export function genomeKey(g) {
  if (!g) return "";
  const s = g.kind === "cat"
    ? [g.fur, g.coat.type, g.coat.density.toFixed(2), g.coat.wave.toFixed(2), g.coat.scale.toFixed(2), g.coat.contrast.toFixed(2), g.coat.stripeColor, g.white, g.point.toFixed(2), g.tortie.toFixed(2)].join("|")
    : [g.color, g.accent, g.style, g.livery.type, g.livery.scale].join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}
