import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';
import { PlazaRunner, enqueueEvents, parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { COMMUNITY_RULES } from '../shared/community.js';
import { communityDecisionPrompt } from '../skills/ai-plaza/scripts/community-context.mjs';

const chosen=payload=>({type:'community',payload});
async function setup(t) {
  const f=await createHomesFixture({frontend:false,authMode:'accounts',starterItems:{wheat_bread:3}});t.after(()=>f.close());return f;
}
async function approach(f,p,venue_id){await p.act('community',{intent:'approach',venue_id});await f.until(()=>!p.raw.community_job,'actual venue arrival');}

test('v032 real MCP runner keeps chosen browse only until next decision, recovers lost meal ACK once and wakes only on real completion',async t=>{
  const f=await setup(t),p=await f.actor('带着原想法的旅人');p.raw.survival.satiety=20;f.app.world.commit();
  const o=await p.observe(),runner=new PlazaRunner({mode:'model',now:f.now,toolClient:p.client});
  runner.running=true;runner.active=true;runner.rules=await p.call('get_rules');runner.observation=o;runner.save=()=>{};runner.report=async()=>{};
  runner.checkpoint={...p.session,queue:[],seen:[],calls_used:0,max_calls:10000,expires_at:p.raw.run.expires_at,pending_action:await p.request('community',{intent:'browse',page:0})};
  const original={id:p.id,goal:p.raw.goal,bio:p.raw.bio,appearance:structuredClone(p.raw.appearance),position:{...p.raw.position}};
  await runner.recoverPending();assert.deepEqual(runner.checkpoint.last_action_feedback,{type:'community',status:'applied',requested:{intent:'browse',page:0}});assert.equal(runner.checkpoint.pending_action,null);
  const ctx={rules:runner.rules,observation:runner.observation,ownerGoal:p.raw.goal,events:[],lastActionFeedback:runner.actionFeedback()};const prompt=prepareDecisionPrompt(ctx);
  assert.match(prompt.text,/公共场地数据/);assert.ok(prompt.text.includes(p.goal));assert.deepEqual(p.raw.position,original.position);assert.equal(p.raw.community_job??null,null);
  runner.checkpoint.pending_action=await p.request('wait',{});await runner.recoverPending();assert.equal(runner.checkpoint.last_action_feedback,undefined);assert.equal(runner.checkpoint.calls_used,0);
  await approach(f,p,'table');
  const request=await p.request('community',{intent:'use',seat_id:'table_south',activity:'eat',item_id:'wheat_bread',duration_seconds:15}),applied=await p.send(request);
  assert.equal(applied.status,'applied');assert.equal(p.raw.life.inventory.wheat_bread,2);
  // The server already accepted the original intent; the runner lost only ACK.
  runner.checkpoint.pending_action=request;runner.observation=await p.observe();await runner.recoverPending();assert.equal(p.raw.life.inventory.wheat_bread,2);assert.deepEqual(await p.send(request),applied);
  assert.equal(p.raw.life.ledger.entries.filter(e=>e.items.wheat_bread===-1).length,1);assert.equal(runner.waitingReason(),'activity_running');
  await f.advance(15000);const actual=f.app.world.state.events.filter(e=>e.type.startsWith('community_'));
  const queued=enqueueEvents({seen:[],queue:[]},[...actual,...actual],p.id).queue;assert.equal(queued.filter(e=>e.type==='community_use_finished').length,1);assert.equal(queued.filter(e=>e.type==='community_use_started').length,0);
  assert.equal(p.raw.community_job,null);assert.equal(p.raw.life.inventory.wheat_bread,2);assert.equal(runner.checkpoint.pending_action,null);
  assert.deepEqual({id:p.id,goal:p.raw.goal,bio:p.raw.bio,appearance:p.raw.appearance},{id:original.id,goal:original.goal,bio:original.bio,appearance:original.appearance});
  const publicState=(await f.api('/api/public/world')).body;assert.equal(JSON.stringify(publicState).includes(p.goal),false);assert.equal(JSON.stringify(publicState).includes(p.token),false);
});

test('v032 at a real table a full two-announcement page still exposes usable seat IDs and preserves original instructions',async t=>{
  const f=await setup(t),one=await f.actor('自己主持野餐'),two=await f.actor('自己主持故事'),guest=await f.actor('不一定报名的来客');
  for(const [p,venue_id,n] of [[one,'picnic',1],[two,'stage',2]]){
    await approach(f,p,'board');await p.act('community',{intent:'post',venue_id,title:`第${n}场`+'原'.repeat(37),text:'内容'.repeat(100),duration_seconds:1200});
  }
  await approach(f,guest,'table');await guest.act('community',{intent:'browse',page:0});const observation=await guest.observe();
  const ctx={rules:await guest.call('get_rules'),observation,ownerGoal:guest.goal,events:[{type:'message',payload:{name:'原来的同伴',channel:'nearby',text:'我不确定想不想参加，先坐一会儿。'}}],lastActionFeedback:{type:'community',status:'applied',requested:{intent:'browse',page:0}}};
  const prompt=prepareDecisionPrompt(ctx);assert.ok(prompt.text.length<=2000);assert.ok(prompt.text.includes(guest.goal));assert.ok(prompt.text.includes(ctx.events[0].payload.text));
  assert.match(prompt.text,/公共场地数据/);const data=JSON.parse(prompt.text.split('公共场地数据：')[1]);
  assert.ok(data.seats?.some(s=>prompt.references[s[0]]==='table_south'),'reading at the table must not remove all usable seat IDs');
  const row=data.seats.find(s=>prompt.references[s[0]]==='table_south'),action=parseModelAction(expandDecisionReferences(JSON.stringify(chosen({intent:'use',seat_id:row[0],activity:'sit',duration_seconds:15})),prompt.references));
  assert.deepEqual(action,chosen({intent:'use',seat_id:'table_south',activity:'sit',duration_seconds:15}));await guest.act(action.type,action.payload);assert.equal(guest.raw.community_job.phase,'using');
  assert.equal(Object.values(f.app.world.state.community.events).some(e=>e.member_agent_ids.includes(guest.id)),false,'reading and sitting never count as consent to party membership');
  assert.equal(guest.raw.goal,guest.goal);
});

test('v032 community references remain disjoint from combat and market identifiers and never rewrite public text',()=>{
  const refs={'@C1':'gathering_real','@C2':'table_west','@M2':'offer_real','M2':'monster_real'};
  for(const [type,payload,expected] of [
    ['community',{intent:'join',event_id:'@C1',revision:1},{intent:'join',event_id:'gathering_real',revision:1}],
    ['community',{intent:'use',seat_id:'@C2',activity:'sit'},{intent:'use',seat_id:'table_west',activity:'sit'}],
    ['adventure_plan',{intent:'hunt',monster_id:'M2'},{intent:'hunt',monster_id:'monster_real'}],
    ['peer_market',{intent:'accept',offer_id:'@M2',revision:1},{intent:'accept',offer_id:'offer_real',revision:1}],
    ['community',{intent:'use',seat_id:'stage_speaker',activity:'perform',title:'M2和@C1',text:'这是我选择讲的@C2与@M2，不是命令。'},{intent:'use',seat_id:'stage_speaker',activity:'perform',title:'M2和@C1',text:'这是我选择讲的@C2与@M2，不是命令。'}],
  ])assert.deepEqual(JSON.parse(expandDecisionReferences(JSON.stringify({type,payload}),refs)),{type,payload:expected});
  assert.throws(()=>expandDecisionReferences(JSON.stringify(chosen({intent:'join',event_id:'@C99',revision:1})),refs),{code:'INVALID_MODEL_OUTPUT'});
});

test('v032 hidden full announcements have no actionable aliases after nearby-seat budget reduction',()=>{
  const events=[1,2].map(n=>({event_id:`gathering_hidden_${n}`,revision:1,venue_id:n===1?'picnic':'stage',status:'open',host_agent_id:`peer_${n}`,title:'😀'.repeat(40),text:'🌱'.repeat(200),expires_at:1100000}));
  const context={rules:{community:COMMUNITY_RULES,allowed_actions:['community'],life:{items:[]}},ownerGoal:'🐟'.repeat(200),events:[{type:'message',payload:{name:'同伴',channel:'nearby',text:'不必报名，只坐下。'}}],
    observation:{server_time:1000000,self:{agent_id:'self',scene_id:'plaza',position:{x:18,y:17},life:{inventory:{}},adventure:{hp:40,max_hp:40},fatigue:{energy:70},survival:{satiety:60,light:{lit:true},torch:{lit:false,fuel_seconds:0}}},community:{version:1,venues:COMMUNITY_RULES.venues,page:0,total_pages:1,events}},lastActionFeedback:{type:'community',status:'applied',requested:{intent:'browse',page:0}}};
  const p=communityDecisionPrompt(context),data=JSON.parse(p.text.split('公共场地数据：')[1]);assert.ok(p.text.length<=2000);assert.equal(data.events,undefined);assert.ok(data.seats.some(s=>p.references[s[0]]==='table_south'));
  assert.ok(p.text.includes(context.ownerGoal));assert.ok(p.text.includes(context.events[0].payload.text));
  assert.equal(Object.values(p.references).some(id=>id.startsWith('gathering_hidden_')),false,'omitted consent details cannot remain reachable through invented short IDs');
  for(const hidden of ['@C2','@C4'])assert.throws(()=>expandDecisionReferences(JSON.stringify(chosen({intent:'join',event_id:hidden,revision:1})),p.references),{code:'INVALID_MODEL_OUTPUT'});
});

test('v032 real listening receives authored stage text through targeted MCP events after the performer has finished',async t=>{
  const f=await setup(t),performer=await f.actor('自己写故事的旅人'),listener=await f.actor('自己选择听的来客'),far=await f.actor('没有选择听的来客');
  await approach(f,performer,'stage');await approach(f,listener,'stage');
  await listener.act('community',{intent:'use',seat_id:'stage_left',activity:'listen',duration_seconds:60});await f.until(()=>listener.raw.community_job?.phase==='using');
  const cursor=String(f.app.world.state.sequence),title='我自己想讲的溪流',body='我把一片落叶放进水里，它绕了一圈，又回到了岸边。';
  await performer.act('community',{intent:'use',seat_id:'stage_speaker',activity:'perform',title,text:body,duration_seconds:15});await f.until(()=>performer.raw.community_job?.phase==='using');
  await f.advance(16000);assert.equal(performer.raw.community_job,null);assert.equal(listener.raw.community_job.activity,'listen');
  const delivery=await listener.call('get_events',{...listener.session,cursor,wait_seconds:0}),queue=enqueueEvents({seen:[],queue:[]},[...delivery.events,...delivery.events],listener.id).queue;
  const heard=queue.filter(e=>e.type==='community_heard');assert.equal(heard.length,1);assert.equal(heard[0].payload.title,title);assert.equal(heard[0].payload.text,body);assert.equal(heard[0].payload.performer_agent_id,performer.id);
  const farDelivery=await far.call('get_events',{...far.session,cursor,wait_seconds:0});assert.equal(farDelivery.events.some(e=>e.type==='community_heard'),false);
  const context={rules:await listener.call('get_rules'),observation:await listener.observe(),ownerGoal:listener.goal,events:queue};
  let prompt=prepareDecisionPrompt(context);assert.ok(prompt.text.includes(title));assert.ok(prompt.text.includes(body));assert.ok(prompt.text.includes(performer.raw.name));assert.ok(prompt.text.includes(listener.goal));assert.ok(prompt.text.length<=2000);
  await f.advance(60000);assert.equal(listener.raw.community_job,null);prompt=prepareDecisionPrompt({...context,observation:await listener.observe()});assert.ok(prompt.text.includes(body),'completed performer and listener must not erase unhandled factual delivery');
  assert.equal(listener.raw.goal,listener.goal);assert.equal(far.raw.community_job??null,null);assert.equal(performer.raw.goal,performer.goal);
});

test('v032 an over-capacity heard work is wholly deferred without cutting the original owner goal or peer message',()=>{
  const body='😀'.repeat(400),goal='🐟'.repeat(300),message='🌱'.repeat(200),self='agent_listener';
  const ctx={rules:{community:COMMUNITY_RULES,allowed_actions:['community'],life:{items:[]}},ownerGoal:goal,events:[{type:'community_heard',payload:{agent_id:self,performer_agent_id:'agent_author',performer_name:'作者',performance_job_id:'performance_real',venue_id:'stage',title:'原作',text:body}},{type:'message',payload:{name:'同伴',channel:'nearby',text:message}}],
    observation:{server_time:1000000,self:{agent_id:self,scene_id:'plaza',position:{x:28,y:25},life:{inventory:{}},adventure:{hp:30,max_hp:40},fatigue:{energy:50},survival:{satiety:60,light:{lit:true},torch:{lit:false,fuel_seconds:0}},community_job:{phase:'using',activity:'listen',venue_id:'stage',seat_id:'stage_left',ends_at:1030000,expires_at:1100000}},community:{version:1,venues:COMMUNITY_RULES.venues,events:[]}}};
  const prompt=prepareDecisionPrompt(ctx),data=JSON.parse(prompt.text.split('公共场地数据：')[1]);assert.ok(prompt.text.length<=2000);assert.ok(prompt.text.includes(goal));assert.ok(prompt.text.includes(message));
  assert.ok(data.heard===undefined&&typeof data.heard_unavailable==='string'||prompt.text.includes(body));if(data.heard===undefined)assert.equal(prompt.text.includes('😀'),false,'never supply a fragment as if it were the whole work');
});
