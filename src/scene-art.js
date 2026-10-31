import {treePresentation} from './survival-state.js';

const resources=new WeakMap();
const resourceKinds={tree:'pine',ore_vein:'ore',berry_bush:'berries',herb:'herb'};
export function resourceArtwork(assets,node){
  if(!assets)return null;
  let cache=resources.get(assets);if(!cache){cache=new Map();resources.set(assets,cache);}
  const stage=node.kind==='tree'?treePresentation(node):null,key=`${node.kind}:${stage?.stage||''}`;
  if(cache.has(key))return cache.get(key);
  const item={branches:'item_wood',stones:'item_ore',grass:'item_grass'}[node.kind];
  const stageArt=stage&&assets.wilderness?.[`tree_${stage.stage}`];
  const groundArt=item&&assets.wilderness?.[node.kind];
  const base=groundArt||(item?assets.items?.[item]:stageArt||assets.wilderness?.[stage?.art||resourceKinds[node.kind]]);
  const factor=groundArt?1:item?(node.kind==='grass'?1.25:1.1):stageArt?1:stage?.scale||1;
  const result=base?{...base,native_scale:(base.native_scale||1)*factor}:null;
  cache.set(key,result);return result;
}

export function artworkAnchor(definition,fallback=[24,43]){
  const unit=definition?.native_scale||1,anchor=definition?.anchor;
  return anchor&&Number.isFinite(anchor.x)&&Number.isFinite(anchor.y)?[anchor.x*unit,anchor.y*unit]:fallback;
}

export function fireArtwork(assets,lit){
  const source=assets?.effects?.campfire;
  if(lit||!source)return source;
  if(assets.effects.campfire_ashes)return assets.effects.campfire_ashes;
  // Old atlases kept the logs at the bottom of the flame frame. This fallback
  // is measured in native units, so a high-resolution frame is never cut at y38.
  const first=source.animations?.idle?.frames?.[0];if(!first)return null;
  const unit=source.native_scale||1,h=Math.min(first.h,Math.round(10/unit)),top=first.h-h;
  const anchor=first.anchor||source.anchor||{x:first.w/2,y:first.h-5/unit};
  return {...source,anchor:{x:anchor.x,y:anchor.y-top},animations:{idle:{loop:false,frames:[{...first,y:first.y+top,h,anchor:{x:anchor.x,y:anchor.y-top}}]}}};
}
