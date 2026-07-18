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

## Verification loop for art changes

1. `node --check src/models.js`
2. One-off probe in `tools/` (Playwright + `/opt/pw-browsers/chromium`,
   SwiftShader args, `viewer.html?webgl=1&plain=1`, drive `window.__viewer`),
   screenshot to the scratchpad and LOOK at it.
3. `node tools/catalog-shots.mjs` when presets/models changed.
4. `npm run check` (+ `node tools/progress-check.mjs` if the economy changed),
   `node tools/build-web.mjs`, then commit + push.
