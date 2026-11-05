import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAZA_LAYOUT, PLAZA_SERVICES } from '../skills/ai-plaza/scripts/plaza-layout.mjs';
import { supportsPlazaLayout, plazaServiceLocations, plazaPromptNotice, preservesPlazaContext } from '../skills/ai-plaza/scripts/plaza-context.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { movementContext } from '../skills/ai-plaza/scripts/movement.mjs';
import { PlazaRunner } from '../skills/ai-plaza/scripts/runtime.mjs';
import { createHomesFixture } from './helpers/homes-fixture.js';

function context() {
  return {ownerGoal:'保留我原来的安排，目的地和玩法由我自己决定。',events:[{type:'message',payload:{agent_id:'friend',channel:'nearby',text:'我在看风景，你也可以继续自己的事情。'}}],
    rules:{plaza_layout:structuredClone(PLAZA_LAYOUT),places:structuredClone(PLAZA_LAYOUT.places),activities:[{id:'read',name:'阅读',place_id:'reading',duration_seconds:30},{id:'solo_game',name:'小游戏',place_id:'play',duration_seconds:30}],games:[],max_move:3,
      allowed_actions:['move','say','wait','inventory','start_activity'],life:{items:[{id:'turnip',kind:'food',heal:12,satiety_restore:15}],recipes:[{item_id:'axe',kind:'tool',ingredients:{wood:3,ore:1}},{item_id:'turnip_soup',kind:'cooking',station_id:'kitchen',ingredients:{turnip:2}}]}},
    observation:{server_time:100000,self:{agent_id:'me',name:'原来的AI',scene_id:'plaza',position:{x:24,y:16},adventure:{hp:20,max_hp:40},life:{inventory:{turnip:4,wood:5,ore:3}}},nearby_agents:[],
      movement:{scene_id:'plaza',version:2,map:{width:48,height:32},max_step:3,candidates:[{x:25,y:16,path:[{x:24,y:16},{x:25,y:16}]},{x:24,y:17,path:[{x:24,y:16},{x:24,y:17}]}]},opportunities:[]}};
}

test('v036 shared service facts use server interaction positions rather than local constants, decorative feet or old camp',()=>{
  const ctx=context(),before=structuredClone(ctx),rows=plazaServiceLocations(ctx.rules);
  for(const f of ctx.rules.plaza_layout.facilities)assert.deepEqual(rows.find(row=>row[0]===f.id),[f.id,f.interaction_position.x,f.interaction_position.y,f.radius]);
  for(const spot of ctx.rules.plaza_layout.fishing_spots)assert.ok(rows.some(row=>row[0]===spot.id&&row[1]===spot.interaction_position.x&&row[2]===spot.interaction_position.y));
  assert.notDeepEqual(PLAZA_SERVICES.home.position,PLAZA_SERVICES.home.interaction_position);
  const moved=structuredClone(ctx.rules);for(const f of moved.plaza_layout.facilities){f.position={x:0,y:0};f.interaction_position.x--;}
  assert.equal(plazaServiceLocations(moved).find(row=>row[0]==='home')[1],PLAZA_SERVICES.home.interaction_position.x-1);
  assert.equal(supportsPlazaLayout({}),false);assert.deepEqual(plazaServiceLocations({}),[]);assert.deepEqual(ctx,before);
});

test('v036 bounded host discovery retains original goal, speech, food and current legal movement candidates',()=>{
  const ctx=context(),before=structuredClone(ctx),prompt=prepareDecisionPrompt(ctx),baseline=prepareDecisionPrompt({...ctx,plazaNoticeReserved:true});
  assert.ok(prompt.text.length<=2000);assert.match(prompt.text,/广场站位/);assert.ok(prompt.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(prompt.text.includes(ctx.events[0].payload.text));
  assert.match(prompt.text,/本次合法move落点=\[\[25,16\],\[24,17\]\]/);
  assert.ok(preservesPlazaContext(baseline,prompt,expandDecisionReferences));
  assert.deepEqual(ctx,before);
});

test('v036 a failed service request names its real distinct site but never fabricates a walk or queued work',()=>{
  const ctx=context();for(const [type,requested,id] of [['farm',{intent:'water',plot_id:'plot_1'},'farm'],['trade',{intent:'buy',item_id:'wood'},'supply'],['inventory',{intent:'repair',item_id:'axe'},'tools'],['inventory',{intent:'craft',item_id:'turnip_soup'},'kitchen'],['inventory',{intent:'equip',item_id:'sword'},'camp']]){
    ctx.lastActionFeedback={type,status:'rejected',code:'NOT_AT_CAMP',requested};const note=plazaPromptNotice(ctx,true),f=PLAZA_SERVICES[id==='supply'?'supply':id];
    assert.ok(note.includes(JSON.stringify([[id,f.interaction_position.x,f.interaction_position.y,f.radius]])));assert.match(note,/不自动补给\/开工/);
  }
  const invalid={x:47,y:31,path:[{x:24,y:16},{x:47,y:31}]};ctx.observation.movement.candidates.push(invalid);
  assert.ok(!plazaPromptNotice(ctx).includes('[47,31]'));assert.equal(movementContext(ctx.observation,ctx.rules).candidates.length,2);
});

test('v036 map discovery never replaces a current game, finite job, house visit or another scene',()=>{
  for(const patch of [{activity:{activity_id:'read'}},{movement:{version:2}},{fishing:{phase:'fishing'}},{home_presence:{home_id:'home_me'}},{home_travel:{home_id:'home_me'}},{community_job:{phase:'using'}},{adventure:{plan:{intent:'explore'}}},{scene_id:'adventure'}]){
    const ctx=context();Object.assign(ctx.observation.self,patch);assert.equal(plazaPromptNotice(ctx),'');
  }
  const ctx=context();ctx.observation.game={status:'active',participants:['me'],game_id:'game_original'};assert.equal(plazaPromptNotice(ctx),'');
  assert.equal(plazaPromptNotice({...context(),rules:{}}),'');
});

test('v036 compacting optional map facts cannot evict food effects, legal actions or message/goal facts',()=>{
  const facts={food:[['turnip',12,4,0,15]],events:[{text:'完整消息'}],opportunities:[{action:{type:'inventory',payload:{intent:'use',item_id:'turnip'}}}],personal_goal:{goal_id:'original',status:'active'}};
  const frame=data=>({text:'公开数据：'+JSON.stringify(data)}),same=frame(facts);assert.equal(preservesPlazaContext(same,same,expandDecisionReferences),true);
  for(const next of [{...facts,food:[['turnip',12,4]]},{...facts,events:[]},{...facts,opportunities:[]},{...facts,personal_goal:undefined}])assert.equal(preservesPlazaContext(same,frame(next),expandDecisionReferences),false);
});

test('v036 original model receives current service contract and keeps its own chosen action without capability growth',async()=>{
  const ctx=context(),posts=[],chosen={type:'move',payload:{x:25,y:16}};
  const runner=new PlazaRunner({mode:'model',now:()=>100000,model:{baseUrl:'https://original.invalid/v1',model:'original-model',apiKey:'isolated-test'},fetchImpl:async(url,options)=>{posts.push(JSON.parse(options.body));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})};}});
  runner.running=true;runner.active=true;runner.abort=new AbortController();runner.rules=ctx.rules;runner.goal=ctx.ownerGoal;runner.report=async()=>{};runner.save=()=>{};runner.checkpoint={run_id:'same',session_epoch:1,calls_used:0,max_calls:20,expires_at:200000};
  assert.deepEqual(await runner.modelDecision(ctx.observation,ctx.events),chosen);
  assert.equal(posts.length,1);const sent=JSON.parse(posts[0].messages[1].content);assert.deepEqual(sent.rules.plaza_layout,ctx.rules.plaza_layout);assert.equal(sent.owner_goal,ctx.ownerGoal);assert.deepEqual(sent.events,ctx.events);
  assert.match(posts[0].messages[0].content,/不能用一个点冒充全部服务/);assert.ok(runner.capabilities().length<=16);assert.equal(runner.checkpoint.calls_used,1);
});

for (const mode of ['model','dsh-pet']) test(`v036 ${mode} real HTTP/MCP rejects a remote workshop request, preserves its site facts and executes only the next original choice`,async t=>{
  const f=await createHomesFixture({frontend:false}),p=await f.actor('原来的独立AI');t.after(()=>f.close());
  const original={id:p.id,appearance:structuredClone(p.raw.appearance),goal:p.goal,inventory:structuredClone(p.raw.life.inventory),run:p.raw.run.run_id};
  const requests=[],calls=[];let next={type:'inventory',payload:{intent:'craft',item_id:'wooden_sword'}};
  const toolClient={listTools:()=>p.client.listTools(),close:async()=>{},callTool:async args=>{calls.push(structuredClone(args));return p.client.callTool(args);}};
  const runner=new PlazaRunner({mode,now:f.now,toolClient,model:{baseUrl:'https://original.invalid/v1',model:'original',apiKey:'isolated-test'},
    fetchImpl:async(_,options)=>{const body=JSON.parse(options.body);requests.push(JSON.parse(body.messages[1].content));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(next)}}]})};},
    petClient:{initialize:async()=>{},decide:async input=>{const prompt=prepareDecisionPrompt(input);assert.ok(prompt.text.length<=2000);requests.push({input,prompt});return JSON.stringify(next);}}});
  runner.checkpoint={version:1,...p.session,controller_id:p.raw.run.controller_id,max_calls:p.raw.run.max_calls,expires_at:p.raw.run.expires_at,calls_used:0,queue:[],seen:[],pending_action:null};
  runner.running=true;runner.abort=new AbortController();await runner.initialize();await runner.activate(await p.call('get_control_state'));Object.assign(p.session,runner.session());t.after(()=>runner.stop());
  const note='原来的聊天内容，地图改造不能替我决定去哪里。';runner.checkpoint.queue.push({event_id:'original-message',type:'message',payload:{agent_id:'friend',channel:'group',text:note}});
  await runner.decide();assert.equal(runner.checkpoint.last_action_feedback.code,'NOT_AT_SERVICE');assert.deepEqual(p.raw.life.inventory,original.inventory);assert.equal(p.raw.movement,null);
  assert.ok(JSON.stringify(requests[0]).includes(note));assert.ok(JSON.stringify(requests[0]).includes(original.goal));
  const observation=await p.observe(),rules=await p.call('get_rules'),site=rules.life.crafting_place.service_center;
  const host=prepareDecisionPrompt({observation,rules,ownerGoal:p.goal,lastActionFeedback:runner.checkpoint.last_action_feedback});
  const hostData=JSON.parse(host.text.split('公开数据：')[1]);assert.deepEqual(hostData.last_action.service,['tools',site.x,site.y,rules.life.crafting_place.radius]);
  if(mode==='model') {
    assert.deepEqual(requests[0].rules.plaza_layout,rules.plaza_layout);
    const candidate=observation.movement.candidates[0];next={type:'move',payload:{x:candidate.x,y:candidate.y}};
  } else next={type:'wait',payload:{}};
  await f.advance(6000);await runner.decide();
  if(mode==='model') {await f.until(()=>!p.raw.movement);assert.deepEqual(p.raw.position,next.payload);}
  else assert.deepEqual(p.raw.position,observation.self.position);
  assert.equal(calls.filter(call=>call.name==='act').length,mode==='model'?2:1);assert.equal(runner.checkpoint.calls_used,2);
  assert.equal(p.raw.adventure.plan,null);assert.equal(p.raw.life.gathering,null);assert.deepEqual(p.raw.life.inventory,original.inventory);
  assert.deepEqual({id:p.id,appearance:p.raw.appearance,goal:p.goal,run:p.raw.run.run_id},{id:original.id,appearance:original.appearance,goal:original.goal,run:original.run});
  assert.equal(runner.capabilities().length,16);
});
