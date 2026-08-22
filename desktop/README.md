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

## Versus (2–4P split screen)

Desktop-only mode (the card appears when the shell bridge is present). The
start line has a Players segment (2/3/4, persisted) plus a pick tile per
seat; each extra seat can also run the full cat/kart card screens. Layouts:
2P = two stacked full-width rows (P1 on top); 3P = quadrants with the free
bottom-right corner showing an enlarged shared minimap; 4P = four quadrants
with the shared map on the centre crosshair. Humans + AI always total the
same six-kart field as solo.

Controllers: pads are dealt in seat order (P1 first); the first seat left
without a pad gets the keyboard (full bindings, same as solo). So 4P wants
three pads + keyboard, or four pads.

Perf posture: the post stack (bloom/god rays/grade) is bypassed in split —
N scene passes replace one scene pass + post — shadows render once per frame
for all views, and at 3-4 seats the per-view far plane is reined in (1800)
and the backing DPR capped at 1.5 (per-pane sharpness matches solo at a sane
fill bill). The dynamic resolution scaler stays in charge of the total frame
cost. The optional "Versus effects" toggle (per-view post) applies to 2P
only. No treats are paid in Versus; the podium is the prize. Verified
headlessly by `npm run check:split` (2P flow: independence, placement,
finish grace, DNF results) and `node tools/split34-check.mjs` (3P/4P:
quadrant cams/HUD, seat picks, input dealing, lean posture).

## Steam Deck

Build a Deck package from any machine (the Deck is plain x86_64 Linux):

```sh
npm run dist:deck    # → out/ zip with the linux build
```

Get the zip onto the Deck (USB stick, scp, or `npx serve desktop/out` on
the build machine and download it with the Deck's browser in Desktop Mode),
extract it anywhere (e.g. `~/Zoomies`), then in desktop Steam:
**Games → Add a Non-Steam Game → Browse** → `zoomies-desktop`. Launch from
Gaming Mode; pick the **Gamepad** controller template so the Deck presents
as a standard pad (the Gamepad API path the game already uses — press any
button once, the browser hides a pad until its first input).

The shell detects Gaming Mode's `SteamDeck=1` env and adapts itself:
Chromium's SUID sandbox helper can't work on SteamOS's immutable filesystem
(a stock Electron launch dies at startup), so it runs `no-sandbox` there —
the game only ever loads its own bundled app:// content — and it starts
fullscreen. Testing from Konsole in Desktop Mode without that env: launch
with `--no-sandbox` by hand.

The screen is 1280×800 — the exact viewport every headless check runs at.
Rumble under Steam Input's virtual pad may not reach Chromium's
`vibrationActuator`; treat it as best-effort on Deck.

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
