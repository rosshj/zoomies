# Zoomies GP — gameplay backlog

## ✅ Shipped: progression v1 (see src/progress.js)
Treats (🐟) earned per race (placement + moments, capped) · garage unlocks with a
starter set (grandfathered saves) · 15 achievements over career stats · 4 solo cups
(points series over fixed seeds; trophies record best difficulty; first win pays
treats + a cup-exclusive unlock money can't buy) · daily challenge seed (+100 once
a day) · Cat-alog screen (treats, trophy shelf, achievements, stats) · backup codes
(ZP1. token, Settings → Progress) · dev mode (?dev=1 or 7 taps on the Settings
title: grant treats, unlock all, reset; __zoomies.dev in the console).
Future lanes from the design chat: cloud sync + paid cosmetics (needs receipts /
server-side entitlements), weekly featured cup, reward-box ceremony.

Design decisions from the "fun but fair" brainstorm. Guiding principles: reward
skill/expression, always give counterplay, no RNG "gotchas", and keep catch-up
*helping the back* without punishing the leader or rubber-banding. Existing
catch-up tools already in the game: position-weighted item rolls, slipstream
(+ overcharge). Keep those in mind so new mechanics don't double up or fight them.

---

## ✅ Shipped: Laser + Nine Lives (PR #48) — design record

> **Laser removed (July 2026):** in play it was never obvious when you were
> using it — the beam + steering-jitter read too subtly. Pulled from the item
> roll and the code; the design record below stays for a possible rebuild with
> clearer feedback (a real dot on the victim, sound, screen shake).

### Laser item (offense with a receiver's choice)
- **Delivery:** a laser mounted on the FRONT of the kart, active for a few seconds
  after you use it. Short-range **front lock** onto the kart directly ahead — you
  have to *close in* to zap, so it's not a cross-map snipe (and can't be a
  leader-punishes-the-pack tool).
- **Effect (the important part — NOT a spinout):** while zapped, the target's
  steering goes **wobbly / pulled** (their cat is distracted by the dot on its own
  kart). They can still drive and recover — it's a *soft* disruptor, funny and
  annoying, not a hard stun.
- **Why it's fair + fun:** it forces a real decision on the *receiving* end — eat
  the wobble and keep your speed but fight the wheel, OR pop the shield to stabilize
  but bleed momentum. Genuine risk/reward, not a coin flip.
- **Tuning knobs that decide the feel:** duration (~a couple seconds — enough to
  matter, not oppressive) and range/lock (short front range so the zap is *earned*).
- Rolls from a power-up box like other items (inherits the position-weighting).

### Nine Lives (box power-up, damage-mitigation)
- **Acquire:** rolled from a power-up box like other items — so trailing karts get
  it more often *for free* via the existing position-weighted rolls (no separate
  catch-up logic needed).
- **HUD:** a **heart pip** lights up when you're holding one (same pattern as the
  milk-bottle button appearing when held). Stack a **few** (2–3, shown as pips) so
  "nine lives" flavors it without making you unkillable.
- **Effect:** on your next spinout, **auto-consume one heart** and downgrade the
  wipeout to a quick flip-and-wobble — keep most of your speed + control, "mrrp,"
  back in it. **No boost, no offense** — purely softens a hit. That's what keeps it
  fair: it caps how badly one item can wreck your race without ever helping you pull
  ahead.
- Auto + inventory-based → zero new input to learn.

---

## 🔖 Parked — future updates

### Parry shield (timed reflect)
- Turn the existing shield into a skill tool: activate it at the *exact* moment an
  incoming yarn/hairball is about to connect and it **reflects** back at the shooter;
  shield early/late and you just block (or eat it).
- **Solves "you can't see behind you":** you don't parry by looking — you react to
  the telegraphs already on the HUD. The **rear-threat indicator** (amber when
  someone's aiming, red-pulse when locked & firing) and the **incoming-yarn ping**
  (flashes ~1s before impact) *are* the parry window. Also makes those HUD elements
  more meaningful.
- All skill, no RNG; gives defense real counterplay against offense.

### Style / flow meter (mid-pack scrum reward)
- A streak that builds from skilled, in-the-pack play and trickles into your boost
  charge (or a small top-speed edge) while it's "hot"; **decays on a crash/spinout**
  and while cruising untouched.
- **Framing (important):** this is a *reward for fighting through traffic*, NOT a
  catch-up mechanic — the very back is already covered by item weighting + slipstream.
- **Anti-snowball design (the whole trick):** feed it from **adversity, not the lack
  of it**:
  - Fast fill: slipstream tucks, overtakes, near-misses with rivals — none of which
    the lonely leader can do.
  - Slow fill: drifting — the one thing the leader *can* farm, so it can't carry the
    meter alone.
  - So the **pack** earns the most; the lonely leader earns little.
- **Don't lock out the lonely ends:** add low-weighted **solo** sources — clean
  drifts + near-misses with walls/props (threading tight sections without crashing) —
  so a dropped-off player (and the leader) still earn a modest baseline while alone.
- **Caveat:** this is the *fuzziest to tune* of the batch — build it LAST, after the
  laser + lives are in and feeling good.

---

## ❌ Considered & rejected (so we don't re-litigate)

- **Hop-trick landings** ("always lands on its feet" → clean landing = boost):
  conflicts directly with drifting, where landing *sideways* is the point.
- **The Zoomies** (self-managed speed burst with twitchy steering): we already have
  plenty of boost mechanics (drift charge, toot + slipstream overcharge) — no room.
- **Skill-gated shortcuts** (risky alternate lines): too big a change for now;
  revisit later, pairs well with the custom-track generator when we do.
