// Multiplayer configuration.
//
// === Ably (recommended) ===
// Create a free account at https://ably.com, copy your publishable API key
// (Dashboard → Apps → API Keys), and paste it here. Safe to ship in client code.
// Free tier: 200 concurrent connections, 6M messages/month.
export const ABLY_KEY = "zDRQCw.ydmgPw:JrBtmO-j6bXrQJZfYGCHfeuQwuCpsPZ7sZJjUxNMGEk";

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

// === WebRTC ICE servers ===
// A public STUN server is enough for LAN + many home networks. Peers behind a
// SYMMETRIC NAT (some mobile carriers) can't form a direct link and need a TURN
// relay — they otherwise fall back to Ably automatically. Provide TURN either by
// filling TURN below (prefer short-lived/ephemeral credentials — this ships in
// client code) or per-session via ?turn=turn:host:port&turnUser=...&turnCred=...
export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
// export const TURN = { urls: "turn:your-relay:3478", username: "...", credential: "..." };

export function resolveIceServers() {
  const list = [...ICE_SERVERS];
  if (typeof TURN !== "undefined" && TURN) list.push(TURN);
  // Node-safe: net-check imports webrtc.js (→ this), where `location` is absent.
  if (typeof location !== "undefined") {
    const p = new URLSearchParams(location.search);
    const turn = p.get("turn");
    if (turn) list.push({ urls: turn, username: p.get("turnUser") || "", credential: p.get("turnCred") || "" });
  }
  return list;
}

// === Race referee (optional Cloudflare Durable Object; Stage 4) ===
// The referee adjudicates hits/laps/finish over one lag-compensated clock so every
// client agrees on them. It's OFF unless a URL is provided — the game is unchanged
// without it. Deploy it yourself (free): see workers/referee/DEPLOY.md.
//
// ┌─ SET UP THE REFEREE (phone path, like the Ably key) ─────────────────────────┐
// │ 1. Run `npx wrangler deploy` in workers/referee — it prints an https:// URL.  │
// │ 2. Replace the ENTIRE placeholder string on the next line with that URL,      │
// │    changing https:// to wss://  →  "wss://zoomies-referee.ross.workers.dev"   │
// │ 3. Rebuild: `npm run build:web` (+ `npm run cap:sync` for the native app).    │
// └──────────────────────────────────────────────────────────────────────────────┘
// Until the placeholder is replaced the referee stays OFF (Settings shows "Not set")
// and nothing tries to connect. (?ref=wss://… still works for a desktop test.)
export const REFEREE_URL = "wss://PASTE_YOUR_WORKER_URL_HERE.workers.dev";

// Treat the untouched placeholder as "not configured" so a fresh checkout never
// tries to reach a fake host — the referee only turns on once you paste a real URL.
function bakedRefereeUrl() {
  return REFEREE_URL.includes("PASTE_YOUR_WORKER_URL_HERE") ? "" : REFEREE_URL;
}

export function resolveRefereeUrl() {
  const baked = bakedRefereeUrl();
  if (typeof location === "undefined") return (baked || "").trim();
  const p = new URLSearchParams(location.search).get("ref");
  return (p || baked || "").trim();
}

export function resolveRefereeRoom() {
  if (typeof location === "undefined") return "main";
  return (new URLSearchParams(location.search).get("refroom") || "main").trim() || "main";
}
