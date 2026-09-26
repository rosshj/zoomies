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
  const ink=base.r*.2126+base.g*.7152+base.b*.0722>.62?'#303846':'#f5f1e5';
  c.fillStyle=ink;
  if(livery===1){c.fillRect(60,0,22,256);c.fillRect(174,0,22,256);}
  else if(livery===2){for(const y of [-75,10,95]){c.beginPath();c.moveTo(0,y);c.lineTo(128,y+55);c.lineTo(256,y);c.lineTo(256,y+24);c.lineTo(128,y+79);c.lineTo(0,y+24);c.fill();}}
  else{c.fillRect(34,0,44,256);c.fillStyle='#252b34';c.fillRect(82,0,9,256);}
  c.fillStyle='#252b34';c.beginPath();c.roundRect(99,79,124,99,18);c.fill();
  c.fillStyle='#f5f1e5';c.beginPath();c.roundRect(103,83,116,91,14);c.fill();
  c.fillStyle='#202631';c.textAlign='center';c.textBaseline='middle';c.font='bold 65px sans-serif';c.fillText(String(number),161,130,105);
  // Fine pinstripes and panel fasteners are paint, not floating geometry.
  c.fillStyle=ink;c.fillRect(8,12,2,163);c.fillRect(246,12,2,163);
  c.fillStyle='#adb4b7';for(const x of [19,237])for(const y of [24,168]){c.beginPath();c.arc(x,y,2.5,0,Math.PI*2);c.fill();}
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
  // Thin brackets, cooling fins and inset trim need no invisible bevel grids.
  const box=(w,h,d,m,x,y,z,r=.06)=>mesh(Math.min(w,h,d)<=.18?new THREE.BoxGeometry(w,h,d):rbox(w,h,d,r,1),m,x,y,z);
  const bar=(a,b,r=.065,m=dark)=>{
    const v=new THREE.Vector3(...a),w=new THREE.Vector3(...b),delta=w.clone().sub(v);
    const o=mesh(new THREE.CylinderGeometry(r,r,delta.length(),8),m);o.position.copy(v.add(w).multiplyScalar(.5));o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return o;
  };
  // Rounded tube bends are one continuous surface; the ends embed in mounts.
  const bentTube=(points,r,m=dark,bend=.14)=>{
    const p=points.map(a=>new THREE.Vector3(...a)),curve=new THREE.CurvePath();let last=p[0];
    for(let i=1;i<p.length-1;i++){
      const d=Math.min(bend,p[i].distanceTo(p[i-1])*.3,p[i].distanceTo(p[i+1])*.3);
      const a=p[i].clone().addScaledVector(p[i-1].clone().sub(p[i]).normalize(),d);
      const b=p[i].clone().addScaledVector(p[i+1].clone().sub(p[i]).normalize(),d);
      curve.add(new THREE.LineCurve3(last,a));curve.add(new THREE.QuadraticBezierCurve3(a,p[i],b));last=b;
    }
    curve.add(new THREE.LineCurve3(last,p.at(-1)));
    return mesh(new THREE.TubeGeometry(curve,points.length*4,r,8,false),m);
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
  panel([[-2.32,.87,.28,.44],[-1.72,1.01,.28,.44],[.8,.92,.28,.44],[2.12,.59,.3,.44]],dark);
  for(const s of [-1,1]){
    bar([s*.94,.40,-2.26],[s*.94,.40,1.85],.07,st.rail?paint:dark);
    bar([s*.94,.40,1.85],[s*.62,.40,2.08],.07,st.rail?paint:dark);
    bar([0,.52,1.55],[s*1.32,.52,1.55],.075,chrome);
    bar([0,.63,-1.6],[s*1.42,.63,-1.6],.085,chrome);
  }
  bar([-.94,.42,-2.3],[.94,.42,-2.3],.1);
  if(st.rail){
    bentTube([[-.98,.44,1.81],[-.89,.48,2.18],[.89,.48,2.18],[.98,.44,1.81]],.09,chrome);
  }else{
    // Swept outer bumper shoulders give the front a molded, purposeful edge.
    panel([[1.76,1.08,.29,.51],[1.94,1.24,.27,st.rubber?.65:.56],[2.18,1.08,.30,st.rubber?.59:.49]],st.rubber?dark:accent);
  }
  // Narrow driving fairing slopes down from the steering column.
  if(st.vintage){
    const g=new THREE.SphereGeometry(1,16,8),p=g.attributes.position,uv=g.attributes.uv;
    for(let i=0;i<p.count;i++)uv.setXY(i,p.getX(i)*.5+.5,.5-p.getZ(i)*.5);
    const o=mesh(g,livery,0,.65,1.25);o.scale.set(.44,.32,.88);
    box(.48,.16,.65,paint,0,.65,.38);
    for(const s of [-1,1])for(let i=0;i<3;i++)box(.02,.07,.23,dark,s*.425,.69,1.12+i*.19,.01);
  }else{
    const shoulder=st.kind==='sprint'||st.kind==='endurance'||st.oval;
    panel([[.32,.32,.40,st.kind==='shifter'?1.02:.98],[.92,.43,.40,.82],[1.48,st.nose*(shoulder?.96:.82),.34,.64],[1.85,st.nose,.32,.56],[2.13,st.nose*.77,.32,.46]],livery);
    // A dark lower lip belongs to the shell and follows its front outline.
    panel([[1.78,st.nose*.97,.285,.34],[2.15,st.nose*.79,.285,.34]],accent);
  }
  const podLen=st.tire>1?1.16:1.55;
  for(const s of [-1,1]){
    const w=st.pod*.5,asym=st.oval&&s<0?.12:0;
    panel([[-podLen/2-.12,w*.63,.38,.63+asym],[-.36,w,.31,.78+asym],[.27,w,.31,.71+asym],[podLen/2-.12,w*.62,.36,.53]],livery,s*(1.02+w*.22),true);
    // Small recessed-looking cooling inlets sit flush in the inner pod wall.
    if(!st.rail)for(let n=0;n<3;n++)box(.026,.085,.12,dark,s*(1.02+w*.22-w+.008),.55,-.23+n*.16,.006);
    if(st.guard){
      box(.12,st.rubber?.3:.20,2.02,dark,s*1.36,.44,-.08);
      bar([s*1.36,.44,.90],[s*1.12,.44,1.12],.07);
    }
  }
  // Tapered bucket-seat back and padded bolsters replace the upright slab.
  const back=panel([[.84,.53,1.04,1.31],[1.21,.67,1.10,1.38],[1.64,.57,1.22,1.46],[1.91,.40,1.30,1.49]],accent);
  back.rotation.x=-Math.PI/2;
  const pad=panel([[1.02,.44,1.04,1.11],[1.45,.46,1.14,1.24],[1.77,.32,1.25,1.34]],dark);pad.rotation.x=-Math.PI/2;
  for(const s of [-1,1]){
    const bolster=box(.20,.31,1.13,dark,s*.64,1.10,-.56,.095);bolster.rotation.z=-s*.13;
    bar([s*.53,.44,-1.13],[s*.53,1.22,-1.32],.06);
  }
  bar([0,.5,.55],[0,1.4,.55],.055);
  // Engine, cooling fins, exhaust header and a supported intake.
  box(st.radiator?.88:.68,.46,.67,dark,-.48,.73,-1.87);
  for(let i=0;i<3;i++)box(.69,.045,.54,chrome,-.48,.62+i*.13,-1.87,.015);
  box(.46,.22,.42,accent,-.48,1.03,-1.87);
  bar([-.47,.8,-2.05],[-.42,.58,-2.35],.105,chrome);
  // A machined fan housing and solid chain guard make the rear readable.
  const fan=mesh(new THREE.CylinderGeometry(.25,.25,.16,12),chrome,-.84,.74,-1.86);fan.rotation.z=Math.PI/2;
  const fanCore=mesh(new THREE.CylinderGeometry(.17,.17,.17,12),dark,-.85,.74,-1.86);fanCore.rotation.z=Math.PI/2;
  box(.49,.34,.65,st.vintage?chrome:dark,.5,.62,-1.87);
  box(.30,.17,.65,accent,.52,.84,-1.85,.07);
  // Rear bumper supports the tail lights and exposed exhausts.
  bentTube([[-.94,.42,-2.17],[-.94,.48,-2.46],[.94,.48,-2.46],[.94,.42,-2.17]],.075);
  for(const side of [-1,1])box(.38,.26,.16,dark,side*.62,.48,-2.44,.06);
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
      const rear=z<0,r=(rear?.62:.52)*st.tire,x=s*(rear?1.42:1.32),rows=[];
      // Single rolled arch follows the tire, with space for front steering.
      for(let i=0;i<=8;i++){
        const a=-.94+i*1.88/8,zz=z+Math.sin(a)*(r+.13),y=r+Math.cos(a)*(r+.13);
        rows.push([zz,rear?.38:.40,y-.075,y]);
      }
      panel(rows,paint,x).name='wheel-arch';
      box(rear?.73:.77,.26,.06,dark,x,rows[0][2]-.10,rows[0][0],.025);
      bar([s*.94,.6,z],[x,r*2+.05,z],.05);
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
    // Swept shoulders soften the cage silhouette, retaining tall-hat clearance.
    for(const s of [-1,1]){
      bentTube([[s*1.03,.4,1.25],[s*1.16,3.30,-.67],[s*1.08,3.52,-1.0],[s*1.08,3.52,-1.78],[s*1.16,3.26,-2.02],[s*1.03,.4,-2.15]],.085,paint,.17);
      const t=(2.30-.4)/(3.30-.4);
      bar([s*1.03,.7,-2.15],[s*(1.03+.13*t),2.30,1.25-1.92*t],.06,accent);
      box(.21,.12,.29,dark,s*1.03,.43,1.25,.03);
      box(.21,.12,.29,dark,s*1.03,.43,-2.15,.03);
    }
    for(const z of [-1.0,-1.78])bar([-1.08,3.52,z],[1.08,3.52,z],.085,paint);
    if(st.kind==='rally')panel([[-1.86,.99,3.48,3.55],[-1.48,1.04,3.50,3.59],[-.96,.99,3.48,3.55]],paint);
  }else if(st.hoopOnly){
    for(const s of [-1,1]){
      bar([s*1.05,2.32,-1.8],[s*.9,.42,-2.3],.07,chrome);
    }
    bentTube([[-.95,.42,-1.8],[-1.05,2.35,-1.8],[-.83,2.55,-1.8],[.83,2.55,-1.8],[1.05,2.35,-1.8],[.95,.42,-1.8]],.09,chrome,.15);
  }else if(st.rubber){
    bar([-.8,.4,-1.5],[-.8,1.95,-1.5],.08);bar([-.8,1.95,-1.5],[.8,1.95,-1.5],.08);bar([.8,1.95,-1.5],[.8,.4,-1.5],.08);
  }
  for(const s of [-1,1])box(st.lamps?.42:.24,.16,.14,dark,s*.71,.59,2.11,.04);
}
