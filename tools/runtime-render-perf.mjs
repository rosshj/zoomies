// Controlled within-build comparison: full detail versus distant LOD. Timings describe shadow-update renders, not game FPS.
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-runtime-render';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}try{const file=path.join(root,req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0]);res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(file));}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const rows=[];
try{
for(const biome of (process.env.BIOMES||'forest,city,wetlands').split(',')){
 const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(biome=>{
  localStorage.setItem('zoomies-quality-v2','high');localStorage.setItem('zoomies-track-v1',JSON.stringify({mode:'custom',seed:'RUNTIME',size:.5,curviness:.45,twist:.4,hilliness:.25,hills:.4,biomes:[biome],timeOfDay:biome==='city'?'night':'midday'}));
  const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>raf(t=>{if(!window.__stopRenderProbe)cb(t);});
 },biome);
 await page.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1&seed=RUNTIME`,{waitUntil:'domcontentloaded',timeout:240000});await page.waitForFunction(()=>window.__zoomies?.world,null,{timeout:240000});await page.waitForTimeout(4000);await page.evaluate(()=>{window.__stopRenderProbe=true;});await page.waitForTimeout(100);
 const result=await page.evaluate(async()=>{
  const z=window.__zoomies,{renderer:r,scene,camera:c,track,world}=z,gl=r.backend.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'),dbg=gl.getExtension('WEBGL_debug_renderer_info');
  const device=dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'unknown';if(!ext||/swiftshader|llvmpipe/i.test(device))throw Error('Native GPU timer required');
  r._nodes.nodeFrame.time=0;r._nodes.nodeFrame.deltaTime=0;
  const wind=await import('/src/wind.js');wind.setWindClock(0);
  const sun=scene.children.find(o=>o.isDirectionalLight&&o.castShadow),shadowNode=sun.shadow.shadowNode,drawShadow=shadowNode.renderShadow;
  let shadowPasses=0;shadowNode.renderShadow=function(frame){shadowPasses++;return drawShadow.call(this,frame);};
  const rows=[],shots=[];scene.traverse(o=>{if(o.material?.isSpriteNodeMaterial)o.visible=false;});
  for(const t of [.06,.38,.72]){
   const a=track.getPointAt(t),b=track.getPointAt(t+.025),dir=b.clone().sub(a).normalize();c.position.set(a.x-dir.x*22,a.y+12,a.z-dir.z*22);c.lookAt(b);c.updateMatrixWorld(true);
   const select=mode=>{if(mode==='full')for(const e of world.lod.entries)e.mesh.geometry=e.near;else world.lod.update([c]);};
   const render=()=>{r._nodes.nodeFrame.frameId++;sun.shadow.needsUpdate=true;r.render(scene,c);};
   const records={full:{gpuMs:[],cpuMs:[]},lod:{gpuMs:[],cpuMs:[]}};
   for(const mode of ['full','lod']){select(mode);for(let i=0;i<25;i++)render();}gl.finish();
   // Pair the modes and alternate order so GPU clock drift is not mistaken for
   // an LOD gain or regression. Every timed render updates the ordinary sun map.
   for(let j=0;j<9;j++)for(const mode of j%2?['lod','full']:['full','lod']){
     select(mode);for(let i=0;i<3;i++)render();gl.finish();
     const before=shadowPasses,q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
     const start=performance.now();for(let i=0;i<20;i++)render();
     records[mode].cpuMs.push((performance.now()-start)/20);gl.endQuery(ext.TIME_ELAPSED_EXT);gl.flush();
     if(shadowPasses-before!==20)throw Error('Shadow benchmark did not update every render');
     const deadline=performance.now()+10000;while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){if(performance.now()>deadline)throw Error('GPU query timed out');await new Promise(r=>setTimeout(r,5));}
     if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint GPU timing');
     records[mode].gpuMs.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6/20);gl.deleteQuery(q);
   }
   for(const mode of ['full','lod']){
     select(mode);r.info.reset();render();if(t===.38)shots.push({name:mode,data:r.domElement.toDataURL('image/png')});
     const record=records[mode];rows.push({t,mode,...record,medianGPU:[...record.gpuMs].sort((a,b)=>a-b)[4],medianCPU:[...record.cpuMs].sort((a,b)=>a-b)[4],render:{...r.info.render}});
   }
  }return {device,rows,shots,lod:world.lod.stats,bake:scene.userData.worldShelter};
 });for(const shot of result.shots)await fs.writeFile(path.join(out,`${biome}-${shot.name}.png`),Buffer.from(shot.data.split(',')[1],'base64'));delete result.shots;rows.push({biome,...result,errors});console.log(JSON.stringify({biome,rows:result.rows.map(r=>({t:r.t,mode:r.mode,gpu:r.medianGPU,cpu:r.medianCPU,draws:r.render.drawCalls,triangles:r.render.triangles})),errors}));await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));await page.close();if(errors.length)throw Error(errors.join('\n'));
}
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
