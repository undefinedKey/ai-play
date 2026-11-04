import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { initializeLife } from '../server/life.js';
import { RESOURCE_NODES, TREE_RULES, initializeResources, publicResources, tickResources } from '../server/resources.js';
import { initializeDayCycle } from '../server/day-cycle.js';
import { findPath, isWalkable, sceneDefinition } from '../server/spatial.js';

function fixture(t, persistent = false) {
  let now = 2000000000000;
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'v021-forest-')) : null;
  const dbPath = dir ? join(dir, 'world.sqlite') : ':memory:';
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); const actors = [];
  t.after(() => { world.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const raw = p => world.agent(p.id), observe = p => world.callTool(p.auth, 'observe', p.session);
  const make = (position = { x: 11, y: 8 }, inventory = {}) => {
    const a = world.createAgent({ name: `林地旅人${actors.length}` }), c = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, max_calls: 10000 });
    const auth = world.authenticate(c.token), joined = world.callTool(auth, 'join_world');
    const p = { id: a.agent_id, auth, session: { run_id: joined.run_id, session_epoch: joined.session_epoch } }; actors.push(p);
    // Explicit unit-test initial state. All subsequent work uses real actions.
    Object.assign(raw(p), { position: { ...position }, position_at: now }); Object.assign(raw(p).life.inventory, inventory); initializeLife(raw(p));
    if (inventory.axe) raw(p).life.tools.axe.durability = 12;
    return p;
  };
  const request = (p, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type: 'gather', payload });
  const act = (p, payload) => world.callTool(p.auth, 'act', request(p, payload));
  const advance = (ms, touch = true) => { const until = now + ms; while (now < until) { now = Math.min(until, now + 100); world.tick(); if (touch && now % 1000 === 0) for (const p of actors) if (raw(p).status === 'active') observe(p); } };
  const until = (condition, limit = 120000) => { for (let i = 0; !condition() && i < limit; i += 100) advance(100); assert.ok(condition()); };
  return { get world() { return world; }, raw, make, observe, request, act, advance, until, now: () => now,
    jump(ms) { now += ms; world.tick(); }, restart(ms = 0) { world.close(); now += ms; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); } };
}
const ok = result => { assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };
const harvest = (f, p, node_id) => { ok(f.act(p, { intent: 'start', node_id })); f.until(() => !f.raw(p).life.gathering); };
const node = (f, id) => f.world.state.resources.nodes[id];

test('v021 forest sites and grass are bounded, reachable, unique, and keep all three original tree locations', t => {
  const f = fixture(t), trees = RESOURCE_NODES.filter(n => n.kind === 'tree');
  assert.equal(RESOURCE_NODES.filter(n => n.scene_id !== 'journey').length, 32); assert.equal(trees.filter(n => n.scene_id !== 'journey').length, 23);
  assert.equal(trees.filter(n => n.scene_id === 'journey').length, 1);
  assert.equal(trees.filter(n => n.initial_stage === 'empty').length, 2);
  assert.equal(RESOURCE_NODES.filter(n => n.kind === 'grass').length, 2);
  assert.equal(new Set(RESOURCE_NODES.map(n => n.id)).size, RESOURCE_NODES.length);
  assert.equal(new Set(RESOURCE_NODES.map(n => `${n.scene_id}:${n.position.x},${n.position.y}`)).size, RESOURCE_NODES.length);
  for (const def of RESOURCE_NODES) { assert.ok(isWalkable(def.scene_id, def.interaction_position), def.id); assert.ok(findPath(def.scene_id, sceneDefinition(def.scene_id).portal.position, def.interaction_position), def.id); }
  for (const [id, scene_id, position] of [['east_pine', 'plaza', { x: 29, y: 7 }], ['south_pine', 'plaza', { x: 30, y: 21 }], ['wild_pine', 'adventure', { x: 29, y: 12 }]]) {
    const def = RESOURCE_NODES.find(n => n.id === id); assert.equal(def.scene_id, scene_id); assert.deepEqual(def.position, position);
  }
  assert.equal(f.world.getRules().resources.version, 2); assert.equal(f.world.getRules().resources.trees.planting.seed_item_id, 'pine_cone');
});

test('v021 migration retains partially harvested trees and non-tree stock clocks without refilling assets', () => {
  const state = { resources: { version: 1, last_at: 1100000, nodes: {
    east_pine: { stock: 2, regrow_at: 1150000, reservation: null }, south_pine: { stock: 0, regrow_at: 1160000, reservation: null },
    camp_branches: { stock: 1, regrow_at: 1120000, reservation: null },
  } } };
  initializeResources(state, 1000000, { restore: true });
  assert.equal(state.resources.last_at, 1100000); assert.equal(state.resources.nodes.east_pine.stock, 2);
  assert.equal(state.resources.nodes.east_pine.ecology.stage, 'mature'); assert.equal(state.resources.nodes.east_pine.regrow_at, null);
  assert.equal(state.resources.nodes.south_pine.stock, 0); assert.equal(state.resources.nodes.south_pine.ecology.stage, 'stump');
  assert.equal(state.resources.nodes.south_pine.ecology.next_at, 1160000);
  assert.deepEqual(state.resources.nodes.camp_branches, { stock: 1, regrow_at: 1120000, reservation: null });
  const before = structuredClone(state.resources); initializeResources(state, 1000000, { restore: true }); assert.deepEqual(state.resources, before);
});

test('v021 finite chops yield wood once, only the final chop drops a cone and a mature tree never replenishes missing segments', t => {
  const f = fixture(t), p = f.make({ x: 28, y: 7 }, { axe: 1 }), initial = f.raw(p).life.inventory.wood;
  harvest(f, p, 'east_pine'); assert.equal(node(f, 'east_pine').stock, 2); assert.equal(f.raw(p).life.inventory.pine_cone || 0, 0);
  f.advance(120000); assert.equal(node(f, 'east_pine').stock, 2); assert.equal(node(f, 'east_pine').regrow_at, null);
  harvest(f, p, 'east_pine'); assert.equal(node(f, 'east_pine').stock, 1); assert.equal(f.raw(p).life.inventory.pine_cone || 0, 0);
  const req = f.request(p, { intent: 'start', node_id: 'east_pine' }), receipt = ok(f.world.callTool(p.auth, 'act', req));
  const job = f.raw(p).life.gathering; f.until(() => !f.raw(p).life.gathering);
  assert.equal(f.raw(p).life.inventory.wood, initial + 9); assert.equal(f.raw(p).life.inventory.pine_cone, 1);
  assert.equal(f.raw(p).life.tools.axe.durability, 9); assert.equal(node(f, 'east_pine').stock, 0); assert.equal(node(f, 'east_pine').ecology.stage, 'stump');
  assert.equal(f.raw(p).life.ledger.entries.filter(e => e.source_id === job.job_id).length, 1);
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), receipt); assert.equal(f.raw(p).life.inventory.pine_cone, 1);
  assert.equal(f.act(p, { intent: 'start', node_id: 'east_pine' }).error.code, 'RESOURCE_DEPLETED');
  assert.equal(f.raw(p).life.tools.axe.durability, 9); assert.equal(f.raw(p).adventure.plan, null);
});

test('v021 natural tree lifecycle crosses exact persisted boundaries, manual clearings never self-plant, and offline growth gives no inventory', () => {
  let now = 1000000; const state = {}, events = [];
  initializeDayCycle(state, now); initializeResources(state, now);
  const def = RESOURCE_NODES.find(n => n.id === 'east_pine'), tree = state.resources.nodes.east_pine;
  tree.stock = 0; tree.ecology = { stage: 'stump', stage_started_at: now, next_at: now + 60000, generation: 0, origin: 'wild' }; tree.regrow_at = now + 960000;
  const world = { state, now: () => now, activeIds: () => [], event: (...args) => events.push(args) };
  for (const [elapsed, stage, stock] of [[59999, 'stump', 0], [60000, 'empty', 0], [359999, 'empty', 0], [360000, 'sapling', 0], [540000, 'young', 0], [959999, 'young', 0], [960000, 'mature', def.max_stock]]) {
    now = 1000000 + elapsed; tickResources(world); assert.equal(tree.ecology.stage, stage); assert.equal(tree.stock, stock);
  }
  assert.equal(tree.ecology.generation, 1); assert.equal(tree.regrow_at, null);
  now += 999999999; tickResources(world); assert.equal(state.resources.nodes.planting_plaza.ecology.stage, 'empty'); assert.equal(state.resources.nodes.planting_plaza.stock, 0);
  assert.equal(tree.ecology.generation, 1); assert.ok(events.every(([type]) => type === 'resource_stage_changed')); assert.equal(state.agents, undefined);
});

test('v021 planting approaches physically, reserves the empty site and consumes one seed only after four seconds of actual work', t => {
  const f = fixture(t), p = f.make({ x: 11, y: 8 }, { pine_cone: 1 }), q = f.make({ x: 11, y: 8 }, { pine_cone: 1 });
  const grant = structuredClone(f.raw(p).run), request = f.request(p, { intent: 'plant', node_id: 'planting_plaza', mode: 'walk' });
  const receipt = ok(f.world.callTool(p.auth, 'act', request)); assert.equal(receipt.life.gathering.intent, 'plant'); assert.equal(receipt.life.gathering.tool_id, null);
  assert.equal(f.raw(p).life.gathering.phase, 'approaching'); assert.equal(f.raw(p).life.inventory.pine_cone, 1); assert.deepEqual(f.raw(p).position, { x: 11, y: 8 });
  f.advance(100); assert.notDeepEqual(f.raw(p).position, { x: 11, y: 8 });
  assert.equal(f.act(q, { intent: 'plant', node_id: 'planting_plaza' }).error.code, 'RESOURCE_BUSY');
  f.until(() => f.raw(p).life.gathering?.phase === 'working'); const job = structuredClone(f.raw(p).life.gathering);
  assert.equal(job.ends_at - job.work_started_at, 4000); assert.equal(job.energy_cost, 2); assert.equal(node(f, 'planting_plaza').ecology.stage, 'empty');
  f.advance(3900); assert.equal(f.raw(p).life.inventory.pine_cone, 1); f.advance(100);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).life.inventory.pine_cone, 0); assert.equal(f.raw(q).life.inventory.pine_cone, 1);
  assert.equal(node(f, 'planting_plaza').ecology.stage, 'sapling'); assert.equal(node(f, 'planting_plaza').ecology.origin, 'planted');
  assert.equal(node(f, 'planting_plaza').reservation, null); assert.equal(node(f, 'planting_plaza').stock, 0);
  assert.equal(f.raw(p).life.ledger.entries.filter(e => e.source_id === job.job_id).length, 1);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt); assert.equal(node(f, 'planting_plaza').ecology.generation, 1);
  assert.deepEqual(f.raw(p).run, grant);
  f.world.ownerControl(p.id, 'pause'); f.world.ownerControl(q.id, 'pause'); f.jump(600000);
  assert.equal(node(f, 'planting_plaza').ecology.stage, 'mature'); assert.equal(f.raw(p).life.inventory.pine_cone, 0);
});

test('v021 cancelling or losing authorization during planting frees reservation without planting or spending a seed', t => {
  for (const operation of ['cancel', 'pause', 'lease', 'expiry']) {
    const f = fixture(t), p = f.make({ x: 11, y: 8 }, { pine_cone: 1 }); ok(f.act(p, { intent: 'plant', node_id: 'planting_plaza' })); f.advance(100);
    if (operation === 'cancel') ok(f.act(p, { intent: 'cancel' }));
    else if (operation === 'pause') f.world.ownerControl(p.id, 'pause');
    else if (operation === 'lease') { f.raw(p).last_contact_at = f.now() - 44750; f.advance(1000, false); }
    else { f.raw(p).run.expires_at = f.now() + 100; f.advance(100); }
    assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).movement, null); assert.equal(f.raw(p).life.inventory.pine_cone, 1);
    assert.equal(node(f, 'planting_plaza').reservation, null); assert.equal(node(f, 'planting_plaza').ecology.stage, 'empty');
    assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_finished').length, 0);
  }
});

test('v021 malformed planting, missing seeds, immature trees and cone-overflow cannot spend tools or create products', t => {
  const f = fixture(t), p = f.make({ x: 28, y: 7 }, { axe: 1 });
  for (const payload of [{ intent: 'plant', resource_id: 'wood' }, { intent: 'plant', node_id: 'planting_plaza', resource_id: 'wood' }, { intent: 'plant', node_id: 'planting_plaza', x: 18 }, { intent: 'cancel', node_id: 'planting_plaza' }]) assert.equal(f.act(p, payload).error.code, 'INVALID_ACTION');
  assert.equal(f.act(p, { intent: 'plant', node_id: 'planting_plaza' }).error.code, 'INSUFFICIENT_ITEMS');
  f.raw(p).life.inventory.pine_cone = Number.MAX_SAFE_INTEGER; node(f, 'east_pine').stock = 1;
  const inventory = structuredClone(f.raw(p).life.inventory), energy = f.raw(p).fatigue.energy;
  assert.equal(f.act(p, { intent: 'start', node_id: 'east_pine' }).error.code, 'INVENTORY_FULL');
  assert.deepEqual(f.raw(p).life.inventory, inventory); assert.equal(f.raw(p).life.tools.axe.durability, 12); assert.equal(f.raw(p).fatigue.energy, energy);
  assert.equal(f.act(p, { intent: 'plant', node_id: 'east_pine' }).error.code, 'NOT_PLANTABLE');
  assert.equal(node(f, 'east_pine').stock, 1); assert.equal(node(f, 'east_pine').reservation, null);
});

test('v021 restart stops planting and preserves original identity, seeds and stage privacy', t => {
  const f = fixture(t, true), p = f.make({ x: 11, y: 8 }, { pine_cone: 2 });
  ok(f.act(p, { intent: 'plant', node_id: 'planting_plaza' })); f.advance(100);
  const position = { ...f.raw(p).position }, identity = f.raw(p).appearance, oldClock = f.world.state.resources.last_at;
  f.restart(-50); assert.deepEqual(f.raw(p).position, position); assert.deepEqual(f.raw(p).appearance, identity);
  assert.equal(f.raw(p).life.inventory.pine_cone, 2); assert.equal(f.raw(p).life.gathering, null); assert.equal(node(f, 'planting_plaza').reservation, null);
  assert.ok(f.world.state.resources.last_at >= oldClock); assert.equal(node(f, 'planting_plaza').ecology.stage, 'empty');
  const tree = node(f, 'east_pine'); Object.assign(tree.ecology, { secret: 'PRIVATE_ECOLOGY', origin: { token: 'PRIVATE_TOKEN' } }); tree.owner_goal = 'PRIVATE_GOAL';
  assert.doesNotMatch(JSON.stringify(publicResources(f.world.state, f.now())), /PRIVATE_/);
});

test('v021 planted sapling timestamps survive a real SQLite restart and offline growth never grants another seed or harvest', t => {
  const f = fixture(t, true), p = f.make({ x: 17, y: 17 }, { pine_cone: 1 });
  ok(f.act(p, { intent: 'plant', node_id: 'planting_plaza' })); f.advance(4000);
  const planted = structuredClone(node(f, 'planting_plaza').ecology), identity = structuredClone(f.raw(p).appearance), inventory = structuredClone(f.raw(p).life.inventory);
  assert.equal(planted.stage, 'sapling'); f.world.ownerControl(p.id, 'pause');
  f.restart(300000); f.world.tick();
  const after = node(f, 'planting_plaza'); assert.equal(after.ecology.stage, 'young');
  assert.equal(after.ecology.stage_started_at, planted.stage_started_at + 180000); assert.equal(after.ecology.next_at, planted.stage_started_at + 600000);
  assert.equal(after.ecology.generation, 1); assert.equal(after.ecology.origin, 'planted'); assert.equal(after.stock, 0);
  assert.deepEqual(f.raw(p).appearance, identity); assert.deepEqual(f.raw(p).life.inventory, inventory);
  f.jump(300000); assert.equal(after.ecology.stage, 'mature'); assert.equal(after.stock, 3);
  assert.deepEqual(f.raw(p).life.inventory, inventory); assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).movement, null);
});

test('v021 final-chop overflow discovered during work keeps tree and every item unchanged without refunding spent tool wear', t => {
  const f = fixture(t), p = f.make({ x: 28, y: 7 }, { axe: 1 }); node(f, 'east_pine').stock = 1;
  ok(f.act(p, { intent: 'start', node_id: 'east_pine' }));
  const wood = f.raw(p).life.inventory.wood;
  // Boundary fixture: another inventory source has filled the secondary reward slot.
  f.raw(p).life.inventory.pine_cone = Number.MAX_SAFE_INTEGER;
  f.advance(14000);
  assert.equal(f.raw(p).life.inventory.wood, wood); assert.equal(f.raw(p).life.inventory.pine_cone, Number.MAX_SAFE_INTEGER);
  assert.equal(node(f, 'east_pine').stock, 1); assert.equal(node(f, 'east_pine').ecology.stage, 'mature');
  assert.equal(node(f, 'east_pine').reservation, null); assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).life.tools.axe.durability, 11);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_finished').length, 0);
});

test('v021 a cancelled planting keeps its seed and spent work energy; missing seed at completion cannot create a tree', t => {
  const f = fixture(t), p = f.make({ x: 17, y: 17 }, { pine_cone: 1 });
  const before = f.raw(p).fatigue.energy; ok(f.act(p, { intent: 'plant', node_id: 'planting_plaza' }));
  assert.equal(f.raw(p).life.gathering.phase, 'working'); assert.equal(f.raw(p).fatigue.energy, before - 2);
  f.advance(1000); ok(f.act(p, { intent: 'cancel' }));
  assert.equal(f.raw(p).life.inventory.pine_cone, 1); assert.equal(f.raw(p).fatigue.energy, before - 2);
  assert.equal(node(f, 'planting_plaza').ecology.stage, 'empty');
  ok(f.act(p, { intent: 'plant', node_id: 'planting_plaza' }));
  // Unit boundary: another permitted use of the same inventory has consumed the seed.
  f.raw(p).life.inventory.pine_cone = 0; f.advance(4000);
  assert.equal(node(f, 'planting_plaza').ecology.stage, 'empty'); assert.equal(node(f, 'planting_plaza').reservation, null);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_finished').length, 0);
});

test('v021 a planting reservation survives the natural germination boundary without double growth or seed duplication', t => {
  const f = fixture(t), p = f.make({ x: 28, y: 7 }, { pine_cone: 1 });
  const target = node(f, 'east_pine'); target.stock = 0;
  target.ecology = { stage: 'empty', stage_started_at: f.now() - 299000, next_at: f.now() + 1000, generation: 2, origin: 'wild' };
  target.regrow_at = f.now() + 601000;
  ok(f.act(p, { intent: 'plant', node_id: 'east_pine' })); f.advance(2000);
  assert.equal(target.ecology.stage, 'empty'); assert.equal(target.ecology.generation, 2);
  f.advance(2000); assert.equal(target.ecology.stage, 'sapling'); assert.equal(target.ecology.origin, 'planted'); assert.equal(target.ecology.generation, 3);
  assert.equal(target.ecology.next_at, f.now() + TREE_RULES.sapling_seconds * 1000); assert.equal(f.raw(p).life.inventory.pine_cone, 0);
  f.world.ownerControl(p.id, 'pause'); f.jump(600000);
  assert.equal(target.ecology.stage, 'mature'); assert.equal(target.ecology.generation, 3); assert.equal(f.raw(p).life.inventory.pine_cone, 0);
});
