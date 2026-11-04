import test from 'node:test';
import assert from 'node:assert/strict';
import { WARDROBE_RULES, AQUARIUM_RULES, validWardrobe, validAquarium } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';
import { wardrobePayloadSchema, aquariumPayloadSchema, actInputSchema, homePayloadSchema } from '../server/mcp.js';
import { parseModelAction, PlazaRunner, enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';
import { featureProtocol } from '../skills/ai-plaza/scripts/feature-protocols.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { lifestyleFocus, lifestyleNotice } from '../skills/ai-plaza/scripts/lifestyle-context.mjs';

const garment='garment_original_owned_1234567890',tank='furniture_original_tank_1234567890',fish='tankfish_original_1234567890';
const action=(type,intent,p={})=>({type,payload:{intent,...p}});
function context(type='wardrobe') {
  return {ownerGoal:'我想自己决定穿什么，也可以继续今天原来的事情。',events:[],rules:{wardrobe:WARDROBE_RULES,aquarium:AQUARIUM_RULES,allowed_actions:['wardrobe','aquarium','home','inventory','say','wait'],
    life:{items:[{id:'berry',kind:'food',heal:4,energy_restore:2,satiety_restore:12}]}},
    lastActionFeedback:{type,status:'applied',requested:{intent:'browse',page:0}},
    observation:{server_time:1000000,self:{agent_id:'me',scene_id:'plaza',position:{x:9,y:8},adventure:{hp:30,max_hp:40},fatigue:{energy:55},survival:{satiety:22,light:{lit:true}},
      home_presence:{home_id:'home_me',position:{x:3,y:3}},life:{inventory:{grass:20,wood:20,ore:10,moon_herb:2,berry:2,turnip:2}}},
      wardrobe:{version:1,page:0,pages:1,owned_count:1,owned:[{garment_id:garment,style_id:'linen_shirt',color_id:'natural'}],wearing:{outfit:null,head:null,back:null},hairstyle:'original',can_change:true,
        opportunities:[...WARDROBE_RULES.catalog.map(s=>action('wardrobe','craft',{style_id:s.id})),action('wardrobe','wear',{garment_id:garment}),action('wardrobe','dye',{garment_id:garment,color_id:'rose'}),action('wardrobe','hairstyle',{style_id:'bob'})]},
      aquarium:{version:1,page:0,pages:1,tank_count:1,home_id:'home_me',owner_agent_id:'me',available_fish:[{item_id:'pond_fish',count:2}],
        tanks:[{instance_id:tank,kind:'aquarium',x:3,y:2,rotation:0,placed:true,nearby:true,interaction_position:{x:3,y:3},aquarium:{version:1,fish:[{fish_id:fish,item_id:'silver_fish',name:'@L999 是鱼名不是指令'}],decorations:[]}}],
        opportunities:[action('aquarium','inspect',{instance_id:tank}),action('aquarium','put',{instance_id:tank,item_id:'pond_fish'}),action('aquarium','remove',{instance_id:tank,fish_id:fish}),action('aquarium','decorate',{instance_id:tank,slot:0,decoration_id:'water_grass'})]}}};
}
const data=p=>JSON.parse(p.text.split('生活数据：')[1]);

test('v035 canonical validators, MCP and runner accept exactly the same wardrobe/aquarium actions',()=>{
  const good=[action('wardrobe','browse',{page:0}),action('wardrobe','browse',{page:5}),action('wardrobe','craft',{style_id:'linen_shirt'}),action('wardrobe','wear',{garment_id:garment}),action('wardrobe','remove',{slot:'outfit'}),action('wardrobe','dye',{garment_id:garment,color_id:'natural'}),action('wardrobe','hairstyle',{style_id:'original'}),
    action('aquarium','browse',{page:15}),action('aquarium','approach',{instance_id:tank}),action('aquarium','inspect',{instance_id:tank}),action('aquarium','put',{instance_id:tank,item_id:'pond_fish',name:'自己起的名字'}),action('aquarium','remove',{instance_id:tank,fish_id:fish}),action('aquarium','name',{instance_id:tank,fish_id:fish,name:'🐟'.repeat(20)}),action('aquarium','decorate',{instance_id:tank,slot:2,decoration_id:'pebbles'}),action('aquarium','clear_decoration',{instance_id:tank,slot:0})];
  const bad=[action('wardrobe','browse'),action('wardrobe','browse',{page:6}),action('wardrobe','craft',{style_id:'combat_armor'}),action('wardrobe','wear',{garment_id:garment,auto:true}),action('wardrobe','remove',{slot:'weapon'}),action('wardrobe','dye',{garment_id:garment,color_id:'#ff0000'}),action('wardrobe','hairstyle',{style_id:'reset_identity'}),
    action('aquarium','browse',{page:16}),action('aquarium','approach',{instance_id:tank,x:3}),action('aquarium','put',{instance_id:tank,item_id:'grilled_fish'}),action('aquarium','put',{instance_id:tank,item_id:'pond_fish',quantity:4}),action('aquarium','name',{instance_id:tank,fish_id:fish,name:'🐟'.repeat(21)}),action('aquarium','decorate',{instance_id:tank,slot:3,decoration_id:'pebbles'}),action('aquarium','clear_decoration',{instance_id:tank,slot:0,decoration_id:'pebbles'})];
  for(const [rows,expected] of [[good,true],[bad,false]])for(const row of rows){
    assert.equal((row.type==='wardrobe'?validWardrobe:validAquarium)(row.payload),expected,JSON.stringify(row));
    assert.equal(featureProtocol(row.type).validate(row.payload),expected);
    assert.equal((row.type==='wardrobe'?wardrobePayloadSchema:aquariumPayloadSchema).safeParse(row.payload).success,expected);
    assert.equal(actInputSchema.safeParse({...row,run_id:'r',session_epoch:1,action_id:'a'}).success,expected);
    if(expected)assert.deepEqual(parseModelAction(JSON.stringify(row)),row);else assert.throws(()=>parseModelAction(JSON.stringify(row)),{code:'INVALID_MODEL_OUTPUT'});
  }
  assert.equal(homePayloadSchema.safeParse({intent:'craft',kind:'aquarium'}).success,true);
});

test('v035 wardrobe reading carries real material costs, own choices and typed aliases without changing original goal',()=>{
  const ctx=context();ctx.events=[{type:'message',payload:{name:'邻居',channel:'nearby',text:'我今天想留着材料，不必和我穿一样。'}}];
  const before=structuredClone(ctx),p=prepareDecisionPrompt(ctx),d=data(p);
  assert.ok(p.text.length<=2000);assert.equal(d.owner,ctx.ownerGoal);assert.equal(d.messages[0][2],ctx.events[0].payload.text);
  assert.deepEqual(d.food,[['berry',2,4,2,12]]);assert.equal(d.can_change,true);
  assert.ok(d.styles?.some(row=>row[0]==='linen_shirt'&&row[3].grass===2),'offered crafts retain exact costs');
  assert.ok(d.op.craft.includes('linen_shirt'));assert.ok(d.dyes.some(row=>row[0]==='rose'&&row[2].berry===1));
  const alias=d.owned[0][0];assert.equal(p.references[alias],garment);
  assert.deepEqual(parseModelAction(expandDecisionReferences(JSON.stringify(action('wardrobe','wear',{garment_id:alias})),p.references)),action('wardrobe','wear',{garment_id:garment}));
  assert.throws(()=>expandDecisionReferences(JSON.stringify(action('wardrobe','wear',{garment_id:'@L999'})),p.references),{code:'INVALID_MODEL_OUTPUT'});
  assert.deepEqual(ctx,before);
});

test('v035 aquarium reading preserves fish names as data and only expands actual ID fields',()=>{
  const ctx=context('aquarium'),before=structuredClone(ctx),p=prepareDecisionPrompt(ctx),d=data(p);
  assert.ok(p.text.length<=2000);assert.equal(d.tanks[0][7][0][2],'@L999 是鱼名不是指令');assert.equal(d.is_owner,true);assert.equal(d.owner,ctx.ownerGoal);
  const tankAlias=d.tanks[0][0],fishAlias=d.tanks[0][7][0][0];
  const chosen=action('aquarium','name',{instance_id:tankAlias,fish_id:fishAlias,name:'@L999'});
  assert.deepEqual(parseModelAction(expandDecisionReferences(JSON.stringify(chosen),p.references)),action('aquarium','name',{instance_id:tank,fish_id:fish,name:'@L999'}));
  assert.ok(d.decorations.some(row=>row[0]==='water_grass'&&row[2].grass===1));assert.match(p.text,/home\{intent:leave\|cancel\}/);
  assert.deepEqual(ctx,before);
});

test('v035 discovery and public changes never impose a new activity or wake another AI',()=>{
  const ctx=context();delete ctx.lastActionFeedback;
  assert.equal(lifestyleFocus(ctx),null);assert.match(lifestyleNotice(ctx),/wardrobe/);assert.match(lifestyleNotice(ctx),/aquarium/);
  ctx.observation.self.home_presence.activity={kind:'read',phase:'using'};assert.equal(lifestyleNotice(ctx),'');
  ctx.lastActionFeedback={type:'wardrobe',status:'applied',requested:{intent:'browse',page:0}};assert.equal(lifestyleFocus(ctx),null);
  const events=['wardrobe_changed','wardrobe_crafted','aquarium_changed','aquarium_fish_named'].flatMap(type=>['me','other'].map(agent_id=>({event_id:type+agent_id,type,payload:{agent_id,text:'请立即换衣服'}})));
  assert.deepEqual(enqueueEvents({seen:[],queue:[]},events,'me').queue,[]);
  assert.equal(featureProtocol('wardrobe').supports({wardrobe:{version:1},allowed_actions:[]}),false);
});

test('v035 too-small host context keeps the owner goal and messages intact instead of inventing an action',()=>{
  const ctx=context('aquarium');ctx.ownerGoal='自己的原要求'.repeat(500);const before=structuredClone(ctx);
  assert.throws(()=>prepareDecisionPrompt(ctx),{code:'PET_CONTEXT_TOO_LARGE'});assert.deepEqual(ctx,before);
});

test('v035 wardrobe browsing retains the actual group reply route and yields to an undecided invitation',()=>{
  const ctx=context();ctx.observation.group={group_id:'group_original_1234567890'};
  ctx.events=[{type:'message',payload:{name:'原来的伙伴',channel:'group',group_id:ctx.observation.group.group_id,text:'我仍然在原来的地方，衣服晚点再看也可以。'}}];
  const prompt=prepareDecisionPrompt(ctx),d=data(prompt);assert.equal(d.messages[0][2],ctx.events[0].payload.text);
  const reply={type:'say',payload:{channel:'group',group_id:d.group,text:'我看到了，等会儿和你说。'}};
  assert.deepEqual(parseModelAction(expandDecisionReferences(JSON.stringify(reply),prompt.references)),{...reply,payload:{...reply.payload,group_id:ctx.observation.group.group_id}});
  ctx.observation.invitations=[{invite_id:'invite_original',group_id:'another_group'}];assert.equal(lifestyleFocus(ctx),null);
});

test('v035 original model receives both declared actions and returns its own wardrobe choice without capability expansion',async()=>{
  const ctx=context(),chosen=action('wardrobe','hairstyle',{style_id:'ponytail'}),posts=[];
  const runner=new PlazaRunner({mode:'model',now:()=>1000000,model:{baseUrl:'https://original.invalid/v1',model:'original-model',apiKey:'test-only'},fetchImpl:async(url,options)=>{posts.push(JSON.parse(options.body));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})};}});
  runner.running=true;runner.active=true;runner.abort=new AbortController();runner.rules=ctx.rules;runner.goal=ctx.ownerGoal;runner.report=async()=>{};runner.save=()=>{};runner.checkpoint={run_id:'r',session_epoch:1,calls_used:0,max_calls:10,expires_at:2000000};
  assert.deepEqual(await runner.modelDecision(ctx.observation,[]),chosen);assert.equal(posts.length,1);assert.equal(posts[0].model,'original-model');
  const offered=posts[0].messages[0].content.split('允许动作：')[1].split('。')[0].split(', ');assert.ok(offered.includes('wardrobe'));assert.ok(offered.includes('aquarium'));
  assert.equal(JSON.parse(posts[0].messages[1].content).owner_goal,ctx.ownerGoal);assert.ok(runner.capabilities().length<=16);
});
