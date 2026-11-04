import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { actInputSchema, communityPayloadSchema } from '../server/mcp.js';
import { COMMUNITY_RULES, validCommunity } from '../skills/ai-plaza/scripts/community-contract.mjs';
import { featureProtocol, relevantFeatureEvent } from '../skills/ai-plaza/scripts/feature-protocols.mjs';
import { communityDecisionPrompt, communityFocus } from '../skills/ai-plaza/scripts/community-context.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';

function fixture(t) {
  const world = new World({now:()=>1000000,actionIntervalMs:0});t.after(()=>world.close());
  const actor=world.createAgent({name:'原来的来客'}),controller=world.createController(actor.agent_id);
  world.ownerControl(actor.agent_id,'start',{controller_id:controller.controller_id,max_calls:100,goal:'我想自己决定今天做什么'});
  const auth=world.authenticate(controller.token);world.callTool(auth,'join_world',{});
  const a=world.agent(actor.agent_id);
  const context=()=>({observation:world.callTool(auth,'observe',{run_id:a.run.run_id,session_epoch:a.session_epoch}),rules:world.getRules(),ownerGoal:a.goal,events:[]});
  return {world,a,auth,context};
}
const action=payload=>({type:'community',payload});

test('community shared contract, portable runner and MCP accept exactly the same action fields',()=>{
  const good=[{intent:'browse',page:0},{intent:'approach',venue_id:'stage',mode:'run'},
    {intent:'use',seat_id:'table_west',activity:'eat',item_id:'berry'},
    {intent:'use',seat_id:'stage_speaker',activity:'perform',title:'今天的树',text:'风在叶子之间绕了一圈。',duration_seconds:15},
    {intent:'cancel_use'},{intent:'post',venue_id:'picnic',title:'野餐',text:'有空可以来，也可以不来。',duration_seconds:300},
    {intent:'join',event_id:'gathering_1',revision:1},{intent:'start',event_id:'gathering_1',revision:1},
    ...['leave','end','cancel'].map(intent=>({intent,event_id:'gathering_1'}))];
  const bad=[{intent:'browse',page:10},{intent:'browse',page:0,force:true},{intent:'join',event_id:'gathering_1',revision:2},
    {intent:'use',seat_id:'table_west',activity:'perform',title:'wrong',text:'wrong'},
    {intent:'use',seat_id:'table_west',activity:'eat'},{intent:'use',seat_id:'table_west',activity:'sit',item_id:'berry'},
    {intent:'use',seat_id:'stage_speaker',activity:'perform',title:'ok',text:'😀'.repeat(401)},
    {intent:'cancel_use',event_id:'gathering_1'},{intent:'post',venue_id:'board',title:'x',text:'x',duration_seconds:60},
    {intent:'approach',venue_id:'stage',x:29},{intent:'use',seat_id:'stage_speaker',activity:'perform',title:'x',text:'x',duration_seconds:121}];
  for(const [values,expected] of [[good,true],[bad,false]])for(const payload of values){
    assert.equal(validCommunity(payload),expected,JSON.stringify(payload));
    assert.equal(featureProtocol('community').validate(payload),expected);
    assert.equal(communityPayloadSchema.safeParse(payload).success,expected);
    assert.equal(actInputSchema.safeParse({run_id:'r',session_epoch:1,action_id:'a',...action(payload)}).success,expected);
    if(expected)assert.deepEqual(parseModelAction(JSON.stringify(action(payload))),action(payload));
    else assert.throws(()=>parseModelAction(JSON.stringify(action(payload))),{code:'INVALID_MODEL_OUTPUT'});
  }
});

test('chosen reading exposes real venues and reversible seat references without changing original goal',t=>{
  const f=fixture(t),ctx=f.context();ctx.lastActionFeedback={type:'community',status:'applied',requested:{intent:'browse',page:0}};
  ctx.events=[{type:'message',payload:{agent_id:'visitor',channel:'nearby',text:'今天我不想参加。'}}];
  const before=structuredClone(ctx),p=prepareDecisionPrompt(ctx);
  assert.ok(p.text.length<=2000);assert.match(p.text,/公共场地数据/);assert.ok(p.text.includes(ctx.ownerGoal));assert.ok(p.text.includes(ctx.events[0].payload.text));assert.match(p.text,/wait/);
  const data=JSON.parse(p.text.split('公共场地数据：')[1]);assert.equal(data.venues.length,4);
  if(data.seats){const seat=data.seats.find(row=>p.references[row[0]]==='table_west');assert.ok(seat);assert.deepEqual(JSON.parse(expandDecisionReferences(JSON.stringify(action({intent:'use',seat_id:seat[0],activity:'sit'})),p.references)),action({intent:'use',seat_id:'table_west',activity:'sit'}));}
  assert.deepEqual(ctx,before);
});

test('a chosen finite stage action fits long original goal and message, retains real last torch and body risk',t=>{
  const f=fixture(t),ctx=f.context();ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  ctx.observation.self.community_job={job_id:'real',kind:'use',venue_id:'stage',seat_id:'stage_speaker',phase:'using',activity:'perform',ends_at:1030000,expires_at:1100000,title:'作品',text:'😀'.repeat(400)};
  ctx.observation.self.survival={satiety:7,light:{lit:false,danger_in_seconds:12},torch:{lit:false,fuel_seconds:73}};
  const p=prepareDecisionPrompt(ctx);assert.ok(p.text.length<=2000);assert.ok(p.text.includes(ctx.ownerGoal));assert.ok(p.text.includes(ctx.events[0].payload.text));
  const data=JSON.parse(p.text.split('公共场地数据：')[1]);assert.equal(data.torch.fuel_seconds,73);assert.equal(data.light.danger_in_seconds,12);assert.equal(data.body[3],7);assert.match(p.text,/cancel_use/);assert.equal(data.job.activity,'perform');
});

test('unrelated gathering announcements never force a decision or replace another current activity',t=>{
  const f=fixture(t),ctx=f.context();ctx.lastActionFeedback={type:'community',status:'applied',requested:{intent:'browse',page:0}};
  ctx.observation.self.activity={activity_id:'read',started_at:1000000,ends_at:1030000};assert.equal(communityFocus(ctx),false);
  const events=[{event_id:'other',type:'community_event_changed',payload:{event:{host_agent_id:'other',member_agent_ids:['other']}}},
    {event_id:'mine',type:'community_event_changed',payload:{event:{host_agent_id:'other',member_agent_ids:[f.a.agent_id]}}},
    {event_id:'step',type:'community_approaching',payload:{agent_id:f.a.agent_id}},
    {event_id:'done',type:'community_use_finished',payload:{agent_id:f.a.agent_id}},
    {event_id:'left',type:'community_event_changed',payload:{agent_id:f.a.agent_id,event:{host_agent_id:'other',member_agent_ids:['other']}}}];
  assert.deepEqual(enqueueEvents({seen:[],queue:[]},[...events,...events],f.a.agent_id).queue.map(e=>e.event_id),['mine','done','left']);
  assert.equal(relevantFeatureEvent({type:'movement_finished'},f.a.agent_id),null);
});

test('oversized explicit event reading falls back without inventing consent or dropping original message',t=>{
  const f=fixture(t),ctx=f.context();ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  ctx.lastActionFeedback={type:'community',status:'applied',requested:{intent:'browse',page:0}};
  ctx.observation.community.events=[1,2].map(n=>({event_id:`gathering_${n}`,revision:1,venue_id:'picnic',host_agent_id:`peer_${n}`,status:'open',title:'😀'.repeat(40),text:'😀'.repeat(200),expires_at:1100000}));
  const p=prepareDecisionPrompt(ctx);assert.ok(p.text.length<=2000);assert.ok(p.text.includes(ctx.ownerGoal));assert.ok(p.text.includes(ctx.events[0].payload.text));
  assert.ok(!p.references?.['@C1']);assert.ok(!p.text.includes('gathering_1'));assert.match(p.text,/wait/);
});

test('runtime schedules completion or bounded reconsideration of actual community work with unchanged capability cap',t=>{
  const f=fixture(t),runner=new PlazaRunner({mode:'model',now:()=>1000000});
  runner.rules=f.world.getRules();runner.tools=new Set(['report_connection']);runner.observation=f.context().observation;
  runner.observation.self.community_job={phase:'approaching',expires_at:1030000,ends_at:null};assert.equal(runner.waitingReason(),'plan_running');
  runner.observation.self.community_job.phase='using';assert.equal(runner.waitingReason(),'activity_running');assert.ok(runner.capabilities().length<=16);
  assert.ok(COMMUNITY_RULES.venues.length===4);
});
