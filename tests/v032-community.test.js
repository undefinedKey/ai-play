import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { COMMUNITY_RULES, initializeCommunity, publicCommunity, publicCommunityJob } from '../server/community.js';
import { validCommunity as validate, COMMUNITY_FOOD_IDS } from '../shared/community.js';
import { LIFE_RULES } from '../server/life.js';
import { spectatorSnapshot, publicEvent } from '../server/spectator.js';
import { findWorldPath, initializeScene, publicMovement, recordMovement } from '../server/spatial.js';
import { isWalkable } from '../shared/world-layout.js';

const venue=id=>COMMUNITY_RULES.venues.find(v=>v.id===id),seat=id=>COMMUNITY_RULES.venues.flatMap(v=>v.seats).find(s=>s.id===id);
const post=(venue_id='picnic')=>({intent:'post',venue_id,title:'自己带点吃的',text:'愿意的话来聊聊，不来没有关系。',duration_seconds:300});
function fixture(t,count=2) {
  let now=2000000000000;
  const world=new World({now:()=>now,actionIntervalMs:0});t.after(()=>world.close());
  const players=Array.from({length:count},(_,i)=>{
    const id=world.createAgent({name:`场地来客${i}`,bio:`原来的性格${i}`,owner_id:`venue-owner-${i}`}).agent_id,controller=world.createController(id);
    world.ownerControl(id,'start',{controller_id:controller.controller_id,duration_minutes:30,max_calls:10000,goal:`原主人目标${i}`});
    const auth=world.authenticate(controller.token);world.callTool(auth,'join_world');Object.assign(world.agent(id).life.inventory,{wheat_bread:3,wood:10});world.agent(id).survival.satiety=30;
    return {id,auth,get a(){return world.agent(id);},observe(){return world.callTool(auth,'observe',{run_id:this.a.run.run_id,session_epoch:this.a.session_epoch});},
      request(payload,type='community'){const o=this.observe();return {run_id:o.run_id,session_epoch:o.session_epoch,action_id:o.next_action_id,type,payload};},
      send(req){return world.callTool(auth,'act',req);},act(payload,type){return this.send(this.request(payload,type));},
      ok(payload,type){const r=this.act(payload,type);assert.equal(r.status,'applied',JSON.stringify(r));return r;},
      at(id){this.a.position={...venue(id).interaction_position};this.a.scene_id='plaza';},event(){return this.observe().community.own_event;}};
  });
  return {world,players,now:()=>now,tick(ms,{heartbeat=true}={}){now+=ms;if(heartbeat)for(const p of players)if(p.a.status==='active')p.a.last_contact_at=now;world.tick();}};
}

test('v032 portable rules match actual food, reachable sparse seats and physical body collision',()=>{
  assert.deepEqual([...COMMUNITY_FOOD_IDS].sort(),LIFE_RULES.items.filter(i=>i.kind==='food').map(i=>i.id).sort());
  for(const v of COMMUNITY_RULES.venues){assert.ok(isWalkable('plaza',v.interaction_position));assert.ok(findWorldPath(null,'plaza',{x:11,y:8},v.interaction_position));for(const s of v.seats)assert.ok(isWalkable('plaza',s.position));for(const p of v.footprint)assert.equal(isWalkable('plaza',p),false);}
  const table=COMMUNITY_RULES.venues.find(v=>v.id==='table').position;
  assert.equal(findWorldPath(null,'plaza',{x:table.x-1,y:table.y},{x:table.x+1,y:table.y}).length,5,'path must go around the actual table');
});

test('public furniture bodies require an explicit terrain repair and cannot be entered from a legal station',()=>{
  for(const v of COMMUNITY_RULES.venues)for(const position of v.footprint){
    const a={scene_id:'plaza',position:{...position}};initializeScene(a,1000);assert.notDeepEqual(a.position,position);assert.ok(isWalkable('plaza',a.position));assert.equal(a.scene_migration.reason,'terrain_repair');assert.deepEqual(a.scene_migration.from_position,position);
    const route=findWorldPath(null,'plaza',a.position,v.interaction_position);assert.ok(route);assert.ok(route.slice(1).every(p=>isWalkable('plaza',p)));
    recordMovement(a,route,1000);assert.ok(publicMovement(a));assert.equal(findWorldPath(null,'plaza',v.interaction_position,position),null);
  }
  const fractional={scene_id:'plaza',position:{x:24,y:16.5}};initializeScene(fractional,1000);assert.deepEqual(fractional.position,{x:24,y:16.5});assert.ok(findWorldPath(null,'plaza',fractional.position,{x:24,y:17}));
});

test('v032 strict shared contract rejects invented fields, forged seats, missing food and hidden performance fields',()=>{
  for(const p of [post(),{intent:'browse',page:0},{intent:'use',seat_id:'table_west',activity:'eat',item_id:'wheat_bread'},{intent:'use',seat_id:'stage_speaker',activity:'perform',title:'落叶',text:'这是我选择分享的诗。'}])assert.equal(validate(p),true);
  for(const p of [{...post(),reward:100},{intent:'use',seat_id:'table_west',activity:'eat'},{intent:'use',seat_id:'table_west',activity:'perform',title:'x',text:'y'},{intent:'use',seat_id:'stage_speaker',activity:'perform',title:'x',text:'x'.repeat(401)},{intent:'use',seat_id:'picnic_west',activity:'sit',text:'隐藏文本'},{intent:'approach',venue_id:'unknown'},{intent:'join',event_id:'gathering_x',revision:2},{intent:'browse',page:10}])assert.equal(validate(p),false,JSON.stringify(p));
});

test('v032 announcement and membership are voluntary, do not travel, alter goals or automatically start',t=>{
  const f=fixture(t),[host,guest]=f.players;assert.equal(host.act(post()).error.code,'NOT_AT_BOARD');host.at('board');host.ok(post());const e=host.event();
  assert.equal(e.status,'open');const guestBefore=structuredClone({position:guest.a.position,goal:guest.a.goal,inventory:guest.a.life.inventory,plan:guest.a.adventure.plan});
  const req=guest.request({intent:'join',event_id:e.event_id,revision:1}),result=guest.send(req);assert.equal(result.status,'applied');assert.deepEqual(guest.send(req),result);
  assert.deepEqual({position:guest.a.position,goal:guest.a.goal,inventory:guest.a.life.inventory,plan:guest.a.adventure.plan},guestBefore);assert.equal(guest.a.community_job??null,null);
  assert.equal(host.act({intent:'start',event_id:e.event_id,revision:1}).error.code,'NOT_AT_VENUE');assert.equal(guest.act({intent:'start',event_id:e.event_id,revision:1}).error.code,'COMMUNITY_HOST');
  f.tick(20000);assert.equal(host.event().status,'open');host.at('picnic');host.ok({intent:'start',event_id:e.event_id,revision:1});assert.equal(host.event().status,'active');assert.equal(host.event().expires_at,e.expires_at);
  assert.equal(guest.a.community_job??null,null);assert.deepEqual(guest.a.position,guestBefore.position);
  guest.ok({intent:'leave',event_id:e.event_id});assert.equal(host.event().joined_count,1);host.ok({intent:'end',event_id:e.event_id});assert.equal(publicCommunity(f.world).events[0].status,'ended');
  const history=f.world.historyPage({limit:'20'});assert.ok(JSON.stringify(history).includes('community_event_changed'));
});

test('v032 busy guests can RSVP without replacing their chosen movement; host cannot duplicate venue announcements',t=>{
  const f=fixture(t),[host,guest]=f.players;host.at('board');host.ok(post());const e=host.event();
  guest.ok({intent:'approach',venue_id:'stage'});const job=structuredClone(guest.a.community_job),movement=structuredClone(guest.a.movement);
  guest.ok({intent:'join',event_id:e.event_id,revision:1});assert.deepEqual(guest.a.community_job,job);assert.deepEqual(guest.a.movement,movement);
  assert.equal(host.act(post('table')).error.code,'COMMUNITY_LIMIT');host.ok({intent:'cancel',event_id:e.event_id});assert.equal(guest.a.community_job.job_id,job.job_id,'cancelled party does not cancel independent self-chosen travel');
});

test('v032 one real seat reservation wins, approach cancellation spends no food and opens reservation',t=>{
  const f=fixture(t),[p,q]=f.players,payload={intent:'use',seat_id:'table_west',activity:'eat',item_id:'wheat_bread'};
  const before={...p.a.position};p.ok(payload);assert.deepEqual(p.a.position,before);assert.equal(p.a.life.inventory.wheat_bread,3);assert.equal(publicCommunity(f.world).venues.find(v=>v.id==='table').seats.find(s=>s.id==='table_west').occupied_by,p.id);
  assert.equal(q.act(payload).error.code,'COMMUNITY_OCCUPIED');p.ok({intent:'cancel_use'});assert.equal(p.a.life.inventory.wheat_bread,3);q.ok(payload);assert.equal(q.a.community_job.seat_id,'table_west');
});

test('v032 own meal is debited once on real arrival, never replenished or repeated by completion, interruption or receipt replay',t=>{
  const f=fixture(t,1),[p]=f.players;p.a.position={...seat('table_west').position};
  const request=p.request({intent:'use',seat_id:'table_west',activity:'eat',item_id:'wheat_bread',duration_seconds:15}),receipt=p.send(request);assert.equal(receipt.status,'applied');assert.equal(p.a.life.inventory.wheat_bread,2);assert.equal(p.a.community_job.phase,'using');
  assert.deepEqual(p.send(request),receipt);assert.equal(p.a.life.inventory.wheat_bread,2);f.tick(15000);assert.equal(p.a.community_job,null);assert.equal(p.a.life.inventory.wheat_bread,2);f.tick(15000);assert.equal(p.a.life.inventory.wheat_bread,2);
  assert.equal(p.a.life.ledger.entries.filter(e=>e.items?.wheat_bread===-1).length,1);
});

test('v032 arrival revalidates chosen food; explicit consumption en route does not duplicate a free table meal',t=>{
  const f=fixture(t,1),[p]=f.players;p.a.life.inventory.wheat_bread=1;p.ok({intent:'use',seat_id:'table_east',activity:'eat',item_id:'wheat_bread'});const arrival=p.a.movement.ends_at;
  p.ok({intent:'use',item_id:'wheat_bread'},'inventory');assert.equal(p.a.life.inventory.wheat_bread,0);f.tick(arrival-f.now());assert.equal(p.a.community_job,null);assert.equal(p.a.life.inventory.wheat_bread,0);
  assert.equal(f.world.state.events.filter(e=>e.type==='community_use_started').length,0);assert.equal(f.world.state.events.at(-1).payload.reason,'INSUFFICIENT_ITEMS');
});

test('v032 stage text remains private during approach, publishes only on actual stage and never generates applause or new thoughts',t=>{
  const f=fixture(t),[p,q]=f.players;const title='主人没有指定的题目',body='我想分享一片叶子的故事。';p.ok({intent:'use',seat_id:'stage_speaker',activity:'perform',title,text:body,duration_seconds:15});
  assert.equal(JSON.stringify(spectatorSnapshot(f.world)).includes(body),false);assert.equal(p.a.community_job.text,body);assert.equal(q.a.community_job??null,null);
  const arrival=p.a.movement.ends_at;f.tick(arrival-f.now());assert.equal(p.a.community_job.phase,'using');assert.equal(publicCommunityJob(p.a).text,body);assert.deepEqual(p.a.position,seat('stage_speaker').position);
  const snapshot=spectatorSnapshot(f.world);assert.ok(JSON.stringify(snapshot).includes(body));assert.equal(q.a.community_job??null,null);
  f.tick(15000);assert.equal(p.a.community_job,null);assert.equal(f.world.state.events.filter(e=>e.type==='community_use_finished').length,1);assert.equal(p.a.goal,'原主人目标0');assert.equal(q.a.goal,'原主人目标1');
});

test('v032 solo listening and sitting remain finite and valid without an invented performer or event',t=>{
  const f=fixture(t,1),[p]=f.players;p.a.position={...seat('stage_center').position};p.ok({intent:'use',seat_id:'stage_center',activity:'listen',duration_seconds:15});assert.equal(publicCommunity(f.world).events.length,0);f.tick(15000);assert.equal(p.a.community_job,null);assert.equal(f.world.state.agents[p.id].goal,'原主人目标0');
});

test('v032 expiry, declined participation and permission loss never renew events or recruit actors',t=>{
  const f=fixture(t),[p,q]=f.players;p.at('board');p.ok({...post(),duration_seconds:60});const e=p.event();f.tick(60000);assert.equal(publicCommunity(f.world).events[0].status,'expired');assert.equal(q.a.community_job??null,null);assert.equal(q.act({intent:'join',event_id:e.event_id,revision:1}).error.code,'COMMUNITY_UNAVAILABLE');
  p.at('board');p.ok(post());const next=p.event();q.ok({intent:'join',event_id:next.event_id,revision:1});f.world.ownerControl(q.id,'pause');assert.equal(p.event().joined_count,1);f.world.ownerControl(p.id,'pause');assert.equal(publicCommunity(f.world).events.find(e=>e.event_id===next.event_id).status,'interrupted');
});

test('v032 restart interrupts announcements and seat use without changing inventory, identity or terminal facts',t=>{
  const f=fixture(t,1),[p]=f.players;p.at('board');p.ok(post());const e=p.event();p.a.position={...seat('picnic_west').position};p.ok({intent:'use',seat_id:'picnic_west',activity:'eat',item_id:'wheat_bread'});
  const identity=structuredClone({id:p.id,goal:p.a.goal,inv:p.a.life.inventory,appearance:p.a.appearance});initializeCommunity(f.world,{restore:true});assert.equal(p.a.community_job,null);assert.equal(publicCommunity(f.world).events[0].status,'interrupted');assert.equal(publicCommunity(f.world).events[0].end_reason,'restarted');
  const count=f.world.state.events.length;initializeCommunity(f.world,{restore:true});assert.equal(f.world.state.events.length,count);assert.deepEqual({id:p.id,goal:p.a.goal,inv:p.a.life.inventory,appearance:p.a.appearance},identity);assert.equal(publicCommunity(f.world).events[0].event_id,e.event_id);
});

test('v032 public world and public events omit controller bindings, private inventory and unperformed drafts',t=>{
  const f=fixture(t,1),[p]=f.players;p.at('board');p.ok(post());const e=f.world.state.community.events[p.event().event_id];e.secret='PRIVATE_ADMIN';e.host_binding.token='PRIVATE_TOKEN';
  const snapshot=JSON.stringify(spectatorSnapshot(f.world));for(const key of ['PRIVATE_ADMIN','PRIVATE_TOKEN','host_binding','member_bindings','原主人目标0'])assert.equal(snapshot.includes(key),false,key);
  const projected=publicEvent({type:'community_event_changed',payload:{event:e,change:'posted',owner_goal:'PRIVATE_GOAL',token:'PRIVATE_TOKEN'}},new Set([p.id]));assert.equal(JSON.stringify(projected).includes('PRIVATE'),false);
  p.ok({intent:'use',seat_id:'stage_speaker',activity:'perform',title:'还没公开',text:'PRIVATE_DRAFT'});assert.equal(JSON.stringify(spectatorSnapshot(f.world)).includes('PRIVATE_DRAFT'),false);p.ok({intent:'cancel_use'});assert.equal(JSON.stringify(spectatorSnapshot(f.world)).includes('PRIVATE_DRAFT'),false);
});

test('v032 invalid saved event bindings are rejected without deleting the recoverable record',t=>{
  const f=fixture(t,1),[p]=f.players;p.at('board');p.ok(post());const e=f.world.state.community.events[p.event().event_id];e.member_bindings[p.id].session_epoch=-1;
  assert.throws(()=>initializeCommunity(f.world,{restore:true}),/Invalid community event/);assert.equal(f.world.state.community.events[e.event_id].status,'open');
});

test('v032 chosen listeners receive actual public work only at physical overlap onsets, even when the performer finishes first',t=>{
  const f=fixture(t,3),[performer,listener,observer]=f.players;
  listener.a.position={...seat('stage_left').position};listener.ok({intent:'use',seat_id:'stage_left',activity:'listen',duration_seconds:120});
  observer.a.position={...seat('stage_right').position};observer.ok({intent:'use',seat_id:'stage_right',activity:'sit',duration_seconds:120});
  assert.equal(f.world.state.events.filter(e=>e.type==='community_heard').length,0);
  performer.a.position={...seat('stage_speaker').position};performer.ok({intent:'use',seat_id:'stage_speaker',activity:'perform',title:'自选的作品',text:'风从树叶的背面吹过。',duration_seconds:15});
  const heard=f.world.state.events.filter(e=>e.type==='community_heard');assert.equal(heard.length,1);assert.deepEqual(heard[0].recipients,[listener.id]);assert.equal(heard[0].payload.agent_id,listener.id);assert.equal(heard[0].payload.performer_agent_id,performer.id);assert.equal(heard[0].payload.text,'风从树叶的背面吹过。');
  f.tick(16000);assert.equal(performer.a.community_job,null);assert.equal(listener.a.community_job.activity,'listen');assert.equal(f.world.state.events.filter(e=>e.type==='community_heard').length,1);
  assert.equal(publicEvent(heard[0],new Set(f.players.map(p=>p.id))),null,'targeted delivery is not a duplicate spectator feed or personal memory');
  listener.ok({intent:'cancel_use'});performer.ok({intent:'use',seat_id:'stage_speaker',activity:'perform',title:'另一段',text:'这一次是我自己想讲的。',duration_seconds:15});
  listener.ok({intent:'use',seat_id:'stage_left',activity:'listen',duration_seconds:30});assert.equal(f.world.state.events.filter(e=>e.type==='community_heard').length,2);
  f.tick(16000);assert.equal(f.world.state.events.filter(e=>e.type==='community_heard').length,2);assert.equal(observer.a.community_job.activity,'sit');
});

test('v032 a listener still walking when the stage performance ends does not receive an invented heard work',t=>{
  const f=fixture(t),[p,q]=f.players;p.a.position={...seat('stage_speaker').position};p.ok({intent:'use',seat_id:'stage_speaker',activity:'perform',title:'一小段',text:'只在这里公开的一段。',duration_seconds:15});
  q.a.position={x:0,y:0};q.ok({intent:'use',seat_id:'stage_left',activity:'listen',duration_seconds:15});const arrival=q.a.movement.ends_at;assert.ok(arrival-f.now()>15000);
  f.tick(arrival-f.now());assert.equal(p.a.community_job,null);assert.equal(q.a.community_job.activity,'listen');assert.equal(q.a.community_job.phase,'using');assert.equal(f.world.state.events.filter(e=>e.type==='community_heard').length,0);
});
