// Fixed-seed landscape views and resource census. ART_ROOT compares a checkout.
// Software WebGL2 resource counts are reproducible; they are NOT hardware FPS.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-landscape-check';
await fs.mkdir(out, { recursive: true });
const mime = { '.html':'text/html', '.mjs':'text/javascript', '.wasm':'application/wasm', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = http.createServer(async (req,res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  try {
    const url = req.url.split('?')[0];
    const file = path.join(root, url === '/' ? 'index.html' : decodeURIComponent(url));
    const data = await fs.readFile(file);
    res.writeHead(200, {'content-type': mime[path.extname(file)] || 'application/octet-stream'}).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1100,height:700}});
  const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
  await page.addInitScript(()=>{
    let s=12345; Math.random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
    localStorage.setItem('zoomies-quality-v2','medium');
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1`,{timeout:150000,waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__zoomies?.track,null,{timeout:150000});
  await page.evaluate(()=>{
    const z=window.__zoomies, c=z.camera;
    window.__setLandscapeCamera=(eye,target)=>{
      Object.getPrototypeOf(c.position).set.call(c.position,...eye);
      Object.getPrototypeOf(c).lookAt.call(c,...target); c.updateMatrixWorld(true);
    };
    c.position.copy=function(){return this;}; c.position.set=function(){return this;}; c.lookAt=()=>{};
    document.querySelectorAll('body *').forEach(e=>{if(e.tagName!=='CANVAS')e.style.visibility='hidden';});
    document.querySelector('#game canvas').style.visibility='visible';
  });
  console.error('Landscape ready; capturing four fixed views.');
  const views=[];
  for(const [name,t] of [['track-a',.06],['track-b',.38],['track-c',.72],['mountain',null]]){
    await page.evaluate(({t})=>{
      const z=window.__zoomies;
      if(t!==null){const a=z.track.getPointAt(t),b=z.track.getPointAt(t+.025),dir=b.clone().sub(a).normalize();window.__setLandscapeCamera([a.x-dir.x*22,a.y+12,a.z-dir.z*22],[b.x,b.y,b.z]);}
      else{
        let peaks;z.scene.traverse(o=>{if(o.userData.mountains)peaks=o.userData.mountains;});
        const p=[...peaks].sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
        const a=Math.atan2(p.z,p.x);window.__setLandscapeCamera([p.x-Math.cos(a)*420,p.y+p.h*.5,p.z-Math.sin(a)*420],[p.x,p.y+p.h*.45,p.z]);
      }
    },{t});
    await page.waitForTimeout(3500);
    await page.screenshot({path:path.join(out,name+'.png'),timeout:120000});
    console.error(`Captured ${name}`);
    views.push(await page.evaluate(name=>({name,render:{...window.__zoomies.renderer.info.render},memory:{...window.__zoomies.renderer.info.memory}}),name));
  }
  const scene=await page.evaluate(()=>{
    let triangles=0,mountainTriangles=0,batches=0,invalid=0,missingColors=0;
    window.__zoomies.scene.traverse(o=>{
      if(!o.isMesh||!o.geometry)return;
      const g=o.geometry, n=(g.index?.count||g.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);
      triangles+=n; if(o.userData.mountains)mountainTriangles+=n;
      batches+=Array.isArray(o.material)?g.groups.length:1;
      for(const a of Object.values(g.attributes))for(const v of a.array)if(!Number.isFinite(v))invalid++;
      if((Array.isArray(o.material)?o.material:[o.material]).some(m=>m.vertexColors)&&!g.attributes.color)missingColors++;
    });
    return {triangles,mountainTriangles,batches,invalid,missingColors};
  });
  if(scene.invalid||scene.missingColors)errors.push('Invalid landscape geometry or missing colors');
  const result={scene,views,errors};
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(errors.length)process.exitCode=1;
} finally {await browser?.close();server.close();}
