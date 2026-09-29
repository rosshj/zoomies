# Running browser checks

All `check:*` browser scripts use `tools/art-browser.mjs`. Node-only checks need no browser.

- `PW_CHROME=/path/to/chrome` selects an executable. Otherwise the helper finds native Chrome, installed Playwright Chromium, or Chromium under `/opt/pw-browsers`.
- Linux defaults to SwiftShader and WebGL. `SOFTWARE=1` exercises the same path on a desktop; `NATIVE=1` opts into hardware rendering on Linux.
- On native hosts the helper probes adapter availability and runs WebGL plus WebGPU when available. Without a WebGPU adapter it runs WebGL, including screenshots and behavioral assertions.
- `BACKENDS=webgl` or `BACKENDS=webgpu` explicitly selects a backend. Explicit requests remain strict: an unexpected renderer fallback fails the check.
- `OUT=/tmp/my-gallery` saves supported render checks outside the source tree. Review images must not be committed.

Examples:

```sh
SOFTWARE=1 npm run check:accessories
SOFTWARE=1 npm run check:cat-roster-art
SOFTWARE=1 npm run check:kart-roster-ui
node tools/snow-village-check.mjs
```

The `procedural art` workflow runs the roster/accessory render checks, creator flows, material budgets, fitted-cat checks, generation measurements and seed-4242 race view on Ubuntu/SwiftShader. Its downloadable `art-*` artifacts contain logs and review images, and are linked from PR #64. Software-rendered frame rates are correctness checks, not phone performance measurements.
