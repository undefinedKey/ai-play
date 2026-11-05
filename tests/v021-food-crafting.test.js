import {PLAZA_RESOURCE_POSITIONS} from '../shared/plaza-layout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { LIFE_RULES } from '../server/life.js';
import { initializeSurvivor, initializeSurvivalWorld, CAMP_SITES, litCampfireNear } from '../server/survival-state.js';

function fixture(t, { position = { x: 11, y: 8 }, scene_id = 'plaza', inventory = {}, satiety = 100, energy = 100, hp = 40 } = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const a = world.createAgent({ name: '原生存旅人' }), c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, max_calls: 10000 });
  const auth = world.authenticate(c.token), joined = world.callTool(auth, 'join_world');
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch }, raw = () => world.agent(a.agent_id);
  // Explicit unit-test starting inventory/body; assertions below only act through the API.
  Object.assign(raw(), { position, scene_id, position_at: now }); Object.assign(raw().life.inventory, inventory);
  initializeSurvivor(raw(), now); raw().survival.satiety = satiety; raw().fatigue.energy = energy; raw().adventure.hp = hp;
  const observe = () => world.callTool(auth, 'observe', session);
  const req = (type, payload) => ({ ...session, action_id: observe().next_action_id, type, payload });
  const act = (type, payload) => world.callTool(auth, 'act', req(type, payload));
  return { world, raw, observe, req, act, auth, now: () => now,
    advance(ms) { const end = now + ms; while (now < end) { now = Math.min(end, now + 100); world.tick(); if (now % 1000 === 0) observe(); } } };
}
const ok = result => { assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };

test('v021 food can restore satiety alone while preserving original healing/energy and exact-once consumption', t => {
  const f = fixture(t, { inventory: { berry: 2 }, satiety: 50 });
  const request = f.req('inventory', { intent: 'use', item_id: 'berry' }), receipt = ok(f.world.callTool(f.auth, 'act', request));
  assert.equal(f.raw().survival.satiety, 62); assert.equal(f.raw().fatigue.energy, 100); assert.equal(f.raw().adventure.hp, 40);
  assert.equal(f.raw().life.inventory.berry, 1); assert.deepEqual(f.world.callTool(f.auth, 'act', request), receipt);
  assert.equal(f.raw().survival.satiety, 62); assert.equal(f.raw().life.inventory.berry, 1);
  const event = f.world.state.events.filter(e => e.type === 'life_consumed').at(-1); assert.equal(event.payload.satiety, 62);
  assert.equal(f.raw().life.ledger.entries.filter(e => e.source_id === request.action_id).length, 1);
});

test('v021 full food effects reject atomically, partial hunger clamps to 100, and food does not auto-trigger', t => {
  const f = fixture(t, { inventory: { trail_ration: 2 }, satiety: 100 });
  const original = structuredClone(f.raw().life.inventory);
  assert.equal(f.act('inventory', { intent: 'use', item_id: 'trail_ration' }).error.code, 'FULL_ENERGY');
  assert.deepEqual(f.raw().life.inventory, original); assert.equal(f.raw().survival.satiety, 100);
  f.raw().survival.satiety = 95; ok(f.act('inventory', { intent: 'use', item_id: 'trail_ration' }));
  assert.equal(f.raw().survival.satiety, 100); assert.equal(f.raw().life.inventory.trail_ration, 1);
  f.raw().survival.satiety = 10; f.advance(1000);
  assert.equal(f.raw().life.inventory.trail_ration, 1); assert.equal(f.world.state.events.filter(e => e.type === 'life_consumed').length, 1);
});

test('v021 grass is harvested through finite work and a torch can be crafted in the wilderness with real materials', t => {
  const f = fixture(t, { position: { x: 24, y: 19 }, scene_id: 'adventure' });
  const gather = ok(f.act('gather', { intent: 'start', node_id: 'wild_grass' })); assert.equal(gather.life.gathering.phase, 'working');
  f.advance(6000); assert.equal(f.raw().life.inventory.grass, 2); assert.equal(f.raw().life.gathering, null);
  const wood = f.raw().life.inventory.wood, energy = f.raw().fatigue.energy;
  const request = f.req('inventory', { intent: 'craft', item_id: 'torch' }), receipt = ok(f.world.callTool(f.auth, 'act', request));
  assert.equal(f.raw().life.inventory.torch, 1); assert.equal(f.raw().life.inventory.grass, 0); assert.equal(f.raw().life.inventory.wood, wood - 1);
  assert.equal(f.raw().fatigue.energy, energy - 2); assert.deepEqual(f.world.callTool(f.auth, 'act', request), receipt); assert.equal(f.raw().life.inventory.torch, 1);
  assert.deepEqual(f.raw().life.equipment, { weapon: null, armor: null }); assert.equal(f.raw().survival.torch, null, 'crafting does not equip or light the torch');
  assert.equal(LIFE_RULES.recipes.find(r => r.item_id === 'torch').station_id, 'portable');
});

test('v021 fire cooking requires an actual lit same-scene nearby fire and never spends ingredients on failed conditions', t => {
  const site = CAMP_SITES.find(s => s.id === 'orchard_hearth');
  const f = fixture(t, { position: { ...site.interaction_position }, inventory: { berry: 2 }, satiety: 60 });
  assert.equal(f.act('inventory', { intent: 'craft', item_id: 'roasted_berry' }).error.code, 'FIRE_REQUIRED');
  assert.equal(f.raw().life.inventory.berry, 2); assert.equal(f.raw().fatigue.energy, 100);
  // A shared installed structure is the fixture here; this test exercises the
  // craft station's live spatial/light checks, not structure construction.
  initializeSurvivalWorld(f.world.state, f.now());
  f.world.state.survival.fires.test_fire = { fire_id: 'test_fire', site_id: site.id, kind: 'campfire', owner_agent_id: 'another-resident',
    fuel_seconds: 90, lit: false, updated_at: f.now(), created_at: f.now() };
  assert.equal(litCampfireNear(f.world, f.raw()), null);
  assert.equal(f.act('inventory', { intent: 'craft', item_id: 'roasted_berry' }).error.code, 'FIRE_REQUIRED');
  f.world.state.survival.fires.test_fire.lit = true;
  f.raw().scene_id = 'adventure'; assert.equal(f.act('inventory', { intent: 'craft', item_id: 'roasted_berry' }).error.code, 'FIRE_REQUIRED');
  f.raw().scene_id = 'plaza'; f.raw().position = { x: site.position.x - 3, y: site.position.y };
  assert.equal(f.act('inventory', { intent: 'craft', item_id: 'roasted_berry' }).error.code, 'FIRE_REQUIRED');
  f.raw().position = { ...site.interaction_position }; ok(f.act('inventory', { intent: 'craft', item_id: 'roasted_berry' }));
  assert.equal(f.raw().life.inventory.berry, 1); assert.equal(f.raw().life.inventory.roasted_berry, 1); assert.equal(f.raw().fatigue.energy, 98);
  assert.equal(f.world.state.survival.fires.test_fire.fuel_seconds, 90, 'crafting neither tops up nor extends the shared flame');
  ok(f.act('inventory', { intent: 'use', item_id: 'roasted_berry' })); assert.equal(f.raw().survival.satiety, 78); assert.equal(f.raw().fatigue.energy, 100);
  assert.equal(f.raw().life.inventory.roasted_berry, 0);
});

test('v021 portable crafting cannot overlap a live resource job and unknown recipe costs stay private', t => {
  const f = fixture(t, { inventory: { grass: 2 }, position: PLAZA_RESOURCE_POSITIONS.camp_branches.interaction_position });
  ok(f.act('gather', { intent: 'start', node_id: 'camp_branches' }));
  const stock = structuredClone(f.raw().life.inventory), energy = f.raw().fatigue.energy;
  assert.equal(f.act('inventory', { intent: 'craft', item_id: 'torch' }).error.code, 'GATHER_BUSY');
  assert.deepEqual(f.raw().life.inventory, stock); assert.equal(f.raw().fatigue.energy, energy);
  assert.equal(f.world.publicAgent(f.raw()).life.inventory, undefined);
});

test('v021 real opportunities expose hunger-only eating, legal planting and portable craft but never unlit cooking or immature harvest', t => {
  const f = fixture(t, { inventory: { berry: 1, pine_cone: 1, grass: 2 }, satiety: 40 });
  let seen = f.observe(); const eat = seen.opportunities.find(o => o.id === 'eat'); assert.ok(eat); ok(f.act(eat.action.type, eat.action.payload));
  assert.equal(f.raw().survival.satiety, 52);
  seen = f.observe(); const planting = seen.opportunities.find(o => o.action.type === 'gather' && o.action.payload.intent === 'plant');
  assert.ok(planting); assert.equal(seen.resources.nodes.find(n => n.id === planting.action.payload.node_id).plantable, true);
  ok(f.act(planting.action.type, planting.action.payload));
  seen = f.observe(); assert.ok(seen.opportunities.some(o => o.id === 'cancel_gather')); assert.ok(!seen.opportunities.some(o => o.action.payload.intent === 'plant'));
  ok(f.act('gather', { intent: 'cancel' }));
  f.raw().position = { x: 24, y: 19 }; f.raw().scene_id = 'adventure';
  const torch = f.observe().opportunities.find(o => o.action.type === 'inventory' && o.action.payload.item_id === 'torch');
  assert.ok(torch); ok(f.act(torch.action.type, torch.action.payload));
  assert.ok(!f.observe().opportunities.some(o => o.action.payload.item_id === 'roasted_berry'));
  const target = f.world.state.resources.nodes.wild_pine; target.stock = 0; target.ecology.stage = 'young';
  assert.equal(f.observe().resources.nodes.find(n => n.id === 'wild_pine').available, false);
  assert.ok(!f.observe().opportunities.some(o => o.action.payload.node_id === 'wild_pine'));
});
