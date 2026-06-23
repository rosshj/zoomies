# Multiplayer (Phase 2: the "ghost race")

This is the first networking milestone: players in the same room see each other's
karts **glide around smoothly in real time**. Remote karts are render-only
"ghosts" — they do **not** collide, carry items, or affect placement yet. The
point is to prove the netcode *feels* good before building race rules on top.

It's **opt-in and isolated**: with no host configured, the game is exactly
single-player. None of the networking code (or the `partysocket` client) is even
loaded until you turn it on.

## Architecture at a glance

```
   your kart          the wire                 a rival's kart
  (local, instant) ── sendState 18Hz ─► PartyKit room ─► onState ─► interpolation
                                          (relay +                    buffer (~100ms)
   RemoteKart  ◄── interpolate/dead-reckon ── shared clock)          + dead-reckoning
```

- **Your own kart** runs the normal local physics — zero input lag, unchanged.
- **Rival karts** are `RemoteKart` puppets: the full kart visual, but driven by
  interpolated network snapshots instead of physics.
- **Transport is abstracted** (`src/net/net.js`). PartyKit today; the same Net
  facade could drive WebRTC later with no gameplay changes.

### Files

| File | Role |
| --- | --- |
| `src/net/interp.js` | Snapshot buffer + interpolation/dead-reckoning (pure, unit-tested) |
| `src/net/clock.js` | NTP-style shared-clock sync (pure, unit-tested) |
| `src/net/net.js` | Transport-agnostic facade: presence, clock, send/receive |
| `src/net/loopback.js` | In-process fake server for tests/local dev (latency/jitter/clock-skew sim) |
| `src/net/partysocket.js` | PartyKit client adapter |
| `src/net/config.js` | `PARTY_HOST` setting + `?host=` override |
| `src/remotekart.js` | Render-only ghost kart driven by the interpolation buffer |
| `party/zoomies.js` | PartyKit server (relay + presence + clock) |
| `partykit.json` | PartyKit project config |

## Turn it on (≈5 minutes)

1. **Install + log in** (one time):
   ```
   npm i -D partykit
   npx partykit login
   ```
2. **Deploy the room server:**
   ```
   npx partykit deploy
   ```
   This prints your host, e.g. `zoomies.YOURNAME.partykit.dev`.
3. **Point the game at it** — set it in `src/net/config.js`:
   ```js
   export const PARTY_HOST = "zoomies.YOURNAME.partykit.dev";
   ```
4. **Play multiplayer** by adding `&mp=1` to the URL. The room is the world seed,
   so the same link = same world + same lobby:
   ```
   https://your-game.vercel.app/?seed=ABC123&mp=1
   ```
   Open it on two devices (or two tabs) and you'll see each other's ghost karts.
   A small `MP · peers N · ping Xms` readout appears bottom-left.

### Local development

Run the room server locally and point the game at it without editing config:
```
npx partykit dev            # serves on 127.0.0.1:1999
# then open:  http://localhost:5173/?seed=ABC123&mp=1&host=127.0.0.1:1999
```

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
- **Needs your account:** PartyKit deploy and the real on-device feel test.
  The adapter/server are written to the same protocol the tests exercise, but
  haven't been run against live PartyKit yet.

## Known Phase-2 limitations (by design)

- No collisions, hairball/item sync, or shared lap/placement — ghosts only.
- Local AI rivals still fill the field; remote players are *added on top*.
- No polished lobby UI yet (that's Phase 3), no reconnection/host-migration.
- Each client picks its own random cat appearance for now.
