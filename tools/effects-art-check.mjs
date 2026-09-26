// Render procedural effects and road paint; check particle expiry/recycling.
// ART_ROOT and BASELINE=1 compare an older checkout. Resource counts are not FPS.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-fx-check';
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
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type()==='error')errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);
  await page.waitForFunction(() => window.__viewer);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { EffectsManager } = await import('/src/effects.js');
    const { Track } = await import('/src/track.js');
    const { toToon } = await import('/src/toon.js');
    const v = window.__viewer;
    v.scene.children.at(-1).visible = false;
    v.setBackground('#263b50'); v.freeze(0);
    v.orbit.target.set(0,2,0); v.orbit.radius=15; v.orbit.theta=0; v.orbit.phi=1.35;
    let seed=12345; Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const fx = new EffectsManager(v.scene); window.__fx=fx;
    for(let i=0;i<6;i++) {
      fx._spawn(new THREE.Vector3(-5+i*2,3,0),new THREE.Color().setHSL(i/6,0.8,0.6),{size:2.2,life:2,opacity:0.85});
      fx._spawn(new THREE.Vector3(-5+i*2,0.5,0),new THREE.Color().setHSL(i/6,0.7,0.7),{size:1.8,life:2,opacity:0.9,spark:true,v:new THREE.Vector3(Math.cos(i*.5)*6,Math.sin(i*.5)*6,2)});
    }
    fx.update(0);
    if(fx.sparkField.aVelocity || fx.sparkField.mesh.material.rotationNode)throw Error('Round particles should not upload/project velocity');
    const sprite = fx.sparkTex.image;
    const pixels = sprite.getContext('2d').getImageData(0,0,64,64).data;
    // A tail or elongated head breaks quarter-turn symmetry. Check the actual
    // baked alpha, so a pin-shaped sprite cannot silently return.
    for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
      const a=pixels[(y*64+x)*4+3],b=pixels[(x*64+63-y)*4+3];
      if(Math.abs(a-b)>2)throw Error('Spark sprite is not round');
    }
    const track = new Track(); const road = track.group.children[0];
    window.__roadMat = toToon(road.material);
    window.__roadColor = new THREE.Color().fromBufferAttribute(road.geometry.attributes.color,5);
    return {cap:fx.maxParts, fields:fx.environmentField?3:2, smokeTexture:[fx.smokeTex.image.width,fx.smokeTex.image.height],sparkTexture:[fx.sparkTex.image.width,fx.sparkTex.image.height], roadTriangles:road.geometry.index.count/3,roadMap:road.material.map?.image.width||0,roadBump:!!road.material.bumpMap};
  });
  await page.waitForTimeout(1000);
  await page.screenshot({path:path.join(out,'particles.png')});
  result.simulation = await page.evaluate(async () => {
    const THREE=await import('three');const fx=window.__fx;
    fx.update(5); const kart={position:new THREE.Vector3(),heading:0,y:0,groundY:0,speed:45};
    let submissions=0, invisible=0, peak=0;
    for(let f=0;f<240;f++) {
      if(f%30===0)fx.tootBurst(kart);
      if(f%4===0)fx.trickle(kart);
      if(f%12===0)fx.tireGrit(kart);
      fx.update(1/60);
      submissions+=fx.smokeField.mesh.count+fx.sparkField.mesh.count+(fx.environmentField?.mesh.count||0);
      invisible+=fx.parts.filter(p=>p.opacity<=0).length;
      peak=Math.max(peak,fx.parts.length);
      if(fx.parts.length>fx.maxParts)throw Error('Particle budget exceeded');
    }
    fx.update(5);
    if(fx.parts.length||fx.smokeField.mesh.count||fx.sparkField.mesh.count||fx.environmentField?.mesh.count)throw Error('Expired particles still submitted');
    for(let i=0;i<fx.maxParts+20;i++)fx._spawn(kart.position,new THREE.Color(1,1,1),{life:2,opacity:.15,size:1});
    if(fx.parts.length!==fx.maxParts)throw Error('Cap/recycling failed');
    fx.update(.2);const fadedSlots=fx.parts.length;
    fx.update(5);
    fx.warmup(new THREE.Vector3(0,-100,0));fx.update(1/60);
    if(fx.smokeField.mesh.count!==1||fx.sparkField.mesh.count!==1||(fx.environmentField&&fx.environmentField.mesh.count!==1))throw Error('Warm-up fields retired before first draw');
    fx.update(5);
    return {submissions,invisible,peak,fadedSlots};
  });
  if(!process.env.BASELINE && (result.simulation.invisible||result.simulation.fadedSlots))throw Error('Fully transparent particles retained');
  await page.evaluate(async()=>{
    const THREE=await import('three'), v=window.__viewer;
    const road=new THREE.Mesh(new THREE.PlaneGeometry(20,40).rotateX(-Math.PI/2),window.__roadMat);
    const colors = new Float32Array(road.geometry.attributes.position.count * 3);
    for(let i=0;i<colors.length;i+=3)window.__roadColor.toArray(colors,i);
    road.geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    road.position.y=.03; v.scene.add(road);
    v.orbit.target.set(0,0,-4);v.orbit.radius=17;v.orbit.theta=.2;v.orbit.phi=.95;
    v.setBackground('#91b2c3');v.setGameLook(true);
  });
  await page.waitForTimeout(1000);
  await page.screenshot({path:path.join(out,'road.png')});
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify({result,errors},null,2));
  console.log(JSON.stringify({result,errors},null,2));
  if(errors.length)process.exitCode=1;
} finally { await browser?.close(); server.close(); }
