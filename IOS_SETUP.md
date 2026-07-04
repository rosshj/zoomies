# iOS + web from one codebase

Zoomies ships to the web **and** the App Store from this single repo. The web app
in `src/` is the one source of truth; iOS (and later Android) are thin
[Capacitor](https://capacitorjs.com/) shells that load the *same* build. Develop
once, run everywhere, stay at parity.

This branch lays the foundation. It is deliberately **non-destructive**: the
existing web game, service worker, and Vercel deploy are untouched. What's new is
additive scaffolding.

## What's in place now

| Piece | What it does |
| --- | --- |
| `tools/build-web.mjs` | Assembles a clean `dist/` (the shared web build both platforms load). Dependency-free. |
| `capacitor.config.json` | Capacitor config; `webDir: "dist"`, app id `app.thea.zoomies`. |
| `src/platform/` | The web ↔ native capability seam — the only place the platforms differ. See its README. |
| `package.json` scripts | `build:web`, `cap:sync`, `ios`, `android`. |

No native project folders are committed yet — `ios/` is generated on a Mac (below),
because it needs Xcode + CocoaPods, which don't run in this Linux dev container.

## First-time iOS setup (on the Mac, once)

```bash
npm install                      # installs Capacitor + plugins (reconciles the lockfile)
npm run build:web                # assembles dist/
npx cap add ios                  # generates the ios/ Xcode project (Mac only)
npx cap sync ios                 # copies dist/ into the app + installs native plugins
npm run ios                      # opens Xcode → pick a simulator/device → Run
```

Then every iteration is just:

```bash
npm run cap:sync                 # rebuild dist/ and push it into the native shell
```

In Xcode: set the **Team** to *Thea Apps Inc.* and confirm the **bundle
identifier**. `app.thea.zoomies` is the chosen id — change it here
*before* the first App Store Connect submission if you want something different,
since it's fixed once submitted.

## Before you commit `ios/`

Capacitor apps normally commit the `ios/` folder (it holds native config). The
`.gitignore` already excludes the heavy/generated bits (`Pods/`, `DerivedData/`,
the synced `public/` web copy). Generate it on the Mac, then commit it there.

## Roadmap from here

Sequenced so each step de-risks the next:

1. **Device perf spike** — run the shell on a real iPhone, profile FPS. Confirm
   the three.js **WebGL2** fallback is the guaranteed target and treat WebGPU in
   the iOS web view as a bonus, not a dependency.
2. **Native chrome** — adopt `platform.ready()` in `main.js` boot (landscape
   lock, status-bar hide, splash dismiss) and route steering through CoreMotion,
   retiring the `DeviceOrientation.requestPermission()` / HTTPS dance.
3. **Bundle the CDN deps** — `ably` / `partysocket` load from `esm.sh` today.
   Move to a bundler (Vite) so both targets consume the identical, locally
   bundled dependency graph. `build-web.mjs` is a drop-in slot for this — Vite
   replaces it and keeps `webDir: "dist"`.
4. **Monetisation** — add `@revenuecat/purchases-capacitor`, implement
   `src/platform/*` `purchases`, gate premium levels/cats on entitlements
   (free = 1 level + default cats). RevenueCat fronts StoreKit *and* Google Play
   Billing, so this is one integration for both stores.
5. **Android** — `npx cap add android` from the same `dist/`. The web netcode is
   identical on both, so cross-platform multiplayer (the stretch goal) comes
   nearly for free.

## Why this shape

- **Parity is structural, not manual.** One game build (`dist/`) feeds every
  platform; only `src/platform/` has two implementations.
- **The web game is never at risk.** Root files and the SW-based PWA keep working
  exactly as before; native is purely additive.
- **Claude Code stays fast.** It's all JS/three.js — one stack, quick edit→reload,
  no engine rewrite.
