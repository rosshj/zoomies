# Hand-off implementation results

Started from `d5434c8`. The unfinished environment pass from the prior checkout is preserved in a local stash, separate from this plan. No history was rewritten.

## 1. Earned roster

Implemented the approved table for all 26 cats and 24 karts, including combined cup/difficulty and full-cup sweeps. New accessories follow their named cat; the original roster and creator prices remain unchanged. Career saves now include biome wins, kart hits on knockable props, and finished Versus matches. Existing purchases survive migration.

The creator labels locked accessories with their cat's name and prevents using them; random designs choose owned accessories. Earned rewards appear on race results and milestone progress appears on locked roster cards.

Validation: approved-table equality, threshold boundaries, wrong-cup rejection, migration, original price ladders, both roster data checks, and live creator save/reload/race/wardrobe checks.

## 2. Quality-scaled generation bakes

High retains 24-ray neighbouring shelter on terrain and rigid structures. Medium uses 8 rays on terrain; Low uses 4. Lower tiers retain existing local structure/contact shading. Village builds now key their scalar bake on generator topology and coarse proportions, avoiding whole-geometry hashing and sharing shading between nearby dimensions without changing their meshes. The boot line reports the actual world-build and shelter times.

Local native Chrome CPU build probe, seed SHADE, Medium, cold/warm city: 4,840/4,818 ms before; 945/836 ms after. Shelter alone: 4,088/4,134 → 162/168 ms. These are generation measurements on this Mac, not container or phone timings and not FPS measurements. Five-biome cold/warm probes retained finite colours, ground contacts and LOD data. Tier receiver/ray counts, cache hits, immutable sources, exposed surfaces and moving-part exclusions pass the bake/runtime checks.
