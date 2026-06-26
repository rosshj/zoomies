// Seeded pseudo-random number generator for deterministic world generation.
//
// Everything the world is built from — scenery scatter, tree/building variety,
// lake placement — draws from this single shared stream instead of Math.random.
// Given the same seed, the build runs the same calls in the same order and so
// produces an identical world on every device. That is the foundation for
// multiplayer: each player in a lobby seeds with the same value and races on the
// same track and landscape. (Per-frame visual effects and AI keep using
// Math.random — they're local and cosmetic, and don't need to match.)

let _state = 0x9e3779b9 >>> 0; // current generator state (mutated on each draw)
let _seed = "default"; // the human-readable seed this stream was set from

// Mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Deterministic given
// its starting state, which is exactly what we want.
function mulberry32() {
  _state |= 0;
  _state = (_state + 0x6d2b79f5) | 0;
  let t = Math.imul(_state ^ (_state >>> 15), 1 | _state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Hash an arbitrary string/number seed into a 32-bit starting state (FNV-1a-ish)
// so seeds like "snowypeak" or "42" both map to a stable, well-mixed state.
function hashSeed(seed) {
  const str = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // A couple of extra mixes so very short seeds still scatter well.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

// Point the shared stream at a seed. Call this BEFORE building the world.
export function setSeed(seed) {
  _seed = seed;
  _state = hashSeed(seed);
}

export function getSeed() {
  return _seed;
}

// Drop-in replacement for Math.random(): a float in [0, 1) from the seeded stream.
export function rand() {
  return mulberry32();
}

// Build a standalone PRNG seeded from `seed`, independent of the shared stream.
// Used for things like the menu track preview, which must reproduce the same loop
// a given seed will race on WITHOUT consuming from (and so shifting) the global
// stream that builds the actual world.
export function makeRng(seed) {
  let state = hashSeed(seed);
  return function () {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fresh, shareable seed (short, URL-friendly, easy to read aloud in a lobby).
export function randomSeed() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
