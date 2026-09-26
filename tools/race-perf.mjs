// Native full-race comparison, including simulation, weather, particles and post.
// ART_ROOT selects a checkout. AI drives the human kart only inside this probe.
// MODELS overrides models.js for a focused before/after comparison. ACCESSORY
// forces the same accessory on every cat to stress its worst rendering case.
// CAT_TYPE and CAT_PATTERN pin morphology/coat; KART_STYLE pins the chassis.
// ACCESSORIES_FILE overrides the extra wardrobe alongside a prior MODELS build.
// RACING_KARTS_FILE pins the procedural shell/paint module for livery comparisons.
import {chromium} from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.env.ART_ROOT||path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-race-perf';
await fs.mkdir(out,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
async function sourceFile(file) {
 if(file.endsWith("/src/racing-karts.js")&&process.env.RACING_KARTS_FILE)return fs.readFile(process.env.RACING_KARTS_FILE);
 if(file.endsWith("/src/cat-accessories.js")&&process.env.ACCESSORIES_FILE)return fs.readFile(process.env.ACCESSORIES_FILE);
 if(!file.endsWith('/src/models.js')||(!process.env.MODELS&&!process.env.ACCESSORY&&!process.env.CAT_TYPE&&!process.env.CAT_PATTERN&&process.env.KART_STYLE===undefined))return fs.readFile(file);
 let code=await fs.readFile(process.env.MODELS||file,'utf8');
 if(process.env.ACCESSORY||process.env.CAT_TYPE||process.env.CAT_PATTERN){
  if(!code.includes('export function createCat('))throw Error('Cat factory changed; update the probe');
  code=code.replace('export function createCat(', 'function createCatForProbe(');
  const override={};
  if(process.env.ACCESSORY)override.accessory=process.env.ACCESSORY;
  if(process.env.CAT_TYPE)override.type=process.env.CAT_TYPE;
  if(process.env.CAT_PATTERN)override.pattern=process.env.CAT_PATTERN;
  code+=`\nexport function createCat(fur,opts={}) { return createCatForProbe(fur,{...opts,...${JSON.stringify(override)}}); }`;
 }
 if(process.env.KART_STYLE!==undefined){
  code=code.replace('export function createKartModel(', 'function createKartForProbe(');
  code+=`\nexport function createKartModel(color,opts={}){return createKartForProbe(color,{...opts,style:${Number(process.env.KART_STYLE)}});}`;
 }
 return code;
}
const server=http.createServer(async(req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}try{const file=path.join(root,req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0]);res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(await sourceFile(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
try {
for(const biome of (process.env.BIOMES||'forest,city,wetlands').split(','))for(const quality of (process.env.QUALITIES||'medium,high').split(',')){
 const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:Number(process.env.DPR||1)}),errors=[],logs=[];
 page.on('pageerror',e=>{if(errors.length<12)errors.push(e.message);});page.on('console',m=>{if(m.type()==='error'){if(errors.length<12)errors.push(m.text());}if(m.text().includes('[zoomies] perf')||m.text().includes('[zoomies] FREEZE'))logs.push(m.text());});
 await page.addInitScript(({biome,quality})=>{
  let s=12345;Math.random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
  localStorage.setItem('zoomies-quality-v2',quality);localStorage.setItem('zoomies-fps','1');localStorage.setItem('zoomies-difficulty','expert');
  localStorage.setItem('zoomies-track-v1',JSON.stringify({mode:'custom',seed:'RUNTIME',size:.5,curviness:.45,twist:.4,hilliness:.25,hills:.4,biomes:[biome],timeOfDay:biome==='city'?'night':'midday'}));
  const raf=window.requestAnimationFrame.bind(window);window.__raceSamples=[];
  window.requestAnimationFrame=cb=>raf(t=>{const z=window.__zoomies,before=z?.track?.raceTime,start=performance.now();cb(t);if(window.__sampleRace&&z?.track?.raceTime>before){window.__raceSamples.push({t,cpu:performance.now()-start,sim:z.track.raceTime,draws:z.renderer.info.render.drawCalls});}});
 },{biome,quality});
 const backend=process.env.BACKEND||'webgl';
 await page.goto(`http://127.0.0.1:${server.address().port}/?${backend}=1&nosw=1&nowd=1&seed=RUNTIME`,{waitUntil:'domcontentloaded',timeout:240000});
 await page.waitForFunction(()=>window.__zoomies?.track,null,{timeout:240000});
 await page.evaluate(()=>document.getElementById('go-btn').click());
 await page.waitForFunction(()=>window.__zoomies.karts?.length>1,null,{timeout:120000});
 await page.evaluate(()=>{const k=window.__zoomies.karts.find(k=>k.isPlayer);k.isPlayer=false;k.skill=1;window.__probePlayer=k;});
 await page.waitForFunction(()=>window.__zoomies.track.raceTime>8,null,{timeout:180000});
 await page.evaluate(()=>{window.__raceSamples.length=0;window.__sampleRace=true;});
 await page.waitForTimeout(Number(process.env.SECONDS||40)*1000);
 const result=await page.evaluate(()=>{
  window.__sampleRace=false;const z=window.__zoomies,samples=window.__raceSamples,dt=samples.slice(1).map((s,i)=>s.t-samples[i].t),sorted=[...dt].sort((a,b)=>a-b),cpu=samples.map(s=>s.cpu).sort((a,b)=>a-b);
  const q=(a,p)=>a[Math.min(a.length-1,Math.floor(a.length*p))],sum=a=>a.reduce((a,b)=>a+b,0),tail=sorted.slice(Math.floor(sorted.length*.99));
  return {drawingBuffer:[z.renderer.domElement.width,z.renderer.domElement.height],frames:samples.length,meanFps:1000/(sum(dt)/dt.length),onePercentLow:1000/(sum(tail)/tail.length),p95Ms:q(sorted,.95),p99Ms:q(sorted,.99),worstMs:sorted.at(-1),cpuMedianMs:q(cpu,.5),cpuP99Ms:q(cpu,.99),drawsMean:sum(samples.map(s=>s.draws))/samples.length,simSeconds:samples.at(-1).sim-samples[0].sim,readout:document.querySelector('#fps-counter')?.textContent,backend:z.renderer.backend.isWebGPUBackend?'webgpu':'webgl',memory:{...z.renderer.info.memory},lod:z.world.lod?.stats,bake:z.scene.userData.worldShelter,playerT:window.__probePlayer.trackT,samples};
 });
 if(result.backend!==backend)errors.push('Requested backend fell back');
 if(result.frames<100||result.simSeconds<5)errors.push('Insufficient racing samples');
 await page.screenshot({path:path.join(out,`${biome}-${quality}.png`)});
 let modes;
 if(process.env.VERIFY){modes=await page.evaluate(()=>{
   const z=window.__zoomies,k=window.__probePlayer;
   z.setSaver(true);const saved={projected:k.groundShadow.visible};
   z.setSaver(false);return saved;
 });if(!modes.projected)errors.push('Saver failed to restore projected shadows');}
 const row={biome,quality,requestedBackend:backend,...result,modes,errors,logs};results.push(row);console.log(JSON.stringify({...row,samples:undefined,logs:undefined}));
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(results,null,2));await page.close();if(errors.length)throw Error(errors.join('\n'));
}
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
