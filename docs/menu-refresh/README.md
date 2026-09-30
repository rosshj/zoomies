# Menu refresh audit

Baseline: `c06ce70` (merged art refresh), branch `menu-refresh`. Audit performed September 29, 2026. No gameplay or menu implementation changes in this pass.

## Recommendation

Make **Race Setup** the central menu, using the existing start-line scene. Show the current mode, track/cup, racer, and race options together, with a persistent Start button. Open focused pickers from these rows and return directly to setup. Keep Garage and Collection available from Home. A player should never have to revisit cat and kart selection merely to change race mode or track.

Keep the refreshed 3D art, cream cards, purple panels, gold primary action, input cues, and existing saved-setup shortcut. The largest improvement is navigation and state behavior, followed by responsive composition—not replacing all the visual styling.

## Evidence and limits

The browser audit walks real click handlers through title, settings, help, collection, mode, cups, tracks, Track Maker, cat and kart selection, setup, a running race, pause, pause settings, parked-race return, results, and badge claims. Results use the existing `debugFinish()` hook; race timings and placement in those screenshots are synthetic. A second pass enables a simulated desktop bridge and custom-item ownership for desktop menus, custom editors, name selection, and the four-player lobby.

Captured CSS viewports:

| Target | Viewport | Notes |
| --- | --- | --- |
| Steam Deck layout | 1280 × 800 | Chromium on Mac; desktop bridge simulated in the second pass |
| MacBook layout | 1440 × 900 | CSS pixels, not panel hardware pixels |
| Laptop | 1280 × 720 | Shorter desktop layout |
| iPhone landscape | 844 × 390 | Layout emulation, not Safari/device verification |
| iPhone portrait | 390 × 844 | Game rotates an 844 × 390 stage |
| Small phone landscape | 667 × 375 | Constrained width and height |

Browse the [screenshot gallery](gallery.html). The 138 screenshots and measured element sizes are in this directory. The JSON records scrollable descendants, not the root overlay itself; an empty scroll list does not prove that results fit without scrolling. Browser resizing does not reproduce iOS browser bars, safe-area values, software keyboard, touch scrolling, Steam overlay, real gamepad hardware, or Electron behavior. These require device follow-up. The source review also covers daily and cup transitions, installation help, purchases, backup/restore, advanced settings, and Track Viewer; these are not all end-to-end device-tested. Native portrait menus are a design recommendation, not current behavior.

Reproduce with `python3 -m http.server 8080`, then `node tools/menu-audit.mjs`; use `DESKTOP=1 node tools/menu-audit.mjs` for the simulated desktop/editor pass. This writes screenshots and JSON measurements using the repository's existing browser launcher. Each run uses an isolated browser profile.

## Current information architecture

| Surface | Purpose and exits | Main friction |
| --- | --- | --- |
| Home/title | Let's Go, Collection, Help, Settings; platform install/download/quit; Resume if a solo race is parked | Let's Go changes destination based on saved state; no explicit setup/mode shortcut |
| Mode | Single Race, Cup, Time Trial, Daily; Versus in desktop shell | Mandatory on first setup, several Back presses away afterward |
| Track / Cup | Select and advance; Track Maker at the end of track grid | Track change may reload the world and always routes through racer selection |
| Cat → Kart | Select owned item, buy/unlock, or enter custom editor | Two sequential screens even for a one-field change; large mixed owned/locked lists |
| Cat Studio / Kart Shop | Steppers, swatches, naming, randomize, buy/use | Many serial clicks; custom items at the end of long grids; no direct Home garage |
| Start line | Racer Edit, map Edit, laps, rivals, prize, Start | Mode is implicit; map Edit opens Track Maker, not track library; Back goes to kart |
| Versus lobby | Player count, per-seat edit, input assignment, Start | Per-seat editing repeats cat → kart; long lobby; all pads share navigation focus |
| Collection / Cat-alog | Prizes, badges, trophies; purchases and claims | Overlaps garage inventory; long scroll; purchase does not mean equip |
| Settings | Audio, display, controls, progress import/export, advanced tools | One long mixed-purpose page; controls below graphics explanations |
| Help / Install | Instructions and close | Help already follows active input; platform extras crowd Home |
| Pause | Resume, Settings, tilt bar on web/mobile, optional Track Viewer, Main Menu, desktop Quit | No restart; unclear exit consequences; utility/debug controls mixed into primary flow |
| Results | Standings, earnings, Next Race when applicable, Race Again, Main Menu | Tall card, actions below earnings on phones; no direct Change Setup |
| Badge claim | Tap each reward, then Continue | Extra mandatory exit screen; hidden Back shortcut claims all |
| Track Viewer | Free camera plus exit to pause | Keep an advanced tool, outside normal player navigation |

Important existing behavior: saved mode **and** saved garage enable Home → Start line, so returning players already avoid the five-step wizard. Preserve this. A new player's normal launch is six activations: Let's Go → mode → track → cat → kart → Start. From setup, changing mode uses four Back presses before the new choice; choosing mode/track/cat/kart and starting brings that route to nine activations. These counts exclude scrolling, controller focus movement, purchases, and load delays.

## Prioritized findings

### P1 — Navigation does not preserve the user's editing context

`flowBack()` has a fixed predecessor table: startline → kart → cat → track/cup → mode. `startline-edit` enters cat without recording a return destination. Pressing Back from that edit opens track/cup instead of cancelling back to setup. Selecting a cat forces a kart choice before committing. Track selection similarly resumes at cat, including after a page reload.

**Change:** give every picker an explicit origin, draft, commit, and cancel. Setup → Cat → select → Setup; Setup → Kart → select → Setup; Setup → Track → select → Setup. Put Mode and Track/Cup controls directly on setup. Preserve per-seat draft isolation.

Evidence: `src/main.js` `flowGo`, `flowBack`, `chooseTrackCard`, `openRacerStep`, `startline-edit`; `index.html` `flow-startline`.

### P1 — “Main Menu” has inconsistent consequences

`toMenu()` parks an unfinished solo race, tears down Versus, and calls `clearCupRun()`. A cup race can retain its physical race while its series state is cleared. The same label hides these differences. Home's Resume then returns to the pause card, requiring another Resume activation. Desktop Quit directly calls the shell bridge.

**Change:** distinguish **Resume**, **Restart race**, **Race Setup**, and **End race**. Preserve a cup run when inspecting settings/setup; make abandoning it explicit. Confirm actions that actually discard race/series progress, and say what will be lost. Make Home's Resume resume directly, with a short countdown if needed. Do not add confirmations to ordinary navigation.

Evidence: `src/main.js:2920` onward (`toMenu`, `resumeParkedRace`), pause markup, desktop quit wiring.

### P1 — Results hide the next action on short screens

At 844 × 390 the initial results viewport shows standings and the start of earnings; Race Again and Main Menu are below the fold. The whole overlay scrolls, unlike setup's pinned Start button. Badge rewards then add another mandatory screen. Escape/Back claims all on that screen, but the visible text tells users to tap every badge individually.

**Change:** pin a results footer containing Next Race / Race Again, Change Setup, and Home. Put standings and earnings in the scrollable body. Present earned badges within results and offer one Collect All action, or bank them automatically with a celebration. Preserve idempotent reward settlement.

Evidence: `screenshots/iphone-landscape-results.jpg`; `index.html` results/claim markup; `showClaimScreen`, `claimScreenBack`, `settleRaceRewards`.

### P1 — Race announcements can draw over pause

The audit pauses as soon as the race enters the racing state. The frozen “GO!” announcement remains above the pause card and overlaps Resume. This is a specific countdown-transition reproduction, not a claim that every pause is obscured.

**Change:** hide transient race announcements while any blocking menu is open and define overlay stacking centrally. Verify countdown pause, regular pause, settings over pause, finish, and Track Viewer separately.

Evidence: `screenshots/iphone-landscape-pause.jpg` and other pause captures; `pauseGame`, `#countdown` / announcement styling.

### P2 — Phone layout is scaled desktop UI rather than a distinct composition

Cat selection always uses five columns; the expanded roster gives 41 picker cards. In landscape the cat list's measured scroll body is 1,446px for a 332px viewport. Portrait rotates the same logical stage but uses physical `vh`/`vw`: its cat list grows to 2,270px despite the same 844 × 390 stage. Setup narrows from viewport-based width and truncates the racer summary; portrait lap buttons measure 39px wide. Racer Edit is 38px high across captured sizes.

**Change:** base layout on the menu container, not physical viewport units. Use fewer columns and larger art in compact layouts, with Owned / All filters and an immediately reachable Custom action. Give touch actions at least a 44 × 44 CSS-pixel target as a product acceptance target. Keep primary actions pinned and one main scroll region. Longer term, let menus use native portrait layout while keeping racing landscape; separate the menu shell from the rotated game stage.

Evidence: `measurements.json`; phone cat/setup screenshots; `.racer-grid`, `.racer-tap`, `.start-side`; `layoutStage`.

### P2 — Settings makes common tasks expensive

The landscape phone settings body is 1,180px tall in a 332px viewport. Audio and part of Graphics occupy the first screen; Controls and Progress are much farther down. Descriptions include renderer internals, shadow maps, motes, and effect stacks. The pause menu exposes Tilt bar even in a desktop browser because it is hidden by the desktop bridge rather than input capability.

**Change:** use Audio, Controls, Display, and Save Data categories; default to the last category used, or Controls when opened from a control-help action. Show concise player outcomes such as “Better battery life”; expand technical detail only when requested. Preserve Help's existing active-input adaptation and extend capability-based visibility to settings and pause. Keep advanced tools separate.

Evidence: settings screenshots, `index.html:985` onward, platform visibility rules in `main.js`.

### P2 — Visual hierarchy is attractive but inconsistent

Cream picker cards and purple setup/settings panels have a cohesive identity. Pause/results retain older dark cards and large orange headings. Small uppercase, widely tracked labels and 11–12.5px descriptions compete with detailed moving backgrounds. Track library thumbnails are route diagrams, so they underuse the biome art. The large MacBook start-line preview works well, but its small map is detached from the setup controls. On phones cat portraits shrink while price/unlock copy occupies much of each card.

**Change:** share panel, header, button, spacing, focus, and typography tokens across setup/pause/results. Use a stable scrim beneath text and quieter scenery behind dense sheets. Show a biome thumbnail with a small route overlay for tracks. Put Track beside Mode and Racer in setup. Use clear selected, owned, locked, and focused states without relying only on color. Reserve gold for the primary action; retain personality through art and restrained animation.

Evidence: MacBook setup, phone cats, settings, pause, results, and mode screenshots. Contrast ratios were not instrumented in this audit.

### P2 — Input navigation needs semantic state, not only geometry

MenuPad provides useful spatial navigation, slider adjustment, input hints, and automatic scrolling. It defaults to the first non-chrome button or gold action, rather than the saved selection, and its ring is a CSS class rather than DOM focus. Its candidates exclude text fields/textarea. Names have a controller-friendly picker, but track seeds and backup codes still need text-entry handling. Toggle/segment markup often communicates state only with classes/text, and sheets lack a consistent dialog/focus lifecycle.

**Change:** seat focus on the selected item; restore it to the invoking control on close. Make the active surface inertness/focus boundaries explicit and align keyboard, controller, and assistive semantics. Use `aria-pressed` for toggles and proper group labels. Provide an on-screen-keyboard route for controller text entry. In Versus, define whether one player owns setup focus or each seat can edit independently. Contextual button hints should describe actions available on the current surface.

Evidence: `src/menupad.js` `_seatDefault`, `_candidates`, `_setFocus`, `_scope`; settings/editor markup. Screen-reader behavior and real Steam keyboard integration remain untested.

## Proposed structure and interaction budget

Home exposes **Race**, **Garage**, **Collection**, and compact Settings/Help. If a race or cup is active, **Resume race / Continue cup** is the primary action, with its track and progress stated.

Race opens the existing cinematic setup screen. Its editable summary contains Mode, Track/Cup, Racer (Cat + Kart), and race options. Daily uses a fixed recipe, and Versus adds player seats/input status. Each picker returns to this screen; no step counter is needed. Garage supports Cat/Kart tabs, owned filtering, previews, and custom editing without starting race setup. Collection focuses on unlock progress, badges, trophies, and reward discovery; owned items offer Equip or Open Garage.

| Task | Current | Target |
| --- | --- | --- |
| First race with defaults | 6 activations | 2: Race → Start |
| Returning race unchanged | 2 | Preserve 2, with explicit setup summary |
| Change mode from setup and race | 9 on normal full route | 3: Mode → choice → Start (cup may need cup selection) |
| Change just cat and race | 4: Edit → cat → kart → Start | 3: Cat → choice → Start |
| Resume parked race from Home | 2 | 1, with readable re-entry/countdown |
| Leave results with N badge claims | N + 2 visible actions | 1–2, independent of badge count |

Pause should show Resume, Restart, Settings, and a clearly named setup/end action. Results should offer the next likely action first and keep it visible on every supported size. Keep installation/download affordances in a compact platform area rather than competing with Race.

## Delivery order and acceptance criteria

1. **Navigation/state:** introduce explicit navigation origins and draft commit/cancel; turn start line into setup; expose mode/track directly; make cat/kart edits independent; preserve saved setup, cup/daily links, and per-seat state.
2. **Pause/results:** fix announcement stacking; define restart/abandon/park rules by mode; pin action footers; consolidate badge collection. Verify rewards cannot be paid twice.
3. **Responsive shell and visual system:** container-based sizing, phone composition, shared panels and typography, compact-height layout, safe-area handling. Decide native portrait menus before large CSS rewrites.
4. **Inventory/settings/input:** owned filters, direct custom editor entry, grouped settings, contextual controls, focus restoration, controller text entry.

Release checks: complete the primary flows at all six viewport sizes; no horizontal clipping; Start/Resume/Next visible without scrolling; touch targets meet the chosen 44px minimum; no announcement or input crosses modal boundaries; Back returns to the actual caller; all settings can be reached with keyboard/controller; changing one field preserves all others; reload preserves the draft destination; settings never unpauses a race; cup/daily progression and reward settlement remain correct; 2–4-player editing preserves other seats. Follow with real iPhone Safari/native and Steam Deck checks, including browser chrome, notch, soft keyboard, held inputs, reconnects, and overlay/background transitions.

## Validation results

- Both visual-audit runs completed: 96 standard captures and 42 simulated desktop/editor captures, with no captured JavaScript page errors. These are layout/flow observations, not a performance certification.
- `node --check tools/menu-audit.mjs` and `git diff --check` passed.
- Existing `node tools/menupad-check.mjs`: first attempt timed out during navigation while another rendering pass was active. The isolated retry exercised controller and keyboard navigation, sliders, settings, countdown pause/resume, results, and claim-all successfully, but failed the “menu container never scrolls sideways” assertion. Do not treat the full check as passed.
- That assertion waits six rendered frames for a 440ms transition; on native rendering six frames need not mean the transition has ended. Its diagnostic does not include the measured offsets. Investigate animation timing versus persistent scroll before classifying this as a product defect; retain it as an unresolved baseline check for implementation.
- No physical-device checks, contrast measurements, screen-reader tests, or full cup/daily campaign runs were performed.
