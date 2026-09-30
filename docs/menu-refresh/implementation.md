# Menu refresh implementation

Branch: `menu-refresh`, based on merged art refresh `c06ce70`. The [original audit](README.md) and its screenshots remain intact. [Open the refreshed gallery](review/gallery.html).

## Navigation

Race setup is now the central hub. A new player can launch with **Race → Start race**, down from six activations. Mode, track/cup, cat, and kart are independently editable from setup. Each picker returns to its caller; changing a cat no longer forces another kart choice. Track changes return to setup even after rebuilding the world.

Home now has a Garage with a live 3D preview and independent cat/kart actions. Owned/All filters shorten the roster; creators are available in the fixed picker toolbar. Cancelling a creator discards the draft. Guest garages retain their seat identity without changing the owner's saved racer.

Collection separates Cats, Karts, Creators, and Awards. Owned items equip directly; purchases show their price before charging. Settings separates Audio, Controls, Display, and Save data, remembering the last category. Installation is optional on mobile browsers.

## Pause, progress, and results

Pause offers Resume, Restart, Settings, Controls, and Home. Home parks an unfinished solo race and makes Resume its primary action. Resume returns directly to the race. Restarting, ending Versus, quitting during a race, replacing a parked race, or leaving a series requires an explicit confirmation with Cancel selected initially.

Cup progress survives Home/resume. Returning to setup after a completed round advances the series instead of replaying the scored round. Leaving a cup or daily challenge clears its active state explicitly. Daily challenges use the same classic recipe, seed, and three laps even when the device previously used a custom track.

Results include automatic, idempotent badge rewards and a fixed footer for Race again/Next race, Race setup, and Home. The separate badge-claim gate is gone. Countdown announcements are cleared on pause.

## Layout and input

Menus use native portrait orientation; driving remains landscape. Stage-relative sizing supports short landscape screens without using portrait viewport dimensions for their logical layout. Primary actions stay outside long scroll regions, including Track Maker and results. The existing cream, plum, and gold palette now has consistent cards, headers, spacing, and focus treatments.

Keyboard focus stays within the active surface and returns to the previous control. Controller navigation remembers its position, supports text inputs, and opens an on-screen keyboard for names and backup codes. Text entry uses a cancellable draft. Selected controls expose their state to assistive technology, and inactive surfaces are inert.

## Verification

The visual sweep captured 27 surfaces at 1280×800, 1440×900, 1280×720, 844×390, 390×844, and 667×375: **162 captures**, no page errors, and no measured visible controls smaller than 44×44 CSS pixels. See [measurements](review/measurements.json). Representative portrait, compact landscape, editor, setup, pause, and results captures were inspected visually.

Automated checks cover:

- Direct setup, picker return paths, creator cancellation, guest isolation, pinned actions, purchase cancellation/payment/equip, keyboard focus confinement, and portrait race/pause/results transitions (`check:menus`).
- Cup parking, continuation, cancellation, abandonment, and daily recipe isolation (`check:menu-state`).
- Controller navigation, sliders, text entry, Back handling, pause/settings layering, and automatic rewards (`check:menupad`).
- Cat/kart creator persistence, split-screen controls/cameras/results, and progression invariants.
- Offline shell caching, including the new stylesheet and UI module, and the production web build.
- A running WebGL race smoke check (`npm run check`), with no console or page errors.

These are Chromium viewport and simulated-controller checks on a Mac, not physical-device certification. Safari safe areas, browser bars, touch/soft-keyboard behavior, Steam Deck hardware and overlays, and packaged Electron/iOS behavior still warrant a hands-on pass. Results screenshots use synthetic race completion; their timings are not gameplay benchmarks.

## Reproducing

Run `npm run check:menus`, `npm run check:menu-state`, and `npm run check:menupad` for the main interaction regressions. The scripts serve isolated local instances. `npm run check:offline` checks cached startup. `npm run build:web` includes the new UI assets.

For the gallery, serve the repository at port 8080 and run `node tools/menu-audit.mjs`. It writes only `review/`. Tests also save selected captures to `after/`.
