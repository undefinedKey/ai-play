import {animationFrame} from './pixel-state.js';
import {PAPER_DOLL_PARTS} from './paper-doll-rig.js';

export {PAPER_DOLL_PARTS};
const prepared=new WeakMap();
const point=value=>value&&Number.isFinite(value.x)&&Number.isFinite(value.y);
const finite=value=>Number.isFinite(value);

function prepareRig(rig){
  if(!rig||typeof rig!=='object')return null;
  if(prepared.has(rig))return prepared.get(rig);
  const directions={};let valid=true;
  for(const facing of ['south','north','east']){
    const parts=rig.directions?.[facing]?.parts;
    if(!parts||PAPER_DOLL_PARTS.some(id=>!parts[id])){valid=false;break;}
    const result={};
    for(const [id,source] of Object.entries(parts)){
      const definition={image:rig.image,sheet_width:rig.sheet_width,sheet_height:rig.sheet_height,native_scale:rig.native_scale,...source,logical_anchor:{x:24,y:43},render_style:'ink',anchor_mode:'source'};
      const frame=animationFrame(definition,'idle',0,false,facing);
      const scale=frame?.native_scale??definition.native_scale,anchor=frame?.anchor||definition.anchor;
      if(!frame||!point(anchor)||!finite(scale)||scale<=0||!(frame.w>0)||!(frame.h>0)||typeof (frame.image||definition.image)!=='string'){
        if(PAPER_DOLL_PARTS.includes(id)){valid=false;break;}continue;
      }
      result[id]={definition,frame};
    }
    if(!valid)break;
    directions[facing]={...rig.directions[facing],parts:result};
  }
  const value=valid?{...rig,directions}:null;
  prepared.set(rig,value);return value;
}

/** Eligibility belongs to the published asset configuration, never a display
 * name, sprite id, query flag or actor-supplied appearance property. Tests can
 * explicitly replace this manifest in their isolated HTTP fixture. */
export function selectPaperDoll(assets,agent){
  if(typeof agent?.agent_id!=='string')return null;
  for(const [id,configuration] of Object.entries(assets?.paper_dolls||{})){
    if(configuration?.enabled===false||!Array.isArray(configuration?.eligible_agent_ids)||!configuration.eligible_agent_ids.includes(agent.agent_id))continue;
    const rig=prepareRig(configuration);if(rig)return {id,rig};
  }
  return null;
}

export function paperDollImages(rig){
  return [...new Set(Object.values(rig?.directions||{}).flatMap(direction=>Object.values(direction.parts).map(({definition,frame})=>frame.image||definition.image)))];
}

const pose=value=>({x:value.x,y:value.y,rotation:value.rotation||0,scaleX:value.scaleX||1,scaleY:value.scaleY||1});
/** Every layer is positioned around the same authoritative world foot. A bone
 * pose is already global; do not apply the old whole-body transform again. */
export function paperDollLayers(rig,sample,assets,agent,{facing='south',tool,toolLevel=1,handsBusy=false,portrait=false}={}){
  const direction=rig?.directions?.[facing==='west'?'east':facing];
  if(!direction||!sample?.parts)return [];
  const bodyImage=direction.parts.torso.frame.image||direction.parts.torso.definition.image;
  const layers=[],equipment=agent.life?.equipment||{};
  for(const [id,{definition,frame}] of Object.entries(direction.parts)){
    const bone=sample.parts[definition.pose_from||id];
    if(!point(bone)||definition.covered_by_armor&&equipment.armor)continue;
    const renderedPose=pose(bone),rest=finite(definition.rest_rotation)?definition.rest_rotation:0;
    // Authored limb axes can lean inside their transparent crop. Correct only
    // that source axis; bone joints and attached equipment stay in rig space.
    // Local source-axis correction precedes projected bone scale. Combining
    // these two rotations would scale oblique source limbs along the wrong axis.
    layers.push({key:id,part:id,definition,frame,pose:renderedPose,sourceRotation:rest*(facing==='west'?-1:1),layer:bone.layer||0,className:'paper-doll-part pixel-layer'});
  }
  const add=(key,definition,slot,itemId,level)=>{
    if(!definition)return;
    slot=definition.attachment_slot||slot;
    const joint=sample.slots?.[slot],frame=animationFrame(definition,'idle',0,false,facing);
    if(!point(joint)||!frame)return;
    const slotLayer=joint.layer??(slot==='hand'?(facing==='north'?-.03:.04):slot==='head'?.08:.03);
    layers.push({key,definition,frame,pose:pose(joint),layer:slotLayer,slot,itemId,toolLevel:level,textureDependency:bodyImage,className:`paper-doll-equipment pixel-layer pixel-${key}`});
  };
  add('accessory',assets?.accessories?.[agent.appearance?.accessory_id],'head',agent.appearance?.accessory_id);
  add('armor',assets?.equipment?.[equipment.armor],'chest',equipment.armor);
  if(!handsBusy)add('weapon',assets?.equipment?.[equipment.weapon],'hand',equipment.weapon);
  if(tool)add('tool',assets?.tools?.[`${tool}_${toolLevel}`],'hand',tool,toolLevel);
  // Portrait cards have a 43px foot anchor and clip their contents. Fit the
  // complete silhouette and held items together, without touching world rigs.
  if(portrait)for(const layer of layers){const p=layer.pose;layer.pose={...p,x:p.x*.78,y:p.y*.78,scaleX:p.scaleX*.78,scaleY:p.scaleY*.78};}
  return layers.sort((a,b)=>a.layer-b.layer);
}
