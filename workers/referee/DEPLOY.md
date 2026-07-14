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
(`wss://`, not `https://`). Add it to a multiplayer link:

```
https://<your game>/?mp=1&ref=wss://zoomies-referee.<your-subdomain>.workers.dev
```

All players in the same race must use the **same** `ref=` URL (and they'll share a
room; add `&refroom=<name>` if you ever want isolated rooms on one deployment).
Leave `ref=` off and the game is 100% unchanged — no connection is made.

> If you'd rather bake the URL in so you don't type it every time, set a default in
> `src/net/config.js` (`resolveRefereeUrl()`), and the game will use the referee
> whenever `?mp=1` is on. It stays a no-op if the Worker is unreachable.

## Verifying it works

- `curl https://zoomies-referee.<subdomain>.workers.dev/health` → `ok`.
- In a two-device `?mp=1&ref=wss://…` race, open the browser console: you'll see the
  referee connection and `hitv` / `lapv` / `finishv` verdicts arriving.
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
