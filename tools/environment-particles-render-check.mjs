// Native backend checks: atlas appearance, bounded shared pool, shader warmup,
// full-lap placement, two-view selection and a real moving GPU wake.
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';import http from 'node:http';import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-environment-particles';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}if(req.url==='/'){const h=await fs.readFile(path.join(root,'viewer.html'),'utf8');res.setHeader('content-type','text/html');res.end(`<body style="margin:0"><script type="importmap">${h.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]}</script></body>`);return;}res.setHeader('content-type','text/javascript');res.end(await fs.readFile(path.join(root,req.url)));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),results=[];
try{for(const backend of ['webgl','webgpu']){
 const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async backend=>{
  const T=await import('three'),{EffectsManager}=await import('/src/effects.js'),{ENVIRONMENT_PROFILES:profiles,environmentAtlas,debrisLight}=await import('/src/environment-particles.js'),{buildEnvironmentCover}=await import('/src/environment-cover.js'),{makeRng}=await import('/src/rng.js'),{setWindClock}=await import('/src/wind.js');
  const assert=(v,m)=>{if(!v)throw Error(m);};
  const scene=new T.Scene();scene.background=new T.Color(0x788b9b);const fx=new EffectsManager(scene);
  const renderer=new T.WebGPURenderer({forceWebGL:backend==='webgl',antialias:true});await renderer.init();renderer.setSize(1100,700);document.body.appendChild(renderer.domElement);
  assert((renderer.backend.isWebGPUBackend?'webgpu':'webgl')===backend,'Backend fallback');
  const camera=new T.PerspectiveCamera(42,1100/700,.1,1000);camera.position.set(0,4,15);camera.lookAt(0,4,0);
  const render=async()=>{await new Promise(requestAnimationFrame);renderer.render(scene,camera);};
  fx.warmup(new T.Vector3(0,-100,0));fx.update(0);await render();const warm=renderer.info.memory.programs;fx.update(5);
  let i=0;for(const [name,spec] of Object.entries(profiles)){
    fx._spawn(new T.Vector3((i%5-2)*2.5,6-Math.floor(i/5)*2,0),new T.Color(spec.colors[0]),{env:true,tile:spec.tile,size:1.6,opacity:1,life:10,angle:.2});i++;
  }fx.update(0);await render();assert(renderer.info.memory.programs===warm,'First environmental burst compiled a shader');
  assert(fx.environmentField.mesh.material.blending===T.NormalBlending,'Debris glows');
  assert(fx.sparkField.mesh.material.blending===T.AdditiveBlending&&!fx.sparkField.mesh.material.rotationNode,'Boost changed');
  const atlas=environmentAtlas().image,alpha=atlas.getContext('2d').getImageData(0,0,256,128).data;
  for(let tile=0;tile<8;tile++){let count=0;for(let y=0;y<64;y++)for(let x=0;x<64;x++)if(alpha[((Math.floor(tile/4)*64+y)*256+tile%4*64+x)*4+3]>30)count++;assert(count>100&&count<3000,'Atlas tile blank or square');}
  window.probe={T,scene,fx,renderer,camera,render,profiles,buildEnvironmentCover,makeRng,setWindClock,debrisLight};
  return {backend,warmPrograms:warm,burstPrograms:renderer.info.memory.programs,atlas:[256,128]};
 },backend);
 await page.screenshot({path:path.join(out,`atlas-${backend}.png`)});
 result.budgets=await page.evaluate(async()=>{
  const {T,fx,scene,camera,buildEnvironmentCover,profiles,makeRng}=window.probe,assert=(v,m)=>{if(!v)throw Error(m);};fx.update(20);
  for(let i=0;i<100;i++)fx._spawn(new T.Vector3(),new T.Color('white'),{env:true,life:2,opacity:1});assert(fx.environmentCount===80,'Environmental cap');
  for(let i=0;i<280;i++)fx._spawn(new T.Vector3(),new T.Color('white'),{life:2,opacity:1});assert(fx.parts.length===280&&fx.environmentCount===0,'Gameplay priority');
  for(let i=0;i<100;i++)fx._spawn(new T.Vector3(),new T.Color('white'),{env:true,life:2,opacity:1});assert(fx.parts.length===280&&fx.environmentCount===0,'Debris evicted gameplay');fx.update(5);assert(fx.parts.length===0,'Expiry');
  const track={samples:1000,halfWidth:12,_pts:[],_tans:[]};for(let i=0;i<1000;i++){const a=i/1000*Math.PI*2;track._pts.push(new T.Vector3(Math.cos(a)*100,0,Math.sin(a)*100));track._tans.push(new T.Vector3(-Math.sin(a),0,Math.cos(a)));}
  const rows=[];for(const biome of Object.keys(profiles)){
    const world=new T.Scene(),cover=buildEnvironmentCover(world,track,()=>0,()=>({name:biome}),makeRng('cover'),()=>false,()=>false);
    const bins=Array(10).fill(0);for(const r of cover.records.ground)bins[Math.floor(r.t*10)]++;
    assert(bins.every(n=>n>0),biome+' lacks lap coverage');assert(cover.records.ground.length<=1900&&cover.records.falling.length<=320,'Placement cap');
    for(const m of cover.meshes){assert(m.geometry.index.count===12,'Card triangle budget');assert(m.boundingSphere.radius>=3,'Motion bounds');}
    if(profiles[biome].fall){const fb=Array(10).fill(0);cover.records.falling.forEach(r=>fb[Math.floor(r.t*10)]++);assert(fb.every(n=>n>0),biome+' falling coverage');}
    rows.push({biome,ground:cover.records.ground.length,falling:cover.records.falling.length,bins});
  }
  const {Track}=await import('/src/track.js'),{biomeNameAt}=await import('/src/scenery.js'),{featureSpanBlock}=await import('/src/features.js');
  const actual=new Track({mode:'custom',seed:'PARTICLE-MIXED',size:.5,curviness:.45,hilliness:.3,hills:.4,biomes:Object.keys(profiles)});
  const mixed=buildEnvironmentCover(new T.Scene(),actual,(x,z)=>actual.groundInfo(x,z).y,(x,z,y)=>({name:biomeNameAt(x,z,y)}),makeRng('mixed'),(x,z)=>featureSpanBlock(actual.features,x,z),()=>false);
  const mixedCounts={};for(const r of [...mixed.records.ground,...mixed.records.falling]){
    assert(r.biome===biomeNameAt(r.x,r.z,r.y),'Mixed habitat mismatch');mixedCounts[r.biome]=(mixedCounts[r.biome]||0)+1;
  }
  assert(Object.keys(mixedCounts).length>3,'Mixed track not exercised');
  const floor=new T.Mesh(new T.PlaneGeometry(260,260).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:0x39434b}));floor.position.y=-.02;scene.add(floor);
  camera.layers.enable(1);
  const cover=buildEnvironmentCover(scene,track,()=>0,()=>({name:'blossom'}),makeRng('cover'),()=>false,()=>false);
  window.probe.cover=cover;const near=new T.Vector3(100,5,10),far=new T.Vector3(-1000,5,0);
  cover.update([],far,1/60,[{position:near},{position:far}]);assert(cover.meshes.some(m=>m.visible),'Second viewport excluded');
  const full=cover.meshes.reduce((n,m)=>n+m.count,0);cover.setQuality('low');cover.update([],near);assert(cover.meshes.reduce((n,m)=>n+m.count,0)<full,'Quality density');cover.setQuality('medium');
  const kart={position:new T.Vector3(100,0,0),groundY:0,heading:0,speed:50,isPlayer:true,airborne:true};cover.update([kart],near);assert(cover.wakes.slice(0,4).every(w=>w.value.w===0),'Airborne wake');
  window.probe.kart=kart;
  return {shared:280,environment:80,rows,mixedCounts};
 });
 await page.evaluate(async()=>{const p=window.probe;p.camera.position.set(100,4,10);p.camera.lookAt(100,.3,0);p.setWindClock(1);p.cover.update([],p.camera.position);await p.render();if(p.renderer.info.render.drawCalls<1)throw Error("Ground cover was not rendered");});
 const restImage=await page.screenshot({path:path.join(out,`rest-${backend}.png`)});
 await page.evaluate(async()=>{const p=window.probe;p.kart.airborne=false;p.kart.groundY=12;p.kart.position.y=12;p.cover.update([p.kart],p.camera.position);await p.render();});
 const raisedImage=await page.screenshot();if(!restImage.equals(raisedImage))throw Error('Elevated road disturbed the lower cover');
 result.heightGate='pixel-identical at +12 road height';
 await page.evaluate(async()=>{const p=window.probe;p.kart.groundY=0;p.kart.position.y=0;p.kart.airborne=false;p.cover.update([p.kart],p.camera.position);p.setWindClock(1.1);await p.render();});
 await page.screenshot({path:path.join(out,`wake-${backend}.png`)});
 result.ambient=await page.evaluate(async()=>{
   const {initGpuParticles}=await import('/src/gpuparticles.js'),p=window.probe;
   const motes=await initGpuParticles(p.scene,p.renderer,{count:240});if(!motes)throw Error('Ambient compute failed');
   motes.setEnvironment('volcanic');motes.update(1/60,p.camera.position);await p.render();
   if(motes.mesh.material.blending!==p.T.NormalBlending||motes.mesh.count!==240)throw Error('Ambient budget/blend');
   motes.setVisible(false);if(motes.mesh.visible)throw Error('Ambient quality toggle');return {count:240,blend:'normal'};
 });
 result.errors=errors;results.push(result);console.log(JSON.stringify(result));if(errors.length)throw Error(errors.join('\n'));await page.close();
}await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(results,null,2));}
finally{await browser.close();server.closeAllConnections();server.close();}
