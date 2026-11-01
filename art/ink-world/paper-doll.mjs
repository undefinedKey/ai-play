import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Source rectangles and joint centres measured in the untouched imagegen PNGs.
// Source limb axes are corrected geometrically, never by repainting the image.
// [bounds x,y,w,h], proximal pivot, distal pivot (or physical source size).
export const FEIYU_PART_GEOMETRY={
 east:{
  head:[[54,25,455,502],[280,455],430],
  torso:[[563,183,264,352],[697,460],248],
  hip:[[929,308,238,189],[1052,400],238],
  upper_arm:[[162,588,143,273],[239,616],[250,846]],
  forearm:[[586,612,116,248],[621,641],[646,845]],
  hand:[[989,670,109,171],[1041,686],149],
  thigh:[[173,902,138,294],[198,945],[236,1161]],
  shin:[[591,932,100,257],[641,951],[646,1173]],
  foot:[[948,1002,223,180],[1007,1092],90],
 },
 south:{
  head:[[19,26,467,443],[248,445],419],
  torso:[[545,125,280,335],[686,398],258],
  hip:[[956,236,250,198],[1082,344],250],
  upper_arm:[[169,529,124,283],[249,561],[230,793]],
  forearm:[[573,553,116,255],[629,575],[627,789]],
  hand:[[972,604,124,195],[1034,618],180],
  thigh:[[156,879,158,312],[235,898],[232,1174]],
  shin:[[566,879,121,312],[627,896],[627,1173]],
  foot:[[955,949,159,248],[1037,1073],124],
 },
 north:{
  head:[[40,19,438,463],[250,439],420],
  torso:[[534,147,301,344],[684,423],260],
  hip:[[957,279,229,197],[1070,383],229],
  upper_arm:[[154,554,153,297],[260,585],[213,823]],
  forearm:[[610,594,115,249],[661,620],[672,824]],
  hand:[[997,650,105,157],[1047,673],133],
  thigh:[[169,892,143,321],[244,938],[241,1198]],
  shin:[[608,928,106,264],[662,945],[663,1176]],
  foot:[[978,975,155,240],[1057,1095],120],
 },
};
export const FEIYU_RIG_DIMENSIONS={hipHeight:21.8,hipWidth:3.2,shoulderWidth:5.3,torso:12,head:20,upperArm:7,forearm:6,hand:3,thigh:10,shin:10,sole:3};
const segmentDimensions={head:'head',torso:'torso',upper_arm:'upperArm',forearm:'forearm',hand:'hand',thigh:'thigh',shin:'shin',foot:'sole'};
const publish=(path,bytes)=>{const value=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!existsSync(path)||!readFileSync(path).equals(value))writeFileSync(path,value);};

export function applyFeiyuPaperDoll(manifest,root){
 const directory=resolve(root,'public/pixel-world'),directions={};
 for(const [direction,specs] of Object.entries(FEIYU_PART_GEOMETRY)){
  const image=`ink_feiyu_parts_${direction}.png`,frames={},parts={};
  publish(resolve(directory,image),readFileSync(resolve(root,`art/ink-world/feiyu_parts_${direction}.png`)));
  for(const [id,[bounds,pivot,measure]] of Object.entries(specs)){
   const [x,y,w,h]=bounds,anchor={x:pivot[0]-x,y:pivot[1]-y},frame={x,y,w,h,duration:1000};
   const isBone=Array.isArray(measure),sourceLength=isBone?Math.hypot(measure[0]-pivot[0],measure[1]-pivot[1]):measure;
   const worldLength=id==='hip'?10:FEIYU_RIG_DIMENSIONS[segmentDimensions[id]];
   const definition={image:`/pixel-world/${image}`,width:w,height:h,sheet_width:1254,sheet_height:1254,render_style:'ink',anchor_mode:'source',anchor,native_scale:worldLength/sourceLength,rest_rotation:isBone?Math.atan2(measure[0]-pivot[0],measure[1]-pivot[1]):0,animations:{idle:{loop:false,frames:[frame]}}};
   frames[id]={frame,anchor,...(isBone?{distal:{x:measure[0]-x,y:measure[1]-y}}:{})};
   if(['head','torso','hip'].includes(id))parts[id]=definition;
   else for(const side of ['l','r'])parts[`${id}_${side}`]=definition;
  }
  publish(resolve(directory,image.replace('.png','.atlas.json')),JSON.stringify({frames,meta:{image,size:{w:1254,h:1254},source:'original-imagegen-transparent-parts',render_style:'ink'}},null,2)+'\n');
  directions[direction]={parts};
 }
 manifest.paper_dolls={feiyu_v1:{enabled:true,eligible_agent_ids:['agent_8afc5902-688e-42b6-953c-0544d0be6bd5'],dimensions:FEIYU_RIG_DIMENSIONS,attachment_offsets:{head:{x:0,y:-15},chest:{x:0,y:-6.6},hand:{x:0,y:1.4}},directions}};
 return manifest;
}
