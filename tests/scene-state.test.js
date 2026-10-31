import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedPosition, sceneActors, actorScene } from '../src/scene-state.js';
import { activeSpeeches } from '../src/speech-state.js';
test('actual scene is required; coordinates do not imply residence',()=>{
 const agents=[{agent_id:'a',scene_id:'plaza',status:'active',position:{x:11,y:8}},{agent_id:'b',scene_id:'adventure',status:'paused',position:{x:11,y:8}},{agent_id:'old',status:'active',position:{x:11,y:8}}];
 assert.deepEqual(sceneActors(agents,'plaza').map(a=>a.agent_id),['a']);assert.deepEqual(sceneActors(agents,'adventure').map(a=>a.agent_id),['b']);assert.equal(actorScene(agents[2]),null);
});
test('confirmed motion interpolates each path leg and rejects blocked, old or cross-scene paths',()=>{
 const a={status:'active',scene_id:'plaza',position:{x:6,y:6},movement:{scene_id:'plaza',path:[{x:5,y:5},{x:6,y:5},{x:6,y:6}],started_at:1000,duration_ms:400}};
 assert.deepEqual(confirmedPosition(a,1100),{x:5.5,y:5});assert.deepEqual(confirmedPosition(a,1300),{x:6,y:5.5});assert.deepEqual(confirmedPosition(a,1500),a.position);assert.deepEqual(confirmedPosition(a,1100,false),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,scene_id:'adventure'}},1100),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,path:[{x:5,y:5},{x:5,y:6},{x:6,y:6}]}},1100),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,path:[{x:5,y:5},{x:6,y:6}]}},1100),a.position);
});
test('head clouds require both confirmed event scene and current actor scene, including held reading',()=>{
 const agent={agent_id:'a',name:'A',scene_id:'adventure',status:'active'};
 const event=(scene_id,id)=>({event_id:id,type:'message',occurred_at:1000,payload:{agent_id:'a',channel:'nearby',text:'hello',...(scene_id?{scene_id}:{})}});
 assert.equal(activeSpeeches({events:[event('plaza','old'),event(null,'unknown')],agents:[agent],sceneId:'adventure',now:1100}).length,0);
 const speech=activeSpeeches({events:[event('adventure','new')],agents:[agent],sceneId:'adventure',now:1100});assert.equal(speech.length,1);
 assert.equal(activeSpeeches({events:[event('adventure','new')],agents:[{...agent,scene_id:'plaza'}],sceneId:'plaza',now:1100,reading:{a:speech[0]}}).length,0);
});
