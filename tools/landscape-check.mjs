// Fixed-seed landscape views and resource census. ART_ROOT compares a checkout;
// BASELINE=1 allows the old per-lake materials while recording their counts.
// Software WebGL2 resource counts are reproducible; they are NOT hardware FPS.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-landscape-check';
await fs.mkdir(out, { recursive: true });
const mime = { '.html':'text/html', '.mjs':'text/javascript', '.wasm':'application/wasm', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = http.createServer(async (req,res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  try {
    const url = req.url.split('?')[0];
    const file = path.join(root, url === '/' ? 'index.html' : decodeURIComponent(url));
    const data = await fs.readFile(file);
    res.writeHead(200, {'content-type': mime[path.extname(file)] || 'application/octet-stream'}).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:process.env.NATIVE ? [] : ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1100,height:700}});
  const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
  await page.addInitScript(()=>{
    let s=12345; Math.random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
    localStorage.setItem('zoomies-quality-v2','medium');
  });
  const biomeRecipes = {
    lavender: {seed:'BLOOM',size:.5,curviness:.5,twist:.42,hilliness:.3,hills:.45,timeOfDay:'sunset'},
    wetlands: {seed:'REED',size:.5,curviness:.4,twist:.4,hilliness:.2,hills:.3,timeOfDay:'midday'},
    volcanic: {seed:'BASALT',size:.5,curviness:.55,twist:.5,hilliness:.6,hills:.6,timeOfDay:'sunset'},
  };
  const recipe = biomeRecipes[process.env.BIOME] || (process.env.BIOME ? {seed:'HABITAT',size:.5,curviness:.45,twist:.4,hilliness:.25,hills:.4,timeOfDay:'midday'} : null);
  const cfg = process.env.RECIPE_FILE ? JSON.parse(await fs.readFile(process.env.RECIPE_FILE,'utf8')) : recipe ? {mode:'custom',...recipe,biomes:[process.env.BIOME]} : null;
  const world = cfg ? Buffer.from(JSON.stringify({cfg,seed:cfg.seed,laps:3})).toString('base64url') : '';

  await page.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1&w=${world}${process.env.TOD ? "&tod=" + encodeURIComponent(process.env.TOD) : ""}`,{timeout:150000,waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__zoomies?.track,null,{timeout:150000});
  await page.evaluate(()=>{
    const z=window.__zoomies, c=z.camera;
    window.__setLandscapeCamera=(eye,target)=>{
      Object.getPrototypeOf(c.position).set.call(c.position,...eye);
      Object.getPrototypeOf(c).lookAt.call(c,...target); c.updateMatrixWorld(true);
    };
    c.position.copy=function(){return this;}; c.position.set=function(){return this;}; c.lookAt=()=>{};
    document.querySelectorAll('body *').forEach(e=>{if(e.tagName!=='CANVAS')e.style.visibility='hidden';});
    document.querySelector('#game canvas').style.visibility='visible';
  });
  console.error('Landscape ready; capturing four fixed views.');
  const views=[];
  const featureViews = process.env.FEATURES ? await page.evaluate(() => {
    const track=window.__zoomies.track;
    return track.features.runs.filter(r=>['bridge','tunnel','causeway'].includes(r.kind)).map(r=>[r.kind,((r.i0-6+track.samples)%track.samples)/track.samples]);
  }) : [];
  const focusViews = process.env.FOCUS_FILE ? [['clearance', await page.evaluate(p=>window.__zoomies.track.project(p).t-.005, JSON.parse(await fs.readFile(process.env.FOCUS_FILE,'utf8')))]] : [];
  for(const [name,t] of [['track-a',.06],['track-b',.38],['track-c',.72],['mountain',null],...featureViews,...focusViews]){
    await page.evaluate(({t})=>{
      const z=window.__zoomies;
      if(t!==null){const a=z.track.getPointAt(t),b=z.track.getPointAt(t+.025),dir=b.clone().sub(a).normalize();window.__setLandscapeCamera([a.x-dir.x*22,a.y+12,a.z-dir.z*22],[b.x,b.y,b.z]);}
      else{
        let peaks;z.scene.traverse(o=>{if(o.userData.mountains)peaks=o.userData.mountains;});
        const p=[...peaks].sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
        const a=Math.atan2(p.z,p.x);window.__setLandscapeCamera([p.x-Math.cos(a)*420,p.y+p.h*.5,p.z-Math.sin(a)*420],[p.x,p.y+p.h*.45,p.z]);
      }
    },{t});
    await page.waitForTimeout(3500);
    await page.screenshot({path:path.join(out,name+'.png'),timeout:120000});
    console.error(`Captured ${name}`);
    views.push(await page.evaluate(name=>({name,render:{...window.__zoomies.renderer.info.render},memory:{...window.__zoomies.renderer.info.memory}}),name));
  }
  const scene=await page.evaluate(()=>{
    let triangles=0,mountainTriangles=0,batches=0,invalid=0,missingColors=0,waterMeshes=0;
    const waterMaterials=new Set();
    window.__zoomies.scene.traverse(o=>{
      if(!o.isMesh||!o.geometry)return;
      const g=o.geometry, n=(g.index?.count||g.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);
      if(g.attributes.aShore && g.attributes.aLen){waterMeshes++;waterMaterials.add(o.material);}
      triangles+=n; if(o.userData.mountains)mountainTriangles+=n;
      batches+=Array.isArray(o.material)?g.groups.length:1;
      for(const a of Object.values(g.attributes))for(const v of a.array)if(!Number.isFinite(v))invalid++;
      if((Array.isArray(o.material)?o.material:[o.material]).some(m=>m.vertexColors)&&!g.attributes.color)missingColors++;
    });
    return {triangles,mountainTriangles,batches,invalid,missingColors,waterMeshes,waterMaterials:waterMaterials.size};
  });
  if(scene.invalid||scene.missingColors)errors.push('Invalid landscape geometry or missing colors');
  if(!process.env.BASELINE && scene.waterMeshes && scene.waterMaterials!==1)errors.push('Identical lake materials must be shared');
  const biome = await page.evaluate(async () => { const {biomeNameAt,biomeWeatherAt}=await import("/src/scenery.js");const p=window.__zoomies.track._pts[0];return {name:biomeNameAt(p.x,p.z),weather:biomeWeatherAt(p.x,p.z)}; });
  if(process.env.BIOME && biome.name!==process.env.BIOME) errors.push("Requested biome did not load");
  const dressing=process.env.DRESSING ? await page.evaluate(async()=>{
    const {dressingFor,allowsDressing,habitatFits}=await import('/src/biome-dressing.js');
    const {biomeNameAt}=await import('/src/scenery.js');
    const scene=window.__zoomies.scene,placements=scene.userData.biomePlacements||[],birds=scene.userData.birdHabitats||[];
    const invalid=placements.filter(p=>{
      const name=biomeNameAt(p.x,p.z);
      return p.kind==='pigeonLoft' ? !dressingFor(name).pigeons : !allowsDressing(name,p.kind);
    });
    const wrongBirds=birds.filter(b=>!habitatFits(biomeNameAt,b.x,b.z,n=>dressingFor(n).bird===b.species,b.radius));
    return {placements, birds, invalid, wrongBirds};
  }) : {invalid:[],wrongBirds:[]};
  if(dressing.invalid.length||dressing.wrongBirds.length)errors.push('Scenery placed in incompatible habitat');
  const result={biome,scene,views,dressing,errors};
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(errors.length)process.exitCode=1;
} finally {
  // Native Chrome can leave its close handshake pending after exiting. Bound
  // teardown so a completed screenshot tour doesn't stall a multi-biome audit.
  await Promise.race([browser?.close(),new Promise(resolve=>setTimeout(resolve,5000))]);
  server.closeAllConnections();server.close();
}
process.exit(process.exitCode || 0);
