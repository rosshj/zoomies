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

## Road edges: barriers and verges are a per-span PLAN

`src/track-edges.js` plans what lines each side of the road per sample
(`track.edges[side][i] = { style, verge, vergeW }`): the biome's stock
barrier (scenery.js `BARRIER_STYLES`) most of the way, with the biome's own
alternatives from `BIOME_EDGES` for 60-160u spans (rock faces, boulder rows,
hedges, snow banks, adobe, concrete, tyre walls, hay, logs, sandbags, basalt
columns) and runoff verges (`VERGE_KINDS`: sand/gravel/mud/snow/grass) on
some spans. Swept kinds are drawn by `Track._buildWalls` off the kerb's
profile (hMul/wMul + paint); discrete kinds stand on a low sill and are built
in `buildEdgeExtras` as instanced meshes per world cell. The plan uses its own
rng stream (`seed|edges`) so it never shifts the scenery's random draws.

- The kart asks the track, not the mesh: `track.barrierAt(proj)` gives the
  style's `scrub` (what a scrape costs; a hedge is soft, rock is not) and
  `bounce` (tyres/concrete kick back); `track.dragAt(proj)` gives the verge's
  drag when the wheels are on it. Stub tracks without those methods still
  work (`check:sim`).
- Side 0 of the plan is the +lateral side (dirSign 1 in `_buildWalls`);
  `config.edges` spans use "right" for it and "left" for side 1. Steer + is
  LEFT, which is NEGATIVE lateral.
- A loop's `t` at the start of a straight is still inside the bend's tangent:
  teleport a probe a little way into the straight before measuring anything
  that depends on holding a lane.
- The playground's "Road edges" area lines every barrier kind down the left of
  its first straight and every verge down the back straight.
- The painted edge line (`Track._buildEdgeLines`) follows the EDGE OF THE
  TARMAC: out with a bay's extra, in past a verge's wobbly inner edge, eased
  over ±3u. Every bit of road paint is an overlay (renderOrder 1, no depth
  write → the polygonOffset bias); a line buried under the verge at the same
  height with depth writes on showed through as a flashing, jagged seam.

## The race carries the playground's kit

A set track keeps its shape; everything the tour proved goes on it: the
per-span edge plan (barriers + verges), two bays per town zone with a
composed place in each (plus the odd rural one), biome props in PAIRS at the
kerb (a group never swallows the next crate slot — every third slot is a
power-up crate the checks count on), and the tour's scenery density:
`main.js` passes `buildWorld` a `density` by quality (1.3 / 2.0 / 2.4; the
tour runs 2.6 on a short loop with one kart). Surface features (jumps) stay
playground-only. The headless race check prints draw calls and CPU ms —
2.0 cost ~60 draw calls over density 1 and no CPU on the sample lap.

## The biome tour is the per-biome test bench

`?area=tour&biome=<name>` in the playground builds a small loop entirely
inside ONE biome with everything it owns packed along the kerbs (every
breakable recipe, every road prop, every alternative barrier down the left,
every verge down the right, leaf piles on leafy biomes) and the game's real
scenery around it via `buildWorld(group, track, { density: 2.6, compact })`
— `density` multiplies the roadside / tree / rock / critter / flyer
placements, `compact` confines the world-wide scatters to the loop's extent.
Weather, wind and the surface debris the tyres kick up follow the kart as in
a race. Switching biome disposes and rebuilds the area.

- Scenery props live on render LAYER 1 (set pieces on 2) so the race's mirror
  can skip them: any new camera must `layers.enable(1)` and `(2)` or every
  hill looks bare while the census says the cows are there (this cost an
  hour).
- Keep the middle of the road clear: scenes sit 8-10u off the centre line,
  props 10-12u, both alternating sides; only the kart's own line is empty.

## Bays (lay-bys): the road widens where establishments stand

`planBays` in `src/track-edges.js` widens the road on one side for 66-90u
spans (`track.bays`, `track._extra[side][i]` = extra half-width per sample)
and `buildBays` paves the apron. A bay is SHALLOW and GRADUAL: 5-6.5u of
extra half-width, smoothstep tapers 40% of the span at each end (max slope
~20°), a flat `plateau` of 13-18u in the middle. The first version (12-15u
deep, 8u tapers) was a bite out of the road: driving in meant a wall at the
end and the barriers around the cut read as broken. Everything that assumed
a constant half-width reads the extra: `_buildWalls` / sand trim / verges /
`buildEdgeExtras` step out with it, `Kart._integrate` widens its
containment, `PropPhysics.resolve` widens its fence, and
`track.distanceToCenter(x, z)` is BAY-AWARE (it subtracts the extra on the
query's side), so every scenery guard of the form `distanceToCenter < halfW
+ k` keeps lamp posts, tufts and signs off the apron without knowing about
bays. Bays are planned in the roadside builder's TOWN zones (every other of
six angular zones — where the houses are) plus the odd rural one, on their
own rng stream.

- A bay hosts a PLACE, not an object: `BIOME_SCENES` lists `cluster`
  recipes (`PLACE(...)` in breakables.js — a greengrocer's front, a café
  terrace, a fish dock, a garage yard) that compose the single recipes with
  DRESSING (chalkboard out front, barrel at the back, planter, bench, sacks,
  a wagon wheel LEANING on the end — never standing dead on edge). Parts lie
  along the kerb in order with a hand's gap and a little stagger; `at:
  frontLeft/frontRight/sideRight` hangs a part off the lead. Scene +z is the
  BACK (barrier side); props.js turns side-1 scenes round so counters face
  the road on both sides. Stacks are never perfect: pyramids sit skew with
  one rolled off, columns lean a touch per course with the last one fallen
  beside them. The single recipes stay in `BREAKABLES` for the viewer and as
  parts.
- Scenes are fitted to a bay by FOOTPRINT (`sceneInBay` in props.js):
  `makeBreakable` centres the scene on its real bounds and reports `along`
  (scene x, down the road) and `across` (scene z); the size shrinks until
  `across <= depth + 2` and `along <= plateau + 4`, and the scene stands with
  its back a step off the widened edge, never more than 2u proud of the old
  kerb line. The playground's layout hands props.js the BAY (`{ kind, bay,
  size }`), not a spot, so the tour tests the same rule a race uses. Tour
  road props come in GROUPS of three at the kerb between bays, not one every
  few metres.
- The tour plans a bay every 78u (`bays: "tour"`); the other playground
  areas pass `bays: false`. A stub track (the node fixtures) has no `bays`:
  props.js falls back to kerb scenes (any of the biome's places when none is
  `rural`) so `check:biome-props` still sees one.

## Loose props never ride along with the kart

Two things carried a piece: the swept hit's re-shove (after its 0.4s
cooldown a tumbling crate within 4u was shoved straight AHEAD at less than
kart speed, caught again, and hopped down the road for as long as the
throttle was held) and `collideKart` pushing a piece whose centre was inside
the kart's box out by only a radius a frame. Now the SWEEP only hits pieces
at rest (asleep or all but stopped); anything in motion is the body's
problem: `collideKart` pushes an inside centre all the way out to the face,
and the nose is a BUMPER whose normal leans to the side the piece is on
(more the further off-centre) and a little up, so a piece being bulldozed
slides off continuously — the drag pressing it into the bumper has a
sideways share every frame. Never add a timer-and-kick: shedding a piece
"after 0.35s" read as it jumping out sideways for no visible reason. The
roof sheds, the contact spin is capped (9 rad/s). `check:playground` drops
a piece on a moving kart and wedges one into its nose; both must be off it
within a second with no sudden impulse.

- Piles are CLOSE-PACKED (`closePack` in breakables.js): a triangular lattice
  base and the rest nestled in the hollows at r·(1+√(8/3)); beach balls and
  floats are `single`-layer. Lying-cylinder pyramids put the axis ACROSS the
  scene (pitch only): with yaw too the bales lined up end to end and read as
  one column.
- A stub track (the node fixtures) has no `bays`: props.js falls back to kerb
  scenes so `check:biome-props` still sees one.

## Held upright, a race is a HANDHELD (the stage has two frames)

`layoutStage` in `main.js` decides the stage frame from the state, the
viewport and how the phone is held (`input.heldLandscape` from gravity, the
viewport when the sensors are silent). Sideways is the landscape stage as
before (a portrait viewport is counter-rotated). Upright in a race
(COUNTDOWN / RACING / PAUSED, solo, Portrait racing setting on) is
`#stage.handheld`: the canvas covers only the top `--view-h` of the stage
(`stageState.VH`; the renderer, composer, shaft target, camera aspect and the
DRS pixel budget all size off VH, not H), `#handheld-shell` is the panel's
body below it, and `styles.css`'s `#stage.handheld` block moves the HUD onto
the panel (status strip, throttle left, minimap centre, action fan right,
steer bar bottom; pause button, power-up pills and the rear-threat/yarn
warnings stay over the view). The camera widens (`stageState.fovScale`,
~75° across whatever the aspect) so the view is not a keyhole.

- The hold follows the sensors LIVE, mid-race included — never latch it (a
  latch ignored a real turn of the phone: the race stayed sideways reading
  the sideways tilt axis while the player held it upright, which read as
  the centre gone haywire). What keeps a steering lean from flipping the
  frame is the detector in `input.js`: a change needs the other axis near
  straight down (`TURN_RATIO` 2.5 ≈ 68°) for `TURN_N` samples in a row.
- Re-centring (`calibrate`, on start / "1" / resume / a frame change) waits
  for a STEADY grip (`STEADY_N` samples with |Δg| < `STEADY_DG`, capped at
  `SETTLE_MAX`) before taking the neutral; steering stays neutral until
  then. An immediate capture froze whatever tilt the hand had in that first
  tenth of a second into the whole race.
- `layoutStage` hands `input.setTiltFrame(portrait, sign)` the tilt axis AND
  the steering sign for the frame as drawn (rot 90 ≙ angle 90); input.js
  never reads the screen angle while the stage is around (it lags a
  rotation on iOS). `check:tilt-menus` asserts the gain, the sign, the
  lean-vs-turn hold and the steady centring.
- Sizes on the panel come off the stage WIDTH (`--stage-vw`), never a `%` in
  `height` (that reads the stage height — the minimap came out 90×124).
- Nothing locks the orientation any more (manifest `any`, no native lock at
  boot, Info.plist lists portrait too); Android's web lock on START only
  runs with Portrait racing off.
- `npm run check:portrait` (browser, phone viewport + touch, presents as a
  home-screen app to pass the install gate) asserts the frame, the panel
  layout, pause/resume, rotation both ways and the setting; it screenshots
  to `/tmp/portrait-*.png` — look at them.
