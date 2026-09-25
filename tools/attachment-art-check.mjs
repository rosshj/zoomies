// Visual fixture for seamless forelegs in every pose and the rear boost plume.
// ART_ROOT selects a baseline checkout; OUT saves the six fixed camera views.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-attachment-check';
await fs.mkdir(out,{recursive:true});
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
  await page.addInitScript(() => {
    let seed=12345;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type()==='error')errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);
  await page.waitForFunction(() => window.__viewer);
  await page.setViewportSize({width:1000,height:700});
  await page.evaluate(()=>{const v=window.__viewer; v.scene.children.at(-1).visible=false;v.freeze(0);v.setGameLook(true);v.setBackground('#7e9daf');});
  for(const pose of ['sit','kart','stand']) {
    await page.evaluate(async pose=>{
      const {createCat}=await import('/src/models.js'); const {toonify}=await import('/src/toon.js');const v=window.__viewer;
      if(window.__subject)v.scene.remove(window.__subject);
      window.__subject=createCat(0xf0a830,{pose,pattern:'tabby'});toonify(window.__subject);v.scene.add(window.__subject);
      v.orbit.target.set(0,1.4,.35);v.orbit.radius=5.7;v.orbit.theta=.9;v.orbit.phi=1.25;
    },pose);await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'cat-'+pose+'.png')});
  }
  await page.evaluate(async()=>{
    const THREE=await import('three');const {EffectsManager}=await import('/src/effects.js');const {createKartModel}=await import('/src/models.js');const {toonify}=await import('/src/toon.js');const v=window.__viewer;
    v.scene.remove(window.__subject);const k=createKartModel(0xe53935);v.scene.add(k.group);toonify(k.group);
    window.__fx=new EffectsManager(v.scene);window.__kart={position:new THREE.Vector3(),heading:0,y:0};
    v.orbit.target.set(0,.8,-3);v.orbit.radius=15;v.orbit.theta=2.2;v.orbit.phi=1.15;v.setBackground('#263b50');
    window.__fx.tootBurst(window.__kart);
  });
  for(let f=0;f<24;f++){
    await page.evaluate(()=>{window.__fx.trickle(window.__kart);window.__fx.update(1/60);});
    if([3,9,19].includes(f)){await page.waitForTimeout(100);await page.screenshot({path:path.join(out,'exhaust-'+f+'.png')});}
  }
  console.log(JSON.stringify({errors}));if(errors.length)process.exitCode=1;
} finally {await browser?.close();server.close();}
