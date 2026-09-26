// Regression probe: sample the RENDERED terrain triangles and mountain faces
// over the actual road mesh, not the terrain height function used to build it.
import './terrain-clearance-unit.mjs';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root=process.env.ART_ROOT || path.resolve(new URL('..',import.meta.url).pathname);
const server=http.createServer(async(req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}
  try{const file=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',file.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile(file));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const recipes=JSON.parse(await fs.readFile(new URL('./fixtures/terrain-clearance-tracks.json',import.meta.url),'utf8'));
const results=[];
try {
  for(const recipe of recipes.filter(r=>!process.env.CASE || r.name===process.env.CASE)) {
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
    const result=await page.evaluate(async recipe=>{
      const THREE=await import('three');const {Track}=await import('/src/track.js');const {buildWorld}=await import('/src/scenery.js');const {setSeed}=await import('/src/rng.js');
      setSeed(recipe.cfg.seed||12345);const track=new Track(recipe.cfg),scene=new THREE.Scene();scene.add(track.group);
      const start=performance.now();buildWorld(scene,track,{detail:.1});const buildMs=performance.now()-start;
      let terrain;const mountainBins=new Map(),cell=40;
      scene.traverse(o=>{
        if(o.userData.terrainTile)terrain=o.geometry.attributes.position;
        if(!o.userData.mountains)return;
        const p=o.geometry.attributes.position,ix=o.geometry.index;
        for(let i=0;i<(ix?ix.count:p.count);i+=3){const v=[0,1,2].map(j=>{const k=ix?ix.getX(i+j):i+j;return [p.getX(k),p.getY(k),p.getZ(k)];});
          const xs=v.map(p=>p[0]),zs=v.map(p=>p[2]);
          for(let x=Math.floor(Math.min(...xs)/cell);x<=Math.floor(Math.max(...xs)/cell);x++)for(let z=Math.floor(Math.min(...zs)/cell);z<=Math.floor(Math.max(...zs)/cell);z++){const key=x+':'+z;if(!mountainBins.has(key))mountainBins.set(key,[]);mountainBins.get(key).push(v);}
        }
      });
      const stride=Math.round(Math.sqrt(terrain.count)),seg=stride-1,half=-terrain.getX(0),step=half*2/seg;
      const groundY=(x,z)=>{
        const gx=(x+half)/step,gz=(z+half)/step,ix=Math.floor(gx),iz=Math.floor(gz),u=gx-ix,v=gz-iz,a=iz*stride+ix;
        if(ix<0||iz<0||ix>=seg||iz>=seg)return -Infinity;
        return u+v<=1?terrain.getY(a)*(1-u-v)+terrain.getY(a+1)*u+terrain.getY(a+stride)*v:terrain.getY(a+stride+1)*(u+v-1)+terrain.getY(a+1)*(1-v)+terrain.getY(a+stride)*(1-u);
      };
      const surfaceY=(tri,x,z)=>{const [a,b,c]=tri,den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(den)<1e-8)return -Infinity;
        const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den;
        return u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6?u*a[1]+v*b[1]+(1-u-v)*c[1]:-Infinity;};
      const road=track.group.children[0].geometry,p=road.attributes.position,ix=road.index;
      let terrainHits=0,mountainHits=0,maxTerrainOverlap=-Infinity,samples=0;const examples=[];
      // Vertices AND triangle centroids catch both road edges and interpolation.
      const check=(x,y,z)=>{samples++;const overlap=groundY(x,z)-y;maxTerrainOverlap=Math.max(maxTerrainOverlap,overlap);
        if(overlap>0.005){terrainHits++;if(examples.length<6)examples.push({kind:'terrain',x,y,z,overlap});}
        for(const tri of mountainBins.get(Math.floor(x/cell)+':'+Math.floor(z/cell))||[])if(surfaceY(tri,x,z)>y+.005){mountainHits++;if(examples.length<6)examples.push({kind:'mountain',x,y,z});break;}
      };
      for(let i=0;i<p.count;i++)check(p.getX(i),p.getY(i),p.getZ(i));
      for(let i=0;i<ix.count;i+=3){const a=ix.getX(i),b=ix.getX(i+1),c=ix.getX(i+2);check((p.getX(a)+p.getX(b)+p.getX(c))/3,(p.getY(a)+p.getY(b)+p.getY(c))/3,(p.getZ(a)+p.getZ(b)+p.getZ(c))/3);}
      const clearance=scene.userData.mountainClearance||[];
      return {name:recipe.name,cfg:recipe.cfg,samples,terrainHits,mountainHits,maxTerrainOverlap,examples,buildMs,loweredVertices:scene.userData.terrainClearance?.loweredVertices,relocatedPeaks:clearance.filter(p=>p.moved).length,peaks:clearance.length,crossovers:track.features.runs.filter(r=>r.kind==='crossover').length};
    },recipe);
    results.push(result);console.log(JSON.stringify(result));await page.close();
  }
  if(process.env.OUT)await fs.writeFile(process.env.OUT,JSON.stringify(results,null,2));
  if(!process.env.BASELINE&&results.some(r=>r.terrainHits||r.mountainHits))process.exitCode=1;
} finally {await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(process.exitCode||0);
