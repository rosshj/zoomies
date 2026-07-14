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
  (local, instant) ── sendState 30Hz ─► WebRTC P2P ─► onState ─► Hermite interp
                                    (binary+FEC; Ably           buffer + curved
   RemoteKart  ◄── velocity-blend + predict-to-present ── fallback)  extrapolation
                                                + shared clock)   → drawn at PRESENT
```

- **Your own kart** runs the normal local physics — zero input lag, unchanged.
- **Rival karts** are `RemoteKart` puppets: the full kart visual, but driven by
  interpolated network snapshots instead of physics. Remote motion uses **cubic
  Hermite** interpolation (curves through corners at 16 Hz), **projective
  velocity blending** (converges onto the true path with no follow-lag), a
  **per-peer jitter-aware delay** (a jittery link buffers more), and
  **predict-to-present**: the ghost is drawn where the kart *is now*, not where
  it was. A **curved (turn-rate + acceleration aware) extrapolator** rides the
  kart's real arc past the newest snapshot, and the render offset is pulled toward
  present on a clean link — so absolute position error collapses (netsim errAbs
  p95 ~4→1.5 u on LAN, staleness ~90→33 ms) — while jitter re-inflates the offset
  back toward the buffered value so a bursty link stays in safe interpolation. See
  `src/net/remotepose.js` + `interp.js`; the wins are measured in the netsim
  harness against `tools/netsim/baseline.json`.
- **Transport is abstracted** (`src/net/net.js`). Ably (cloud relay) by default,
  or a WebRTC peer-to-peer transport — same facade, no gameplay changes.

### Files

| File | Role |
| --- | --- |
| `src/net/interp.js` | Snapshot buffer + cubic-Hermite interpolation + dead-reckoning (pure, unit-tested) |
| `src/net/clock.js` | NTP-style shared-clock sync (pure, unit-tested; injectable clock) |
| `src/net/remotepose.js` | Pure remote-pose tracking: buffer, velocity-blend convergence, per-peer jitter-aware delay, bump, stale, flags (headless, unit-tested) |
| `src/net/session.js` | `MpSession` — dependency-injected multiplayer orchestration (send loop, adaptive delay, roster, collisions) |
| `src/net/net.js` | Transport-agnostic facade: presence, clock, send/receive (injectable timers) |
| `src/net/loopback.js` | In-process fake server for tests/local dev (injectable latency/jitter/clock-skew/loss sim) |
| `src/net/ably.js` | Ably realtime adapter (default cloud transport) |
| `src/net/webrtc.js` | WebRTC peer-to-peer transport (DEFAULT; binary+FEC pose stream, `?rtc=0` opts out) |
| `src/net/posecodec.js` | Binary quantized pose packet + piggyback FEC (P2P channel only; pure, unit-tested) |
| `src/net/partysocket.js` | PartyKit client adapter (legacy) |
| `src/net/config.js` | `ABLY_KEY` / `PARTY_HOST` settings + URL overrides |
| `src/net/recorder.js` | Dev-only arrival recorder → exports a replayable trace (`?rec=1`) |
| `src/net/sim/` | Netsim harness: virtual clock, scripted drivers, metrics, scenario runner, trace replay |
| `src/remotekart.js` | Render-only ghost kart: a THREE adapter over `RemotePose` |
| `party/zoomies.js` | PartyKit server (relay + presence + clock) |
| `partykit.json` | PartyKit project config |

## Peer-to-peer (the default transport) — lower latency

WebRTC is now the **default**: the high-frequency pose stream travels **directly
between players** over data channels — on the same Wi-Fi/LAN a ~1–5 ms hop vs
relaying every pose through Ably's cloud (~50–150 ms round trip), so remote karts
feel far more immediate. Opt OUT with `?rtc=0` (or Settings → Advanced) to force
the Ably relay.

The direct channel is tuned for a real-time pose stream:
- **Binary + quantized** (`src/net/posecodec.js`): a pose packs to ~17 bytes vs
  ~150 as JSON, so the stream is cheap on bandwidth and battery.
- **Piggyback FEC**: each packet carries the last ~3 poses, so a single dropped
  datagram is recovered from the next — no gap.
- **Unreliable + unordered** (`ordered:false, maxRetransmits:0`): a lost packet
  never head-of-line-blocks later poses (the reliable-ordered mode would stall the
  whole stream behind a retransmit). Out-of-order arrivals are dropped safely by
  the snapshot buffer's monotonic guard.
- **30 Hz** on the direct channel (no relay per-message limit); Ably stays 16 Hz.

What still uses Ably (all latency-tolerant): the **handshake** (signalling),
**presence**, the **shared clock**, and the occasional **events** (start, shots,
hits, finishes). So you still need the Ably key + a little internet **to connect**.

- A normal **invite link** needs no flag (both ends default to P2P); it only
  carries `rtc=0` if the host opted OUT, so guests match the transport.
- **Graceful fallback**: a peer that never opens a channel (NAT-blocked) stays on
  the Ably path, throttled to 16 Hz; a peer still connecting falls back until its
  link is live (the receiver drops the duplicate once it is). Default-on is safe.
- Peers form a **full mesh** (fine at 2–6 players). **ICE**: a public STUN server
  by default; add a **TURN** relay (for symmetric-NAT peers) via `config.js` or a
  `?turn=…&turnUser=…&turnCred=…` override.

⚠️ **All peers must run the same build** — a peer on an older build speaks the old
JSON channel format and would drop the new binary poses (a web game reloads to the
latest deploy, so the window is brief).

`tools/net-check.mjs` (`npm run check:net`) exercises the routing + binary/FEC path
against a mock mesh (peer-id stamping, Ably-fallback shape, FEC-drop recovery), and
`npm run check:codec` unit-tests the codec. Real SCTP delivery, TURN traversal, and
the on-device feel need real devices.

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

Short of two phones, the **netsim harness** reproduces those conditions offline
(see below), and you can **record a real cellular session and replay it** through
that harness for a repeatable measurement.

### Netsim harness (`npm run check:netsim`)

`src/net/sim/` drives the *real* send loop + interpolation + clock sync (the same
`Net` + `MpSession` + `RemotePose` the game ships) over the loopback hub on a
virtual clock with a seeded RNG. It runs a matrix of network conditions
(`lan` / `wifi` / `cellular` / `awful`, from 20 ms clean up to 250±120 ms with 5%
loss and multi-second clock skew) and measures per-frame positional error,
staleness, correction magnitude, extrapolation share, snap-corrections and a hard
no-teleport invariant. Because every timing/random source is injected, a run is
**bit-for-bit reproducible** — the harness asserts this by running twice and
comparing.

Metrics are compared against a committed baseline (`tools/netsim/baseline.json`)
with tolerance bands, so a change that meaningfully worsens smoothness fails CI.
Recapture the baseline (after an intended improvement) with:
```
node tools/netsim-check.mjs --write-baseline
```

### Recording + replaying a real trace

Add `?rec=1` (or set `localStorage["zoomies-netrec"]="1"` in an installed PWA),
race, then tap **REC ⬇** on the bottom-left debug readout to save a trace of
every pose you received (arrival time + pose per peer). Replay it offline:
```
node tools/netsim-check.mjs --trace zoomies-trace-<...>.json
```
This reconstructs exactly what your device interpolated, so you can see the snap
count, extrapolation share and staleness a real link produced — no ground truth,
receive-side only.

## What's verified vs. what needs you

- **Verified here (no infra):** the interpolation, dead-reckoning, snapshot
  buffering, and clock-sync math are unit-tested (`npm run check:net`); the full
  presence + clock + state-relay flow, the extracted `MpSession` orchestration,
  and the end-to-end send→interpolate pipeline are tested against the loopback
  server with simulated latency, jitter, loss, and a skewed server clock, plus
  the scenario matrix above (`npm run check:netsim`). Both run node-only in CI.
- **Live against Ably:** the lobby, synchronized countdown, collisions, and
  shared placement have been exercised on real Ably channels across multiple
  clients. Plug in your own key (above) to run it yourself.
- **Needs your account:** the real on-device feel test on cellular — only you
  can judge that, and it's the test that matters (see "How to actually validate
  it" above). Record a trace there and replay it to turn feel into numbers.

## Current scope

- Up to 6 humans per room; the host is the room creator. If the host leaves, the
  room just can't launch a new race — host migration is a separate feature, not
  yet built.
- Collisions are resolved locally with single-player-parity physics.
- All combat replicates: hairballs and yarn balls are shooter-authoritative
  (rivals render a cosmetic ghost projectile; the shooter decides the hit and
  sends it), and spilled milk is victim-authoritative (the puddle is replicated
  and each client trips its own player on it). The spin-out itself streams over
  the normal pose channel.
- Multiplayer races are humans-only; AI rivals only fill the field in
  single-player.
- Each client picks its own cat/kart appearance from its garage.
