import {chromium} from 'playwright-core';
import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-kart-ui';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const f=root+(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]);res.setHeader('content-type',f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.jpg')?'image/jpeg':'application/octet-stream');res.end(await fs.readFile(f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const p=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  if(!localStorage.getItem('zoomies-profile-v1')){
   localStorage.setItem('zoomies-profile-v1',JSON.stringify({unlocked:['custom.kart',...Array.from({length:34},(_,i)=>'kart.'+i)],treats:0}));
   localStorage.setItem('zoomies-garage-v1',JSON.stringify({v:2,cat:0,kart:10,customKart:{name:'Legacy Kart',color:0x32938a,style:6,number:77}}));
   localStorage.setItem('zoomies-quality-v2','high');localStorage.setItem('zoomies-track-v1',JSON.stringify({mode:'custom',seed:'KARTS-UI',size:.5,curviness:.4,twist:.3,hilliness:.25,hills:.4,biomes:['meadow']}));
  }
 });
 const url=`http://127.0.0.1:${server.address().port}/?webgpu=1&nosw=1&nowd=1`;
 const load=async()=>{await p.goto(url);await p.waitForFunction(()=>window.__zoomies?.track,null,{timeout:180000});};
 const editor=async()=>{await p.evaluate(()=>document.querySelector('#startline-edit').click());await p.evaluate(()=>document.querySelector('#cat-grid button').click());await p.getByText('Custom Kart',{exact:true}).click();};
 await load();await editor();
 const editorResult=await p.evaluate(()=>{
  const assert=(x,m)=>{if(!x)throw Error(m);};
  assert(document.querySelector('#kart-custom-name').value==='Legacy Kart','Old custom selection/name lost');
  assert(document.querySelector('#kart-style-name').textContent==='Cage','Old style 6 did not migrate');
  const labels=new Set();for(let i=0;i<17;i++){labels.add(document.querySelector('#kart-style-name').textContent);document.querySelector('#kart-style-next').click();}assert(labels.size===17,'Missing chassis');
  while(document.querySelector('#kart-style-name').textContent!=='Sprint')document.querySelector('#kart-style-next').click();
  while(document.querySelector('#kart-livery-name').textContent!=='Chevron')document.querySelector('#kart-livery-next').click();
  return {styles:[...labels]};
 });
 await p.waitForTimeout(750);await p.screenshot({path:`${out}/creator.png`});
 // Check the tallest chassis in the same showroom and a phone-sized viewport.
 await p.evaluate(()=>{while(document.querySelector('#kart-style-name').textContent!=='Rallycross')document.querySelector('#kart-style-next').click();});
 await p.waitForTimeout(750);await p.screenshot({path:`${out}/creator-rally.png`});
 await p.setViewportSize({width:844,height:390});await p.waitForTimeout(750);
 await p.locator('#kart-livery-next').scrollIntoViewIfNeeded();await p.locator('#kart-livery-next').click();
 await p.locator('#kart-edit-use').scrollIntoViewIfNeeded();await p.screenshot({path:`${out}/creator-phone.png`});
 await p.setViewportSize({width:1100,height:800});
 await p.evaluate(()=>{while(document.querySelector('#kart-style-name').textContent!=='Sprint')document.querySelector('#kart-style-next').click();while(document.querySelector('#kart-livery-name').textContent!=='Chevron')document.querySelector('#kart-livery-next').click();});
 await p.evaluate(()=>document.querySelector('#kart-edit-use').click());
 const save=await p.evaluate(()=>JSON.parse(localStorage.getItem('zoomies-garage-v1')));
 if(save.v!==3||save.kart!==34||save.kartId!=='custom'||save.customKart.style!==6||save.customKart.livery!==2||save.customKart.number!==77)throw Error('Creator save failed');
 await load();await editor();
 if(await p.locator('#kart-style-name').textContent()!=='Sprint'||await p.locator('#kart-livery-name').textContent()!=='Chevron')throw Error('New style 6 remapped on reload');
 await p.evaluate(()=>{document.querySelector('#kart-edit-use').click();document.querySelector('#go-btn').click();});await p.waitForFunction(()=>window.__zoomies.karts?.length===6,null,{timeout:180000});
 const racers=await p.evaluate(async()=>{
  const {KART_PRESETS}=await import('/src/presets.js');
  return window.__zoomies.karts.map(k=>{
   const model=k.group.children.find(o=>o.userData.kartStyle!==undefined);if(!model)throw Error('Missing kart model');
   if(k.isPlayer&&(model.userData.kartStyle!==6||model.userData.kartLivery!==2))throw Error('Player livery dropped');
   if(!k.isPlayer&&!KART_PRESETS.some(p=>p.style===model.userData.kartStyle&&(p.livery??0)===model.userData.kartLivery))throw Error('Unknown AI livery');
   return {name:k.name,player:k.isPlayer,style:model.userData.kartStyle,livery:model.userData.kartLivery};
  });
 });
 await p.waitForTimeout(1500);await p.screenshot({path:`${out}/race.png`});
 // Version 3 index 10 must select Club Racer, not the old custom sentinel.
 await p.evaluate(()=>{const c=JSON.parse(localStorage.getItem('zoomies-garage-v1'));c.kart=10;c.kartId=null;localStorage.setItem('zoomies-garage-v1',JSON.stringify(c));});
 await load();await p.evaluate(()=>document.querySelector('#go-btn').click());await p.waitForFunction(()=>window.__zoomies.karts?.length===6,null,{timeout:180000});
 const style=await p.evaluate(()=>window.__zoomies.karts.find(k=>k.isPlayer).group.children.find(o=>o.userData.kartStyle!==undefined).userData.kartStyle);
 if(style!==5)throw Error('New preset mistaken for legacy Custom Kart');
 if(errors.length)throw Error(errors.join('\n'));
 const result={editorResult,save,racers,presetStyle:style,errors};await fs.writeFile(`${out}/results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
