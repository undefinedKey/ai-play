import {PLAZA_SERVICES,PLAZA_CAMP_SITES,PLAZA_RESOURCE_POSITIONS} from '../shared/plaza-layout.js';
const CAMP=PLAZA_SERVICES.camp.interaction_position,HEARTH=PLAZA_CAMP_SITES.find(s=>s.id==='plaza_hearth'),DARK_START={x:HEARTH.position.x-7,y:HEARTH.position.y};
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { publicSurvivor } from '../server/survival-state.js';

const START = 2000000000000;
function fixture(t, { position = { ...CAMP }, energy = 100, inventory = {}, night = false, dbPath = ':memory:' } = {}) {
  let now = START;
  const world = new World({ now: () => now, dbPath, actionIntervalMs: 0 }); let closed = false;
  const close = () => { if (!closed) { world.close(); closed = true; } }; t.after(close);
  const created = world.createAgent({ name: '边界测试旅人', owner_id: 'private_owner' }), controller = world.createController(created.agent_id);
  world.ownerControl(created.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 10000, goal: 'PRIVATE_OWNER_GOAL' });
  const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world', {});
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch }, raw = () => world.agent(created.agent_id);
  // Starting body/location and supplied materials are explicit unit-test fixtures.
  // All decisions after setup use normal World/MCP actions and physical ticks.
  raw().position = { ...position }; raw().position_at = now; raw().fatigue.energy = energy;
  Object.assign(raw().life.inventory, inventory);
  if (night) { world.state.day_cycle.epoch_at = now - 360000; world.state.day_cycle.last_at = now; }
  const observe = () => world.callTool(auth, 'observe', session);
  const request = (type, payload) => ({ ...session, action_id: observe().next_action_id, type, payload });
  const act = (type, payload) => world.callTool(auth, 'act', request(type, payload));
  return { world, raw, auth, session, controller, observe, request, act, close, now: () => now,
    jump(ms) { now += ms; world.tick(); },
    advance(ms, keepAlive = true) { const end = now + ms; while (now < end) { now = Math.min(end, now + 100); world.tick(); if (keepAlive && now % 1000 === 0) observe(); } },
    setNow(value) { now = value; },
  };
}
const applied = receipt => { assert.equal(receipt.status, 'applied', JSON.stringify(receipt.error)); return receipt; };
function fireFixture(f, fuel = 90) {
  // A previously built shared fire isolates time integration from the build test below.
  const fire = { fire_id: 'fixture_fire', site_id: 'plaza_hearth', kind: 'campfire', owner_agent_id: f.raw().agent_id,
    fuel_seconds: fuel, lit: true, updated_at: f.now(), created_at: f.now() };
  f.world.state.survival.fires[fire.fire_id] = fire; return fire;
}
function near(actual, expected, label = '') { assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`); }

for (const source of ['fire', 'torch']) test(`v021 ${source} exact burnout inside a delayed tick agrees with 100 ms stepping`, t => {
  function setup() {
    const f = fixture(t, { position: { ...HEARTH.interaction_position }, night: true });
    if (source === 'fire') fireFixture(f, 0.25);
    else f.raw().survival.torch = { lit: true, fuel_seconds: 0.25, updated_at: f.now() };
    return f;
  }
  const delayed = setup(), stepped = setup(); delayed.jump(1000); stepped.advance(1000);
  near(delayed.raw().survival.darkness_seconds, 0.75, 'only time after actual burnout is dark');
  near(stepped.raw().survival.darkness_seconds, 0.75);
  near(delayed.raw().survival.satiety, 99.96); near(stepped.raw().survival.satiety, 99.96);
  assert.equal(delayed.raw().adventure.hp, 40);
  assert.equal(publicSurvivor(delayed.world, delayed.raw()).light.lit, false);
  if (source === 'torch') { assert.equal(delayed.raw().survival.torch.lit, false); assert.equal(delayed.raw().survival.torch.fuel_seconds, 0); }
  else { assert.equal(delayed.world.state.survival.fires.fixture_fire.lit, false); assert.equal(delayed.world.state.events.filter(e => e.type === 'fire_extinguished').length, 1); }
});

test('v021 delayed dusk-to-night crossing starts darkness at the actual phase boundary', t => {
  const f = fixture(t); f.world.state.day_cycle.epoch_at = f.now() - 359750;
  f.jump(1000); near(f.raw().survival.darkness_seconds, 0.75); assert.equal(f.world.publicSnapshot().day_cycle.phase, 'night');
  assert.equal(f.world.state.events.filter(e => e.type === 'survival_warning' && e.payload.kind === 'darkness').length, 1);
});

test('v021 exhausted run cannot borrow its untravelled path to obtain light during a delayed tick', t => {
  const f = fixture(t, { position: { ...DARK_START }, energy: 0.3, night: true }); fireFixture(f, 90);
  f.raw().survival.darkness_seconds = 89;
  applied(f.act('survival', { intent: 'approach', site_id: 'plaza_hearth', mode: 'run' }));
  const expires = f.raw().run.expires_at; f.jump(2000);
  near(f.raw().position.x, DARK_START.x+1); near(f.raw().position.y, DARK_START.y);
  assert.equal(f.raw().movement, null); assert.equal(f.raw().survival.travel, null);
  near(f.raw().survival.darkness_seconds, 91, 'the actual stopped position remains outside radius five');
  assert.equal(publicSurvivor(f.world, f.raw()).light.lit, false); assert.equal(f.raw().run.expires_at, expires);
  assert.equal(f.world.state.events.filter(e => e.type === 'survival_travel_cancelled' && e.payload.reason === 'exhausted').length, 1);
});

test('v021 explicit owner pause halts personal hunger, torch and travel; the shared fire still burns', t => {
  const f = fixture(t, { inventory: { torch: 1 }, night: true }); fireFixture(f, 90);
  applied(f.act('survival', { intent: 'torch', lit: true }));
  applied(f.act('survival', { intent: 'approach', site_id: 'plaza_hearth', mode: 'walk' }));
  f.advance(200); const expiry = f.raw().run.expires_at;
  f.world.ownerControl(f.raw().agent_id, 'pause');
  const before = structuredClone({ position: f.raw().position, hp: f.raw().adventure.hp, satiety: f.raw().survival.satiety, fuel: f.raw().survival.torch.fuel_seconds });
  f.jump(600000);
  assert.deepEqual(f.raw().position, before.position); assert.equal(f.raw().adventure.hp, before.hp); assert.equal(f.raw().survival.satiety, before.satiety);
  assert.equal(f.raw().survival.torch.fuel_seconds, before.fuel); assert.equal(f.raw().survival.torch.lit, false);
  assert.equal(f.raw().movement, null); assert.equal(f.raw().survival.travel, null); assert.equal(f.raw().run.expires_at, expiry);
  assert.equal(f.world.state.survival.fires.fixture_fire.fuel_seconds, 0); assert.equal(f.world.state.survival.fires.fixture_fire.lit, false);
});

test('v021 lost controller integrates only its 45 second lease and does not catch up personal costs offline', t => {
  const f = fixture(t, { inventory: { torch: 1 }, night: true }); applied(f.act('survival', { intent: 'torch', lit: true }));
  const expiry = f.raw().run.expires_at; f.jump(60000);
  assert.equal(f.raw().status, 'offline'); near(f.raw().survival.satiety, 98.2);
  near(f.raw().survival.torch.fuel_seconds, 45); assert.equal(f.raw().survival.torch.lit, false);
  const before = { hp: f.raw().adventure.hp, satiety: f.raw().survival.satiety, fuel: f.raw().survival.torch.fuel_seconds };
  f.jump(600000); assert.deepEqual({ hp: f.raw().adventure.hp, satiety: f.raw().survival.satiety, fuel: f.raw().survival.torch.fuel_seconds }, before);
  assert.equal(f.raw().run.expires_at, expiry);
});

test('v021 a subsecond grant expiry caps movement, torch and hunger without extending authorization', t => {
  const f = fixture(t, { inventory: { torch: 1 }, night: true }); applied(f.act('survival', { intent: 'torch', lit: true }));
  applied(f.act('survival', { intent: 'approach', site_id: 'plaza_hearth' }));
  f.raw().run.expires_at = f.now() + 250; const expiry = f.raw().run.expires_at;
  f.jump(1000); assert.equal(f.raw().status, 'paused'); assert.equal(f.raw().run.expires_at, expiry);
  near(Math.abs(f.raw().position.x - CAMP.x) + Math.abs(f.raw().position.y - CAMP.y), 0.5);
  near(f.raw().survival.satiety, 99.99); near(f.raw().survival.torch.fuel_seconds, 89.75);
  assert.equal(f.raw().survival.torch.lit, false); assert.equal(f.raw().survival.travel, null); assert.equal(f.raw().movement, null);
});

test('v021 darkness damage at the work completion boundary cancels gathering before any reward', t => {
  const f = fixture(t, { night: true, position:PLAZA_RESOURCE_POSITIONS.camp_branches.interaction_position }); const stock = f.world.state.resources.nodes.camp_branches.stock;
  const beforeWood = f.raw().life.inventory.wood, expires = f.raw().run.expires_at;
  applied(f.act('gather', { intent: 'start', node_id: 'camp_branches' }));
  assert.equal(f.raw().life.gathering.phase, 'working'); assert.equal(f.raw().life.gathering.ends_at, f.now() + 15000, 'night work uses the published 1.25 time multiplier');
  f.raw().survival.darkness_seconds = 85; f.advance(15000);
  assert.equal(f.raw().adventure.hp, 36); assert.equal(f.raw().life.gathering, null);
  assert.equal(f.raw().life.inventory.wood, beforeWood); assert.equal(f.world.state.resources.nodes.camp_branches.stock, stock);
  assert.equal(f.world.state.resources.nodes.camp_branches.reservation, null); assert.equal(f.raw().run.expires_at, expires);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_finished').length, 0);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_cancelled' && e.payload.reason === 'hurt').length, 1);
});

test('v021 a late tick cannot travel past the earlier darkness hit that cancels the journey', t => {
  function setup() {
    const f = fixture(t, { position: { ...DARK_START }, night: true });
    f.raw().survival.darkness_seconds = 99.9;
    applied(f.act('survival', { intent: 'approach', site_id: 'plaza_hearth' })); return f;
  }
  const stepped = setup(), delayed = setup(); stepped.advance(2000); delayed.jump(2000);
  assert.equal(stepped.raw().adventure.hp, 36); assert.equal(delayed.raw().adventure.hp, 36);
  assert.equal(stepped.raw().movement, null); assert.equal(delayed.raw().movement, null);
  assert.equal(stepped.raw().survival.travel, null); assert.equal(delayed.raw().survival.travel, null);
  near(Math.abs(stepped.raw().position.x - DARK_START.x) + Math.abs(stepped.raw().position.y - DARK_START.y), 0.2);
  near(delayed.raw().position.x, stepped.raw().position.x, 'hit must stop at the same physical position');
  near(delayed.raw().position.y, stepped.raw().position.y, 'hit must stop at the same physical position');
  near(delayed.raw().fatigue.energy, stepped.raw().fatigue.energy, 'movement energy cannot be spent after its interruption');
});

test('v021 a rest tick cannot recover energy after its torch has actually burned out', t => {
  const f = fixture(t, { energy: 50, night: true });
  f.raw().survival.torch = { lit: true, fuel_seconds: 0.25, updated_at: f.now() };
  applied(f.act('adventure_plan', { intent: 'rest' }));
  f.jump(1000);
  assert.equal(f.raw().survival.torch.lit, false); assert.equal(f.raw().adventure.plan, null);
  assert.ok(f.raw().fatigue.energy <= 50.5 + 1e-6, `only 0.25 lit seconds may restore at most 0.5 energy, got ${f.raw().fatigue.energy}`);
  const stopped = f.raw().fatigue.energy; f.advance(1000); assert.equal(f.raw().fatigue.energy, stopped, 'night camp is not a free light source');
});

test('v021 a rest tick cannot recover energy after satiety reaches zero mid-tick', t => {
  const f = fixture(t, { energy: 50 }); f.raw().survival.satiety = 0.004;
  applied(f.act('adventure_plan', { intent: 'rest' })); f.jump(1000);
  assert.equal(f.raw().survival.satiety, 0); assert.equal(f.raw().adventure.plan, null);
  assert.ok(f.raw().fatigue.energy <= 50.2 + 1e-6, `only 0.1 fed seconds may restore at most 0.2 energy, got ${f.raw().fatigue.energy}`);
  const stopped = f.raw().fatigue.energy; f.advance(1000); assert.equal(f.raw().fatigue.energy, stopped, 'rest cannot replace food');
});

test('v021 construction and shared fuel are exact-once, while only the owner can extinguish', t => {
  const f = fixture(t, { position: { ...HEARTH.interaction_position }, inventory: { wood: 10, grass: 4 } });
  const build = f.request('survival', { intent: 'build', site_id: 'plaza_hearth', kind: 'campfire' });
  const first = applied(f.world.callTool(f.auth, 'act', build)); assert.deepEqual(f.world.callTool(f.auth, 'act', build), first);
  const fire = Object.values(f.world.state.survival.fires)[0]; assert.equal(Object.keys(f.world.state.survival.fires).length, 1);
  assert.equal(f.raw().life.inventory.wood, 7); assert.equal(f.raw().life.inventory.grass, 2); assert.equal(f.raw().fatigue.energy, 98);
  assert.deepEqual(f.raw().life.ledger.entries.filter(e => e.source_id === build.action_id).map(e => e.items), [{ wood: -3, grass: -2 }], 'World.act records exactly one build cost entry');
  const other = f.world.createAgent({ name: '另一位火塘使用者' }), c = f.world.createController(other.agent_id);
  f.world.ownerControl(other.agent_id, 'start', { controller_id: c.controller_id }); const auth = f.world.authenticate(c.token), j = f.world.callTool(auth, 'join_world');
  const a = f.world.agent(other.agent_id); a.position = { ...HEARTH.interaction_position }; a.life.inventory.wood = 2;
  const req = payload => ({ run_id: j.run_id, session_epoch: j.session_epoch, action_id: a.next_action_id, type: 'survival', payload });
  const fuel = req({ intent: 'fuel', fire_id: fire.fire_id, item_id: 'wood', quantity: 1 });
  const receipt = applied(f.world.callTool(auth, 'act', fuel)); assert.deepEqual(f.world.callTool(auth, 'act', fuel), receipt);
  assert.equal(a.life.inventory.wood, 1); assert.equal(a.fatigue.energy, 98); assert.equal(f.world.state.survival.fires[fire.fire_id].fuel_seconds, 150);
  assert.deepEqual(a.life.ledger.entries.filter(e => e.source_id === fuel.action_id).map(e => e.items), [{ wood: -1 }], 'World.act records exactly one shared fuel cost entry');
  const denied = f.world.callTool(auth, 'act', req({ intent: 'extinguish', fire_id: fire.fire_id })); assert.equal(denied.error.code, 'NOT_FIRE_OWNER');
  assert.equal(f.world.state.survival.fires[fire.fire_id].lit, true); assert.equal(f.world.state.survival.fires[fire.fire_id].fuel_seconds, 150);
  applied(f.act('survival', { intent: 'extinguish', fire_id: fire.fire_id })); f.jump(1000);
  assert.equal(f.world.state.survival.fires[fire.fire_id].lit, false); assert.equal(f.world.state.survival.fires[fire.fire_id].fuel_seconds, 150);
  assert.equal(f.world.state.events.filter(e => e.type === 'fire_built').length, 1); assert.equal(f.world.state.events.filter(e => e.type === 'fire_fueled').length, 1);
});

test('v021 public survival projects allowlisted scalar data and rejects malformed nested fields', t => {
  const f = fixture(t, { night: true }); const fire = fireFixture(f);
  const secret = { token: 'PRIVATE_NESTED_SECRET', owner_goal: 'PRIVATE_NESTED_SECRET' };
  f.raw().survival.travel = { site_id: secret, expires_at: secret, run_id: 'PRIVATE_NESTED_SECRET', session_epoch: secret };
  f.raw().survival.torch = { lit: true, fuel_seconds: 25, updated_at: f.now(), secret };
  f.raw().survival.secret = secret; fire.owner_agent_id = secret; fire.secret = secret;
  let snap = spectatorSnapshot(f.world), json = JSON.stringify(snap);
  assert.ok(!json.includes('PRIVATE_NESTED_SECRET')); assert.ok(!json.includes('PRIVATE_OWNER_GOAL'));
  assert.equal(snap.survival.fires.length, 0); assert.equal(snap.agents[0].survival.travel, null);
  fire.owner_agent_id = f.raw().agent_id; fire.fire_id = secret; snap = spectatorSnapshot(f.world);
  assert.equal(snap.survival.fires.length, 0); assert.ok(!JSON.stringify(snap).includes('PRIVATE_NESTED_SECRET'));
  assert.deepEqual(Object.keys(snap.agents[0].survival.torch).sort(), ['expires_at', 'fuel_seconds', 'lit']);
});

test('v021 SQLite restart preserves personal assets and hunger, stops torch/travel, and advances only shared fuel', t => {
  const dir = mkdtempSync(join(tmpdir(), 'v021-survival-restart-'));
  const dbPath = join(dir, 'world.sqlite'), f = fixture(t, { dbPath, inventory: { torch: 1 }, night: true });
  fireFixture(f, 90); applied(f.act('survival', { intent: 'torch', lit: true }));
  applied(f.act('survival', { intent: 'approach', site_id: 'plaza_hearth' })); f.advance(200);
  const before = structuredClone(f.raw()), oldFire = structuredClone(f.world.state.survival.fires.fixture_fire);
  f.close(); f.setNow(f.now() + 120000);
  const restored = new World({ dbPath, now: f.now, actionIntervalMs: 0 }); t.after(() => { restored.close(); rmSync(dir, { recursive: true, force: true }); }); restored.tick();
  const a = restored.agent(before.agent_id); assert.equal(a.status, 'offline'); assert.deepEqual(a.position, before.position);
  assert.equal(a.survival.satiety, before.survival.satiety); assert.equal(a.adventure.hp, before.adventure.hp);
  assert.equal(a.survival.torch.fuel_seconds, before.survival.torch.fuel_seconds); assert.equal(a.survival.torch.lit, false);
  assert.equal(a.survival.travel, null); assert.equal(a.movement, null); assert.equal(a.survival.darkness_seconds, 0);
  assert.deepEqual(a.life.inventory, before.life.inventory); assert.deepEqual(a.run, before.run);
  assert.equal(restored.state.survival.fires.fixture_fire.fuel_seconds, 0); assert.equal(restored.state.survival.fires.fixture_fire.lit, false);
  assert.equal(restored.state.survival.fires.fixture_fire.owner_agent_id, oldFire.owner_agent_id);
  assert.equal(restored.state.events.filter(e => e.type === 'survival_arrived').length, 0);
});
