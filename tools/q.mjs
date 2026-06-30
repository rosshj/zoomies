import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT="/home/user/zoomies"; const PORT=8084;
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".json":"application/json"};
const srv=http.createServer((q,r)=>{let u=q.url.split("?")[0]; if(u==="/")u="/index.html"; fs.readFile(path.join(ROOT,u),(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200,{"content-type":MIME[path.extname(u)]||"text/plain"});r.end(d);});});
await new Promise(r=>srv.listen(PORT,r));
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--use-gl=angle","--use-angle=swiftshader","--ignore-gpu-blocklist","--enable-unsafe-swiftshader","--no-sandbox"]});
async function run(qual){
  const ctx=await b.newContext({viewport:{width:1280,height:800}});
  await ctx.addInitScript((qual)=>{ try{ localStorage.setItem("zoomies-fps","1"); if(qual==="low") localStorage.setItem("zoomies-quality","low"); }catch{} }, qual);
  const p=await ctx.newPage(); const errs=[];
  p.on("console",m=>{ if(m.type()==="error") errs.push(m.text()); });
  p.on("pageerror",e=>errs.push("PE:"+e.message));
  await p.goto(`http://127.0.0.1:${PORT}/index.html?webgl=1&nosw=1`,{waitUntil:"load"});
  await p.waitForSelector("#start-btn"); await p.click("body",{position:{x:5,y:5}}).catch(()=>{}); await p.click("#start-btn",{force:true});
  let txt=""; for(let i=0;i<75;i++){ txt=await p.textContent("#fps-counter").catch(()=>""); if(/\d+\s*FPS/.test(txt||"")) break; await p.waitForTimeout(1000); }
  await p.waitForTimeout(4000); txt=await p.textContent("#fps-counter");
  await ctx.close();
  return { qual, fps: txt.trim(), errors: errs.length };
}
console.log(JSON.stringify(await run("high")));
console.log(JSON.stringify(await run("low")));
await b.close(); srv.close();
