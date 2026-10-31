import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { SCENES, findPath, isWalkable, movementOptions, initializeScene, nearestWalkable } from '../server/spatial.js';
import { spectatorSnapshot } from '../server/spectator.js';
function fixture(t, persisted = false) {
  let now = 1000000;
  const dir = persisted ? mkdtempSync(join(tmpdir(), 'plaza-scenes-')) : null;
  let w = new World({ now: () => now, actionIntervalMs: 0, dbPath: dir ? join(dir, 'world.sqlite') : ':memory:' });
  const people = [];
  t.after(() => { w.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const make = () => { const a = w.createAgent({ name: `AI${people.length}` }), c = w.createController(a.agent_id); w.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 60 }); const p = { id: a.agent_id, c, auth: w.authenticate(c.token) }; const o = w.callTool(p.auth, 'join_world'); p.session = { run_id: o.run_id, session_epoch: o.session_epoch }; people.push(p); return p; };
  const raw = p => w.agent(p.id), observe = p => w.callTool(p.auth, 'observe', p.session);
  const act = (p, type, payload = {}) => w.callTool(p.auth, 'act', { ...p.session, action_id: observe(p).next_action_id, type, payload });
  const tick = () => { now += 1000; w.tick(); for (const p of people) if (raw(p).status === 'active') observe(p); };
  const until = (predicate, limit = 90) => { for (let i = 0; !predicate() && i < limit; i++) tick(); assert.ok(predicate(), 'bounded plan reached expected state'); };
  return { get w() { return w; }, make, raw, observe, act, tick, until, now: () => now,
    restart() { w.close(); now += 1000; w = new World({ now: () => now, dbPath: join(dir, 'world.sqlite'), actionIntervalMs: 0 }); } };
}
const ok = r => { assert.equal(r.status, 'applied', JSON.stringify(r.error)); return r; };

test('v017 real bidirectional gateway plan walks each path, retains deadline and invalidates stale scene decisions', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p), run = structuredClone(a.run);
  ok(f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'forest' }));
  const deadline = a.adventure.plan.expires_at;
  let previous = { ...a.position }, scene = a.scene_id;
  const stale = { ...p.session, action_id: a.next_action_id, type: 'say', payload: { channel: 'nearby', text: 'old scene answer' } };
  for (let i = 0; a.scene_id === 'plaza' && i < 40; i++) {
    f.tick(); assert.equal(a.adventure.plan.expires_at, deadline);
    if (scene === a.scene_id) { assert.ok(Math.abs(a.position.x-previous.x)+Math.abs(a.position.y-previous.y)<=2, 'physical speed bound includes initial preparation'); assert.ok(isWalkable(scene, a.position)); }
    else { assert.deepEqual(f.w.state.events.findLast(e=>e.type==='scene_changed').payload.from_position, { x:22,y:8 }); assert.deepEqual(a.position, { x: 11, y: 8 }); }
    previous = { ...a.position }; scene = a.scene_id;
  }
  assert.equal(a.scene_id, 'adventure'); assert.deepEqual(a.run, run);
  assert.throws(() => f.w.callTool(p.auth, 'act', stale), { code: 'STALE_ACTION' });
  assert.equal(f.w.callTool(p.auth, 'get_action_result', { action_id: stale.action_id }).status, 'not_found');
  f.until(() => a.adventure.encounter?.status === 'pending');
  ok(f.act(p, 'adventure_plan', { intent: 'retreat' }));
  const retreatDeadline = a.adventure.plan.expires_at;
  f.until(() => a.scene_id === 'plaza'); assert.deepEqual(a.position, { x: 22, y: 8 }); assert.equal(a.adventure.plan.expires_at, retreatDeadline);
  f.until(() => !a.adventure.plan); assert.deepEqual(a.position, { x: 11, y: 8 }); assert.deepEqual(a.run, run);
  assert.equal(f.w.state.events.filter(e => e.type === 'scene_changed').length, 2);
});

test('v017 normal move never uses portal; shortest walkable path and blocked terrain are authoritative', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); a.position = { x: 21, y: 8 };
  const r = ok(f.act(p, 'move', { x: 22, y: 8 })); assert.equal(a.scene_id, 'plaza'); assert.deepEqual(r.path, [{ x: 21, y: 8 }, { x: 22, y: 8 }]); f.tick(); assert.deepEqual(a.position,{x:22,y:8});
  a.position = { x: 1, y: 2 }; const oldEnergy = a.fatigue.energy;
  const blocked = f.act(p, 'move', { x: 2, y: 2 }); assert.equal(blocked.status, 'rejected'); assert.equal(f.raw(p).fatigue.energy, oldEnergy);
  f.raw(p).position = { x: 8, y: 5 };
  assert.equal(f.act(p, 'move', { x: 10, y: 5 }).status, 'rejected', 'two-tile straight line crosses well, four-step detour is over budget');
  const around = ok(f.act(p, 'move', { x: 9, y: 6 })); assert.equal(around.path.length, 3); assert.ok(around.path.every(point => isWalkable('plaza', point)));
  for (const scene of SCENES) for (let y=0;y<16;y++) for(let x=0;x<24;x++) if(isWalkable(scene.id,{x,y})) {
    for(const c of movementOptions({x,y},scene.id).candidates) { assert.ok(c.path.length <=4); assert.deepEqual(c.path,findPath(scene.id,{x,y},c,{maxSteps:3})); }
  }
});

test('v017 same coordinates across scenes do not grant nearby interactions, life service or monster damage; remote groups survive', t => {
  const f=fixture(t),p=f.make(),q=f.make(); f.raw(p).position={x:11,y:8};f.raw(q).position={x:11,y:8};
  const group=ok(f.act(p,'create_group')).group_id;const invite=ok(f.act(p,'invite',{group_id:group,target_agent_id:q.id}));ok(f.act(q,'respond_invite',{invite_id:invite.invite_id,accept:true}));
  f.raw(q).scene_id='adventure';assert.equal(f.observe(p).nearby_agents.length,0);
  ok(f.act(p,'say',{channel:'nearby',text:'only plaza'}));assert.deepEqual(f.w.state.events.at(-1).recipients,[p.id]);
  ok(f.act(q,'say',{channel:'group',group_id:group,text:'remote friend'}));assert.ok(f.w.state.events.at(-1).recipients.includes(p.id));
  assert.equal(f.act(p,'cooperation',{intent:'propose',template_id:'camp_meal',role_id:'supplier',target_agent_id:q.id}).error.code,'COOPERATION_TARGET');
  assert.equal(f.act(q,'farm',{intent:'till',plot_id:'plot_1'}).error.code,'SCENE_REQUIRED');
  assert.equal(f.act(q,'start_activity',{activity_id:'relax'}).error.code,'SCENE_REQUIRED');
  f.raw(p).position={x:20,y:7};f.raw(p).adventure.in_field=true;const hp=f.raw(p).adventure.hp;
  for(let i=0;i<10;i++)f.tick();assert.equal(f.raw(p).adventure.hp,hp);assert.equal(f.w.state.adventure.monsters[2].target_agent_id,null);
  f.raw(q).fatigue.energy=20;for(let i=0;i<5;i++)f.tick();assert.equal(f.raw(q).fatigue.energy,20,'adventure entry is safe, but not the plaza resting facilities');
});

test('v017 stop, pause, restart and stale movement do not relocate a role or re-enable combat',t=>{
 const f=fixture(t,true),p=f.make();ok(f.act(p,'adventure_plan',{intent:'explore',zone_id:'forest'}));f.until(()=>f.raw(p).scene_id==='adventure');f.tick();
 ok(f.act(p,'adventure_plan',{intent:'stop'}));const position={...f.raw(p).position},run=structuredClone(f.raw(p).run);
 f.w.ownerControl(p.id,'pause');assert.equal(f.raw(p).scene_id,'adventure');assert.deepEqual(f.raw(p).position,position);f.restart();
 assert.equal(f.raw(p).scene_id,'adventure');assert.deepEqual(f.raw(p).position,position);assert.equal(f.raw(p).adventure.in_field,false);assert.equal(f.raw(p).adventure.plan,null);assert.equal(f.raw(p).movement,null);assert.equal(f.raw(p).run.calls_used,run.calls_used);
});

test('v017 migration uses structured pre-cleanup evidence and nearest legal cell without invented movement; old history stays unknown',t=>{
 const f=fixture(t),p=f.make();const legacy=structuredClone(f.raw(p));delete legacy.scene_id;legacy.position={x:2,y:2};legacy.adventure.in_field=true;
 initializeScene(legacy,f.now());assert.equal(legacy.scene_id,'adventure');assert.deepEqual(legacy.scene_migration.from_position,{x:2,y:2});
 const plain=structuredClone(f.raw(p));delete plain.scene_id;plain.position={x:2,y:2};initializeScene(plain,f.now());assert.equal(plain.scene_id,'plaza');assert.deepEqual(plain.position,nearestWalkable('plaza',{x:2,y:2}));assert.equal(plain.scene_migration.reason,'legacy_default_plaza');
 const snapshot=spectatorSnapshot(f.w);assert.equal(snapshot.agents[0].scene_id,'plaza');assert.equal(snapshot.scenes.length,2);assert.doesNotMatch(JSON.stringify(snapshot),/scene_stale_actions|scene_migration/);
 f.w.event('message',{agent_id:p.id,text:'new',channel:'nearby'},[p.id]);assert.equal(f.w.historyPage({}).items[0].details.scene_id,'plaza');
});

test('v017 portal arrival never extends plan, lease or grant; deadline and pause win before a crossing', t => {
 for (const boundary of ['deadline','pause','lease','grant']) {
  const f=fixture(t),p=f.make(),a=f.raw(p);a.position={x:22,y:8};ok(f.act(p,'adventure_plan',{intent:'explore',zone_id:'forest'}));
  if(boundary==='deadline')a.adventure.plan.expires_at=f.now()+1000;
  if(boundary==='pause')f.w.ownerControl(p.id,'pause');
  if(boundary==='lease')a.last_contact_at=f.now()-44000;
  if(boundary==='grant')a.run.expires_at=f.now()+1000;
  f.tick();assert.equal(a.scene_id,'plaza');assert.deepEqual(a.position,{x:22,y:8});assert.equal(a.adventure.plan,null);
 }
 const f=fixture(t),p=f.make(),a=f.raw(p);a.position={x:22,y:8};const req={...p.session,action_id:f.observe(p).next_action_id,type:'adventure_plan',payload:{intent:'explore',zone_id:'forest'}};
 const receipt=f.w.callTool(p.auth,'act',req);a.adventure.plan.expires_at=f.now()+2000;f.tick();assert.equal(a.scene_id,'adventure');assert.equal(a.adventure.plan.expires_at,f.now()+1000);
 assert.deepEqual(f.w.callTool(p.auth,'act',req),receipt,'already-applied original action is still idempotent after crossing');
 f.tick();assert.equal(a.adventure.plan,null);assert.deepEqual(a.position,{x:11,y:8});
});

test('v017 patrols obey shared solid footprints and public paths reject corrupt nested data', t => {
 const f=fixture(t),p=f.make();
 for(let i=0;i<120;i++){f.tick();for(const monster of f.w.state.adventure.monsters)assert.ok(isWalkable('adventure',monster.position));}
 const a=f.raw(p);a.movement={version:2,movement_id:'public-test',mode:'walk',speed:2,scene_id:'plaza',path:[{x:11,y:8},{x:12,y:8}],started_at:f.now(),ends_at:f.now()+500,duration_ms:500};a.position={x:11,y:8};
 assert.equal(spectatorSnapshot(f.w).agents[0].movement.path.length,2);
 for(const path of [[],[{x:11,y:8},{x:15,y:8}],[{x:11,y:8},{x:{PRIVATE_NESTED:true},y:8}]]) {a.movement.path=path;assert.equal(spectatorSnapshot(f.w).agents[0].movement,null);}
 assert.doesNotMatch(JSON.stringify(spectatorSnapshot(f.w)),/PRIVATE_NESTED/);
});
