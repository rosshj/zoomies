import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<script type="importmap">{"imports":{"three":"/vendor/three/three.webgpu.min.js","three/webgpu":"/vendor/three/three.webgpu.min.js","three/tsl":"/vendor/three/three.tsl.min.js"}}</script>');return;}res.setHeader('content-type','text/javascript');res.end(await fs.readFile(path.join(root,req.url)));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
 for(const backend of (process.env.BACKENDS||'webgl,webgpu').split(',')) {
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async backend=>{
 const {simplifyScenery}=await import('/src/scenery-lod.js');
 const T=await import('three'),{installSceneryRendering}=await import('/src/scenery-shadows.js');
 const r=new T.WebGPURenderer({forceWebGL:backend==='webgl'});await r.init();if((r.backend.isWebGPUBackend?'webgpu':'webgl')!==backend)throw Error('Requested backend fell back');r.setSize(256,256);r.shadowMap.enabled=true;r.shadowMap.type=T.PCFShadowMap;
 const s=new T.Scene(),c=new T.PerspectiveCamera(50,1,.1,100);c.position.set(10,12,15);c.lookAt(0,0,0);
 s.add(new T.AmbientLight(0xffffff,.3));const sun=new T.DirectionalLight(0xffffff,2);sun.position.set(6,10,4);sun.castShadow=true;sun.shadow.mapSize.set(256,256);sun.shadow.camera.left=sun.shadow.camera.bottom=-12;sun.shadow.camera.right=sun.shadow.camera.top=12;sun.shadow.camera.far=40;sun.shadow.autoUpdate=false;s.add(sun,sun.target);
 const ground=new T.Mesh(new T.PlaneGeometry(30,30),new T.MeshStandardMaterial());ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;s.add(ground);
 const fixed=new T.Mesh(new T.BoxGeometry(3,4,3),new T.MeshStandardMaterial({color:0x5577aa}));fixed.position.set(-3,2,0);fixed.castShadow=true;fixed.layers.set(1);sun.shadow.camera.layers.enable(1);s.add(fixed);
 const live=new T.Mesh(new T.BoxGeometry(2,2,2),new T.MeshStandardMaterial({color:0xdd6633}));live.position.set(3,1,0);live.castShadow=true;s.add(live);
 installSceneryRendering(r,sun);const node=sun.shadow.shadowNode;
 const target=new T.RenderTarget(256,256);r.setRenderTarget(target);
 const read=async()=>{await new Promise(requestAnimationFrame);r.render(s,c);return Array.from(await r.readRenderTargetPixelsAsync(target,0,0,256,256));};
 // Camera sees only the receiver: geometry differences cannot mask a changed
 // silhouette. The sun sees layer 1 and must always use the original caster.
 const full=fixed.geometry,far=new T.BoxGeometry(1,1,1),diffs=[];
 const difference=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
 for(const x of [3,-1,5]) {
   live.position.x=x;fixed.geometry=full;sun.shadow.needsUpdate=true;
   const reference=await read();if(new Set(reference).size<16)throw Error('Blank shadow reference');
   fixed.geometry=far;fixed.shadowGeometry=full;sun.shadow.needsUpdate=true;
   const distant=await read();diffs.push(difference(reference,distant));
   if(fixed.geometry!==far)throw Error('Visual geometry was not restored');
 }
 sun.position.x=8;sun.shadow.mapSize.set(128,128);sun.shadow.needsUpdate=true;
 const resized=await read();fixed.geometry=full;sun.shadow.needsUpdate=true;
 const reference=await read(),resizeDiff=difference(resized,reference);
 fixed.castShadow=live.castShadow=false;sun.shadow.needsUpdate=true;
 const shadowSignal=difference(await read(),reference);
 if(shadowSignal<.05)throw Error('Probe did not render visible shadows');
 if(diffs.some(d=>d>.15)||resizeDiff>.15)throw Error('Scenery LOD changed shadow pixels');
 // Merged props are non-indexed, tree crowns indexed. Exercise both visible
 // geometry switches with unequal buffer sizes, including the post/shadow path.
 const {toonify}=await import('/src/toon.js');
 const switched=[];
 for(const indexed of [false,true]) {
   const source=new T.SphereGeometry(1.2,20,16),near=indexed?source:source.toNonIndexed(),distant=simplifyScenery(near,.5);
   const object=new T.Mesh(near,new T.MeshStandardMaterial({color:0x66aa33}));
   object.position.set(indexed?3:-3,2,0);object.castShadow=true;object.shadowGeometry=near;toonify(object);s.add(object);
   switched.push({object,near,distant});
 }
 for(let i=0;i<12;i++){
   for(const e of switched)e.object.geometry=i%2?e.distant:e.near;
   sun.shadow.needsUpdate=true;await read();
 }
 target.dispose();node.dispose();r.dispose();return {backend,diffs,resizeDiff,shadowSignal};
 },backend);
 console.log(JSON.stringify({result,errors}));if(errors.length)throw Error('Browser errors');await page.close();
 }
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
