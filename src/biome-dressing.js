// Explicit habitat choices shared by scenery and feature builders. No renderer
// dependency: the complete roster and boundary rules can be audited in Node.
const profile = (field, town, verge, landmarks, bird, options = {}) => ({
  field, town, verge, landmarks, bird,
  bridges: ['girder', 'arch'], stone: 0x918879, wood: 0x80664c,
  insects: [], ducks: false, goats: false, pigeons: false,
  festive: false, balloons: false, footbridge: false, ...options,
});
export const BIOME_DRESSING = {
  meadow: profile(['tree','cow','cow','sheep','hay','barn','fence','trough','windmill','silo'], ['farmhouse','barn','farmhouse'], ['bush','fence','sign','planter'], ['windmill'], 'swallow', {bridges:['girder','covered','arch'], insects:['butterfly','moth'], ducks:true, festive:true, balloons:true, footbridge:true}),
  forest: profile(['tree','tree','deer','fox','boar','bush','rock','log'], ['cabin','lookout'], ['tree','bush','log','rock'], ['giantTree'], 'raven', {bridges:['covered','arch'], insects:['dragonfly','moth'], ducks:true, footbridge:true}),
  alpine: profile(['tree','goat','hare','rock','cairn'], ['chalet'], ['rock','tree','sign'], ['castle'], 'raven', {stone:0x9aa2ac, goats:true}),
  autumn: profile(['tree','deer','fox','boar','sheep','cow','hay','barn','fence'], ['farmhouse','cabin','barn'], ['bush','log','fence','sign'], ['windmill','castle'], 'swallow', {bridges:['covered','arch'], insects:['butterfly','moth'], ducks:true, festive:true, balloons:true, footbridge:true}),
  desert: profile(['cactus','cactus','rock','vulture','tortoise','adobe'], ['adobe','well'], ['rock','cactus','sign'], ['rockSpire'], 'vulture', {stone:0xb99870, wood:0x917657}),
  mesa: profile(['rock','cactus','vulture','tortoise','rock'], ['adobe','well'], ['rock','cactus','sign'], ['rockSpire'], 'vulture', {stone:0xad7153, wood:0x926c4e}),
  blossom: profile(['tree','tree','deer','hare','bush','apiary','planter'], ['pavilion','farmhouse'], ['planter','bench','tree'], ['giantTree'], 'swallow', {bridges:['covered','arch'], insects:['butterfly','moth'], ducks:true, festive:true, balloons:true, footbridge:true}),
  jungle: profile(['tree','tree','parrot','boar','frog','bush','rock'], ['hut'], ['tree','bush','rock'], ['giantTree'], 'parrot', {bridges:['suspension','covered'], insects:['butterfly','dragonfly','moth'], ducks:true, wood:0x796145, footbridge:true}),
  savanna: profile(['tree','antelope','antelope','rock','vulture','bush','trough'], ['hut'], ['rock','tree','sign'], ['giantTree'], 'vulture', {bridges:['girder','suspension'], stone:0x9f8960, wood:0xa18555, goats:true, insects:['butterfly','moth']}),
  tundra: profile(['tree','goat','hare','rock','cairn'], ['chalet'], ['rock','tree','sign'], ['rockSpire'], 'raven', {stone:0x939ca3, goats:true}),
  city: profile(['planter','bench','hydrant','sign'], ['tower','tower','store'], ['lamp','bench','hydrant','planter','stall','sign'], ['ferris','catStatue'], 'pigeon', {pigeons:true, stone:0x859099}),
  beach: profile(['palm','crab','gull','seal','parasol','rock'], ['hut','lifeguard','parasol'], ['palm','parasol','gull','crab'], ['lighthouse'], 'gull', {bridges:['girder','suspension'], wood:0xa28b59, festive:true, insects:['butterfly']}),
  lavender: profile(['tree','sheep','cow','hare','hay','barn','apiary','fence','windmill'], ['farmhouse','barn'], ['planter','fence','bush','sign'], ['windmill'], 'swallow', {bridges:['covered','arch'], insects:['butterfly','moth'], ducks:true, festive:true, balloons:true, footbridge:true}),
  wetlands: profile(['tree','duck','frog','reed','rock'], ['stiltHut','birdHide'], ['reed','tree','rock'], ['giantTree'], 'heron', {bridges:['girder','covered'], insects:['dragonfly','moth'], ducks:true, wood:0x6e7760, stone:0x697e75, footbridge:true}),
  volcanic: profile(['basalt','basalt','vulture','rock','cairn'], ['ruin'], ['basalt','rock','vulture','sign'], ['rockSpire'], 'vulture', {stone:0x655d6c, wood:0x605b58}),
};
export function dressingFor(name) {
  const p = BIOME_DRESSING[name];
  if (!p) throw new Error(`Missing biome dressing: ${name}`);
  return p;
}
export function allowsDressing(name, kind) {
  const p = dressingFor(name);
  return p.field.includes(kind) || p.town.includes(kind) || p.verge.includes(kind) || p.landmarks.includes(kind);
}
// Test the full footprint/roaming envelope at generation time. Sampling the
// actual terrain biome also handles the elevation-based alpine boundary.
export function habitatFits(nameAt, x, z, accepts, radius = 0) {
  if (!accepts(nameAt(x, z))) return false;
  for (let i = 0; radius > 0 && i < 12; i++) {
    const a = i * Math.PI / 6;
    if (!accepts(nameAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius))) return false;
  }
  return true;
}
