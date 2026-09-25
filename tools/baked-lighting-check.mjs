import assert from 'node:assert/strict';
import * as THREE from 'three';
import {setSeed,rand} from '../src/rng.js';
import { bakeScenery, bakeGroundContacts, bakeStats, bakeBuildingShelter } from '../src/baked-lighting.js';

const material=()=>new THREE.MeshStandardMaterial({color:0xe4c798});
const sheet=(size,y)=>new THREE.Mesh(new THREE.PlaneGeometry(size,size,2,2).rotateX(-Math.PI/2).translate(0,y,0),material());
const sample=roof=>{const g=new THREE.Group();g.add(sheet(2,0));if(roof)g.add(sheet(6,.45));return g;};
const exposed=bakeScenery(sample(false),{ground:null});
assert(exposed.children[0].geometry.attributes.color.array.every(v=>v===1),'Exposed flat surface must stay bright');
const covered=sample(true),positions=covered.children.map(o=>Array.from(o.geometry.attributes.position.array));
const indices=covered.children.map(o=>Array.from(o.geometry.index.array));
setSeed('bake-test');const expected=rand();setSeed('bake-test');
bakeScenery(covered,{ground:null});assert.equal(rand(),expected,'Bake must preserve world RNG');
const colors=covered.children[0].geometry.attributes.color;
assert(colors.getX(4)<.9,'Nearby roof should shade the sheltered centre');
assert(covered.children[1].geometry.attributes.color.getX(4)>.99,'Roof top must stay bright');
covered.children.forEach((o,i)=>{assert.deepEqual(Array.from(o.geometry.attributes.position.array),positions[i]);assert.deepEqual(Array.from(o.geometry.index.array),indices[i]);});
assert(colors.array.every(v=>Number.isFinite(v)&&v>=.68&&v<=1),'Bounded finite shading');
const once=Array.from(colors.array);bakeScenery(covered,{ground:null});assert.deepEqual(Array.from(colors.array),once,'No repeated darkening');
const hits=bakeStats.hits,cached=bakeScenery(sample(true),{ground:null});
assert(bakeStats.hits>hits);assert.deepEqual(Array.from(cached.children[0].geometry.attributes.color.array),once,'Cached result is deterministic');
const moving=sample(true);moving.children[1].userData.keepLive=true;
bakeScenery(moving,{ground:null});assert(moving.children[0].geometry.attributes.color.array.every(v=>v===1),'Moving parts must not leave frozen occlusion');

const wall=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),material()),building=new THREE.Group();building.add(wall);
bakeBuildingShelter(building,[{x:0,z:0,y:1,rx:1.2,rz:1.2,reach:.5}],-10);
const wc=wall.geometry.attributes.color,wn=wall.geometry.attributes.normal,wp=wall.geometry.attributes.position;
let shadedSides=0;
for(let i=0;i<wc.count;i++) {
 if(wn.getY(i)>.9)assert.equal(wc.getX(i),1,'Analytic ledge preserves bright top faces');
 if(Math.abs(wn.getY(i))<.1&&wp.getY(i)>.9&&wc.getX(i)<.9)shadedSides++;
}
assert(shadedSides>0,'Analytic ledge shades wall immediately below it');

function ground(footprints) {
  const scene=new THREE.Scene(),geo=new THREE.PlaneGeometry(10,10,10,10).rotateX(-Math.PI/2);
  geo.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count*3).fill(1),3));
  const a=new THREE.Mesh(geo),b=new THREE.Mesh(geo);a.userData.terrainTile=b.userData.terrainTile=true;scene.add(a,b);
  bakeGroundContacts(scene,footprints);return {scene,geo,a,b};
}
const footprint={x:0,z:0,y:0,rx:1,rz:1,yaw:0};
const first=ground([footprint]),twice=ground([footprint,footprint]);
assert.deepEqual(first.geo.attributes.color.array,twice.geo.attributes.color.array,'Overlapping contacts use max, not cumulative blackening');
assert.equal(first.a.geometry.attributes.color,first.b.geometry.attributes.color,'Tiles keep shared buffers');
assert(first.geo.attributes.color.getX(60)<.9);assert.equal(first.geo.attributes.color.getX(0),1,'Distant ground is unchanged');
assert(ground([{...footprint,y:20}]).geo.attributes.color.array.every(v=>v===1),'Elevated objects cannot shade unrelated ground');
console.log(JSON.stringify({checks:'shelter, exposed faces, topology, RNG, bounds, idempotence, cache, moving parts, shared terrain, overlapping contacts, height rejection',stats:bakeStats},null,2));
