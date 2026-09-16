// Encoded world token (pure, dependency-free so it unit-tests in node).
//
// A track is built from its seed PLUS a full per-device config (track mode +
// curve knobs + biomes + width + lap count) normally read from localStorage. A
// cup is a reload chain, and each round must build EXACTLY the cup's track
// whatever the player's saved settings — so cupRaceURL (main.js) packs the whole
// world into this compact `?w=` token and the boot path decodes it.
//
// A "world" is { cfg, laps, seed }: `cfg` is the trackConfig object (mode + knobs),
// `laps` the race length, `seed` the world seed.

// Encode a world object to a URL-safe token (base64url of its JSON). Track configs
// are pure ASCII (mode names, numbers, A–Z0–9 seeds), so btoa is safe. Returns "" on
// failure so a bad config can never throw at a call site.
export function encodeWorld(world) {
  try {
    const b64 = btoa(JSON.stringify(world));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return "";
  }
}

// Decode a token back to a world object, or null if absent/malformed.
export function decodeWorld(token) {
  if (!token || typeof token !== "string") return null;
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const w = JSON.parse(atob(b64));
    return w && typeof w === "object" && w.cfg && typeof w.cfg === "object" ? w : null;
  } catch {
    return null;
  }
}

// Canonical (key-sorted) stringify so two worlds compare equal regardless of key
// order — used both to compare and as a stable signature.
export function worldSig(world) {
  return world ? stable(world) : "";
}

// Do two worlds describe the same map? (Same cfg, laps, and seed.)
export function sameWorld(a, b) {
  return worldSig(a) === worldSig(b);
}

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
