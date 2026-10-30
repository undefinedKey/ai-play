import test from 'node:test';
import assert from 'node:assert/strict';
import {gatheringState,publicLifeResult} from '../src/life-state.js';
const agent={agent_id:'a',status:'active',life:{gathering:{job_id:'j',item_id:'wood',started_at:1000,ends_at:13000,quantity:1}}};
test('public gathering progress clamps before start and awaits server confirmation instead of fabricating success',()=>{
 assert.equal(gatheringState(agent,{},0).elapsed,0);
 assert.equal(gatheringState(agent,{},4000).seconds,9);
 const ended=gatheringState(agent,{},14000);assert.equal(ended.awaiting,true);assert.equal(ended.elapsed,12000);
 assert.equal(gatheringState({...agent,status:'paused'},{},4000),null);
 assert.equal(gatheringState({...agent,life:{gathering:null}},{},4000),null);
});
test('latest life receipt is scoped to selected agent and excludes messages/private fields',()=>{
 const done={type:'life_gather_finished',payload:{agent_id:'a',text:'拾枝完成'}};
 assert.equal(publicLifeResult(agent,[done,{type:'message',payload:{agent_id:'a'}},{type:'life_traded',payload:{agent_id:'b'}}]),done);
 assert.equal(publicLifeResult(null,[done]),null);
});
