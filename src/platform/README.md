# `src/platform/` — the web ↔ native capability seam

This directory is the **only** place web and native (iOS/Android) are allowed to
diverge. Everything else in `src/` is shared game code that runs byte-for-byte
identically on every target. That's what keeps the web and iOS builds at parity:
divergence is confined here, by construction.

## The contract

`getPlatform()` returns a single adapter for the current runtime:

```js
import { getPlatform } from "./platform/index.js";

const platform = await getPlatform();
platform.name        // 'web' | 'ios' | 'android'
platform.isNative    // false on web, true in a Capacitor shell
await platform.ready();          // boot-time native chrome (no-op on web)
platform.haptics.impact();       // buzz on hit
await platform.orientation.lock("landscape");
platform.purchases.available;    // false until StoreKit/RevenueCat is wired
```

Two implementations satisfy that contract:

- `web.js` — plain web APIs; the reference behaviour native must match.
- `native.js` — Capacitor plugins via the injected `window.Capacitor.Plugins`
  bridge (no bundler needed; a web build never loads this file). Each plugin is
  optional-guarded: not-yet-installed → no-op.

`index.js` detects the runtime (`window.Capacitor`) and hands back the right one.

## The one rule

**Game code never branches on platform.** No `if (iOS)` in `kart.js`. If you feel
the urge, that's the signal to add a capability to the adapter contract and give
it a `web.js` and a `native.js` implementation instead. Follow that rule and
parity is automatic — there is only ever one game.

## Adopting it (incrementally)

Nothing imports this yet, so it's inert scaffolding — safe to land without
touching the running game. Wire capabilities through it one at a time:

1. **Boot chrome** — `await (await getPlatform()).ready()` early in `main.js`
   boot. On native this locks landscape, hides the status bar, and dismisses the
   splash; on web it's a no-op.
2. **Haptics** — call `platform.haptics.impact()` where the game reacts to a hit
   / pickup. Real taptic feedback on iOS, silent elsewhere.
3. **Motion/steering** — today `input.js` reads `DeviceOrientation` directly.
   The native win is feeding steering from CoreMotion (via `@capacitor/motion`
   or a small native bridge) behind a `platform.motion` capability, so iOS drops
   the fragile `requestPermission()`/HTTPS dance. Add it here, then switch
   `input.js` to read from the adapter.
4. **Purchases** — implement `platform.purchases` against RevenueCat (see
   `../../IOS_SETUP.md`) and gate premium levels/cats on entitlements.
