// Whole-world bake coverage and cold/warm generation costs. No FPS claims.
import {chromium} from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.env.ART_ROOT||path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-baked-world';
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}try{const file=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',file.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const rows=[];
try {
 for(const biome of ['meadow','forest','city','beach','volcanic']) {
  const page=await browser.newPage();
  // Viewer boot is outside the timed region; only world construction is timed.
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html`);
  await page.waitForFunction(()=>window.__viewer);
  const row=await page.evaluate(async({biome,baseline})=>{
   const THREE=await import('three'),{Track}=await import('/src/track.js'),{buildWorld}=await import('/src/scenery.js'),{setSeed}=await import('/src/rng.js');
   const lighting=baseline?null:await import('/src/baked-lighting.js'),runs=[];
   for(let repeat=0;repeat<2;repeat++) {
    setSeed('SHADE');const track=new Track({mode:'custom',seed:'SHADE',size:.5,curviness:.45,twist:.4,hilliness:.25,hills:.4,biomes:[biome]});
    const scene=new THREE.Scene(),before=lighting?{...lighting.bakeStats}:{};
    const start=performance.now();const world=buildWorld(scene,track,{detail:1});const buildMs=performance.now()-start;
    let invalid=0,triangles=0;scene.traverse(o=>{if(o.geometry){for(const v of o.geometry.attributes.color?.array||[])if(!Number.isFinite(v)||v<0)invalid++;if(o.isMesh)triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
    const stats=lighting?Object.fromEntries(Object.entries(lighting.bakeStats).map(([k,v])=>[k,v-before[k]])):null;
    const ground=scene.userData.groundContactBake;
    if(invalid)throw Error('Invalid baked colours');
    if(!baseline && (!ground?.shaded || !stats.vertices))throw Error('Missing world bake coverage');
    for(const e of world.lod?.entries||[])for(const a of Object.values(e.far.attributes))if(!a.array.every(Number.isFinite))throw Error('Invalid distant geometry');
    runs.push({buildMs,triangles,invalid,bake:stats,ground,context:scene.userData.worldShelter,lod:world.lod?.stats});
   }
   return {biome,runs};
  },{biome,baseline:!!process.env.BASELINE});
  rows.push(row);console.log(JSON.stringify(row));await page.close();
 }
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));
} finally {await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
