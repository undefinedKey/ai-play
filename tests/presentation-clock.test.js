import test from 'node:test';
import assert from 'node:assert/strict';
import {World} from '../server/world.js';
import {spectatorSnapshot} from '../server/spectator.js';
import {snapshotDelta} from '../server/snapshot-delta.js';
import {mergeSpectatorDelta} from '../src/spectator-frame.js';
import {snapshotPresentationTime,samplePresentationClock} from '../src/presentation-clock.js';
import {sampleMotion} from '../shared/motion.js';

function trace(t,jitter=[0]) {
  const epoch=2000000000000;let now=epoch;
  const world=new World({now:()=>now,actionIntervalMs:0});t.after(()=>world.close());
  const a=world.createAgent({name:'移动时钟验证'}),c=world.createController(a.agent_id);
  world.ownerControl(a.agent_id,'start',{controller_id:c.controller_id,duration_minutes:60,max_calls:100});
  const auth=world.authenticate(c.token),j=world.callTool(auth,'join_world'),session={run_id:j.run_id,session_epoch:j.session_epoch};
  const actor=world.agent(a.agent_id);actor.position={x:7,y:8};actor.position_at=now;
  const observed=world.callTool(auth,'observe',session);
  assert.equal(world.callTool(auth,'act',{...session,action_id:observed.next_action_id,type:'survival',payload:{intent:'approach',site_id:'plaza_hearth',mode:'run'}}).status,'applied');
  const packets=[];
  for(let tick=0;tick<=2200;tick+=100){
    now=epoch+tick;world.tick();
    if(tick%200===0){now+=90;const snapshot=spectatorSnapshot(world);packets.push({at:tick+110+jitter[packets.length%jitter.length],snapshot});}
  }
  let index=-1,clock=null,last=null;const rows=[];
  for(let time=110;time<2150;time+=1000/60){
    while(index+1<packets.length&&packets[index+1].at<=time)index++;
    if(index<0)continue;
    const packet=packets[index],visible=packet.snapshot.agents.find(x=>x.agent_id===a.agent_id);
    clock=samplePresentationClock(clock,{serverTime:snapshotPresentationTime(packet.snapshot),receivedAt:epoch+packet.at,localTime:epoch+time,actor:visible});
    const sample=sampleMotion(visible,clock.time);
    rows.push({clock:clock.time,at:time,moving:sample.moving,backward:last!==null&&clock.time<last});last=clock.time;
  }
  return {packets,rows,world};
}

test('100ms模拟与200ms广播相位错开时，真实长路线的显示不周期性冻成idle',t=>{
  const {rows,packets}=trace(t);
  assert.ok(packets.every(p=>p.snapshot.server_time-p.snapshot.agents[0].position_at>=90));
  assert.equal(rows.filter(r=>!r.moving).length,0,'发送时间晚于实际位置，不能提前吃掉250ms预测窗口');
});

test('同一持续移动遇到延迟变化，显示时钟不倒退且校正速度有界',t=>{
  const {rows}=trace(t,[0,60,0,40]);
  assert.equal(rows.filter(r=>r.backward).length,0);
  for(let i=1;i<rows.length;i++)assert.ok(rows[i].clock-rows[i-1].clock<=(rows[i].at-rows[i-1].at)*1.1+.001);
});

test('实际包间隔208ms且展示时钟领先109ms时，逐步减速不会自造预测过期站姿',()=>{
  const actor={status:'active',scene_id:'plaza',position:{x:0,y:0},position_at:0,movement:{version:2,scene_id:'plaza',path:[{x:0,y:0},{x:3,y:0}],speed:2,started_at:0,ends_at:1500}};
  let clock={time:109,localTime:0,uninterrupted:true};
  for(let localTime=16;localTime<=208;localTime+=16){
    const prior=clock;
    clock=samplePresentationClock(prior,{serverTime:0,receivedAt:0,localTime,actor});
    assert.ok(clock.time>=prior.time+(localTime-prior.localTime)*.5-1e-8,'减速仍连续前进，不倒退或硬冻结');
    assert.ok(clock.time<=prior.time+(localTime-prior.localTime)*1.1+1e-8,'不加速追跳');
    assert.equal(sampleMotion(actor,clock.time).moving,true,'正常208ms消息间隔不能因旧时钟领先而切回站姿');
  }
  assert.ok(clock.time-208<20,'在下一包之前偿还大部分领先量');
  const disconnected=samplePresentationClock(clock,{serverTime:0,receivedAt:0,localTime:500,actor});
  assert.equal(sampleMotion(actor,disconnected.time).frozen,true,'真实消息停顿仍触发250ms预测边界');
});

test('公开与主人快照的模拟时间经delta保留，查询本身不推进模拟',t=>{
  const {packets,world}=trace(t);const [a,b]=packets.map(p=>p.snapshot);
  assert.ok(Number.isFinite(a.simulation_time));
  assert.deepEqual(mergeSpectatorDelta(a,snapshotDelta(a,b)),b);
  assert.equal(world.ownerSnapshot().simulation_time,world.simulationTime);
  const before=world.simulationTime;world.publicSnapshot();spectatorSnapshot(world);assert.equal(world.simulationTime,before);
});

test('迟到的新受击或攻击立即对齐权威时钟，不被运动缓调跳过',()=>{
  const prior={time:2000,localTime:2000,uninterrupted:true};
  for(const reaction of [{hurt:{started_at:1600,ends_at:1900}},{action:{started_at:1600,impact_at:1700,ends_at:1900}}]){
    const clock=samplePresentationClock(prior,{serverTime:1600,receivedAt:2016,localTime:2016,actor:{movement:{version:2},...reaction}});
    assert.equal(clock.time,1600);assert.equal(clock.uninterrupted,false);
  }
});

test('旧服务兼容、异常模拟时间与真正时钟重置不延长移动预测窗口',()=>{
  for(const simulation_time of [undefined,Infinity,5001,1000])assert.equal(snapshotPresentationTime({server_time:5000,simulation_time}),5000);
  assert.equal(snapshotPresentationTime({server_time:5000,simulation_time:4900}),4900);
  const actor={status:'active',scene_id:'plaza',position:{x:0,y:0},position_at:1000,movement:{version:2,scene_id:'plaza',path:[{x:0,y:0},{x:3,y:0}],speed:2,started_at:1000,ends_at:2500}};
  const clock=samplePresentationClock({time:5000,localTime:2000,uninterrupted:true},{serverTime:1000,receivedAt:2000,localTime:2016,actor});
  assert.equal(clock.time,1016);
  assert.equal(sampleMotion(actor,1400).frozen,true);
  assert.equal(sampleMotion(actor,1400).position.x,.5);
});
