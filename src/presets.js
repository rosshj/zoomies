// Garage presets — the named cats and karts the player picks from (and the
// Cat-alog sells). Pure data, no THREE: shared by main.js (garage, roster,
// prizes) and by tools/catalog-shots.mjs, which renders each preset in the
// asset viewer to produce the Cat-alog's prize thumbnails.

// Nine distinct breeds, each a different markings template (not just a recolour
// of the same one): see createCat for how each pattern is drawn.
export const CAT_PRESETS = [
  { name: "Marmalade", fur: 0xf0a830, pattern: "spotted" }, // ginger spotted tabby
  { name: "Smokey", fur: 0x8c9298, pattern: "solid" }, // plush solid grey (Russian Blue)
  { name: "Shadow", fur: 0x2a2a2a, pattern: "tuxedo" }, // black & white tuxedo
  { name: "Snow", fur: 0xfbfbfb, pattern: "snowshoe" }, // white + seal mask/points
  { name: "Whiskey", fur: 0xc8966a, pattern: "tabby" }, // classic brown mackerel tabby
  { name: "Nelson", fur: 0x4a3328, pattern: "mitted" }, // brown, white chest + socks
  { name: "Pickle", fur: 0xf3dcb6, pattern: "point" }, // seal-point Siamese
  { name: "Patches", fur: 0xf5ead6, pattern: "calico" }, // tricolour calico (cream + ginger + black), collar & bell
  { name: "Pepper", fur: 0x9aa2a8, pattern: "tabby" }, // cool silver mackerel tabby
  { name: "Cocoa", fur: 0x5a3b2a, pattern: "tortie" }, // mottled tortoiseshell (ginger + black, no white)
];

// Each kart: a colour, a body silhouette (style 0=GP / 1=roadster / 2=buggy /
// 3=finned speedster), and a racing number stamped on the side roundels.
export const KART_PRESETS = [
  { name: "Ember", color: 0xe53935, style: 0, number: 5 },
  { name: "Lagoon", color: 0x1e88e5, style: 1, number: 7 },
  { name: "Clover", color: 0x43a047, style: 2, number: 3 },
  { name: "Tangerine", color: 0xfb8c00, style: 0, number: 9 },
  { name: "Grape", color: 0x8e24aa, style: 1, number: 4 },
  { name: "Sunbeam", color: 0xfdd835, style: 2, number: 1 },
  { name: "Teal", color: 0x00897b, style: 0, number: 8 },
  { name: "Comet", color: 0x26c6da, style: 3, number: 2 }, // jet-age finned speedster
  { name: "Nova", color: 0xec407a, style: 3, number: 6 },
];

// What the creators open with (also the look the Cat-alog uses to advertise them).
export const DEFAULT_CUSTOM_CAT = { name: "My Cat", fur: 0xf0a830, pattern: "spotted", accessory: "cap", accessoryColor: null };
export const DEFAULT_CUSTOM_KART = { name: "My Kart", color: 0xe53935, style: 0, number: 0 };
