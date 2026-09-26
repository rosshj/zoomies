import * as THREE from 'three';

// Separate nose, side and upright-plate layouts in one opaque 256px atlas.
// UVs select a panel; paint stays in the existing material batch.
const TILES={hood:[4,4,152,248],side:[164,4,88,108],plate:[164,120,88,64],trim:[180,192,72,60]};
const SOLID_UV=[168/256,1-244/256];
const paints=new Map();
const hoodSize=st=>!st.racing?[1.04,1.55]:st.vintage?[.88,1.76]:[Math.max(.43,st.nose)*2,1.81];
export function racingPaint(color,livery,number,st){
  const [hoodW,hoodH]=hoodSize(st),sideW=st.racing?(st.tire>1?1.16:1.55):(st.tire>=1.2?1.25:1.62),sideH=st.racing?.48:.5;
  const key=`${color}|${livery}|${number}|${hoodW}|${hoodH}|${sideW}|${sideH}`;
  if(paints.has(key))return paints.get(key);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const c=canvas.getContext('2d'),base=new THREE.Color(color);
  const body='#'+base.getHexString(),shade='#'+base.clone().multiplyScalar(.42).getHexString();
  const ink=base.r*.2126+base.g*.7152+base.b*.0722>.62?'#303846':'#f5f1e5';
  // A restrained third team color complements the body; no random palettes.
  const hsl=base.getHSL({});
  const trim=hsl.s<.18?(hsl.l>.65?'#ce4338':'#dca742'):hsl.h<.08||hsl.h>.9?'#f2c45a':hsl.h<.18?'#243c56':hsl.h<.46?'#dfb851':hsl.h<.64?'#ee8844':'#d8bc70';
  c.fillStyle=body;c.fillRect(0,0,256,256);
  // Draw in physical panel proportions, not texture-pixel proportions. This
  // keeps glyphs readable on both broad fairings and narrow side panels.
  const tile=(role,w,h,draw)=>{
    const [x,y,tw,th]=TILES[role];c.save();c.beginPath();c.rect(x,y,tw,th);c.clip();
    c.translate(x+tw/2,y+th/2);c.scale(tw/(w*100),th/(h*100));draw(w*100,h*100);c.restore();
  };
  const text=(label,x,y,w,h,color,font='bold 80px sans-serif')=>{
    c.save();c.font=font;c.textAlign='left';c.textBaseline='alphabetic';
    const m=c.measureText(label),iw=m.actualBoundingBoxLeft+m.actualBoundingBoxRight,ih=m.actualBoundingBoxAscent+m.actualBoundingBoxDescent;
    const fit=Math.min(w/Math.max(iw,1),h/Math.max(ih,1));
    c.translate(x,y);c.scale(fit,fit);c.fillStyle=color;
    // Optical centering uses the actual ink bounds, including italic overhang.
    c.fillText(label,(m.actualBoundingBoxLeft-m.actualBoundingBoxRight)/2,(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2);c.restore();
  };
  const polygon=(points,color)=>{c.fillStyle=color;c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fill();};
  const band=(x,w,h,color)=>{c.fillStyle=color;c.fillRect(x-w/2,-h/2,w,h);};
  // Stripes are continuous across the nose and matching trim panels. Each
  // layout uses a small number of broad marks that remain legible in a race.
  const topPattern=(w,h)=>{
    if(livery===0){band(-w*.26,w*.18,h,ink);band(-w*.13,w*.035,h,trim);}
    else if(livery===1){for(const s of [-1,1]){band(s*w*.28,w*.13,h,ink);band(s*w*.38,w*.025,h,trim);}}
    else if(livery===2){
      polygon([[-w/2,-h*.42],[0,-h*.10],[w/2,-h*.42],[w/2,-h*.24],[0,h*.08],[-w/2,-h*.24]],ink);
      polygon([[-w/2,-h*.19],[0,h*.13],[w/2,-h*.19],[w/2,-h*.14],[0,h*.18],[-w/2,-h*.14]],trim);
    }else if(livery===3){band(0,w*.42,h,shade);band(0,w*.27,h,ink);for(const s of [-1,1])band(s*w*.24,w*.028,h,trim);}
    else if(livery===4){for(const s of [-1,1]){band(s*w*.30,w*.023,h,ink);band(s*w*.35,w*.023,h,trim);}}
    else if(livery===5){
      polygon([[-w/2,-h/2],[-w*.1,-h/2],[w/2,h*.31],[w/2,h/2],[w*.2,h/2],[-w/2,-h*.26]],ink);
      polygon([[-w/2,-h*.2],[w*.12,h/2],[w*.25,h/2],[-w/2,-h*.36]],trim);
    }else if(livery===6){
      polygon([[-w/2,-h/2],[-w*.12,-h/2],[-w*.24,h*.22],[-w/2,h*.22]],ink);
      polygon([[w*.18,-h*.1],[w/2,-h*.1],[w/2,h/2],[w*.06,h/2]],trim);
    }else{band(0,w*.62,h,'#222e3c');for(const s of [-1,1]){band(s*w*.35,w*.033,h,trim);band(s*w*.41,w*.016,h,ink);}}
  };
  const badge=(x,y,w,h)=>{
    const night=livery===7,round=livery===4,field=night?'#202a37':'#f7f2df',edge=night?ink:'#252b34';
    const plate=(inset,color)=>{c.fillStyle=color;c.beginPath();if(round)c.ellipse(x,y,w/2-inset,h/2-inset,0,0,Math.PI*2);else c.roundRect(x-w/2+inset,y-h/2+inset,w-inset*2,h-inset*2,livery===6?1:Math.min(w,h)*.13);c.fill();};
    plate(0,edge);plate(1.5,field);
    text(String(number),x,y,w-10,h-10,night?'#f7f2df':'#202631',round?'bold 80px sans-serif':'bold italic 80px sans-serif');
  };
  tile('hood',hoodW,hoodH,(w,h)=>{
    topPattern(w,h);
    c.fillStyle=shade;c.fillRect(-w/2,h*.40,w,h*.10);
    const bw=livery===4?Math.min(w*.64,54):Math.min(w*.66,82);
    badge(0,h*.10,bw,livery===4?bw:52);
    // Tiny team marks sit in their own painted tab, clear of graphic overlaps.
    c.fillStyle=body;c.fillRect(-Math.min(w*.32,24),-h*.295,Math.min(w*.64,48),h*.09);
    text(['APEX','VECTOR','SUMMIT','GT','CLUB','WORKS','RALLY','ENDURO'][livery],0,-h*.25,Math.min(w*.58,44),h*.05,ink);
  });
  tile('side',sideW,sideH,(w,h)=>{
    if(livery===0||livery===1||livery===4){
      c.fillStyle=ink;c.fillRect(-w/2,-h*.35,w,h*.065);
      c.fillStyle=trim;c.fillRect(-w/2,livery===1?h*.27:-h*.24,w,h*.035);
    }else if(livery===2||livery===5){
      polygon([[-w/2,h*.32],[-w/2,h*.05],[w*.28,-h*.40],[w/2,-h*.40],[w/2,-h*.12],[-w*.25,h*.32]],ink);
      polygon([[-w/2,h*.43],[-w/2,h*.37],[w/2,-h*.1],[w/2,-h*.02]],trim);
    }else if(livery===3){c.fillStyle=shade;c.fillRect(-w/2,-h*.27,w,h*.54);c.fillStyle=trim;c.fillRect(-w/2,-h*.34,w,h*.04);}
    else if(livery===6){polygon([[-w/2,-h/2],[-w*.22,-h/2],[-w*.35,h/2],[-w/2,h/2]],ink);polygon([[w*.3,-h/2],[w/2,-h/2],[w/2,h/2],[w*.17,h/2]],trim);}
    else{c.fillStyle='#222e3c';c.fillRect(-w/2,-h*.38,w,h*.76);c.fillStyle=trim;c.fillRect(-w/2,h*.38,w,h*.04);}
    badge(0,0,livery===4?34:66,livery===4?34:26);
  });
  tile('plate',.72,.43,()=>badge(0,0,livery===4?34:61,34));
  tile('trim',1,1,topPattern);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=2;map.userData.shared=true;
  const mat=new THREE.MeshStandardMaterial({map,roughness:.4});mat.userData.shared=true;mat.userData.paint=true;
  if(paints.size>=64)paints.delete(paints.keys().next().value);
  paints.set(key,mat);return mat;
}

// Split UV seams without adding triangles. A side number belongs on the outer
// side face, never repeated/stretched over the pod's top or end caps.
export function panelPaintUV(geometry,role,project,side=1,face=role==='side'?'side':role==='plate'?'front':'top'){
  const g=geometry.index?geometry.toNonIndexed():geometry,p=g.attributes.position,uv=g.attributes.uv;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),n=new THREE.Vector3();
  const [x,y,w,h]=TILES[role];
  for(let i=0;i<p.count;i+=3){
    a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,i+1);c.fromBufferAttribute(p,i+2);
    n.crossVectors(b.sub(a),c.sub(a)).normalize();
    const painted=face==='side'?n.x*side>.65:face==='front'?n.z>.65:n.y>.3;
    for(let j=i;j<i+3;j++){
      if(!painted){uv.setXY(j,...SOLID_UV);continue;}
      const [u,v]=project(p.getX(j),p.getY(j),p.getZ(j));
      uv.setXY(j,(x+Math.max(0,Math.min(1,u))*w)/256,1-(y+Math.max(0,Math.min(1,v))*h)/256);
    }
  }
  uv.needsUpdate=true;return g;
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
  const panel=(rows,m,x=0,side=false,trim=false)=>{
    const pos=[],uv=[],ix=[],min=rows[0][0],len=rows.at(-1)[0]-min,maxW=Math.max(...rows.map(r=>r[1]));
    rows.forEach(([z,w,b,t],j)=>{
      const c=Math.min(.075,(t-b)*.24,w*.2);
      for(const [px,py] of [[-w,b+c],[-w+c,b],[w-c,b],[w,b+c],[w,t-c],[w-c,t],[-w+c,t],[-w,t-c]]){
        pos.push(px,py,z);uv.push(side?(x>0?1-(z-min)/len:(z-min)/len):px/(maxW*2)+.5,side?(py-b)/(t-b):1-(z-min)/len);
      }
      if(j)for(let i=0;i<8;i++){const a=(j-1)*8+i,b=(j-1)*8+(i+1)%8,d=j*8+i,e=j*8+(i+1)%8;ix.push(a,b,d,b,e,d);}
    });
    for(let i=1;i<7;i++){ix.push(0,i+1,i);const b=(rows.length-1)*8;ix.push(b,b+i,b+i+1);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(ix);g.computeVertexNormals();
    if(m===livery){
      const centerY=(rows[1][3]+rows[2][3])*.25+.155;
      const mapped=panelPaintUV(g,trim?'trim':side?'side':'hood',side
        ?(px,py,z)=>[.5+(x>0?-1:1)*(z+.045)/len,.5-(py-centerY)/.48]
        :(px,py,z)=>[px/(maxW*2)+.5,(z-min)/len],Math.sign(x));
      return mesh(mapped,m,x);
    }
    return mesh(g,m,x);
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
    const g=panelPaintUV(new THREE.SphereGeometry(1,16,8),'hood',(x,y,z)=>[x*.5+.5,z*.5+.5]);
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
    const plate=box(.72,.43,.075,livery,0,1.04,.83,.035);plate.geometry=panelPaintUV(plate.geometry,'plate',(x,y)=>[x/.72+.5,.5-y/.43]);plate.rotation.x=-.13;
  }
  if(st.oval){
    panel([[-2.27,1.18,.42,.81],[-1.98,1.18,.4,.75]],paint);
    box(2.35,.15,.12,accent,0,.85,-2.26,.025);
  }
  if(st.stream){
    for(const s of [-1,1]){
      // High rear-wheel shoulders, open on the outside and below the driver.
      panel([[-2.26,.31,.91,1.12],[-1.75,.34,1.17,1.36],[-1.38,.33,1.17,1.36],[-.92,.20,.82,.95]],livery,s*1.4,false,true);
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
      panel(rows,livery,x,false,true).name='wheel-arch';
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
    if(st.kind==='rally')panel([[-1.86,.99,3.48,3.55],[-1.48,1.04,3.50,3.59],[-.96,.99,3.48,3.55]],livery,0,false,true);
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
