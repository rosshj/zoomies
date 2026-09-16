// Tests for the encoded-world codec (src/worldcfg.js) that carries a cup round's
// exact map through its `?w=` reload. Run: `npm run check:worldcfg`.
import { encodeWorld, decodeWorld, sameWorld, worldSig } from "../src/worldcfg.js";

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok  " : "FAIL  ") + name); if (!cond) failures++; };

const classic = { cfg: { mode: "classic" }, laps: 3, seed: "ABCD" };
const custom = {
  cfg: { mode: "custom", seed: "XY12", size: 0.6, curviness: 0.8, hilliness: 0.3, hills: 4, twist: 0.2, biomes: ["desert", "forest"], width: 1.1, features: { arch: true, tunnel: false }, timeOfDay: "day" },
  laps: 5, seed: "XY12",
};

// --- Round-trip ---
check("classic world round-trips", sameWorld(decodeWorld(encodeWorld(classic)), classic));
check("custom world round-trips (all knobs + biomes + features)", sameWorld(decodeWorld(encodeWorld(custom)), custom));
check("decoded custom equals original by deep value", JSON.stringify(decodeWorld(encodeWorld(custom))) === JSON.stringify(custom));

// --- URL-safe token (no +, /, = so it survives a query string) ---
const tok = encodeWorld(custom);
check("token is URL-safe (no +, /, =)", !/[+/=]/.test(tok) && tok.length > 0);

// --- Malformed / absent input never throws, returns null ---
check("null token → null", decodeWorld(null) === null);
check("empty token → null", decodeWorld("") === null);
check("garbage token → null", decodeWorld("!!!not-base64!!!") === null);
check("valid base64 of a non-world → null", decodeWorld(encodeWorld({ nope: 1 })) === null);

// --- sameWorld is key-order independent but value-sensitive ---
const reordered = { seed: "ABCD", laps: 3, cfg: { mode: "classic" } };
check("sameWorld ignores key order", sameWorld(classic, reordered));
check("different laps → not same", !sameWorld(classic, { ...classic, laps: 4 }));
check("different seed → not same", !sameWorld(classic, { ...classic, seed: "ZZZZ" }));
check("classic vs custom → not same (the real desync case)", !sameWorld(classic, custom));
check("different curviness → not same", !sameWorld(custom, { ...custom, cfg: { ...custom.cfg, curviness: 0.1 } }));

// --- worldSig is stable across encode→decode (so an adopt-reload converges, no loop) ---
check("signature stable through a round-trip", worldSig(decodeWorld(encodeWorld(custom))) === worldSig(custom));

if (failures) { console.log(`\n${failures} worldcfg check(s) FAILED`); process.exit(1); }
console.log("\nall worldcfg checks passed");
