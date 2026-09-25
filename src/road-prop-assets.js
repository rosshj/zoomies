// Procedural road toys: one cached, vertex-coloured draw per object. Shared art
// is independent of a world's seed; placement/yaw supply the regional variety.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const profile = (name, sound, extra = {}) => ({ name, sound, launch: .65, lift: 1, restitution: .28, friction: 6, angularDrag: 7, ...extra });
export const ROAD_PROPS = {
  hayBale: profile('Round hay bale', 'hay', { shape: 'cylinder', launch: .35, friction: 2.4, angularDrag: 3, stand: true }),
  pumpkin: profile('Pumpkin', 'fruit', { launch: .6, friction: 3, angularDrag: 4 }),
  fruitBasket: profile('Apple basket', 'wood', { burst: 'apple', depleted: true, anchors: ['barn','farmhouse','stall','apiary'] }),
  beachBall: profile('Beach ball', 'rubber', { shape: 'sphere', sphereRadius: 1.02, restitution: .78, gravity: 16, airDrag: .6, friction: 1.2, angularDrag: 2, lift: 1.7, wind: true }),
  coconut: profile('Coconut', 'coconut', { shape: 'sphere', sphereRadius: .68, restitution: .46, friction: 2.2, angularDrag: 3, anchors: ['palm'] }),
  sandBucket: profile('Sand bucket', 'plastic', { launch: .9, lift: 1.4 }),
  log: profile('Short fallen log', 'wood', { shape: 'cylinder', stand: true, launch: .4, friction: 2.4, angularDrag: 3, anchors: ['tree','cabin'] }),
  pinecone: profile('Pinecone', 'wood', { launch: .85, lift: 1.25 }),
  campRoll: profile('Camping bedroll', 'hay', { shape: 'cylinder', stand: true, launch: .5, anchors: ['cabin','lookout','chalet'] }),
  leafBundle: profile('Leaf bundle', 'rustle', { burst: 'leaf', vanish: true, wind: true }),
  tumbleweed: profile('Tumbleweed', 'rustle', { shape: 'sphere', sphereRadius: .88, restitution: .5, gravity: 16, airDrag: 1.2, friction: 2, angularDrag: 3, wind: true, lift: 1.5 }),
  clayPot: profile('Clay pot', 'pot', { burst: 'clay', vanish: true, anchors: ['adobe','well','hut'] }),
  wagonWheel: profile('Wagon wheel', 'wood', { shape: 'cylinder', stand: true, launch: .55, friction: 1.8, angularDrag: 2.4 }),
  snowball: profile('Snowball', 'snow', { shape: 'sphere', sphereRadius: .85, burst: 'snow', vanish: true }),
  iceChunk: profile('Ice chunk', 'ice', { friction: .65, angularDrag: 2.5, restitution: .17 }),
  supplyCase: profile('Supply case', 'plastic', { launch: .48, anchors: ['chalet','lookout'] }),
  trafficCone: profile('Traffic cone', 'plastic', { deform: true, launch: .85, lift: 1.2, anchors: ['lamp','hydrant','sign'] }),
  cardboardBox: profile('Cardboard carton', 'rustle', { deform: true, launch: .95, lift: 1.45, airDrag: 1.2, wind: true, anchors: ['store','stall'] }),
  tire: profile('Loose tire', 'rubber', { shape: 'cylinder', stand: true, launch: .7, restitution: .65, friction: 1.6, angularDrag: 2.5, lift: 1.3 }),
  tropicalFruit: profile('Fallen mangoes', 'fruit', { burst: 'mango', vanish: true, anchors: ['tree','palm','hut'] }),
  bambooBundle: profile('Bamboo bundle', 'wood', { shape: 'cylinder', stand: true, launch: .5, friction: 2.8, angularDrag: 4 }),
  fishingFloat: profile('Fishing float', 'plastic', { shape: 'sphere', sphereRadius: .81, restitution: .62, gravity: 22, friction: 2, lift: 1.3, anchors: ['stiltHut','birdHide','hut'] }),
  pumice: profile('Pumice rock', 'stone', { launch: .55, restitution: .4, burst: 'dust' }),
  canister: profile('Metal canister', 'metal', { shape: 'cylinder', launch: .6, friction: 3, angularDrag: 4 }),
};
export const ROAD_PROP_BIOMES = {
  meadow: ['hayBale','pumpkin','fruitBasket'], forest: ['log','pinecone','campRoll'],
  alpine: ['log','pinecone','campRoll','supplyCase'], autumn: ['pumpkin','fruitBasket','leafBundle'],
  beach: ['beachBall','coconut','sandBucket'], desert: ['tumbleweed','clayPot','wagonWheel'],
  mesa: ['clayPot','wagonWheel','tumbleweed'], tundra: ['snowball','iceChunk','supplyCase'],
  city: ['trafficCone','cardboardBox','tire'], jungle: ['tropicalFruit','bambooBundle','log'],
  wetlands: ['fishingFloat','bambooBundle','log'], volcanic: ['pumice','canister'],
  savanna: ['tumbleweed','clayPot','campRoll'], blossom: ['fruitBasket','leafBundle','clayPot'],
  lavender: ['hayBale','fruitBasket','leafBundle'],
};
const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 });
material.userData.shared = true;
const cache = new Map();
const C = { wood: 0x936137, end: 0xd6aa65, rope: 0x594732, dark: 0x343c45, straw: 0xd8b753, green: 0x688e49 };

function buildGeometry(kind, used) {
  const parts = [], tint = new THREE.Color();
  const add = (geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    geo.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x,y,z);
    const p = geo.attributes.position, n = geo.attributes.normal;
    tint.set(color); const values = new Float32Array(p.count * 3);
    for (let i=0;i<p.count;i++) {
      const shade = .83 + .17 * Math.max(0, n.getY(i) * .8 + n.getX(i) * .3 + n.getZ(i) * .2);
      values.set([tint.r*shade,tint.g*shade,tint.b*shade],i*3);
    }
    geo.setAttribute('color',new THREE.BufferAttribute(values,3));
    // Keep every part compatible and preserve a single opaque batch.
    geo.deleteAttribute('uv');
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose(); parts.push(g);
  };
  const box = (w,h,d,col,x=0,y=0,z=0,rz=0) => add(new THREE.BoxGeometry(w,h,d),col,x,y,z,0,0,rz);
  const cyl = (r1,r2,h,col,x=0,y=0,z=0,segments=10) => add(new THREE.CylinderGeometry(r1,r2,h,segments),col,x,y,z);
  const ring = (r,t,col,y=0) => add(new THREE.TorusGeometry(r,t,4,12),col,0,y,0,Math.PI/2);
  const ball = (r,col,x=0,y=0,z=0,sx=1,sy=1,sz=1) => add(new THREE.IcosahedronGeometry(r,1).scale(sx,sy,sz),col,x,y,z);
  const lathe = (points,col) => add(new THREE.LatheGeometry(points.map(p=>new THREE.Vector2(...p)),10),col);
  switch(kind) {
    case 'hayBale':
      cyl(1,1,1.6,C.straw);for(const y of [-.55,.55])ring(1.01,.035,C.rope,y);
      for(const y of [-.81,.81]){for(const r of [.25,.52,.78])ring(r,.025,0xb5913d,y);}
      break;
    case 'pumpkin':
      for(let i=0;i<8;i++){const a=i*Math.PI/4;ball(.5,i%2?0xe58a27:0xcf6a1e,Math.sin(a)*.42,0,Math.cos(a)*.42,.8,1.45,.8);}
      cyl(.10,.16,.27,0x5e6b33,0,.8);break;
    case 'fruitBasket':
      lathe([[0,-.5],[.65,-.5],[.82,.35],[.73,.35],[.57,-.4],[0,-.4]],C.wood);
      for(const y of [-.4,-.1,.2,.36])ring(.65+(y+.5)*.2,.035,C.end,y);
      if(!used)for(let i=0;i<5;i++){const a=i*2.4;ball(.29,i%2?0x9bbf49:0xd64632,Math.sin(a)*.46,.39+(i===4?.2:0),Math.cos(a)*.46);}
      break;
    case 'beachBall': {
      const colors=[0xef5e4a,0xfaf1d6,0xf9d656,0xfaf1d6,0x60c0d3,0xfaf1d6];
      const indexed=new THREE.SphereGeometry(1,18,8),sphere=indexed.toNonIndexed();
      indexed.dispose();
      // Longitude UVs keep each panel boundary on a mesh edge, including poles.
      const uv=sphere.attributes.uv;
      add(sphere,0xffffff);
      const g=parts.at(-1),a=g.attributes.position,c=g.attributes.color;
      for(let i=0;i<a.count;i+=3){
        const longitude=(uv.getX(i)+uv.getX(i+1)+uv.getX(i+2))/3;
        tint.set(colors[Math.min(5,Math.floor(longitude*6))]);
        for(let j=0;j<3;j++)c.setXYZ(i+j,tint.r,tint.g,tint.b);
      }
      break;
    }
    case 'coconut':
      ball(.66,0x876044);for(const [x,z] of [[-.16,0],[.16,0],[0,.2]])ball(.065,0x3b3028,x,.60,z);break;
    case 'sandBucket':
      lathe([[0,-.6],[.49,-.6],[.66,.52],[.56,.52],[.41,-.48],[0,-.48]],0x53bcc4);ring(.63,.065,0xf4d353,.53);
      add(new THREE.TorusGeometry(.68,.035,4,12,Math.PI),0xf4d353,0,.45,0);break;
    case 'log':
      cyl(.64,.68,2.25,C.wood);for(const y of [-1.135,1.135]){cyl(.57,.57,.018,C.end,0,y);for(const r of [.18,.37,.53])ring(r,.018,0xae7b44,y);}
      for(let i=0;i<5;i++){const a=i*Math.PI*.4;box(.08,1.9,.08,0x694831,Math.sin(a)*.64,0,Math.cos(a)*.64);}break;
    case 'pinecone':
      ball(.48,0x69452c,0,0,0,.8,1.3,.8);cyl(.06,.09,.20,0x63412b,0,.68);
      for(let j=0;j<4;j++)for(let i=0;i<6;i++){
        const a=(i+j*.5)*Math.PI/3,r=.34*(1-j*.13);
        add(new THREE.OctahedronGeometry(.21).scale(1,.65,1.4),j%2?0x9d7449:0x805333,Math.sin(a)*r,-.34+j*.24,Math.cos(a)*r,.45,a);
      }break;
    case 'campRoll':
      cyl(.61,.61,1.8,0x648369);for(const y of [-.6,.6])ring(.62,.05,0x3d4d46,y);for(const y of [-.91,.91]){ring(.39,.04,0x354f47,y);ring(.18,.03,0x98b58f,y);}break;
    case 'leafBundle':
      for(let i=0;i<13;i++){const a=i*2.4;add(new THREE.OctahedronGeometry(.4).scale(.7,.2,1.4),[0xd79035,0xb95736,0x9a793d][i%3],Math.sin(a)*.48,(i%3)*.16-.2,Math.cos(a)*.48,0,a,.15);}break;
    case 'tumbleweed':
      for(let i=0;i<7;i++)add(new THREE.TorusGeometry(.73+(i%3)*.06,.023,3,10),i%2?0xa2824f:0xc5a46a,0,0,0,i*.72,i*.41,i*.65);
      break;
    case 'clayPot':
      lathe([[0,-.7],[.4,-.7],[.75,-.2],[.70,.35],[.45,.62],[.46,.74],[.34,.74],[.34,.59],[.58,.25],[.61,-.2],[.31,-.55],[0,-.55]],0xc78459);ring(.46,.055,0xf0bf7f,.69);ring(.72,.025,0x744f3c,.18);break;
    case 'wagonWheel':
      ring(.93,.105,C.wood);ring(.98,.035,C.dark);cyl(.18,.18,.38,C.wood);
      for(let i=0;i<6;i++)add(new THREE.BoxGeometry(.10,.16,1.72),C.end,0,0,0,0,i*Math.PI/6);break;
    case 'snowball':ball(.84,0xe3eef0);break;
    case 'iceChunk':add(new THREE.DodecahedronGeometry(1,0).scale(.9,.58,.73),0x9dcedd);break;
    case 'supplyCase':
      box(1.75,1.05,1.2,0x68818e);for(const x of [-.67,.67])box(.10,1.10,1.24,C.dark,x);box(.45,.15,.14,0xddd6b2,0,.18,.65);box(.7,.12,.25,C.dark,0,.6);break;
    case 'trafficCone':
      box(1.25,.14,1.25,C.dark,0,-.65);
      if(used){add(new THREE.ConeGeometry(.47,1.2,10),0xf17838,0,-.32,.36,Math.PI*.36);add(new THREE.CylinderGeometry(.2,.32,.22,10),0xf2e7c5,0,-.16,.59,Math.PI*.36);}
      else{cyl(.09,.48,1.36,0xf17838);cyl(.21,.28,.23,0xf5eddb,0,.16);}break;
    case 'cardboardBox': {
      const h=used ? .45 : 1.2;box(1.35,h,1.3,0xbd935f,0,-.6+h/2);box(.20,h+.02,1.32,0xe2c393,0,-.6+h/2);
      box(.66,.045,1.28,0xd2b07c,-.4,-.6+h,.0,used ? .15 : -.25);box(.66,.045,1.28,0xb88c55,.4,-.6+h,0,used?-.2:.28);break;
    }
    case 'tire':
      ring(.67,.25,0x343b42);ring(.71,.19,0x23292e,.04);
      for(let i=0;i<12;i++){const a=i*Math.PI/6;add(new THREE.BoxGeometry(.10,.42,.15),0x30363b,Math.sin(a)*.86,0,Math.cos(a)*.86,0,a);}break;
    case 'tropicalFruit':for(let i=0;i<4;i++){const a=i*2.4;ball(.38,i%2?0xe6bc45:0xc68b2d,Math.sin(a)*.38,-.05+(i===3?.25:0),Math.cos(a)*.38,.75,1,1.2);}break;
    case 'bambooBundle':
      for(const [x,z] of [[-.2,-.16],[.2,-.16],[0,.2]]){cyl(.22,.22,2.2,0x8aab58,x,0,z,8);for(const y of [-.8,0,.8])cyl(.235,.235,.07,0xd7c787,x,y,z,8);}
      for(const y of [-.65,.65])ring(.40,.045,C.rope,y);break;
    case 'fishingFloat':
      ball(.76,0xe7dfbc);cyl(.80,.80,.25,0xdf6645,0,0,0,12);cyl(.12,.12,.13,C.dark,0,.75);break;
    case 'pumice': {
      const geo=new THREE.IcosahedronGeometry(.8,1).scale(1.1,.8,.9),p=geo.attributes.position;
      for(let i=0;i<p.count;i++){
        const v=Math.sin(p.getX(i)*81+p.getY(i)*57+p.getZ(i)*93);
        if(v>.5)p.setXYZ(i,p.getX(i)*.92,p.getY(i)*.92,p.getZ(i)*.92);
      }
      geo.computeVertexNormals();add(geo,0x817a78);
      const g=parts.at(-1),c=g.attributes.color,a=g.attributes.position;
      for(let i=0;i<a.count;i++)if(Math.sin(a.getX(i)*81+a.getY(i)*57+a.getZ(i)*93)>.35)c.setXYZ(i,c.getX(i)*.65,c.getY(i)*.65,c.getZ(i)*.65);
      break;
    }
    case 'canister':
      cyl(.58,.58,1.7,0x809093);for(const y of [-.75,.75])ring(.58,.065,C.dark,y);box(.68,.4,.10,0xe2bb56,0,0,.57);cyl(.18,.18,.15,C.dark,.2,.92);box(.5,.08,.14,C.dark,-.1,.95);break;
    default: throw Error(`Unknown road prop ${kind}`);
  }
  const geometry=mergeGeometries(parts,false);for(const p of parts)p.dispose();
  geometry.computeBoundingBox();geometry.userData.shared=true;
  const points=new Map(),p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){const v=new THREE.Vector3().fromBufferAttribute(p,i);points.set(v.toArray().map(n=>n.toFixed(5)).join(','),v);}
  let hull = [...points.values()];
  if (ROAD_PROPS[kind].shape === 'cylinder') {
    // A radial convex envelope drops decorative/interior vertices. Generation
    // does the work; runtime sees only a few twelve-sided rings.
    const levels = new Map();
    for (const v of hull) { const y = Number(v.y.toFixed(5)); levels.set(y, Math.max(levels.get(y) || 0, Math.hypot(v.x,v.z))); }
    const envelope = [];
    for (const point of [...levels].sort((a,b)=>a[0]-b[0])) {
      while (envelope.length > 1) {
        const a=envelope.at(-2),b=envelope.at(-1);
        if ((b[0]-a[0])*(point[1]-b[1])-(b[1]-a[1])*(point[0]-b[0]) < -1e-7) break;
        envelope.pop();
      }
      envelope.push(point);
    }
    hull = [];
    for (const [y,r] of envelope) for(let k=0;k<12;k++) hull.push(new THREE.Vector3(Math.sin(k*Math.PI/6)*r/Math.cos(Math.PI/12),y,Math.cos(k*Math.PI/6)*r/Math.cos(Math.PI/12)));
  }
  return { geometry, hull, rest:-geometry.boundingBox.min.y };
}
export function makeRoadProp(kind, used = false) {
  const key=kind+(used?':used':'');let art=cache.get(key);
  if(!art){art=buildGeometry(kind,used);cache.set(key,art);}
  if(!used && (ROAD_PROPS[kind].depleted || ROAD_PROPS[kind].deform) && !cache.has(kind+':used'))cache.set(kind+':used',buildGeometry(kind,true));
  const mesh=new THREE.Group();mesh.add(new THREE.Mesh(art.geometry,material));
  if(ROAD_PROPS[kind].stand)mesh.rotation.x=Math.PI/2;
  return {mesh,hull:art.hull,rest:art.rest,profile:ROAD_PROPS[kind]};
}
