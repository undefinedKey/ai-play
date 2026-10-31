import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Source PNGs stay byte-for-byte original. Rectangles and ground contacts were
// measured from the real alpha silhouettes, not assumed equal atlas cells.
// [left, top, right, bottom], followed by contact in absolute source pixels.
export const cropPropFrames={
  turnip_untilled:[[20,55,380,310],[198,298]],
  turnip_tilled:[[412,118,764,312],[588,303]],
  turnip_seeded:[[786,118,1144,312],[966,303]],
  turnip_growing:[[1181,23,1523,313],[1352,302]],
  turnip_ready:[[22,323,383,647],[202,642]],
  wheat_untilled:[[413,359,761,640],[588,634]],
  wheat_tilled:[[786,456,1144,649],[966,642]],
  wheat_seeded:[[1168,416,1522,649],[1350,641]],
  wheat_growing:[[28,654,370,991],[198,983]],
  wheat_ready:[[416,640,765,993],[589,985]],
  bench:[[808,691,1185,998],[996,982]],
  ruin_column:[[1258,652,1497,996],[1378,982]],
};
export const effectFrames={
  fire_1:[[40,5,350,360],[194,350]],
  fire_2:[[434,5,744,360],[588,350]],
  fire_3:[[808,5,1118,360],[962,350]],
  fire_4:[[1192,5,1502,360],[1346,350]],
  campfire_ashes:[[41,503,354,676],[197,662]],
  supply_cache_idle:[[421,420,763,683],[592,668]],
  supply_cache_resolved:[[790,366,1125,684],[958,668]],
  wild_garden_idle:[[1149,392,1528,683],[1339,668]],
  wild_garden_resolved:[[16,799,380,999],[198,986]],
  spring_idle:[[400,690,764,1007],[582,989]],
  spring_resolved:[[781,690,1147,1007],[964,989]],
};
const publish=(path,bytes)=>{
  const value=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  if(!existsSync(path)||!readFileSync(path).equals(value))writeFileSync(path,value);
};
function sourceFrame([rect,contact],duration=1000){
  const[x,y,right,bottom]=rect;
  return{x,y,w:right-x,h:bottom-y,duration,anchor:{x:contact[0]-x,y:contact[1]-y}};
}
function definition(image,frame,scale,animations){
  return{image:`/pixel-world/${image}`,width:frame.w,height:frame.h,sheet_width:1536,sheet_height:1024,render_style:'ink',anchor_mode:'source',anchor:{...frame.anchor},native_scale:scale,animations};
}
function atlas(directory,image,specs){
  const frames=Object.fromEntries(Object.entries(specs).map(([id,spec])=>{const frame=sourceFrame(spec);return[id,{frame,anchor:frame.anchor}];}));
  publish(resolve(directory,image.replace('.png','.atlas.json')),JSON.stringify({frames,meta:{image,size:{w:1536,h:1024},source:'original-imagegen-transparent-atlas',render_style:'ink'}},null,2)+'\n');
}

export function applyInkFarmEffects(manifest,root){
  const directory=resolve(root,'public/pixel-world');
  for(const[source,published]of [['crops-props.png','ink_crops_props.png'],['farm-effects.png','ink_farm_effects.png'],['farm-ground.png','ink_farm_ground.png']])publish(resolve(directory,published),readFileSync(resolve(root,'art/ink-world',source)));
  atlas(directory,'ink_crops_props.png',cropPropFrames);atlas(directory,'ink_farm_effects.png',effectFrames);
  const background={image:'/pixel-world/ink_farm_ground.png',width:1536,height:1024,render_style:'ink'};
  manifest.farm_scene=background;
  publish(resolve(directory,'ink_farm_ground.atlas.json'),JSON.stringify({frames:{farm:{frame:{x:0,y:0,w:1536,h:1024},anchor:{x:0,y:0}}},meta:{image:'ink_farm_ground.png',size:{w:1536,h:1024},source:'original-imagegen-farm-background',render_style:'ink'}},null,2)+'\n');
  manifest.crops||={};
  for(const crop of ['turnip','wheat']){
    const animations=Object.fromEntries(['untilled','tilled','seeded','growing','ready'].map(state=>[state,{loop:false,frames:[sourceFrame(cropPropFrames[`${crop}_${state}`])]}]));
    animations.empty=animations.tilled;animations.idle=animations.untilled;
    manifest.crops[crop]=definition('ink_crops_props.png',animations.ready.frames[0],.15,animations);
  }
  manifest.props||={};
  for(const[id,scale]of [['bench',.21],['ruin_column',.23]]){
    const frame=sourceFrame(cropPropFrames[id]);
    manifest.props[id]=definition('ink_crops_props.png',frame,scale,{idle:{loop:false,frames:[frame]}});
  }
  manifest.effects||={};
  const fireFrames=['fire_1','fire_2','fire_3','fire_4'].map(id=>sourceFrame(effectFrames[id],145));
  const burning={loop:true,frames:fireFrames};
  manifest.effects.campfire=definition('ink_farm_effects.png',fireFrames[0],.14,{idle:burning,campfire:burning});
  const ash=sourceFrame(effectFrames.campfire_ashes);
  manifest.effects.campfire_ashes=definition('ink_farm_effects.png',ash,.14,{idle:{loop:false,frames:[ash]}});
  manifest.discoveries||={};
  for(const id of ['supply_cache','wild_garden','spring']){
    const idle=sourceFrame(effectFrames[`${id}_idle`]),resolved=sourceFrame(effectFrames[`${id}_resolved`]);
    manifest.discoveries[id]=definition('ink_farm_effects.png',idle,.15,{idle:{loop:false,frames:[idle]},resolved:{loop:false,frames:[resolved]}});
  }
  return manifest;
}
