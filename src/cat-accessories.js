import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Appended ids preserve every existing saved accessory and picker order.
export const EXTRA_ACCESSORIES = {
  propeller: ['Propeller Beanie', 0xe84b51],
  catEye: ['Cat-Eye Goggles', 0xef589b],
  space: ['Space Helmet', 0xe8edf2],
  dragon: ['Dragon Hood', 0x55a679],
  shark: ['Shark Fin', 0x638aab],
  unicorn: ['Unicorn Horn', 0xf6c9eb],
  sombrero: ['Sombrero', 0xe5b761],
  rain: ['Rain Hat', 0xffcf38],
  cone: ['Tiny Traffic Cone', 0xff7733],
  bee: ['Bee Antennae', 0xffcb35],
  mustache: ['Oversized Mustache', 0x51382c],
  duck: ['Rubber-duck Hat', 0xffd840],
  frog: ['Frog Hood', 0x71b95d],
  mushroom: ['Mushroom Cap', 0xd94b52],
  straw: ['Straw Sunhat', 0xdcb978],
  ski: ['Ski Goggles', 0x36a9cb],
  lei: ['Flower Lei', 0xf270ad],
  detective: ['Detective Hat', 0x956f4a],
  shells: ['Shell Necklace', 0xe4cdb0],
};
export const EXTRA_ACCESSORY_COLORS = Object.fromEntries(Object.entries(EXTRA_ACCESSORIES).map(([id,[,color]]) =>
  [id, [...new Set([color,0xe84b51,0x4393dc,0x6ab967,0xffca42,0xbd77d4,0xf4ede1,0x343a49])]]));

const shared = m => { m.userData.shared = true; return m; };
const fabric = shared(new THREE.MeshStandardMaterial({vertexColors:true, roughness:.72}));
const glass = shared(new THREE.MeshBasicMaterial({color:0xb5e7f2,transparent:true,opacity:.105,depthWrite:false,side:THREE.FrontSide}));
const lights = shared(new THREE.MeshBasicMaterial({vertexColors:true}));
const cache = new Map();
const TAU = Math.PI * 2;
function cacheGeometry(key, geometry) {
  if(cache.size>=96)cache.delete(cache.keys().next().value);
  cache.set(key,geometry);
}

// One vertex-colored batch per rigid/moving part, regardless of palette size.
// Cache is bounded like the parent cat cache; all transforms are baked once.
function bake(parts, key, material = fabric) {
  let geometry = cache.get(key);
  if (!geometry) {
    const geos = parts.map(part => {
      part.updateMatrix();
      let g = part.geometry.clone().applyMatrix4(part.matrix);
      if (g.index) { const indexed=g; g=g.toNonIndexed(); indexed.dispose(); }
      const rgb = new Float32Array(g.attributes.position.count * 3), c = part.material.color;
      for(let i=0;i<rgb.length;i+=3){rgb[i]=c.r;rgb[i+1]=c.g;rgb[i+2]=c.b;}
      g.setAttribute('color',new THREE.BufferAttribute(rgb,3));
      return g;
    });
    geometry=mergeGeometries(geos,false);geos.forEach(g=>g.dispose());
    geometry.userData.shared=true;
    cacheGeometry(key,geometry);
  }
  for(const part of parts){part.geometry.dispose();part.material.dispose();}
  return new THREE.Mesh(geometry,material);
}

export function createExtraAccessory(id, color, helpers) {
  if(!EXTRA_ACCESSORIES[id])return null;
  const {latheDeform:lathe, taperedTube, accessoryPlaque:plaque, cutAccessoryEarSlots:earSlots, neckBandGeo:neck}=helpers;
  // The legacy tube helper's side winding faces inward. Correct its sides
  // here so new closed accessories can all use one front-sided material.
  const tube=(points,r0,r1,segs,radial)=>{
    const g=taperedTube(points,r0,r1,segs,radial),ix=g.index;
    for(let i=0;i<ix.count-radial*6;i+=3){const b=ix.getX(i+1);ix.setX(i+1,ix.getX(i+2));ix.setX(i+2,b);}
    g.computeVertexNormals();return g;
  };
  const key=`extra|${id}|${color}`,group=new THREE.Group(),parts=[],moving=[];
  let target=parts,body=false,covered=false,motion=null,dome=null;
  const add=(g,c=color,x=0,y=0,z=0,scale=null)=>{
    const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:c}));
    m.position.set(x,y,z);if(scale)m.scale.set(...scale);target.push(m);return m;
  };
  const ball=(r,c,x,y,z,scale=null)=>add(new THREE.SphereGeometry(r,10,6),c,x,y,z,scale);
  const ring=(r,t,c,x,y,z,rx=Math.PI/2)=>{const m=add(new THREE.TorusGeometry(r,t,5,24),c,x,y,z);m.rotation.x=rx;return m;};
  const line=(points,r,c,segments=12)=>add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),segments,r,5,false),c);
  const cap=(profile,c=color,fn=null,segments=24)=>add(lathe(profile,segments,fn),c);
  const shape=(points,depth,c,x=0,y=0,z=0)=>{
    const s=new THREE.Shape();points.forEach(([a,b],i)=>i?s.lineTo(a,b):s.moveTo(a,b));s.closePath();
    return add(new THREE.ExtrudeGeometry(s,{depth,bevelEnabled:false}),c,x,y,z-depth/2);
  };
  const hood=()=>cap([[.7,-.42],[.86,-.05],[.79,.29],[.67,.51],[.47,.72],[.22,.83],[0,.86]],color,(v,a,r)=>{
    if(v.y<.4){const side=1-Math.max(0,Math.cos(a))**2;v.y+=(.4-v.y)*(1-side);const fit=(.7+(r-.7)*side)/r;v.x*=fit;v.z*=fit;}
  });
  const band=(c=0x343a49,y=.22,r=.79)=>{const m=ring(r,.04,c,0,y,0);m.scale.z=.96;};
  const dark=0x28333f, ivory=0xffedd1;
  const pivot=(kind,x,y,z)=>{target=moving;motion={kind,phase:0,base:new THREE.Vector3(x,y,z)};};
  switch(id){
    case 'propeller': {
      covered=true;
      // Alternating four cloth panels share one batch, no texture or material per panel.
      for(let i=0;i<4;i++)add(new THREE.SphereGeometry(.65,6,7,i*TAU/4,TAU/4,0,Math.PI/2),[color,0x4ba8dd,0xffcf42,0x73c677][i],0,.43,0,[1,.73,1]);
      ring(.63,.045,ivory,0,.45,0);
      add(new THREE.CylinderGeometry(.04,.04,.18,8),dark,0,1.0,0);
      pivot('propeller',0,1.1,0);
      for(let i=0;i<3;i++){
        const a=i*TAU/3,m=ball(.22,[0xf95870,0xffd846,0x62ceec][i],Math.sin(a)*.26,0,Math.cos(a)*.26,[.55,.12,1.7]);m.rotation.y=a;
      }
      ball(.075,ivory,0,.025,0);break;
    }
    case 'catEye': {
      band();
      for(const sx of [-1,1]){
        shape([[-.23,-.13],[.17,-.16],[.29,.2],[-.23,.15]].map(([x,y])=>[x*sx,y]),.065,color,sx*.34,.12,.87);
        const lens=add(plaque(.33,.23,.018,.06),0x63d8ec,sx*.34,.12,.915);
        lens.rotation.z=sx*.06;
        const glint=add(plaque(.07,.15,.009,.02),0xe6ffff,sx*.33-.065,.15,.933);glint.rotation.z=-.45;
      }
      add(plaque(.22,.07,.05,.025),color,0,.15,.89);break;
    }
    case 'ski': {
      // One wraparound shield with a nose cutout, deep foam seal and broad
      // elastic strap. Curvature and highlights are baked, not transparent.
      cap([[.79,.06],[.835,.06],[.835,.24],[.79,.24],[.79,.06]],dark).scale.z=.94;
      for(const sx of [-1,1]){
        const strap=add(new THREE.BoxGeometry(.11,.17,.46),dark,sx*.72,.15,.53);strap.rotation.y=-sx*.23;
        add(plaque(.11,.19,.045,.025),color,sx*.7,.15,.755);
      }
      const outline=[[-.69,.07],[-.66,.26],[-.56,.36],[-.32,.4],[0,.38],[.32,.4],[.56,.36],[.66,.26],[.69,.07],[.59,-.14],[.23,-.16],[.12,-.05],[0,.005],[-.12,-.05],[-.23,-.16],[-.59,-.14]];
      const shield=(sx,sy,depth,c,z)=>{
        const m=shape(outline.map(([x,y])=>[x*sx,(y-.12)*sy+.12]),depth,c,0,0,z);
        const p=m.geometry.attributes.position;
        for(let i=0;i<p.count;i++)p.setZ(i,p.getZ(i)-.5*p.getX(i)**2);
        m.geometry.computeVertexNormals();return m;
      };
      shield(1.035,1.1,.12,0x17232d,.915);
      shield(1,1,.095,color,.978);
      shield(.87,.77,.025,0x263749,1.04);
      line([[-.49,.26,.946],[-.29,.30,1.024],[-.08,.30,1.062]],.014,0xa1bdce,8);
      line([[.35,.01,1.005],[.46,.055,.96]],.012,0x617c93,4);
      break;
    }
    case 'space': {
      covered=true;
      // Cut the ellipsoid on the neckline: lower under the chin, higher at
      // the nape. The rim and dome share the exact boundary, so no gap opens.
      // y = -.13 - .44 * (z - .04), about 24 degrees from horizontal.
      const domePoint=(u,v,out=new THREE.Vector3())=>{
        const a=u*TAU,b=.44*Math.sin(a),r=Math.hypot(1.2,b);
        const edge=Math.atan2(b,1.2)+Math.acos(-.26/r),p=v*edge;
        return out.set(-1.02*Math.cos(a)*Math.sin(p),.13+1.2*Math.cos(p),.04+Math.sin(a)*Math.sin(p));
      };
      class Neckline extends THREE.Curve {
        getPoint(t,out=new THREE.Vector3()){return domePoint(t,1,out);}
      }
      const neckline=new Neckline();
      add(new THREE.TubeGeometry(neckline,24,.06,5,true),color);
      add(new THREE.TubeGeometry(neckline,24,.023,5,true),dark,0,-.045,0);
      for(const sx of [-1,1]){
        ball(.15,dark,sx*.81,.13,.035,[.45,1,1]);
        ball(.145,color,sx*.865,.13,.035,[.4,1,1]);
        line([[sx*.87,.22,.015],[sx*.96,.56,-.07],[sx*.91,.88,-.09]],.025,dark);
        ball(.055,0xffbf41,sx*.91,.88,-.09);
      }
      // Exactly one boom, attached to the right earcup, ends by the mouth.
      line([[.88,.1,.08],[.88,-.1,.48],[.67,-.28,.78],[.24,-.30,.88]],.025,dark,12);
      ball(.08,0x17232d,.19,-.30,.89,[1.35,.65,.65]);
      // A closer-fitting ellipsoid still clears the anchored ears and muzzle.
      // One front surface, with no transmission/refraction or extra light.
      const g=new THREE.SphereGeometry(1,24,14,0,TAU,0,2.12),p=g.attributes.position,sample=new THREE.Vector3();
      for(let i=0;i<p.count;i++){
        domePoint((i%25)/24,Math.floor(i/25)/14,sample);
        p.setXYZ(i,sample.x,sample.y,sample.z);
      }
      g.computeVertexNormals();g.userData.shared=true;
      const domeKey='extra|space|dome';if(!cache.has(domeKey))cacheGeometry(domeKey,g);else g.dispose();
      dome=new THREE.Mesh(cache.get(domeKey),glass);dome.renderOrder=2;group.add(dome);
      line([[-.53,.90,.60],[-.37,1.04,.57],[-.17,1.10,.59]],.016,0xe5fbff);
      line([[.996,-.13,.04],[1.02,.13,.04],[.841,.81,.04],[.50,1.175,.04]],.01,0xc4e3eb);
      pivot('blink',0,0,0);
      for(const [u,c] of [[1/6,0x7effa9],[1/3,0xff6d6d]]){
        const p=domePoint(u,1);ball(.04,c,p.x,p.y+.045,p.z+.018);
      }
      break;
    }
    case 'dragon': {
      covered=true;hood();
      for(const sx of [-1,1]){
        add(tube([new THREE.Vector3(sx*.27,.69,-.32),new THREE.Vector3(sx*.4,1,-.39),new THREE.Vector3(sx*.38,1.14,-.5)],.12,.015,8,7),ivory);

      }
      for(const [y,r] of [[.56,.627],[.7,.489]])for(const a of [-.8,-.4,0,.4,.8]){
        const n=new THREE.Vector3(Math.sin(a)*.65,.7,Math.cos(a)*.65).normalize();
        const m=add(new THREE.SphereGeometry(.075,6,4),y>.6?0x82c493:0x3b8669,Math.sin(a)*r+n.x*.02,y+n.y*.02,Math.cos(a)*r+n.z*.02,[1,.6,.22]);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),n);
      }
      // Bury the broad root in the hood, above the hem. Rotation is about
      // this attached root so flutter cannot open a gap under the hood.
      pivot('tail',0,.12,-.78);
      add(tube([new THREE.Vector3(0,.10,.20),new THREE.Vector3(0,-.3,-.13),new THREE.Vector3(.06,-.76,-.23),new THREE.Vector3(0,-1.22,-.35)],.19,.018,12,7),color);
      for(let i=0;i<4;i++)ball(.075,0xefc067,0,-.2-i*.24,-.20-i*.03,[.4,1,1.3]);break;
    }
    case 'shark': {
      band(dark,.55,.62);
      const fin=shape([[-.38,0],[.4,0],[.24,.18],[-.06,.72],[-.13,.4]],.12,color,0,.64,-.08);
      fin.rotation.y=Math.PI/2;
      shape([[-.26,0],[.3,0],[.15,.09],[-.06,.5],[-.09,.22]],.125,0xa5c3d7,0,.66,-.08).rotation.y=Math.PI/2;
      break;
    }
    case 'unicorn': {
      cap([[0,.69],[.17,.69],[.14,.98],[.085,1.28],[0,1.62]],ivory,null,14).position.z=.35;
      const pts=[];for(let i=0;i<=48;i++){const t=i/48,y=.71+t*.86;
        const profile=[[.69,.17],[.98,.14],[1.28,.085],[1.62,0]];let j=1;while(y>profile[j][0])j++;
        const [ya,ra]=profile[j-1],[yb,rb]=profile[j],r=ra+(rb-ra)*(y-ya)/(yb-ya)+.01;
        pts.push([Math.cos(t*TAU*3)*r,y,Math.sin(t*TAU*3)*r+.35]);}
      line(pts,.018,0xe5b359,48);
      const rainbow=[0xf477ae,0xf7c650,0x78c997,0x75bce8,0xb895e5];
      for(let i=0;i<5;i++)ball(.18,rainbow[i],0,.75-i*.19,-.5-i*.095,[.72,1.05,.6]);
      pivot('sparkle',0,1.16,.4);
      for(const [x,y] of [[-.22,.14],[.18,-.15]])shape([[0,.06],[.016,.016],[.06,0],[.016,-.016],[0,-.06],[-.016,-.016],[-.06,0],[-.016,.016]],.012,ivory,x,y,.03);
      break;
    }
    case 'sombrero': {
      covered=true;cap([[0,.64],[.5,.64],[1.13,.63],[1.16,.7],[.98,.73],[.42,.71],[.31,1.02],[.24,1.28],[0,1.34]],color);
      ring(1.08,.037,0xe25d61,0,.7,0);ring(.35,.034,0x48a9ad,0,.87,0);
      pivot('trim',0,.69,0);
      for(let i=0;i<12;i++){const a=i*TAU/12;ball(.065,[0xe65d6f,ivory,0x4baab2][i%3],Math.sin(a)*1.09,-.085,Math.cos(a)*1.09);}
      break;
    }
    case 'rain': {
      covered=true;cap([[0,.43],[.62,.43],[.86,.39],[.88,.43],[.72,.55],[.6,.9],[.46,1.01],[0,1.03]],color);
      ring(.65,.024,ivory,0,.69,0);break;
    }
    case 'cone': {
      add(new THREE.BoxGeometry(.54,.055,.54),dark,0,.73,0);
      cap([[0,.75],[.22,.75],[.17,.95],[.14,1.05],[.1,1.23],[.055,1.4],[0,1.42]],color,null,16);
      cap([[.147,1.03],[.119,1.16]],ivory,null,16);break;
    }
    case 'bee': {
      band(color,.55,.62);pivot('feelers',0,.59,0);
      for(const sx of [-1,1]){
        line([[sx*.26,0,0],[sx*.38,.32,-.04],[sx*.52,.55,.015]],.027,dark);
        ball(.11,color,sx*.52,.55,.015);ring(.09,.018,dark,sx*.52,.55,.015);
      }break;
    }
    case 'mustache': {
      pivot('mustache',0,-.27,.85);
      for(const sx of [-1,1])add(tube([new THREE.Vector3(sx*.015,0,0),new THREE.Vector3(sx*.22,-.04,.03),new THREE.Vector3(sx*.44,.015,.02),new THREE.Vector3(sx*.56,.19,0)],.105,.015,10,7),color);
      break;
    }
    case 'duck': {
      ball(.2,color,0,.87,.02,[1.2,.76,1.2]);ball(.135,color,0,1.08,.15);
      ball(.1,0xff8c36,0,1.055,.29,[1,.36,.85]);
      for(const sx of [-1,1]){ball(.026,dark,sx*.092,1.105,.232);ball(.11,0xffe997,sx*.18,.88,.015,[.35,.72,1]);}
      ball(.08,color,0,.93,-.18,[.65,.8,1.6]);break;
    }
    case 'frog': {
      covered=true;hood();
      for(const sx of [-1,1]){
        ball(.21,color,sx*.33,.87,.18,[1,1,.8]);ball(.13,ivory,sx*.33,.92,.31,[1,1,.4]);ball(.072,dark,sx*.33,.93,.359,[.8,1.15,.3]);ball(.024,0xffffff,sx*.33-.02,.955,.38);
      }break;
    }
    case 'mushroom': {
      covered=true;
      // White chef-style stem supports the raised cap; ear slots are cut
      // through the stem and cap together during generation.
      cap([[0,.49],[.5,.49],[.54,.57],[.51,.83],[.49,1.06],[0,1.06]],0xfff4de);
      const lift=.29;
      cap([[0,.7],[.42,.7],[.83,.72],[.93,.79],[.91,.85],[.77,1.08],[.5,1.27],[.22,1.32],[0,1.33]],color).position.y=lift;
      cap([[.36,.7],[.75,.705],[.9,.765]],ivory).position.y=lift;
      for(const [a,r] of [[0,.65],[1.2,.65],[2.4,.65],[3.7,.8],[5,.55],[.5,.25]]){
        const y=r>.5?1.27-(r-.5)*(.19/.27):1.32-(r-.22)*(.05/.28);
        const n=new THREE.Vector3(Math.sin(a)*.57,.82,Math.cos(a)*.57).normalize();
        const m=ball(.115,ivory,Math.sin(a)*r+n.x*.02,y+lift+n.y*.02,Math.cos(a)*r+n.z*.02,[1,.9,.2]);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),n);
      }break;
    }
    case 'straw': {
      covered=true;cap([[0,.65],[.43,.65],[.92,.57],[1,.6],[.94,.64],[.5,.7],[.44,.97],[.34,1.08],[0,1.1]],color,(v,a,r)=>{if(r>.55)v.y+=.04*Math.sin(a*3);});
      cap([[.499,.7],[.467,.86]],0x5b99b9);
      for(const r of [.6,.74,.88])ring(r,.009,0xad824a,0,.637,0);break;
    }
    case 'lei': {
      body=true;add(neck(.11),0x73a171);
      for(let i=0;i<9;i++){
        const a=i*TAU/9,x=Math.sin(a)*.925,z=Math.cos(a)*.925,y=1.58-.23*Math.cos(a);
        const center=new THREE.Vector3(x,y,z),normal=new THREE.Vector3(x,.22,z).normalize(),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),normal);
        for(let j=0;j<5;j++){
          const p=new THREE.Vector3(Math.cos(j*TAU/5)*.087,Math.sin(j*TAU/5)*.087,0).applyQuaternion(q).add(center);
          const m=add(new THREE.SphereGeometry(.07,6,4),i%2?ivory:color,p.x,p.y,p.z,[1,1,.35]);m.quaternion.copy(q);
        }
        const p=center.clone().addScaledVector(normal,.026);add(new THREE.IcosahedronGeometry(.049,0),0xffd64d,p.x,p.y,p.z);
      }break;
    }
    case 'detective': {
      covered=true;
      add(new THREE.SphereGeometry(.64,20,10,0,TAU,0,Math.PI/2),color,0,.49,0,[1,.74,1.05]);
      for(const sz of [-1,1])ball(.32,color,0,.5,sz*.55,[1.48,.1,1.05]);
      for(const sx of [-1,1])ball(.2,0x6a503b,sx*.72,.47,0,[.4,.9,1.12]);
      ring(.56,.016,0x5b4935,0,.66,0);ball(.05,ivory,0,1,0);
      // Broad stitched panel lines, baked geometry rather than a fabric texture.
      for(const sx of [-1,1])line([[sx*.4,.78,.27],[sx*.25,.92,.13],[0,.975,0]],.009,0xc5a17a);break;
    }
    case 'shells': {
      body=true;add(neck(.09),0x8d765b);
      for(let i=-2;i<=2;i++){
        const a=i*.36,x=Math.sin(a)*.935,z=Math.cos(a)*.935,y=1.34+.08*Math.abs(i);
        const outline=[[-.025,-.09]];
        for(let j=0;j<=12;j++){const angle=Math.PI-j*Math.PI/12,r=.13*(1+.065*(j%2?1:-1));outline.push([Math.cos(angle)*r,Math.sin(angle)*r-.04]);}
        outline.push([.025,-.09]);
        const shell=shape(outline,.027,i%2?ivory:color,x,y,z);shell.rotation.y=a;
        for(let j=-1;j<=1;j++){
          const dx=j*.045;line([[x+dx*.3,y+.075,z+.027],[x+dx,y-.035,z+.029]],.006,0xb89c7c);
        }
      }break;
    }
  }
  if(covered)for(const p of parts)earSlots(p);
  if(parts.length)group.add(bake(parts,key+'|fixed'));
  if(moving.length){
    const child=bake(moving,key+'|moving',id==='space'?lights:fabric);
    const pivotGroup=new THREE.Group();pivotGroup.position.copy(motion.base);pivotGroup.add(child);group.add(pivotGroup);motion.object=pivotGroup;
  }
  group.userData.keepResources=true;
  group.userData.accessoryId=id;
  return {group,body,covered,motion};
}

// Bounded per-accessory transforms reuse the parent's filtered turn response.
// No particle emitters, constraints, scene searches, or allocations per frame.
export function updateExtraAccessory(motion, dt, turn, speed=0) {
  if(!motion)return;
  const t=motion.phase=(motion.phase+dt) % (Math.PI*200),o=motion.object;
  switch(motion.kind){
    case 'propeller': o.rotation.y=(o.rotation.y+dt*(2+Math.min(55,Math.abs(speed))*.4))%TAU;break;
    case 'blink': o.visible=Math.sin(t*4)>-.35;break;
    case 'tail': o.rotation.z=Math.sin(t*7)*(.03+Math.min(40,Math.abs(speed))*.002)-turn*.12;o.rotation.x=Math.sin(t*5)*.045;break;
    case 'trim': o.rotation.z=turn*.08;o.position.y=motion.base.y+Math.abs(turn)*.09*Math.sin(t*9);break;
    case 'feelers': o.rotation.z=-turn*.2+Math.sin(t*4)*.025;break;
    case 'mustache': o.rotation.z=turn*.08;o.position.y=motion.base.y+Math.sin(t*10)*Math.min(.035,Math.abs(speed)*.001);break;
    case 'sparkle': o.scale.setScalar(.8+Math.sin(t*5)*.2);break;
  }
}
