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
