import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { publicMovement, publicPath, isWalkable } from '../server/spatial.js';
import { sampleMotion, metric } from '../shared/motion.js';
import { characterAction } from '../src/pixel-state.js';
import { confirmedPosition } from '../src/scene-state.js';

function fixture(t, position={x:11,y:8}) {
  const epoch=2_000_000_000_000;let now=epoch;
  const world=new World({now:()=>now,actionIntervalMs:0});t.after(()=>world.close());
  const a=world.createAgent({name:'连续行程验证'}),c=world.createController(a.agent_id);
  world.ownerControl(a.agent_id,'start',{controller_id:c.controller_id,duration_minutes:60,max_calls:1000});
  const auth=world.authenticate(c.token),joined=world.callTool(auth,'join_world',{}),session={run_id:joined.run_id,session_epoch:joined.session_epoch};
  const raw=world.agent(a.agent_id);Object.assign(raw,{position:{...position},position_at:now});
  const observe=()=>world.callTool(auth,'observe',session);
  const act=(type,payload)=>world.callTool(auth,'act',{...session,action_id:observe().next_action_id,type,payload});
  const advance=ms=>{const end=now+ms;while(now<end){now=Math.min(end,now+100);world.tick();}};
  return {world,raw,act,advance,epoch,now:()=>now};
}
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);

for(const [mode,origin] of [['run',{x:7,y:8}],['walk',{x:35,y:8}]]) {
  test(`accepted long ${mode} travel publishes real motion and animates between packets`,t=>{
    const f=fixture(t,origin),result=f.act('survival',{intent:'approach',site_id:'plaza_hearth',mode});
    assert.equal(result.status,'applied');assert.ok(f.raw.movement.path.length>6);
    if(mode==='walk')assert.ok(f.raw.movement.duration_ms>10000);
    const published=f.world.publicAgent(f.raw),speed=mode==='run'?3.5:2;
    assert.ok(published.movement,'a legal long trip must not become a stationary public actor');
    assert.equal(characterAction(published,[],f.now()+100),mode);
    close(metric(confirmedPosition(published,f.now()+100,true),origin),speed*.1);
    const stale=sampleMotion(published,f.now()+1000);
    assert.equal(stale.moving,false);close(metric(stale.position,origin),speed*.25);
    f.advance(100);close(metric(f.raw.position,origin),speed*.1);
    assert.ok(isWalkable('plaza',f.raw.position));
    const remaining=f.raw.movement.ends_at-f.now();
    f.advance(remaining);
    assert.deepEqual(f.raw.position,{x:13,y:11});assert.equal(f.raw.movement,null);assert.equal(f.raw.survival.travel,null);
    assert.equal(f.world.state.events.filter(event=>event.type==='survival_arrived').length,1,'arrival remains an actual once-only server receipt');
    f.advance(500);assert.deepEqual(f.raw.position,{x:13,y:11});
  });
}

test('long route publication still rejects corrupt geometry, timings and speed without widening manual action paths',t=>{
  const f=fixture(t,{x:35,y:8});f.act('survival',{intent:'approach',site_id:'plaza_hearth'});
  const original=structuredClone(f.raw.movement);
  assert.equal(publicPath('plaza',original.path),null,'short public action hints keep their existing bound');
  for(const corrupt of [
    m=>{m.path[1]={x:m.path[0].x+.2,y:m.path[0].y+.2};},
    m=>{m.duration_ms+=1;m.ends_at+=1;},m=>{m.speed=200;},
    m=>{m.path=Array.from({length:1600},(_,i)=>({x:11+i%2,y:8}));},
    m=>{m.scene_id='adventure';},m=>{m.ends_at=Infinity;},
  ]) {f.raw.movement=structuredClone(original);corrupt(f.raw.movement);assert.equal(publicMovement(f.raw),null);}
  f.raw.movement=original;f.raw.movement.path[0].PRIVATE_SECRET='not public';
  assert.doesNotMatch(JSON.stringify(publicMovement(f.raw)),/PRIVATE_SECRET/);
});

for(const mode of ['walk','run']) {
  test(`${mode} adventure route remains moving between healthy 200ms snapshots without one-tile idle cuts`,t=>{
    const f=fixture(t);assert.equal(f.act('adventure_plan',{intent:'explore',zone_id:'forest',mode}).status,'applied');
    const packets=[];
    for(let tick=0;tick<=3000;tick+=100){if(tick)f.advance(100);if(tick%200===0)packets.push({at:tick,actor:f.world.publicAgent(f.raw)});}
    let current=0,previous=null;const ids=new Set();
    for(let at=400;at<2800;at+=1000/60){
      while(current+1<packets.length&&packets[current+1].at<=at)current++;
      const actor=packets[current].actor,time=f.epoch+at;
      assert.equal(characterAction(actor,[],time),mode,`unexpected idle inside chosen travel at ${at}`);
      ids.add(actor.movement.movement_id);
      const point=confirmedPosition(actor,time,true);
      if(previous)close(metric(point,previous),(mode==='run'?3.5:2)/60);
      previous=point;
    }
    assert.equal(ids.size,1,'static destination retains its actual continuous route');
  });
}

test('a hunt replans from the settled position when its real target changes, then only attacks in real range',t=>{
  const f=fixture(t,{x:15,y:7});f.raw.scene_id='adventure';
  const monster=f.world.state.adventure.monsters[2];
  Object.assign(monster,{position:{x:20,y:7},movement:null,next_patrol_at:Infinity,aggro_radius:0});
  assert.equal(f.act('adventure_plan',{intent:'hunt',monster_id:monster.monster_id,mode:'run'}).status,'applied');
  f.advance(100);const old=f.raw.movement.movement_id;
  monster.position={x:20,y:9};f.advance(100);
  assert.notEqual(f.raw.movement.movement_id,old);
  assert.deepEqual(f.raw.movement.path[0],f.raw.position);
  assert.deepEqual(f.raw.movement.path.at(-1),monster.position);
  assert.equal(f.raw.action,null);assert.equal(monster.hp,monster.max_hp);
  const origin={...f.raw.position},energy=f.raw.fatigue.energy;f.advance(100);
  close(metric(f.raw.position,origin),.35);close(energy-f.raw.fatigue.energy,.105);
  for(let n=0;n<30&&!f.raw.action;n++)f.advance(100);
  assert.equal(f.raw.action?.type,'attack');assert.ok(metric(f.raw.position,monster.position)<=1+1e-8);
  assert.equal(f.raw.movement,null,'actual attack stops travel before windup');
});

test('stop and authorization cutoff still stop a long accepted adventure path at the actual point',t=>{
  for(const operation of ['stop','expiry']){
    const f=fixture(t);f.act('adventure_plan',{intent:'explore',zone_id:'forest',mode:'run'});f.advance(100);
    if(operation==='expiry')f.raw.run.expires_at=f.now()+250;
    else {f.advance(200);f.act('adventure_plan',{intent:'stop'});}
    const before={...f.raw.position};f.advance(1000);
    assert.equal(f.raw.movement,null);assert.equal(f.raw.adventure.plan,null);
    close(metric(f.raw.position,before),operation==='expiry'?.875:0);
  }
});
