import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleGait,actorAnimationAction,gatheringFrameTime,actorVisualPose,settlePose,STILL_POSE} from '../src/actor-motion.js';
import {actionPose,actorFacing,characterAction,monsterAction,animationFrame} from '../src/pixel-state.js';

const actor={agent_id:'a',status:'active',scene_id:'plaza',position:{x:5,y:5},position_at:1000,facing:'east'};
const move=(extra={})=>({...actor,movement:{version:2,movement_id:'m1',scene_id:'plaza',path:[{x:5,y:5},{x:6,y:5},{x:7,y:5},{x:8,y:5}],mode:'walk',speed:2,started_at:1000,ends_at:2500,duration_ms:1500},...extra});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('gait follows real distance rather than frame count, server packet count or a fixed walking speed',()=>{
  const fast=move({position_at:1500}),slow=move({position_at:2000});slow.movement={...slow.movement,speed:1,ends_at:4000};
  close(sampleGait(fast,1500).phase,sampleGait(slow,2000).phase);
  const first=sampleGait(fast,1400),next=sampleGait({...fast,position:{x:6,y:5}},1500,first.state);
  close(next.phase,sampleGait(fast,1500).phase);
  const repeat=sampleGait(fast,1500,next.state);close(repeat.phase,next.phase);
  assert.deepEqual(fast.position,{x:5,y:5},'presentation cannot settle or teleport the actor');
});

test('a short contiguous move/turn keeps the previous step, while portal transfers reset the local odometer',()=>{
  const first=sampleGait(move({position_at:1300}),1300);
  const turned=move({position_at:1400,movement:{version:2,movement_id:'m2',scene_id:'plaza',path:[{x:5.6,y:5},{x:6,y:5},{x:6,y:6}],mode:'walk',speed:2,started_at:1300,ends_at:2000}});
  close(sampleGait(turned,1400,first.state).phase,sampleGait(move({position_at:1400}),1400).phase);
  const transferred={...turned,scene_id:'adventure',movement:{...turned.movement,scene_id:'adventure'}};
  close(sampleGait(transferred,1400,first.state).phase,.2/1.25);
  const sprint={...turned,position_at:1300,movement:{...turned.movement,mode:'run',speed:3.5}};
  close(sampleGait(sprint,1300,first.state).phase,first.phase,'changing into a run retains the current supporting foot');
});

test('stale, paused and scene-mismatched motion cannot continue a gait or a body bob',()=>{
  const moving=move(),initial=sampleGait(moving,1200);
  for(const stale of [moving,{...moving,status:'paused'},{...moving,movement:{...moving.movement,scene_id:'adventure'}}]){
    const now=stale===moving?1400:1200;
    assert.equal(sampleGait(stale,now,initial.state).moving,false);
    assert.deepEqual(actorVisualPose(stale,'walk',now,{gaitPhase:.3}),STILL_POSE);
  }
  assert.deepEqual(actorVisualPose(moving,'walk',1200,{gaitPhase:.3,enabled:false}),STILL_POSE);
});

test('a replan behind a predicted point does not count visual reconciliation as another physical step',()=>{
  // Last server position was 5.4 at 1200; the screen predicted to 5.8 at 1400.
  // The AI cancelled at the true 5.6 point and backtracked before turning north.
  const predicted=sampleGait(move({position_at:1200}),1400);
  const replanned=move({position_at:1400,movement:{version:2,movement_id:'replan',scene_id:'plaza',path:[{x:5.6,y:5},{x:5,y:5},{x:5,y:4}],mode:'walk',speed:2,started_at:1300,ends_at:2100}});
  const actual=sampleGait(replanned,1400,predicted.state);
  close(actual.state.distance,.8); // .6 on old path, .2 on the accepted new path.
  close(actual.phase,.8/1.25);
  const teleported={...replanned,movement:{...replanned.movement,path:[{x:5.6,y:5.4},{x:5.6,y:4.4}]}};
  close(sampleGait(teleported,1400,predicted.state).state.distance,.2,'off-path corrections do not inherit imaginary travelled distance');
});

test('a real position_at tick does not reset the gait and species changes only the visual weight',()=>{
  let state=null,last=0;
  for(let now=1100;now<=1500;now+=100){
    const current=move({position_at:now,position:{x:5+(now-1000)*.002,y:5}}),sample=sampleGait(current,now,state);
    assert.ok(sample.state.distance>last);close(sample.state.distance,(now-1000)*.002);state=sample.state;last=sample.state.distance;
  }
  const at=move({status:'alive',position_at:1200});
  const slime=actorVisualPose({...at,monster_id:'forest_slime'},'walk',1200,{gaitPhase:.25});
  const stone=actorVisualPose({...at,monster_id:'ruins_guardian'},'walk',1200,{gaitPhase:.25});
  assert.ok(slime.y<stone.y,'slime hops higher than a heavy guardian');
  assert.deepEqual(at.position,{x:5,y:5});
});

test('anticipation never becomes a thrust until the authoritative hit time; misses and cancellation never thrust',()=>{
  const pending={...actor,action:{type:'attack',action_id:'swing',scene_id:'plaza',facing:'east',started_at:1000,impact_at:1400,ends_at:2000,outcome:null}};
  const late=actorVisualPose(pending,'attack',1700,{facing:'east'});
  assert.ok(late.x<=0);assert.equal(actionPose(pending,'attack',1700).frame,1);
  const hit={...pending,action:{...pending.action,outcome:'hit',resolved_at:1700}};
  assert.ok(actorVisualPose(hit,'attack',1755,{facing:'east'}).x>1);
  assert.ok(actorVisualPose(hit,'attack',1650,{facing:'east'}).x<=0,'future receipt cannot start recoil/strike early');
  assert.equal(actionPose(hit,'attack',1650).frame,1);
  const miss={...hit,action:{...hit.action,outcome:'miss'}};
  for(let now=1700;now<2000;now+=10)assert.ok(actorVisualPose(miss,'attack',now,{facing:'east'}).x<=0);
  assert.deepEqual(actorVisualPose({...hit,action:{...hit.action,outcome:'cancelled'}},'attack',1755),STILL_POSE);
  assert.deepEqual(actorVisualPose(hit,'attack',2000),STILL_POSE);
});

test('hurt and moving monsters use real deadlines; continuous recoil returns to the same foot without changing health',()=>{
  const hurt={...actor,status:'alive',monster_id:'forest_slime',hp:12,hurt:{action_id:'actual-hit',started_at:1000,ends_at:1360,damage:3}};
  assert.deepEqual(actorVisualPose(hurt,'hurt',999),STILL_POSE);
  assert.deepEqual(actorVisualPose(hurt,'hurt',1360),STILL_POSE);
  const frames=Array.from({length:37},(_,i)=>actorVisualPose(hurt,'hurt',1000+i*10,{facing:'east'}));
  assert.ok(frames.some(p=>p.x<-.7));
  for(let i=1;i<frames.length;i++)assert.ok(Math.abs(frames[i].x-frames[i-1].x)<.25,'no full-pose jump between close samples');
  assert.equal(hurt.hp,12);assert.equal(hurt.hurt.damage,3);
});

test('gathering starts at physical work time on every observation and never animates approach or a completed job',()=>{
  const job={job_id:'j',phase:'working',tool_id:'axe',started_at:1000,work_started_at:3000,ends_at:7000};
  const worker={...actor,life:{gathering:job}};
  assert.notEqual(characterAction(worker,[],2999),'gather');
  assert.deepEqual(actionPose(worker,'gather',2999),{});
  assert.deepEqual(actorVisualPose(worker,'gather',2999),STILL_POSE);
  assert.equal(characterAction(worker,[],3000),'gather');
  assert.equal(actionPose(worker,'gather',3500).elapsed,500);
  assert.deepEqual(actionPose(structuredClone(worker),'gather',3500),actionPose(worker,'gather',3500));
  const approach={...worker,life:{gathering:{...job,phase:'approaching'}}};
  assert.notEqual(characterAction(approach,[],3500),'gather');assert.deepEqual(actorVisualPose(approach,'gather',3500),STILL_POSE);
  assert.equal(characterAction(worker,[],7000),'idle');assert.deepEqual(actorVisualPose(worker,'gather',7000),STILL_POSE);
  assert.notEqual(characterAction({...worker,life:{gathering:{...job,phase:'cancelled'}}},[],3500),'gather');
  assert.notDeepEqual(actorVisualPose(worker,'gather',3200),actorVisualPose(worker,'gather',3500));
  const receipt={type:'life_watered',occurred_at:3100,payload:{agent_id:'a'}};
  assert.equal(actionPose(actor,'water',3500,[receipt]).elapsed,400,'one-shot receipts also survive observer remount');
});

test('expired combat facing cannot make a moving actor or monster run backwards',()=>{
  const travelling=move({position_at:1700,action:{type:'attack',facing:'north',started_at:500,impact_at:700,ends_at:900,outcome:'hit'},status:'alive',monster_id:'forest_boar'});
  assert.equal(monsterAction(travelling,[],1700),'walk');assert.equal(actorFacing(travelling,'walk',1700),'east');
  const attacking={...travelling,action:{...travelling.action,started_at:1600,impact_at:1900,ends_at:2200,outcome:null}};
  assert.equal(actorFacing(attacking,'attack',1700),'north');
});

test('bare-hand gathering uses a low picking pose, but axe and pickaxe keep standing work without changing the public action',()=>{
  for(const tool of [null,'axe','pickaxe']){
    const worker={...actor,life:{gathering:{job_id:'j',phase:'working',tool_id:tool,started_at:1000,work_started_at:1000,ends_at:7000}}};
    assert.equal(characterAction(worker,[],1500),'gather');
    assert.equal(actorAnimationAction(worker,'gather'),tool?'gather':'plant');
    assert.equal(actorAnimationAction(worker,'attack'),'attack');
    assert.equal(actorAnimationAction(worker,'water'),'water');
  }
  const bare={...actor,life:{gathering:{tool_id:null}}},source={animations:{plant:{loop:false,frames:[{x:1,duration:150},{x:2,duration:150},{x:3,duration:150},{x:4,duration:150}]}}};
  assert.equal(animationFrame(source,'plant',gatheringFrameTime(bare,900+100,source,'plant')).x,1,'second picking cycle must not clamp to standing');
  assert.equal(animationFrame(source,'plant',gatheringFrameTime(bare,900+800,source,'plant')).x,4,'each picking cycle still has a real recovery');
});

test('ending a pose settles over a bounded interval, then becomes completely still',()=>{
  const start=settlePose(null,'run',{x:0,y:-1.4,rotation:.04,scaleX:1,scaleY:1},1000);
  const stop=settlePose(start.state,'idle',STILL_POSE,1010);
  assert.deepEqual(stop.pose,start.pose);
  const half=settlePose(stop.state,'idle',STILL_POSE,1065);assert.ok(half.pose.y<0&&half.pose.y>start.pose.y);
  assert.deepEqual(settlePose(half.state,'idle',STILL_POSE,1120).pose,STILL_POSE);
});
