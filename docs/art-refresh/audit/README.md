# Graphics audit after the procedural refresh

Audit baseline: `966cdf0` (the completed lighting pass). The full refresh is
compared separately against original main `0d0198a`. The goal was to find
further substantial visual improvements without increasing the rendering
budget, preserve the procedural cel style, implement justified changes, and
leave everything reviewable in PR #64.

## Conclusion

The largest safe opportunities were the silhouette, colour, surface-paint and
geometry changes already delivered in the preceding passes. This audit found
a real transparency defect and redundant water-material work, both corrected.
It also found and repaired a headless item-test regression introduced by the
prop painting. It did not find evidence that another expensive rendering
feature could be added for free.

There is **no measured guarantee of unchanged FPS on every device**. The tests
use Chrome's software WebGL2 backend. They establish image correctness,
geometry/submission budgets and renderer allocations. The earlier grain and
facade work adds surface texture samples even though the complete branch uses
less geometry and reported memory than original main. CPU savings cannot be
assumed to cancel GPU costs. Native WebGPU and iOS frame pacing remain device
validation, not a claim made by this report.

## Changes from this audit

### Transparent road decals retain their depth behavior

`toToon()` copied transparency and opacity but discarded `depthWrite`. The
crosswalk/manhole materials explicitly disable depth writes; conversion restored
the default `true`. A fully transparent portion of their rectangular texture
could therefore write an invisible occluder and hide a later-drawn effect.
The converter now preserves the source setting in both stock and node cel
materials. This corrects visibility without another pass, sample or buffer.
It can allow previously incorrectly hidden fragments to draw; that is the
intended image, not a claim that every pixel workload is bit-identical.

The regression fixture renders an effect behind the transparent half of a
decal, on both conversion paths. Before, both sample pixels were background
RGB **38,59,80**. After, both show the effect RGB **238,68,34**. The opaque white
half remains intact. The fixture retains **5 draws, 9 triangles**, and identical
renderer allocation. Cache reuse is also checked.

| Before: invisible depth hides the effect | After: effect remains visible through the gap |
| --- | --- |
| ![Before decal fix](before-decals.png) | ![After decal fix](after-decals.png) |

### Lakes share their identical material

Every lake previously rebuilt the same node graph with the same mood and TSL
clock. Shoreline and ripple differences already come from geometry attributes.
One material is now shared per world: the audit seed has **5 water meshes and
1 water material**. Meshes remain separate, preserving transparent sorting and
frustum culling. There is no world-global cache that could carry the wrong mood
into another world.

The legacy loop writing a dummy time uniform once per lake per frame is removed;
the real ripple animation already uses TSL `time`. No new water shading or
reflection technique is added. This is a small CPU/setup simplification, not a
large FPS improvement. The measured renderer-memory difference is only 48 bytes.

### Item checks run again, including in CI

Procedural crate paint was lazy-created but still required `document` when the
Node-only item tests constructed props. That disabled props and aborted the
suite. The paint setup now follows the existing browser-only shadow behavior:
non-DOM simulation retains geometry and gameplay while skipping the canvas.
The browser path still creates the same shared paint texture. The item suite
now passes and is included in GitHub Actions, covering pickup/refill behavior,
yarn, milk, shields, jumps, catnip and tri-shot charges.

## Coverage and decisions

| Area audited | Evidence and decision |
| --- | --- |
| Cats, karts and accessories | Existing procedural rigs and merged meshes remain intact. The art suite covers all five kart styles, cat patterns/poses and accessories. Earlier 49–57% kart-triangle reductions leave the refreshed silhouettes substantially cheaper. More tessellation or separate decorative meshes is not justified under the constraint. |
| Trees, grass, flowers and wildlife | Re-rendered the 82-asset catalog, checking finite attributes, colours and material/triangle budgets. Inspected representative tree, grass, cloud, mountain and building images. Existing baked gradients and shared wind retain depth and movement without independent animation systems. Low quality intentionally hides grass; increasing density would add work. |
| Mountains and hills | Grain is precomputed and mipmapped; coordinates are static. The oblique projection can stretch on steep faces. Three-way projection or fragment noise could improve that detail but costs more samples/math, so it is not enabled. Mountain geometry remains 504 triangles per catalog specimen. |
| Buildings and landmarks | Existing shared facade/emission sheets and merged static parts carry detail without new windows as geometry. More trim, per-building lights or higher-resolution masks are not free. Fine grids can still alias at distance; a larger texture does not solve subpixel sampling. |
| Roads and roadside paint | Asphalt, kerbs, seams and road-conforming decals are already procedural. Corrected the proven depth-state defect instead of adding extra layered decals. Track seam checks cover classic, city and hilly alpine circuits. |
| Water and puddles | Existing sky-tinted Fresnel and ripple cues avoid a reflection render pass. Shared lake material and removed dummy updates are the audit's optimization. SSR was previously removed for off-screen reflection gaps and cost; reinstating it is not justified. |
| Particles, weather and boost effects | Existing two-field particle pooling, visibility retirement, tapered embers and painted smoke remain. The prior controlled sequence reduced instance submissions 31.2%. More particles, longer trails or particle lights would increase work. Weather and lighting already reuse shared uniforms. |
| Lighting and shadows | Retain one sun/moon and hemisphere fill, cached lower-tier shadows and movement-gated High shadows. The prior pass tuned colours/exposure and the existing contact mask. Higher map resolution, wider filters, cascades, or moving the sun continuously would increase rendering or memory cost. |
| Transparency | Investigated two-sided effects as a possible redundant pass. This renderer's `RenderList` only adds that double pass for transmission, so changing `forceSinglePass` would not deliver the suspected saving. No speculative change was made. |
| Post-processing and image stability | Bloom already runs at reduced resolution; god rays are quality/visibility gated. Boost aberration skips its extra samples while inactive. TAA, SSAO and outline passes would add work/history buffers; no such feature is enabled. Residual edge shimmer needs device-specific assessment before choosing an antialiasing tradeoff. |
| Gameplay projectiles | Yarn/hairballs use small shared geometry and materials. A new textured winding/fur treatment or material conversion would change shader work and warm-up needs. No unmeasured extra shader path is added for these small fast-moving objects. Their gameplay checks pass. |
| Quality tiers and split-screen | Reviewed existing Low/Balanced/Medium/High, battery-saver, culling and split-camera paths. This audit does not change their budgets, draw distances or resolution policy. Shared material state is view-independent; the split regression exercises independent controls and race completion. |
| HUD and menus | No new overlays, DOM effects or UI animation loops. Existing catalog art and gameplay HUD are preserved; this audit targets rendering correctness and the procedural world. |

## Performance evidence

The full audit world retains **797,270 scene triangles, 1,172 mesh batches and
52 textures**. Renderer allocation is **100,463,992 bytes**, compared with
100,464,040 immediately before this audit. Individual frame draw/triangle
counts fluctuate slightly with animated particles; total scene geometry is
unchanged. Material sharing reduces five identical water materials to one,
not five water draws to one.

Against original main, the complete PR still has approximately **2.1% fewer
scene triangles** and **1.0% less reported renderer memory**. The earlier kart
and particle savings are workload-specific; they do not prove the whole game
runs faster. See [original landscape comparison](../landscape/README.md),
[particle measurements](../effects/README.md), [grain cost](../grain/README.md),
and [lighting comparisons](../lighting/README.md).

Raw evidence: [decal baseline](before-metrics.json), [decal result](after-metrics.json),
[world before](world-before.json), [world after](world-after.json),
[82-asset results](scenery-metrics.json).

## Reproduction and validation

Use `PW_CHROME=/path/to/chrome` for browser checks. `check:materials` writes its
fixture and counters to `OUT`, supports `ART_ROOT` for a baseline checkout and
`BASELINE=1` to record the known defect without enforcing the corrected pixels.
`check:landscape` now also reports water mesh/material counts.

Checks run for this audit: material pixel regression, all scenery previews,
four fixed full-world views on both revisions, item logic, simulation, web
build, and split-screen gameplay. Earlier passes also verified the art budgets,
road seams, full-game smoke, effects lifecycle and catalog renders. CI and the
branch preview are checked after pushing. The PR stays unmerged for testing.
