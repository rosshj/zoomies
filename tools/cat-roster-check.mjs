// Native renderer gallery and morphology/accessory compatibility probe.
import {chromium} from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-cat-roster';
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const f=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{
 for(const backend of ['webgl','webgpu']){
  const page=await browser.newPage({viewport:{width:320,height:400}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?${backend}=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
  const presets=await page.evaluate(async()=> {
   const {CAT_PRESETS}=await import('/src/presets.js'),{CAT_ACCESSORIES,CAT_PATTERNS}=await import('/src/models.js');
   for(const c of CAT_PRESETS)if(!CAT_ACCESSORIES.includes(c.accessory)||!CAT_PATTERNS.includes(c.pattern))throw Error('Unregistered preset appearance');
   return CAT_PRESETS;
  });
  for(const [i,c] of presets.entries()){
   const result=await page.evaluate(async c=>{
    const v=window.__viewer;v.setBackground('#c5d6df');v.setGameLook(true);v.showPreset({kind:'cat',...c});v.freeze(0);
    v.orbit.theta=.5;v.orbit.phi=1.36;v.orbit.target.set(0,1.85,.1);v.orbit.radius=6.3;
    const cat=v.scene.children.at(-1);let triangles=0,draws=0;
    cat.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;draws+=Math.max(1,o.geometry.groups.length);}});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {name:c.name,type:cat.userData.catType,triangles,draws,backend:v.backend};
   },c);
   if(result.backend!==backend)throw Error('Renderer fallback');rows.push(result);
   if(backend==='webgpu'){
    await page.screenshot({path:`${out}/cat-${i}.png`});
    await page.evaluate(async c=>{window.__viewer.showPreset({kind:'cat',...c,accessory:'none'});const v=window.__viewer;v.freeze(0);v.orbit.theta=.5;v.orbit.phi=1.36;v.orbit.target.set(0,1.85,.1);v.orbit.radius=6.3;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},c);
    await page.screenshot({path:`${out}/cat-${i}-bare.png`});
    await page.evaluate(async()=>{window.__viewer.orbit.theta=3.6;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    await page.screenshot({path:`${out}/cat-${i}-back.png`});
    await page.evaluate(name=>[...document.querySelectorAll('#list button')].find(b=>b.textContent===name).click(),c.name);
    await page.evaluate(()=>document.querySelector('[data-pose="drive"]').click());
    await page.evaluate(async()=>{const v=window.__viewer;v.freeze(0);v.orbit.theta=.55;v.orbit.phi=1.18;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    await page.screenshot({path:`${out}/cat-${i}-drive.png`});
    await page.evaluate(()=>document.querySelector('[data-pose="sit"]').click());
   }
  }
  if(backend==='webgl'&&!process.env.GALLERY_ONLY){
   const result=await page.evaluate(async()=>{
    const {CAT_TYPES}=await import('/src/cat-types.js'),{CAT_PRESETS}=await import('/src/presets.js');
    const {CAT_ACCESSORIES,createCat,updateCatRig,disposeGroup}=await import('/src/models.js');
    let combinations=0,maxTriangles=0,maxDraws=0;
    for(const [type,desc] of Object.entries(CAT_TYPES))for(const accessory of CAT_ACCESSORIES){
     const preset=CAT_PRESETS.find(c=>c.type===type)||CAT_PRESETS[0];
     for(const pose of ['sit','kart','stand']){
      const cat=createCat(preset.fur,{...preset,type,accessory,pose});let triangles=0,draws=0;
      cat.traverse(o=>{if(o.isMesh){const g=o.geometry;triangles+=(g.index?.count??g.attributes.position.count)/3;draws+=Math.max(1,g.groups.length);
       for(const a of Object.values(g.attributes))if(!a.array.every(Number.isFinite))throw Error(`${type}/${accessory}: nonfinite geometry`);
       for(const group of g.groups)if(Array.isArray(o.material)&&!o.material[group.materialIndex])throw Error('Bad material slot');
      }});
      if(triangles>12000||draws>32)throw Error(`${type}/${accessory}/${pose}: ${triangles} triangles ${draws} batches`);
      if(cat.userData.catType!==desc.label)throw Error('Dropped morphology');
      const rig=cat.userData.rig;for(let k=0;k<30;k++)updateCatRig(rig,1/60,.7,.4,false,false,true,false,24);
      if(!Number.isFinite(rig.head.rotation.z)||!Number.isFinite(rig.tail.rotation.x))throw Error('Broken rig');
      if(type==='manx'&&rig.tail.visible)throw Error('Manx tail visible');
      if(['helmet','viking','rain','detective'].includes(accessory)?rig.earL.visible:!rig.earL.visible)throw Error('Wrong costume ear coverage');
      if(['classic','round','wide'].includes(desc.ear)){
       const g=rig.earL.children[0].geometry;g.computeBoundingBox();
       if(g.boundingBox.max.z-g.boundingBox.min.z>.09)throw Error('Thick slab ears returned');
      }
      if(['wizard','helmet','dragon','mushroom','detective','straw'].includes(accessory)){
       let paint=false;cat.traverse(o=>{for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m?.map?.userData.accessoryPaint)paint=true;});
       if(!paint)throw Error('Surface decoration lost its painted material');
      }
      if(rig.earMotionScale===0&&rig.earL.rotation.x!==0)throw Error('Hat ears not anchored');
      maxTriangles=Math.max(maxTriangles,triangles);maxDraws=Math.max(maxDraws,draws);combinations++;disposeGroup(cat);
     }
    }
    return {combinations,maxTriangles,maxDraws};
   });console.log(JSON.stringify(result));await fs.writeFile(`${out}/compatibility.json`,JSON.stringify(result,null,2));
  }
  if(errors.length)throw Error(errors.join('\n'));await page.close();
 }
 await fs.writeFile(`${out}/metrics.json`,JSON.stringify(rows,null,2));
 const page=await browser.newPage({viewport:{width:1280,height:400}});
 for(const angle of ['', '-bare','-back','-drive']){
  const cards=await Promise.all(rows.filter(r=>r.backend==='webgpu').map(async(r,i)=>`<div><img src="data:image/png;base64,${(await fs.readFile(`${out}/cat-${i}${angle}.png`)).toString('base64')}"><p>${r.name} · ${r.type}</p></div>`));
  await page.setContent(`<style>body{margin:0;background:#c5d6df;font:14px system-ui}.grid{display:grid;grid-template-columns:repeat(4,1fr)}img{width:320px;display:block}p{height:24px;margin:0;text-align:center}</style><div class="grid">${cards.join('')}</div>`);
  await page.screenshot({path:`${out}/roster${angle}.png`,fullPage:true});
 }
 console.log(JSON.stringify({renders:rows.length,errors:[]}));
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
