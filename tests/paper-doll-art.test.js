import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FEIYU_PART_GEOMETRY} from '../art/ink-world/paper-doll.mjs';
import {PAPER_DOLL_PARTS,samplePaperDollPose} from '../src/paper-doll-rig.js';
import {selectPaperDoll,paperDollLayers} from '../src/paper-doll-render.js';
import {spriteGeometry} from '../src/render-packet.js';

const assets=JSON.parse(readFileSync(new URL('../public/pixel-world/manifest.json',import.meta.url)));
const actor={agent_id:'agent_8afc5902-688e-42b6-953c-0544d0be6bd5',status:'active',scene_id:'plaza',appearance:{sprite_id:'wanderer_3'},life:{}};
const selected=selectPaperDoll(assets,actor);
const pointDistance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

test('the shipped prototype is complete in three authored directions and applies only to the existing Feiyu identity',()=>{
 assert.ok(selected);assert.equal(selected.id,'feiyu_v1');
 assert.equal(selectPaperDoll(assets,{...actor,agent_id:'another-agent',name:'肥鱼'}),null);
 assert.equal(Object.keys(assets.characters).length,8,'existing persisted appearances remain available');
 for(const direction of ['east','south','north'])assert.deepEqual(Object.keys(selected.rig.directions[direction].parts).sort(),[...PAPER_DOLL_PARTS].sort());
});

test('actual published limb pixels register proximal and distal joints in all directions, including mirrored west',()=>{
 for(const facing of ['south','north','east','west'])for(const action of ['idle','walk','run'])for(const phase of [0,.125,.3,.5,.75]){
  const direction=facing==='west'?'east':facing;
  const observed={...actor,position:{x:10,y:10},position_at:1100,movement:{version:2,movement_id:'source-projection',scene_id:'plaza',started_at:1000,ends_at:9000,speed:action==='run'?3.5:2,mode:action,path:[{x:10,y:10},{x:20,y:10}]}};
  const sample=samplePaperDollPose(observed,action,1100,{facing,phase,rig:selected.rig});
  const layers=paperDollLayers(selected.rig,sample,assets,actor,{facing});
  for(const side of ['l','r'])for(const [part,proximal,distal] of [
   ['upper_arm','shoulder','elbow'],['forearm','elbow','wrist'],['thigh','hip','knee'],['shin','knee','ankle'],
  ]){
   const layer=layers.find(item=>item.part===`${part}_${side}`),[bounds,,sourceEnd]=FEIYU_PART_GEOMETRY[direction][part];
   const geo=spriteGeometry(layer.definition,layer.frame,[0,0],facing,{rotation:layer.sourceRotation},layer.pose);
   const transform=source=>{const x=(source[0]-bounds[0]-geo.domAnchor[0])*geo.unit,y=(source[1]-bounds[1]-geo.domAnchor[1])*geo.unit;return{x:geo.target[0]+geo.matrix[0]*x+geo.matrix[2]*y,y:geo.target[1]+geo.matrix[1]*x+geo.matrix[3]*y};};
   assert.ok(pointDistance(transform(FEIYU_PART_GEOMETRY[direction][part][1]),sample.joints[`${proximal}_${side}`])<1e-6);
   assert.ok(pointDistance(transform(sourceEnd),sample.joints[`${distal}_${side}`])<1e-6,`${facing}/${part}/${side}: painted limb must end on its real joint`);
  }
 }
});
