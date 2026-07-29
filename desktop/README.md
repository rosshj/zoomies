# Zoomies GP — desktop shell (Steam)

An Electron wrapper around the same `dist/` bundle the web deploy and the
Capacitor apps use. Nothing about the game changes: `tools/build-web.mjs`
assembles `dist/`, and this shell serves it over a private `app://` scheme
(file:// can't load ES modules) with the service worker disabled — a desktop
build is already offline-complete.

## Run it locally

```sh
# from repo root: assemble dist/, then launch the shell
cd desktop
npm install
npm start          # runs build:web first; `npm run start:fast` skips it
```

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

The one-action-at-a-time rule from the touch controls applies to the face
buttons too. Verified headlessly by `npm run check:gamepad` at the repo root
(stubs `navigator.getGamepads`, races, asserts every binding).

## Package

```sh
npm run dist       # electron-builder → desktop/out/ (zip per OS)
```

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

Wire-up points once the App ID exists: achievements map onto the unlock
events in `src/progress.js`, and Steam Cloud wants the save moved from
localStorage to a real file (bridge it through `preload.cjs`).

Known caveat: the **Steam overlay** frequently fails to render inside
Electron. `main.cjs` calls `electronEnableSteamOverlay()` best-effort, but
treat the overlay as unsupported — nothing in the game may depend on it.

## Steam Deck

Runs via the linux64 depot (preferred) or Proton. For a Verified rating the
blockers are full controller support in the MENUS (racing already has it —
the menu flow still needs stick/d-pad navigation) and on-screen keyboard
invocation for the multiplayer room-code field.
