import * as THREE from 'three';

// Generated once per palette; a white tile lets undecorated pieces share the
// same batch. Patterns are UV paint on the original surface, never decals.
const tiles={plain:0,stars:1,spots:2,scales:3,seams:4,straw:5,stripe:6,hem:7};
const textures=new Map();
export function accessoryPaint(color){
  if(textures.has(color))return textures.get(color);
  const c=document.createElement('canvas');c.width=512;c.height=256;
  const ctx=c.getContext('2d'),base=new THREE.Color(color),hex='#'+base.getHexString();
  ctx.fillStyle='#fff';ctx.fillRect(0,0,512,256);
  for(const [name,tile] of Object.entries(tiles)){
    if(name==='plain')continue;
    ctx.save();ctx.translate((tile%4)*128,Math.floor(tile/4)*128);
    ctx.beginPath();ctx.rect(0,0,128,128);ctx.clip();ctx.fillStyle=hex;ctx.fillRect(0,0,128,128);
    if(name==='stars'){
      ctx.fillStyle='#f5cf62';
      for(const [x,y,r] of [[24,35,11],[85,68,13],[40,110,8],[111,17,7]]){
        ctx.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,d=i%2?r*.42:r;ctx.lineTo(x+Math.cos(a)*d,y+Math.sin(a)*d);}ctx.closePath();ctx.fill();
      }
    }else if(name==='spots'){
      ctx.fillStyle='#fff0d4';for(const [x,y,r] of [[33,36,10],[92,29,11],[61,98,9],[103,79,8],[23,76,10],[70,56,9]]){ctx.beginPath();ctx.ellipse(x,y,r,r*.78,.25,0,Math.PI*2);ctx.fill();}
    }else if(name==='scales'){
      ctx.strokeStyle='#'+base.clone().multiplyScalar(.7).getHexString();ctx.lineWidth=2;
      for(let row=-1;row<5;row++)for(let col=-1;col<5;col++){ctx.beginPath();ctx.arc(col*32+(row%2)*16,row*29,15,0,Math.PI);ctx.stroke();}
    }else if(name==='seams'){
      ctx.strokeStyle='#'+base.clone().lerp(new THREE.Color(0xffedd1),.4).getHexString();ctx.lineWidth=2;ctx.setLineDash([5,4]);
      for(const x of [4,64,124]){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,128);ctx.stroke();}
    }else if(name==='straw'){
      ctx.strokeStyle='#'+base.clone().multiplyScalar(.8).getHexString();ctx.lineWidth=1;
      for(let y=4;y<128;y+=12){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(128,y);ctx.stroke();}
    }else if(name==='hem'){
      ctx.fillStyle='#f9f1de';ctx.fillRect(0,95,128,33);
    }else if(name==='stripe'){
      ctx.fillStyle='#f9f1de';ctx.fillRect(62,0,4,128);ctx.fillRect(0,0,5,128);ctx.fillRect(123,0,5,128);
    }
    ctx.restore();
  }
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=2;tex.userData.shared=true;tex.userData.accessoryPaint=true;
  if(textures.size>=48)textures.delete(textures.keys().next().value);
  textures.set(color,tex);return tex;
}
export function paintUV(geometry,pattern='plain'){
  const tile=tiles[pattern],uv=geometry.attributes.uv;
  for(let i=0;i<uv.count;i++){
    // Inset into each tile avoids neighboring colors in mip/filter footprints.
    const u=pattern==='plain'?.5:THREE.MathUtils.clamp(uv.getX(i),0,1);
    const v=pattern==='plain'?.5:THREE.MathUtils.clamp(uv.getY(i),0,1);
    uv.setXY(i,((tile%4)*128+3+u*122)/512,1-(Math.floor(tile/4)*128+3+(1-v)*122)/256);
  }
  return geometry;
}
