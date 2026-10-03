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

## Verification loop for menu / CSS changes

Menus are plain HTML in `index.html` plus `styles.css`, `menu-refresh.css`
and `menu-components.css`; game state stays in `main.js`, shared DOM behaviour
in `src/menu-ui.js`. Put structure in the markup, not in boot-time DOM moves.

1. `npm run check:menus`, `check:menu-state`, `check:menupad` (browser checks;
   each serves the repo itself). `check:menupad` times its presses in real
   frames, so under SwiftShader a slow frame can double-register a held
   direction — a one-off failure there is worth a rerun before a fix.
2. For a stylesheet refactor, prove it visually neutral instead of eyeballing:
   `STYLE_DUMP=before.json npm run menu:gallery` on the old tree, the same with
   `after.json` on the new one, then `npm run menu:style-diff -- before.json
   after.json` (every element's computed style + rect on every surface and
   viewport; `--by-rect` ignores pure markup reordering).
3. Every browser tool gets a `check:*` / `menu:*` script in package.json;
   node-only checks also go in `.github/workflows/checks.yml`.

## Track features: test them in the playground first

`playground.html` + `src/playground.js` is the sandbox for anything that
lives ON the road (like `viewer.html` is for assets): tiny loops authored as
explicit control points (`new Track({ mode: "points", points, biomes,
features: [] })`), the real `Kart`, the real `props.js` runtime. Areas are
data in `src/playground-areas.js` — stations are given in track coordinates
(`t`, `lateral`) and resolved against the built loop, so add a station there
rather than hand-plotting world XZ.

- Breakable structures (`src/breakables.js`) are ASSEMBLIES: a structure is
  its pieces at rest, and a hit releases every piece as its own PropPhysics
  body (so tyres roll off and become obstacles, the awning sails, fruit
  scatters). Pieces are registered as `dormant` props up front and skipped by
  every loop until `breakStructure` lets them go; `props.reset()` re-docks
  them. Author art at 1u ≈ 1m and set `spec.scale` — the kart is ~2u per
  metre, and unscaled furniture reads as toys next to it.
- Scenes are PROCEDURAL: `BREAKABLES` recipes = a generator (`stall`,
  `stack`, `seating`, `cart`, `heap`, `pallets`, `rack`) + params + size
  (0/1/2), and `BIOME_SCENES` says which recipes a biome scatters along its
  kerbs in a race (props.js `build`, after the road props; never counted in
  the 64-prop budget). Stacks and piles reuse shipped road-prop art, so a new
  biome flavour is usually one recipe line, not new art. Intact scenes draw
  as one merged proxy per structure; pieces only render once broken.
- A build-time placement needs its `roadIndex` from a GLOBAL nearest-sample
  scan (`nearestIndex` in props.js), never from `physics.locate` seeded with
  0: locate is a LOCAL window search, and a wrong index lets the fence
  containment shove a body across the infield onto the other straight (this
  was "the luggage cart vanished").
- Karts are solid to loose props (`collideKart` in props.js: sphere vs the
  kart's box, pushed out and bounced, carrying the kart's velocity). The
  swept-segment fling is the arcade "hit" for props at REST only; a prop
  already tumbling gets a blended shove, and nothing above the bonnet line is
  swept at all (a 2-D sweep re-launched falling pieces as the kart passed
  under them — "they seem to get hit again").
- Ramps/humps are `SurfaceFeatures` (`src/track-surface.js`): a height
  profile in the road's frame that `Track._projResult` adds to `groundY`, plus
  a mesh built from the same profile. The kart goes airborne when the road
  falls away faster than gravity (`Kart._integrate`, `RAMP_KICK`) — the
  generator's smoothed hills never trip it (`check:breakables` asserts this).
- `npm run check:breakables` (node) and `npm run check:playground` (browser)
  after touching any of this; `tools/playground-check.mjs` drives the areas
  through `window.__playground` (`freeze` + `step` for deterministic probes,
  `pin` to park the camera for a screenshot).
