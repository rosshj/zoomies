import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {ROAD_PROPS} from '../src/road-prop-assets.js';
const root=path.resolve(new URL('..',import.meta.url).pathname),out=process.env.OUT||'/tmp/zoomies-road-prop-art';
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const f=path.join(root,req.url.split('?')[0]);res.setHeader('content-type',f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.PW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[];
try{
 for(const backend of ['webgl','webgpu']){
  const page=await browser.newPage({viewport:{width:420,height:360}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/viewer.html?${backend}=1&plain=1`);await page.waitForFunction(()=>window.__viewer);
  for(const [kind,spec] of Object.entries(ROAD_PROPS)){
   const result=await page.evaluate(async name=>{
    const v=window.__viewer;v.setBackground('#c5d6df');v.setGameLook(true);
    [...document.querySelectorAll('#list button')].find(b=>b.textContent===name).click();v.freeze(0);
    v.orbit.theta=.6;v.orbit.phi=1.05;
    const object=v.scene.children.at(-1);let triangles=0,draws=0;
    object.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;draws++;}});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {name,triangles,draws,backend:v.backend};
   },spec.name);
   if(result.backend!==backend)throw Error('Backend fallback');
   if(result.draws!==1||result.triangles>1000)throw Error('Art budget');
   // Viewer exposes renderer through its dev handle; console validation also
   // catches compilation errors on either material path.
   rows.push({...result,requestedBackend:backend,kind});
   if(backend==='webgl')await page.screenshot({path:path.join(out,kind+'.png')});
  }
  if(errors.length)throw Error(errors.join('\n'));await page.close();
 }
 const sheet=await browser.newPage({viewport:{width:1200,height:1950}});
 const cards=await Promise.all(Object.entries(ROAD_PROPS).map(async([kind,spec])=>`<div><img src="data:image/png;base64,${(await fs.readFile(path.join(out,kind+'.png'))).toString('base64')}"><p>${spec.name}</p></div>`));
 await sheet.setContent(`<style>body{margin:0;background:#c5d6df;font:18px system-ui;color:#243444}.grid{display:grid;grid-template-columns:repeat(4,1fr)}img{width:300px;height:280px;object-fit:cover}p{margin:0;text-align:center;height:44px}h1{font-size:24px;margin:15px}</style><div class="grid">${cards.join('')}</div>`);
 await sheet.screenshot({path:path.join(out,'catalog.png'),fullPage:true});
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify({assets:Object.keys(ROAD_PROPS).length,renders:rows.length,maxTriangles:Math.max(...rows.map(r=>r.triangles)),errors:[]}));
}finally{await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(0);
