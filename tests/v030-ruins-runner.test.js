import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { actInputSchema, homePayloadSchema, ruinsPayloadSchema } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient, prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { supportsRuins, validRuins, ruinsOutdoorNotice } from '../skills/ai-plaza/scripts/ruins-context.mjs';
import { outdoorHomeOffer } from '../skills/ai-plaza/scripts/homes-context.mjs';

const action = (intent,fields={}) => ({type:'ruins',payload:{intent,...fields}});
const decode = prepared => JSON.parse(prepared.text.split('公开数据：')[1]);
const expand = (chosen,prepared) => JSON.parse(expandDecisionReferences(JSON.stringify(chosen),prepared.references));
function fixture(t) {
  let now=1000000;
  const world = new World({now:()=>now,actionIntervalMs:0}); t.after(()=>world.close());
  const a = world.createAgent({name:'原桌宠',bio:'仍是原来的自己'}),c=world.createController(a.agent_id);
  world.ownerControl(a.agent_id,'start',{controller_id:c.controller_id,max_calls:100,goal:'自己决定今天的玩法'});
  world.callTool(world.authenticate(c.token),'join_world');
  const raw=world.agent(a.agent_id);raw.scene_id='ruins';raw.position={x:6,y:25};
  return {world,raw,setNow:value=>now=value,context:()=>({rules:world.getRules(),observation:world.observation(raw),events:[],ownerGoal:'我自己的要求\n可以发呆，不必解谜。🐟'})};
}

test('v030 MCP and portable bridge agree on strict ruin intents, targets and artifact display',()=>{
  const good=[action('enter',{mode:'run'}),action('leave'),action('cancel'),action('approach',{object_id:'mural',mode:'walk'}),
    action('claim',{object_id:'key_cache'}),action('claim',{object_id:'relic_leaf'}),action('unlock',{object_id:'main_gate'}),
    action('repair',{object_id:'broken_bridge'}),action('turn',{object_id:'dial_west',direction:'previous'}),action('submit',{object_id:'rune_console'})];
  for(const a of good){assert.equal(validRuins(a.payload),true);assert.equal(ruinsPayloadSchema.safeParse(a.payload).success,true);assert.deepEqual(parseModelAction(JSON.stringify(a)),a);assert.equal(actInputSchema.safeParse({run_id:'r',session_epoch:1,action_id:'a',...a}).success,true);}
  const bad=[action('enter',{object_id:'main_gate'}),action('leave',{x:1}),action('cancel',{mode:'run'}),action('approach',{object_id:'missing'}),
    action('claim',{object_id:'main_gate'}),action('unlock',{object_id:'key_cache'}),action('repair',{object_id:'broken_bridge',quantity:1}),
    action('turn',{object_id:'dial_west',direction:'sun'}),action('submit',{object_id:'dial_west'}),action('approach',{object_id:'@R1'})];
  for(const a of bad){assert.equal(validRuins(a.payload),false);assert.equal(ruinsPayloadSchema.safeParse(a.payload).success,false);assert.throws(()=>parseModelAction(JSON.stringify(a)),{code:'INVALID_MODEL_OUTPUT'});}
  for(const item_id of ['ruins_leaf_medallion','ruins_stone_bird','ruins_star_lens']){const payload={intent:'display',instance_id:'shelf_me',item_id};assert.equal(homePayloadSchema.safeParse(payload).success,true);assert.deepEqual(parseModelAction(JSON.stringify({type:'home',payload})),{type:'home',payload});}
  assert.equal(homePayloadSchema.safeParse({intent:'display',instance_id:'shelf_me',item_id:'ruins_bronze_key'}).success,false);
});

test('v030 focused host context preserves real mechanisms and personal goal, without route solving or outdoor offers',t=>{
  const f=fixture(t),ctx=f.context();
  ctx.observation.self.personal_goal={goal_id:'goal_original',status:'needs_review',kind:'collect_item',target_id:'wood',target_count:6,progress:2,expires_at:1000600};
  const before=structuredClone(ctx),prepared=prepareDecisionPrompt(ctx),data=decode(prepared);
  assert.ok(prepared.text.length<=2000);assert.deepEqual(data.gates,[false,false,false]);assert.equal(data.runes[2],ctx.observation.ruins.runes.clue);
  assert.equal(prepared.references[data.personal_goal[0]],'goal_original');assert.deepEqual(data.personal_goal.slice(1),['needs_review','collect_item','wood',2,6,1]);
  assert.equal(outdoorHomeOffer(ctx),'');assert.ok(!prepared.text.includes('adventure_plan{'));assert.ok(!prepared.text.includes('solution'));
  const approach=data.op.find(row=>row[0]==='approach');assert.deepEqual(expand(action('approach',{object_id:approach[1]}),prepared),action('approach',{object_id:prepared.references[approach[1]]}));
  assert.deepEqual(ctx,before);assert.equal(f.raw.ruins_job??null,null);
  assert.equal(supportsRuins({allowed_actions:['ruins']}),false);assert.equal(supportsRuins({ruins:{version:1},allowed_actions:[]}),false);
  const old=structuredClone(ctx);delete old.rules.ruins;assert.equal(ruinsOutdoorNotice(old),'');
});

test('v030 long private goal and peer message keep all real choices and food effects in host budget',t=>{
  const f=fixture(t);Object.assign(f.world.state.ruins,{gate_open:true,archive_open:true});f.raw.life.inventory.berry=2;f.raw.fatigue.energy=50;f.raw.survival.satiety=50;
  const ctx=f.context();ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  const prepared=prepareDecisionPrompt(ctx),data=decode(prepared);
  assert.ok(prepared.text.length<=2000);assert.ok(prepared.text.includes(JSON.stringify(ctx.ownerGoal)));assert.equal(data.msg[2],ctx.events[0].payload.text);
  assert.deepEqual(data.food.find(row=>row[0]==='berry'),['berry',4,2,2,12]);
  assert.ok(data.op.some(row=>row[0]==='leave'));assert.equal(data.op.find(row=>row[0]==='approach')[1].length,12,'every actual approach choice survives grouping');
  assert.equal(data.runes[2],ctx.observation.ruins.runes.clue);
});

test('v030 finite ruin work uses existing 30-second review; shared results wake only same scene and event IDs deduplicate',()=>{
  const events=['ruins_approaching','ruins_repair_started','ruins_bridge_repaired','ruins_dial_turned','ruins_runes_submitted','ruins_arrived'].flatMap(type=>['me','peer'].map(agent_id=>({event_id:type+agent_id,type,payload:{agent_id}})));
  const queue=enqueueEvents({seen:[],queue:[]},[...events,...events],'me',[],'ruins').queue;
  assert.equal(queue.filter(e=>e.type==='ruins_repair_started').length,1);assert.equal(queue.find(e=>e.type==='ruins_repair_started').payload.agent_id,'peer');
  assert.ok(!queue.some(e=>e.type==='ruins_approaching'));assert.equal(queue.filter(e=>e.type==='ruins_arrived').length,1);
  assert.equal(queue.filter(e=>e.type==='ruins_bridge_repaired').length,2);
  assert.ok(enqueueEvents({seen:[],queue:[]},events,'me',[],'adventure').queue.every(e=>e.payload.agent_id==='me'));
  let now=1000000;const runner=new PlazaRunner({mode:'dsh-pet',now:()=>now,idleMs:60000});
  runner.active=true;runner.rules={};runner.checkpoint={queue:[],max_calls:10,calls_used:1};runner.lastDecisionAt=now;runner.observedAt=now;
  runner.observation={server_time:now,self:{agent_id:'me',ruins_job:{phase:'approaching',expires_at:now+120000}}};
  now+=10000;assert.equal(runner.decisionDue(),false);assert.equal(runner.waitingReason(),'plan_running');now+=20000;assert.equal(runner.decisionDue(),true);
});

test('v030 forest entry travel keeps real pursuing threats, failed target and cancellation visible without inventing a replacement',t=>{
  const f=fixture(t),ctx=f.context();ctx.observation.self.scene_id='adventure';
  ctx.observation.self.ruins_job={intent:'enter',scene_id:'adventure',phase:'approaching',expires_at:1100000};
  ctx.observation.ruins.opportunities=[action('cancel')];ctx.observation.adventure.monsters=[{monster_id:'real_boar',position:{x:10,y:8},hp:19,behavior:'chasing',target_agent_id:f.raw.agent_id},
    {monster_id:'other_boar',position:{x:12,y:8},hp:20,behavior:'attacking',target_agent_id:'other'}];
  ctx.lastActionFeedback={type:'ruins',status:'rejected',code:'OUT_OF_RANGE',requested:{intent:'repair',object_id:'broken_bridge'}};
  const before=structuredClone(ctx),prepared=prepareDecisionPrompt(ctx),data=decode(prepared);
  assert.deepEqual(data.threats,[['real_boar',10,8,19,'chasing']]);assert.match(prepared.text,/尚在冒险/);assert.deepEqual(data.op,[['cancel']]);assert.deepEqual(data.receipt.requested,ctx.lastActionFeedback.requested);assert.deepEqual(ctx,before);
});

test('v030 original dsh-pet can choose a route, leave or wait without persona mutation or an automatic follow-up',async t=>{
  const f=fixture(t),ctx=f.context(),before=JSON.stringify(ctx),persona={main:{whisperPrompt:'私有记忆\n保持不变',pets:[{id:'original',name:'原桌宠',display:'both',whisperPrompt:'原角色'}]}};
  const saved=JSON.stringify(persona),posts=[];let chosen;
  const pet=new DshPetClient({petId:'original',url:'http://127.0.0.1:32991',fetchImpl:async(url,options)=>{
    if(url.endsWith('/config'))return{ok:true,json:async()=>persona};
    assert.match(url,/\/chat\?pet=original&surface=any$/);const body=JSON.parse(options.body);posts.push(body);assert.deepEqual(Object.keys(body),['text']);
    assert.ok(body.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(!body.text.includes(persona.main.whisperPrompt));return{ok:true,json:async()=>({ok:true,text:JSON.stringify(chosen)})};
  }});
  for(const next of [action('approach',{object_id:'broken_bridge',mode:'walk'}),action('leave'),{type:'wait',payload:{}}]){chosen=next;assert.deepEqual(JSON.parse(await pet.decide(ctx)),next);}
  assert.equal(posts.length,3);assert.equal(JSON.stringify(persona),saved);assert.equal(JSON.stringify(ctx),before);assert.equal(f.raw.ruins_job??null,null);assert.deepEqual(f.raw.position,{x:6,y:25});
});

test('v030 generic model request actually includes ruin protocol and relays its exact original choice',async t=>{
  const f=fixture(t),ctx=f.context(),chosen=action('leave'),requests=[];
  const runner=new PlazaRunner({mode:'model',now:()=>1000000,model:{baseUrl:'https://original.invalid/v1',model:'original-model',apiKey:'test-not-secret'},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})};}});
  runner.running=true;runner.active=true;runner.abort=new AbortController();runner.rules=ctx.rules;runner.goal=ctx.ownerGoal;runner.report=async()=>{};runner.save=()=>{};
  runner.checkpoint={run_id:'r',session_epoch:1,calls_used:0,max_calls:10,expires_at:2000000};
  assert.deepEqual(await runner.modelDecision(ctx.observation,[]),chosen);assert.equal(requests.length,1);
  assert.match(requests[0].messages[0].content,/rules\.ruins\.version=1/);assert.match(requests[0].messages[0].content,/不会自动/);
  assert.equal(JSON.parse(requests[0].messages[1].content).owner_goal,ctx.ownerGoal);assert.equal(requests[0].model,'original-model');assert.equal(f.raw.ruins_job??null,null);
});
