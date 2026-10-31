import test from 'node:test';
import assert from 'node:assert/strict';
import {cooperationState,cooperationSummary,selectedCooperation} from '../src/cooperation-state.js';
const project=(status='active')=>({cooperation_id:'c',template_id:'camp_meal',status,created_at:10,invite_expires_at:160,expires_at:1000,members:[{agent_id:'a',role_id:'supplier',confirmed:true}],progress:[{step_id:'supply',role_id:'supplier',progress:2,target_count:4,completed_at:null}]});
test('cooperation summary follows accepted membership, prioritizes current project and never infers consent from an invitation',()=>{
  const old={...project('completed'),cooperation_id:'old'},current=project();
  assert.equal(selectedCooperation([old,current],'a'),current);
  assert.equal(selectedCooperation([{...current,target_agent_id:'b'}],'b'),null);
  const world={cooperations:[current],cooperation:{templates:[{template_id:'camp_meal',name:'共同备餐',roles:[{role_id:'supplier',name:'供菜者'}]}]}};
  assert.equal(cooperationSummary(world,'a',20).text,'共同备餐 · 合作进行中 · 供菜者 2/4');
});
test('local deadlines wait for server terminal state; decline/unavailability share neutral public reason',()=>{
  const pending=project('proposed');assert.equal(cooperationState(pending,170).label,'期限已到，等待确认');assert.equal(pending.status,'proposed');
  assert.equal(cooperationState({...project('ended'),end_reason:'not_formed'},20).label,'未能成行');
  const review=project('needs_review');assert.equal(cooperationState(review,20).confirmed,1);assert.equal(cooperationState(review,1010).label,'期限已到，等待确认');
  assert.equal(cooperationState(project('completed'),1010).label,'合作已完成');
});
