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

## Landscape-only (Info.plist — do this once)

The JS-side orientation lock only engages once the game boots; the app itself
must declare landscape-only so the SPLASH already comes up landscape (launching
while holding the phone upright otherwise started portrait until a relaunch).

In Xcode: **App target → General → Deployment Info** → check **Landscape Left**
and **Landscape Right**, uncheck **Portrait** and **Upside Down**. (Equivalent
to setting `UISupportedInterfaceOrientations` to just the two landscape values
in `ios/App/App/Info.plist`.)

## App icon & splash screen

`tools/gen-icons.mjs` (the same script that draws the web icons) also emits the
native sources into `resources/`: `icon-only.png` (1024², the web app's cat) and
`splash.png` / `splash-dark.png` (2732², the cat mark on the theme navy so the
splash blends into the app's first frame). They're committed, so normally you
don't regenerate them.

To install them into the Xcode project (on the Mac, after any regeneration or
on first setup):

```bash
npx @capacitor/assets generate --ios --assetPath resources
```

(The npm package is the scoped `@capacitor/assets`; its binary happens to be
called `capacitor-assets`, but npx must be given the package name.)

That writes the full AppIcon + Splash asset catalogs into
`ios/App/App/Assets.xcassets`. Rebuild in Xcode and both the home-screen icon
and the launch screen update.

## TestFlight

TestFlight is the **slow lane** and that's fine — its job is testing the native
experience (haptics, splash, orientation, launch feel), not daily gameplay
iteration. Gameplay/levels/graphics iterate through the **fast lane**: the web
deploy, where playtesters get every push instantly at the URL. Cut a TestFlight
build when the native layer changes or every week or two.

One-time setup:

1. [App Store Connect](https://appstoreconnect.apple.com) → My Apps → **+** →
   New App: platform iOS, bundle ID `app.thea.zoomies` (must match Xcode),
   SKU anything (e.g. `zoomies`), name "Zoomies GP" (or claim your preferred
   store name now — names are first-come).
2. In Xcode, add to `ios/App/App/Info.plist`:
   `ITSAppUsesNonExemptEncryption` = `NO` (the app uses only standard HTTPS,
   which is exempt — this skips the export-compliance question on every upload).
3. Xcode → set the run destination to **Any iOS Device (arm64)** →
   Product → **Archive** → in the Organizer window, **Distribute App** →
   App Store Connect → Upload (defaults are fine).
4. App Store Connect → your app → TestFlight tab: the build appears after a
   few minutes of processing. Add yourself + friends under **Internal Testing**
   (up to 100 Apple IDs, no review, instant). Testers install via the
   TestFlight app from the email invite.

Every build after that is just: bump the build number in Xcode (General →
Build), Archive, Upload. Internal testers get it as soon as processing
finishes — usually minutes, no re-review.

## Roadmap from here

Sequenced so each step de-risks the next:

1. **Device perf spike** — run the shell on a real iPhone, profile FPS. Confirm
   the three.js **WebGL2** fallback is the guaranteed target and treat WebGPU in
   the iOS web view as a bonus, not a dependency.
2. **Native chrome** — adopt `platform.ready()` in `main.js` boot (landscape
   lock, status-bar hide, splash dismiss) and route steering through CoreMotion,
   retiring the `DeviceOrientation.requestPermission()` / HTTPS dance.
3. ~~**Bundle the CDN deps**~~ — done. `ably` / `partysocket` are vendored
   under `vendor/net/` (single-file ESM bundles built by `npm run vendor:net`),
   mirroring the vendored three.js. No runtime CDN fetches on any platform; a
   full Vite migration wasn't needed and stays optional (minification/TS,
   should we ever want them).
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
