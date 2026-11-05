import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';
import { PlazaRunner, parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { findWorldPath } from '../server/spatial.js';

async function walkTo(f,p,destination) {
  const path=findWorldPath(f.app.world,p.raw.scene_id,p.raw.position,destination);assert.ok(path,'fixture destination must be reachable');
  for(let i=3;i<path.length+3;i+=3){const next=path[Math.min(i,path.length-1)];if(p.raw.position.x===next.x&&p.raw.position.y===next.y)continue;await p.act('move',next);await f.until(()=>!p.raw.movement);}
}

async function setup(t,starterItems={}) {
  const f=await createHomesFixture({frontend:false,starterItems:{wood:100,grass:100,ore:40,moon_herb:4,berry:4,turnip:4,pond_fish:6,silver_fish:3,...starterItems}});t.after(()=>f.close());
  const p=await f.actor('原来的家园主人');await walkTo(f,p,(await p.call('get_rules')).life.camp_place.service_center);
  return {f,p};
}
const context=async(p,type,intent='browse')=>({rules:await p.call('get_rules'),observation:await p.observe(),ownerGoal:p.goal,events:[],lastActionFeedback:type?{type,status:'applied',requested:{intent,page:0}}:undefined});
const data=p=>JSON.parse(p.text.split('生活数据：')[1]);
function resolve(prepared,type,payload){return parseModelAction(expandDecisionReferences(JSON.stringify({type,payload}),prepared.references));}

test('v035 real MCP craft ACK recovery keeps one garment, original identity and a freely chosen next wear',async t=>{
  const {f,p}=await setup(t),original={id:p.id,appearance:structuredClone(p.raw.appearance),goal:p.goal},grass=p.raw.life.inventory.grass;
  const request=await p.request('wardrobe',{intent:'craft',style_id:'linen_shirt'}),receipt=await p.send(request);
  const runner=new PlazaRunner({mode:'model',now:f.now,toolClient:p.client});runner.running=true;runner.active=true;runner.rules=await p.call('get_rules');runner.observation=await p.observe();runner.save=()=>{};runner.report=async()=>{};
  runner.checkpoint={...p.session,queue:[],seen:[],calls_used:0,max_calls:10000,expires_at:p.raw.run.expires_at,pending_action:request};
  await runner.recoverPending();assert.deepEqual(await p.send(request),receipt);
  assert.equal(p.raw.wardrobe.items.length,1);assert.equal(p.raw.life.inventory.grass,grass-2);assert.equal(p.raw.wardrobe.wearing.outfit,null,'craft never grants consent to wear');
  assert.equal(runner.checkpoint.last_action_feedback.type,'wardrobe');assert.equal(runner.checkpoint.last_action_feedback.requested.intent,'craft');
  let ctx=await context(p,'wardrobe','craft'),prompt=prepareDecisionPrompt(ctx),d=data(prompt);
  assert.ok(prompt.text.length<=2000);assert.ok(d.op.wear?.length);assert.ok(d.dyes?.some(row=>row[0]==='rose'&&row[2].berry===1));
  const chosen=resolve(prompt,'wardrobe',{intent:'wear',garment_id:d.op.wear[0]});await p.act(chosen.type,chosen.payload);
  assert.equal(p.raw.wardrobe.wearing.outfit,p.raw.wardrobe.items[0].garment_id);
  ctx=await context(p,'wardrobe','wear');prompt=prepareDecisionPrompt(ctx);d=data(prompt);
  const berry=p.raw.life.inventory.berry,alias=d.owned[0][0];const dye=resolve(prompt,'wardrobe',{intent:'dye',garment_id:alias,color_id:'rose'});await p.act(dye.type,dye.payload);
  assert.equal(p.raw.life.inventory.berry,berry-1);assert.equal(p.raw.wardrobe.items[0].color_id,'rose');
  assert.deepEqual({id:p.id,appearance:p.raw.appearance,goal:p.goal},original);
  await f.advance(4000);assert.equal(p.raw.wardrobe.items.length,1);assert.equal(p.raw.life.inventory.berry,berry-1,'no automatic dye or crafting loop');
});

test('v035 real home construction, explicit approach and fish/decor edits remain distinct choices in host context',async t=>{
  const {f,p}=await setup(t);await p.act('home',{intent:'build',name:'原来的小屋'});const homeId='home_'+p.id;
  await p.act('home',{intent:'visit',home_id:homeId});await f.until(()=>!!p.raw.home_presence);
  await p.act('home',{intent:'craft',kind:'aquarium'});
  let observation=await p.observe();const home=f.app.world.state.homes[homeId],tank=home.furniture.find(v=>v.kind==='aquarium');assert.ok(tank);
  const place=(observation.homes.opportunities||[]).map(row=>row.action||row).find(row=>row.payload?.intent==='place'&&row.payload.instance_id===tank.instance_id);assert.ok(place,'actual legal room placement is discoverable');
  const storedPrompt=prepareDecisionPrompt(await context(p,'aquarium')),storedData=data(storedPrompt);
  const offeredPlacement=storedData.home_options.find(row=>row.payload.intent==='place');assert.ok(offeredPlacement,'stored tank exposes actual placement choices');
  const expandedPlacement=resolve(storedPrompt,'home',offeredPlacement.payload);assert.equal(expandedPlacement.payload.instance_id,tank.instance_id);
  assert.ok(observation.homes.opportunities.some(row=>JSON.stringify(row.payload)===JSON.stringify(expandedPlacement.payload)));
  assert.deepEqual(storedData.build.cost,{wood:4,ore:3});assert.equal(storedData.build.width,2);assert.equal(storedData.build.height,1);
  await p.act(place.type,place.payload);await p.act('aquarium',{intent:'browse',page:0});
  let prompt=prepareDecisionPrompt(await context(p,'aquarium')),d=data(prompt);assert.ok(prompt.text.length<=2000);assert.equal(d.tank_count,1);
  const held=p.raw.life.inventory.pond_fish;
  if(!d.tanks[0][5]) {
    const chosen=resolve(prompt,'aquarium',{intent:'approach',instance_id:d.tanks[0][0]});await p.act(chosen.type,chosen.payload);
    assert.equal(tank.aquarium.fish.length,0);assert.equal(p.raw.life.inventory.pond_fish,held);
    prompt=prepareDecisionPrompt(await context(p,'aquarium','approach'));d=data(prompt);assert.ok(d.moving);assert.ok(!d.op.put,'a walk does not advertise remote fish placement');
    await f.until(()=>!p.raw.home_presence.movement);
  }
  prompt=prepareDecisionPrompt(await context(p,'aquarium','approach'));d=data(prompt);assert.equal(d.tanks[0][5],true);
  const chosen=resolve(prompt,'aquarium',{intent:'put',instance_id:d.tanks[0][0],item_id:'pond_fish',name:'自己选的鱼名'});await p.act(chosen.type,chosen.payload);
  assert.equal(p.raw.life.inventory.pond_fish,held-1);assert.equal(tank.aquarium.fish.length,1);assert.equal(tank.aquarium.fish[0].name,'自己选的鱼名');
  prompt=prepareDecisionPrompt(await context(p,'aquarium','put'));d=data(prompt);assert.equal(d.owner,p.goal);assert.ok(d.decorations.some(row=>row[0]==='water_grass'&&row[2].grass===1));
  const grass=p.raw.life.inventory.grass,decoration=resolve(prompt,'aquarium',{intent:'decorate',instance_id:d.tanks[0][0],slot:1,decoration_id:'water_grass'});await p.act(decoration.type,decoration.payload);
  assert.equal(p.raw.life.inventory.grass,grass-1);
  await f.advance(2000);assert.equal(tank.aquarium.fish.length,1);assert.equal(p.raw.life.inventory.pond_fish,held-1);assert.equal(tank.aquarium.decorations.length,1);
  const publicWorld=(await f.api('/api/public/world')).body;assert.equal(JSON.stringify(publicWorld).includes(p.goal),false);assert.equal(JSON.stringify(publicWorld).includes(p.token),false);
});

test('v035 wardrobe pages remain bounded while complete cost/owner facts and a return to ordinary life stay available',async t=>{
  const {p}=await setup(t);for(let i=0;i<9;i++)await p.act('wardrobe',{intent:'craft',style_id:'linen_shirt'});
  await p.act('wardrobe',{intent:'browse',page:1});let ctx=await context(p,'wardrobe'),prompt=prepareDecisionPrompt(ctx),d=data(prompt);
  assert.equal(d.page,1);assert.equal(d.pages,3);assert.equal(d.owned_count,9);assert.equal(d.owned.length,4);assert.ok(prompt.text.length<=2000);
  assert.ok(d.op.wear?.length);assert.equal(d.owner,p.goal);assert.match(prompt.text,/wait/);
  assert.ok(!d.catalog_omitted,'a full page still permits independent crafts and dyes');
  assert.ok(d.styles.some(row=>row[0]==='linen_shirt'&&row.at(-1).grass===2));assert.ok(d.dyes.some(row=>row[0]==='rose'&&row.at(-1).berry===1));
  assert.ok(d.op.dye?.length||Object.values(d.dye_options||{}).some(colors=>colors.includes('rose')));
  const before=structuredClone(p.raw.wardrobe);await p.act('wait',{});assert.deepEqual(p.raw.wardrobe,before);
  ctx=await context(p);prompt=prepareDecisionPrompt(ctx);assert.ok(!prompt.text.includes('生活数据：'),'a wait does not keep an enforced wardrobe task');
});

test('v035 ordinary home discovery offers both services while keeping existing household choices',async t=>{
  const {f,p}=await setup(t);await p.act('home',{intent:'build',name:'原本的小屋'});
  await p.act('home',{intent:'visit',home_id:'home_'+p.id});await f.until(()=>!!p.raw.home_presence);
  const ctx=await context(p),prompt=prepareDecisionPrompt(ctx);
  assert.ok(prompt.text.length<=2000);assert.match(prompt.text,/wardrobe\{intent:browse/);assert.match(prompt.text,/aquarium\{intent:browse/);
  assert.ok(prompt.text.includes(p.goal));assert.match(prompt.text,/home/);assert.ok(!prompt.text.includes('生活数据：'),'discovery does not select a service');
});

test('v035 an actually caught fish can be placed and retrieved through MCP without another catch or model decision',async t=>{
  const {f,p}=await setup(t,{pond_fish:0,silver_fish:0});
  const original={id:p.id,goal:p.goal,appearance:structuredClone(p.raw.appearance)};
  await p.act('home',{intent:'build',name:'放鱼的小屋'});
  await walkTo(f,p,(await p.call('get_rules')).life.crafting_place.service_center);
  for(const item_id of ['fishing_rod','fish_bait'])await p.act('inventory',{intent:'craft',item_id});
  const rules=await p.call('get_rules');await p.act('fish',{intent:'start',spot_id:rules.fishing.spots[0].id,bait_id:'fish_bait'});
  await f.until(()=>!p.raw.fishing);
  const item_id=['pond_fish','silver_fish'].find(id=>p.raw.life.inventory[id]>0);assert.ok(item_id);
  const caught=p.raw.life.inventory[item_id];assert.equal(caught,1);
  await p.act('home',{intent:'visit',home_id:'home_'+p.id});await f.until(()=>!!p.raw.home_presence);
  await p.act('home',{intent:'craft',kind:'aquarium'});
  const house=f.app.world.state.homes['home_'+p.id],tank=house.furniture.find(v=>v.kind==='aquarium');
  const place=(await p.observe()).homes.opportunities.map(v=>v.action||v).find(v=>v.payload?.intent==='place'&&v.payload.instance_id===tank.instance_id);assert.ok(place);await p.act(place.type,place.payload);
  await p.act('aquarium',{intent:'approach',instance_id:tank.instance_id});await f.until(()=>!p.raw.home_presence.movement);
  let prompt=prepareDecisionPrompt(await context(p,'aquarium','approach')),d=data(prompt);
  assert.ok(d.available_fish.some(row=>row[0]===item_id&&row[1]===1));
  let choice=resolve(prompt,'aquarium',{intent:'put',instance_id:d.tanks[0][0],item_id});const placed=await p.applied(choice.type,choice.payload);
  assert.equal(p.raw.life.inventory[item_id]||0,0);assert.equal(tank.aquarium.fish.length,1);assert.equal(tank.aquarium.fish[0].item_id,item_id);
  assert.deepEqual(await p.send(placed.req),placed.receipt);assert.equal(tank.aquarium.fish.length,1);
  prompt=prepareDecisionPrompt(await context(p,'aquarium','put'));d=data(prompt);
  choice=resolve(prompt,'aquarium',{intent:'remove',instance_id:d.tanks[0][0],fish_id:d.tanks[0][7][0][0]});const removed=await p.applied(choice.type,choice.payload);
  assert.deepEqual(await p.send(removed.req),removed.receipt);assert.equal(p.raw.life.inventory[item_id],caught);assert.equal(tank.aquarium.fish.length,0);
  await f.advance(35000);assert.equal(p.raw.life.inventory[item_id],caught);assert.equal(tank.aquarium.fish.length,0);
  assert.equal(f.app.world.state.events.filter(e=>e.type==='fish_finished'&&e.payload.agent_id===p.id).length,1);
  assert.deepEqual({id:p.id,goal:p.goal,appearance:p.raw.appearance},original);
});
