// Garage presets — the named cats and karts the player picks from (and the
// Cat-alog sells). Pure data, no THREE: shared by main.js (garage, roster,
// prizes) and by tools/catalog-shots.mjs, which renders each preset in the
// asset viewer to produce the Cat-alog's prize thumbnails.

// Stable, append-only preset indexes preserve saved racers and unlock IDs.
// Each named cat has one signature accessory; the creator can mix any type/coat.
export const CAT_PRESETS = [
  { name: "Marmalade", fur: 0xf0a830, pattern: "spotted", accessory: "cap" }, // ginger spotted tabby · cap
  { name: "Smokey", fur: 0x8c9298, pattern: "solid", accessory: "headphones" }, // plush solid grey (Russian Blue) · headphones
  { name: "Shadow", fur: 0x2a2a2a, pattern: "tuxedo", accessory: "sunglasses" }, // black & white tuxedo · sunglasses
  { name: "Snow", fur: 0xfbfbfb, pattern: "snowshoe", accessory: "beanie" }, // white + seal mask/points · beanie
  { name: "Whiskey", fur: 0xc8966a, pattern: "tabby", accessory: "cowboy" }, // brown tabby, hat to match the name
  { name: "Nelson", fur: 0x4a3328, pattern: "mitted", accessory: "fedora" }, // brown, white chest + socks · fedora
  { name: "Pickle", fur: 0xf3dcb6, pattern: "point", accessory: "flower" }, // seal-point Siamese · flower
  { name: "Patches", fur: 0xf5ead6, pattern: "calico", accessory: "party" }, // tricolour calico, always celebrating
  { name: "Pepper", fur: 0x9aa2a8, pattern: "tabby", accessory: "helmet" }, // silver tabby, full race trim
  { name: "Cocoa", fur: 0x5a3b2a, pattern: "tortie", accessory: "bow" }, // mottled tortoiseshell · bow tie
  { name: "Ziggy", fur: 0xd9a34a, pattern: "bengal", accessory: "aviator" }, // golden bengal daredevil
  { name: "Moo", fur: 0xf6f3ea, pattern: "cow", accessory: "collar" }, // milk-white with big black patches · bell collar
  { name: "Misty", fur: 0x565e6e, pattern: "smoke", accessory: "wizard" }, // blue-grey smoke, suitably mysterious
  { name: "Biscuit", fur: 0xe3c692, pattern: "tabby", accessory: "chef" }, // warm golden tabby, fresh from the oven
  { name: "Timber", type: "maine", fur: 0x947259, pattern: "tabby", accessory: "dragon" },
  { name: "Fjord", type: "forest", fur: 0xc1b39c, pattern: "smoke", accessory: "viking" },
  { name: "Marple", type: "persian", fur: 0xe0cfb9, pattern: "solid", accessory: "detective" },
  { name: "Duchess", type: "angora", fur: 0xf4efe7, pattern: "solid", accessory: "crown" },
  { name: "Russet", type: "somali", fur: 0xba7146, pattern: "ticked", accessory: "scarf" },
  { name: "Winston", type: "british", fur: 0xa6a1b5, pattern: "solid", accessory: "tophat" },
  { name: "Pudding", type: "exotic", fur: 0xd8b184, pattern: "mitted", accessory: "mushroom" },
  { name: "Pebble", type: "chartreux", fur: 0x778c9d, pattern: "solid", accessory: "rain" },
  { name: "Crumpet", type: "selkirk", fur: 0xd9cfb7, pattern: "solid", accessory: "straw" },
  { name: "Marshmallow", type: "ragdoll", fur: 0xe4dfd9, pattern: "bicolor", accessory: "unicorn" },
  { name: "Chai", type: "birman", fur: 0xeed9b9, pattern: "mittedPoint", accessory: "lei" },
  { name: "Skipper", type: "van", fur: 0xf4e8d9, pattern: "van", accessory: "pirate" },
  { name: "Opal", type: "khaomanee", fur: 0xf9f3eb, pattern: "solid", accessory: "catEye" },
  { name: "Orbit", type: "sphynx", fur: 0xd4a69c, pattern: "solid", accessory: "space" },
  { name: "Fizz", type: "devon", fur: 0xc3b6a2, pattern: "smoke", accessory: "bee" },
  { name: "Noodle", type: "cornish", fur: 0xba9371, pattern: "solid", accessory: "mustache" },
  { name: "Saffron", type: "abyssinian", fur: 0xbd8955, pattern: "ticked", accessory: "sombrero" },
  { name: "Dumpling", type: "fold", fur: 0xb8b0a0, pattern: "tabby", accessory: "duck" },
  { name: "Clover", type: "curl", fur: 0xccbdaa, pattern: "bicolor", accessory: "frog" },
  { name: "Rumpus", type: "manx", fur: 0x9b795c, pattern: "tabby", accessory: "bandana" },
  { name: "Yoshi", type: "bobtail", fur: 0xf2ddd2, pattern: "calico", accessory: "propeller" },
  { name: "Inky", type: "bombay", fur: 0x191d29, pattern: "solid", accessory: "shark" },
  { name: "Dapple", type: "ocicat", fur: 0xd4ad78, pattern: "spotted", accessory: "charm" },
  { name: "Quicksilver", type: "mau", fur: 0xc1c6c2, pattern: "spotted", accessory: "cone" },
  { name: "Stripes", type: "toyger", fur: 0xd6924e, pattern: "tiger", accessory: "ski" },
  { name: "Flurry", type: "snowbengal", fur: 0xe8e3d6, pattern: "bengal", accessory: "shells" },

];

// Stable preset ids: curated body color, chassis, racing number and livery.
export const KART_PRESETS = [
  { name: "Ember", color: 0xe53935, style: 0, number: 5, livery: 3 },
  { name: "Lagoon", color: 0x1e88e5, style: 1, number: 7, livery: 4 },
  { name: "Clover", color: 0x43a047, style: 2, number: 3, livery: 6 },
  { name: "Tangerine", color: 0xfb8c00, style: 0, number: 9, livery: 5 },
  { name: "Grape", color: 0x8e24aa, style: 1, number: 4, livery: 1 },
  { name: "Sunbeam", color: 0xfdd835, style: 2, number: 1, livery: 0 },
  { name: "Teal", color: 0x00897b, style: 0, number: 8, livery: 7 },
  { name: "Comet", color: 0x26c6da, style: 3, number: 2, livery: 0 }, // jet-age finned speedster
  { name: "Nova", color: 0xec407a, style: 3, number: 6, livery: 5 },
  { name: "Prowler", color: 0x3949ab, style: 4, number: 12, livery: 6 }, // off-road buggy with a full roll cage
  // Two team editions per new chassis. Existing ids and cup rewards stay stable.
  { name: "Club Racer", color: 0xd84d3e, style: 5, number: 20, livery: 0 },
  { name: "Club Cobalt", color: 0x3078c4, style: 5, number: 21, livery: 3 },
  { name: "Sprint", color: 0x207d79, style: 6, number: 23, livery: 1 },
  { name: "Sprint Citrus", color: 0xf2b93b, style: 6, number: 24, livery: 6 },
  { name: "Shifter", color: 0x3457a1, style: 7, number: 26, livery: 5 },
  { name: "Shifter Frost", color: 0xe6e9e5, style: 7, number: 27, livery: 7 },
  { name: "Endurance", color: 0xae3549, style: 8, number: 29, livery: 7 },
  { name: "Endurance Gold", color: 0xe8b444, style: 8, number: 30, livery: 3 },
  { name: "Rental Pro", color: 0x50677b, style: 9, number: 32, livery: 6 },
  { name: "Rental Orange", color: 0xe98036, style: 9, number: 33, livery: 0 },
  { name: "Vintage Racer", color: 0x286b50, style: 10, number: 35, livery: 4 },
  { name: "Vintage Ivory", color: 0xe7dcc4, style: 10, number: 36, livery: 4 },
  { name: "Dirt Oval", color: 0xe6bf38, style: 11, number: 38, livery: 5 },
  { name: "Oval Scarlet", color: 0xbb3f3d, style: 11, number: 39, livery: 7 },
  { name: "Flat Tracker", color: 0xbf652f, style: 12, number: 41, livery: 4 },
  { name: "Tracker Slate", color: 0x526b7c, style: 12, number: 42, livery: 2 },
  { name: "Rallycross", color: 0x4a7561, style: 13, number: 44, livery: 6 },
  { name: "Rally Arctic", color: 0xe6e8df, style: 13, number: 45, livery: 2 },
  { name: "Crosskart", color: 0x364e75, style: 14, number: 47, livery: 5 },
  { name: "Crosskart Lime", color: 0xa1bd38, style: 14, number: 48, livery: 1 },
  { name: "Dune Racer", color: 0xc49d69, style: 15, number: 50, livery: 0 },
  { name: "Dune Copper", color: 0xb86346, style: 15, number: 51, livery: 6 },
  { name: "Streamliner", color: 0xabb8c5, style: 16, number: 53, livery: 3 },
  { name: "Stream Azure", color: 0x328db0, style: 16, number: 54, livery: 7 },

];

// What the creators open with (also the look the Cat-alog uses to advertise them).
export const DEFAULT_CUSTOM_CAT = { type: "classic", name: "My Cat", fur: 0xf0a830, pattern: "spotted", accessory: "cap", accessoryColor: null };
export const DEFAULT_CUSTOM_KART = { name: "My Kart", color: 0xe53935, style: 0, number: 0, livery: 0 };
