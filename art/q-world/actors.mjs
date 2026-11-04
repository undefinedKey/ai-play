import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Q_ACTOR_ACTIONS, Q_DIRECTIONS, Q_ACTOR_GEOMETRY, qActorPose, qCharacterPixels, qAccessoryPixels, qGearPixels, qMonsterPixels } from '../../src/q-actor-art.js';

const oneShot=new Set(['attack','hurt','till','plant','water','harvest','craft','repair','upgrade','cook','eat']);
export const Q_ACTOR_IDS=Object.freeze(Array.from({length:8},(_,i)=>`wanderer_${i+1}`));
export const Q_MONSTER_IDS=Object.freeze(['forest_slime','forest_boar','ruins_guardian']);
export const Q_EQUIPMENT_IDS=Object.freeze(['wooden_sword','iron_sword','hunter_bow','heavy_hammer','wooden_shield','iron_armor','heavy_armor']);
const timing=action=>action==='idle'?[700,180,700,140]:action==='walk'?[170,130,170,130]:action==='run'?[135,85,135,85]:action==='attack'?[180,100,140,240]:['gather','till','repair','upgrade'].includes(action)?[420,160,260,160]:Array(4).fill(['rest','sleep','sit','read','listen'].includes(action)?500:action==='hurt'?100:150);
async function publish(path,value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);let same=false;try{same=(await readFile(path)).equals(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}if(!same)await writeFile(path,bytes);}
function paint(buffer,width,height,pixels,offsetX,offsetY,id){
  for(const p of pixels){
    if(![p.x,p.y,p.w,p.h].every(Number.isInteger)||p.x<0||p.y<0||p.x+p.w>48||p.y+p.h>48)throw new Error(`${id}: pixel rectangle outside authored cell: ${JSON.stringify(p)}`);
    const hex=p.color.slice(1),rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));
    if(rgb.some(n=>!Number.isFinite(n)))throw new Error(`${id}: invalid opaque pixel color`);
    for(let y=p.y;y<p.y+p.h;y++)for(let x=p.x;x<p.x+p.w;x++){const i=((offsetY+y)*width+offsetX+x)*4;buffer[i]=rgb[0];buffer[i+1]=rgb[1];buffer[i+2]=rgb[2];buffer[i+3]=255;}
  }
}
async function atlas(outputDir,id,draw,actions=Q_ACTOR_ACTIONS){
  const width=48*4,height=48*actions.length*3,raw=Buffer.alloc(width*height*4),animations={},frames={},filename=`q_${id}.png`;
  for(const[actionIndex,action]of actions.entries())for(const[directionIndex,direction]of Q_DIRECTIONS.entries()){
    const row=actionIndex*3+directionIndex,sequence=[];
    for(let index=0;index<4;index++){
      const x=index*48,y=row*48,state={action,direction,frame:index},pose=qActorPose(action,direction,index),pixels=draw(state);
      paint(raw,width,height,pixels,x,y,`${id}/${action}/${direction}/${index}`);
      const frame={x,y,w:48,h:48,duration:timing(action)[index],anchor:{...Q_ACTOR_GEOMETRY.foot},attachments:{hand:{...pose.hand,rotation:0},head:{...pose.head,rotation:0},chest:{x:24,y:32+pose.by,rotation:0}},pose_index:index};
      sequence.push(frame);frames[`${action}_${direction}_${index}`]={frame:{x,y,w:48,h:48},anchor:frame.anchor,duration:frame.duration,attachments:frame.attachments};
    }
    animations[`${action}_${direction}`]={loop:!oneShot.has(action),frames:sequence};if(direction==='south')animations[action]=animations[`${action}_${direction}`];
  }
  await publish(resolve(outputDir,filename),await sharp(raw,{raw:{width,height,channels:4}}).png({compressionLevel:9,palette:true,effort:7}).toBuffer());
  await publish(resolve(outputDir,`q_${id}.atlas.json`),JSON.stringify({frames,meta:{image:filename,size:{w:width,h:height},source:'original-authored-pixel-clusters',render_style:'q-pixel',logical_size:48,foot_anchor:Q_ACTOR_GEOMETRY.foot,directions:Q_DIRECTIONS,west:'mirror-east'}},null,2)+'\n');
  return {image:`/pixel-world/${filename}`,width:48,height:48,sheet_width:width,sheet_height:height,render_style:'q-pixel',anchor_mode:'source',anchor:{...Q_ACTOR_GEOMETRY.foot},logical_anchor:{...Q_ACTOR_GEOMETRY.foot},native_scale:1,overlay_mode:'registered-canvas',animations};
}
async function icon(outputDir,id,draw){
  const raw=Buffer.alloc(48*48*4);paint(raw,48,48,draw({action:'idle',direction:'east',frame:0}),0,0,id);
  const filename=`q_${id}.png`;await publish(resolve(outputDir,filename),await sharp(raw,{raw:{width:48,height:48,channels:4}}).png({compressionLevel:9,palette:true,effort:7}).toBuffer());
  await publish(resolve(outputDir,`q_${id}.atlas.json`),JSON.stringify({frames:{idle:{frame:{x:0,y:0,w:48,h:48},anchor:{x:24,y:43}}},meta:{image:filename,size:{w:48,h:48},source:'original-authored-pixel-clusters',render_style:'q-pixel'}},null,2)+'\n');
  return {image:`/pixel-world/${filename}`,width:48,height:48,sheet_width:48,sheet_height:48,render_style:'q-pixel',native_scale:1,anchor_mode:'source',anchor:{x:24,y:43},animations:{idle:{loop:false,frames:[{x:0,y:0,w:48,h:48,duration:500,anchor:{x:24,y:43}}]}}};
}
/** All IDs remain the saved IDs. No identity, equipment or gameplay is generated. */
export async function buildActorAssets({outputDir}){
  await mkdir(outputDir,{recursive:true});
  const fragment={characters:{},monsters:{},equipment:{},accessories:{},tools:{},tool_icons:{}};
  for(const id of Q_ACTOR_IDS)fragment.characters[id]=await atlas(outputDir,id,state=>qCharacterPixels(id,state));
  for(const id of Q_MONSTER_IDS)fragment.monsters[id]=await atlas(outputDir,id,state=>qMonsterPixels(id,state),Q_ACTOR_ACTIONS.slice(0,5));
  for(const id of Q_EQUIPMENT_IDS)fragment.equipment[id]=await atlas(outputDir,id,state=>qGearPixels(id,state));
  for(const id of ['leaf','scarf','ribbon','star'])fragment.accessories[id]=await atlas(outputDir,`accessory_${id}`,state=>qAccessoryPixels(id,state));
  for(const id of ['hoe','watering_can','axe','pickaxe','fishing_rod'])for(let level=1;level<=3;level++){
    fragment.tools[`${id}_${level}`]=await atlas(outputDir,`${id}_${level}`,state=>qGearPixels(id,state,level));
    fragment.tool_icons[`${id}_${level}_icon`]=await icon(outputDir,`${id}_${level}_icon`,state=>qGearPixels(id,state,level));
  }
  return fragment;
}
