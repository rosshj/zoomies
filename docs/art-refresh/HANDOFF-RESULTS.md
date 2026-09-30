# Hand-off implementation results

Started from `d5434c8`. The unfinished environment pass from the prior checkout is preserved in a local stash, separate from this plan. No history was rewritten.

## 1. Earned roster

Implemented the approved table for all 26 cats and 24 karts, including combined cup/difficulty and full-cup sweeps. New accessories follow their named cat; the original roster and creator prices remain unchanged. Career saves now include biome wins, kart hits on knockable props, and finished Versus matches. Existing purchases survive migration.

The creator labels locked accessories with their cat's name and prevents using them; random designs choose owned accessories. Earned rewards appear on race results and milestone progress appears on locked roster cards.

Validation: approved-table equality, threshold boundaries, wrong-cup rejection, migration, original price ladders, both roster data checks, and live creator save/reload/race/wardrobe checks.

## 2. Quality-scaled generation bakes

High retains 24-ray neighbouring shelter on terrain and rigid structures. Medium uses 8 rays on terrain; Low uses 4. Lower tiers retain existing local structure/contact shading. Village builds now key their scalar bake on generator topology and coarse proportions, avoiding whole-geometry hashing and sharing shading between nearby dimensions without changing their meshes. The boot line reports the actual world-build and shelter times.

Local native Chrome CPU build probe, seed SHADE, Medium, cold/warm city: 4,840/4,818 ms before; 945/836 ms after. Shelter alone: 4,088/4,134 → 162/168 ms. These are generation measurements on this Mac, not container or phone timings and not FPS measurements. Five-biome cold/warm probes retained finite colours, ground contacts and LOD data. Tier receiver/ray counts, cache hits, immutable sources, exposed surfaces and moving-part exclusions pass the bake/runtime checks.

## 3. Cache the fitted cat

A bounded 64-entry LRU now retains pristine fitted templates, including paws and ear-slot cuts. Each request clones the scene objects and rebinds all rig references; geometry/materials are shared, while springs, eyelids, propellers and blink timers remain independent. Eviction releases resources owned by the template.

Local browser warm builds across all 40 presets averaged 0.066 ms; beanies averaged 0.053 ms (targets 4 ms / 10 ms). These CPU construction timings exclude rendering. Art geometry/batch checks and 738 accessory variants pass; 82 backend render cases reported no errors. The existing propeller frame-rate and independent helmet-blink tests pass, and a beanie render was inspected.

## 4. Shared pigments and paint

Ear fronts/backs use coat-aware vertex pigments and one shared ear surface. Matte cat pieces and solid kart paint also share materials by surface role. A palette-independent procedural ink atlas preserves fixed gold stars/ivory spots while vertex pigment supplies the custom fabric colour; recolours share materials and retain the existing single texture sample. Ear-slot cutting now interpolates vertex pigment as well as normals/UVs.

The same six-preset field measured 82 → 48 source materials and 18 → 12 mapped textures (the separate ink atlas is shared across recolours). Material transparency pixels, geometry/batch budgets, explicit red/blue wizard pigment preservation and shared-atlas assertions pass. Both accessory backends and 738 variants pass. Wizard front and mushroom side renders were visually inspected. Runtime catalog thumbnails were regenerated; review screenshots remain outside the repository.

## 5. Molded accessories

Rebuilt the duck as one sculpted body/neck/head with an integrated bill and tail, the frog eyes as continuous painted cups, the beanie hem/dome/spindle as one surface, and the right helmet earcup as a single cushion/shell profile. Fixed tapered-tube side winding at its source and removed the accessory workaround; a triangle-normal check covers sides and both caps.

Front, side and top renders of all four were inspected. Full accessory variants and batch/triangle budgets, art integrity, smoke and web build checks pass. Runtime catalog thumbnails were refreshed. No additional runtime animation or material passes were introduced.

## 6. Snow-biome villages

Alpine and tundra town palettes now include compact two-house village clusters alongside chalets. The clusters reuse snow-roofed village architecture and the existing static batching, with a nine-unit footprint for spacing, road clearance and habitat checks. Seed 4242 has five clusters, four near its tundra start straight. Six-point weather sprites intentionally represent snow crystals; they are unrelated to kart boost sparks.

All 16 single/mixed biome audits pass. The scenery audit now correctly selects scenery sidebar groups rather than treating named cats/accessories as scenery with obsolete budgets; dedicated character checks retain that coverage. All 122 scenery assets pass, including a bounded four-batch village cluster. A pinned seed-4242 race render and village asset render were inspected. Smoke and web build pass.

## 7. Portable browser checks

All browser `check:*` scripts and catalog capture share executable discovery and renderer flags. Linux defaults to SwiftShader/WebGL; desktop runs probe WebGPU availability, and explicit backend requests remain strict. Fallback runs still capture galleries and exercise behavior. Creator navigation allows time for software shader compilation. The paint assertion now checks the shared atlas node and vertex pigment, and the kart save check expects the already-approved removal of the style-6 remap.

Software WebGL validation includes 41 accessory renders/369 variants, 40 cat renders/3,321 combinations, 34 kart renders/816 variants, material/art budgets, shadow pixels, environmental particle shader/pool checks and all 24 road-prop renders. The native launcher also passed both backends for the four re-molded accessories. Creator save/reload/race checks and software smoke pass. The Linux CI workflow publishes logs and review screenshots as artifacts, not source files; `BROWSER-CHECKS.md` documents the controls.

## 8. Reuse impact replacements

Destructive prop impacts now reuse the live mesh and its converted cel material, swapping cached geometry instead of constructing/discarding a Group and Mesh. Replacement hull arrays are reserved during generation and share existing vector slots; radius and inertia are cached with the art. No replacement scene node, hull array or hull vector is allocated in that impact path.

The actual swept-hit tests assert mesh/material/buffer/vector identity, then run all biome props through settling. All 15 biome rosters, 340,272 regional art-vertex checks, 973 slope/curve/stacked-road poses, 64,788 crate/barrel vertices and item-box checks pass. A rendered destructive basket impact retained 24 WebGL / 26 WebGPU shader programs before/after and passed all 16 single/mixed placement worlds. Node-only 64-active-prop stress measured about 0.93 ms median / 1.26 ms p99, excluding rendering; this is not a phone FPS claim. Software smoke and web build pass.

## Remaining device validation

All eight implementation steps are complete. Ross's phone checks remain: a corner with five or more piled-up props, city track load time, and a long session of garage browsing. This work does not claim measured mobile frame-rate gains. Review galleries are PR links/CI artifacts; no gallery PNGs were added to the source tree. PR #64 remains unmerged.

## Linux follow-up

The first Ubuntu/SwiftShader workflow passed all six render/creator/world jobs. Its city build measured 2.31 s cold / 1.66 s warm (a second run measured 2.49 / 1.80 s), so the 1.5 s target was not met on that runner despite being met locally. Profiling found additional generation-only overhead in LOD keys and shelter queries. Exact integer LOD keys now avoid per-vertex strings/temporary arrays; conservative empty-neighbourhood rejection and precomputed hemisphere directions avoid unnecessary shelter work. Comparison probes produced bitwise-identical indices/attributes across 12 indexed/non-indexed LOD cases, including large-coordinate fallback, and identical shelter colours at all three tiers. No detail, ray count or runtime lighting was reduced.

The follow-up local city probe measured 656 / 583 ms cold/warm. Bake/runtime, all-biome, scenery, terrain-clearance, seed-4242, smoke and web-build checks pass. Village members also now select static batching cells using their world position, retaining correct chunk culling after nesting them in a cluster. Final Linux timings and galleries are reported in the PR description; hardware-dependent generation numbers must not be presented as mobile FPS gains.
