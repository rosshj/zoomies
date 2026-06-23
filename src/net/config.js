// Multiplayer configuration.
//
// PARTY_HOST is your deployed PartyKit host, WITHOUT protocol, e.g.
// "zoomies.yourname.partykit.dev" (from `npx partykit deploy`), or
// "127.0.0.1:1999" while running `npx partykit dev` locally.
//
// Until it's set, multiplayer stays off and the game is exactly single-player.
// You can also override it per-session with a ?host= URL param for quick tests.
export const PARTY_HOST = "";

// Resolve the host: URL ?host= wins (handy for dev), else the constant above.
export function resolveHost() {
  const p = new URLSearchParams(location.search).get("host");
  return (p || PARTY_HOST || "").trim();
}
