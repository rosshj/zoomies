// Garage presets — the named cats and karts the player picks from (and the
// Cat-alog sells). Pure data, no THREE: shared by main.js (garage, roster,
// prizes) and by tools/catalog-shots.mjs, which renders each preset in the
// asset viewer to produce the Cat-alog's prize thumbnails.

// Nine distinct breeds, each a different markings template (not just a recolour
// of the same one): see createCat for how each pattern is drawn. An `accessory`
// overrides the pattern's default so every named cat wears something DISTINCT
// (three tabbies would otherwise all show up in the same bandana).
export const CAT_PRESETS = [
  { name: "Marmalade", fur: 0xf0a830, pattern: "spotted" }, // ginger spotted tabby · cap
  { name: "Smokey", fur: 0x8c9298, pattern: "solid" }, // plush solid grey (Russian Blue) · headphones
  { name: "Shadow", fur: 0x2a2a2a, pattern: "tuxedo" }, // black & white tuxedo · sunglasses
  { name: "Snow", fur: 0xfbfbfb, pattern: "snowshoe" }, // white + seal mask/points · beanie
  { name: "Whiskey", fur: 0xc8966a, pattern: "tabby", accessory: "cowboy" }, // brown tabby, hat to match the name
  { name: "Nelson", fur: 0x4a3328, pattern: "mitted" }, // brown, white chest + socks · fedora
  { name: "Pickle", fur: 0xf3dcb6, pattern: "point" }, // seal-point Siamese · flower
  { name: "Patches", fur: 0xf5ead6, pattern: "calico", accessory: "party" }, // tricolour calico, always celebrating
  { name: "Pepper", fur: 0x9aa2a8, pattern: "tabby", accessory: "helmet" }, // silver tabby, full race trim
  { name: "Cocoa", fur: 0x5a3b2a, pattern: "tortie" }, // mottled tortoiseshell · bow tie
  { name: "Ziggy", fur: 0xd9a34a, pattern: "bengal", accessory: "aviator" }, // golden bengal daredevil
  { name: "Moo", fur: 0xf6f3ea, pattern: "cow" }, // milk-white with big black patches · bell collar
  { name: "Misty", fur: 0x565e6e, pattern: "smoke", accessory: "wizard" }, // blue-grey smoke, suitably mysterious
  { name: "Biscuit", fur: 0xe3c692, pattern: "tabby", accessory: "chef" }, // warm golden tabby, fresh from the oven
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
  // (Wheelie the moto and Vanilla the minivan are parked for now — their model
  // styles 4 and 5 still exist in createKartModel and will return later.)
  { name: "Prowler", color: 0x3949ab, style: 6, number: 12 }, // off-road buggy with a full roll cage
];

// What the creators open with (also the look the Cat-alog uses to advertise them).
export const DEFAULT_CUSTOM_CAT = { name: "My Cat", fur: 0xf0a830, pattern: "spotted", accessory: "cap", accessoryColor: null };
export const DEFAULT_CUSTOM_KART = { name: "My Kart", color: 0xe53935, style: 0, number: 0 };
