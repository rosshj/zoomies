// Hardware WebGL2 GPU timing of a frozen world scene (no post-processing or
// gameplay simulation). ART_ROOT selects the checkout; OUT saves raw batches.
// Nine batches of 20 renders per view; batch averages are NOT gameplay frame times.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-scenery-perf';
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
  browser=await chromium.launch({executablePath:process.env.PW_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1100,height:700}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    let s=12345;Math.random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
    localStorage.setItem('zoomies-quality-v2','medium');
    const raf=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=cb=>raf(t=>{if(!window.__pausePerf)cb(t);});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?webgl=1&nosw=1&nowd=1${process.env.TOD ? "&tod=" + encodeURIComponent(process.env.TOD) : ""}`,{timeout:150000,waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__zoomies?.track,null,{timeout:150000});
  await page.waitForTimeout(5000);
  await page.evaluate(()=>{window.__pausePerf=true;});
  await page.waitForTimeout(100);
  const result=await page.evaluate(async()=>{
    const {renderer,scene,camera,track}=window.__zoomies;
    // The pinned dependency exposes the TSL clock here; the game/renderer
    // RAF callbacks are paused, so every measured view uses the same wind phase.
    renderer._nodes.nodeFrame.time=0;renderer._nodes.nodeFrame.deltaTime=0;
    const wind=await import('/src/wind.js');
    const {uWindDir,uWindStr,uWindAir}=wind;wind.setWindClock?.(0);
    uWindDir.value.set(.82,.57).normalize();uWindStr.value=1;uWindAir.value=1;
    const gl=renderer.backend.getContext();
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const dbg=gl.getExtension('WEBGL_debug_renderer_info');
    const device=dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'unknown';
    if(!ext||/swiftshader|llvmpipe/i.test(device))throw Error('Hardware timer unavailable: '+device);
    // Fixed opaque/scenery workload. Hide weather/ambient sprite fields, whose
    // live placement otherwise changes while each build starts. Freeze wind/time.
    scene.traverse(o=>{if(o.material?.isSpriteNodeMaterial)o.visible=false;});
    const views=[];
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    for(const t of [.06,.38,.72]){
      const a=track.getPointAt(t),b=track.getPointAt(t+.025),dir=b.clone().sub(a).normalize();
      camera.position.set(a.x-dir.x*22,a.y+12,a.z-dir.z*22);camera.lookAt(b);camera.updateMatrixWorld(true);
      for(let i=0;i<20;i++)renderer.render(scene,camera);
      gl.finish();
      const batches=[];
      for(let sample=0;sample<9;sample++){
        const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
        for(let i=0;i<20;i++)renderer.render(scene,camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);gl.flush();
        const start=performance.now();
        while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){
          if(performance.now()-start>15000)throw Error('GPU query timed out');await sleep(5);
        }
        if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint GPU timer sample');
        batches.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6/20);gl.deleteQuery(q);
      }
      renderer.info.reset();renderer.render(scene,camera);
      const sorted=[...batches].sort((a,b)=>a-b);
      views.push({t,batchesMsPerRender:batches,medianMsPerRender:sorted[4],render:{...renderer.info.render}});
    }
    // Isolate the CPU scenery controller too. This deliberately excludes race
    // physics, rendering and the separately updated kart-wake/string-light code.
    const world=window.__zoomies.world,cpu=[];
    const positions=Array.from({length:600},(_,i)=>track.getPointAt(.06+i*.5/track.length));
    let step=0;
    for(const mode of ['nearKart','wholeWorld']) {
      const update=()=>{world.update(step/60,1/60,mode==='nearKart'?positions[step%600]:null);step++;};
      for(let i=0;i<120;i++)update();
      const batches=[];
      for(let sample=0;sample<9;sample++) {
        const start=performance.now();for(let i=0;i<600;i++)update();
        batches.push((performance.now()-start)/600);
      }
      cpu.push({mode,batchesMsPerUpdate:batches,medianMsPerUpdate:[...batches].sort((a,b)=>a-b)[4]});
    }
    return {device,viewport:[1100,700],drawingBuffer:[renderer.domElement.width,renderer.domElement.height],views,cpu};
  });
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify({result,errors},null,2));
  console.log(JSON.stringify({result,errors},null,2));if(errors.length)process.exitCode=1;
} finally {await Promise.race([browser?.close(),new Promise(r=>setTimeout(r,5000))]);server.closeAllConnections();server.close();}
process.exit(process.exitCode||0);
