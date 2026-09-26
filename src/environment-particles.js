// Shared procedural art and budgets for loose surface material. No image assets,
// rigid bodies or per-particle lights; both scenery and kart wakes use this atlas.
import * as THREE from 'three';
import { uniform } from 'three/tsl';
export const debrisLight = uniform(new THREE.Color(1, 1, 1));
const profile = (tile, colors, density, size, lift, fall = 0) => ({ tile, colors, density, size, lift, fall });
export const ENVIRONMENT_PROFILES = {
  blossom: profile(0, [0xffbdd5,0xffdce7,0xf5a4c5], .72, .31, .85, .85),
  lavender: profile(0, [0xc4a4e0,0xd8bce9,0xb9a0d1], .35, .21, .7, .35),
  forest: profile(1, [0x6d803d,0x85714d,0x49743a], .56, .38, .55, .15),
  autumn: profile(1, [0xcc7937,0xb74d29,0xd9a94b], .8, .44, .65, .65),
  jungle: profile(1, [0x42744a,0x68834d,0x898352], .5, .48, .5, .2),
  wetlands: profile(1, [0x708853,0x9b935d,0x527248], .4, .35, .4, .12),
  meadow: profile(2, [0x8ca563,0xc7bb80,0x9db96f], .24, .24, .3),
  savanna: profile(2, [0xc4a669,0xb9934f,0xd8c389], .35, .29, .4, .08),
  beach: profile(3, [0xdcc99e,0xeaddbd,0xbeb090], .13, .09, .13),
  desert: profile(3, [0xc2a171,0xd8be8c,0xb79765], .16, .09, .13),
  mesa: profile(3, [0xb58462,0xc89c72,0xdaaf85], .13, .10, .15),
  alpine: profile(4, [0xdce6ee,0xc5d8e4,0xf2f4ef], .26, .18, .25),
  tundra: profile(4, [0xd5e3ed,0xbdd2df,0xecf0ed], .35, .20, .28),
  city: profile(5, [0xc9c3ad,0xe1dccb,0xa3aaa8], .09, .26, .35),
  volcanic: profile(6, [0x756d69,0x565253,0x9a8780], .19, .12, .2, .12),
};
export const environmentProfile = name => ENVIRONMENT_PROFILES[name] || ENVIRONMENT_PROFILES.meadow;
export const ENVIRONMENT_LIMITS = { ground: 1900, falling: 320, wake: 80 };

// A deterministic time accumulator, independent of render frequency. Per-kart
// callers own a small record; a long background pause cannot spawn a backlog.
export function emissionCount(state, key, rate, dt) {
  const value = (state[key] || 0) + Math.max(0, rate) * Math.min(.1, Math.max(0, dt));
  const n = Math.floor(value + 1e-9); state[key] = Math.max(0, value - n); return n;
}

// Mirror the visible road's clumped loose-cover/wear formula at the kart's
// existing track projection. No nearest-road search or collision work per puff.
const smooth = x => { x=Math.max(0,Math.min(1,x)); return x*x*(3-2*x); };
export function looseSurface(biome, x, z, lateral, halfWidth, row, sliding = false) {
  const f = Math.max(0, Math.min(1, (lateral + halfWidth) / (2 * halfWidth)));
  const edge = smooth((Math.abs(lateral) - halfWidth * .62) / (halfWidth * .32));
  const sandy = ['beach','desert','mesa'].includes(biome), snowy = ['alpine','tundra'].includes(biome);
  if (!sandy && !snowy) return Math.min(1, edge * .75 + (sliding ? .06 : .008));
  const wander=.03*Math.sin(row*.06)+.02*Math.sin(row*.017+2.1);
  const lane=Math.min(Math.abs(f-(.32+wander)),Math.abs(f-(.68+wander)));
  const wear=(1-smooth(lane/.17))*(.82+.18*Math.sin(row*.11+f*3));
  const clump=.5+.5*Math.sin(x*.16+Math.sin(z*.13)*2.2)*Math.cos(z*.11+Math.sin(x*.09)*1.8);
  return Math.min(1,(.18+.42*clump)*(1-.92*smooth(wear*1.25))+.3*smooth((.12-Math.min(f,1-f))/.12));
}

let atlas;
export function environmentAtlas() {
  if (atlas) return atlas;
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;
  const c=canvas.getContext('2d');
  for(let tile=0;tile<8;tile++){
    c.save();c.translate((tile%4)*64,Math.floor(tile/4)*64);
    c.fillStyle='#ffffff';c.strokeStyle='#b6b6b6';c.lineWidth=1.4;c.beginPath();
    if(tile===0){ // Rounded, notched petal with an asymmetric cupped shoulder.
      c.moveTo(31,55);c.bezierCurveTo(8,40,8,12,24,10);c.quadraticCurveTo(30,9,33,16);c.quadraticCurveTo(38,7,44,12);c.bezierCurveTo(59,23,47,45,31,55);
    }else if(tile===1){
      c.moveTo(31,5);c.quadraticCurveTo(56,24,43,41);c.lineTo(35,46);c.lineTo(30,59);c.lineTo(27,46);c.quadraticCurveTo(5,32,31,5);
    }else if(tile===2){
      c.moveTo(19,56);c.quadraticCurveTo(25,21,42,8);c.lineTo(32,38);c.lineTo(38,50);c.lineTo(28,43);c.closePath();
    }else if(tile===3||tile===6){
      c.moveTo(24,18);c.lineTo(39,15);c.lineTo(48,32);c.lineTo(34,47);c.lineTo(18,38);c.closePath();
    }else if(tile===4){
      c.moveTo(18,17);c.quadraticCurveTo(26,9,37,17);c.quadraticCurveTo(55,14,51,33);c.quadraticCurveTo(53,48,34,48);c.quadraticCurveTo(17,57,13,39);c.quadraticCurveTo(5,26,18,17);
    }else if(tile===5){
      c.moveTo(13,14);c.lineTo(47,10);c.lineTo(53,44);c.lineTo(41,52);c.lineTo(17,48);c.closePath();
    }else{ // Soft, slightly irregular dust. Texture noise is baked once.
      const grad=c.createRadialGradient(30,30,3,32,32,27);grad.addColorStop(0,'rgba(255,255,255,.65)');grad.addColorStop(.55,'rgba(255,255,255,.32)');grad.addColorStop(1,'rgba(255,255,255,0)');
      c.fillStyle=grad;c.ellipse(32,32,27,24,.2,0,Math.PI*2);
    }
    c.fill();
    if(tile<3||tile===5){c.beginPath();c.moveTo(30,49);c.quadraticCurveTo(34,33,31,20);c.stroke();}
    c.restore();
  }
  atlas=new THREE.CanvasTexture(canvas);atlas.colorSpace=THREE.SRGBColorSpace;
  atlas.userData.shared=true;return atlas;
}
