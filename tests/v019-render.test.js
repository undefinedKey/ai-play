import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cameraView,zoomCamera,panCamera,cameraTransform} from '../src/camera-state.js';
import {characterAction,monsterAction,actionPose,animationFrame,actionFrame} from '../src/pixel-state.js';
import {confirmedPosition} from '../src/scene-state.js';
import {newSoundEvents} from '../src/world-audio.js';

const actor={agent_id:'a',scene_id:'plaza',status:'active',position:{x:5,y:5},position_at:1000,facing:'south',action:null,hurt:null,movement:null};
test('v019 camera clamps edges, preserves zoom anchor and never changes the actor',()=>{
 const overview=cameraView(),zoom=zoomCamera(overview,2,{x:.75,y:.25});
 assert.deepEqual(zoom,{zoom:2,center:{x:.625,y:.375}});
 assert.deepEqual(panCamera(zoom,5,-5),{zoom:2,center:{x:.25,y:.75}});
 assert.deepEqual(zoomCamera(zoom,.5),overview);assert.equal(cameraView({x:0,y:0},9).zoom,4);
 assert.equal(cameraTransform(overview),'translate(0%, 0%) scale(1)');
});
test('v019 position samples an authorized path, keeps turns and freezes at the actual point offline',()=>{
 const moving={...actor,position:{x:5.2,y:5},position_at:1100,movement:{version:2,movement_id:'m',scene_id:'plaza',path:[{x:5,y:5},{x:6,y:5},{x:6,y:6}],mode:'run',speed:2,started_at:1000,ends_at:2000,duration_ms:1000}};
 assert.deepEqual(confirmedPosition(moving,1200),{x:5.4,y:5});
 assert.deepEqual(confirmedPosition(moving,4000),{x:5.7,y:5});
 assert.deepEqual(confirmedPosition(moving,1200,false),moving.position);
 assert.equal(characterAction(moving,[],1200),'run');
 assert.equal(characterAction(moving,[],4000,true),'idle','stale movement does not keep walking in place');
 assert.deepEqual(confirmedPosition({...moving,status:'paused'},1200),moving.position);
});
test('v019 combat uses authoritative phases and outcomes; old receipts never synthesize attacks',()=>{
 const attack={...actor,action:{action_id:'hit1',type:'attack',started_at:1000,impact_at:1400,ends_at:1800,outcome:null,phase:'prepare'}};
 assert.equal(characterAction(attack,[],1100),'attack');assert.equal(actionPose(attack,'attack',1100).frame,0);
 assert.equal(actionPose(attack,'attack',1500).frame,1,'wait for settlement after impact time');
 const hit={...attack,action:{...attack.action,outcome:'hit',resolved_at:1450,phase:'recovery'}};
 assert.equal(actionPose(hit,'attack',1500).frame,2);assert.equal(actionPose(hit,'attack',1750).frame,3);
 assert.equal(actionPose({...hit,action:{...hit.action,outcome:'miss'}},'attack',1500).frame,3);
 assert.equal(characterAction({...hit,hurt:{action_id:'incoming',started_at:1490,ends_at:1750,damage:3}},[],1500),'hurt');
 assert.equal(characterAction(actor,[{type:'adventure_combat',occurred_at:1000,payload:{agent_id:'a',attacker:'agent'}}],1100),'idle');
 assert.equal(monsterAction({...actor,status:'alive',monster_id:'slime'},[{type:'adventure_combat',occurred_at:1000,payload:{monster_id:'slime',attacker:'monster'}}],1100),'idle');
 assert.equal(characterAction({...attack,action:{...attack.action,outcome:'cancelled'}},[],1100),'idle');
});
test('v019 body, equipment and tools cover every direction with shared frame timing and distinct run poses',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../public/pixel-world/manifest.json',import.meta.url)));
 const body=manifest.characters.wanderer_1;
 for(const group of ['characters','equipment','accessories','tools'])for(const sprite of Object.values(manifest[group]))for(const action of ['idle','walk','run','attack','hurt','till','water'])for(const direction of ['south','north','east','west']){
   assert.ok(animationFrame(sprite,action,120,true,direction));
   assert.ok(sprite.animations[`${action}_${direction==='west'?'east':direction}`]);
   assert.deepEqual(sprite.animations[`${action}_${direction==='west'?'east':direction}`].frames.map(f=>f.duration),body.animations[`${action}_${direction==='west'?'east':direction}`].frames.map(f=>f.duration));
 }
 assert.notDeepEqual(body.animations.walk.frames,body.animations.run.frames);
 assert.notDeepEqual(actionFrame(body,'attack','north',2),actionFrame(body,'attack','south',2));
 assert.equal(body.animations.attack_north.loop,false);
});
test('v019 sound starts with a silent baseline and ignores replay, old history and another scene',()=>{
 const hit={event_id:'a',type:'adventure_combat',occurred_at:1000,payload:{scene_id:'plaza',damage:3}};
 const first=newSoundEvents([hit],null,1100,'plaza');assert.deepEqual(first.sounds,[]);
 assert.deepEqual(newSoundEvents([hit],first.seen,1200,'plaza').sounds,[]);
 assert.deepEqual(newSoundEvents([{...hit,event_id:'b'}],first.seen,1200,'plaza').sounds,['hit']);
 assert.deepEqual(newSoundEvents([{...hit,event_id:'b'}],first.seen,1700,'plaza').sounds,[]);
 assert.deepEqual(newSoundEvents([{...hit,event_id:'b'}],first.seen,1200,'adventure').sounds,[]);
});
