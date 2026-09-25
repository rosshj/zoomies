// Extra habitat silhouettes. Every asset is one painted mesh; structures join
// the world's existing static batches and animals use its bounded amble loop.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeScenery } from './baked-lighting.js';
import { paintSurface } from './scenery-art.js';
import { dressingFor } from './biome-dressing.js';

export const HABITAT_ASSETS = {
  fox: { name: 'Fox', biome: 'forest', animal: true },
  hare: { name: 'Hare', biome: 'tundra', animal: true },
  tortoise: { name: 'Tortoise', biome: 'desert', animal: true },
  seal: { name: 'Seal', biome: 'beach', animal: true },
  antelope: { name: 'Antelope', biome: 'savanna', animal: true },
  boar: { name: 'Boar', biome: 'jungle', animal: true },
  frog: { name: 'Frog', biome: 'wetlands', animal: true },
  lifeguard: { name: 'Lifeguard tower', biome: 'beach' },
  birdHide: { name: 'Bird hide', biome: 'wetlands' },
  lookout: { name: 'Forest lookout', biome: 'forest' },
  well: { name: 'Desert well', biome: 'desert' },
  trough: { name: 'Water trough', biome: 'savanna' },
  apiary: { name: 'Bee hives', biome: 'lavender' },
  cairn: { name: 'Stone cairn', biome: 'alpine' },
};

export function makeHabitatAsset(kind, biome, material) {
  const spec = HABITAT_ASSETS[kind];
  if (!spec) throw new Error(`Unknown habitat asset: ${kind}`);
  const parts = [], theme = dressingFor(biome.name);
  const add = (geo, tint) => {
    if (geo.index) { const old=geo; geo=geo.toNonIndexed(); old.dispose(); }
    paintSurface(geo, { low: .82, faces: .05 });
    const c = new THREE.Color(tint), colors = geo.attributes.color;
    for (let i=0;i<colors.count;i++) colors.setXYZ(i,colors.getX(i)*c.r,colors.getY(i)*c.g,colors.getZ(i)*c.b);
    parts.push(geo);
  };
  const oval = (x,y,z,sx,sy,sz,c) => add(new THREE.SphereGeometry(1,8,5).scale(sx,sy,sz).translate(x,y,z),c);
  const box = (x,y,z,w,h,d,c) => add(new THREE.BoxGeometry(w,h,d).translate(x,y,z),c);
  const beam = (a,b,r,c,rEnd=r) => {
    const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),dir=end.clone().sub(start);
    const geo=new THREE.CylinderGeometry(rEnd,r,dir.length(),6);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir.normalize()));
    add(geo.translate(...start.add(end).multiplyScalar(.5).toArray()),c);
  };
  // Continuous tapered, curved silhouette for tails/horns; colour changes are
  // painted on the same surface, so a pale tail tip has no overlapping seam.
  const sweep = (points,radii,c,tip=c) => {
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
    const geo=new THREE.TubeGeometry(curve,8,1,6,false),p=geo.attributes.position;
    for(let i=0;i<=8;i++) {
      const t=i/8,center=curve.getPointAt(t),j=t*(radii.length-1),k=Math.min(radii.length-2,Math.floor(j));
      const r=THREE.MathUtils.lerp(radii[k],radii[k+1],j-k);
      for(let n=0;n<=6;n++){const v=i*7+n;p.setXYZ(v,center.x+(p.getX(v)-center.x)*r,center.y+(p.getY(v)-center.y)*r,center.z+(p.getZ(v)-center.z)*r);}
    }
    geo.computeVertexNormals();add(geo,c);
    if(tip!==c){const g=parts.at(-1),col=g.attributes.color,uv=g.attributes.uv,color=new THREE.Color(tip);for(let i=0;i<col.count;i++)if(uv.getX(i)>.7)col.setXYZ(i,color.r,color.g,color.b);}
  };
  const eyes=(x,y,z)=>{for(const s of [-1,1])oval(x,y,s*z,.055,.065,.035,0x202b2c);};
  const legs=(x,y,z,h,c)=>{for(const dx of [-x,x])for(const dz of [-z,z])beam([dx,.1,dz],[dx,y,dz],h,c);};
  const roof=(y,w,d,c)=>{for(const s of [-1,1])add(new THREE.BoxGeometry(w,.18,d*.61).rotateX(s*.48).translate(0,y,s*d*.23),c);};
  const posts=(top,w,d,c)=>{for(const x of [-w,w])for(const z of [-d,d])beam([x,0,z],[x,top,z],.16,c);};
  const dark=0x343432,cream=0xefe4c4;

  if(kind==='fox'||kind==='boar'||kind==='antelope') {
    const boar=kind==='boar',antelope=kind==='antelope';
    const fur=boar?0x675447:antelope?0xc89450:0xc57436, y=antelope?1.75:boar?1.0:.9;
    oval(0,y,0,boar?1.25:1.1,boar?.68:.49,boar?.64:.43,fur);
    legs(.7,y,.32,antelope?.095:.13,dark);
    if(antelope)beam([-.8,1.7,0],[-1.17,2.65,0],.23,fur,.19);
    oval(-1.1,antelope?2.6:y+.22,0,.48,.38,.34,fur);
    oval(-1.48,antelope?2.46:y+.12,0,boar?.25:.36,.20,.22,boar?0x9c7970:cream);
    eyes(-1.3,antelope?2.73:y+.35,.30);
    for(const s of [-1,1]) {
      add(new THREE.ConeGeometry(.18,.42,4).rotateX(s*.3).translate(-1.03,antelope?2.95:y+.66,s*.24),fur);
      if(antelope)sweep([[-1.0,2.87,s*.19],[-.94,3.28,s*.24],[-.65,3.58,s*.28]],[.095,.075,0],dark);
      if(boar)sweep([[-1.49,y-.01,s*.2],[-1.68,y+.02,s*.28],[-1.72,y+.25,s*.28]],[.08,.065,0],cream);
    }
    if(kind==='fox')sweep([[.8,.9,0],[1.5,.8,.12],[2.0,.48,.25],[2.3,.64,.3]],[.20,.35,.27,0],fur,cream);
    else sweep([[.95,y+.15,0],[1.36,y+.08,0],[1.45,y-.2,.1]],[.09,.06,0],dark);
  } else if(kind==='hare') {
    const fur=['tundra','alpine'].includes(biome.name)?0xe8e8df:0xb2a18b;
    oval(0,.62,0,.65,.58,.42,fur);oval(-.52,1.04,0,.35,.38,.29,fur);
    for(const s of [-1,1]) {
      oval(-.4,1.64,s*.16,.13,.51,.105,fur);
      oval(-.50,1.67,s*.16,.035,.35,.073,0xc99c97);
      oval(.35,.26,s*.35,.39,.25,.18,fur);oval(-.43,.16,s*.22,.32,.12,.13,fur);
    }
    oval(.66,.65,0,.19,.21,.21,cream);eyes(-.73,1.12,.235);
  } else if(kind==='tortoise') {
    oval(0,.36,0,.95,.24,.66,0xb59f65);
    const shell=new THREE.SphereGeometry(1,10,5,0,Math.PI*2,0,Math.PI/2).scale(.96,.78,.70).translate(0,.35,0);
    add(shell,0x6e8051);
    // Alternate shell facets are baked pigment, not additional plates.
    const g=parts.at(-1),p=g.attributes.position,c=g.attributes.color;
    for(let i=0;i<p.count;i++){const shade=Math.floor((Math.atan2(p.getZ(i),p.getX(i))+Math.PI)*5/Math.PI)%2?.82:1;c.setXYZ(i,c.getX(i)*shade,c.getY(i)*shade,c.getZ(i)*shade);}
    for(const s of [-1,1])for(const x of [-.6,.6])oval(x,.23,s*.55,.29,.20,.2,0xb59f65);
    oval(-1.02,.49,0,.35,.25,.25,0xb59f65);eyes(-1.14,.59,.22);
  } else if(kind==='seal') {
    // One sculpted torso tapers into the rear, with broad flippers at ground.
    const body=new THREE.SphereGeometry(1,10,6),p=body.attributes.position;
    for(let i=0;i<p.count;i++){const x=p.getX(i),t=(x+1)/2;p.setXYZ(i,x*1.45,.64+p.getY(i)*(.72-.42*t),p.getZ(i)*(.67-.40*t));}
    body.computeVertexNormals();add(body,0x84989b);
    oval(-1.0,1.06,0,.48,.48,.43,0x84989b);oval(-1.37,.96,0,.19,.19,.30,0xc5ceca);
    for(const s of [-1,1]){oval(-.4,.29,s*.48,.5,.19,.4,0x657d83);oval(1.19,.42,s*.18,.42,.16,.30,0x657d83);}
    eyes(-1.24,1.19,.35);oval(-1.55,1.07,0,.08,.07,.11,dark);
  } else if(kind==='frog') {
    oval(0,.43,0,.57,.38,.48,0x668b43);oval(-.39,.53,0,.42,.31,.41,0x7d9e4a);
    for(const s of [-1,1]) {
      oval(.29,.26,s*.47,.43,.24,.24,0x4f793b);
      oval(-.43,.22,s*.33,.34,.18,.20,0x7d9e4a);
      oval(-.44,.81,s*.27,.17,.18,.16,0xbac67a);
      oval(-.56,.83,s*.3,.07,.095,.075,dark);
    }
  } else if(['lifeguard','lookout','birdHide'].includes(kind)) {
    const hide=kind==='birdHide',life=kind==='lifeguard',deck=hide?1.0:life?2.5:3.8,top=deck+2.4;
    posts(top-.28,1.65,1.35,theme.wood);box(0,deck,0,3.8,.25,3.2,theme.wood);
    // Continuous boards and viewing slot; interior remains visibly open.
    for(const z of [-1.35,1.35])box(0,deck+.7,z,3.5,1.2,.16,life?0xe9dfb6:theme.wood);
    if(hide){for(const z of [-1.35,1.35])box(0,top-.55,z,3.5,.55,.16,theme.wood);}
    for(const x of [-1.65,1.65])box(x,deck+.7,0,.16,1.2,2.7,theme.wood);
    roof(top,4.3,3.9,life?0x559ba9:0x58644c);
    for(const s of [-1,1])beam([s*.55,0,2.6],[s*.55,deck,1.6],.10,theme.wood);
    for(let i=1;i<=5;i++)box(0,deck*i/6,2.6-i/6,1.2,.12,.22,theme.wood);
    if(life){box(0,deck+.8,1.45,1.2,.22,.08,0xc1644c);box(0,deck+.8,1.5,.22,.9,.08,0xc1644c);}
    else if(!hide)for(const s of [-1,1])beam([-1.65,.3,s*1.35],[1.65,deck-.15,s*1.35],.12,theme.wood);
  } else if(kind==='well') {
    // A hollow stone ring, with an opaque recessed water disc.
    add(new THREE.CylinderGeometry(1.35,1.45,1.05,10,1,true).translate(0,.525,0),theme.stone);
    const inside=new THREE.CylinderGeometry(1.12,1.12,1.05,10,1,true);
    const ix=inside.index.array,n=inside.attributes.normal;
    for(let i=0;i<ix.length;i+=3)[ix[i],ix[i+2]]=[ix[i+2],ix[i]];
    for(let i=0;i<n.count;i++)n.setXYZ(i,-n.getX(i),-n.getY(i),-n.getZ(i));
    add(inside.translate(0,.525,0),theme.stone);
    add(new THREE.RingGeometry(1.12,1.35,10).rotateX(-Math.PI/2).translate(0,1.05,0),theme.stone);
    add(new THREE.CircleGeometry(1.12,10).rotateX(-Math.PI/2).translate(0,.22,0),0x476f78);
    for(const x of [-1.6,1.6])beam([x,0,0],[x,3.3,0],.14,theme.wood);
    beam([-1.6,2.6,0],[1.6,2.6,0],.1,theme.wood);beam([0,2.6,0],[0,.65,0],.025,0x9b895c);
    roof(3.35,3.8,2.5,0xa77754);
  } else if(kind==='trough') {
    box(0,.35,0,3,.35,1.1,theme.wood);
    for(const z of [-.6,.6])box(0,.65,z,3.3,.65,.18,theme.wood);
    for(const x of [-1.55,1.55])box(x,.65,0,.18,.65,1.2,theme.wood);
    box(0,.76,0,2.95,.05,1.03,0x5c8e94);
    for(const x of [-1,1])box(x,.16,0,.25,.3,1.3,theme.wood);
  } else if(kind==='apiary') {
    for(const x of [-.95,.95]) {
      box(x,.35,0,1.2,.22,1.3,theme.wood);
      for(const z of [-.4,.4])box(x,.18,z,.85,.35,.14,theme.wood);
      box(x,1.05,0,1.05,1.2,1.05,0xd8bd78);
      for(const y of [.7,1.05,1.4])box(x,y,.535,1.05,.045,.025,0x927144);
      box(x,.55,.56,.45,.09,.04,0x3d3830);
      add(new THREE.ConeGeometry(.95,.55,4).rotateY(Math.PI/4).translate(x,1.86,0),0x7d8270);
    }
  } else if(kind==='cairn') {
    for(let i=0;i<4;i++)add(new THREE.IcosahedronGeometry(1,0).scale(1.0-i*.20,.35-i*.035,.80-i*.14).rotateY(i*1.8).translate(Math.sin(i)*.1,.28+i*.37,0),theme.stone);
  }
  const geo=mergeGeometries(parts);parts.forEach(p=>p.dispose());
  const group=new THREE.Group(),mesh=new THREE.Mesh(geo,material);
  mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
  if(spec.animal)group.userData.wander={range:kind==='frog'?2:4,speed:kind==='tortoise'?.35:kind==='seal'?.55:1.1,bob:kind==='hare'?.12:.025};
  else group.userData.staticProp=true;
  return spec.animal ? group : bakeScenery(group);
}
