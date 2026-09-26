// Construct every single-biome world plus a mixed world, then advance actual
// wildlife transforms and validate their habitats. No screenshot/FPS claims.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BIOME_DRESSING } from '../src/biome-dressing.js';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const server=http.createServer(async(req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}
  try {const file=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',file.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile(file));}
  catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
try {
  for(const name of [...Object.keys(BIOME_DRESSING),'mixed']) {
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);
    await page.waitForFunction(()=>window.__viewer);
    const result=await page.evaluate(async name=>{
      const THREE=await import('three');
      const {Track}=await import('/src/track.js');
      const {buildWorld,BIOME_NAMES,biomeNameAt}=await import('/src/scenery.js');
      const {setSeed}=await import('/src/rng.js');
      const {BIOME_DRESSING,dressingFor,allowsDressing}=await import('/src/biome-dressing.js');
      if(BIOME_NAMES.some(n=>!BIOME_DRESSING[n]))throw Error('Unconfigured biome');
      setSeed('HABITAT');
      const track=new Track({mode:'custom',seed:'HABITAT',size:.4,curviness:.45,twist:.4,hilliness:.3,hills:.4,biomes:name==='mixed'?BIOME_NAMES:[name]});
      const scene=new THREE.Scene();scene.add(track.group);
      const world=buildWorld(scene,track,{detail:.5});
      const errors=[],kinds={};
      for(const p of scene.userData.biomePlacements) {
        kinds[p.kind]=(kinds[p.kind]||0)+1;
        const n=biomeNameAt(p.x,p.z);
        if(p.kind==='pigeonLoft'?!dressingFor(n).pigeons:!allowsDressing(n,p.kind))errors.push(`${p.kind} in ${n}`);
      }
      // Advance the existing animation code, not a second test-only orbit model.
      const pos=new THREE.Vector3();
      const loft=scene.userData.biomePlacements.find(p=>p.kind==="pigeonLoft");
      const player=loft?new THREE.Vector3(loft.x,0,loft.z):null;
      for(let t=0;t<120;t+=3) {
        world.update(t,.1,player);scene.updateMatrixWorld(true);
        scene.traverse(o=>{
          if(o.userData.dressing && o.userData.wander) {
            o.getWorldPosition(pos);const n=biomeNameAt(pos.x,pos.z);
            if(!allowsDressing(n,o.userData.dressing.kind))errors.push(`roaming ${o.userData.dressing.kind} in ${n}`);
          }
          if(o.userData.habitatSpecies) {
            o.getWorldPosition(pos);const n=biomeNameAt(pos.x,pos.z);
            if(dressingFor(n).bird!==o.userData.habitatSpecies)errors.push(`flying ${o.userData.habitatSpecies} in ${n}`);
          }
          if(o.userData.habitatAnimal) {
            o.getWorldPosition(pos);const n=biomeNameAt(pos.x,pos.z);
            if(!dressingFor(n)[o.userData.habitatAnimal])errors.push(`${o.userData.habitatAnimal} in ${n}`);
          }
        });
      }
      let invalid=0,missingColors=0;
      scene.traverse(o=>{if(!o.geometry)return;for(const attr of Object.values(o.geometry.attributes))for(const v of attr.array)if(!Number.isFinite(v))invalid++;
        if(o.material?.vertexColors&&!o.geometry.attributes.color)missingColors++;
      });
      if(invalid||missingColors)errors.push('invalid geometry/colours');
      return {name,kinds,flocks:scene.userData.birdHabitats,errors:[...new Set(errors)]};
    },name);
    results.push(result);console.log(JSON.stringify(result));await page.close();
  }
  if(process.env.OUT)await fs.writeFile(process.env.OUT,JSON.stringify(results,null,2));
  if(results.some(r=>r.errors.length))process.exitCode=1;
} finally {await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(process.exitCode||0);
