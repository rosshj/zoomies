// Real procedural road + real prop lifecycle, native rendering and art ray checks.
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-prop-contact';
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{
 if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}
 if(req.url==='/'){const html=await fs.readFile(path.join(root,'viewer.html'),'utf8');res.setHeader('content-type','text/html');res.end(`<body style="margin:0"><script type="importmap">${html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]}</script></body>`);return;}
 res.setHeader('content-type','text/javascript');res.end(await fs.readFile(path.join(root,req.url)));
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{for(const backend of ['webgl','webgpu']){
 const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async backend=>{
  const T=await import('three'),{Track}=await import('/src/track.js'),{initProps}=await import('/src/props.js'),{toonify}=await import('/src/toon.js');
  const track=new Track({mode:'custom',seed:'CONTACT',size:.5,curviness:.65,twist:.5,hilliness:.8,hills:.7,biomes:['meadow']});
  const scene=new T.Scene();scene.background=new T.Color(0xa9c9dd);scene.add(track.group);
  const props=await initProps(scene,track,{seed:'CONTACT'});if(!props)throw Error('Props disabled');props.setItemsEnabled(false);
  const ray=new T.Raycaster(),point=new T.Vector3(),origin=new T.Vector3(),down=new T.Vector3(0,-1,0);
  const road=new T.Mesh(new T.BufferGeometry(),new T.MeshBasicMaterial({side:T.DoubleSide}));road.updateMatrixWorld();
  let checks=0,minClearance=Infinity;
  const check=pr=>{
   const geo=new T.BufferGeometry(),ix=track.roadSurface.geometry.index,indices=[];
   for(let k=-4;k<=4;k++){const row=(pr.roadIndex+k+track.samples)%track.samples;for(let j=0;j<60;j++)indices.push(ix.getX(row*60+j));}
   geo.setAttribute('position',track.roadSurface.geometry.attributes.position);geo.setIndex(indices);road.geometry=geo;
   pr.mesh.updateMatrixWorld(true);
   pr.mesh.traverse(o=>{if(!o.isMesh||o===pr.glow)return;const p=o.geometry.attributes.position;
    for(let i=0;i<p.count;i++){
     point.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld);origin.set(point.x,track._pts[pr.roadIndex].y+8,point.z);ray.set(origin,down);ray.far=18;
     const hits=ray.intersectObject(road);if(hits.length){const gap=point.y-hits[0].point.y;minClearance=Math.min(minClearance,gap);if(gap<-.005)throw Error(`Art penetrated road: ${gap}`);checks++;}
    }
   });geo.dispose();
  };
  for(const pr of props._props)if(pr.mode==='ground')check(pr);
  // Place a crate and barrel side by side on a steep real section, then launch
  // both into the fence. Others retain their normal generated placements.
  const shown=[props._props.find(p=>p.mode==='ground'&&p.kind==='crate'),props._props.find(p=>p.kind==='barrel')];
  if(shown.some(p=>!p))throw Error('Missing prop kind');
  let index=20;for(let i=20;i<track.samples-20;i++)if(Math.abs(track._tans[i].y)>.15){index=i;break;}
  const base=track._pts[index],side=new T.Vector3().crossVectors(track._tans[index],new T.Vector3(0,1,0)).normalize();
  shown.forEach((pr,i)=>{pr.roadIndex=index+i*2;pr.pos.copy(track._pts[pr.roadIndex]).addScaledVector(side,track.halfWidth-3);pr.pos.y+=4;pr.quat.setFromEuler(new T.Euler(.8+i,.2,1.1));pr.vel.copy(side).multiplyScalar(22).addScaledVector(track._tans[index],i?3:-3);pr.vel.y=2;pr.angVel.set(8,4,-9);pr.asleep=pr.settle=false;pr.quiet=0;pr.spent=true;});
  for(let i=0;i<900;i++){props.update(1/120,[]);if(i%30===0)shown.forEach(check);}
  if(shown.some(p=>!p.asleep||p.settle))throw Error('Props did not settle');shown.forEach(check);
  scene.add(new T.HemisphereLight(0xdbeeff,0x847759,2));const sun=new T.DirectionalLight(0xfff2dc,2.2);sun.position.copy(base).add(new T.Vector3(30,60,30));scene.add(sun);
  toonify(scene);const renderer=new T.WebGPURenderer({forceWebGL:backend==='webgl',antialias:true});await renderer.init();
  if((renderer.backend.isWebGPUBackend?'webgpu':'webgl')!==backend)throw Error('Backend fallback');
  renderer.setSize(1100,700);renderer.toneMapping=T.ACESFilmicToneMapping;document.body.appendChild(renderer.domElement);
  const focus=shown[0].pos.clone().lerp(shown[1].pos,.5),camera=new T.PerspectiveCamera(48,1100/700,.1,1500);
  camera.position.copy(focus).addScaledVector(side,-12).addScaledVector(track._tans[index],-7).add(new T.Vector3(0,7,0));camera.lookAt(focus);
  for(let i=0;i<5;i++){await new Promise(requestAnimationFrame);renderer.render(scene,camera);}
  return {backend,checks,minClearance,index,grade:track._tans[index].y,landed:shown.map(p=>({kind:p.kind,asleep:p.asleep,position:p.pos.toArray(),quaternion:p.quat.toArray()}))};
 },backend);
 await page.screenshot({path:path.join(out,`${backend}.png`)});result.errors=errors;rows.push(result);console.log(JSON.stringify(result));if(errors.length)throw Error('Browser errors');await page.close();
}await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));}
finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
