import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {actorVisualPose,STILL_POSE} from '../src/actor-motion.js';
import {animationFrame} from '../src/pixel-state.js';
import {renderSpace,spriteAttachment,spriteGeometry,spriteRenderPacket} from '../src/render-packet.js';

const assets=JSON.parse(readFileSync(new URL('../public/pixel-world/manifest.json',import.meta.url)));
const start=1000;
const actor={agent_id:'registration-probe',scene_id:'plaza',status:'active',position:{x:9,y:10},position_at:start,
  movement:{version:2,movement_id:'registration-run',scene_id:'plaza',started_at:start,ends_at:10000,speed:3.5,mode:'run',path:[{x:9,y:10},{x:20,y:10}]}};
function sample(definition,action,facing,elapsed){
  const cycle=action==='run'?1.5/3.5*1000:1.25/2*1000,phase=(elapsed/cycle)%1;
  const frames=definition.animations[`${action}_${facing==='west'?'east':facing}`].frames;
  const total=frames.reduce((sum,f)=>sum+f.duration,0),frame=animationFrame(definition,action,phase*total,true,facing);
  const observed={...actor,position_at:start+elapsed,movement:{...actor.movement,mode:action,speed:action==='run'?3.5:2}};
  const authority=structuredClone(observed);
  const pose=actorVisualPose(observed,action,start+elapsed,{facing,gaitPhase:phase,definition,frame});
  assert.deepEqual(observed,authority,'presentation cannot rewrite the confirmed actor or its movement');
  const marker={native_scale:1,anchor_mode:'source',anchor:{x:0,y:0}},markerFrame={x:0,y:0,w:1,h:1};
  const points=Object.fromEntries(['head','chest'].map(slot=>[slot,spriteGeometry(marker,markerFrame,[24,43],facing,spriteAttachment(definition,frame,slot,facing),pose).target]));
  return {frame,pose,points,observed};
}

test('authored walking/running frame boundaries keep head and torso within three world pixels in one millisecond',()=>{
  let worst=0;
  for(const [id,definition] of Object.entries(assets.characters))for(const action of ['walk','run'])for(const facing of ['south','north','east','west']){
    const frames=definition.animations[`${action}_${facing==='west'?'east':facing}`].frames;
    const cycle=action==='run'?1.5/3.5*1000:1.25/2*1000,total=frames.reduce((sum,f)=>sum+f.duration,0);
    let duration=0;
    for(let index=0;index<frames.length;index++){
      duration+=frames[index].duration;const at=duration/total*cycle;
      const before=sample(definition,action,facing,at-.5),after=sample(definition,action,facing,at+.5);
      for(const slot of ['head','chest']){
        const jump=Math.hypot(...before.points[slot].map((v,k)=>v-after.points[slot][k]));worst=Math.max(worst,jump);
        assert.ok(jump<=3,`${id}/${action}/${facing}/${index} ${slot} jumps ${jump.toFixed(3)} world pixels`);
      }
    }
  }
  assert.ok(worst>0,'actual source drawings retain bounded movement, not a frozen or replaced pose');
});

test('registered source frames preserve authority and carry equipment through the same body transform',()=>{
  const definition=assets.characters.wanderer_3,source=structuredClone(definition);
  for(const facing of ['south','north','east','west'])for(const elapsed of [20,160,250,370]){
    const {frame,pose,observed}=sample(definition,'run',facing,elapsed),space=renderSpace(observed.position),saved=structuredClone(observed);
    const body=spriteRenderPacket(definition,frame,space,{action:'run',facing,pose});
    const attachment=spriteAttachment(definition,frame,'hand',facing),item={native_scale:.1,anchor_mode:'source',anchor:{x:10,y:20}},itemFrame={x:0,y:0,w:30,h:40};
    const held=spriteRenderPacket(item,itemFrame,space,{action:'run',facing,attachment,pose});
    const local=[attachment.x-24,attachment.y-43],c=Math.cos(body.poseRotation),s=Math.sin(body.poseRotation);
    const expected=[body.x+(c*local[0]*body.poseScaleX-s*local[1]*body.poseScaleY)*space.scale,body.y+(s*local[0]*body.poseScaleX+c*local[1]*body.poseScaleY)*space.scale];
    assert.ok(Math.hypot(held.x-expected[0],held.y-expected[1])<1e-8);
    assert.deepEqual([body.originX,body.originY],[space.x,space.y]);
    assert.deepEqual(observed,saved);assert.deepEqual(definition,source);
    assert.ok(Math.hypot(pose.x,pose.y)<=8,'registration plus real gait lift remains below a quarter tile');
    assert.ok(Math.abs(pose.rotation)<=.14);assert.ok(pose.scaleX>=.94&&pose.scaleX<=1.06);
  }
});

test('stopped or disabled motion never applies registration or continues local animation',()=>{
  const definition=assets.characters.wanderer_3,frame=definition.animations.run.frames[2];
  for(const options of [{enabled:false},{enabled:true}]){
    const stopped={...actor,movement:null};
    assert.deepEqual(actorVisualPose(stopped,'run',start,{...options,definition,frame}),STILL_POSE);
  }
  assert.deepEqual(actorVisualPose(actor,'run',start,{enabled:false,definition,frame}),STILL_POSE);
});
