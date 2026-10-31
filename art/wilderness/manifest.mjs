import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Original imagegen assets stay intact; atlas frames sample them without editing.
// Source rectangles were checked against their actual alpha/contact bounds.
export function applyWildernessAssets(manifest,root) {
  const directory=resolve(root,'public/pixel-world');
  for(const name of ['ground_ink','props_ink'])copyFileSync(resolve(root,`art/wilderness/${name}.png`),resolve(directory,`${name}.png`));
  const frames={},wilderness={};
  for(const [id,column,row] of [['pine',0,0],['oak',1,0],['ore',2,0],['berries',0,1],['stump',1,1],['herb',2,1]]){
    const frame={x:column*512,y:row?600:0,w:512,h:row?424:600,duration:1000},anchor={x:256,y:row?374:570};
    frames[id]={frame,anchor};
    wilderness[id]={image:'/pixel-world/props_ink.png',width:frame.w,height:frame.h,sheet_width:1536,sheet_height:1024,anchor,native_scale:.22,animations:{idle:{loop:false,frames:[frame]}}};
  }
  writeFileSync(resolve(directory,'props_ink.atlas.json'),JSON.stringify({frames,meta:{image:'props_ink.png',size:{w:1536,h:1024},source:'original-imagegen-transparent-atlas'}},null,2)+'\n');
  writeFileSync(resolve(directory,'ground_ink.atlas.json'),JSON.stringify({frames:{world:{frame:{x:0,y:0,w:1536,h:1024},anchor:{x:0,y:0}}},meta:{image:'ground_ink.png',size:{w:1536,h:1024},source:'original-imagegen-walkable-ground'}},null,2)+'\n');
  const ground={image:'/pixel-world/ground_ink.png',width:1536,height:1024};
  Object.assign(manifest,{release:'0.20.0',map:{width:48,height:32},scene:{...ground},scenes:{plaza:{...ground},adventure:{...ground}},wilderness});
  return manifest;
}
