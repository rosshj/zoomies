# Zoomies GP — desktop shell (Steam)

An Electron wrapper around the same `dist/` bundle the web deploy and the
Capacitor apps use. Nothing about the game changes: `tools/build-web.mjs`
assembles `dist/`, and this shell serves it over a private `app://` scheme
(file:// can't load ES modules) with the service worker disabled — a desktop
build is already offline-complete.

## Run it locally

```sh
cd desktop
npm install        # first time only
npm start
```

Dev launches serve the WORKING TREE directly (same as the headless checks),
so a `git pull` is live on the next `npm start` — no build step, no stale
`dist/` to bite you. `dist/` only exists for packaging.

The shell pins the game to its **WebGL2 backend** (`webgl=1`): Electron's
WebGPU swap-chain on macOS interleaves stale frames into the present queue
(frame-by-frame analysis of a screen recording showed the live view
alternating with ~37s-old frames — the reported "menu flicker"). Retest
WebGPU on a newer Electron with `ZOOMIES_QUERY=webgpu=1 npm start`.

`F11` or `Alt+Enter` toggles fullscreen. Gamepads work through the standard
browser Gamepad API (see the mapping below), keyboard through the existing
bindings.

## Controller mapping (standard/Xbox layout, `src/input.js`)

| Control | Action |
| --- | --- |
| Left stick / d-pad ◀▶ | steer (analog, same expo curve as tilt) |
| RT / LT | accelerate / brake–reverse (analog) |
| A | hop, hold to drift |
| X | hold to charge, release to shoot |
| B | boost |
| Y | milk |
| LB or RB | shield (hold) |
| Start | pause / resume |

In the menus the pad navigates too (`src/menupad.js`): stick/d-pad moves a
focus ring spatially between buttons, A activates, B backs out (sheets first,
then one flow step) — every screen works without registering anything.

The one-action-at-a-time rule from the touch controls applies to the face
buttons too. Verified headlessly at the repo root by `npm run check:gamepad`
(stubs `navigator.getGamepads`, races, asserts every binding) and
`npm run check:menupad` (walks the menu flow + sheets on the fake pad).

## Package

```sh
npm run dist       # electron-builder → desktop/out/ (zip per OS)
```

(`--linux dir` gives the unpacked build; the binary is named
`zoomies-desktop` after the package. Smoke-test a packaged build with
`EXE=desktop/out/linux-unpacked/zoomies-desktop xvfb-run -a node
tools/electron-smoke.mjs` — it exercises the packaged resources path.)

Build on (or cross-compile for) each Steam depot platform: win64 is the one
depot Steam requires; a native linux64 depot is worth shipping for Steam Deck
(Electron runs there natively; the Windows build under Proton also works).

## Steam integration

The shell boots fine with no Steam present. To light Steam up:

1. Pay the one-time [Steam Direct](https://partner.steamgames.com/steamdirect)
   fee ($100 per app), create the app, note the **App ID**.
2. `npm install steamworks.js` in this directory — `main.cjs` already
   try-requires it and calls `init()`.
3. For dev launches outside Steam, put the App ID in `desktop/steam_appid.txt`
   (gitignored). Real Steam launches don't need it.
4. Upload with SteamPipe: one depot per OS containing the unpacked build from
   `out/`. Launch option = the executable, no arguments.

**Saves are already file-backed for Steam Cloud.** The game saves through
localStorage (`zoomies-*` keys); `preload.cjs` mirrors those keys into
`userData/zoomies-save.json` every 5s and flushes synchronously on close, and
hydrates them back at boot when the file carries a newer stamp (so a
cloud-synced file from another machine wins over an older local profile,
never the reverse). Point Steam **Auto-Cloud** at that file — root
`WinAppDataRoaming`, path `Zoomies GP/zoomies-save.json` (macOS:
`~/Library/Application Support/Zoomies GP/`; Linux: the `XDG_CONFIG_HOME`
equivalent) — and cloud saves work with no further code. (The folder is the
app's productName — it moved from `zoomies-desktop/` when the app got its
real name; dev-run saves from before that rename start fresh.)

The window remembers its size and fullscreen state across launches
(`userData/window-state.json`).

**Rumble** works out of the box: the web platform adapter routes the game's
discrete haptic moments (spin-outs, landings, boosts) to the connected pad's
`vibrationActuator`, so no Steam API is involved.

Remaining wire-up once the App ID exists: achievements, mapped onto the
unlock events in `src/progress.js`.

Known caveat: the **Steam overlay** frequently fails to render inside
Electron. `main.cjs` calls `electronEnableSteamOverlay()` best-effort, but
treat the overlay as unsupported — nothing in the game may depend on it.

## Smoke test

`xvfb-run -a node tools/electron-smoke.mjs` (repo root) launches THIS shell
for real via Playwright's Electron driver and asserts the app:// chain boots
the game to the title screen with the preload bridge live. `SHOT=/path.png`
grabs a screenshot. Prereq: `npm install` here.

## Steam Deck

Runs via the linux64 depot (preferred) or Proton. Racing and the menus are
both fully pad-drivable now; the remaining Verified-rating blocker is
on-screen keyboard invocation for the text fields (multiplayer room code,
custom cat/kart names).
