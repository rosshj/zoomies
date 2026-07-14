# Deploying the Zoomies race referee (Cloudflare Durable Object)

The referee is **optional**. Zoomies plays exactly as it does today without it —
positions always flow peer-to-peer. What the referee adds is *agreement* on the
contested events (hits, laps, finish order): one clock, lag-compensated, so every
player's screen resolves them the same way. It runs on the Cloudflare **Workers
Free** plan at **$0** (SQLite-backed Durable Objects are free; we keep all state
in memory, so nothing is even written to storage).

## What you need to do (one-time, ~5 minutes)

You have a free Cloudflare account — that's the only prerequisite. From this repo:

```bash
cd workers/referee

# 1. Install wrangler (Cloudflare's CLI) if you don't have it.
npm install -g wrangler        # or: npx wrangler <cmd> without installing

# 2. Log in — opens a browser to authorize your Cloudflare account.
wrangler login

# 3. Deploy. First deploy also creates the Durable Object class.
wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.:

```
https://zoomies-referee.<your-subdomain>.workers.dev
```

That's the whole server side. There's nothing to configure, no database to
create, no secrets to set.

## Pointing the game at it

The client connects to the referee only when it's given the URL, as a **WebSocket**
(`wss://`, not `https://`). It reuses the address `wrangler deploy` printed, with the
protocol swapped to `wss://`, e.g. `wss://zoomies-referee.<your-subdomain>.workers.dev`.

### On phones (the real path) — bake it into config

The game runs as a PWA and a native app, and **neither can be switched by a URL**
(the installed PWA launches at a fixed page with no query string; the native app
loads `capacitor://localhost` with no address bar). So, exactly like the Ably key,
you set the referee address **once in config and rebuild** — then it ships inside the
app and there's no URL to type, ever.

1. Open `src/net/config.js` and set:
   ```js
   export const REFEREE_URL = "wss://zoomies-referee.<your-subdomain>.workers.dev";
   ```
2. Rebuild the app (`npm run build:web`, then `npm run cap:sync` for the native
   builds).

Now the referee is **on by default** for everyone. To turn it off or back on without
rebuilding, use **Settings → Advanced → Referee** (a normal On/Off toggle; it reads
“Not set” until you've configured the URL above). The toggle takes effect the next
time you Host or Join. For consistency both players should have it on — if only one
does, the referee simply half-applies and the game falls back to the normal
peer-to-peer behaviour, so nothing breaks.

### On desktop (quick test before you bake it in)

In a browser you *can* pass it as a link parameter, which is handy for a one-off test
without editing config:

```
https://<your game>/?mp=1&ref=wss://zoomies-referee.<your-subdomain>.workers.dev
```

Both players must use the **same** `ref=` URL (they share a room; add
`&refroom=<name>` for isolated rooms on one deployment). Leave the URL out of both
config and the link and the game is 100% unchanged — no connection is made.

## Verifying it works

- `curl https://zoomies-referee.<subdomain>.workers.dev/health` → `ok`.
- In a two-device race (referee on via config, or `?ref=` on desktop), open the
  browser console: you'll see the referee connection and `hitv` / `lapv` / `finishv`
  verdicts arriving.
- `wrangler tail` streams live logs from the deployed Worker while you play.

## Costs & limits (free plan)

- Durable Objects on the free plan require the **SQLite backend** — already
  configured in `wrangler.toml` (`new_sqlite_classes`). No paid plan needed.
- Free plan: 100k Worker requests/day and generous DO limits — a hobby race uses a
  tiny fraction. WebSocket **Hibernation** (already used) means an idle room costs
  nothing.
- We store nothing durable, so you'll never approach the 1 GB free storage cap.

## How it fits together

```
  each client ──P2P poses──► each client        (movement, unchanged, zero-latency)
       │
       └──referee WebSocket──► Durable Object ──► RefereeRoom (src/net/referee.js)
              state feed              │              lag-comp buffers
              hit/finish claims       └─broadcast──► hit / lap / finish VERDICTS
```

- `worker.js` — the Worker entry + `RaceReferee` Durable Object (WebSocket shell).
- `src/net/referee.js` — the pure adjudication brain (unit-tested: `npm run
  check:referee`).
- `src/net/refereeclient.js` — the client connector (default-off).
