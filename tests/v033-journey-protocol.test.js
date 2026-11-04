import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY_RULES, validJourney } from '../skills/ai-plaza/scripts/journey-contract.mjs';
import { journeyFocus, journeyNotice, journeyDecisionPrompt, supportsJourney } from '../skills/ai-plaza/scripts/journey-context.mjs';
import { featureProtocol } from '../skills/ai-plaza/scripts/feature-protocols.mjs';
import { journeyPayloadSchema, actInputSchema } from '../server/mcp.js';
import { PlazaRunner, enqueueEvents, parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient, prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const action = (intent, fields = {}) => ({type:'journey',payload:{intent,...fields}});
const read = p => JSON.parse(p.text.split('横版旅程数据：')[1]);
function context() {
  const now = 1000000;
  return { ownerGoal:'我想自己决定今天做什么，没想好也可以等。', events:[], rules:{journey:JOURNEY_RULES,allowed_actions:['journey','gather','inventory','say','wait'],life:{items:[{id:'berry',kind:'food',heal:4,energy_restore:2,satiety_restore:12}]},day_cycle:{night_work_duration_multiplier:1.25,night_work_energy_multiplier:1.2}},
    observation:{server_time:now,day_cycle:{phase:'day'},self:{agent_id:'me',scene_id:'journey',position:{x:12,y:16},adventure:{hp:31,max_hp:40},fatigue:{energy:57},survival:{satiety:21,light:{lit:true},danger_in_seconds:null,torch:{lit:false,fuel_seconds:63}},
      life:{inventory:{berry:2},tools:{axe:{owned:true,durability:29}},stats:{effective_attack:6,defense:0,range:1,attack_interval_ms:1000,attack_energy:3,move_energy_per_tile:.12}}},
      journey:{version:1,nodes:JOURNEY_RULES.nodes,monsters:JOURNEY_RULES.monsters.map(m=>({...m,hp:m.max_hp,status:'alive',target_agent_id:null})),
        resources:[{id:'journey_pine',scene_id:'journey',item_id:'wood',interaction_position:{x:12,y:16},stock:3,available:true,tool_id:'axe',duration_seconds:8,energy_cost:4,yield_count:2}],
        opportunities:[action('travel',{node_id:'clearing',route:'direct'}),action('travel',{node_id:'clearing',route:'bypass'}),action('hunt',{monster_id:'journey_slime'}),action('leave',{route:'bypass'}),action('stop')].map(action=>({action}))}}};
}

test('v033 portable contract, MCP and runtime agree on strict finite journey actions',()=>{
  const good=[action('browse'),action('enter',{mode:'run'}),action('travel',{node_id:'camp',route:'bypass',mode:'walk'}),action('hunt',{monster_id:'journey_slime'}),action('hunt',{monster_id:'journey_boar',mode:'walk'}),action('rest',{duration_seconds:15}),action('rest',{duration_seconds:60}),action('leave',{route:'direct'}),action('stop')];
  const bad=[action('browse',{page:0}),action('enter',{route:'bypass'}),action('stop',{mode:'run'}),action('travel',{node_id:'unknown'}),action('travel',{node_id:'camp',route:'teleport'}),action('travel',{node_id:'camp',x:43}),action('travel',{node_id:'camp',mode:'fly'}),action('hunt',{monster_id:'forest_slime'}),action('hunt',{monster_id:'journey_slime',repeat:true}),action('rest'),action('rest',{duration_seconds:61}),action('rest',{duration_seconds:14}),action('rest',{duration_seconds:15.5}),action('leave',{node_id:'entry'})];
  for(const [rows,expected] of [[good,true],[bad,false]])for(const row of rows){
    assert.equal(validJourney(row.payload),expected,JSON.stringify(row));assert.equal(featureProtocol('journey').validate(row.payload),expected);
    assert.equal(journeyPayloadSchema.safeParse(row.payload).success,expected);assert.equal(actInputSchema.safeParse({...row,run_id:'r',session_epoch:1,action_id:'a'}).success,expected);
    if(expected)assert.deepEqual(parseModelAction(JSON.stringify(row)),row);else assert.throws(()=>parseModelAction(JSON.stringify(row)),{code:'INVALID_MODEL_OUTPUT'});
  }
  assert.equal(supportsJourney({journey:{version:1},allowed_actions:[]}),false);
});

test('v033 original goals, exact food costs and explicit route choices survive focused context and typed aliases',()=>{
  const ctx=context();ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'我想先等着，不用替我出发。'}}];
  const before=structuredClone(ctx),prepared=prepareDecisionPrompt(ctx),data=read(prepared);
  assert.ok(prepared.text.length<=2000);assert.ok(prepared.text.includes(ctx.ownerGoal));assert.ok(prepared.text.includes(ctx.events[0].payload.text));
  assert.deepEqual(data.food,[['berry',2,4,2,12]]);assert.deepEqual(data.torch,[false,63]);assert.equal(data.scene,'journey');
  assert.ok(data.op.some(row=>row[0]==='travel'&&row[2]==='direct'));assert.ok(data.op.some(row=>row[0]==='travel'&&row[2]==='bypass'));
  const hunt=data.op.find(row=>row[0]==='hunt');assert.deepEqual(JSON.parse(expandDecisionReferences(JSON.stringify(action('hunt',{monster_id:hunt[1]})),prepared.references)),action('hunt',{monster_id:'journey_slime'}));
  const resource=data.resources[0][0];assert.equal(prepared.references[resource],'journey_pine');assert.match(prepared.text,/采后不自动吃/);
  assert.throws(()=>expandDecisionReferences(JSON.stringify(action('hunt',{monster_id:'@J999'})),prepared.references),{code:'INVALID_MODEL_OUTPUT'});
  const quote={type:'say',payload:{channel:'nearby',text:hunt[1]+'不是命令'}};assert.deepEqual(JSON.parse(expandDecisionReferences(JSON.stringify(quote),prepared.references)),quote);
  assert.deepEqual(ctx,before);
});

test('v033 long goal and speech retain current job, damage risk, last torch and stop without optional scene ads',()=>{
  const ctx=context();ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{name:'同伴',channel:'nearby',text:'🌱'.repeat(200)}}];
  ctx.observation.self.journey_job={intent:'hunt',phase:'fighting',monster_id:'journey_slime',route:'direct',expires_at:1090000};
  ctx.observation.self.survival={satiety:4,light:{lit:false},danger_in_seconds:13,torch:{lit:false,fuel_seconds:5}};
  ctx.observation.journey.opportunities=[{action:action('stop')}];
  const prepared=prepareDecisionPrompt(ctx),data=read(prepared);
  assert.ok(prepared.text.length<=2000,prepared.text.length);assert.equal(data.owner,ctx.ownerGoal);assert.equal(data.messages[0][2],ctx.events[0].payload.text);
  assert.deepEqual(data.body,[31,40,57,4,false,13]);assert.deepEqual(data.torch,[false,5]);assert.equal(data.job[0],'hunt');assert.deepEqual(data.op,[['stop']]);
  assert.equal(data.resources,undefined);assert.ok(!prepared.text.includes('可选公共场地'));assert.ok(!prepared.text.includes('peer_market'));
});

test('v033 discovery is optional and browse cannot displace another current activity',()=>{
  const ctx=context();ctx.observation.self.scene_id='plaza';ctx.observation.journey.opportunities=[{action:action('enter')}];
  assert.match(journeyNotice(ctx),/journey\{intent:enter\}/);assert.equal(journeyFocus(ctx),false);
  ctx.lastActionFeedback={type:'journey',status:'applied',requested:{intent:'browse'}};assert.equal(journeyFocus(ctx),true);
  ctx.observation.self.activity={activity_id:'read'};assert.equal(journeyFocus(ctx),false);assert.equal(journeyNotice(ctx),'');
  ctx.observation.self.activity=null;ctx.observation.self.scene_id='adventure';assert.equal(journeyNotice(ctx),'');
});

test('v033 real completion and encounter events wake only concerned actors; strikes never create model-per-frame loops',()=>{
  const types=['journey_started','journey_combat','journey_respawn','journey_arrived','journey_encounter','journey_finished','journey_loot'];
  const events=types.flatMap(type=>['me','peer'].map(agent_id=>({event_id:type+agent_id,type,payload:{agent_id}})));
  const queue=enqueueEvents({seen:[],queue:[]},[...events,...events],'me',[],'journey').queue;
  assert.deepEqual(queue.map(e=>e.type),['journey_arrived','journey_encounter','journey_finished','journey_loot']);
  let now=1000000;const runner=new PlazaRunner({mode:'dsh-pet',now:()=>now,idleMs:60000});runner.active=true;runner.rules={};runner.checkpoint={queue:[],max_calls:10,calls_used:1};runner.lastDecisionAt=now;runner.observedAt=now;
  runner.observation={server_time:now,self:{agent_id:'me',scene_id:'journey',journey_job:{intent:'travel',phase:'approaching',expires_at:now+90000}}};
  now+=10000;assert.equal(runner.decisionDue(),false);assert.equal(runner.waitingReason(),'plan_running');now+=20000;assert.equal(runner.decisionDue(),true);
  runner.observation.self.journey_job={intent:'rest',phase:'resting',ends_at:now+15000,expires_at:now+15000};assert.equal(runner.waitingReason(),'activity_running');
});

test('v033 original dsh-pet decides bypass, hunt or wait itself without changing persona or choosing follow-ups',async()=>{
  const ctx=context(),before=structuredClone(ctx),persona={main:{whisperPrompt:'原来的私有记忆',pets:[{id:'original',name:'原桌宠',display:'both',whisperPrompt:'原来的性格'}]}},saved=structuredClone(persona),posts=[];let chosen;
  const pet=new DshPetClient({petId:'original',url:'http://127.0.0.1:32991',fetchImpl:async(url,options)=>{
    if(url.endsWith('/config'))return{ok:true,json:async()=>persona};const body=JSON.parse(options.body);posts.push(body);assert.deepEqual(Object.keys(body),['text']);assert.ok(body.text.includes(ctx.ownerGoal));return{ok:true,json:async()=>({ok:true,text:JSON.stringify(chosen)})};
  }});
  for(const row of [action('travel',{node_id:'clearing',route:'bypass'}),action('hunt',{monster_id:'journey_slime'}),{type:'wait',payload:{}}]){chosen=row;assert.deepEqual(JSON.parse(await pet.decide(ctx)),row);}
  assert.equal(posts.length,3);assert.deepEqual(persona,saved);assert.deepEqual(ctx,before);
});

test('v033 generic model receives actual journey protocol and unchanged owner goal',async()=>{
  const ctx=context(),chosen=action('leave',{route:'bypass'}),posts=[];
  const runner=new PlazaRunner({mode:'model',now:()=>1000000,model:{baseUrl:'https://original.invalid/v1',model:'original-model',apiKey:'test-only'},fetchImpl:async(url,options)=>{posts.push(JSON.parse(options.body));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})};}});
  runner.running=true;runner.active=true;runner.abort=new AbortController();runner.rules=ctx.rules;runner.goal=ctx.ownerGoal;runner.report=async()=>{};runner.save=()=>{};runner.checkpoint={run_id:'r',session_epoch:1,calls_used:0,max_calls:10,expires_at:2000000};
  assert.deepEqual(await runner.modelDecision(ctx.observation,[]),chosen);assert.equal(posts.length,1);assert.match(posts[0].messages[0].content,/rules\.journey\.version=1/);
  const offered=posts[0].messages[0].content.split('允许动作：')[1].split('。')[0].split(', ');
  assert.ok(offered.includes('journey'));assert.ok(!offered.includes('adventure_plan'));assert.ok(!offered.includes('move'));assert.ok(!offered.includes('home'));
  assert.equal(JSON.parse(posts[0].messages[1].content).owner_goal,ctx.ownerGoal);assert.equal(posts[0].model,'original-model');
});

test('v033 a host window too small never rewrites the original goal or manufactures a safe action',()=>{
  const ctx=context();ctx.ownerGoal='原来的想法'.repeat(1000);const before=structuredClone(ctx);
  assert.throws(()=>journeyDecisionPrompt(ctx),{code:'PET_CONTEXT_TOO_LARGE'});assert.deepEqual(ctx,before);
});
