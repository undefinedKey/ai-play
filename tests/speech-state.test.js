import test from 'node:test';
import assert from 'node:assert/strict';
import {activeSpeeches,placeSpeechClouds} from '../src/speech-state.js';
const agents=['a','b','c'].map(agent_id=>({agent_id,name:agent_id,status:'active'}));
const event=(id,agent,text='hello',time=100)=>({event_id:id,type:'message',occurred_at:time,payload:{agent_id:agent,text,channel:'nearby'}});
test('head speech is newest per active real speaker; closing never resurrects older receipts',()=>{
 const events=[event('1','a'),event('2','a','latest',101),event('3','b'),{...event('private','c'),payload:{agent_id:'c',text:'secret',channel:'private'}},{...event('system','c'),type:'activity_finished'}];
 assert.deepEqual(activeSpeeches({events,agents,now:200}).map(m=>m.eventId),['2','3']);
 assert.deepEqual(activeSpeeches({events,agents,now:200,dismissedIds:new Set(['event:2'])}).map(m=>m.eventId),['3']);
 assert.deepEqual(activeSpeeches({events,agents:agents.map(a=>({...a,presence:{state:'paused'}})),now:200}),[]);
 assert.deepEqual(activeSpeeches({events,agents,now:18101}),[]);
 const reading={a:activeSpeeches({events:[events[0]],agents,now:101})[0]};
 const held=activeSpeeches({events,agents,now:20000,reading});assert.equal(held.length,1);assert.equal(held[0].eventId,'1');assert.equal(held[0].newer,true);
});
test('five corner clouds retain head identities and fit the mobile map without overlapping',()=>{
 const items=Array.from({length:5},(_,i)=>({key:String(i),headX:8+i*12,headY:12+i*10,w:142,h:80}));
 const placed=placeSpeechClouds(items,370,284);assert.equal(placed.length,5);
 for(const p of placed){assert.ok(p.x>=0&&p.y>=0&&p.x+p.w<=370&&p.y+p.h<=284);assert.equal(p.headX,items[Number(p.key)].headX);}
 for(let i=0;i<placed.length;i++)for(let j=i+1;j<placed.length;j++){const a=placed[i],b=placed[j];assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y);}
});
