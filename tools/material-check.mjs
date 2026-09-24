// Verify actual transparent decal occlusion through both cel material paths.
// ART_ROOT and BASELINE=1 compare an older checkout. Resource counts are not FPS.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-material-check';
await fs.mkdir(out,{recursive:true});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  if(req.url.startsWith('/lighting.html')) {
    const html=await fs.readFile(path.join(root,'viewer.html'),'utf8');
    const imports=html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
    res.writeHead(200,{'content-type':'text/html'}).end('<html><body style="margin:0"><div id="game"></div><script type="importmap">'+imports+'</script></body></html>');return;
  }
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({viewport:{width:640,height:320}});
  await page.addInitScript(() => { let seed = 12345; Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }; });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if(m.type()==='error')errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/lighting.html?webgl=1`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('three'); const {toToon}=await import('/src/toon.js');
    const renderer=new THREE.WebGPURenderer({forceWebGL:true,antialias:false});
    renderer.setSize(640,320);renderer.setPixelRatio(1);renderer.setClearColor(0x263b50);
    document.querySelector('#game').appendChild(renderer.domElement);await renderer.init();
    const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffffff,0xffffff,2));
    const camera=new THREE.OrthographicCamera(-4,4,2,-2,.1,10);camera.position.z=5;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=32;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(16,0,16,32);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const rows=[];
    for(const [x,node] of [[-2,false],[2,true]]){
      const source=new THREE.MeshStandardMaterial({map:texture,transparent:true,depthWrite:false});
      if(node)source.userData.rim=true;
      const material=toToon(source);
      const decal=new THREE.Mesh(new THREE.PlaneGeometry(3,3),material);decal.position.x=x;decal.renderOrder=1;scene.add(decal);
      // Same ordering as crossing paint over a later-drawn wet/skid decal. The
      // transparent half must leave depth untouched so the red patch survives.
      const behind=new THREE.Mesh(new THREE.PlaneGeometry(1.2,2.5),new THREE.MeshBasicMaterial({color:0xee4422,transparent:true,depthWrite:false}));
      behind.position.set(x-.75,0,-.1);behind.renderOrder=2;scene.add(behind);
      rows.push({path:node?'node':'stock',depthWrite:material.depthWrite,cached:toToon(source)===material});
    }
    await renderer.renderAsync(scene,camera);
    return {rows,render:{...renderer.info.render},memory:{...renderer.info.memory}};
  });
  const shot=await page.screenshot({path:path.join(out,'decals.png')});
  result.pixels=await page.evaluate(async data=>{
    const img=new Image();img.src=data;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
    return [100,420].map(x=>[...ctx.getImageData(x,160,1,1).data]);
  },'data:image/png;base64,'+shot.toString('base64'));
  if(!process.env.BASELINE){
    for(const row of result.rows)if(row.depthWrite||!row.cached)errors.push('Cel conversion loses decal depth/cache state');
    for(const pixel of result.pixels)if(pixel[0]<180||pixel[0]<pixel[2]*2)errors.push('Transparent decal gap occludes underlying effect');
  }
  await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify({result,errors},null,2));
  console.log(JSON.stringify({result,errors},null,2));if(errors.length)process.exitCode=1;
} finally {await browser?.close();server.close();}
