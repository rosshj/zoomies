# Scenery and wildlife pass

This extends the first cat/kart pass to the world around the race. It retains
procedural generation, the shared wind field, instancing, spatial batching,
quality-tier density, and existing animation update rates.

| Area | Changes |
| --- | --- |
| Sky | Softer, overlapping cloud lobes with cool painted undersides; curved bird wings and shaded flight feathers; shaped balloon fabric panels. |
| Vegetation | Lobed deciduous crowns, rounded pine bough tiers, arched palm fronds, flared trunks, shaded shrubs and planters; continuous curved cactus arms. |
| Ground cover | Pointed, asymmetric grass/reeds with painted shading; radial flower petals and golden centres, retaining the original triangle budgets. |
| Wildlife | Eyes, ears, and muzzle detail on farm animals; sculpted pigeon wings and facial detail; gull eyes/feet; rounded goats and duck bills. |
| Towns and landmarks | Baked form shading on merged architectural details and framed window paintings, preserving the existing building batches. |
| Props and transit | Painted crate planks/braces/nails, shaped barrels, rounded train coaches and separate window panes in the existing window meshes. |
| Terrain and weather | Sculpted rock planes and painted surfaces; snow crystals in the same small sprite texture. |

The remaining sky gradients, water, mountain terrain, gameplay effects, and
set-piece structures were reviewed and retain their existing rendering systems.
No new post-processing passes, lights, particle populations, or animation loops
were introduced. New shape detail is generated once when the world builds.

## Before / after

Each pair uses the same seed and camera settings in the asset viewer's Game look.

| Before | After |
| --- | --- |
| ![Cloud before](before-Cloud.png) | ![Cloud after](after-Cloud.png) |
| ![Bird before](before-Sky-bird.png) | ![Bird after](after-Sky-bird.png) |
| ![Pine before](before-Tree-forest.png) | ![Pine after](after-Tree-forest.png) |
| ![Tree before](before-Tree-meadow.png) | ![Tree after](after-Tree-meadow.png) |
| ![Pigeon before](before-Pigeon.png) | ![Pigeon after](after-Pigeon.png) |
| ![Cow before](before-Cow.png) | ![Cow after](after-Cow.png) |
| ![Crate before](before-Crate.png) | ![Crate after](after-Crate.png) |
| ![Cactus before](before-Cactus.png) | ![Cactus after](after-Cactus.png) |
| ![Duck before](before-Duck.png) | ![Duck after](after-Duck.png) |
| ![Goat before](before-Goat.png) | ![Goat after](after-Goat.png) |
| ![World before](before-world.png) | ![World after](after-world.png) |

## Budget and validation

`npm run check:scenery` actually renders all 79 non-cat/kart entries (including
accessories and five newly exposed plant previews), checks finite buffers and
paint attributes, and enforces per-asset triangle and batch budgets against
commit `78520a0`. The same 74 baseline entries total 204,099 → 205,835 triangles
(+0.85%) and 541 → 539 material batches. These catalog totals are not a world
benchmark: repeated assets are measured separately in the seeded world check.

The most common ground-cover cards stay at four triangles and flowers at eight.
Clouds, sky birds, broadleaf crowns, palms, rocks, and architectural surfaces
retain their triangle counts. Pines add 42 triangles per canopy. Added animal
facial detail and molded prop shapes use the existing material batches; gulls
now share their orange material, saving two batches per bird. The crate artwork
adds one shared 128×128 canvas texture; no external art assets are required.

A fixed 1100×700 Medium WebGL2 city/forest view, using the same world seed and
camera as the first pass, measured:

| Measurement | First pass (`78520a0`) | With scenery pass |
| --- | ---: | ---: |
| Total scene triangles (including instances) | 818,430 | 841,604 (+2.8%) |
| Visible draw calls | 424 | 425 (+0.24%) |
| Visible triangles | 391,094 | 407,238 (+4.1%) |
| Renderer-reported allocated bytes | 100,698,369 | 101,621,043 (+0.9%) |
| Textures | 49 | 50 |
| Wind-driven canopy batches | 40 | 40 |

These are resource counters, not hardware frame-time measurements. The
architectural and vegetation changes preserve spatial batching and wind data;
the extra shared crate texture accounts for the additional texture allocation.
The game smoke test, all 79 catalog renders, the existing art-budget checks,
world-config checks, and web build pass.

For reproducible screenshots:

```sh
PW_CHROME=/path/to/chrome OUT=/tmp/zoomies-scenery npm run check:scenery
```

The viewer now includes palm/jungle trees, grass tufts, flowers, and reeds.
Inspect these in `viewer.html`, then race through their corresponding biomes.
Native GPU frame pacing, iOS, and WebGPU still need hardware playtesting; the
browser checks use software WebGL2 and are not a hardware FPS claim.
