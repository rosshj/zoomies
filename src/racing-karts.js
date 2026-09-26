import * as THREE from 'three';

// One cached opaque paint material, including number/team marks. No floating
// decals or extra passes. A bounded palette cache is shared by all chassis.
const paints=new Map();
export function racingPaint(color,livery,number){
  const key=`${color}|${livery}|${number}`;
  if(paints.has(key))return paints.get(key);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const c=canvas.getContext('2d'),base=new THREE.Color(color);
  c.fillStyle='#'+base.getHexString();c.fillRect(0,0,256,256);
  c.fillStyle='#'+base.clone().multiplyScalar(.42).getHexString();c.fillRect(0,186,256,70);
  c.fillStyle='#f5f1e5';
  if(livery===1){c.fillRect(60,0,22,256);c.fillRect(174,0,22,256);}
  else if(livery===2){for(const y of [-75,10,95]){c.beginPath();c.moveTo(0,y);c.lineTo(128,y+55);c.lineTo(256,y);c.lineTo(256,y+24);c.lineTo(128,y+79);c.lineTo(0,y+24);c.fill();}}
  else{c.fillRect(34,0,44,256);c.fillStyle='#252b34';c.fillRect(82,0,9,256);}
  c.fillStyle='#f5f1e5';c.beginPath();c.roundRect(103,83,116,91,16);c.fill();
  c.fillStyle='#202631';c.textAlign='center';c.textBaseline='middle';c.font='bold 65px sans-serif';c.fillText(String(number),161,130,105);
  c.font='bold 17px sans-serif';c.fillStyle='#f5f1e5';c.fillText(['APEX','VECTOR','SUMMIT'][livery],160,219);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=2;map.userData.shared=true;
  const mat=new THREE.MeshStandardMaterial({map,roughness:.4});mat.userData.shared=true;mat.userData.paint=true;
  if(paints.size>=64)paints.delete(paints.keys().next().value);
  paints.set(key,mat);return mat;
}

// All twelve builds use the same seat, steering, wheel and exhaust anchors.
// Parts are merged by the caller into its usual rigid shell. No new frame loop.
export function buildRacingShell(st,{add,rbox,paint,accent,stripe,dark,chrome,livery}){
  const mesh=(g,m,x=0,y=0,z=0)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);add(o);return o;};
  const box=(w,h,d,m,x,y,z,r=.06)=>mesh(rbox(w,h,d,r,1),m,x,y,z);
  const bar=(a,b,r=.065,m=dark)=>{
    const v=new THREE.Vector3(...a),w=new THREE.Vector3(...b),delta=w.clone().sub(v);
    const o=mesh(new THREE.CylinderGeometry(r,r,delta.length(),8),m);o.position.copy(v.add(w).multiplyScalar(.5));o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return o;
  };
  // Chamfered closed lofts give large panels shaped silhouettes with few faces.
  const panel=(rows,m,x=0,side=false)=>{
    const pos=[],uv=[],ix=[],min=rows[0][0],len=rows.at(-1)[0]-min,maxW=Math.max(...rows.map(r=>r[1]));
    rows.forEach(([z,w,b,t],j)=>{
      const c=Math.min(.075,(t-b)*.24,w*.2);
      for(const [px,py] of [[-w,b+c],[-w+c,b],[w-c,b],[w,b+c],[w,t-c],[w-c,t],[-w+c,t],[-w,t-c]]){
        pos.push(px,py,z);uv.push(side?(x>0?1-(z-min)/len:(z-min)/len):px/(maxW*2)+.5,side?(py-b)/(t-b):1-(z-min)/len);
      }
      if(j)for(let i=0;i<8;i++){const a=(j-1)*8+i,b=(j-1)*8+(i+1)%8,d=j*8+i,e=j*8+(i+1)%8;ix.push(a,b,d,b,e,d);}
    });
    for(let i=1;i<7;i++){ix.push(0,i+1,i);const b=(rows.length-1)*8;ix.push(b,b+i,b+i+1);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(ix);g.computeVertexNormals();return mesh(g,m,x);
  };
  box(2.02,.16,4.5,dark,0,.36,-.1);
  for(const s of [-1,1]){
    bar([s*.94,.40,-2.26],[s*.94,.40,1.85],.07,st.rail?paint:dark);
    bar([s*.94,.40,1.85],[s*.62,.40,2.08],.07,st.rail?paint:dark);
    bar([0,.52,1.55],[s*1.32,.52,1.55],.075,chrome);
    bar([0,.63,-1.6],[s*1.42,.63,-1.6],.085,chrome);
  }
  bar([-.94,.42,-2.3],[.94,.42,-2.3],.1);
  if(st.rail){
    bar([-.98,.44,1.85],[-.88,.48,2.15],.09,chrome);bar([-.88,.48,2.15],[.88,.48,2.15],.09,chrome);bar([.88,.48,2.15],[.98,.44,1.85],.09,chrome);
  }else box(2.45,st.rubber?.36:.24,.38,st.rubber?dark:accent,0,.43,2.02,.1);
  // Narrow driving fairing slopes down from the steering column.
  if(st.vintage){
    const g=new THREE.SphereGeometry(1,16,8),p=g.attributes.position,uv=g.attributes.uv;
    for(let i=0;i<p.count;i++)uv.setXY(i,p.getX(i)*.5+.5,.5-p.getZ(i)*.5);
    const o=mesh(g,livery,0,.65,1.25);o.scale.set(.44,.32,.88);
    box(.48,.16,.65,paint,0,.65,.38);
    for(const s of [-1,1])for(let i=0;i<3;i++)box(.02,.07,.23,dark,s*.425,.69,1.12+i*.19,.01);
  }else{
    panel([[.36,.39,.40,.94],[.88,.48,.40,.78],[1.65,st.nose,.34,st.kind==='flat'?.59:.62],[2.12,st.nose*.82,.32,.49]],livery);
  }
  const podLen=st.tire>1?1.1:1.4;
  for(const s of [-1,1]){
    const w=st.pod*.5,asym=st.oval&&s<0?.12:0;
    panel([[-podLen/2-.12,w*.86,.38,.65+asym],[.15,w,.32,.75+asym],[podLen/2-.12,w*.78,.34,.60]],livery,s*(1.02+w*.22),true);
    if(st.guard){
      box(.12,st.rubber?.3:.20,2.02,dark,s*1.36,.44,-.08);
      bar([s*1.36,.44,.90],[s*1.12,.44,1.12],.07);
    }
  }
  box(1.28,1,.28,st.vintage?accent:dark,0,1.38,-1.24,.1);
  for(const s of [-1,1])box(.17,.44,1.14,dark,s*.72,1.1,-.55);
  bar([0,.5,.55],[0,1.4,.55],.055);
  // Engine, cooling fins, exhaust header and a supported intake.
  box(st.radiator?.88:.68,.46,.67,dark,-.48,.73,-1.87);
  for(let i=0;i<3;i++)box(.69,.045,.54,chrome,-.48,.62+i*.13,-1.87,.015);
  box(.46,.22,.42,accent,-.48,1.03,-1.87);
  bar([-.47,.8,-2.05],[-.42,.58,-2.35],.105,chrome);
  box(.49,.34,.65,st.vintage?chrome:dark,.5,.62,-1.87);
  if(st.radiator){
    box(.16,.70,.58,chrome,.85,.94,-.77);
    for(let i=0;i<4;i++)box(.02,.06,.49,dark,.94,.71+i*.14,-.77,.01);
    bar([.83,.7,-1.0],[.55,.65,-1.6],.035);
  }
  if(st.kind==='flat'){
    const plate=box(.72,.43,.075,livery,0,1.04,.83,.035);plate.rotation.x=-.13;
  }
  if(st.oval){
    panel([[-2.27,1.18,.42,.81],[-1.98,1.18,.4,.75]],paint);
    box(2.35,.15,.12,accent,0,.85,-2.26,.025);
  }
  if(st.stream){
    for(const s of [-1,1]){
      // High rear-wheel shoulders, open on the outside and below the driver.
      panel([[-2.26,.31,.91,1.12],[-1.75,.34,1.17,1.36],[-1.38,.33,1.17,1.36],[-.92,.20,.82,.95]],paint,s*1.4);
    }
    panel([[-2.35,.70,.50,.75],[-1.98,.85,.50,.93]],accent);
  }
  if(st.fenders){
    for(const s of [-1,1])for(const z of [1.55,-1.6]){
      box(.66,.13,.95,paint,s*(z>0?1.32:1.42),z>0?1.23:1.43,z,.065);
      box(.61,.32,.06,dark,s*(z>0?1.32:1.42),z>0?1.03:1.23,z-.46,.025);
      bar([s*.94,.6,z],[s*1.4,z>0?1.21:1.41,z],.05);
    }
  }
  if(st.suspension){
    for(const s of [-1,1])for(const z of [1.55,-1.6]){
      bar([s*.7,.44,z-.28],[s*1.4,.65,z],.065,chrome);
      bar([s*.7,.44,z+.28],[s*1.4,.65,z],.065,chrome);
      bar([s*.83,1.04,z],[s*1.35,.61,z],.09,accent);
      bar([s*.83,1.04,z],[s*.83,.4,z],.06);
    }
  }
  if(st.cockpit){
    // Outboard pillars and a high roof clear even tall hats during head lean.
    for(const s of [-1,1]){
      bar([s*1.03,.4,1.25],[s*1.16,3.45,-.62],.085,paint);
      bar([s*1.16,3.45,-.62],[s*1.16,3.45,-1.88],.085,paint);
      bar([s*1.16,3.45,-1.88],[s*1.03,.4,-2.15],.085,paint);
      bar([s*1.03,.7,-2.15],[s*1.117,2.45,-.007],.06,accent);
    }
    for(const z of [-.62,-1.88])bar([-1.16,3.45,z],[1.16,3.45,z],.085,paint);
    if(st.kind==='rally')box(2.22,.10,.67,paint,0,3.44,-1.36,.04);
  }else if(st.hoopOnly){
    for(const s of [-1,1]){
      bar([s*.95,.42,-1.8],[s*1.05,2.5,-1.8],.09,chrome);
      bar([s*1.05,2.5,-1.8],[s*.9,.42,-2.3],.07,chrome);
    }
    bar([-1.05,2.5,-1.8],[1.05,2.5,-1.8],.09,chrome);
  }else if(st.rubber){
    bar([-.8,.4,-1.5],[-.8,1.95,-1.5],.08);bar([-.8,1.95,-1.5],[.8,1.95,-1.5],.08);bar([.8,1.95,-1.5],[.8,.4,-1.5],.08);
  }
  for(const s of [-1,1])box(st.lamps?.42:.24,.16,.14,dark,s*.71,.59,2.11,.04);
}
