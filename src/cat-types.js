// Shared, pure-data morphology recipes. All types retain the same rig and
// accessory anchors; changes are baked only while constructing a model.
const families = {
  classic: { cheek:1, jaw:1, belly:1, tail:1, plume:1 },
  longhair: { cheek:1.16, jaw:1.08, belly:1.04, tail:1, plume:1.7, ruff:1 },
  plush: { cheek:1.20, jaw:1.12, belly:1.06, tail:.85, plume:1.25 },
  masked: { cheek:1.08, jaw:1.03, belly:1, tail:1, plume:1.4, ruff:.6 },
  sleek: { cheek:.83, jaw:.91, belly:.91, tail:1.02, plume:.82 },
  distinctive: { cheek:1.10, jaw:1.05, belly:1.02, tail:.85, plume:1.1 },
  athletic: { cheek:.92, jaw:.97, belly:.96, tail:1, plume:1 },
};
const type=(label,family,extra={})=>({label,family,ear:'classic',...families[family],...extra});
export const CAT_TYPES = {
  classic:type('Classic','classic'),
  maine:type('Maine Coon','longhair',{cheek:1.2,jaw:1.15}),
  forest:type('Norwegian Forest','longhair',{ruff:1.2,cheek:1.10,plume:1.85}),
  persian:type('Persian','longhair',{cheek:1.28,jaw:1.16,ear:'round',tail:.8,plume:1.8}),
  angora:type('Turkish Angora','longhair',{cheek:1.06,belly:.95,plume:1.65,ruff:.65}),
  somali:type('Somali','longhair',{cheek:1.08,belly:.96,plume:1.95,eye:0xdab243}),
  british:type('British Shorthair','plush',{ear:'round',eye:0xe6a139}),
  exotic:type('Exotic Shorthair','plush',{cheek:1.29,jaw:1.17,ear:'round',tail:.72}),
  chartreux:type('Chartreux','plush',{cheek:1.14,eye:0xf1a52d,tail:.95}),
  selkirk:type('Selkirk Rex','plush',{curl:true,cheek:1.23,plume:1.6}),
  ragdoll:type('Ragdoll','masked',{cheek:1.15,eye:0x609bdf,plume:1.7}),
  birman:type('Birman','masked',{eye:0x708fd7,plume:1.45}),
  van:type('Turkish Van','masked',{cheek:1.12,plume:1.55,eye:0xe8b65d}),
  khaomanee:type('Khao Manee','masked',{ruff:0,cheek:1.02,plume:1,eye:0x69b8e7,eyeR:0xe8b847}),
  sphynx:type('Sphynx','sleek',{ear:'wide',folds:true,eye:0xb6d884,plume:.7}),
  devon:type('Devon Rex','sleek',{ear:'wide',curl:true,cheek:.93,eye:0x91c680}),
  cornish:type('Cornish Rex','sleek',{ear:'wide',curl:true,cheek:.8,belly:.87,plume:.72}),
  abyssinian:type('Abyssinian','sleek',{ear:'wide',eye:0xc4cc64,cheek:.91}),
  fold:type('Scottish Fold','distinctive',{ear:'fold',cheek:1.23,eye:0xe6b84d}),
  curl:type('American Curl','distinctive',{ear:'curl',plume:1.4,ruff:.45}),
  manx:type('Manx','distinctive',{tail:0,belly:1.07,cheek:1.15}),
  bobtail:type('Japanese Bobtail','distinctive',{tail:.26,plume:1.5,cheek:1.02}),
  bombay:type('Bombay','athletic',{cheek:1.09,eye:0xe9a52e}),
  ocicat:type('Ocicat','athletic',{ear:'wide',eye:0xbed865}),
  mau:type('Egyptian Mau','athletic',{cheek:.94,eye:0xa4d279}),
  toyger:type('Toyger','athletic',{jaw:1.10,cheek:1.08,eye:0xdac266}),
  snowbengal:type('Snow Bengal','athletic',{eye:0x76bada,plume:1.1}),
};
export const CAT_TYPE_IDS=Object.keys(CAT_TYPES);
export const catType = id => Object.hasOwn(CAT_TYPES,id) ? CAT_TYPES[id] : CAT_TYPES.classic;

// Versionless saves used index 14 for Custom Cat. New saves carry a version
// and the custom sentinel, so later roster additions cannot steal the slot.
export function savedCatIndex(config, count) {
  if(config.catId==='custom'||((config.v??1)<2&&config.cat===14))return count;
  return Number.isInteger(config.cat)&&config.cat>=0&&config.cat<count+1?config.cat:0;
}
