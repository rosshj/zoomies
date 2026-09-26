// Procedural art budget/integrity check. No GPU timing claim: the assertions
// cover geometry and material batches; use hardware gameplay for frame pacing.
// PW_CHROME=/path/to/chrome node tools/art-check.mjs
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);
  await page.waitForFunction(() => window.__viewer);
  const result = await page.evaluate(async () => {
    const { createCat, createKartModel, CAT_PATTERNS, CAT_ACCESSORIES, updateCatRig } = await import('/src/models.js');
    const { Track } = await import('/src/track.js');
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const inspect = root => {
      let triangles = 0, batches = 0;
      root.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry, p = g.attributes.position;
        assert([...p.array].every(Number.isFinite), 'non-finite model vertex');
        const count = g.index?.count ?? p.count;
        triangles += count / 3;
        batches += Math.max(1, g.groups.length);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const group of (Array.isArray(o.material) ? g.groups : [])) {
          assert(group.start + group.count <= count, 'geometry group exceeds buffer');
          assert(mats[group.materialIndex], 'cached geometry/material slots disagree');
        }
      });
      return { triangles, batches };
    };
    // Baseline material batches and triangle budgets from main at 0d0198a.
    const baseline = [25292, 22568, 22084, 23420, 24268];
    const batches = [22, 24, 22, 22, 22];
    const karts = [];
    for (let style = 0; style < 5; style++) {
      for (const color of [0xe53935, 0xfafafa, 0x182030]) {
        const kart = createKartModel(color, { style });
        const stats = inspect(kart.group);
        assert(stats.triangles < baseline[style] * 0.65, `style ${style}: triangle budget`);
        assert(stats.batches <= batches[style], `style ${style}: added material batches`);
        assert(kart.wheels.length === 4, 'wheel rig missing');
        if (color === 0xe53935) karts.push({ style, ...stats });
      }
    }
    let cats = 0;
    for (const pattern of CAT_PATTERNS) for (const pose of ['sit', 'kart', 'stand']) {
      const cat = createCat(0xf0a830, { pattern, pose });
      inspect(cat);
      updateCatRig(cat.userData.rig, 0.016, 0.6, 20, false, false, true);
      cats++;
    }
    for (const accessory of CAT_ACCESSORIES) inspect(createCat(0x8c9298, { pattern: 'solid', accessory }));
    const { setSeed } = await import('/src/rng.js');
    const { BIOME_NAMES, planBiomeWedges, biomeNameAt, biomeWeatherAt } = await import('/src/scenery.js');
    const classic = planBiomeWedges(null, 'CLASSIC').order;
    assert(classic.length === 11 && !classic.includes('lavender'), 'classic biome layout changed');
    assert(BIOME_NAMES.length === new Set(BIOME_NAMES).size, 'duplicate biome names');
    const tracks = [];
    const recipes = [null,
      ...["lavender","wetlands","volcanic"].map(b=>({mode:"custom",seed:"ART-"+b,size:.5,curviness:.5,twist:.42,hilliness:.4,hills:.45,biomes:[b]})),
      { mode: 'custom', seed: 'ART-CITY', size: 0.5, curviness: 0.45, twist: 0.55, hilliness: 0.3, hills: 0.4, biomes: ['city'] },
      { mode: 'custom', seed: 'ART-HILLS', size: 0.5, curviness: 0.55, twist: 0.5, hilliness: 0.7, hills: 0.65, biomes: ['alpine', 'tundra'] },
    ];
    for (const recipe of recipes) {
      setSeed(recipe?.seed || 'ART-CLASSIC');
      const track = new Track(recipe);
      if (recipe?.biomes.length === 1) {
        const p = track._pts[0], name = recipe.biomes[0];
        assert(biomeNameAt(p.x, p.z, p.y) === name, 'selected biome not applied');
        assert(biomeWeatherAt(p.x, p.z) === (name === 'wetlands' ? 'rain' : 'none'), 'biome weather mismatch');
      }
      tracks.push({ seed: recipe?.seed || 'classic', ...inspect(track.group) });
      // Paint must stay narrow on curves, use a bounded mesh, and never bridge
      // a dash gap with one giant triangle (including the closing loop segment).
      const paint = track.group.children.find(o => o.geometry?.attributes.aAlpha);
      assert(paint, 'missing centre paint mesh');
      const pg = paint.geometry, pp = pg.attributes.position;
      assert(pg.index.count / 3 <= track.samples * 2, 'centre paint triangle budget');
      for (let i = 0; i < pp.count; i += 2) {
        const width = Math.hypot(pp.getX(i)-pp.getX(i+1), pp.getZ(i)-pp.getZ(i+1));
        assert(width > .37 && width < .39, 'centre paint width changed on curve');
      }
      for (const a of pg.attributes.aAlpha.array) assert(a >= 0 && a <= 1, 'invalid paint alpha');
      for (let i = 0; i < pg.index.count; i += 3) {
        const a = pg.index.getX(i), b = pg.index.getX(i+2);
        const length = Math.hypot(pp.getX(a)-pp.getX(b), pp.getY(a)-pp.getY(b), pp.getZ(a)-pp.getZ(b));
        assert(length < track.length / track.samples * 1.5 + .4, 'paint bridges gap or loop');
      }
      // Road shoulders must close cleanly, including the final loop join.
      const shoulder = track.group.children[1].geometry;
      const p = shoulder.attributes.position;
      assert(p.count === track.samples * 12, 'unexpected shoulder topology');
      for (let i = 0; i < track.samples; i++) for (let side = 0; side < 2; side++) {
        for (let j = 0; j < 3; j++) {
          const a = i * 12 + side * 6 + 3 + j;
          const b = ((i + 1) % track.samples) * 12 + side * 6 + j;
          for (const get of ['getX', 'getY', 'getZ']) assert(Math.abs(p[get](a) - p[get](b)) < 1e-5, 'open shoulder seam');
        }
      }
    }
    return { karts, catPoses: cats, accessories: CAT_ACCESSORIES.length, tracks };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.close();
}
