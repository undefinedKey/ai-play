import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { actInputSchema,peerMarketPayloadSchema } from '../server/mcp.js';
import { PEER_MARKET_CATALOG,PEER_MARKET_RULES } from '../shared/peer-market.js';
import { PEER_MARKET_ITEMS,supportsPeerMarket,validPeerMarket,peerMarketPromptPart } from '../skills/ai-plaza/scripts/peer-market-context.mjs';
import { PlazaRunner,parseModelAction,enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient,prepareDecisionPrompt,expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const action=(intent,fields={})=>({type:'peer_market',payload:{intent,...fields}});
const expand=(a,p)=>JSON.parse(expandDecisionReferences(JSON.stringify(a),p.references));
function fixture(t) {
  const now=1000000,world=new World({now:()=>now,actionIntervalMs:0});t.after(()=>world.close());
  const actor=world.createAgent({name:'原桌宠',bio:'保留原性格'}),c=world.createController(actor.agent_id);
  world.ownerControl(actor.agent_id,'start',{controller_id:c.controller_id,max_calls:100,goal:'可以逛集市，也可以独处'});
  const auth=world.authenticate(c.token);world.callTool(auth,'join_world');
  const a=world.agent(actor.agent_id);a.position={...PEER_MARKET_RULES.place.interaction_position};
  return {world,a,auth,context:()=>({rules:world.getRules(),observation:world.observation(a),events:[],ownerGoal:'我自己的要求\n不一定接受报价。🐟'})};
}
function offer(n,fields={}) {
  return {offer_id:`offer_${n}`,revision:1,kind:'exchange',owner_agent_id:`agent_seller_${n}`,owner_name:`卖家${n}`,target_agent_id:null,give:{items:{wheat_bread:2},gold:0},want:{items:{ore:1},gold:0},expires_at:1600000,status:'open',title:'本人自行报价',...fields};
}

test('v031 MCP and standalone bridge validate sparse assets and exact intent fields identically',()=>{
  assert.deepEqual([...PEER_MARKET_ITEMS].sort(),PEER_MARKET_CATALOG.map(item=>item.id).sort());
  const good=[action('browse',{page:0}),action('approach',{mode:'run'}),action('post',{kind:'exchange',give:{items:{wheat_bread:2}},want:{gold:7}}),
    action('post',{kind:'request',give:{gold:50},want:{items:{wood:3,ore:2}},title:'需要建屋材料',duration_seconds:60}),
    action('post',{kind:'gift',target_agent_id:'agent_friend',give:{items:{ruins_star_lens:1}}}),
    ...['accept','decline','cancel'].map(intent=>action(intent,{offer_id:'offer_1',revision:1})),action('claim_return',{offer_id:'offer_1'})];
  for(const a of good){assert.equal(validPeerMarket(a.payload),true,JSON.stringify(a));assert.equal(peerMarketPayloadSchema.safeParse(a.payload).success,true,JSON.stringify(a));assert.deepEqual(parseModelAction(JSON.stringify(a)),a);assert.equal(actInputSchema.safeParse({run_id:'r',session_epoch:1,action_id:'a',...a}).success,true);}
  const bad=[action('browse',{page:10}),action('browse',{page:-1}),action('approach',{x:28}),action('accept',{offer_id:'offer_1',revision:2}),action('claim_return',{offer_id:'offer_1',revision:1}),
    action('post',{kind:'gift',give:{items:{wood:1}}}),action('post',{kind:'gift',target_agent_id:'peer',give:{gold:1},want:{items:{wood:1}}}),
    action('post',{kind:'exchange',give:{gold:1},want:{gold:2}}),action('post',{kind:'request',give:{items:{wood:2}},want:{items:{wood:3}}}),
    action('post',{kind:'gift',target_agent_id:'peer',give:{items:{ruins_star_lens:2}}}),action('post',{kind:'exchange',give:{items:{}},want:{items:{wood:1}}}),action('post',{kind:'exchange',give:{items:{wood:0}},want:{gold:1}}),
    ...['ruins_bronze_key','axe','torch','book_fake','invented_currency'].map(item=>action('post',{kind:'exchange',give:{items:{[item]:1}},want:{gold:1}}))];
  for(const a of bad){assert.equal(validPeerMarket(a.payload),false,JSON.stringify(a));assert.equal(peerMarketPayloadSchema.safeParse(a.payload).success,false,JSON.stringify(a));assert.throws(()=>parseModelAction(JSON.stringify(a)),{code:'INVALID_MODEL_OUTPUT'});}
});

test('v031 page adapter exposes exact current terms, no accept for omitted pages, and reversible short IDs',t=>{
  const f=fixture(t),ctx=f.context();ctx.observation.peer_market={...ctx.observation.peer_market,page:3,total_pages:10,total_open:20,offers:[offer(7),offer(8,{kind:'request'})],
    incoming_gifts:[{offer_id:'offer_19',revision:1,page:9}],opportunities:[action('accept',{offer_id:'offer_7',revision:1}),action('accept',{offer_id:'offer_19',revision:1})]};
  const before=structuredClone(ctx),part=peerMarketPromptPart(ctx,{compact:true}),data=part.data;
  assert.equal(data.page,3);assert.equal(data.pages,10);assert.equal(data.total,20);assert.equal(data.offers.length,2);assert.equal(data.op.length,1);
  assert.deepEqual(expand(action('accept',{offer_id:data.op[0][1],revision:1}),part),action('accept',{offer_id:'offer_7',revision:1}));
  const bread=Object.keys(data.offers[0][5][0])[0],ore=Object.keys(data.offers[0][6][0])[0];
  assert.deepEqual(expand(action('post',{kind:'exchange',give:{items:{[bread]:2}},want:{items:{[ore]:1}}}),part),action('post',{kind:'exchange',give:{items:{wheat_bread:2}},want:{items:{ore:1}}}));
  assert.throws(()=>expand(action('accept',{offer_id:'M999',revision:1}),part),{code:'INVALID_MODEL_OUTPUT'});
  assert.throws(()=>expand(action('post',{kind:'exchange',give:{items:{[bread]:2,wheat_bread:2}},want:{gold:1}}),part),{code:'INVALID_MODEL_OUTPUT'});
  assert.deepEqual(ctx,before);
});

test('v031 current market page coexists with original goal, message, food and other voluntary choices in host budget',t=>{
  const f=fixture(t),ctx=f.context();ctx.observation.self.life.inventory.berry=2;
  ctx.observation.peer_market.offers=[offer(1),offer(2,{kind:'gift',target_agent_id:f.a.agent_id,want:{items:{},gold:0}})];
  ctx.observation.peer_market.total_open=2;ctx.observation.peer_market.total_pages=1;
  ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'你愿意来吃饭吗？不来我也自己吃。'}}];
  const before=structuredClone(ctx),prepared=prepareDecisionPrompt(ctx);
  assert.ok(prepared.text.length<=2000);assert.ok(prepared.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(prepared.text.includes(ctx.events[0].payload.text));assert.ok(prepared.text.includes('berry'));assert.match(prepared.text,/wait/);assert.match(prepared.text,/peer_market/);assert.deepEqual(ctx,before);
});

test('v031 event queue wakes only affected original actors, deduplicates and does not react to every public listing',()=>{
  const events=[{event_id:'post',type:'peer_market_changed',payload:{offer:{owner_agent_id:'other',target_agent_id:null}}},
    {event_id:'gift',type:'peer_market_changed',payload:{offer:{owner_agent_id:'other',target_agent_id:'me'}}},
    {event_id:'sale',type:'peer_market_changed',payload:{offer:{owner_agent_id:'me',taker_agent_id:'peer'}}},
    {event_id:'walk',type:'peer_market_arrived',payload:{agent_id:'me'}}, {event_id:'otherwalk',type:'peer_market_arrived',payload:{agent_id:'other'}}];
  assert.deepEqual(enqueueEvents({seen:[],queue:[]},[...events,...events],'me').queue.map(e=>e.event_id),['gift','sale','walk']);
});

test('v031 two maximum item bundles retain every price alongside long private goal and peer message',t=>{
  const f=fixture(t),ctx=f.context();
  ctx.observation.self.life.inventory=Object.fromEntries(PEER_MARKET_ITEMS.map(id=>[id,1]));
  const give={items:{ruins_leaf_medallion:1,ruins_stone_bird:1,ruins_star_lens:1,roasted_berry:99},gold:10000};
  const want={items:{turnip_soup:99,wheat_bread:99,grilled_fish:99,trail_ration:99},gold:0};
  ctx.observation.peer_market.offers=[offer(1,{give,want,title:'公开标题'.repeat(15)}),offer(2,{give,want,title:'另外报价'.repeat(15)})];
  ctx.observation.peer_market.total_open=20;ctx.observation.peer_market.total_pages=10;
  ctx.observation.peer_market.opportunities=[action('accept',{offer_id:'offer_1',revision:1}),action('accept',{offer_id:'offer_2',revision:1})];
  ctx.lastActionFeedback={type:'peer_market',status:'applied',requested:{intent:'browse',page:0}};
  ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  const prepared=prepareDecisionPrompt(ctx);
  assert.ok(prepared.text.length<=2000);assert.ok(prepared.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(prepared.text.includes(ctx.events[0].payload.text));
  const data=JSON.parse(prepared.text.split('集市数据：')[1].split('\n')[0]);
  for(const row of data.offers){const translated=expand(action('post',{kind:'exchange',give:{items:row[5][0],gold:row[5][1]},want:{items:row[6][0],gold:row[6][1]}}),prepared);assert.deepEqual(translated.payload.give,give);assert.deepEqual(translated.payload.want,want);}
});

test('v031 original pet can browse, refuse or wait unchanged; generic model receives same protocol and owner goal',async t=>{
  const f=fixture(t),ctx=f.context(),before=JSON.stringify(ctx),persona={main:{whisperPrompt:'原私人记忆',pets:[{id:'original',name:'原桌宠',display:'both',whisperPrompt:'原人格'}]}};
  const saved=JSON.stringify(persona),posts=[];let chosen;
  const pet=new DshPetClient({petId:'original',url:'http://127.0.0.1:32991',fetchImpl:async(url,options)=>{
    if(url.endsWith('/config'))return{ok:true,json:async()=>persona};posts.push(JSON.parse(options.body));assert.deepEqual(Object.keys(posts.at(-1)),['text']);
    return{ok:true,json:async()=>({ok:true,text:JSON.stringify(chosen)})};
  }});
  for(const next of [action('browse',{page:0}),action('decline',{offer_id:'offer_1',revision:1}),{type:'wait',payload:{}}]){chosen=next;assert.deepEqual(JSON.parse(await pet.decide(ctx)),next);}
  assert.equal(posts.length,3);assert.equal(JSON.stringify(persona),saved);assert.equal(JSON.stringify(ctx),before);
  const requests=[],runner=new PlazaRunner({mode:'model',now:()=>1000000,model:{baseUrl:'https://original.invalid/v1',model:'original',apiKey:'test'},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})};}});
  runner.running=true;runner.active=true;runner.abort=new AbortController();runner.rules=ctx.rules;runner.goal=ctx.ownerGoal;runner.report=async()=>{};runner.save=()=>{};runner.checkpoint={run_id:'r',session_epoch:1,calls_used:0,max_calls:10,expires_at:2000000};
  assert.deepEqual(await runner.modelDecision(ctx.observation,[]),chosen);assert.match(requests[0].messages[0].content,/rules\.peer_market\.version=1/);assert.equal(JSON.parse(requests[0].messages[1].content).owner_goal,ctx.ownerGoal);
  assert.equal(supportsPeerMarket({allowed_actions:['peer_market']}),false);assert.equal(supportsPeerMarket({peer_market:{version:1},allowed_actions:[]}),false);
});

test('v031 a real full board plus own offer and incoming gifts never displaces an existing ruin job',t=>{
  const f=fixture(t);f.world.state.room.capacity=24;
  const act=(a,auth,next)=>{const o=f.world.observation(a);const result=f.world.callTool(auth,'act',{run_id:o.run_id,session_epoch:o.session_epoch,action_id:o.next_action_id,...next});assert.equal(result.status,'applied',JSON.stringify(result));};
  act(f.a,f.auth,action('post',{kind:'exchange',give:{items:{wood:1}},want:{items:{ore:1}}}));
  for(let index=0;index<19;index++) {
    const a=f.world.createAgent({name:`真实报价者${index}`}),c=f.world.createController(a.agent_id);
    f.world.ownerControl(a.agent_id,'start',{controller_id:c.controller_id,max_calls:100});const auth=f.world.authenticate(c.token);
    // Model the contract's future 20-listing capacity without changing the production five-seat admission rule.
    const raw=f.world.agent(a.agent_id);if(index>=4){raw.status='active';raw.run.has_joined=true;raw.last_contact_at=f.world.now();raw.next_action_id=`act_fixture_${index}`;}
    f.world.callTool(auth,'join_world');raw.position={...PEER_MARKET_RULES.place.interaction_position};
    act(raw,auth,action('post',index<2?{kind:'gift',target_agent_id:f.a.agent_id,give:{items:{wood:1}}}:{kind:'exchange',give:{items:{wood:1}},want:{items:{ore:1}}}));
  }
  act(f.a,f.auth,action('browse',{page:9}));
  f.a.scene_id='ruins';f.a.position={x:6,y:25};
  act(f.a,f.auth,{type:'ruins',payload:{intent:'approach',object_id:'key_cache'}});
  const ctx=f.context();ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  assert.equal(ctx.observation.peer_market.total_open,20);assert.equal(ctx.observation.peer_market.incoming_gifts.length,2);assert.ok(ctx.observation.self.ruins_job);assert.ok(ctx.observation.peer_market.own_offer);
  const before=structuredClone(ctx),baseline=prepareDecisionPrompt({...ctx,peerMarketNoticeReserved:true}),prepared=prepareDecisionPrompt(ctx);
  assert.ok(prepared.text.length<=2000);assert.ok(prepared.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(prepared.text.includes(ctx.events[0].payload.text));
  assert.equal(prepared.text.slice(prepared.text.indexOf('公开数据：')),baseline.text.slice(baseline.text.indexOf('公开数据：')));
  for(const [key,value] of Object.entries(baseline.references||{}))assert.equal(prepared.references[key],value);
  assert.deepEqual(ctx,before);
});

test('v031 original runner retains an applied browse fact for exactly the next original decision',async t=>{
  const f=fixture(t),o=f.world.observation(f.a);
  const runner=new PlazaRunner({mode:'model',now:()=>1000000,toolClient:{callTool:async({name,arguments:args})=>({structuredContent:f.world.callTool(f.auth,name,args)})}});
  runner.running=true;runner.active=true;runner.rules=f.world.getRules();runner.observation=o;runner.save=()=>{};runner.report=async()=>{};
  runner.checkpoint={run_id:o.run_id,session_epoch:o.session_epoch,queue:[],seen:[],calls_used:0,max_calls:100,expires_at:2000000,pending_action:{run_id:o.run_id,session_epoch:o.session_epoch,action_id:o.next_action_id,...action('browse',{page:0})}};
  await runner.recoverPending();assert.deepEqual(runner.checkpoint.last_action_feedback,{type:'peer_market',status:'applied',requested:{intent:'browse',page:0}});
  const next=f.world.observation(f.a);runner.checkpoint.pending_action={run_id:next.run_id,session_epoch:next.session_epoch,action_id:next.next_action_id,type:'wait',payload:{}};
  await runner.recoverPending();assert.equal(runner.checkpoint.last_action_feedback,undefined);assert.equal(runner.checkpoint.calls_used,0);
});

test('v031 explicit reading retains two disjoint maximum quotes and body state under a full hungry inventory',t=>{
  const f=fixture(t);f.a.life.inventory=Object.fromEntries(PEER_MARKET_CATALOG.map(item=>[item.id,1]));f.a.survival.satiety=20;f.a.fatigue.energy=50;f.a.adventure.hp=20;
  const ctx=f.context(),items=PEER_MARKET_CATALOG.map(item=>item.id);
  ctx.observation.peer_market.offers=[0,1].map(n=>offer(n,{give:{items:Object.fromEntries(items.slice(n*8,n*8+4).map(id=>[id,99])),gold:0},want:{items:Object.fromEntries(items.slice(n*8+4,n*8+8).map(id=>[id,99])),gold:0},title:'同伴自由命名'.repeat(10)}));
  ctx.observation.peer_market.total_pages=10;ctx.observation.peer_market.total_open=20;
  ctx.ownerGoal='🐟'.repeat(300);ctx.events=[{type:'message',payload:{agent_id:'peer',channel:'nearby',text:'🌱'.repeat(200)}}];
  ctx.lastActionFeedback={type:'peer_market',status:'applied',requested:{intent:'browse',page:0}};
  const prepared=prepareDecisionPrompt(ctx);assert.ok(prepared.text.length<=2000);assert.equal(prepared.marketReadingDeferred,undefined);
  assert.ok(prepared.text.includes(JSON.stringify(ctx.ownerGoal)));assert.ok(prepared.text.includes(ctx.events[0].payload.text));
  const market=JSON.parse(prepared.text.split('集市数据：')[1].split('\n')[0]),data=JSON.parse(prepared.text.split('公开数据：')[1]);
  for(let n=0;n<2;n++){const row=market.offers[n],next=expand(action('post',{kind:'exchange',give:{items:row[5][0],gold:row[5][1]},want:{items:row[6][0],gold:row[6][1]}}),prepared);assert.deepEqual(next.payload.give,ctx.observation.peer_market.offers[n].give);assert.deepEqual(next.payload.want,ctx.observation.peer_market.offers[n].want);}
  assert.deepEqual(data.body,[20,40,50,20,ctx.observation.self.survival.light.lit,ctx.observation.self.survival.danger_in_seconds]);
  assert.equal(data.food,undefined);assert.doesNotMatch(prepared.text,/inventory\{intent:use/);assert.match(prepared.text,/wait结束阅读/);
  const ordinary=prepareDecisionPrompt({...ctx,lastActionFeedback:undefined});assert.ok(ordinary.text.length<=2000);assert.doesNotMatch(ordinary.text,/wait结束阅读/);assert.match(ordinary.text,/food|cook|inventory/);
});
