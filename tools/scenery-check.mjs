// Render the entire asset catalog with its game materials and check geometry /
// batching budgets against the first art pass (78520a0). OUT saves review shots.
// Use ART_ROOT=/path/to/baseline and BASELINE=1 to render an earlier checkout.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const budgets = JSON.parse(await fs.readFile(new URL('./fixtures/scenery-budget.json', import.meta.url), 'utf8'));
const out = process.env.OUT;
if (out) await fs.mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  try {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const extra = { Sign: 25, 'Building — village': 6, 'Building — snowy': 6, Barrel: 96, Cactus: 96, Cow: 208, Sheep: 144, Deer: 144, Goat: 232, Gull: 80, Pigeon: 88, Duck: 78, 'Sky train': 528, 'Tree — forest': 42 };
const shots = new Set(['Street lamp','Fence','Racing banner','Timber footbridge','Bench','Planter','Sign','Billboard','Tree — wetlands','Tree — lavender','Basalt columns','Mountain — volcanic','Mountain — lavender','Mountain — wetlands','Mountain — alpine', 'Mountain — meadow', 'Mountain — desert','Tower', 'City tower', 'Building — snowy','Cloud', 'Sky bird', 'Tree — meadow', 'Tree — forest', 'Tree — blossom', 'Tree — savanna', 'Tree — beach', 'Grass tuft', 'Wildflowers', 'Cow', 'Sheep', 'Pigeon', 'Gull', 'Crate', 'Barrel', 'Building — village', 'Hot-air balloon', 'Rock', 'Cactus', 'Duck', 'Goat', 'Sky train']);
try {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 660 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);
  await page.waitForFunction(() => window.__viewer);
  const names = await page.evaluate(() => [...document.querySelectorAll('#list button')].map(b => b.textContent).filter(n => !n.startsWith('Cat') && !n.startsWith('Kart')));
  const rows = [];
  for (const name of names) {
    const row = await page.evaluate(async name => {
      const { setSeed } = await import('/src/rng.js'); setSeed('art-' + name);
      let seed = 81;
      Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const v = window.__viewer; v.setBackground('#91b2c3'); v.setGameLook(true);
      [...document.querySelectorAll('#list button')].find(b => b.textContent === name).click();
      v.freeze(0); v.orbit.theta = ['Cow', 'Sheep', 'Deer'].includes(name) ? -0.8 : 0.7; v.orbit.phi = 1.1; v.orbit.radius *= name === 'Tower' ? 1.35 : name.startsWith('Tree') ? 1.28 : 1.06;
      const root = v.scene.children.at(-1);
      let triangles = 0, batches = 0, invalid = 0, missingColors = 0;
      root.traverse(o => {
        if (!o.geometry) return;
        const g = o.geometry;
        for (const a of Object.values(g.attributes)) for (const value of a.array) if (!Number.isFinite(value)) invalid++;
        if (!o.isMesh) return;
        triangles += (g.index?.count || g.attributes.position.count) / 3;
        batches += Array.isArray(o.material) ? g.groups.length : 1;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some(m => m.vertexColors) && !g.attributes.color) missingColors++;
      });
      // Let the real renderer compile/draw every asset, not just construct it.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { name, triangles, batches, invalid, missingColors };
    }, name);
    rows.push(row);
    if (row.invalid || row.missingColors) errors.push(`${name}: invalid buffers or missing painted attributes`);
    if (name.startsWith('Mountain —') && (row.triangles > 504 || row.batches !== 1)) errors.push(`${name}: mountain budget exceeded`);
    const newBudgets = { 'Racing banner': [280, 2], 'Timber footbridge': [1700, 1], 'Tree — wetlands': [230, 2], 'Tree — lavender': [360, 2], 'Basalt columns': [72, 3] };
    if (newBudgets[name] && (row.triangles > newBudgets[name][0] || row.batches > newBudgets[name][1])) errors.push(`${name}: new asset budget exceeded`);
    const base = budgets[name];
    if (!process.env.BASELINE && base) {
      if (row.triangles > base[0] + (extra[name] || 0)) errors.push(`${name}: triangle budget exceeded (${row.triangles})`);
      if (row.batches > base[1]) errors.push(`${name}: additional material batches (${row.batches})`);
    }
    if (out && shots.has(name)) await page.screenshot({ path: path.join(out, name.replaceAll(' — ', '-').replaceAll(' ', '-') + '.png') });
  }
  const sharedBillboards = await page.evaluate(async () => {
    const {makeBillboard, BILLBOARD_SIGNS} = await import('/src/features.js');
    const a=makeBillboard(BILLBOARD_SIGNS[0],true),b=makeBillboard(BILLBOARD_SIGNS[0],true);
    return a.children[1].material === b.children[1].material;
  });
  if (!sharedBillboards) errors.push('Identical billboard materials are not shared');
  if (out) await fs.writeFile(path.join(out, 'metrics.json'), JSON.stringify({ rows, errors }, null, 2));
  console.log(JSON.stringify({ assets: rows.length, errors, totalTriangles: rows.reduce((n, r) => n + r.triangles, 0) }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser?.close(); server.close();
}
