// Real biome layout, burst warm-up and offline procedural sound validation.
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';import http from 'node:http';import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-road-prop-integration';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}if(req.url==='/'){const h=await fs.readFile(path.join(root,'viewer.html'),'utf8');res.setHeader('content-type','text/html');res.end(`<body style="margin:0"><script type="importmap">${h.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]}</script></body>`);return;}res.setHeader('content-type','text/javascript');res.end(await fs.readFile(path.join(root,req.url)));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{for(const backend of ['webgl','webgpu']){
 const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async backend=>{
  const T=await import('three'),{Track}=await import('/src/track.js'),{initProps}=await import('/src/props.js'),{biomeNameAt}=await import('/src/scenery.js'),{ROAD_PROP_BIOMES}=await import('/src/road-prop-assets.js'),{toonify}=await import('/src/toon.js');
  const worlds=[];
  if(backend==='webgl')for(const biome of [...Object.keys(ROAD_PROP_BIOMES),'mixed']){
    const track=new Track({mode:'custom',seed:'REGION',size:.5,curviness:.5,hilliness:.5,hills:.4,twist:.4,biomes:biome==='mixed'?Object.keys(ROAD_PROP_BIOMES):[biome]});
    const scene=new T.Scene(),props=await initProps(scene,track,{seed:'REGION',biomeNameAt});if(!props)throw Error('Props build failed');
    const placed={};for(const pr of props._props){
      if(pr.profile&&!ROAD_PROP_BIOMES[biomeNameAt(pr.pos.x,pr.pos.z,pr.groundY)]?.includes(pr.kind))throw Error('Foreign road prop');
      placed[pr.kind]=(placed[pr.kind]||0)+1;
    }
    if(props.boxTargets().length!==5||!placed.crate||props.count>64)throw Error('Crate/count budget');
    worlds.push({biome,placed,count:props.count});
  }
  const track=new Track({mode:'custom',seed:'BURST',size:.5,curviness:.4,hilliness:.3,hills:.3,biomes:['meadow']});
  const scene=new T.Scene();scene.background=new T.Color(0x9ebecb);scene.add(track.group);
  const props=await initProps(scene,track,{seed:'BURST',biomeNameAt});props.setItemsEnabled(false);
  const source=props._props.find(p=>p.kind==='fruitBasket');if(!source)throw Error('No basket');
  scene.add(new T.HemisphereLight(0xd9efff,0x83724f,2));const sun=new T.DirectionalLight(0xffe5b7,2);sun.position.set(50,100,20);scene.add(sun);
  toonify(scene);const renderer=new T.WebGPURenderer({forceWebGL:backend==='webgl',antialias:true});await renderer.init();if((renderer.backend.isWebGPUBackend?'webgpu':'webgl')!==backend)throw Error('Fallback');
  renderer.setSize(1100,700);renderer.toneMapping=T.ACESFilmicToneMapping;document.body.appendChild(renderer.domElement);
  const camera=new T.PerspectiveCamera(50,1100/700,.1,1500);camera.position.copy(source.pos).add(new T.Vector3(-6,5,8));camera.lookAt(source.pos);
  for(let i=0;i<6;i++){props.update(1/60,[]);await new Promise(requestAnimationFrame);renderer.render(scene,camera);}
  const programsBefore=renderer.info.memory.programs;
  // Exercise all warmed fragment pipelines and actual destructive basket hit.
  const p=source.pos.clone(),t=track._tans[source.roadIndex];
  props.update(.05,[{x:p.x-t.x*7,z:p.z-t.z*7}]);props.update(.05,[{x:p.x+t.x*2,z:p.z+t.z*2}]);
  props._debris.burst('clay',source,()=>.5);props._debris.burst('leaf',source,()=>.5);
  for(let i=0;i<8;i++){props.update(1/120,[]);await new Promise(requestAnimationFrame);renderer.render(scene,camera);}
  if(!source.used||props._debris.activeCount<=0)throw Error('Burst not exercised');
  const programsAfter=renderer.info.memory.programs;
  if(programsAfter>programsBefore)throw Error(`First burst compiled pipelines: ${programsBefore} -> ${programsAfter}`);
  return {backend,worlds,programsBefore,programsAfter,debris:props._debris.activeCount};
 },backend);
 await page.screenshot({path:path.join(out,`burst-${backend}.png`)});
 if(backend==='webgl')result.audio=await page.evaluate(async()=>{
  const {audio}=await import('/src/audio.js');const results=[];
  for(const kind of ['wood','coconut','rubber','hay','rustle','fruit','plastic','pot','snow','ice','stone','metal']){
   const ctx=new OfflineAudioContext(1,22050*.4,22050);let nodes=0;
   audio.ctx=new Proxy(ctx,{get(t,k){if(k==='state')return 'running';if(k==='createOscillator')return()=>{nodes++;return t.createOscillator();};const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
   audio.sfxOn=true;audio.sfxGain=ctx.createGain();audio.sfxGain.connect(ctx.destination);audio._noise=ctx.createBuffer(1,22050,22050);
   let seed=123;const noise=audio._noise.getChannelData(0);for(let i=0;i<noise.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;noise[i]=seed/2147483648-1;}
   audio._lastPropImpact=-1;audio.propImpact(kind,{x:0,z:0},.7);audio.propImpact(kind,{x:0,z:0},.7);
   if(nodes!==1)throw Error('Sound rate limit');audio._lastPropImpact=-1;audio.sfxOn=false;audio.propImpact(kind,null);audio.sfxOn=true;audio.propImpact(kind,{x:10000,z:10000});if(nodes!==1)throw Error('Mute/distance created sound');
   const b=await ctx.startRendering(),values=b.getChannelData(0);let energy=0,peak=0,hash=0;
   for(let i=0;i<values.length;i++){const v=values[i];if(!Number.isFinite(v))throw Error('Invalid sound');energy+=v*v;peak=Math.max(peak,Math.abs(v));hash+=v*Math.sin(i*.123);}
   if(peak<.001||peak>=1)throw Error('Silent/clipped effect');results.push({kind,peak,rms:Math.sqrt(energy/values.length),signature:hash});
  }
  if(new Set(results.map(r=>r.signature.toFixed(4))).size!==results.length)throw Error('Identical material sounds');audio.ctx=null;return results;
 });
 result.errors=errors;rows.push(result);console.log(JSON.stringify(result));if(errors.length)throw Error('Browser errors');await page.close();
}await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));}
finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}process.exit(0);
