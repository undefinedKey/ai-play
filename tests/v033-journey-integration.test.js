import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';
import { PlazaRunner, enqueueEvents, parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const chosen = payload => ({type:'journey',payload});
const decode = p => JSON.parse(p.text.split('横版旅程数据：')[1]);
async function setup(t) { const f=await createHomesFixture({frontend:false,authMode:'accounts',starterItems:{berry:2,wood:4,grass:3}});t.after(()=>f.close());return f; }
async function context(p) { return {rules:await p.call('get_rules'),observation:await p.observe(),ownerGoal:p.goal,events:[]}; }
async function enter(f,p) { await p.act('journey',{intent:'enter'});await f.until(()=>p.raw.scene_id==='journey','actual portal crossing'); }
async function travel(f,p,node_id,route='bypass') { await p.act('journey',{intent:'travel',node_id,route});await f.until(()=>!p.raw.journey_job,'finite route stops'); }

test('v033 actual MCP preserves a chosen entry through lost ACK and direct encounters never select combat',async t=>{
  const f=await setup(t),p=await f.actor('保持自己想法的旅人'),other=await f.actor('没有决定出门的同伴');
  const original={id:p.id,bio:p.raw.bio,goal:p.raw.goal,appearance:structuredClone(p.raw.appearance),otherPosition:{...other.raw.position}};
  const runner=new PlazaRunner({mode:'model',now:f.now,toolClient:p.client});runner.running=true;runner.active=true;runner.rules=await p.call('get_rules');runner.observation=await p.observe();runner.save=()=>{};runner.report=async()=>{};
  const request=await p.request('journey',{intent:'enter'}),receipt=await p.send(request),job=p.raw.journey_job.job_id;
  runner.checkpoint={...p.session,queue:[],seen:[],calls_used:0,max_calls:10000,expires_at:p.raw.run.expires_at,pending_action:request};
  await runner.recoverPending();assert.equal(p.raw.journey_job.job_id,job);assert.equal(runner.checkpoint.pending_action,null);assert.deepEqual(await p.send(request),receipt);
  let prompt=prepareDecisionPrompt(await context(p));assert.equal(decode(prompt).scene,'plaza');assert.equal(decode(prompt).job[0],'enter');assert.match(prompt.text,/stop/);
  await f.until(()=>p.raw.scene_id==='journey','actual forest entry');assert.deepEqual(p.raw.position,{x:2,y:16});assert.equal(p.raw.journey_job,null);
  assert.deepEqual(other.raw.position,original.otherPosition);assert.equal(other.raw.scene_id,'plaza');assert.equal(other.raw.journey_job??null,null);
  const hp=p.raw.adventure.hp,monsterHp=f.app.world.state.journey.monsters[0].hp;
  await travel(f,p,'clearing','direct');assert.deepEqual(p.raw.position,{x:15,y:16});assert.equal(p.raw.journey_last_result.kind,'encounter');
  await f.advance(30000);assert.deepEqual(p.raw.position,{x:15,y:16});assert.equal(p.raw.adventure.hp,hp);assert.equal(f.app.world.state.journey.monsters[0].hp,monsterHp);assert.equal(p.raw.journey_job,null);
  prompt=prepareDecisionPrompt(await context(p));const data=decode(prompt),row=data.op.find(r=>r[0]==='travel'&&r[1]==='clearing'&&r[2]==='bypass');assert.ok(row);
  const action=parseModelAction(expandDecisionReferences(JSON.stringify(chosen({intent:row[0],node_id:row[1],route:row[2]})),prompt.references));
  await p.act(action.type,action.payload);assert.ok(p.raw.movement.path.some(point=>point.y===18));await f.until(()=>!p.raw.journey_job);assert.deepEqual(p.raw.position,{x:26,y:16});
  assert.equal(p.raw.adventure.hp,hp);assert.equal(f.app.world.state.journey.monsters[0].hp,monsterHp);
  const events=f.app.world.state.events.filter(e=>e.type.startsWith('journey_')),queue=enqueueEvents({seen:[],queue:[]},[...events,...events],p.id,[],'journey').queue;
  assert.equal(queue.filter(e=>e.type==='journey_encounter').length,1);assert.ok(queue.some(e=>e.type==='journey_arrived'));assert.equal(queue.some(e=>e.type==='journey_started'),false);
  assert.deepEqual({id:p.id,bio:p.raw.bio,goal:p.raw.goal,appearance:p.raw.appearance},{id:original.id,bio:original.bio,goal:original.goal,appearance:original.appearance});
  const state=(await f.api('/api/public/world')).body;assert.equal(JSON.stringify(state).includes(p.goal),false);assert.equal(JSON.stringify(state).includes(p.token),false);
});

test('v033 observed near resources, explicit eating and finite camp rest form a real MCP loop without automatic repetition',async t=>{
  const f=await setup(t),p=await f.actor('自己选择补给的旅人');p.raw.fatigue.energy=65;p.raw.survival.satiety=20;f.app.world.commit();
  await enter(f,p);let prompt=prepareDecisionPrompt(await context(p));assert.equal(decode(prompt).resources.length,0,'unreached gathering targets must not be offered as usable');
  await travel(f,p,'camp');prompt=prepareDecisionPrompt(await context(p));let data=decode(prompt);const berry=data.resources.find(row=>prompt.references[row[0]]==='journey_berries');assert.ok(berry);
  assert.ok(data.camp.build.some(row=>row[0]==='campfire'));assert.deepEqual(data.camp.held,{wood:4,grass:3,ore:0,pine_cone:0});
  const gather=parseModelAction(expandDecisionReferences(JSON.stringify({type:'gather',payload:{intent:'start',node_id:berry[0]}}),prompt.references));
  const before=p.raw.life.inventory.berry;await p.act(gather.type,gather.payload);await f.until(()=>!p.raw.life.gathering,'one real gathering completed');assert.equal(p.raw.life.inventory.berry,before+2);
  const afterGather={...p.raw.position};await f.advance(3000);assert.deepEqual(p.raw.position,afterGather);assert.equal(p.raw.life.inventory.berry,before+2,'food must not be eaten or harvested again automatically');
  const satiety=p.raw.survival.satiety;await p.act('inventory',{intent:'use',item_id:'berry'});assert.equal(p.raw.life.inventory.berry,before+1);assert.ok(p.raw.survival.satiety>satiety);
  await travel(f,p,'camp');await p.act('survival',{intent:'build',site_id:'journey_camp',kind:'campfire'});
  prompt=prepareDecisionPrompt(await context(p));data=decode(prompt);assert.equal(data.camp.fire[1],true);assert.ok(data.camp.fire[2]>0);assert.equal(data.camp.build,undefined);
  assert.ok(data.craft.some(row=>row[0]==='roasted_berry'),'lit actual camp exposes its cooking ingredients and energy cost');
  const berries=p.raw.life.inventory.berry;await p.act('inventory',{intent:'craft',item_id:'roasted_berry'});assert.equal(p.raw.life.inventory.berry,berries-1);assert.equal(p.raw.life.inventory.roasted_berry,1);
  await f.advance(1000);assert.equal(p.raw.life.inventory.roasted_berry,1,'cooking never grants consent to eat');
  const energy=p.raw.fatigue.energy;await p.act('journey',{intent:'rest',duration_seconds:15});assert.equal(p.raw.journey_job.phase,'resting');await f.advance(15100);assert.equal(p.raw.journey_job,null);assert.ok(p.raw.fatigue.energy>energy);
  const rested=p.raw.fatigue.energy;await f.advance(5000);assert.equal(p.raw.journey_job,null);assert.equal(p.raw.fatigue.energy,rested,'completed explicit rest does not silently renew');
  await p.act('journey',{intent:'leave',route:'bypass'});await f.until(()=>p.raw.scene_id==='plaza');assert.deepEqual(p.raw.position,{x:46,y:20});assert.equal(p.raw.goal,p.goal);
});
