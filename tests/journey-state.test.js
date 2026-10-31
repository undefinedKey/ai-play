import test from 'node:test';
import assert from 'node:assert/strict';
import {encounterState,goalState} from '../src/journey-state.js';
test('pending encounter deadline becomes awaiting confirmation without inventing a choice or extending protection',()=>{
 const agent={adventure:{encounter:{template_id:'spring',status:'pending',expires_at:5000}}};
 assert.equal(encounterState(agent,2000).seconds,3);assert.equal(encounterState(agent,2000).label,'等待原 AI 选择');
 assert.equal(encounterState(agent,6000).label,'选择期限已到，等待确认');assert.equal(agent.adventure.encounter.status,'pending');
 assert.equal(encounterState({},6000),null);
 for(const status of['resolved','declined','expired','interrupted'])assert.equal(encounterState({adventure:{encounter:{...agent.adventure.encounter,status}}},6000).pending,false);
});
test('goal uses server progress only, bounded without inferring inventory or advancing by elapsed time',()=>{
 const goal={kind:'collect_item',target_count:3,progress:1,status:'active',expires_at:5000};
 assert.equal(goalState(goal,1000).progress,1);assert.equal(goalState(goal,9000).progress,1);assert.equal(goalState(goal,9000).label,'截止时间已到，等待确认');
 assert.equal(goalState({...goal,status:'needs_review'},1000).label,'等待原 AI 复核');assert.equal(goalState({...goal,status:'completed',progress:3},9000).label,'已完成');
 assert.equal(goalState({...goal,progress:9},1000).progress,3);assert.equal(goalState(null,1000),null);
});
