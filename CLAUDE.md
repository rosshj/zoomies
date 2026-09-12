# Zoomies GP — working notes

## Art: curved surfaces are MOLDED, not assembled

Never build a curved object (hat, horn, cloth, shell) by stacking primitive
boxes/spheres/cylinders — the seams always read as parts stuck together. Use
the molded-surface helpers in `src/models.js` (or add new ones in that style):

- `latheDeform(profile, segs, deform)` — revolve ONE unbroken 2D silhouette
  (e.g. a hat's brim + crown + dome as a single surface), then sculpt it with
  an azimuth-aware vertex callback: brim curls, tricorn folds, ear-flap skirts
  and crown creases are carved into the same mesh. Deforms must agree at
  θ=±π (use cos/sin/|x| forms) so the lathe seam stays welded.
- `taperedTube(points, r0, r1)` — sweep a shrinking circle along a curve for
  smooth single-piece horns/tails/pipes (capped ends; pair with a DoubleSide
  material).
- `torsoRibbonGeo(...)` / `chestDecalGeo(...)` — cloth strips and painted-on
  markings whose every vertex lies on the body capsule's own cross-section
  (+small offset), so they drape/read as part of the body instead of floating.

Fit rules that keep re-appearing:
- The torso is a capsule (r 0.9, cylinder y0.61–1.39); the skull is an
  ellipsoid (≈0.81 × 0.75 × 0.75 at head-local origin). Compute clearances
  against these before placing anything.
- Neckwear bands are tilted CONES (small top, wide bottom, shifted forward)
  because a tilted plane cuts an egg-shaped body section — a straight ring
  either floats at the nape or knifes into the chest/cheeks.
- Verify every model change with a headless viewer render from the user's
  screenshot angle before regenerating `assets/catalog` and pushing.

## Anything that blows reads ONE wind field

`src/wind.js` owns the world's wind: a direction, a strength, and a gust wave
that TRAVELS along that direction. Never give a new swaying thing its own
`time.mul(k).sin()` — independent clocks read as a pile of unrelated twitching
instead of weather, and the whole point is that one gust lays the grass over,
then reaches the treeline a beat later.

- `windLean(px, pz, amp)` → world-XZ lean vec2 for something rooted at that
  world position. `amp` is a FRACTION OF THE OBJECT'S OWN HEIGHT, so the same
  number bends a blade of grass and an oak through the same angle.
- `windBendNode(amp)` → a ready-made `positionNode` for planted, instanced
  things. Needs `aBend` per vertex (bake with `bakeBendWeights(geo)`) and
  `aWindRoot` per instance = (world x, world z, instance height scale) — the
  world XZ is where the gust wave gets sampled, the scale turns a
  fraction-of-height lean into world units.
- `windGustDrift(px, pz, amp, jitter, lift)` → world-XZ(+Y) drift for AIRBORNE
  motes (tumbleweed, spindrift, litter, petals). They are carried, not bent:
  the gust shoves them downwind and they ease back as the front passes. Keep
  them anchored to a home point — a mote that translates forever has to wrap,
  and the wrap always shows.
- On a `MeshStandardMaterial`, `userData.sway = amp` is enough: `toToon` sees
  it and wires `windBendNode` into the toon material it builds. Add
  `userData.swayMaxStr = k` to cap the force THAT material feels (stiff trees
  don't track a gale one-for-one — the canopies cap at 1.45 so storm seeds,
  where `uWindStr` reaches 2.4, firm the lean instead of thrashing the crown).

Bending rules that keep re-appearing (the grass got both wrong first):
- Offsets are fractions of the object's own height, never fixed world units —
  a fixed push uproots small instances and stretches them.
- Weight by height² so the base stays planted, and drop the tip by s²/2 so the
  shape bows over instead of growing.
- Per-instance attributes mean the geometry must be CLONED off any shared
  cache (`_foliageGeoCache` hands the same geometry to every batch).
- On an InstancedMesh, three folds the instance matrix into `positionLocal`
  BEFORE a material's `positionNode` runs. So `positionLocal.y` is the vertex's
  WORLD height (squaring it for a bend weight throws the object out of the
  world — this is what "the grass flies everywhere" actually was), and an
  offset added to `positionLocal` is already in WORLD space, so do NOT rotate
  it by the instance yaw. Take heights off `positionGeometry` instead.

## Verification loop for art changes

1. `node --check src/models.js`
2. One-off probe in `tools/` (Playwright + `/opt/pw-browsers/chromium`,
   SwiftShader args, `viewer.html?webgl=1&plain=1`, drive `window.__viewer`),
   screenshot to the scratchpad and LOOK at it.
   For world/scenery motion the probe has to PIN THE CAMERA — the race loop
   moves it through `camera.position.copy` + `camera.lookAt`, so neutering
   those two freezes the shot (see `tools/wind-probe.mjs`), and only a frozen
   shot tells a lean apart from a camera drift. Adaptive quality also HIDES the
   grass outright at SwiftShader framerates; force `visible` back on.
3. `node tools/catalog-shots.mjs` when presets/models changed.
4. `npm run check` (+ `node tools/progress-check.mjs` if the economy changed),
   `node tools/build-web.mjs`, then commit + push.

## Found racers are GENOMES; the atlas is a pure function of (x, y)

`src/genome.js` grows a cat or kart from a seed string (continuous genes, not
a pattern id); `src/atlas.js` grows a track recipe + resident from a cell
coordinate. Both are pure and node-testable (`npm run check:atlas`), and the
whole point is determinism: a friend's `?atlas=4,-2` must regrow the identical
place and cat with no server. Never draw from `Math.random` or the shared world
stream inside them, and never let a saved profile store anything a genome
already implies — the profile keeps regrowable stubs `{kind, seed, biome}`.

Rules that keep re-appearing:
- `createCat` / `createKartModel` read `opts.genome`. Anything that MOVES A
  VERTEX (body proportions, accessory flair, kart blends) must be folded into
  the merged-geometry cache keys (`bodyKey(g)` for cats, `genomeKey(g)` for
  karts) — the `_geoCache` hands one baked body to every racer with the same
  key, so a missed key means six racers silently share one cat's silhouette.
  Coat textures key on `genomeKey(g)` for the same reason.
- Accessory extras are built in the accessory's own frame BEFORE the flair
  pose (tilt / yaw / backwards / scale about the contact point), then baked
  with `applyMatrix4` into the static cluster — still one draw per material.
- Track archetypes live in `ARCHETYPES` (`src/track.js`): sections multiply
  the HIGH harmonics only (the lap's rhythm), `lobes` scale the low ones (the
  silhouette), width follows the archetype, and only `classic`/`figure8` may
  self-cross. A cell's knob RANGES per archetype live in `src/atlas.js`
  (`ARCH_KNOBS`) — keep both when adding one, and add it to the random sweep
  in `tools/track-audit.mjs`.
- Verify genome/atlas changes by LOOKING: `node tools/genome-probe.mjs`
  (contact sheet), `node tools/archetype-probe.mjs` (loop shapes),
  `node tools/atlas-probe.mjs` (the whole explore → win → name → hatch loop).
