import assert from 'node:assert/strict';
import * as T from 'three';
import { BIOME_DRESSING } from '../src/biome-dressing.js';
import { ROAD_PROPS, ROAD_PROP_BIOMES, makeRoadProp } from '../src/road-prop-assets.js';
import { initProps } from '../src/props.js';
import { PropPhysics } from '../src/prop-physics.js';
import { trackFixture } from './fixtures/prop-track.mjs';
import { setWind, setWindClock } from '../src/wind.js';
const track=trackFixture(),scene=new T.Scene(),physics=new PropPhysics(track),results=[];
assert.deepEqual(Object.keys(ROAD_PROP_BIOMES).sort(),Object.keys(BIOME_DRESSING).sort());
let sounds=0,bursts=0;
for(const biome of Object.keys(ROAD_PROP_BIOMES)){
 const opts={seed:'REGIONAL',biomeNameAt:()=>biome,onImpact:()=>sounds++,onItem:()=>true};
 const system=await initProps(scene,track,opts);assert(system);
 const props=system._props,types=[...new Set(props.filter(p=>p.profile).map(p=>p.kind))];
 assert.equal(system.boxTargets().length,5);assert(props.filter(p=>p.kind==='crate'&&p.mode==='ground').length>=19);
 assert(system.count<=64);assert.deepEqual(types.sort(),[...ROAD_PROP_BIOMES[biome]].sort());
 for(const pr of props)if(pr.profile)assert(ROAD_PROP_BIOMES[biome].includes(pr.kind));
 const twin=await initProps(new T.Scene(),track,opts);
 assert.deepEqual(props.map(p=>[p.kind,...p.pos.toArray()]),twin._props.map(p=>[p.kind,...p.pos.toArray()]));
 system.setItemsEnabled(false);
 for(const kind of types){
  const pr=props.find(p=>p.kind===kind),oldGeometry=pr.mesh.children[0].geometry;
  // Actual swept-kart impact, with other props away from this segment.
  const t=track._tans[pr.roadIndex],start=pr.pos.clone().addScaledVector(t,-7),end=pr.pos.clone().addScaledVector(t,7);
  system.update(.05,[{x:start.x,z:start.z}]);system.update(.05,[{x:end.x,z:end.z}]);
  assert(pr.hit>0,`${kind} wasn't hit`);
  if(pr.profile.burst){assert(system._debris.activeCount>0);bursts++;}
  if(pr.profile.vanish)assert(pr.broken&&!pr.mesh.visible);
  if(pr.profile.depleted||pr.profile.deform)assert.notEqual(pr.mesh.children[0].geometry,oldGeometry);
 }
 for(let i=0;i<1800;i++)system.update(1/120,[]);
 assert.equal(system._debris.activeCount,0);
 assert(props.filter(p=>p.profile&&!p.broken).every(p=>p.asleep&&!p.settle),`${biome} never slept: ${props.filter(p=>p.profile&&!p.broken&&!p.asleep).map(p=>p.kind+':'+p.vel.length()+':'+p.angVel.length())}`);
 // Debris pools saturate without adding meshes or increasing slot count.
 const source=props.find(p=>p.profile);
 for(let i=0;i<50;i++)for(const type of ['apple','clay','leaf'])system._debris.burst(type,source,()=>.5);
 assert.equal(system._debris.activeCount,36);assert.equal(Object.values(system._debris.pools).reduce((n,p)=>n+p.slots.length,0),36);
 for(let i=0;i<400;i++)system.update(1/120,[]);assert.equal(system._debris.activeCount,0);
 results.push({biome,types,crates:props.filter(p=>p.kind==='crate').length,count:system.count});
 scene.remove(system.group);
}
// No decorative object can grant an item or become a replacement crate.
assert(sounds>0&&bursts>0);
// Hollow containers need outward-facing undersides as well as interior floors:
// backface culling must not make a tumbling or emptied container see-through.
for(const [kind,bottom,floor,radius] of [['fruitBasket',-.5,-.4,.5],['sandBucket',-.6,-.48,.35],['clayPot',-.7,-.55,.25]]){
 for(const used of kind==='fruitBasket'?[false,true]:[false]){
  const {mesh}=makeRoadProp(kind,used);mesh.updateMatrixWorld(true);
  for(let i=0;i<20;i++){
   const angle=(i+.37)*Math.PI*2/20,r=i%2?radius:.05;
   const x=Math.sin(angle)*r,z=Math.cos(angle)*r;
   const underside=new T.Raycaster(new T.Vector3(x,bottom-1,z),new T.Vector3(0,1,0)).intersectObject(mesh)[0];
   assert(underside&&Math.abs(underside.point.y-bottom)<1e-6&&underside.face.normal.y<-.99,`${kind} missing underside (used=${used})`);
   if(kind!=='fruitBasket'||used){
    const interior=new T.Raycaster(new T.Vector3(x,1,z),new T.Vector3(0,-1,0)).intersectObject(mesh)[0];
    assert(interior&&Math.abs(interior.point.y-floor)<1e-6&&interior.face.normal.y>.99,`${kind} must have an open top and raised interior floor`);
   }
  }
 }
}
let checkedVertices=0;
const ray=new T.Raycaster(),origin=new T.Vector3(),down=new T.Vector3(0,-1,0),road=new T.Mesh(new T.BufferGeometry(),new T.MeshBasicMaterial({side:T.DoubleSide}));road.updateMatrixWorld();
const budgets=[];
for(const kind of Object.keys(ROAD_PROPS))for(const used of [false,...(ROAD_PROPS[kind].depleted||ROAD_PROPS[kind].deform?[true]:[])]){
 const b=makeRoadProp(kind,used),g=b.mesh.children[0].geometry;
 assert.equal(b.mesh.children.length,1);assert(g.attributes.position.count/3<=1000,`${kind} geometry budget`);
 for(const a of Object.values(g.attributes))assert(a.array.every(Number.isFinite));
 const pr={kind,profile:b.profile,mesh:b.mesh,pos:track._pts[55].clone(),quat:new T.Quaternion(),vel:new T.Vector3(),angVel:new T.Vector3(),asleep:false,settle:false};physics.prepare(pr,b.hull,55);
 const check=()=>{
  const geo=new T.BufferGeometry(),ix=track.roadSurface.geometry.index,indices=[];
  for(let k=-3;k<=3;k++){const row=(pr.roadIndex+k+track.samples)%track.samples;for(let j=0;j<60;j++)indices.push(ix.getX(row*60+j));}
  geo.setAttribute('position',track.roadSurface.geometry.attributes.position);geo.setIndex(indices);road.geometry=geo;
  for(let i=0;i<g.attributes.position.count;i++){
   const p=new T.Vector3().fromBufferAttribute(g.attributes.position,i).applyQuaternion(pr.quat).add(pr.pos);
   origin.set(p.x,track._pts[pr.roadIndex].y+5,p.z);ray.set(origin,down);ray.far=12;const hits=ray.intersectObject(road);
   if(hits.length){assert(p.y>=hits[0].point.y-.006,`${kind} clips ${hits[0].point.y-p.y}, used=${used}`);checkedVertices++;}
  }geo.dispose();
 };
 check();pr.vel.set(80,13,-40);pr.angVel.set(14,7,-16);
 for(let i=0;i<1800&&!pr.asleep;i++){physics.step(pr,1/120);if(i%30===0)check();}
 assert(pr.asleep,`${kind} didn't settle`);check();budgets.push({kind,used,triangles:g.attributes.position.count/3,hull:b.hull.length});
}
// Shared-wind events only wake nearby lightweight objects and respect the cap.
const windy=await initProps(new T.Scene(),track,{seed:'WIND',biomeNameAt:()=> 'beach'});windy.setItemsEnabled(false);
const ball=windy._props.find(p=>p.kind==='beachBall');setWind({strength:2.4});setWindClock(12);
const tan=track._tans[ball.roadIndex],viewer=ball.pos.clone().addScaledVector(tan,40);
for(let i=0;i<120;i++)windy.update(1/120,[{x:viewer.x,z:viewer.z}]);
assert(windy._props.some(p=>p.profile?.wind&&p.windAt>0),'No shared-wind wake');
console.log(JSON.stringify({results,budgets,checkedVertices,sounds,bursts,maxDebris:36}));
const stress=[];
for(const count of [8,64]){
 const kinds=Object.keys(ROAD_PROPS),bodies=[];
 for(let i=0;i<count;i++){
  const kind=kinds[i%kinds.length],b=makeRoadProp(kind),index=Math.floor(i*track.samples/count);
  const pr={kind,profile:b.profile,mesh:b.mesh,pos:track._pts[index].clone(),quat:new T.Quaternion(),vel:new T.Vector3(),angVel:new T.Vector3(),asleep:false,settle:false};physics.prepare(pr,b.hull,index);bodies.push(pr);
 }
 const times=[];
 for(let f=0;f<360;f++){
  if(f%60===0)for(const p of bodies){p.asleep=p.settle=false;p.quiet=0;p.vel.set(25,10,40);p.angVel.set(14,7,-18);}
  const start=performance.now();for(const p of bodies)physics.step(p,1/60);if(f>=60)times.push(performance.now()-start);
 }
 times.sort((a,b)=>a-b);stress.push({forcedActive:count,medianMs:times[times.length>>1],p99Ms:times[Math.floor(times.length*.99)]});
}
console.log(JSON.stringify({stress,note:'Node solver-only, assorted props relaunched every second; excludes renderer'}));
