// Multiplayer configuration.
//
// === Ably (recommended) ===
// Create a free account at https://ably.com, copy your publishable API key
// (Dashboard → Apps → API Keys), and paste it here. Safe to ship in client code.
// Free tier: 200 concurrent connections, 6M messages/month.
export const ABLY_KEY = "";

// === PartyKit (fallback) ===
// PARTY_HOST is your deployed PartyKit host, WITHOUT protocol, e.g.
// "zoomies.yourname.partykit.dev" (from `npx partykit deploy`), or
// "127.0.0.1:1999" while running `npx partykit dev` locally.
// Note: partykit.dev zone is currently over its Cloudflare limit (10K domains).
export const PARTY_HOST = "";

// Resolve at runtime: URL params win (handy for dev), else the constants above.
export function resolveAblyKey() {
  const p = new URLSearchParams(location.search).get("ablyKey");
  return (p || ABLY_KEY || "").trim();
}

export function resolveHost() {
  const p = new URLSearchParams(location.search).get("host");
  return (p || PARTY_HOST || "").trim();
}

// Ably key for multiplayer.
export const ABLY_KEY = "zDRQCw.ydmgPw:JrBtmO-j6bXrQJZfYGCHfeuQwuCpsPZ7sZJjUxNMGEk";
