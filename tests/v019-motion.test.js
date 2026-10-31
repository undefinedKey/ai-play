import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { findPath, isWalkable, recordMovement } from '../server/spatial.js';
import { sampleMotion, actionPhase, metric, facingBetween } from '../shared/motion.js';
import { spectatorSnapshot } from '../server/spectator.js';

function fixture(t,dbPath=':memory:') {
  let now=1000000;let world=new World({now:()=>now,actionIntervalMs:0,dbPath});
  const users=[];t.after(()=>world.close());
  const make=()=>{const a=world.createAgent({name:`原AI${users.length}`}),c=world.createController(a.agent_id);world.ownerControl(a.agent_id,'start',{controller_id:c.controller_id});const auth=world.authenticate(c.token),o=world.callTool(auth,'join_world');const p={id:a.agent_id,auth,session:{run_id:o.run_id,session_epoch:o.session_epoch}};users.push(p);world.agent(p.id).position={x:11,y:8};return p;};
  const raw=p=>world.agent(p.id),observe=p=>world.callTool(p.auth,'observe',p.session);
  const act=(p,type,payload={})=>world.callTool(p.auth,'act',{...p.session,action_id:observe(p).next_action_id,type,payload});
  const advance=(ms,{touch=true}={})=>{const end=now+ms;while(now<end){now=Math.min(end,now+100);world.tick();if(touch)for(const p of users)if(raw(p).status==='active')observe(p);}};
  const hunt=p=>{const a=raw(p),m=world.state.adventure.monsters[2];a.scene_id='adventure';a.position={x:19,y:7};a.adventure.hp=a.adventure.max_hp=1000;m.hp=m.max_hp=1000;m.position={x:20,y:7};m.movement=null;assert.equal(act(p,'adventure_plan',{intent:'hunt',monster_id:m.monster_id}).status,'applied');return m;};
  return {get world(){return world;},make,raw,observe,act,advance,hunt,now:()=>now,jump(ms){now+=ms;world.tick();},restart(){world.close();world=new World({now:()=>now,actionIntervalMs:0,dbPath});}};
}
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} == ${expected}`);
test('v019 facing follows the dominant target axis while a stationary role keeps its direction',()=>{
  assert.equal(facingBetween({x:10,y:10},{x:10.2,y:8}),'north');
  assert.equal(facingBetween({x:10,y:10},{x:8,y:10.2}),'west');
  assert.equal(facingBetween({x:10,y:10},{x:10,y:10},'east'),'east');
});

test('v019 walk/run move real position over time and charge travelled distance, not destination',t=>{
  const f=fixture(t),walk=f.make(),run=f.make();
  const accepted=f.act(walk,'move',{x:14,y:8});f.act(run,'move',{x:14,y:8,mode:'run'});
  assert.deepEqual(accepted.position,{x:11,y:8});assert.deepEqual(accepted.target,{x:14,y:8});assert.equal(accepted.movement.version,2);
  assert.equal(f.raw(walk).fatigue.energy,100);f.advance(200);
  close(f.raw(walk).position.x,11.4);close(f.raw(run).position.x,11.7);
  close(f.raw(walk).fatigue.energy,99.94);close(f.raw(run).fatigue.energy,99.79);
  assert.equal(f.raw(run).facing,'east');assert.ok(isWalkable('plaza',f.raw(run).position));
  f.advance(1400);assert.deepEqual(f.raw(walk).position,{x:14,y:8});assert.equal(f.raw(walk).movement,null);
  assert.equal(f.world.state.events.filter(e=>e.type==='movement_finished'&&e.payload.agent_id===walk.id).length,1);
});
test('v019 stop and turn preserve the physical point and never cross blocked corners',t=>{
  const f=fixture(t),p=f.make();f.act(p,'move',{x:14,y:8});f.advance(200);
  const stopped={...f.raw(p).position};f.act(p,'adventure_plan',{intent:'stop'});f.advance(1000);
  assert.deepEqual(f.raw(p).position,stopped);assert.equal(f.raw(p).adventure.plan,null);
  const r=f.act(p,'move',{x:11,y:7,mode:'walk'});assert.equal(r.status,'applied');assert.deepEqual(r.path[0],stopped);
  assert.equal(f.raw(p).facing,'west');f.advance(800);assert.deepEqual(f.raw(p).position,{x:11,y:7});assert.equal(f.raw(p).facing,'north');
  assert.equal(findPath('plaza',{x:8,y:5},{x:10,y:5},{maxSteps:3}),null);
  assert.equal(isWalkable('plaza',{x:8.5,y:5}),false);
});
test('v019 run exhaustion stops where energy ran out and never silently switches to walking',t=>{
  const f=fixture(t),p=f.make();f.raw(p).fatigue.energy=.03;
  assert.equal(f.act(p,'move',{x:14,y:8,mode:'run'}).status,'applied');f.advance(100);
  close(f.raw(p).position.x,11.1);assert.equal(f.raw(p).movement,null);assert.equal(f.raw(p).fatigue.energy,0);
  assert.equal(f.world.state.events.filter(e=>e.type==='movement_finished').at(-1).payload.reason,'exhausted');
  assert.equal(f.act(p,'move',{x:12,y:8,mode:'run'}).error.code,'FATIGUE_EXHAUSTED');
  assert.equal(f.act(p,'move',{x:12,y:8}).status,'applied');f.advance(500);assert.deepEqual(f.raw(p).position,{x:12,y:8});
});
test('v019 snapshot, camera sample and interactions use actual positions during movement',t=>{
  const f=fixture(t),p=f.make(),q=f.make();f.raw(p).position={x:14,y:8};f.raw(q).position={x:5,y:8};f.act(p,'move',{x:11,y:8});
  assert.equal(f.observe(p).nearby_agents.length,0);f.advance(1000);assert.equal(f.observe(p).nearby_agents.length,0);
  const a=f.observe(p).self,sampled=sampleMotion(a,f.now());close(sampled.position.x,a.position.x);
  const max=sampleMotion(a,f.now()+10000);assert.ok(metric(max.position,a.position)<=.5+1e-8,'prediction capped at 250ms');
  f.advance(500);assert.equal(f.observe(p).nearby_agents.length,1);
});
test('v019 attack prepares then resolves exactly once and exposes truthful impact and hurt',t=>{
  const f=fixture(t),p=f.make(),m=f.hunt(p);f.advance(100);
  const a=f.raw(p),id=a.action.action_id;assert.equal(a.action.outcome,null);assert.equal(actionPhase(a.action,f.now()),'prepare');assert.equal(m.hp,1000);
  f.advance(300);assert.equal(m.hp,1000);f.advance(100);
  assert.equal(m.hp,994);assert.equal(a.action.action_id,id);assert.equal(a.action.outcome,'hit');assert.equal(a.action.damage,6);assert.equal(m.hurt.action_id,id);
  f.world.tick();assert.equal(m.hp,994);assert.equal(f.world.state.events.filter(e=>e.payload.action_id===id).length,1);
  assert.equal(spectatorSnapshot(f.world).adventure.monsters[2].hurt.action_id,id);
});
test('v019 a target moving out of range during preparation is missed at actual impact',t=>{
  const f=fixture(t),p=f.make(),m=f.hunt(p);f.advance(100);
  recordMovement(m,[{x:20,y:7},{x:21,y:7}],f.now(),'run');f.advance(400);
  assert.equal(f.raw(p).action.outcome,'miss');assert.equal(m.hp,1000);assert.equal(f.raw(p).adventure.hp,1000);
});
test('v019 retreat or pause cancels preparation, without inventing another AI goal',t=>{
  for(const operation of ['stop','pause']){
    const f=fixture(t),p=f.make(),m=f.hunt(p);f.advance(100);
    if(operation==='stop')f.act(p,'adventure_plan',{intent:'stop'});else f.world.ownerControl(p.id,'pause');
    assert.equal(f.raw(p).action.outcome,'cancelled');f.advance(600);assert.equal(m.hp,1000);assert.equal(f.raw(p).adventure.plan,null);
  }
});
test('v019 late combat tick misses instead of replaying damage backlog',t=>{
  const f=fixture(t),p=f.make(),m=f.hunt(p);f.advance(100);const id=f.raw(p).action.action_id;
  f.jump(10000);assert.equal(m.hp,1000);assert.equal(f.raw(p).adventure.hp,1000);
  assert.equal(f.world.state.events.some(e=>e.payload.action_id===id),false);
});
test('v019 permission expiry and host lease end stop physical movement at the cutoff',t=>{
  for(const boundary of ['run','lease']){
    const f=fixture(t),p=f.make();f.act(p,'move',{x:14,y:8});
    if(boundary==='run')f.raw(p).run.expires_at=f.now()+250;else f.raw(p).last_contact_at=f.now()-44750;
    f.jump(1000);close(f.raw(p).position.x,11.5);assert.equal(f.raw(p).movement,null);assert.notEqual(f.raw(p).status,'active');
  }
});
test('v019 delayed movement settles fatigue at its actual cutoff then only idle-recovers in camp',t=>{
  for(const boundary of ['run','lease','arrival','run_exhaustion']) {
    const f=fixture(t),p=f.make(),a=f.raw(p);a.fatigue.energy=boundary==='run_exhaustion'?.105:50;
    f.act(p,'move',{x:12,y:8,...(boundary==='run_exhaustion'?{mode:'run'}:{})});
    if(boundary==='run')a.run.expires_at=f.now()+250;
    if(boundary==='lease')a.last_contact_at=f.now()-44750;
    f.jump(10000);
    const expected=boundary==='arrival'?52.4:boundary==='run_exhaustion'?2.67:52.55;
    close(a.fatigue.energy,expected);assert.equal(a.movement,null);
    close(a.position.x,boundary==='arrival'?12:boundary==='run_exhaustion'?11.35:11.5);
    f.world.tick();close(a.fatigue.energy,expected);
  }
});
test('v019 restart preserves a fractional legal location and cancels uncompleted work',t=>{
  const dir=mkdtempSync(join(tmpdir(),'v019-motion-'));const f=fixture(t,join(dir,'world.sqlite')),p=f.make();t.after(()=>rmSync(dir,{recursive:true,force:true}));
  f.act(p,'move',{x:14,y:8});f.advance(200);const before={...f.raw(p).position},energy=f.raw(p).fatigue.energy;
  f.restart();assert.deepEqual(f.raw(p).position,before);assert.equal(f.raw(p).fatigue.energy,energy);assert.equal(f.raw(p).movement,null);assert.equal(f.raw(p).action,null);assert.equal(f.raw(p).status,'offline');
});
test('v019 public timeline projection drops corrupt nested fields',t=>{
  const f=fixture(t),p=f.make();f.hunt(p);f.advance(100);f.raw(p).action.target_id={PRIVATE_SECRET:true};f.raw(p).hurt={action_id:{PRIVATE_SECRET:true},started_at:0,ends_at:1,damage:1};
  const snapshot=spectatorSnapshot(f.world);assert.equal(snapshot.agents[0].action,null);assert.equal(snapshot.agents[0].hurt,null);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_SECRET/);
});
test('v019 monster motion metadata and plan mode use a scalar public whitelist',t=>{
  const f=fixture(t),p=f.make(),m=f.hunt(p);f.advance(100);const secret={PRIVATE_MONSTER_METADATA:'never public'};
  m.position_at=secret;m.facing=secret;m.home_position.secret=secret;m.position.secret=secret;m.target_agent_id=secret;m.name=secret;m.behavior=secret;
  f.raw(p).adventure.plan.mode=secret;
  const snapshot=spectatorSnapshot(f.world),monster=snapshot.adventure.monsters[2];
  assert.equal(monster.position_at,undefined);assert.equal(monster.facing,'south');assert.equal(monster.target_agent_id,null);assert.equal(snapshot.agents[0].adventure.plan.mode,'walk');
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_MONSTER_METADATA|never public/);
});
test('v019 no spectators still advances patrols and an authorized plan; no replacement goal',t=>{
  const f=fixture(t),p=f.make();assert.equal(f.world.listenerCount('change'),0);const initial={...f.raw(p).position};
  f.act(p,'adventure_plan',{intent:'explore',zone_id:'camp',mode:'run'});f.advance(1000);
  assert.deepEqual(f.raw(p).position,initial);assert.equal(f.raw(p).adventure.plan,null);
  const m=f.world.state.adventure.monsters[0],home={...m.position};f.advance(2000);assert.notDeepEqual(m.position,home);assert.equal(Object.keys(f.world.state.agents).length,1);
});
