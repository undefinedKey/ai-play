import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

const actions=['idle','walk','run','attack','hurt','till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat','rest','tired'];
const directions=['south','north','east'];
const poses={idle:[0,0,0,0],walk:[1,0,2,0],run:[3,1,3,2],attack:[4,4,5,0],hurt:[6,6,0,0],till:[4,5,6,6],plant:[6,6,6,0],water:[0,6,6,0],harvest:[6,6,6,0],craft:[6,6,6,0],repair:[4,6,6,0],upgrade:[4,6,6,0],gather:[4,5,6,6],cook:[6,6,6,0],eat:[0,4,4,0],rest:[7,7,7,7],tired:[0,0,0,0]};
const duration=(action,id)=>{
  if(action==='idle')return [700,180,700,140];
  if(action==='attack')return id==='ruins_guardian'?[240,180,90,330]:id==='forest_slime'?[210,120,100,250]:[180,100,140,240];
  if(action==='gather'||action==='till')return [420,160,260,160];
  if(action==='walk')return id==='forest_slime'?[170,90,170,90]:id==='ruins_guardian'?[210,150,210,150]:[170,130,170,130];
  if(action==='run')return id==='forest_slime'?[155,65,155,65]:id==='ruins_guardian'?[150,110,150,110]:[135,85,135,85];
  return Array(4).fill(action==='rest'?500:action==='tired'?340:action==='hurt'?100:150);
};
const oneShot=new Set(['attack','hurt','till','plant','water','harvest','craft','repair','upgrade','cook','eat']);
function publish(path,bytes){const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!existsSync(path)||!readFileSync(path).equals(data))writeFileSync(path,data);}

export function applyInkActors(manifest,root){
  const directory=resolve(root,'public/pixel-world'),source=resolve(root,'art/ink-world');
  const geometry=JSON.parse(readFileSync(resolve(source,'actor-geometry.json'),'utf8'));
  const motion=JSON.parse(readFileSync(resolve(source,'motion-geometry.json'),'utf8'));
  publish(resolve(directory,'ink_actor_preparation.png'),readFileSync(resolve(source,'actor_preparation.png')));
  const preparationFrames={};
  for(const id of['wanderer_3','wanderer_4'])for(const[index,frame]of geometry[id].rows[4].entries())preparationFrames[`${id}_${directions[index]}`]={frame:{x:frame.x,y:frame.y,w:frame.w,h:frame.h},anchor:frame.anchor};
  publish(resolve(directory,'ink_actor_preparation.atlas.json'),JSON.stringify({frames:preparationFrames,meta:{image:'ink_actor_preparation.png',size:{w:1536,h:1024},source:'original-imagegen-transparent-atlas',render_style:'ink'}},null,2)+'\n');
  for(const[id,data]of Object.entries(geometry)){
    const image=`ink_${id}.png`,monster=!id.startsWith('wanderer_'),animations={},atlasFrames={};
    const extra=motion[id],motionImage=`ink_motion_${id}.png`,motionAtlas={};
    if(!monster){
      if(!extra||extra.rows.length!==5)throw new Error(`Missing authored motion supplement: ${id}`);
      publish(resolve(directory,motionImage),readFileSync(resolve(source,`motion-${id}.png`)));
    }
    publish(resolve(directory,image),readFileSync(resolve(source,`${id}.png`)));
    for(const action of monster?actions.slice(0,5):actions){
      for(const[directionIndex,direction]of directions.entries()){
        const times=duration(action,id);
        const sequence=monster&&action==='hurt'?[6,6,0,0]:poses[action];
        const frames=sequence.map((row,index)=>{
          // The supplemental drawings provide actual leg changes and a standing
          // recoil. Never substitute crouching work for damage or chop recovery.
          const supplementRow=monster?null:action==='walk'?(index===1?0:index===3?1:null):action==='run'?([null,0,2,1][index]):action==='hurt'&&index<2?3:['attack','gather','till','repair','upgrade'].includes(action)&&index===3?4:null;
          let sourceFrame=data.rows[row][directionIndex];
          if(!monster){
            if(action==='walk'&&index===2)sourceFrame=data.rows[2][directionIndex];
            if(['gather','till','repair','upgrade'].includes(action))sourceFrame=data.rows[[4,5,0,0][index]][directionIndex];
            if(['gather','till','repair','upgrade'].includes(action)&&index===2)sourceFrame=extra.rows[4][directionIndex];
            if(action==='hurt'&&index>=2)sourceFrame=data.rows[0][directionIndex];
            if(supplementRow!==null)sourceFrame=extra.rows[supplementRow][directionIndex];
          }
          const frame=structuredClone(sourceFrame);frame.duration=times[index];
          // A seated character breathes subtly about the same authored foot.
          // This changes presentation scale only; resting remains AI-selected.
          if(action==='rest')frame.native_scale=(frame.native_scale||data.native_scale)*[1,1.015,1,.99][index];
          if(frame.attachments?.hand&&['attack','gather','till','repair','upgrade'].includes(action))frame.attachments.hand.rotation=action==='attack'?[-.45,-.65,Math.PI*.5,.9][index]:[-.65,Math.PI*.5,.9,.35][index];
          atlasFrames[`${action}_${direction}_${index}`]={frame:{x:frame.x,y:frame.y,w:frame.w,h:frame.h},anchor:frame.anchor,image:frame.image||`/pixel-world/${image}`,native_scale:frame.native_scale||data.native_scale,duration:frame.duration};
          if(frame.image===`/pixel-world/${motionImage}`)motionAtlas[`${action}_${direction}_${index}`]=atlasFrames[`${action}_${direction}_${index}`];
          return frame;
        });
        animations[`${action}_${direction}`]={loop:!oneShot.has(action),frames};
        if(direction==='south')animations[action]=animations[`${action}_${direction}`];
      }
    }
    const first=animations.idle.frames[0];
    const definition={image:`/pixel-world/${image}`,...(!monster?{motion_images:[`/pixel-world/${motionImage}`]}:{}),width:first.w,height:first.h,sheet_width:data.sheet_width,sheet_height:data.sheet_height,render_style:'ink',anchor_mode:'source',anchor:first.anchor,logical_anchor:{x:24,y:43},native_scale:data.native_scale,animations};
    (monster?manifest.monsters:manifest.characters)[id]=definition;
    publish(resolve(directory,`ink_${id}.atlas.json`),JSON.stringify({frames:atlasFrames,meta:{image,size:{w:data.sheet_width,h:data.sheet_height},source:'original-imagegen-transparent-atlas',render_style:'ink',alpha_zero_fraction:data.alpha_zero_fraction}},null,2)+'\n');
    if(!monster)publish(resolve(directory,motionImage.replace('.png','.atlas.json')),JSON.stringify({frames:motionAtlas,meta:{image:motionImage,size:{w:extra.sheet_width,h:extra.sheet_height},source:'original-imagegen-transparent-atlas',render_style:'ink',alpha_zero_fraction:extra.alpha_zero_fraction}},null,2)+'\n');
  }
  return manifest;
}
