# Hand-off: finishing the procedural art refresh (PR #64)

Audit date 2026-09-29. Start from the current head of `codex/procedural-art-refresh`
(fast-forwarded from `claude/graphics-audit-6zbovd`). The audit found and fixed the
blocking bugs; what remains is design work that belongs to the branch author.

## Ground rules

- Run `npm run format` before every commit. CI rejects unformatted code.
- Every step below names the check that proves it. Run it before pushing.
- Screenshots go in the PR description, never in the tree (the 64 MB of gallery
  PNGs were removed for this reason; the READMEs name the images they refer to).
- Do not rewrite branch history. The PR will be squash-merged.
- The working notes in `CLAUDE.md` still apply: curved surfaces are molded with
  `latheDeform` / `taperedTube`, and everything that blows reads the one wind field.

## Already done (do not redo)

- Shelter bake clones shared geometry before writing (`src/world-shelter.js`);
  `tools/runtime-art-check.mjs` asserts the cached canopy stays untouched.
- Road-prop hulls are at most 64 points (`src/road-prop-assets.js`);
  `tools/biome-props-check.mjs` asserts it.
- Hovering crates recheck their hull every 12th frame; paint, material and geometry
  caches dispose on eviction; dead code and the style 6 to 4 save remap are gone.
- `tools/progress-check.mjs` reports the full priced roster and asserts one unlock
  gate per catalog entry.

## Work plan, in order

### 1. Economy: earned unlocks instead of treat prices

Intent: the 26 added cats (`cat.14` to `cat.39`) and 24 added karts (`kart.10` to
`kart.33`) are earned by playing, not bought. Each new accessory is available in the
Custom Cat creator only once the cat that wears it is unlocked; the wardrobe shows a
locked item with that cat's name. The original 14 cats, 10 karts and their 14
accessories keep today's behaviour.

Gate kinds. Two exist: `cup` (win the named cup at any difficulty) and `diff` (win
any cup at that difficulty or harder). Add:

- `cup` + `diff` together: win the named cup at that difficulty or harder. Derivable
  from the trophy record, which already keeps the best difficulty per cup.
- `stat`: a career counter threshold, e.g. `{ stat: "wins", min: 5 }`. Existing
  counters: `races`, `wins`, `winsHard`, `winsNight`, `driftBoosts`, `slipSeconds`,
  `milkTrips`, `heartSaves`, `boxes`, `dailies`, `racesCustom`, `treatsEarned`.
- `biomeWin`: win a race whose start line is in the named biome. Needs a new
  `winsByBiome` counter written where `wins` is incremented.
- New counters: `propsKnocked` (each knockable prop hit) and `versusRaces` (each
  finished split-screen race).

Migration: a profile that already bought a new cat or kart on the playtest build keeps
it unlocked (existing rule: never brick a save). Unknown ids still read as unlocked.

Checks: replace the reported total in `tools/progress-check.mjs` with assertions that
no `cat.14+` or `kart.10+` entry carries a price, every accessory `acc.*` gate names
an existing cat, every `biomeWin` names a real biome, every `cup` names a real cup,
and prices still climb for the original ladders. `check:cat-roster` and
`check:kart-roster` must still pass.

The table below was approved by Ross on 2026-09-29. Treat it as the spec.

### 2. Gate the bakes by quality tier

`bakeWorldShelter` ignores world detail and casts 24 rays per receiver vertex over
405k vertices on a city world (2.3 to 2.8 s of a 4.1 to 4.5 s build on the SwiftShader
container). Scale ray count and receiver set by detail in `src/world-shelter.js`. In
`src/baked-lighting.js` key the per-building bake on the generator parameters, not a
hash of every vertex, so randomly sized buildings hit the cache. Print build time in
the boot console line. Target: city world under 1.5 s at Medium in the container.
Check: `check:baked-lighting`, `check:runtime-art`, `tools/baked-world-check.mjs`.

### 3. Cache fitted cats

Ear-slot cutting, headwear fit and paw sculpt run on every `createCat` before the
geometry-key cache is consulted (`src/models.js`). Warm build went from 2.2 ms on
main to 9 to 10 ms, beanie 38 ms. Move the fitted result behind the cache. Target:
under 4 ms average, beanie under 10 ms. Check: `check:art`, `check:accessories`.

### 4. Consolidate materials

A six-racer field went from 46 to 81 distinct materials: two ear materials per fur
colour, one painted material per accessory colour, one livery material per kart.
Share ear materials across furs by painting the colour, and use one atlas material per
accessory kind. Target: back near 46. Check: `check:materials`, `check:art`.

### 5. Re-mold the stacked accessories

Duck (seven stacked spheres), frog eyes (four stacked spheres each), propeller dome
(sphere wedges plus torus plus cylinder) and the space-helmet earcup (two overlapping
spheres) violate the molded-surface rule in `CLAUDE.md`. Rebuild them with
`latheDeform` and `taperedTube` the way fedora, collar bell and headphones were. Fix
`taperedTube`'s inward winding at source in `src/models.js` and remove the index-flip
wrapper in `src/cat-accessories.js`. Check: `check:accessories`, viewer screenshots
from front, side and top.

### 6. Dress alpine and tundra again

The alpine roster in `src/biome-dressing.js` allows only chalets, so seed 4242's start
straight lost the village `main` had. Add a village cluster type to alpine and tundra.
Confirm the six-point snow star particles are intended. Check: `check:biomes`,
`check:scenery`, a race screenshot on seed 4242.

### 7. Unify the art checks

The roster, accessory and UI checks default to a native Chrome path and require the
WebGPU backend. Make them accept the SwiftShader container path and a WebGL fallback
like `check:art` and `check:materials`, so every `check:*` runs where `CLAUDE.md` says.

### 8. Small items

`impact()` in `src/props.js` builds a throwaway group per prop impact and allocates a
fresh world hull each time; pool both.

## Unlock table (approved)

Gate columns: `cup` and `diff` as in `src/progress.js` today; `stat` is a career
counter and threshold; `biomeWin` is a race win in that biome. Each new cat also
unlocks its accessory.

| Id | Name | Accessory | Gate |
| --- | --- | --- | --- |
| cat.14 | Timber | dragon | biomeWin volcanic |
| cat.15 | Fjord | viking | biomeWin tundra |
| cat.16 | Marple | detective | stat winsNight 3 |
| cat.17 | Duchess | crown | cup zoomies, diff hard |
| cat.18 | Russet | scarf | biomeWin autumn |
| cat.19 | Winston | tophat | stat treatsEarned 2000 |
| cat.20 | Pudding | mushroom | biomeWin forest |
| cat.21 | Pebble | rain | biomeWin wetlands |
| cat.22 | Crumpet | straw | biomeWin lavender |
| cat.23 | Marshmallow | unicorn | cup meadows, diff hard |
| cat.24 | Chai | lei | biomeWin beach |
| cat.25 | Skipper | pirate | cup sandypaws, diff hard |
| cat.26 | Opal | catEye | stat driftBoosts 100 |
| cat.27 | Orbit | space | all four cups won (existing cup-sweep test) |
| cat.28 | Fizz | bee | biomeWin blossom |
| cat.29 | Noodle | mustache | stat races 50 |
| cat.30 | Saffron | sombrero | biomeWin desert |
| cat.31 | Dumpling | duck | stat heartSaves 10 |
| cat.32 | Clover | frog | biomeWin jungle |
| cat.33 | Rumpus | bandana | stat propsKnocked 100 |
| cat.34 | Yoshi | propeller | stat slipSeconds 200 |
| cat.35 | Inky | shark | stat winsNight 10 |
| cat.36 | Dapple | charm | biomeWin savanna |
| cat.37 | Quicksilver | cone | biomeWin city |
| cat.38 | Stripes | ski | cup meowtain, diff hard |
| cat.39 | Flurry | shells | biomeWin alpine |
| kart.10 | Club Racer | | stat races 5 |
| kart.11 | Club Cobalt | | stat wins 5 |
| kart.12 | Sprint | | stat driftBoosts 25 |
| kart.13 | Sprint Citrus | | stat driftBoosts 150 |
| kart.14 | Shifter | | stat wins 3 |
| kart.15 | Shifter Frost | | stat winsHard 3 |
| kart.16 | Endurance | | stat races 25 |
| kart.17 | Endurance Gold | | stat races 100 |
| kart.18 | Rental Pro | | stat dailies 3 |
| kart.19 | Rental Orange | | stat dailies 15 |
| kart.20 | Vintage Racer | | stat racesCustom 1 |
| kart.21 | Vintage Ivory | | stat racesCustom 20 |
| kart.22 | Dirt Oval | | cup meadows |
| kart.23 | Oval Scarlet | | cup meadows, diff expert |
| kart.24 | Flat Tracker | | cup sandypaws |
| kart.25 | Tracker Slate | | cup sandypaws, diff expert |
| kart.26 | Rallycross | | cup meowtain |
| kart.27 | Rally Arctic | | cup meowtain, diff expert |
| kart.28 | Crosskart | | cup zoomies |
| kart.29 | Crosskart Lime | | cup zoomies, diff expert |
| kart.30 | Dune Racer | | stat boxes 100 |
| kart.31 | Dune Copper | | stat propsKnocked 250 |
| kart.32 | Streamliner | | stat versusRaces 1 |
| kart.33 | Stream Azure | | all four cups won at hard or better |

Biomes not used as a gate: meadow (the starter) and mesa.

## After the plan

Ross tests on the phone: a corner with five or more biome props piled up, city track
load time, and a long session with heavy garage browsing. Then the PR description is
updated with the audit outcomes and the gallery zips, and PR #64 is squash-merged.
