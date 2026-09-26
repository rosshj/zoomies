import assert from 'node:assert/strict';
import {KART_PRESETS} from '../src/presets.js';
import {KART_STYLES,KART_LIVERIES,savedKartIndex,savedKartStyle} from '../src/kart-styles.js';
import {catalogEntry,buyUnlock,defaultProfile} from '../src/progress.js';
assert.equal(KART_PRESETS.length,34);assert.equal(KART_STYLES.length,17);
assert.equal(new Set(KART_PRESETS.map(k=>k.name)).size,34);
assert.deepEqual(KART_PRESETS.slice(0,10).map(k=>k.name),['Ember','Lagoon','Clover','Tangerine','Grape','Sunbeam','Teal','Comet','Nova','Prowler']);
for(const [i,k] of KART_PRESETS.entries()){
 assert.ok(KART_STYLES[k.style]);assert.ok(catalogEntry(`kart.${i}`));
 if(i>=10){assert.ok(KART_LIVERIES[k.livery]);const p=defaultProfile();p.treats=1000;assert.ok(buyUnlock(p,`kart.${i}`));assert.ok(p.unlocked.includes(`kart.${i}`));}
}
for(let style=5;style<17;style++){
 const rows=KART_PRESETS.filter(k=>k.style===style);assert.equal(rows.length,2);assert.notEqual(rows[0].livery,rows[1].livery);
}
for(const v of [undefined,1,2]){
 assert.equal(savedKartIndex({v,kart:10},34),34);assert.equal(savedKartStyle({v,customKart:{style:6}}),4);
 for(let i=0;i<10;i++)assert.equal(savedKartIndex({v,kart:i},34),i);
}
assert.equal(savedKartIndex({v:3,kart:10},34),10);
assert.equal(savedKartIndex({v:3,kart:34,kartId:'custom'},40),40);
assert.equal(savedKartStyle({v:3,customKart:{style:6}}),6);
assert.equal(savedKartIndex({kart:-1},34),0);
console.log('34 presets, 17 chassis, three liveries, unchanged original slots/unlocks and versioned custom migration pass');
