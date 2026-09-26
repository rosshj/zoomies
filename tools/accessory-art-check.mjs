// Native accessory fitting/render audit. PW_CHROME selects Chrome; OUT saves
// front/side/back/driving sheets. MODELS optionally serves a baseline models.js
// for visual/budget comparisons (it skips new behavioral assertions).
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-accessory-art';
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const f=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(process.env.MODELS && f.endsWith('/src/models.js') ? process.env.MODELS : f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{
 for(const backend of ['webgl','webgpu']){
  const page=await browser.newPage({viewport:{width:360,height:440}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?${backend}=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
  const accessories=await page.evaluate(async()=> (await import('/src/models.js')).CAT_ACCESSORIES);
  for(const accessory of accessories){
   const result=await page.evaluate(async accessory=>{
    const v=window.__viewer;v.setBackground('#c5d6df');v.setGameLook(true);
    v.showPreset({kind:'cat',fur:0xc8966a,pattern:'spotted',accessory});v.freeze(0);
    v.orbit.theta=.4;v.orbit.phi=1.4;v.orbit.target.set(0,2.55,.1);v.orbit.radius=4.1;
    const object=v.scene.children.at(-1);let triangles=0,draws=0;
    object.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;draws+=Math.max(1,o.geometry.groups.length);}});
    const T=await import('three'),ear=object.userData.rig.earL.children[0];
    ear.geometry.computeBoundingBox();const size=ear.geometry.boundingBox.getSize(new T.Vector3()).toArray();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {accessory,triangles,draws,earSize:size,backend:v.backend};
   },accessory);
   if(result.backend!==backend)throw Error('Backend fallback');rows.push(result);
   if(backend==='webgpu'){
     await page.screenshot({path:path.join(out,accessory+'.png')});
     for(const [name,theta] of [['side',1.6],['back',3.2]]){
       await page.evaluate(async theta=>{window.__viewer.orbit.theta=theta;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},theta);
       await page.screenshot({path:path.join(out,accessory+'-'+name+'.png')});
     }
   }
   // Exercise actual accessory selection in the kart, using the viewer's
   // normal composition, scaling and seat offset.
   await page.evaluate(async accessory=>{
     const {ACCESSORY_LABELS}=await import('/src/models.js');
     const button=[...document.querySelectorAll('#list button')].find(b=>b.textContent===ACCESSORY_LABELS[accessory]);
     if(button)button.click();else [...document.querySelectorAll('#list button')].find(b=>b.textContent==='Cat — Solid').click();
     document.querySelector('[data-pose="drive"]').click();
     const v=window.__viewer;v.freeze(0);v.orbit.theta=.55;v.orbit.phi=1.18;
     if(accessory==='none'){
       const {createCat}=await import('/src/models.js');
       const combo=v.scene.children.at(-1),old=combo.children.find(o=>o.userData.rig);
       const cat=createCat(0x8c9298,{pattern:'solid',pose:'kart',accessory:'none'});
       cat.position.copy(old.position);cat.scale.copy(old.scale);combo.remove(old);combo.add(cat);
       v.setGameLook(false);v.setGameLook(true);
     }
     await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   },accessory);
   if(backend==='webgpu')await page.screenshot({path:path.join(out,accessory+'-drive.png')});
   await page.evaluate(()=>document.querySelector('[data-pose="sit"]').click());
  }
  if(!process.env.MODELS)await page.evaluate(async()=>{
    const {createCat,updateCatRig,CAT_ACCESSORIES}=await import('/src/models.js');
    const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
    const {EXTRA_ACCESSORIES,updateExtraAccessory}=await import('/src/cat-accessories.js');
    const {ACCESSORY_LABELS,ACCESSORY_COLORS}=await import('/src/models.js');
    assert(new Set(CAT_ACCESSORIES).size===CAT_ACCESSORIES.length,'Duplicate accessory ids');
    for(const id of Object.keys(EXTRA_ACCESSORIES)){
      assert(CAT_ACCESSORIES.includes(id)&&ACCESSORY_LABELS[id]&&ACCESSORY_COLORS[id].length,'Missing wardrobe registration');
      const a=createCat(0xc8966a,{pattern:'spotted',accessory:id,pose:'kart'});
      const b=createCat(0xc8966a,{pattern:'spotted',accessory:id,pose:'kart'});
      const parts=[];a.traverse(o=>{if(o.userData.accessoryId===id)parts.push(o);});
      assert(parts.length===1,`${id}: accessory omitted or duplicated`);
      let draws=0,transparent=0,triangles=0;
      parts[0].traverse(o=>{if(o.isMesh){
        draws++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;
        assert(o.geometry.userData.shared&&o.material.userData.shared,`${id}: unshared resources`);
        if(o.material.transparent){transparent++;assert(!o.material.depthWrite&&o.material.side===0,`${id}: dome pass budget`);}
      }});
      assert(draws<=3&&triangles<3000,`${id}: extra accessory budget`);
      assert(transparent===(id==='space'?1:0),`${id}: unexpected transparency`);
      if(a.userData.rig.accessory){
        assert(a.userData.rig.accessory.object!==b.userData.rig.accessory.object,`${id}: shared animated transform`);
      }
    }
    const makeMotion=()=>createCat(0xc8966a,{accessory:'propeller',pose:'kart'}).userData.rig.accessory;
    const slow=makeMotion(),fast=makeMotion();updateExtraAccessory(slow,.02,0,0);updateExtraAccessory(fast,.02,0,30);
    assert(fast.object.rotation.y>slow.object.rotation.y*5,'Propeller does not follow speed');
    const angles=[];
    for(const hz of [30,60,120]){const m=makeMotion();for(let i=0;i<hz*2;i++)updateExtraAccessory(m,1/hz,.2,20);angles.push(m.object.rotation.y);}
    assert(Math.max(...angles)-Math.min(...angles)<1e-6,'Propeller depends on frame rate');
    const blinkA=createCat(0xc8966a,{accessory:'space'}).userData.rig.accessory,blinkB=createCat(0xc8966a,{accessory:'space'}).userData.rig.accessory;
    updateExtraAccessory(blinkA,1.1,0,0);assert(!blinkA.object.visible&&blinkB.object.visible,'Blink lights leak between cats');
    for(const accessory of CAT_ACCESSORIES)for(const pose of ['sit','kart','stand'])for(const color of ['#ffffff','#0a0a0a','#e23b3b']){
      const cat=createCat(0xc8966a,{pattern:'spotted',accessory,pose,accessoryColor:color});
      let triangles=0;
      cat.traverse(o=>{
        if(!o.isMesh)return;
        const g=o.geometry,count=g.index?.count??g.attributes.position.count;
        triangles+=count/3;
        for(const a of Object.values(g.attributes))assert(a.array.every(Number.isFinite),`${accessory}: non-finite geometry`);
        for(const group of g.groups){
          assert(group.start+group.count<=count,`${accessory}: invalid group bounds`);
          assert(!Array.isArray(o.material)||o.material[group.materialIndex],`${accessory}: cached material mismatch`);
        }
      });
      assert(triangles<11000,`${accessory}: cat triangle budget`);
      const rig=cat.userData.rig;
      for(let i=0;i<90;i++)updateCatRig(rig,1/60,.65,.2,false,false,false);
      if(rig.earMotionScale===0)assert(rig.earL.rotation.x===0&&rig.earL.rotation.z===0,`${accessory}: ears cross hat openings`);
      else assert(Math.abs(rig.earL.rotation.z)>.05,`${accessory}: exposed ears lost their animation`);
      assert(Math.abs(rig.head.rotation.z)>.05,`${accessory}: head animation lost`);
    }
  });
  if(errors.length)throw Error(errors.join('\n'));await page.close();
 }
 const sheet=await browser.newPage({viewport:{width:1440,height:460}});
 for(const angle of ['', '-side', '-back', '-drive']){
   const cards=await Promise.all(rows.filter(r=>r.backend==='webgpu').map(async r=>`<div><img src="data:image/png;base64,${(await fs.readFile(path.join(out,r.accessory+angle+'.png'))).toString('base64')}"><p>${r.accessory}</p></div>`));
   await sheet.setContent(`<style>body{margin:0;background:#c5d6df;font:18px system-ui}.grid{display:grid;grid-template-columns:repeat(4,1fr)}img{width:360px;height:440px}p{margin:0;text-align:center;height:20px}</style><div class="grid">${cards.join('')}</div>`);
   await sheet.screenshot({path:path.join(out,'accessories'+angle+'.png'),fullPage:true});
 }
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify({renders:rows.length,variants:process.env.MODELS?0:rows.length*9,errors:[]}));
}finally{await browser.close();server.closeAllConnections();server.close();}
