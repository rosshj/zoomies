import assert from 'node:assert/strict';
import {CAT_PRESETS,DEFAULT_CUSTOM_CAT} from '../src/presets.js';
import {CAT_TYPES,catType,savedCatIndex} from '../src/cat-types.js';
import {catalogEntry,defaultProfile,buyUnlock,migrateProfile} from '../src/progress.js';
assert.equal(CAT_PRESETS.length,40);assert.equal(new Set(CAT_PRESETS.map(c=>c.name)).size,40);
assert.equal(new Set(CAT_PRESETS.map(c=>c.accessory)).size,40);
assert.equal(new Set(CAT_PRESETS.slice(14).map(c=>catType(c.type).family)).size,6);
assert.deepEqual(CAT_PRESETS.slice(0,14).map(c=>c.name),['Marmalade','Smokey','Shadow','Snow','Whiskey','Nelson','Pickle','Patches','Pepper','Cocoa','Ziggy','Moo','Misty','Biscuit']);
for(const [i,c] of CAT_PRESETS.entries()){
 assert.ok(catalogEntry(`cat.${i}`));assert.ok(Object.hasOwn(CAT_TYPES,c.type||'classic'));
 if(i>=14){const p=defaultProfile();p.treats=1000;assert.ok(buyUnlock(p,`cat.${i}`));assert.ok(migrateProfile(p).unlocked.includes(`cat.${i}`));}
}
assert.equal(savedCatIndex({cat:14},40),40);
assert.equal(savedCatIndex({cat:13},40),13);
assert.equal(savedCatIndex({cat:14,v:2},40),14);
assert.equal(savedCatIndex({cat:40,v:2,catId:'custom'},50),50);
assert.equal(savedCatIndex({cat:-1},40),0);
assert.equal(catType('garbage'),CAT_TYPES.classic);assert.equal(DEFAULT_CUSTOM_CAT.type,'classic');
console.log('40 unique racers/accessories; 26 new unlocks; six families; legacy/custom save migration pass');
