import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { spectatorSnapshot, scopeSpectatorSnapshot } from '../server/spectator.js';

test('v033 all spectators share actual journey facts; scene switching cannot move residents or expose control bindings',t=>{
  let now=2000000000000;
  const world=new World({now:()=>now,actionIntervalMs:0});t.after(()=>world.close());
  const id=world.createAgent({name:'旁观测试旅人',owner_id:'PRIVATE_OWNER'}).agent_id,ctl=world.createController(id);
  world.ownerControl(id,'start',{controller_id:ctl.controller_id,duration_minutes:30,max_calls:1000,goal:'PRIVATE_ORIGINAL_GOAL'});
  const auth=world.authenticate(ctl.token);world.callTool(auth,'join_world');
  let a=world.agent(id);a.scene_id='journey';a.position={x:2,y:16};
  const session={run_id:a.run.run_id,session_epoch:a.session_epoch},o=world.callTool(auth,'observe',session);
  const r=world.callTool(auth,'act',{...session,action_id:o.next_action_id,type:'journey',payload:{intent:'travel',node_id:'camp'}});
  assert.equal(r.status,'applied');
  now+=600;world.tick();a=world.agent(id);
  a.journey_job.private_sentinel='PRIVATE_JOB_SECRET';world.state.journey.monsters[0].private_sentinel='PRIVATE_MONSTER_SECRET';
  const before=structuredClone(world.state),snapshot=spectatorSnapshot(world);
  assert.ok(snapshot.agents.find(a=>a.agent_id===id).journey_job);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_|owner_id|run_id|session_epoch|contributions/);
  for(const scene of ['plaza','adventure','ruins','journey']){
    const scoped=scopeSpectatorSnapshot(snapshot,scene);
    assert.equal(scoped.agents.find(a=>a.agent_id===id).scene_id,'journey');
    assert.equal(scoped.journey.monsters.length,scene==='journey'?2:0);
    assert.equal(scoped.adventure.monsters.length,scene==='adventure'?3:0);
    assert.ok(scoped.resources.nodes.every(n=>n.scene_id===scene));
    if(scene==='journey')assert.ok(scoped.events.some(e=>e.type==='journey_started'));
  }
  assert.deepEqual(world.state,before,'reading scenes has no world effects');
});

test('v033 journey observations expose legal local choices and omit legacy coordinate movement',t=>{
  const world=new World({now:()=>2000000000000,actionIntervalMs:0});t.after(()=>world.close());
  const id=world.createAgent({name:'接口测试旅人'}).agent_id,ctl=world.createController(id);
  world.ownerControl(id,'start',{controller_id:ctl.controller_id,duration_minutes:30,max_calls:1000});
  const auth=world.authenticate(ctl.token);world.callTool(auth,'join_world');const a=world.agent(id);a.scene_id='journey';a.position={x:2,y:16};
  const session={run_id:a.run.run_id,session_epoch:a.session_epoch},o=world.callTool(auth,'observe',session);
  assert.deepEqual(o.movement.candidates,[]);assert.ok(o.journey.opportunities.some(row=>row.action.payload.route==='bypass'));
  assert.ok(!o.opportunities.some(row=>['move','adventure_plan','home','fish','ruins','farm'].includes(row.action.type)));
  for(const [type,payload] of [['adventure_plan',{intent:'explore',zone_id:'forest'}],['survival',{intent:'approach',site_id:'journey_camp'}],['gather',{intent:'start',node_id:'journey_pine'}]]){
    const fresh=world.callTool(auth,'observe',session);
    const result=world.callTool(auth,'act',{...session,type,payload,action_id:fresh.next_action_id});
    assert.equal(result.status,'rejected');assert.equal(result.error.code,'JOURNEY_ROUTE_REQUIRED');
    assert.deepEqual(world.agent(id).position,{x:2,y:16});
  }
});
