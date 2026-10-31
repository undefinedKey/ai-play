import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { LIFE_RULES, initializeLife } from '../server/life.js';
import { RESOURCE_NODES, publicResources } from '../server/resources.js';
import { publicDayCycle } from '../server/day-cycle.js';
import { findPath, isWalkable } from '../server/spatial.js';
import { spectatorSnapshot } from '../server/spectator.js';

function fixture(t, persistent = false) {
  let now = 2000000000000;
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'v020-resource-')) : null;
  const dbPath = directory ? join(directory, 'world.sqlite') : ':memory:';
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  const actors = [];
  t.after(() => { world.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const raw = p => world.agent(p.id);
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const make = () => {
    const a = world.createAgent({ name: `采集者${actors.length}` }), c = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, max_calls: 10000 });
    const auth = world.authenticate(c.token), seen = world.callTool(auth, 'join_world');
    const p = { id: a.agent_id, auth, session: { run_id: seen.run_id, session_epoch: seen.session_epoch } }; actors.push(p);
    raw(p).position = { x: 11, y: 8 }; raw(p).position_at = now;
    return p;
  };
  const request = (p, type, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const advance = (ms, { touch = true } = {}) => { const end = now + ms; while (now < end) { now = Math.min(end, now + 100); world.tick(); if (touch && now % 1000 === 0) for (const p of actors) if (raw(p).status === 'active') observe(p); } };
  const until = (condition, limit = 120000) => { for (let i = 0; i < limit && !condition(); i += 100) advance(100); assert.ok(condition(), 'condition must be reached using real 100ms world steps'); };
  const tools = p => { Object.assign(raw(p).life.inventory, { axe: 1, pickaxe: 1 }); initializeLife(raw(p)); for (const id of ['axe', 'pickaxe']) raw(p).life.tools[id].durability = 12; };
  return { get world() { return world; }, raw, make, observe, request, act, advance, until, tools, now: () => now,
    jump(ms) { now += ms; world.tick(); }, restart(ms = 0) { world.close(); now += ms; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); } };
}
const applied = r => { assert.equal(r.status, 'applied', JSON.stringify(r.error)); return r; };
const gather = (f, p, node_id, mode) => applied(f.act(p, 'gather', { intent: 'start', node_id, ...(mode ? { mode } : {}) }));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('v020 shared authored nodes are reachable and public data excludes private reservations', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p);
  assert.equal(RESOURCE_NODES.length, 9);
  for (const def of RESOURCE_NODES) { assert.ok(isWalkable(def.scene_id, def.interaction_position), def.id); assert.ok(findPath(def.scene_id, { x: 11, y: 8 }, def.interaction_position), def.id); }
  assert.equal(a.life.tools.hoe.durability, 20); assert.equal(a.life.tools.axe.owned, false); assert.equal(a.life.tools.axe.durability, 0);
  gather(f, p, 'camp_branches');
  Object.assign(f.world.state.resources.nodes.camp_branches.reservation, { run_id: 'PRIVATE_RUN', token: 'PRIVATE_TOKEN' });
  f.world.state.resources.nodes.camp_branches.owner_goal = 'PRIVATE_GOAL';
  assert.doesNotMatch(JSON.stringify(publicResources(f.world.state, f.now())), /PRIVATE_/);
  assert.equal(f.observe(p).resources.nodes.find(n => n.id === 'camp_branches').available, false);
  assert.equal(spectatorSnapshot(f.world).resources.nodes.length, 9);
  assert.equal(f.world.getRules().life.gathering.version, 2);
});

test('v020 real bootstrap → crafted axe → travel/work → berries → ration supplies the same AI', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p);
  applied(f.act(p, 'gather', { intent: 'start', resource_id: 'ore' })); f.advance(18000);
  assert.equal(a.life.inventory.ore, 1);
  applied(f.act(p, 'inventory', { intent: 'craft', item_id: 'axe' })); assert.equal(a.life.tools.axe.durability, 12);
  const energy = a.fatigue.energy, start = { ...a.position }, stock = f.world.state.resources.nodes.east_pine.stock;
  gather(f, p, 'east_pine'); assert.equal(a.life.gathering.phase, 'approaching'); assert.deepEqual(a.position, start); assert.equal(a.fatigue.energy, energy);
  f.advance(100); assert.notDeepEqual(a.position, start); assert.equal(a.life.tools.axe.durability, 12); assert.ok(a.fatigue.energy < energy);
  f.until(() => a.life.gathering?.phase === 'working');
  assert.equal(a.life.tools.axe.durability, 11); assert.equal(f.world.state.resources.nodes.east_pine.stock, stock);
  const wood = a.life.inventory.wood, work = a.life.gathering; f.advance(work.ends_at - f.now() - 100); assert.equal(a.life.inventory.wood, wood);
  f.advance(100); assert.equal(a.life.gathering, null); assert.equal(a.life.inventory.wood, wood + 3); assert.equal(f.world.state.resources.nodes.east_pine.stock, stock - 1);
  assert.equal(a.life.ledger.entries.filter(e => e.source_id === work.job_id).length, 1);
  gather(f, p, 'orchard_berries'); f.until(() => !a.life.gathering); assert.equal(a.life.inventory.berry, 2);
  applied(f.act(p, 'adventure_plan', { intent: 'retreat' })); f.until(() => !a.adventure.plan); assert.deepEqual(a.position, { x: 11, y: 8 });
  applied(f.act(p, 'inventory', { intent: 'craft', item_id: 'trail_ration' })); assert.equal(a.life.inventory.berry, 0);
  a.adventure.hp = 20; a.fatigue.energy = 30;
  applied(f.act(p, 'inventory', { intent: 'use', item_id: 'trail_ration' })); assert.equal(a.adventure.hp, 32); assert.equal(a.fatigue.energy, 48); assert.equal(a.life.inventory.trail_ration, 0);
  assert.equal(a.adventure.plan, null); assert.equal(a.movement, null);
});

test('v020 competing clients share one reservation and one stock, old commands cannot bypass depletion', t => {
  const f = fixture(t), p = f.make(), q = f.make();
  const request = f.request(p, 'gather', { intent: 'start', node_id: 'camp_branches' });
  applied(f.world.callTool(p.auth, 'act', request));
  assert.equal(f.act(q, 'gather', { intent: 'start', resource_id: 'wood' }).error.code, 'RESOURCE_BUSY');
  const charged = f.raw(p).fatigue.energy;
  applied(f.world.callTool(p.auth, 'act', request)); assert.equal(f.raw(p).fatigue.energy, charged);
  f.advance(12000); assert.equal(f.raw(p).life.inventory.wood, 4);
  applied(f.world.callTool(p.auth, 'act', request)); assert.equal(f.raw(p).life.inventory.wood, 4);
  for (let i = 0; i < 2; i++) { gather(f, p, 'camp_branches'); f.advance(12000); }
  assert.equal(f.world.state.resources.nodes.camp_branches.stock, 0);
  assert.equal(f.act(q, 'gather', { intent: 'start', resource_id: 'wood' }).error.code, 'RESOURCE_DEPLETED');
  const next = f.world.state.resources.nodes.camp_branches.regrow_at; f.advance(next - f.now());
  assert.equal(f.world.state.resources.nodes.camp_branches.stock, 1);
  gather(f, q, 'camp_branches'); applied(f.act(q, 'gather', { intent: 'cancel' }));
  assert.equal(f.world.state.resources.nodes.camp_branches.stock, 1); assert.equal(f.world.state.resources.nodes.camp_branches.reservation, null);
});

test('v020 cancel, pause, run expiry and host lease stop approach without remote reward or replacement goal', t => {
  for (const operation of ['cancel', 'pause', 'expiry', 'lease']) {
    const f = fixture(t), p = f.make(); f.tools(p); const a = f.raw(p), wood = a.life.inventory.wood;
    gather(f, p, 'east_pine', 'run'); f.advance(100);
    if (operation === 'cancel') applied(f.act(p, 'gather', { intent: 'cancel' }));
    else if (operation === 'pause') f.world.ownerControl(p.id, 'pause');
    else if (operation === 'expiry') { a.run.expires_at = f.now() + 250; f.jump(1000); }
    else { a.last_contact_at = f.now() - 44750; f.jump(1000); }
    const position = { ...a.position }; f.advance(2000, { touch: false });
    assert.deepEqual(a.position, position); assert.equal(a.movement, null); assert.equal(a.life.gathering, null); assert.equal(a.life.inventory.wood, wood);
    assert.equal(f.world.state.resources.nodes.east_pine.reservation, null); assert.equal(a.life.tools.axe.durability, 12); assert.equal(a.adventure.plan, null);
  }
});

test('v020 tooling is owned, durable and repairable; invalid actions and duplicate crafts do not create tools', t => {
  const f = fixture(t), p = f.make(); let a = f.raw(p);
  assert.equal(f.act(p, 'gather', { intent: 'start', node_id: 'east_pine' }).error.code, 'TOOL_REQUIRED');
  assert.equal(f.act(p, 'inventory', { intent: 'repair', item_id: 'axe' }).error.code, 'TOOL_REQUIRED');
  a = f.raw(p);
  Object.assign(a.life.inventory, { wood: 20, ore: 20 });
  applied(f.act(p, 'inventory', { intent: 'craft', item_id: 'axe' })); const wood = a.life.inventory.wood;
  assert.equal(f.act(p, 'inventory', { intent: 'craft', item_id: 'axe' }).error.code, 'ALREADY_CRAFTED'); a = f.raw(p); assert.equal(a.life.inventory.wood, wood);
  a.life.tools.axe.durability = 0; applied(f.act(p, 'inventory', { intent: 'repair', item_id: 'axe' })); assert.equal(a.life.tools.axe.durability, 12);
  applied(f.act(p, 'inventory', { intent: 'upgrade', item_id: 'axe' })); assert.equal(a.life.tools.axe.level, 2); assert.equal(a.life.tools.axe.durability, 24);
  assert.equal(f.act(p, 'gather', { intent: 'start', node_id: 'east_pine', resource_id: 'wood' }).status, 'rejected');
  assert.equal(f.act(p, 'gather', { intent: 'start', node_id: 'ridge_ore' }).error.code, 'SCENE_REQUIRED');
});

test('v020 a real monster hit interrupts working and does not grant remote loot', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); f.tools(p);
  a.scene_id = 'adventure'; a.position = { x: 28, y: 12 };
  const monster = f.world.state.adventure.monsters[0]; Object.assign(monster, { position: { x: 29, y: 12 }, home_position: { x: 29, y: 12 }, movement: null, next_patrol_at: f.now() + 10000 });
  const wood = a.life.inventory.wood; gather(f, p, 'wild_pine'); assert.equal(a.life.gathering.phase, 'working');
  f.until(() => !a.life.gathering, 2000);
  assert.ok(a.adventure.hp < a.adventure.max_hp); assert.equal(a.life.inventory.wood, wood); assert.equal(f.world.state.resources.nodes.wild_pine.stock, 3);
  assert.equal(f.world.state.resources.nodes.wild_pine.reservation, null); assert.equal(a.life.tools.axe.durability, 11);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_cancelled').at(-1).payload.reason, 'hurt');
});

test('v020 night availability and work costs are real, fixed at work start and never impose offline damage', t => {
  const f = fixture(t), p = f.make(); let a = f.raw(p); a.scene_id = 'adventure'; a.position = { x: 40, y: 24 };
  assert.equal(f.act(p, 'gather', { intent: 'start', node_id: 'moon_herb' }).error.code, 'RESOURCE_PHASE');
  a = f.raw(p);
  f.world.state.day_cycle.epoch_at = f.now() - 539000; f.world.state.day_cycle.last_at = f.now();
  gather(f, p, 'moon_herb'); const job = a.life.gathering;
  close(job.energy_cost, 4.8); assert.equal(job.duration_seconds, 12.5); assert.equal(job.day_phase, 'night');
  f.advance(2000); assert.equal(publicDayCycle(f.world.state, f.now()).phase, 'dawn'); assert.equal(a.life.gathering.energy_cost, 4.8);
  f.advance(10500); assert.equal(a.life.inventory.moon_herb, 1); assert.equal(a.life.gathering, null);
  const hp = a.adventure.hp, energy = a.fatigue.energy; f.world.ownerControl(p.id, 'pause'); f.jump(600000);
  assert.equal(a.adventure.hp, hp); assert.equal(a.fatigue.energy, energy);
});

test('v020 persisted stocks, monotonic day clock and original identities survive restart without resuming work', t => {
  const f = fixture(t, true), p = f.make(), a = f.raw(p);
  gather(f, p, 'camp_branches'); f.advance(12000); f.tools(p); gather(f, p, 'east_pine'); f.advance(200);
  const before = { position: { ...a.position }, wood: a.life.inventory.wood, epoch: f.world.state.day_cycle.epoch_at, stock: f.world.state.resources.nodes.camp_branches.stock };
  f.restart(-1000); const restored = f.world.agent(p.id);
  assert.deepEqual(restored.position, before.position); assert.equal(restored.life.inventory.wood, before.wood); assert.equal(restored.life.gathering, null); assert.equal(restored.movement, null);
  assert.equal(f.world.state.resources.nodes.camp_branches.stock, before.stock); assert.equal(f.world.state.resources.nodes.east_pine.reservation, null);
  assert.equal(f.world.state.day_cycle.epoch_at, before.epoch); assert.ok(publicDayCycle(f.world.state, f.now()).server_time >= f.now() + 1000);
  assert.equal(Object.keys(f.world.state.agents).length, 1);
});

test('v020 manual redirection cancels only the old resource path; active work cannot pay from a distant position', t => {
  const f = fixture(t), p = f.make(); f.tools(p); let a = f.raw(p);
  gather(f, p, 'east_pine'); f.advance(100);
  const stopped = { ...a.position }, target = f.observe(p).movement.candidates[0];
  applied(f.act(p, 'move', { x: target.x, y: target.y })); assert.equal(a.life.gathering, null);
  assert.equal(f.world.state.resources.nodes.east_pine.reservation, null); assert.ok(a.movement); f.advance(2000); assert.notDeepEqual(a.position, stopped);
  a.position = { x: 11, y: 8 }; a.movement = null; gather(f, p, 'camp_branches');
  const wood = a.life.inventory.wood; a.position = { x: 20, y: 20 }; f.advance(12000);
  assert.equal(a.life.inventory.wood, wood); assert.equal(a.life.gathering, null); assert.equal(f.world.state.resources.nodes.camp_branches.stock, 3);
});

test('v020 job TTL is independent from owner grant, frees the node and never extends authorization', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); f.tools(p);
  const grant = a.run.expires_at; gather(f, p, 'east_pine'); f.advance(100);
  a.life.gathering.expires_at = f.now() + 250; f.world.state.resources.nodes.east_pine.reservation.expires_at = a.life.gathering.expires_at;
  f.jump(1000); assert.equal(a.life.gathering, null); assert.equal(a.movement, null); close(a.position.x, 11.7);
  assert.equal(a.run.expires_at, grant); assert.equal(a.status, 'active'); assert.equal(a.adventure.plan, null);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_cancelled').at(-1).payload.reason, 'expired');
});

test('v020 mining uses the owned upgraded pickaxe once and mixed food can heal at full energy', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); f.tools(p);
  a.life.tools.pickaxe = { owned: true, level: 2, durability: 1, max_durability: 24 };
  a.scene_id = 'adventure'; a.position = { x: 36, y: 9 }; const energy = a.fatigue.energy;
  gather(f, p, 'ridge_ore'); assert.equal(a.life.tools.pickaxe.durability, 0); assert.equal(a.life.gathering.duration_seconds, 17); close(a.fatigue.energy, energy - 6);
  f.advance(17000); assert.equal(a.life.inventory.ore, 3); assert.equal(a.life.gathering, null);
  assert.equal(f.act(p, 'gather', { intent: 'start', node_id: 'ridge_ore' }).error.code, 'TOOL_REQUIRED');
  const current = f.raw(p); current.life.inventory.trail_ration = 1; current.adventure.hp = 20; current.fatigue.energy = 100;
  applied(f.act(p, 'inventory', { intent: 'use', item_id: 'trail_ration' })); assert.equal(current.adventure.hp, 32); assert.equal(current.fatigue.energy, 100);
});

test('v020 leaving adventure camp for a resource enables actual wilderness exposure; defeat releases work', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); a.scene_id = 'adventure'; a.adventure.in_field = false;
  gather(f, p, 'deep_berries');
  f.until(() => Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) > 2, 5000);
  assert.equal(a.adventure.in_field, true); assert.equal(a.adventure.plan, null);
  applied(f.act(p, 'gather', { intent: 'cancel' }));
  f.tools(p); a.position = { x: 28, y: 12 }; a.adventure.hp = 1;
  const monster = f.world.state.adventure.monsters[0]; Object.assign(monster, { position: { x: 29, y: 12 }, home_position: { x: 29, y: 12 }, movement: null, next_patrol_at: f.now() + 10000 });
  const wood = a.life.inventory.wood; gather(f, p, 'wild_pine'); f.until(() => a.scene_id === 'plaza', 3000);
  assert.equal(a.adventure.hp, 10); assert.equal(a.life.gathering, null); assert.equal(a.movement, null); assert.equal(a.life.inventory.wood, wood);
  assert.equal(f.world.state.resources.nodes.wild_pine.reservation, null); assert.equal(a.adventure.plan, null);
});

test('v020 a disappeared target cancels a real trip rather than recreating stock or granting materials', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); f.tools(p);
  gather(f, p, 'east_pine'); f.advance(100); const wood = a.life.inventory.wood;
  delete f.world.state.resources.nodes.east_pine; f.advance(100);
  assert.equal(a.life.gathering, null); assert.equal(a.movement, null); assert.equal(a.life.inventory.wood, wood);
  const node = publicResources(f.world.state, f.now()).nodes.find(n => n.id === 'east_pine'); assert.equal(node.available, false); assert.equal(node.stock, 0);
});
