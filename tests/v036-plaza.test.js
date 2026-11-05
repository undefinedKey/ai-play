import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,basename } from 'node:path';
import { World } from '../server/world.js';
import { initializePlazaLayout } from '../server/plaza-layout.js';
import { PLAZA_LAYOUT,PLAZA_SERVICES,PLAZA_LAYOUT_VERSION,PLAZA_PROPS,PLAZA_ROADS } from '../shared/plaza-layout.js';
import { createPlazaMap } from '../shared/plaza-map.js';
import { SCENES,isWalkable } from '../shared/world-layout.js';
import { findWorldPath } from '../server/spatial.js';
import { RESOURCE_NODES } from '../shared/resources-layout.js';
import { CAMP_SITES } from '../shared/survival-rules.js';
import { COMMUNITY_VENUES } from '../shared/community.js';
import { FISHING_SPOTS } from '../shared/fishing-layout.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { verifyScenes } from '../deploy/verify-scenes.mjs';

function fixture(t,count=1,options={}) {
  let now=2000000000000,closed=false; const world=new World({now:()=>now,actionIntervalMs:0,...options});
  const close=()=>{if(!closed){closed=true;world.close();}};t.after(close);
  const players=Array.from({length:count},(_,n)=>{
    const {agent_id:id}=world.createAgent({name:'布局测试'+n,owner_id:'layout_owner_'+n}),c=world.createController(id);
    world.ownerControl(id,'start',{controller_id:c.controller_id,duration_minutes:60,max_calls:1000});const auth=world.authenticate(c.token);world.callTool(auth,'join_world');
    return {id,auth,get a(){return world.agent(id);},observe(){return world.callTool(auth,'observe',{run_id:this.a.run.run_id,session_epoch:this.a.session_epoch});},
      act(type,payload){const o=this.observe();return world.callTool(auth,'act',{run_id:o.run_id,session_epoch:o.session_epoch,action_id:o.next_action_id,type,payload});},
      ok(type,payload){const r=this.act(type,payload);assert.equal(r.status,'applied',JSON.stringify(r));return r;},
      at(id){this.a.position={...PLAZA_SERVICES[id].interaction_position};},stock(){Object.assign(this.a.life.inventory,{wood:40,ore:40,grass:40,turnip:8,wheat:8,turnip_seed:4});this.a.adventure.gold=100;},
    };
  });
  const tick=ms=>{const end=now+ms;while(now<end){now=Math.min(end,now+100);for(const p of players)if(p.a.status==='active')p.a.last_contact_at=now;world.tick();}};
  const until=(fn,label,limit=120000)=>{const end=now+limit;while(!fn()&&now<end)tick(100);assert.ok(fn(),label);};
  return {world,players,tick,until,now:()=>now,close};
}

test('v036 one portable layout generates map, exact physical services and connected station/road geometry',t=>{
  const f=fixture(t),rules=f.world.getRules();
  assert.deepEqual(JSON.parse(readFileSync(new URL('../shared/maps/plaza.json',import.meta.url),'utf8')),createPlazaMap());
  assert.deepEqual(rules.plaza_layout,PLAZA_LAYOUT);assert.deepEqual(spectatorSnapshot(f.world).plaza_layout,PLAZA_LAYOUT);
  assert.deepEqual(rules.places,PLAZA_LAYOUT.places);assert.deepEqual(SCENES[0].props,PLAZA_PROPS);
  const targets=[...Object.values(PLAZA_SERVICES).map(s=>s.interaction_position),...FISHING_SPOTS.map(s=>s.interaction_position),
    ...COMMUNITY_VENUES.flatMap(v=>[v.interaction_position,...v.seats.map(s=>s.position)]),...RESOURCE_NODES.filter(n=>n.scene_id==='plaza').map(n=>n.interaction_position),...CAMP_SITES.filter(s=>s.scene_id==='plaza').map(s=>s.interaction_position)];
  for(const point of targets) {assert.ok(isWalkable('plaza',point),JSON.stringify(point));assert.ok(findWorldPath(f.world,'plaza',PLAZA_SERVICES.camp.interaction_position,point));}
  for(const road of PLAZA_ROADS)for(let i=1;i<road.points.length;i++){
    const from=road.points[i-1],to=road.points[i],dx=Math.sign(to.x-from.x),dy=Math.sign(to.y-from.y);assert.ok(!dx||!dy);
    const length=Math.abs(to.x-from.x)+Math.abs(to.y-from.y);for(let step=0;step<=length;step++)assert.ok(isWalkable('plaza',{x:from.x+dx*step,y:from.y+dy*step}),road.id);
  }
  for(const prop of PLAZA_PROPS)for(const point of prop.footprint)assert.equal(isWalkable('plaza',point),false,prop.id);
  for(const facility of [PLAZA_SERVICES.market,PLAZA_SERVICES.adventure,PLAZA_SERVICES.journey])for(const foot of facility.footprint)assert.equal(isWalkable('plaza',foot),false,facility.id+' solid display body');
  for(const spot of FISHING_SPOTS)assert.equal(isWalkable('plaza',spot.position),false,'fish belong to real water');
  assert.deepEqual(rules.life.camp_place.service_center,PLAZA_SERVICES.camp.interaction_position);
  assert.deepEqual(rules.fatigue.recovery.camp_center,PLAZA_SERVICES.camp.interaction_position);
  assert.deepEqual(rules.adventure.zones[0],{...rules.adventure.zones[0],...PLAZA_SERVICES.camp.interaction_position});
  assert.notDeepEqual(PLAZA_SERVICES.adventure.interaction_position,PLAZA_SERVICES.journey.interaction_position);
});

test('v036 old and wrong service points reject without teleport or spending; chosen real facilities perform existing costs',t=>{
  const f=fixture(t),[p]=f.players;p.stock();p.at('camp');
  for(const [type,payload] of [['inventory',{intent:'craft',item_id:'wooden_sword'}],['inventory',{intent:'craft',item_id:'turnip_soup'}],['trade',{intent:'buy',item_id:'wheat_bread',quantity:1}],['farm',{intent:'till',plot_id:'plot_1'}]]){
    const before=structuredClone({position:p.a.position,inventory:p.a.life.inventory,gold:p.a.adventure.gold});
    assert.equal(p.act(type,payload).error.code,'NOT_AT_SERVICE');assert.deepEqual({position:p.a.position,inventory:p.a.life.inventory,gold:p.a.adventure.gold},before);assert.equal(p.a.movement,null);
  }
  p.a.position={x:11,y:8};assert.equal(p.act('trade',{intent:'buy',item_id:'wheat_bread',quantity:1}).error.code,'NOT_AT_SERVICE');
  p.at('tools');const wood=p.a.life.inventory.wood;p.ok('inventory',{intent:'craft',item_id:'wooden_sword'});assert.equal(p.a.life.inventory.wood,wood-3);
  assert.equal(p.act('inventory',{intent:'equip',item_id:'wooden_sword'}).error.code,'NOT_AT_CAMP');p.at('camp');p.ok('inventory',{intent:'equip',item_id:'wooden_sword'});
  p.at('farm');p.ok('farm',{intent:'till',plot_id:'plot_1'});p.ok('farm',{intent:'plant',plot_id:'plot_1',crop_id:'turnip'});p.ok('farm',{intent:'water',plot_id:'plot_1'});
  p.at('kitchen');p.ok('inventory',{intent:'craft',item_id:'turnip_soup'});assert.equal(p.a.life.inventory.turnip,6);
  p.at('supply');p.ok('trade',{intent:'buy',item_id:'wheat_bread',quantity:1});assert.equal(p.a.adventure.gold,88);
  p.at('tools');p.ok('inventory',{intent:'repair',item_id:'hoe'});assert.equal(p.a.life.tools.hoe.durability,20);
  p.at('camp');assert.equal(p.a.wardrobe.items.length,0);p.ok('wardrobe',{intent:'craft',style_id:'linen_shirt'});p.ok('home',{intent:'build',name:'原身份之家'});
  assert.equal(p.a.personal_goal,null);assert.equal(p.a.adventure.plan,null);
});

test('v036 reading and game activities require the actual pavilion/table rather than old decoration coordinates',t=>{
  const f=fixture(t),[p]=f.players;
  p.a.position={x:19,y:4};assert.equal(p.act('start_activity',{activity_id:'read'}).status,'rejected');assert.equal(p.a.movement,null);
  p.at('reading');p.ok('start_activity',{activity_id:'read'});f.tick(46000);assert.equal(p.a.activity,null);
  p.at('play');p.ok('start_activity',{activity_id:'solo_game'});p.ok('finish_activity',{answer:p.a.activity.task.answer});assert.equal(p.a.activity,null);
  assert.equal(p.a.personal_goal,null);
});

test('v036 explicit visits and approaches travel to real entrance/venue and never buy, cook or fish implicitly',t=>{
  const f=fixture(t),[p]=f.players;p.stock();p.at('camp');p.ok('home',{intent:'build',name:'门后原来的小屋'});
  p.ok('home',{intent:'visit',home_id:`home_${p.id}`});assert.ok(p.a.movement.path.some(q=>q.x===24&&q.y===6));f.until(()=>!!p.a.home_presence,'home entry');
  assert.deepEqual(p.a.home_presence.position,{x:5,y:7});p.ok('home',{intent:'leave'});assert.deepEqual(p.a.position,PLAZA_SERVICES.home.interaction_position);
  const inventory=structuredClone(p.a.life.inventory);p.ok('peer_market',{intent:'approach'});f.until(()=>!p.a.movement,'market arrival');
  assert.deepEqual(p.a.position,PLAZA_SERVICES.market.interaction_position);assert.deepEqual(p.a.life.inventory,inventory);
  p.ok('community',{intent:'use',seat_id:'stage_left',activity:'sit',duration_seconds:15});f.until(()=>p.a.community_job?.phase==='using','real stage seat');
  assert.deepEqual(p.a.position,COMMUNITY_VENUES.find(v=>v.id==='stage').seats.find(s=>s.id==='stage_left').position);f.until(()=>!p.a.community_job,'finite seating ends');
  assert.deepEqual(p.a.life.inventory,inventory);assert.equal(p.a.fishing??null,null);
});

test('v036 the two edge portals lead to their own real scene and preserve old wilderness geometry',t=>{
  const f=fixture(t,2),[p,q]=f.players;p.at('camp');q.at('camp');
  p.ok('journey',{intent:'enter'});assert.deepEqual(p.a.movement.path.at(-1),PLAZA_SERVICES.journey.interaction_position);f.until(()=>p.a.scene_id==='journey','sideview arrival');
  assert.deepEqual(p.a.position,{x:2,y:16});assert.equal(p.a.journey_job,null);
  q.ok('adventure_plan',{intent:'explore',zone_id:'forest'});f.until(()=>!!q.a.movement,'wilderness travel');assert.deepEqual(q.a.movement.path.at(-1),PLAZA_SERVICES.adventure.interaction_position);
  f.until(()=>q.a.scene_id==='adventure','wilderness arrival');q.ok('adventure_plan',{intent:'stop'});assert.deepEqual(q.a.position,{x:11,y:8});
});

test('v036 saved layout migration retains legal points, repairs only plaza blockers, records proof and cannot replay paths',t=>{
  const dir=mkdtempSync(join(tmpdir(),'plaza-v036-')),dbPath=join(dir,'world.sqlite'),f=fixture(t,4,{dbPath}),[p,q,r,s]=f.players;p.stock();p.at('camp');p.ok('home',{intent:'build',name:'存档中的原屋'});
  p.a.position={x:20.5,y:16};q.a.position={x:24,y:5};r.a.scene_id='adventure';r.a.position={x:11,y:8};s.a.scene_id='journey';s.a.position={x:12,y:16};
  q.a.movement={movement_id:'old_path_id',path:[{x:24,y:5},{x:24,y:6}]};delete f.world.state.plaza_layout_version;
  const old=structuredClone(f.world.state);f.world.commit();f.close();
  let restored=new World({dbPath,now:f.now,actionIntervalMs:0});const current=structuredClone(restored.state);
  assert.deepEqual(verifyScenes(old,current),{scene_locations_preserved:true,plaza_layout_verified:true,migrated:2,repaired:1});
  assert.deepEqual(current.agents[p.id].position,old.agents[p.id].position);assert.equal(isWalkable('plaza',current.agents[q.id].position),true);
  for(const id of [r.id,s.id]){assert.deepEqual(current.agents[id].position,old.agents[id].position);assert.equal(current.agents[id].plaza_layout_migration,undefined);}
  assert.deepEqual(current.homes,old.homes);
  for(const id of Object.keys(old.agents))for(const key of ['appearance','life','wardrobe','run','goal','personal_goal'])assert.deepEqual(current.agents[id][key],old.agents[id][key],key);
  for(const modify of [n=>delete n.agents[p.id].plaza_layout_migration,n=>n.agents[q.id].plaza_layout_migration.position.x++,n=>n.events=n.events.filter(e=>e.type!=='plaza_layout_migrated'),n=>n.agents[r.id].position.x++,n=>n.agents[p.id].position.x++]){const changed=structuredClone(current);modify(changed);assert.throws(()=>verifyScenes(old,changed));}
  restored.close();restored=new World({dbPath,now:f.now});assert.deepEqual(restored.state.agents[p.id].plaza_layout_migration,current.agents[p.id].plaza_layout_migration);
  assert.equal(restored.state.events.filter(e=>e.type==='plaza_layout_migrated').length,2);restored.close();
  assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('plaza-v036-'));rmSync(dir,{recursive:true,force:true});
});

test('v036 layout repair itself never edits an occupied private room position or other-scene action',t=>{
  const f=fixture(t,2),[p,q]=f.players;p.a.home_presence={position:{x:2.5,y:4},movement:{private:'room route'}};p.a.position={x:24,y:5};q.a.scene_id='adventure';q.a.position={x:11,y:8};q.a.movement={movement_id:'wild_route'};
  const room=structuredClone(p.a.home_presence),other=structuredClone(q.a);delete f.world.state.plaza_layout_version;const transitions=initializePlazaLayout(f.world,{restore:true});
  assert.equal(transitions.length,1);assert.deepEqual(p.a.home_presence,room);assert.deepEqual(q.a,other);assert.equal(f.world.state.plaza_layout_version,PLAZA_LAYOUT_VERSION);
});

test('v036 a real ordinary plaza campfire still lights the meeting centre for a separately chosen night rest',t=>{
  const f=fixture(t),[p]=f.players;p.stock();p.at('camp');
  f.world.state.day_cycle.epoch_at=f.now()-370000;f.world.state.day_cycle.last_at=f.now();
  p.ok('survival',{intent:'approach',site_id:'plaza_hearth'});f.until(()=>!p.a.survival.travel,'actual hearth arrival');
  const wood=p.a.life.inventory.wood,grass=p.a.life.inventory.grass;
  p.ok('survival',{intent:'build',site_id:'plaza_hearth',kind:'campfire'});
  assert.equal(p.a.life.inventory.wood,wood-3);assert.equal(p.a.life.inventory.grass,grass-2);
  assert.equal(p.a.adventure.plan,null,'building a fire does not choose rest');
  p.a.fatigue.energy=40;
  p.ok('adventure_plan',{intent:'rest'});
  f.until(()=>!p.a.movement && p.a.position.x===24 && p.a.position.y===16,'original rest target reached');
  assert.equal(p.observe().self.survival.light.lit,true,'authored ordinary fire actually illuminates centre');
  const energy=p.a.fatigue.energy;f.tick(3000);assert.ok(p.a.fatigue.energy>energy,'rest restores energy using actual light');
});

test('v036 fishing preparation opportunities use the real workshop and each offered rod action executes there',t=>{
  const f=fixture(t),[p]=f.players;p.stock();p.at('camp');
  const rodActions=()=>p.observe().fishing.opportunities.filter(o=>o.type==='inventory'&&o.payload.item_id==='fishing_rod');
  assert.equal(rodActions().length,0,'the meeting area cannot advertise remote tool manufacture');
  p.at('tools');let options=rodActions();assert.ok(options.some(o=>o.payload.intent==='craft'));
  p.ok('inventory',options.find(o=>o.payload.intent==='craft').payload);assert.equal(p.a.life.tools.fishing_rod.owned,true);
  p.a.life.tools.fishing_rod.durability=0;options=rodActions();assert.ok(options.some(o=>o.payload.intent==='repair'));
  p.ok('inventory',options.find(o=>o.payload.intent==='repair').payload);assert.equal(p.a.life.tools.fishing_rod.durability,12);
  options=rodActions();assert.ok(options.some(o=>o.payload.intent==='upgrade'));p.ok('inventory',options.find(o=>o.payload.intent==='upgrade').payload);
  assert.equal(p.a.life.tools.fishing_rod.level,2);p.a.life.tools.fishing_rod.durability=0;p.at('camp');assert.equal(rodActions().length,0);
  assert.equal(p.a.fishing??null,null);assert.equal(p.a.personal_goal,null);
});

for(const clockMode of ['wall-clock','advancing-clock']) test(`v036 release migration proof permits real constructor event delay and rejects forged timing: ${clockMode}`,()=>{
  const root=resolve(tmpdir()),directory=mkdtempSync(join(root,'v036-clock-proof-')),dbPath=join(directory,'world.sqlite');let world;
  let clock=Date.now();const now=clockMode==='wall-clock'?()=>Date.now():()=>++clock;
  try {
    world=new World({dbPath,now,actionIntervalMs:0});
    for(let i=0;i<25;i++)world.createAgent({name:'迁移时间验证'+i});
    delete world.state.plaza_layout_version;world.commit();const before=structuredClone(world.state);world.close();
    world=new World({dbPath,now,actionIntervalMs:0});const current=structuredClone(world.state);
    assert.equal(verifyScenes(before,current).plaza_layout_verified,true);
    const id=Object.keys(before.agents)[0],record=current.agents[id].plaza_layout_migration;
    const event=current.events.findLast(e=>e.type==='plaza_layout_migrated'&&e.payload.agent_id===id),restart=current.events.findLast(e=>e.type==='server_restarted');
    assert.ok(record.at<=event.occurred_at&&event.occurred_at<=restart.occurred_at);
    if(clockMode==='advancing-clock')assert.ok(event.occurred_at>record.at,'event publication and point migration need not happen in the same millisecond');
    for(const invalidTime of [record.at-1,restart.occurred_at+1]){
      const forged=structuredClone(current);forged.events.find(e=>e.cursor===event.cursor).occurred_at=invalidTime;
      assert.throws(()=>verifyScenes(before,forged),'publication must be inside this actual restart interval');
    }
    world.close();world=new World({dbPath,now,actionIntervalMs:0});
    assert.equal(verifyScenes(current,world.state).migrated,0,'same layout restart preserves original timing evidence');
  } finally {world?.close();assert.equal(dirname(resolve(directory)),root);assert.ok(basename(directory).startsWith('v036-clock-proof-'));rmSync(directory,{recursive:true,force:true});}
});
