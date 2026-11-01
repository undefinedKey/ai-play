import test from 'node:test';
import assert from 'node:assert/strict';
import {PAPER_DOLL_PARTS,selectPaperDoll,paperDollImages,paperDollLayers} from '../src/paper-doll-render.js';
import {renderSpace,spriteGeometry,spriteRenderPacket} from '../src/render-packet.js';

const feiyu='agent_8afc5902-688e-42b6-953c-0544d0be6bd5';
function part(slot){
  return {image:'/pixel-world/rig-test.png',sheet_width:256,sheet_height:256,native_scale:.25,anchor_mode:'source',anchor:{x:12,y:8},...(slot?{attachment_slot:slot}:{}),animations:{idle:{loop:false,frames:[{x:16,y:32,w:24,h:40}]}}};
}
function configuration(){
  return {eligible_agent_ids:[feiyu],directions:Object.fromEntries(['south','north','east'].map(direction=>[direction,{parts:Object.fromEntries(PAPER_DOLL_PARTS.map(id=>[id,part()]))}]))};
}
function fixture(){
  const assets={paper_dolls:{feiyu_v1:configuration()},accessories:{scarf:part('chest')},equipment:{iron_armor:part('chest'),iron_sword:part('hand')},tools:{axe_2:part('hand')}};
  const agent={agent_id:feiyu,name:'肥鱼',appearance:{sprite_id:'wanderer_3',accessory_id:'scarf'},life:{equipment:{armor:'iron_armor',weapon:'iron_sword'}}};
  const sample={parts:Object.fromEntries(PAPER_DOLL_PARTS.map((id,i)=>[id,{x:i-7,y:-i,rotation:i*.03,scaleX:1,scaleY:1,layer:(i-7)/1000}])),slots:{head:{x:1,y:-43,rotation:.02,layer:.008},chest:{x:1,y:-24,rotation:.08,layer:.006},hand:{x:11,y:-18,rotation:.48,layer:.009}}};
  return {assets,agent,sample};
}

test('rig eligibility is an explicit published identity allowlist, independent of names or avatar choice',()=>{
  const {assets,agent}=fixture();
  assert.equal(selectPaperDoll(assets,agent).id,'feiyu_v1');
  assert.equal(selectPaperDoll(assets,{...agent,agent_id:'unrelated',appearance:{sprite_id:'wanderer_3',paper_doll:'feiyu_v1'}}),null);
  assert.equal(selectPaperDoll(assets,{...agent,agent_id:null}),null);
  assert.equal(selectPaperDoll({},agent),null);
  const isolated=structuredClone(assets);isolated.paper_dolls.feiyu_v1.eligible_agent_ids=['isolated-fixture'];
  assert.equal(selectPaperDoll(isolated,agent),null);
  assert.equal(selectPaperDoll(isolated,{...agent,agent_id:'isolated-fixture'}).id,'feiyu_v1');
});

test('incomplete or disabled rigs preserve the complete legacy character fallback',()=>{
  for(const edit of [rig=>{rig.enabled=false;},rig=>{delete rig.directions.north;},rig=>{delete rig.directions.east.parts.forearm_l;},rig=>{rig.directions.south.parts.head.anchor.x=NaN;},rig=>{rig.directions.south.parts.head.native_scale=0;}]){
    const {assets,agent}=fixture();edit(assets.paper_dolls.feiyu_v1);assert.equal(selectPaperDoll(assets,agent),null);
  }
});

test('preparing static atlas definitions is cached and requests only selected rig textures',()=>{
  const {assets,agent}=fixture(),original=structuredClone(assets),first=selectPaperDoll(assets,agent),second=selectPaperDoll(assets,agent);
  assert.equal(first.rig,second.rig);
  assert.equal(first.rig.directions.south.parts.head.definition,second.rig.directions.south.parts.head.definition);
  assert.deepEqual(paperDollImages(first.rig),['/pixel-world/rig-test.png']);
  assert.deepEqual(assets,original);
});

test('all independent joints keep the server foot while DOM and Phaser use the same mirrored global pose',()=>{
  const {assets,agent,sample}=fixture(),{rig}=selectPaperDoll(assets,agent),space=renderSpace({x:12.5,y:11.25},{depth:200}),saved=structuredClone(space);
  for(const facing of ['south','north','east','west']){
    const layers=paperDollLayers(rig,sample,assets,agent,{facing});
    assert.equal(layers.filter(layer=>layer.part).length,15);
    for(const layer of layers){
      const geometry=spriteGeometry(layer.definition,layer.frame,space.anchor,facing,null,layer.pose),packet=spriteRenderPacket(layer.definition,layer.frame,space,{facing,pose:layer.pose,layer:layer.layer});
      assert.deepEqual([packet.originX,packet.originY],[space.x,space.y]);
      assert.equal(packet.x,space.x+layer.pose.x);assert.equal(packet.y,space.y+layer.pose.y);
      assert.equal(packet.poseRotation,layer.pose.rotation);
      assert.equal(packet.depth,space.depth+layer.layer);
      assert.equal(geometry.offset.x+geometry.domAnchor[0]*geometry.unit,space.anchor[0]+layer.pose.x);
      assert.equal(geometry.offset.y+geometry.domAnchor[1]*geometry.unit,space.anchor[1]+layer.pose.y);
      const flip=facing==='west'?-1:1;
      assert.ok(Math.abs(geometry.matrix[0]-Math.cos(packet.poseRotation)*flip)<1e-12);
      assert.ok(Math.abs(geometry.matrix[1]-Math.sin(packet.poseRotation)*flip)<1e-12);
    }
  }
  assert.deepEqual(space,saved);
});

test('gear follows the named bone slot, gathering replaces weapons with the owned tool tier, and armor covers only optional clothing',()=>{
  const {assets,agent,sample}=fixture();
  for(const direction of Object.values(assets.paper_dolls.feiyu_v1.directions))direction.parts.vest={...part(),pose_from:'torso',covered_by_armor:true};
  const {rig}=selectPaperDoll(assets,agent);
  const idle=paperDollLayers(rig,sample,assets,agent),working=paperDollLayers(rig,sample,assets,agent,{handsBusy:true,tool:'axe',toolLevel:2});
  assert.equal(idle.some(layer=>layer.part==='vest'),false);
  assert.equal(idle.some(layer=>layer.part==='torso'),true);
  assert.deepEqual(idle.find(layer=>layer.key==='accessory').pose,{x:1,y:-24,rotation:.08,scaleX:1,scaleY:1});
  assert.deepEqual(idle.find(layer=>layer.key==='weapon').pose,{x:11,y:-18,rotation:.48,scaleX:1,scaleY:1});
  const sword=idle.find(layer=>layer.key==='weapon'),space=renderSpace({x:10,y:10});
  const held=spriteRenderPacket(sword.definition,sword.frame,space,{pose:sword.pose,attachment:{image:sword.textureDependency}});
  assert.equal(held.attachmentImage,'/pixel-world/rig-test.png','held gear waits for its rig texture in Phaser');
  assert.equal(held.x,space.x+sample.slots.hand.x);assert.equal(held.y,space.y+sample.slots.hand.y);
  assert.equal(working.some(layer=>layer.key==='weapon'),false);
  assert.equal(working.find(layer=>layer.key==='tool').definition,assets.tools.axe_2);
  assert.equal(working.find(layer=>layer.key==='tool').toolLevel,2);
  const unarmored={...agent,life:{equipment:{}}};
  assert.equal(paperDollLayers(rig,sample,assets,unarmored).some(layer=>layer.part==='vest'),true);
});

test('measured source-axis correction joins the authored distal point to its real bone without rotating attachment slots',()=>{
  const {assets,agent,sample}=fixture(),dx=38,dy=216,length=10,rest=Math.atan2(dx,dy),angle=.47;
  for(const direction of Object.values(assets.paper_dolls.feiyu_v1.directions))Object.assign(direction.parts.thigh_r,{native_scale:length/Math.hypot(dx,dy),rest_rotation:rest});
  const {rig}=selectPaperDoll(assets,agent);
  for(const facing of ['east','west','south','north'])for(const scaleY of [.25,.6,1]){
    const bone={...sample.parts.thigh_r,rotation:facing==='west'?-angle:angle,scaleY},observed={...sample,parts:{...sample.parts,thigh_r:bone}};
    const layers=paperDollLayers(rig,observed,assets,agent,{facing}),leg=layers.find(layer=>layer.part==='thigh_r'),item=layers.find(layer=>layer.key==='weapon');
    const attachment={rotation:leg.sourceRotation},geometry=spriteGeometry(leg.definition,leg.frame,[24,43],facing,attachment,leg.pose),[a,b,c,d]=geometry.matrix;
    const rendered={x:(a*dx+c*dy)*geometry.unit,y:(b*dx+d*dy)*geometry.unit};
    assert.ok(Math.abs(rendered.x+Math.sin(bone.rotation)*length*scaleY)<1e-10);
    assert.ok(Math.abs(rendered.y-Math.cos(bone.rotation)*length*scaleY)<1e-10);
    const packet=spriteRenderPacket(leg.definition,leg.frame,renderSpace({x:8,y:8}),{facing,attachment,pose:leg.pose});
    assert.equal(packet.poseRotation,bone.rotation);assert.equal(packet.poseScaleY,scaleY);assert.equal(packet.rotation,leg.sourceRotation);
    const fx=(facing==='west'?-1:1)*dx*geometry.unit,fy=dy*geometry.unit,localX=Math.cos(packet.rotation)*fx-Math.sin(packet.rotation)*fy,localY=(Math.sin(packet.rotation)*fx+Math.cos(packet.rotation)*fy)*packet.poseScaleY;
    assert.ok(Math.abs(Math.cos(packet.poseRotation)*localX-Math.sin(packet.poseRotation)*localY-rendered.x)<1e-10);
    assert.ok(Math.abs(Math.sin(packet.poseRotation)*localX+Math.cos(packet.poseRotation)*localY-rendered.y)<1e-10);
    assert.equal(item.pose.rotation,sample.slots.hand.rotation,'source correction must not turn the gripping bone');
    assert.equal(observed.parts.thigh_r.rotation,bone.rotation);
  }
});

test('portrait fits the complete body and equipment about the same anchor without scaling the world character',()=>{
  const {assets,agent,sample}=fixture(),{rig}=selectPaperDoll(assets,agent),before=structuredClone(sample);
  const world=paperDollLayers(rig,sample,assets,agent),portrait=paperDollLayers(rig,sample,assets,agent,{portrait:true});
  assert.equal(portrait.length,world.length);
  for(let i=0;i<world.length;i++){
    assert.equal(portrait[i].key,world[i].key);
    assert.deepEqual(portrait[i].pose,{...world[i].pose,x:world[i].pose.x*.78,y:world[i].pose.y*.78,scaleX:world[i].pose.scaleX*.78,scaleY:world[i].pose.scaleY*.78});
    assert.equal(portrait[i].definition,world[i].definition);assert.equal(portrait[i].frame,world[i].frame);
  }
  assert.deepEqual(sample,before);
  assert.deepEqual(paperDollLayers(rig,sample,assets,agent),world);
});
