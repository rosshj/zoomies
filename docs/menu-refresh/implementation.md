# Menu refresh implementation

Branch: `menu-refresh`, based on merged art refresh `c06ce70`. The [original audit](README.md) remains as the baseline record. Representative captures of the refresh are in [samples/after/](samples/after/); the full 194-capture gallery is regenerated into `review/` (gitignored) with `npm run menu:gallery`.

## Navigation

Race setup is now the central hub. A new player can launch with **Race → Start race**, down from six activations. Mode, track/cup, cat, and kart are independently editable from setup. Each picker returns to its caller; changing a cat no longer forces another kart choice. Track changes return to setup even after rebuilding the world.

Home now has a Garage with a live 3D preview and independent cat/kart actions. Owned/All filters shorten the roster; creators are available in the fixed picker toolbar. Cancelling a creator discards the draft. Guest garages retain their seat identity without changing the owner's saved racer.

Collection separates Cats, Karts, Creators, and Awards. Owned items equip directly; purchases show their price before charging. Settings separates Audio, Controls, Display, and Save data, remembering the last category. Installation is optional on mobile browsers.

## Pause, progress, and results

Pause offers Resume, Restart, Settings, Controls, and Home. Home parks an unfinished solo race and makes Resume its primary action. Resume returns directly to the race. Restarting, ending Versus, quitting during a race, replacing a parked race, or leaving a series requires an explicit confirmation with Cancel selected initially.

Cup progress survives Home/resume. Returning to setup after a completed round advances the series instead of replaying the scored round. START CUP and the results' "Race N of M" reload into the next seed and start that race themselves once the world is built (the race veil covers the build; on iOS, where motion access needs a tap, the veil asks for one tap instead of a trip through Home and setup). In Cup mode the setup's track card is a fixed preview that pages through the series' tracks; cups are chosen from Mode → Cup Series. Opening the cup, track or mode list never prompts; committing to a different cup, track or mode while a series or the daily is live does, and re-choosing the current one returns to setup with the run intact. Daily challenges use the same classic recipe, seed, and three laps even when the device previously used a custom track.

Results include automatic, idempotent badge rewards and a fixed footer for Race again/Next race, Race setup, and Home. The separate badge-claim gate is gone. Countdown announcements are cleared on pause.

## Layout and input

Pre-race menus and results use native portrait orientation; driving and pause remain landscape. On laptops and desktops every flow screen past Home caps its body (1120px for the two-column setup, garage, studios and track builder; 900px for the mode, track, cup, rivals, length and players lists) and centres it under the full-width header, as Collection and Settings already do; phone layouts are below those widths and unchanged. Stage-relative sizing supports short landscape screens without using portrait viewport dimensions for their logical layout. Primary actions stay outside long scroll regions, including Track Maker and results. The existing cream, plum, and gold palette now has consistent cards, headers, spacing, and focus treatments.

Keyboard focus stays within the active surface and returns to the previous control. Controller navigation remembers its position, supports text inputs, and opens an on-screen keyboard for names and backup codes. Text entry uses a cancellable draft. Selected controls expose their state to assistive technology, and inactive surfaces are inert.

## Verification

The visual sweep captured 28 surfaces at 1280×800, 1440×900, 1280×720, 844×390, 390×844, and 667×375: **168 captures**, no page errors, and no measured visible controls smaller than 44×44 CSS pixels. The per-capture measurements are written to `review/measurements.json` when the gallery is regenerated. Representative portrait, compact landscape, editor, setup, pause, and results captures were inspected visually.

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

The narrower browser checks are `check:studio`, `check:track-builder`, `check:racer-details`, `check:preview-rotation`, `check:track-portrait`, `check:menu-consistency` and `check:menu-followup`; every tool serves the repository itself. `npm run gen:track-previews` regenerates the bundled track stills after a featured recipe or world-art change.

For the gallery run `npm run menu:gallery` (it writes only `review/`, which is gitignored). Tests also save selected captures to `after/`. For a stylesheet refactor, run the gallery with `STYLE_DUMP=before.json` on the old tree and `STYLE_DUMP=after.json` on the new one, then `npm run menu:style-diff -- before.json after.json`: it compares every element's computed style and rect on every captured surface and viewport.


## Device feedback revision

The notched-iPhone screenshot exposed a double safe-area inset on floating header actions. Actions now belong to the active header's flex layout, so Back, title, balance, and Settings share one row. The visual pass standardizes the system sans-serif type scale, dark header and toolbar surfaces, compact utility buttons, card borders, and selected states. The gallery now simulates 59px top and 34px bottom portrait safe-area insets and asserts that header actions neither overlap titles nor escape the header.

Pause keeps the driving orientation. Motion sampling is disabled outside countdown/racing; resume recalibrates the current grip, and calibration clears stale steering output. `node tools/tilt-menu-check.mjs` covers motion isolation, fresh neutral, preserved steering sensitivity, and calibration reset. These checks do not reproduce physical iPhone motion sensors; driving feel still needs device verification.


## Filled-menu and Home revision

Home now separates a compact brand lockup, a large two-line headline, the primary Race action, a secondary Garage card, and a quiet utility grid. The web shell is captured separately to verify the Get the app layout as well as the desktop Quit layout.

Menu emoji are replaced with original filled SVG pictograms from `src/menu-icons.js`, including dynamically rendered rewards, currency, mode cards, and settings. The module preserves existing DOM event handlers and text inputs while decorating changing labels. Menu surfaces and selected segments use solid fills rather than stacked borders and shadows; focus outlines remain available for keyboard/controller navigation.

The visual audit additionally rejects visible menu emoji. The refreshed gallery includes 168 captures. Interaction and controller navigation regressions were rerun after this revision.


## Map and control sizing

Race setup gives the track map a full panel beside controls in landscape and above them in portrait. The higher-resolution canvas retains readable route strokes and landmarks. Compact landscape spacing preserves the primary action; extra Versus controls scroll independently. Menu buttons share rounded rectangular corners, including selected segments and Settings tabs.

Settings option groups use explicit grid columns. In portrait, labels sit above full-width groups so Graphics and Frame rate choices stay inside the card. Audio retains its label, toggle, and slider layout. Narrow 320px screens stack setup option labels and reduce Settings card padding while retaining 44px targets.

The visual sweep now adds 320×568 setup and Display captures to the six-device gallery (170 total). Regression assertions check map visibility, the pinned Start action, and segmented controls staying within their containers and viewport.


## Racer previews on setup

The setup map yields space to two visual picker cards for the selected cat and kart. Each uses the existing catalog artwork, a compact name caption, and a direct picker action. Portrait keeps the images above the race options; short landscape switches to compact horizontal cards. Images use contain sizing to preserve the full silhouette. The map remains visible, and Start stays pinned on narrow screens.

Setup audit checks now require both preview images to load and remain at least 60×60 CSS pixels, alongside map and control bounds checks. The menu interaction regression covers changing either selection and returning to setup.

For setup-only visual iterations, `npm run menu:gallery -- --setup-only` refreshes setup and Versus captures and retains the other validated gallery measurements.


## Summary-first setup and a combined racer portrait

Race setup presents Mode, Track, Length, and Rivals as compact current-value cards. Length and Rivals open dedicated pickers; selecting a value saves it and returns to setup, while Back leaves the selection unchanged. Difficulty descriptions reflect the AI table's pace, shot frequency, shielding, and catnip behavior. The selected choice exposes its pressed state and receives initial keyboard/controller focus.

A single cat-in-kart portrait replaces the two catalog images. `src/racer-portrait.js` renders the actual race models, mounting pose, colours, livery, number, breed, and accessories into a cached canvas whenever the selected appearance changes. It uses a small lazy WebGL renderer and renders only on selection changes; no extra animation loop runs during racing. Stale queued selections are skipped, and temporary model resources are disposed after each snapshot.

The setup visual pass includes both drill-in screens at all six viewport sizes (182 gallery captures total). Interaction checks cover choosing difficulty/laps, Back without changes, and portrait updates when changing the cat; controller checks cover initial selection focus and A/B return paths. Cup/daily and offline checks cover state preservation and the new portrait module.


## Picker widths and mode-first setup

Mode now precedes the map in the document order and sits above it on both portrait and landscape layouts. The remaining Track/Cup, Length, and Rivals choices share equal flexible columns; hidden controls no longer reserve an empty slot. Mode, Track, Cup, Rivals, and Length pickers share safe-area-aware outer gutters, with no extra inner padding or arbitrary width cap on the detail lists.

The setup audit now captures Single Race, Cup, and Time Trial layouts, checks equal-width summary choices against both row edges, and verifies that Mode precedes the map. Picker checks ensure each list fills the shared gutters. The gallery includes 194 captures after adding Cup and Time Trial setup at six viewport sizes.


## One track entry point and consistent setup spacing

The map card is now labelled “Track” with a gold chevron and opens the appropriate track/cup picker. The duplicate Track/Cup summary button and the reward, duration, and descriptive text below the racer are removed. Changing a running cup or daily track still uses the existing confirmation path.

Setup uses a shared 12px card gap (8px in short landscape). Portrait lays out the visible cards at their natural height, with the map taking the remaining space and Start outside the scroll area. Empty summary rows collapse, including Time Trial and an in-progress cup. Interaction checks now use the map as the track entry point.
