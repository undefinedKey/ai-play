import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

// Sampling metadata only: original transparent PNG bytes are never altered.
// Rectangles are measured per object; the generator does not produce equal cells.
export const itemRects={
 wood:[35,57,310,252],ore:[366,50,583,255],turnip:[665,16,903,276],wheat:[996,14,1187,275],turnip_seed:[1286,51,1483,256],
 wheat_seed:[65,283,256,500],turnip_soup:[336,307,595,490],wheat_bread:[635,307,911,493],gold:[974,301,1224,492],berry:[1279,283,1508,503],
 moon_herb:[70,515,288,744],trail_ration:[345,557,591,731],moon_stew:[653,547,913,741],grass:[992,509,1229,747],pine_cone:[1319,530,1489,740],
 torch:[82,733,235,1010],roasted_berry:[318,765,597,983],
};
// Tool gripping points are absolute source coordinates; rows preserve tier identity.
export const toolFrames={
 hoe_1:[[73,7,342,331],[160,203]],watering_can_1:[[443,57,776,315],[510,108]],axe_1:[[848,5,1096,332],[925,200]],pickaxe_1:[[1189,7,1509,332],[1326,209]],
 hoe_2:[[66,336,360,664],[150,540]],watering_can_2:[[432,391,784,662],[515,435]],axe_2:[[848,334,1129,664],[923,542]],pickaxe_2:[[1173,341,1520,665],[1326,542]],
 hoe_3:[[40,666,378,1009],[135,865]],watering_can_3:[[423,721,788,1009],[516,765]],axe_3:[[831,666,1143,1014],[914,876]],pickaxe_3:[[1168,671,1519,1013],[1324,881]],
};
export const equipmentFrames={
 iron_armor:[[51,45,369,369],[210,210],16,'chest'],hunter_bow:[[409,9,749,369],[583,194],28,'hand'],heavy_hammer:[[784,5,1158,373],[899,266],32,'hand'],heavy_armor:[[1167,35,1513,385],[1340,210],18,'chest'],
 leaf:[[108,409,291,636],[150,582],9,'head'],scarf:[[441,403,714,662],[564,461],14,'chest'],ribbon:[[838,404,1081,668],[970,464],11,'head'],star:[[1257,419,1444,618],[1351,521],7,'chest'],
 wooden_sword:[[42,650,363,1005],[128,910],28,'hand'],iron_sword:[[403,660,732,1012],[499,916],29,'hand'],wooden_shield:[[814,681,1113,998],[973,840],18,'hand'],
};
const publish=(path,bytes)=>{const value=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!existsSync(path)||!readFileSync(path).equals(value))writeFileSync(path,value);};
const frame=(rect,point)=>({x:rect[0],y:rect[1],w:rect[2]-rect[0],h:rect[3]-rect[1],duration:1000,anchor:{x:point[0]-rect[0],y:point[1]-rect[1]}});
function definition(image,f,size,slot,body){
 const native_scale=size/Math.max(f.w,f.h);
 const animations=body?Object.fromEntries(Object.entries(body.animations).map(([name,anim])=>[name,{loop:anim.loop,frames:anim.frames.map(p=>({...f,anchor:{...f.anchor},duration:p.duration}))}])):{idle:{loop:false,frames:[f]}};
 return{image:`/pixel-world/ink_${image}.png`,width:f.w,height:f.h,sheet_width:1536,sheet_height:1024,render_style:'ink',anchor_mode:'source',anchor:{...f.anchor},native_scale,...(slot?{attachment_slot:slot}:{}),animations};
}
export function applyInkInventory(manifest,root){
 const directory=resolve(root,'public/pixel-world'),atlases={items:{},tools:{},equipment:{}},body=manifest.characters.wanderer_1;
 for(const name of Object.keys(atlases))publish(resolve(directory,`ink_${name}.png`),readFileSync(resolve(root,`art/ink-world/${name}.png`)));
 for(const[id,rect]of Object.entries(itemRects)){
  const f=frame(rect,[(rect[0]+rect[2])/2,(rect[1]+rect[3])/2]);atlases.items[id]={frame:f,anchor:f.anchor};manifest.items[`item_${id}`]=definition('items',f,28);
 }
 for(const[id,[rect,point]]of Object.entries(toolFrames)){
  const f=frame(rect,point);atlases.tools[id]={frame:f,anchor:f.anchor};manifest.tools[id]=definition('tools',f,id.startsWith('watering_can')?23:30,'hand',body);
  manifest.tool_icons[`${id}_icon`]=definition('tools',frame(rect,[(rect[0]+rect[2])/2,(rect[1]+rect[3])/2]),28);
 }
 for(const[id,[rect,point,size,slot]]of Object.entries(equipmentFrames)){
  const f=frame(rect,point);atlases.equipment[id]={frame:f,anchor:f.anchor};const group=['leaf','scarf','ribbon','star'].includes(id)?'accessories':'equipment';
  manifest[group][id]=definition('equipment',f,size,slot,body);
  if(group==='equipment')manifest.items[`item_${id}`]=definition('equipment',frame(rect,[(rect[0]+rect[2])/2,(rect[1]+rect[3])/2]),28);
 }
 for(const[name,frames]of Object.entries(atlases))publish(resolve(directory,`ink_${name}.atlas.json`),JSON.stringify({frames,meta:{image:`ink_${name}.png`,size:{w:1536,h:1024},source:'original-imagegen-transparent-atlas',render_style:'ink'}},null,2)+'\n');
 return manifest;
}
