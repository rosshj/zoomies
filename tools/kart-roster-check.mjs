import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';import http from 'node:http';import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-racing-karts';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const f=root+req.url.split('?')[0];res.setHeader('content-type',f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{
 for(const backend of ['webgl','webgpu']){
  const page=await browser.newPage({viewport:{width:480,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?${backend}=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
  const count=await page.evaluate(async()=> (await import('/src/presets.js')).KART_PRESETS.length);
  for(let i=0;i<count;i++){
   const result=await page.evaluate(async i=>{
    const {KART_PRESETS}=await import('/src/presets.js'),k=KART_PRESETS[i],v=window.__viewer;
    v.setBackground('#c5d6df');v.showPreset({kind:'kart',...k});v.setGameLook(true);v.freeze(0);
    const kart=v.scene.children.at(-1);let triangles=0,batches=0;
    kart.traverse(o=>{if(o.isMesh){const g=o.geometry;triangles+=(g.index?.count??g.attributes.position.count)/3;batches+=Math.max(1,g.groups.length);for(const a of Object.values(g.attributes))if(!a.array.every(Number.isFinite))throw Error('Nonfinite kart');}});
    v.orbit.theta=.65;v.orbit.phi=1.1;v.orbit.target.set(0,k.style>=13&&k.style<=14?1.6:.8,0);v.orbit.radius=8.4;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(v.backend!==new URLSearchParams(location.search).keys().next().value)throw Error('Backend fallback');
    if(k.style>=5&&(triangles>9000||batches>21))throw Error(`${k.name} over budget: ${triangles}/${batches}`);
    return {...k,triangles,batches,backend:v.backend};
   },i);rows.push(result);
   if(backend==='webgpu'){
    await page.screenshot({path:`${out}/kart-${i}.png`});
    for(const [angle,theta,phi] of [['rear',3.75,1.1],['side',1.57,1.35],['top',.2,.3]]){
     await page.evaluate(async({theta,phi})=>{const v=window.__viewer;v.orbit.theta=theta;v.orbit.phi=phi;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},{theta,phi});
     await page.screenshot({path:`${out}/kart-${i}-${angle}.png`});
    }
    await page.evaluate(async()=>{
     const {createCat,updateCatRig}=await import('/src/models.js'),v=window.__viewer,kart=v.scene.children.at(-1);
     const cat=createCat(0xc8966a,{pattern:'spotted',accessory:'wizard',pose:'kart'});cat.scale.setScalar(.62);cat.position.set(0,.85,-.35);kart.add(cat);
     for(let n=0;n<60;n++)updateCatRig(cat.userData.rig,1/60,.7,.4,false,true,false,true,25);
     v.setGameLook(false);v.setGameLook(true);v.orbit.theta=3.65;v.orbit.phi=1.1;v.orbit.target.y=1.3;v.orbit.radius=10.3;
     await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    });await page.screenshot({path:`${out}/kart-${i}-driver.png`});
   }
  }
  if(!process.env.GALLERY_ONLY)await page.evaluate(async()=>{
   const {createKartModel,disposeGroup}=await import('/src/models.js');
   for(let style=0;style<17;style++)for(let livery=0;livery<8;livery++)for(const color of [0xe53935,0xfafafa,0x182030]){
    const a=createKartModel(color,{style,livery,number:37}),b=createKartModel(color,{style,livery,number:37});
    if(a.wheels.length!==4||a.brakeMat===b.brakeMat||a.flames===b.flames)throw Error('Rig sharing regression');
    for(let i=0;i<4;i++){
     const w=a.wheels[i];w.updateMatrixWorld(true);w.children[0].geometry.computeBoundingBox();
     const box=w.children[0].geometry.boundingBox.clone().applyMatrix4(w.matrixWorld);
     if(Math.abs(box.min.y)>.02)throw Error('Tire does not rest on ground');
     if(w.children[0].geometry!==b.wheels[i].children[0].geometry)throw Error('Wheel cache missed');
    }
    const shells=a.group.children.filter(o=>o.isMesh&&o.geometry.groups.length>=4),others=b.group.children.filter(o=>o.isMesh&&o.geometry.groups.length>=4);
    if(shells[0].geometry!==others[0].geometry)throw Error('Shell not shared');
    a.group.traverse(o=>{if(o.isMesh){const n=o.geometry.index?.count??o.geometry.attributes.position.count;for(const g of o.geometry.groups)if(g.start+g.count>n||!(Array.isArray(o.material)?o.material[g.materialIndex]:o.material))throw Error('Bad material group');}});
    disposeGroup(a.group);disposeGroup(b.group);
   }
  });
  if(errors.length)throw Error(errors.join('\n'));await page.close();
 }
 await fs.writeFile(`${out}/metrics.json`,JSON.stringify(rows,null,2));
 const page=await browser.newPage({viewport:{width:1440,height:384}});
 for(const angle of ['','-rear','-side','-top','-driver']){
  const cards=await Promise.all(rows.filter(r=>r.backend==='webgpu').map(async(r,i)=>`<div><img src="data:image/png;base64,${(await fs.readFile(`${out}/kart-${i}${angle}.png`)).toString('base64')}"><p>${r.name}</p></div>`));
  await page.setContent(`<style>body{margin:0;background:#c5d6df;font:18px system-ui}.grid{display:grid;grid-template-columns:repeat(3,1fr)}img{width:480px;display:block}p{margin:0;height:24px;text-align:center}</style><div class="grid">${cards.join('')}</div>`);
  await page.screenshot({path:`${out}/karts${angle}.png`,fullPage:true});
 }
 console.log(JSON.stringify({renders:rows.length,variants:816,errors:[]}));
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
