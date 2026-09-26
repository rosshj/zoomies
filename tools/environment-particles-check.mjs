import assert from 'node:assert/strict';
import {ENVIRONMENT_PROFILES,ENVIRONMENT_LIMITS,emissionCount,looseSurface} from '../src/environment-particles.js';
import {BIOME_DRESSING} from '../src/biome-dressing.js';
import {reservoirAdd,wakeStrength} from '../src/environment-cover.js';
import {makeRng} from '../src/rng.js';
assert.deepEqual(Object.keys(ENVIRONMENT_PROFILES).sort(),Object.keys(BIOME_DRESSING).sort());
for(const spec of Object.values(ENVIRONMENT_PROFILES)){
 assert(spec.tile>=0&&spec.tile<7&&spec.colors.length>=3&&spec.size>0);
 assert(spec.density>0&&spec.density<=1&&spec.lift<=1);
}
const emitted=[];
for(const hz of [30,60,120]){
 const state={};let n=0;for(let f=0;f<hz*10;f++)n+=emissionCount(state,'wake',7.3,1/hz);
 assert.equal(n,73);emitted.push({hz,emitted:n});
}
assert(emissionCount({},'wake',16,30)<=2,'Background resume emits a backlog');
assert.equal(wakeStrength({speed:0}),0);assert.equal(wakeStrength({speed:90,airborne:true}),0);
assert(wakeStrength({speed:5})<wakeStrength({speed:40}));
assert(wakeStrength({speed:40,drifting:true})>wakeStrength({speed:40}));
for(const biome of Object.keys(ENVIRONMENT_PROFILES)){
 const center=looseSurface(biome,100,20,0,12,200),edge=looseSurface(biome,100,20,11.5,12,200);
 assert(edge>center,`${biome} should accumulate cover at the edge`);
 for(let l=-15;l<=15;l+=.5){const v=looseSurface(biome,100,20,l,12,200,true);assert(v>=0&&v<=1);}
}
const choose=()=>{const list=[],rng=makeRng('coverage');for(let i=0;i<10000;i++)reservoirAdd(list,i,i+1,1900,rng);return list;};
const list=choose();assert.deepEqual(list,choose());const bins=Array(10).fill(0);list.forEach(i=>bins[Math.floor(i/1000)]++);
assert(bins.every(n=>n>120&&n<260),'Budget biased toward one part of the lap');
console.log(JSON.stringify({biomes:Object.keys(ENVIRONMENT_PROFILES).length,emitted,reservoirBins:bins,limits:ENVIRONMENT_LIMITS,checks:'frame-rate independence, resume cap, grounded/speed/sliding wake, surface cover, deterministic full-lap sampling'}));
