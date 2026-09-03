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

## Window, focus, fullscreen

- **Fullscreen by default.** A first launch opens fullscreen (a Steam game
  opens like a game); after that the window remembers the size and
  fullscreen state the player left it in (`userData/window-state.json`).
  `F11` or `Alt+Enter` toggles fullscreen; the game can also drive it
  through the bridge (below). The Steam Deck never fullscreens at creation
  — see the Deck section.
- **Single instance.** Hitting PLAY in Steam while the game is running
  focuses (and un-minimizes) the existing window instead of opening a
  second one.
- **Focus loss** is pushed to the renderer as `zoomies:blur` /
  `zoomies:focus` window events so the game can pause when the player
  alt-tabs away.
- **Renderer health.** If the renderer process dies (GPU driver crash, OOM),
  the shell reloads the game once; a second death in the same stretch lands
  on a plain inline error page instead of a black window or a reload loop.
  Child-process deaths and a hung renderer are logged.

Gamepads work through the standard browser Gamepad API (see the mapping
below), keyboard through the existing bindings.

## Bridge API (`window.zoomiesDesktop`)

`preload.cjs` exposes exactly this object (context isolation stays on; the
renderer never sees `require` or `ipcRenderer`). Every field is optional
from the game's point of view — the same bundle runs on the web and in
Capacitor, so feature-detect (`window.zoomiesDesktop?.deck`), never assume.

| Member | Type | Meaning |
| --- | --- | --- |
| `quit()` | `() => void` | Quit the app (the title screen's Quit button). |
| `deck` | `boolean` | `true` when the shell detected a Steam Deck / SteamOS at launch. |
| `isFullscreen()` | `() => boolean` | Current fullscreen state (synchronous IPC). |
| `setFullscreen(on)` | `(boolean) => void` | Enter/leave fullscreen (same as F11). |
| `onBlur(cb)` | `(fn) => unsubscribe` | Called when the window loses focus. Returns a function that removes the listener. |
| `onFocus(cb)` | `(fn) => unsubscribe` | Called when the window regains focus. |

Blur/focus also fire as DOM events on `window` — `zoomies:blur` and
`zoomies:focus` — for code that prefers `addEventListener`.

## Shell log

Everything the main process prints (the build/backend line, Steam init
result, renderer-gone reasons, save-bridge write failures) is appended to
`userData/logs/main.log`, capped at ~200 KB (it is cut back to its newest
half when it grows past that). `userData` is the productName folder:
`%APPDATA%\Zoomies GP` on Windows, `~/Library/Application Support/Zoomies GP`
on macOS, `~/.config/Zoomies GP` on Linux/Deck. First thing to ask a
tester for.

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
then one flow step) — every screen works without registering anything. Every
connected pad drives the menus (and can pause mid-race), so on a couch
nobody has to pass controller #1 around.

The one-action-at-a-time rule from the touch controls applies to the face
buttons too. Verified headlessly at the repo root by `npm run check:gamepad`
(stubs `navigator.getGamepads`, races, asserts every binding) and
`npm run check:menupad` (walks the menu flow + sheets on the fake pad).

## Package

```sh
npm run dist       # electron-builder → desktop/out/ (zip per OS)
```

`dist` (and `dist:deck`) first run `node ../tools/build-web.mjs
--target=desktop`, which assembles a **desktop-only `dist/`**: the game
(`index.html`, `styles.css`, `src/`, `vendor/`, `assets/`, `icon-512.png`)
without the web-only surface — no `sw.js`, `manifest.json`, PWA icons,
`viewer.html` or `/download` page. `ZOOMIES_TARGET=desktop` does the same
thing for scripts that can't pass a flag. The default (web) build is
unchanged. `tools/release.mjs` uses the desktop target too, and refuses to
run when the tag it is given doesn't match the `version` in `package.json`
here (`v0.1.1` and `0.1.1` both match `0.1.1`) — bump the version first.

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
   try-requires it at the top level (so the overlay's Chromium switches are
   applied BEFORE the app is ready, the only time they take effect) and
   calls `init()` after ready. `electron-builder.json` unpacks the module
   (and every `.node` binary) out of the asar so the native addon loads in
   a packaged build.
3. For dev launches outside Steam, put the App ID in `desktop/steam_appid.txt`
   (gitignored). Real Steam launches don't need it.
4. Upload with SteamPipe: one depot per OS containing the unpacked build from
   `out/`. Launch option = the executable, no arguments.

**Saves are already file-backed for Steam Cloud.** The game saves through
localStorage; `preload.cjs` mirrors an **allowlist of profile keys** into
`userData/zoomies-save.json` — checked every 30s and written only when the
content changed, flushed synchronously on close — and hydrates them back at
boot when the file carries a newer stamp. The keys that follow the player:

```
zoomies-profile-v1   zoomies-garage-v1   zoomies-track-v1
zoomies-timetrial-v2 zoomies-ttghost-v2  zoomies-audio-v2
zoomies-laps         zoomies-difficulty  zoomies-mode-v1
zoomies-cup-choice
```

Per-device state (quality tier, WebGL preference, fps overlay, dev/debug
flags, crash log, rumble, split-screen seat picks, track view, …) is
deliberately NOT synced — it describes the machine, not the player. The
stamp is a monotonic counter (`max(file, local) + 1` per write), not the
wall clock, so a skewed clock on one machine can't win every merge forever.
Point Steam **Auto-Cloud** at that file — root `WinAppDataRoaming`, path
`Zoomies GP/zoomies-save.json` (macOS: `~/Library/Application Support/Zoomies
GP/`; Linux: the `XDG_CONFIG_HOME` equivalent) — and cloud saves work with
no further code. (The folder is the app's productName — it moved from
`zoomies-desktop/` when the app got its real name; dev-run saves from before
that rename start fresh.)

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
start line is the couch lobby: a Players segment (2/3/4, persisted), one
compact row per seat (catalog thumbnails + a live input badge showing which
pad or keyboard drives that seat, re-dealt as pads connect), a pre-GO
warning when seats outnumber inputs, and GO pinned below the scrolling
panel so it always fits (4P used to push it off a 720p window). Each seat's
Edit runs the cat/kart card screens for that one seat and returns to the
lobby; guests pick from every preset free of charge (locks, prices and the
custom studios belong to P1's own garage flow). Layouts:
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

Runs via the linux64 depot (preferred) or Proton. Racing and the menus are
both fully pad-drivable; the remaining Verified-rating blocker is on-screen
keyboard invocation for the text fields (custom cat/kart names). The bridge
reports `zoomiesDesktop.deck === true` there so the game can adapt its UI.

Build a Deck package from any machine (the Deck is plain x86_64 Linux):

```sh
npm run dist:deck    # → out/ tar.gz with the linux build
```

tar.gz, NOT zip: browser downloads + GUI extraction strip the executable
bit out of zips (field-verified — the binary silently wouldn't launch until
a manual `chmod +x`), while tar preserves permissions.

Get the archive onto the Deck (USB stick, scp, or `npx serve desktop/out`
on the build machine and download it with the Deck's browser in Desktop
Mode), extract it anywhere (e.g. `~/Zoomies`), then in desktop Steam:
**Games → Add a Non-Steam Game → Browse** → `zoomies-desktop`. Launch from
Gaming Mode; pick the **Gamepad** controller template so the Deck presents
as a standard pad (the Gamepad API path the game already uses — press any
button once, the browser hides a pad until its first input).

The shell detects SteamOS itself (`/etc/os-release`, plus the `SteamDeck`
env belt-and-braces — Gaming Mode does NOT pass its env to non-Steam
shortcuts) and adapts: Chromium's SUID sandbox helper can't work on the
immutable filesystem (a stock launch dies at startup) so it runs
`no-sandbox` — the game only ever loads its own bundled app:// content.
The decisive fix (field-A/B'd on a real Deck) is `no-zygote`: the zygote's
children were denied shared memory (ESRCH in /dev/shm AND /tmp), killing
the renderer at birth — live app, black window, both modes — so children
spawn directly instead; `disable-dev-shm-usage` stays as belt-and-braces.
It does NOT force fullscreen (the fullscreen-by-default rule above is
skipped on the Deck): Gaming Mode fullscreens windows itself, and
fullscreen-at-creation wedged into a stuck black window.

The screen is 1280×800 — the exact viewport every headless check runs at.
Rumble under Steam Input's virtual pad may not reach Chromium's
`vibrationActuator`; treat it as best-effort on Deck.

## Smoke test

`xvfb-run -a node tools/electron-smoke.mjs` (repo root) launches THIS shell
for real via Playwright's Electron driver and asserts the app:// chain boots
the game to the title screen with the preload bridge live. `SHOT=/path.png`
grabs a screenshot. Prereq: `npm install` here.
