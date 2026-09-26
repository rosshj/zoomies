// Stable style ids: the original five and every saved preset retain their slots.
const race=(name,extra={})=>({name,racing:true,snout:1.55,wing:'none',tire:1,...extra});
export const KART_STYLES=[
  {name:'GP',snout:1.55,wing:'big',tire:1},
  {name:'Roadster',snout:1.45,wing:'lip',tire:1.06},
  {name:'Buggy',snout:1.3,wing:'none',tire:1.2,hoop:true},
  {name:'Finned',snout:1.8,wing:'fin',tire:.94},
  {name:'Cage',snout:1.35,wing:'none',tire:1.3,cage:true},
  race('Club Racer',{kind:'club',nose:.48,pod:.30,rail:true}),
  race('Sprint',{kind:'sprint',nose:.92,pod:.5}),
  race('Shifter',{kind:'shifter',nose:.65,pod:.4,radiator:true}),
  race('Endurance',{kind:'endurance',nose:1.03,pod:.54,guard:true,lamps:true}),
  race('Rental Pro',{kind:'rental',nose:.96,pod:.5,guard:true,rubber:true}),
  race('Vintage Racer',{kind:'vintage',nose:.42,pod:.24,rail:true,vintage:true}),
  race('Dirt Oval',{kind:'oval',nose:1.14,pod:.52,oval:true}),
  race('Flat Tracker',{kind:'flat',nose:.46,pod:.28,rail:true,tread:true,tire:1.1}),
  race('Rallycross',{kind:'rally',nose:.86,pod:.48,tread:true,tire:1.1,cockpit:true,fenders:true,lamps:true}),
  race('Crosskart',{kind:'cross',nose:.44,pod:.25,tread:true,tire:1.15,cockpit:true,suspension:true}),
  race('Dune Racer',{kind:'dune',nose:.6,pod:.34,tread:true,tire:1.15,suspension:true,hoopOnly:true}),
  race('Streamliner',{kind:'stream',nose:.64,pod:.46,stream:true}),
];
export const KART_LIVERIES=['Team Stripe','Twin Stripe','Chevron'];
export function savedKartIndex(config,count){
  if(config.kartId==='custom'||((config.v??1)<3&&config.kart===10))return count;
  return Number.isInteger(config.kart)&&config.kart>=0&&config.kart<count+1?config.kart:0;
}
export const savedKartStyle=(config)=>((config.v??1)<3&&config.customKart?.style===6)?4:config.customKart?.style;
