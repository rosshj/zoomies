// Adversarial tiny fixtures: a hillside between road samples, stacked decks,
// and a full mountain skirt wider than the old nominal cone radius.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clearTerrainGrid, clearMountainPosition, mountainClearance } from '../src/terrain-clearance.js';
const terrain=new THREE.PlaneGeometry(40,40,4,4).rotateX(-Math.PI/2).attributes.position;
for(let i=0;i<terrain.count;i++)terrain.setY(i,30);
const road=new THREE.Float32BufferAttribute([
  -9,4,-15, -7,4,-15, -9,6,15, -7,6,15,
],3);
clearTerrainGrid(terrain,4,40,road,2);
// This narrow strip crossing the cells has NO grid vertices on the tarmac.
// Every touched cell must still have all four corners under its lowest road.
for(let z=0;z<5;z++)for(const x of [1,2])assert.ok(terrain.getY(z*5+x)<=3.651);
assert.equal(terrain.getY(0),30,'far terrain remains procedural, not flattened');
const raised=new THREE.Float32BufferAttribute(Array.from(road.array,(v,i)=>i%3===1?v+25:v),3);
clearTerrainGrid(terrain,4,40,raised,2);
assert.ok(terrain.getY(6)<=3.651,'a high crossing cannot raise terrain over a low road');
const track=[{x:-50,z:0},{x:50,z:0},{x:50,z:80},{x:-50,z:80}];
const pos=clearMountainPosition(0,18,25,track,15,100);
assert.ok(pos.moved);assert.ok(mountainClearance(pos.x,pos.z,25,track,15)>=8);
assert.deepEqual(pos,clearMountainPosition(0,18,25,track,15,100),'relocation is deterministic');
const safe=clearMountainPosition(0,180,25,track,15,100);assert.equal(safe.moved,false);
console.log('Terrain-cell, stacked-road and full-skirt clearance fixtures pass.');
