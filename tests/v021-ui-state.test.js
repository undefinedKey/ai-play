import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneFireLights,treePresentation,survivalStatus} from '../src/survival-state.js';
import {resourceState} from '../src/wilderness-state.js';
import {characterAction} from '../src/pixel-state.js';

test('light rendering uses only real lit fire geometry in its own scene',()=>{
 const source={fires:[{fire_id:'a',scene_id:'plaza',lit:true,fuel_seconds:30,light_radius:5,position:{x:14,y:11}},{fire_id:'b',scene_id:'adventure',lit:true,fuel_seconds:30,light_radius:6,position:{x:31,y:17}},{fire_id:'c',scene_id:'plaza',lit:false,fuel_seconds:30,light_radius:5,position:{x:28,y:16}},{fire_id:'d',scene_id:'plaza',lit:true,fuel_seconds:0,light_radius:5,position:{x:14,y:11}}]};
 assert.deepEqual(sceneFireLights(source,'plaza'),[{id:'a',x:464,y:368,radius:160}]);assert.deepEqual(sceneFireLights(null,'plaza'),[]);assert.equal(source.fires[0].fuel_seconds,30);
});
test('tree stages cannot be advanced by UI countdown, and planting reservations are shown as work',()=>{
 for(const stage of['empty','sapling','young','mature','stump']){const node={kind:'tree',stock:stage==='mature'?3:0,ecology:{stage,next_at:1000},plantable:stage==='empty'};const view=treePresentation(node);resourceState(node,[],9999999);assert.equal(node.ecology.stage,stage);assert.equal(view.stage,stage);assert.ok(view.scale>0);}
 const job={intent:'plant',phase:'working',started_at:1000,ends_at:5000},actor={agent_id:'a',status:'active',life:{gathering:job}},node={stock:0,kind:'tree',ecology:{stage:'empty'},reservation:{agent_id:'a'}};
 assert.equal(resourceState(node,[actor],2000).label,'正在种树');assert.equal(characterAction(actor,[],2000),'plant');
});
test('survival disclosure distinguishes starvation, true light, darkness and rescue protection',()=>{
 const actor={survival:{satiety:20,max_satiety:100,satiety_state:'hungry',light:{lit:false,kind:'darkness'},darkness_seconds:40,danger_in_seconds:50}};
 assert.equal(survivalStatus(actor,'night').warning,'暗处风险约 50 秒后开始');actor.survival.protected_until=9000;assert.equal(survivalStatus(actor,'night').warning,'救援保护中');actor.survival.protected_until=null;actor.survival.light={lit:true,kind:'campfire'};assert.equal(survivalStatus(actor,'night').danger,false);actor.survival.satiety_state='starving';assert.equal(survivalStatus(actor,'night').warning,'需要食物补给');
});
