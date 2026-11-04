import { WARDROBE_DYES } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';

const ink = '#30394b', cream = '#fff0c8', buckle = '#e6bc60';
const shades = {
  natural: ['#d6b782', '#f1d9a5', '#a58251'], leaf: ['#78a85c', '#b7d68a', '#4c783f'],
  sky: ['#69a9cf', '#b4ddec', '#447695'], rose: ['#d97b8c', '#f4b8bf', '#a2526b'],
  ochre: ['#dda64f', '#f6d68b', '#a16d37'],
};
export const WARDROBE_PIXEL_DYES = Object.freeze(Object.fromEntries(WARDROBE_DYES.map(dye => [dye.id, Object.freeze(shades[dye.id])])));
function drawing() { const pixels=[]; return { pixels, r(x,y,w,h,color,part='wardrobe') { if(w>0&&h>0)pixels.push({x,y,w,h,color,part}); } }; }
const rotate = pixels => pixels.map(p => ({ ...p, x:48-p.x-p.w, y:48-p.y-p.h }));
const translate = (pixels,x,y) => pixels.map(p => ({ ...p,x:p.x+x,y:p.y+y }));

export function wardrobeForegroundPixels(identity, pose, bodyPixels) {
  if(pose.action==='sleep')return [];
  const hand=pose.hand;
  return [
    {x:hand.x-2,y:hand.y,w:5,h:4,color:identity.outline,part:'hand-front'},
    {x:hand.x-1,y:hand.y,w:3,h:3,color:identity.skin,part:'hand-front'},
    ...bodyPixels.filter(pixel=>['book','pen'].includes(pixel.part)),
  ];
}

/** Worn objects only, registered to an actual body pose; no role/identity choices. */
export function wardrobeGarmentPixels(id,colorId,pose) {
  const s=pose,d=drawing(),r=d.r,colors=shades[colorId];
  if(!colors)return [];
  const [color,light,shade]=colors,b=s.by||0,side=s.direction==='east',back=s.direction==='north';
  const box=(x,y,w,h,fill,part='wardrobe')=>{r(x,y,w,h,ink,part);r(x+1,y+1,w-2,h-2,fill,part);};
  if(s.action==='sleep') {
    if(['cloth_satchel','travel_pack'].includes(id))return [];
    if(s.direction!=='east')return s.direction==='north'?rotate(wardrobeGarmentPixels(id,colorId,{...s,action:'rest',direction:'south',sleep:false,by:5})):wardrobeGarmentPixels(id,colorId,{...s,action:'rest',direction:'south',sleep:false,by:5});
    if(['soft_cap','straw_hat'].includes(id))return translate(wardrobeGarmentPixels(id,colorId,{...s,action:'rest',direction:'east',sleep:false,by:5}),-8,9);
    r(17,35,15,6,color,'wardrobe-outfit');r(18,35,12,2,light,'wardrobe-outfit');
    if(id==='garden_apron'){r(25,35,3,6,shade,'wardrobe-outfit');r(22,38,5,2,cream,'wardrobe-outfit');}
    else if(id==='traveler_coat'){r(20,36,10,1,shade,'wardrobe-outfit');r(28,36,2,4,buckle,'wardrobe-outfit');}
    return d.pixels;
  }
  if(id==='linen_shirt'||id==='garden_apron'||id==='traveler_coat') {
    const part='wardrobe-outfit';
    box(17,28+b,14,10,id==='garden_apron'?cream:color,part);r(19,29+b,3,7,light,part);
    if(id==='linen_shirt'){r(21,28+b,3,2,cream,part);r(27,28+b,3,2,cream,part);if(!back)r(25,31+b,1,5,shade,part);r(18,36+b,12,1,shade,part);}
    if(id==='garden_apron'){r(21,28+b,2,7,color,part);r(27,28+b,2,7,color,part);r(19,33+b,11,5,color,part);r(21,34+b,6,3,shade,part);r(22,34+b,4,1,light,part);if(back){r(23,30+b,4,3,light,part);r(18,33+b,13,2,color,part);}}
    if(id==='traveler_coat'){box(15,35+b,18,5,color,part);r(16,36+b,6,2,light,part);r(24,29+b,2,10,shade,part);if(!back){r(20,28+b,4,4,light,part);r(27,28+b,3,4,light,part);r(25,32+b,2,2,buckle,part);}else r(18,30+b,12,2,shade,part);}
    if(!s.seated)for(const hand of [s.farHand,s.hand])if(hand){r(hand.x-1,hand.y-5,3,5,id==='garden_apron'?cream:color,part);r(hand.x-1,hand.y-5,1,4,light,part);}
  } else if(id==='soft_cap') {
    const part='wardrobe-head';box(13,3+b,20,9,color,part);r(16,2+b,14,3,ink,part);r(17,3+b,12,2,light,part);r(14,10+b,18,3,shade,part);
    if(side){r(30,10+b,7,3,ink,part);r(31,10+b,5,2,light,part);}else{r(12,11+b,23,3,ink,part);r(13,11+b,21,2,light,part);}
    r(back?18:26,6+b,3,3,cream,part);
  } else if(id==='straw_hat') {
    const part='wardrobe-head';box(14,4+b,18,9,color,part);r(17,3+b,12,3,light,part);r(15,10+b,16,2,shade,part);box(9,12+b,29,4,color,part);r(11,13+b,25,1,light,part);r(back?28:15,9+b,3,3,buckle,part);
  } else if(id==='cloth_satchel') {
    const part='wardrobe-back';const x=side?12:back?25:28;
    r(side?15:19,29+b,2,8,shade,part);r(side?16:21,30+b,2,7,light,part);box(x,33+b,9,9,color,part);r(x+1,34+b,7,3,light,part);r(x+4,37+b,2,2,buckle,part);
  } else if(id==='travel_pack') {
    const part='wardrobe-back';const x=side?9:back?16:29,w=back?16:9;
    box(x,28+b,w,14,color,part);r(x+2,29+b,w-4,4,light,part);r(x+1,34+b,w-2,2,shade,part);r(x+Math.floor(w/2),33+b,2,3,buckle,part);
    if(!back){r(side?20:18,28+b,2,9,shade,part);r(side?21:19,28+b,1,8,light,part);}
  }
  return d.pixels;
}

export function wardrobeHairPixels(style,identity,pose) {
  if(!['short','bob','ponytail'].includes(style))return [];
  const s=pose;
  if(s.action==='sleep') {
    const pixels=wardrobeHairPixels(style,identity,{...s,action:'rest',direction:s.direction==='east'?'east':'south',by:5});
    return s.direction==='north'?rotate(pixels):s.direction==='east'?translate(pixels,-8,9):pixels;
  }
  const d=drawing(),r=d.r,b=s.by||0,p=identity,north=s.direction==='north',side=s.direction==='east',part='wardrobe-hair';
  r(14,8+b,19,7,p.hair,part);r(16,7+b,15,3,p.hair,part);r(16,9+b,11,2,p.hairLight,part);
  if(north){r(13,12+b,21,11,p.hair,part);r(16,23+b,15,3,p.hair,part);r(15,13+b,3,8,p.hairLight,part);r(27,19+b,3,5,p.hairLight,part);}
  else{r(13,12+b,6,10,p.hair,part);r(18,13+b,4,4,p.hair,part);r(27,13+b,5,2,p.hair,part);r(14,13+b,2,6,p.hairLight,part);if(!side)r(31,14+b,3,9,p.hair,part);}
  if(style==='short'){r(14,5+b,5,5,p.hair,part);r(19,4+b,8,6,p.hair,part);r(27,6+b,5,5,p.hair,part);r(20,5+b,5,2,p.hairLight,part);}
  if(style==='bob'){r(11,11+b,4,15,p.hair,part);r(13,23+b,5,4,p.hair,part);if(!side||north){r(31,12+b,4,14,p.hair,part);r(28,24+b,5,3,p.hair,part);}r(12,14+b,1,8,p.hairLight,part);}
  if(style==='ponytail'){const x=north?28:9;r(x,11+b,6,4,ink,part);r(x,15+b,5,10,p.hair,part);r(x-1,24+b,5,5,p.hair,part);r(x+1,16+b,2,8,p.hairLight,part);r(x,13+b,5,2,buckle,part);}
  return d.pixels;
}
