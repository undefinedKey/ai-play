import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedPosition, sceneActors, actorScene } from '../src/scene-state.js';
import { activeSpeeches } from '../src/speech-state.js';
import { PLAZA_SERVICES } from '../shared/plaza-layout.js';
import { isWalkable } from '../shared/world-layout.js';
test('actual scene is required; coordinates do not imply residence',()=>{
 const agents=[{agent_id:'a',scene_id:'plaza',status:'active',position:{x:11,y:8}},{agent_id:'b',scene_id:'adventure',status:'paused',position:{x:11,y:8}},{agent_id:'old',status:'active',position:{x:11,y:8}}];
 assert.deepEqual(sceneActors(agents,'plaza').map(a=>a.agent_id),['a']);assert.deepEqual(sceneActors(agents,'adventure').map(a=>a.agent_id),['b']);assert.equal(actorScene(agents[2]),null);
});
test('confirmed motion interpolates each path leg and rejects blocked, old or cross-scene paths',()=>{
 const house=PLAZA_SERVICES.home.position,x=house.x-3,y=house.y,start={x,y},turn={x,y:y+1},end={x:x+1,y:y+1},blockedCorner={x:x+1,y};
 assert.ok([start,turn,end].every(p=>isWalkable('plaza',p)));assert.equal(isWalkable('plaza',blockedCorner),false,'alternate route cuts through the actual house body');
 const a={status:'active',scene_id:'plaza',position:end,movement:{scene_id:'plaza',path:[start,turn,end],started_at:1000,duration_ms:400}};
 assert.deepEqual(confirmedPosition(a,1100),{x,y:y+.5});assert.deepEqual(confirmedPosition(a,1300),{x:x+.5,y:y+1});assert.deepEqual(confirmedPosition(a,1500),a.position);assert.deepEqual(confirmedPosition(a,1100,false),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,scene_id:'adventure'}},1100),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,path:[start,blockedCorner,end]}},1100),a.position);
 assert.deepEqual(confirmedPosition({...a,movement:{...a.movement,path:[start,end]}},1100),a.position);
});
test('head clouds require both confirmed event scene and current actor scene, including held reading',()=>{
 const agent={agent_id:'a',name:'A',scene_id:'adventure',status:'active'};
 const event=(scene_id,id)=>({event_id:id,type:'message',occurred_at:1000,payload:{agent_id:'a',channel:'nearby',text:'hello',...(scene_id?{scene_id}:{})}});
 assert.equal(activeSpeeches({events:[event('plaza','old'),event(null,'unknown')],agents:[agent],sceneId:'adventure',now:1100}).length,0);
 const speech=activeSpeeches({events:[event('adventure','new')],agents:[agent],sceneId:'adventure',now:1100});assert.equal(speech.length,1);
 assert.equal(activeSpeeches({events:[event('adventure','new')],agents:[{...agent,scene_id:'plaza'}],sceneId:'plaza',now:1100,reading:{a:speech[0]}}).length,0);
});
