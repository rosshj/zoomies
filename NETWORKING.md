# Multiplayer

Players in the same room race against each other live: karts **glide around
smoothly in real time**, **collide** with single-player-parity bumps, and share
**placement** (`2nd / N`). The host is the player who created the room, and the
race countdown is synchronized off a shared clock so everyone launches together.

Remote karts are driven by an interpolation buffer (with dead-reckoning to ride
out jitter), but collisions are resolved locally and self-authoritatively, so a
bump feels the same as it does against an AI rival.

It's **opt-in and isolated**: with multiplayer off, the game is exactly
single-player. None of the networking code (or the transport client) is even
loaded until you add `&mp=1`.

## Architecture at a glance

```
   your kart          the wire                    a rival's kart
  (local, instant) ── sendState ~16Hz ─► Ably relay ─► onState ─► interpolation
                                     (or WebRTC P2P               buffer (adaptive
   RemoteKart  ◄── interpolate/dead-reckon ── + shared clock)     ~200ms) + dead-reckoning
```

- **Your own kart** runs the normal local physics — zero input lag, unchanged.
- **Rival karts** are `RemoteKart` puppets: the full kart visual, but driven by
  interpolated network snapshots instead of physics.
- **Transport is abstracted** (`src/net/net.js`). Ably (cloud relay) by default,
  or a WebRTC peer-to-peer transport — same facade, no gameplay changes.

### Files

| File | Role |
| --- | --- |
| `src/net/interp.js` | Snapshot buffer + interpolation/dead-reckoning (pure, unit-tested) |
| `src/net/clock.js` | NTP-style shared-clock sync (pure, unit-tested) |
| `src/net/net.js` | Transport-agnostic facade: presence, clock, send/receive |
| `src/net/loopback.js` | In-process fake server for tests/local dev (latency/jitter/clock-skew sim) |
| `src/net/ably.js` | Ably realtime adapter (default cloud transport) |
| `src/net/webrtc.js` | WebRTC peer-to-peer transport (`?rtc=1`; pose stream goes direct) |
| `src/net/partysocket.js` | PartyKit client adapter (legacy) |
| `src/net/config.js` | `ABLY_KEY` / `PARTY_HOST` settings + URL overrides |
| `src/remotekart.js` | Render-only ghost kart driven by the interpolation buffer |
| `party/zoomies.js` | PartyKit server (relay + presence + clock) |
| `partykit.json` | PartyKit project config |

## Peer-to-peer mode (`?rtc=1`) — lower latency

Add `&rtc=1` to the URL (alongside `&mp=1`) for a **peer-to-peer** transport.
Instead of relaying every pose through Ably's cloud (~50–150 ms round trip), the
high-frequency pose stream travels **directly between players** over WebRTC data
channels — on the same Wi-Fi/LAN that's a ~1–5 ms hop, so remote karts feel far
more immediate.

What still uses Ably (all latency-tolerant): the **connection handshake**
(signalling), **presence** (who's in the room), the **shared clock**, and the
occasional **events** (race start, hairball shots, hits, finishes). Only the
continuous pose stream is peer-to-peer. So you still need the Ably key set and a
little internet **to connect** — the gameplay traffic is what goes direct.

- The **invite link** carries `rtc=1`, so friends who open it join the same P2P
  room. (Host and guests must agree on the transport to form direct links.)
- It's **backward-compatible**: a peer that never opens a data channel just stays
  on the Ably path, and a peer still connecting falls back to Ably until its P2P
  link is live (the receiver drops the duplicate once it is).
- Peers form a **full mesh** (fine at 2–6 players). A public STUN server is used
  for connection setup; on a pure LAN, local candidates connect without it.

`tools/net-check.mjs` (`npm run check:net`) unit-tests the pure routing decisions
(who initiates, and the Ably-fallback de-dup). The live mesh needs real devices.

## Turn it on — Ably (recommended, ≈3 minutes, no server)

The PartyKit.dev zone hit Cloudflare's 10K-subdomain limit and can't accept new
deploys. Ably is the active backend — free tier, no server to run.

1. **Create a free Ably account** at https://ably.com  
2. **Copy your API key**: Dashboard → Apps → (your app) → API Keys → copy the key  
   (it looks like `xVLyHw.AbCdEf:xxxxxxxxxxxxxxxxxxxx`)  
3. **Paste it** in `src/net/config.js`:
   ```js
   export const ABLY_KEY = "xVLyHw.AbCdEf:xxxxxxxxxxxxxxxxxxxx";
   ```
4. **Play multiplayer** by adding `&mp=1` to the URL. Room = world seed:
   ```
   https://your-game.vercel.app/?seed=ABC123&mp=1
   ```
   Open on two devices (or two tabs). START RACE drops you into a **lobby** (room
   code + player list); the player with a 👑 is the host. When the host presses
   START RACE, everyone's countdown is synchronized off a shared clock and the
   race begins together. Multiplayer races are **humans-only** (no AI), and
   placement (`2nd / N`) is shared across all players. A small
   `MP · peers N · ping Xms` readout appears bottom-left.

No deploy step, no server. Ably relays everything.

## Turn it on — PartyKit (blocked / for reference)

PartyKit can't currently deploy new projects to partykit.dev (Cloudflare zone
limit). Kept here for when they fix it:

1. `npm i -D partykit && npx partykit login`
2. `npx partykit deploy` → prints `zoomies.YOURNAME.partykit.dev`
3. Set `PARTY_HOST` in `src/net/config.js`
4. Add `&mp=1` to the URL

### Local development (Ably)

No local server needed — Ably's cloud relays in dev too. Just set the key and
use `?mp=1`. For a loopback/offline test:
```
# open two tabs:
http://localhost:5173/?seed=ABC123&mp=1
```
Both tabs connect to the same Ably channel and see each other immediately.

## How to actually validate it

Two tabs on the same Wi-Fi will look flawless and *lie to you*. The honest test
is **two phones on cellular** — that's where jitter and packet loss reveal
whether the interpolation buffer and dead-reckoning are doing their job. Watch a
rival kart: it should glide, not teleport or stutter, even when your bars drop.

## What's verified vs. what needs you

- **Verified here (no infra):** the interpolation, dead-reckoning, snapshot
  buffering, and clock-sync math are unit-tested; the full presence + clock +
  state-relay flow is tested end-to-end against the loopback server with
  simulated latency, jitter, and a skewed server clock.
- **Live against Ably:** the lobby, host election, synchronized countdown,
  collisions, and shared placement have been exercised on real Ably channels
  across multiple clients. Plug in your own key (above) to run it yourself.
- **Needs your account:** the real on-device feel test on cellular — only you
  can judge that, and it's the test that matters (see "How to actually validate
  it" above).

## Current scope

- Up to 6 humans per room; the host is the room creator, and a new host is
  elected if they leave.
- Collisions are resolved locally with single-player-parity physics (no item/
  hairball sync yet — projectiles are local).
- Multiplayer races are humans-only; AI rivals only fill the field in
  single-player.
- Each client picks its own cat/kart appearance from its garage.
