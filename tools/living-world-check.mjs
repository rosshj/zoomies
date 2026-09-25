// Exercise real wildlife/event controllers over continuous time, then render
// representative moving assets with game materials and a pinned viewer camera.
import {chromium} from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-living-check';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}try{const file=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',file.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),results=[];
try {
 for(const biome of (process.env.BIOMES?.split(',') || ['meadow','forest','beach','desert','city','wetlands','volcanic','tundra'])) {
  const page=await browser.newPage({viewport:{width:1000,height:700}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?webgl=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
  const result=await page.evaluate(async biome=>{
    const THREE=await import('three'),{Track}=await import('/src/track.js'),{buildWorld,biomeNameAt}=await import('/src/scenery.js'),{setSeed}=await import('/src/rng.js'),{allowsDressing}=await import('/src/biome-dressing.js'),{toonify}=await import('/src/toon.js');
    setSeed('HABITAT');const track=new Track({mode:'custom',seed:'HABITAT',size:.4,curviness:.45,twist:.4,hilliness:.3,hills:.4,biomes:[biome]});
    const scene=new THREE.Group();scene.add(track.group);const world=buildWorld(scene,track,{detail:.35});
    const errors=[],animals=[];world.update(0,.1,null);
    scene.traverse(o=>{if(o.userData.behaviour)animals.push(o);});
    const target=animals.find(o=>o.userData.flight)||animals[0];
    const player=target?target.position.clone().add(new THREE.Vector3(2,0,2)):new THREE.Vector3();
    const seen=new Set(),point=new THREE.Vector3();let steamFrames=0;
    for(let step=1;step<=900;step++) {
      const t=step*.1;world.update(t,.1,step<50?player:null);
      for(const a of animals) {
        seen.add(a.userData.behaviour);
        if(!allowsDressing(biomeNameAt(a.position.x,a.position.z),a.userData.dressing.kind))errors.push('Animal left its habitat');
        if(![a.position.x,a.position.y,a.position.z,a.rotation.y].every(Number.isFinite))errors.push('Invalid animal pose');
      }
      for(const b of world.biomeEvents.boats) {
        if(!['beach','wetlands'].includes(biomeNameAt(b.obj.position.x,b.obj.position.z)))errors.push('Boat left its habitat');
        if(Math.hypot(b.obj.position.x-b.x,b.obj.position.z-b.z)>b.radius+.001)errors.push('Boat escaped its validated orbit');
      }
      if(world.biomeEvents.steam?.visible)steamFrames++;
    }
    if(target && !seen.has('startled')&&!seen.has('takeoff'))errors.push('No kart reaction');
    if(target?.userData.flight && !seen.has('takeoff'))errors.push('Gull never took off');
    const parked=target?.position.clone();world.update(91,.1,new THREE.Vector3(1e6,0,1e6));
    if(target&&!target.position.equals(parked))errors.push('Distant animal kept updating');
    if(world.livingDetails.meshes>8||world.livingDetails.flags>2||world.biomeEvents.boats.length>2||world.biomeEvents.vents.length>2)errors.push('Motion budget exceeded');
    scene.traverse(o=>{if(o.userData.canopyShape==='palm') {
      const p=o.geometry.attributes.position,b=o.geometry.attributes.aBend;
      for(let i=0;i<p.count;i++) {
        const r=Math.hypot(p.getX(i),p.getZ(i));if(r<.11&&b.getY(i)!==0)errors.push('Unpinned palm root');
        if(r>2&&b.getY(i)<=0)errors.push('Palm tip cannot move');
      }
    }});
    // Render the real attached motion detail, event or canopy, not a substitute.
    const pose=world.biomeEvents.vents.length?(38-world.biomeEvents.vents[0].phase)%38+2:3;
    world.update(pose,1,null);
    const chosen=world.biomeEvents.boats[0]?.obj || world.livingDetails.items[0]?.obj || target;
    const v=window.__viewer;v.scene.remove(v.scene.children.at(-1));v.scene.add(scene);toonify(scene);v.camera.layers.enable(1);
    let cameraTarget;
    if(world.biomeEvents.vents.length) {const vent=world.biomeEvents.vents[0];cameraTarget=new THREE.Vector3(vent.x,vent.y+2,vent.z);v.orbit.radius=18;}
    else if(chosen) {chosen.getWorldPosition(point);cameraTarget=point.clone();v.orbit.radius=biome==='beach'||biome==='wetlands'?13:9;}
    else {cameraTarget=track._pts[0].clone();v.orbit.radius=24;}
    v.orbit.target.copy(cameraTarget).add(new THREE.Vector3(0,1,0));v.orbit.phi=1.1;v.orbit.theta=.7;
    if(chosen && world.livingDetails.items.some(i=>i.obj===chosen)){const forward=new THREE.Vector3(0,0,1).applyQuaternion(chosen.quaternion);v.orbit.theta=Math.atan2(forward.x,forward.z)+.2;v.orbit.phi=1.45;v.orbit.target.copy(cameraTarget);}
    v.freeze(pose);world.update(pose,1,null);
    window.__motionProbe={world,scene,target,player};
    return {biome,animals:animals.length,behaviours:[...seen],details:world.livingDetails.counts,boats:world.biomeEvents.boats.length,vents:world.biomeEvents.vents.length,steamFrames,errors:[...new Set(errors)]};
  },biome);
  await page.waitForTimeout(1000);await page.screenshot({path:path.join(out,biome+'.png')});
  await page.evaluate(()=>{const {world}=window.__motionProbe,v=window.__viewer;v.freeze(7);world.update(7,1,null);return true;});
  await page.waitForTimeout(200);await page.screenshot({path:path.join(out,biome+'-later.png')});
  if(biome==='beach') {
    await page.evaluate(async()=>{
      const THREE=await import('three'),{scene}=window.__motionProbe,v=window.__viewer;let palm;
      scene.traverse(o=>{if(!palm&&o.userData.canopyShape==='palm')palm=o;});
      if(!palm)throw Error('No palm to inspect');const m=new THREE.Matrix4();palm.getMatrixAt(0,m);v.orbit.target.setFromMatrixPosition(m);v.orbit.radius=13;v.orbit.phi=1.15;v.orbit.theta=.8;v.freeze(2);
    });
    await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'palm-2.png')});
    await page.evaluate(()=>window.__viewer.freeze(7));await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'palm-7.png')});
    await page.evaluate(()=>{const {target,world}=window.__motionProbe,v=window.__viewer;v.orbit.target.copy(target.position);v.orbit.radius=8;v.orbit.phi=1.25;v.orbit.theta=.7;const p=target.position.clone();p.x+=2;
      for(let i=0;i<12;i++)world.update(110+i*.1,.1,p);v.orbit.target.copy(target.position);v.orbit.target.y+=.6;v.freeze(111.1);
    });
    await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'gull-takeoff.png')});
  }
  result.errors.push(...errors);results.push(result);console.log(JSON.stringify(result));await page.close();
 }
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(results,null,2));
 if(results.some(r=>r.errors.length))process.exitCode=1;
} finally {await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(process.exitCode||0);
