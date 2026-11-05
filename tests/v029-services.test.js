import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { LIFE_RULES, publicGathering } from '../server/life.js';
import { MARKET_RULES } from '../server/economy.js';
import { RESOURCE_NODES, publicResources } from '../server/resources.js';
import { findPath, isWalkable } from '../server/spatial.js';
import { PLAZA_RESOURCE_POSITIONS } from '../shared/plaza-layout.js';

const FALLEN = 'camp_fallen_berries';
const applied = result => { assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };
const rejected = (result, code) => { assert.equal(result.status, 'rejected'); assert.equal(result.error.code, code); };
function fixture(t) {
  let now = 2000000000000;
  const world = new World({ dbPath: ':memory:', now: () => now, actionIntervalMs: 0 }), actors = [];
  t.after(() => world.close());
  const raw = p => world.agent(p.id), observe = p => world.callTool(p.auth, 'observe', p.session);
  const make = () => {
    const a = world.createAgent({ name: `世界服务访客${actors.length}` }), c = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, max_calls: 10000 });
    const auth = world.authenticate(c.token), seen = world.callTool(auth, 'join_world');
    const p = { id: a.agent_id, auth, session: { run_id: seen.run_id, session_epoch: seen.session_epoch } };
    actors.push(p); raw(p).position = { ...world.getRules().life.camp_place.service_center }; raw(p).position_at = now;
    return p;
  };
  const request = (p, type, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const advance = (ms, touch = true) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100); world.tick();
      if (touch && now % 1000 === 0) for (const p of actors) if (raw(p).status === 'active') observe(p);
    }
  };
  const until = (condition, max = 12000) => {
    const deadline = now + max;
    while (!condition() && now < deadline) advance(100);
    assert.ok(condition(), 'condition reached through actual world ticks');
  };
  const empty = p => {
    const a = raw(p); a.life.inventory = {}; a.adventure.gold = 0; a.adventure.hp = 10; a.fatigue.energy = 0;
    Object.assign(a.survival, { satiety: 0, last_at: now, starvation_seconds: 0, hunger_hits: 0, protected_until: 0 });
  };
  return { world, raw, observe, make, request, act, advance, until, empty, now: () => now,
    jump(ms) { now += ms; world.tick(); } };
}
const balances = a => structuredClone({ inventory: a.life.inventory, gold: a.adventure.gold, market: a.life.market, ledger: a.life.ledger,
  energy: a.fatigue.energy, satiety: a.survival.satiety, hp: a.adventure.hp });
const gather = (f, p) => applied(f.act(p, 'gather', { intent: 'start', node_id: FALLEN, mode: 'walk' }));

test('v029 food service publishes equal prices and a reachable shared, finite fallen-fruit resource', t => {
  const f = fixture(t), p = f.make(), q = f.make();
  for (const [id, price, satiety] of [['wheat_bread', 12, 35], ['turnip', 5, 15]]) {
    assert.equal(MARKET_RULES.items.find(i => i.item_id === id).buy_price, price);
    assert.equal(LIFE_RULES.items.find(i => i.id === id).satiety_restore, satiety);
  }
  assert.equal(LIFE_RULES.items.find(i => i.id === 'wheat_bread').energy_restore, 24);
  assert.deepEqual(f.observe(p).life.market, f.observe(q).life.market);
  const def = RESOURCE_NODES.find(n => n.id === FALLEN);
  assert.deepEqual(def.position, PLAZA_RESOURCE_POSITIONS[FALLEN].position); assert.deepEqual(def.interaction_position, PLAZA_RESOURCE_POSITIONS[FALLEN].interaction_position);
  assert.ok(isWalkable('plaza', def.position)); assert.ok(isWalkable('plaza', def.interaction_position));
  const path = findPath('plaza', LIFE_RULES.camp_place.service_center, def.interaction_position);
  assert.ok(path); assert.deepEqual(path[0], LIFE_RULES.camp_place.service_center); assert.deepEqual(path.at(-1), def.interaction_position);
  assert.ok(path.length - 1 <= 4, 'zero-energy walk and 7.5s night pickup must fit before the first ordinary 10s starvation hit');
  assert.equal(def.energy_cost, 0); assert.equal(def.tool_id, null); assert.equal(def.duration_seconds, 6);
  assert.equal(def.yield_count, 1); assert.equal(def.max_stock, 1); assert.equal(def.regrow_seconds, 120);
  assert.deepEqual(def.available_phases, ['day', 'dusk', 'night', 'dawn']);
  const before = balances(f.raw(p));
  for (let i = 0; i < 5; i++) f.observe(p);
  assert.deepEqual(balances(f.raw(p)), before, 'reading the world never grants or consumes food');
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).adventure.plan, null);
});

test('v029 buying food at zero energy only transfers the purchased inventory; eating requires a separate action', t => {
  const f = fixture(t), p = f.make(); f.empty(p); f.raw(p).position = { ...MARKET_RULES.place.service_center }; f.raw(p).adventure.gold = 12;
  const request = f.request(p, 'trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 });
  applied(f.world.callTool(p.auth, 'act', request));
  assert.equal(f.raw(p).life.inventory.wheat_bread, 1); assert.equal(f.raw(p).adventure.gold, 0);
  assert.equal(f.raw(p).fatigue.energy, 0); assert.equal(f.raw(p).survival.satiety, 0); assert.equal(f.raw(p).adventure.hp, 10);
  applied(f.world.callTool(p.auth, 'act', request));
  assert.equal(f.raw(p).life.inventory.wheat_bread, 1); assert.equal(f.raw(p).life.market.bought, 1);
  assert.equal(f.raw(p).life.ledger.entries.filter(e => e.source_id === request.action_id).length, 1);
  f.advance(1000);
  assert.equal(f.raw(p).life.inventory.wheat_bread, 1); assert.equal(f.raw(p).fatigue.energy, 0); assert.equal(f.raw(p).survival.satiety, 0);
  applied(f.act(p, 'inventory', { intent: 'use', item_id: 'wheat_bread' }));
  assert.equal(f.raw(p).life.inventory.wheat_bread, 0); assert.equal(f.raw(p).fatigue.energy, 24); assert.equal(f.raw(p).survival.satiety, 35);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).movement, null); assert.equal(f.raw(p).adventure.plan, null);
});

test('v029 failed food purchases leave balances, body, quota and ledger unchanged; existing quantity/window limits still apply', t => {
  const f = fixture(t), p = f.make(); f.empty(p);
  f.raw(p).position = { ...MARKET_RULES.place.service_center };
  const buy = (item_id, quantity = 1) => f.act(p, 'trade', { intent: 'buy', item_id, quantity });
  for (const id of ['turnip', 'wheat_bread']) {
    const before = balances(f.raw(p)); rejected(buy(id), 'INSUFFICIENT_GOLD'); assert.deepEqual(balances(f.raw(p)), before);
  }
  f.raw(p).adventure.gold = 500;
  for (const qty of [0, 11, 1.5]) {
    const before = balances(f.raw(p)); rejected(buy('wheat_bread', qty), 'INVALID_ACTION'); assert.deepEqual(balances(f.raw(p)), before);
  }
  f.raw(p).position = { x: 20, y: 10 };
  const before = balances(f.raw(p)); assert.equal(buy('wheat_bread').status, 'rejected'); assert.deepEqual(balances(f.raw(p)), before);
  f.raw(p).position = { ...MARKET_RULES.place.service_center };
  applied(buy('turnip', 10)); applied(buy('wheat_bread', 10));
  assert.equal(f.raw(p).life.market.bought, 20); assert.equal(f.raw(p).adventure.gold, 330);
  assert.equal(f.raw(p).survival.satiety, 0); assert.equal(f.raw(p).fatigue.energy, 0);
  const limited = balances(f.raw(p)); rejected(buy('turnip'), 'TRADE_LIMIT'); assert.deepEqual(balances(f.raw(p)), limited);
});

for (const phase of ['day', 'night']) test(`v029 ${phase}: an empty, penniless, starving zero-energy visitor can explicitly walk, pick one berry, then eat it`, t => {
  const f = fixture(t), p = f.make(); f.empty(p);
  if (phase === 'night') f.world.state.day_cycle.epoch_at = f.now() - 360000;
  const start = { ...f.raw(p).position }, at = f.now(); gather(f, p);
  assert.equal(publicGathering(f.raw(p)).energy_cost, 0); assert.equal(f.raw(p).life.gathering.phase, 'approaching');
  assert.deepEqual(f.raw(p).position, start); assert.deepEqual(f.raw(p).life.inventory, {});
  f.until(() => f.raw(p).life.gathering?.phase === 'working', 2000);
  const job = publicGathering(f.raw(p));
  assert.equal(job.energy_cost, 0); assert.equal(job.duration_seconds, phase === 'night' ? 7.5 : 6);
  assert.equal(job.day_phase, phase); assert.equal(f.raw(p).fatigue.energy, 0);
  assert.deepEqual(f.raw(p).position, PLAZA_RESOURCE_POSITIONS[FALLEN].interaction_position);
  f.until(() => !f.raw(p).life.gathering, 8000);
  assert.ok(f.now() - at < 10000, 'short pickup can finish before the first ordinary starvation hit');
  assert.equal(f.raw(p).survival.protected_until, 0, 'fixture grants no artificial damage immunity');
  assert.equal(f.raw(p).adventure.hp, 10); assert.equal(f.raw(p).life.inventory.berry, 1);
  assert.equal(f.raw(p).survival.satiety, 0); assert.equal(f.raw(p).fatigue.energy, 0);
  assert.equal(f.raw(p).life.ledger.entries.filter(e => e.source_id === job.job_id).length, 1);
  assert.equal(f.raw(p).movement, null); assert.equal(f.raw(p).adventure.plan, null);
  applied(f.act(p, 'inventory', { intent: 'use', item_id: 'berry' }));
  assert.equal(f.raw(p).life.inventory.berry, 0); assert.equal(f.raw(p).survival.satiety, 12);
  assert.equal(f.raw(p).fatigue.energy, 2); assert.equal(f.raw(p).adventure.hp, 14);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).adventure.gold, 0);
});

test('v029 zero work cost survives arrival recalculation across dusk/night; ordinary paid work still fails at zero', t => {
  const f = fixture(t), p = f.make(); f.empty(p);
  f.world.state.day_cycle.epoch_at = f.now() - 359900;
  gather(f, p); assert.equal(publicGathering(f.raw(p)).energy_cost, 0);
  f.until(() => f.raw(p).life.gathering?.phase === 'working', 2000);
  assert.equal(publicGathering(f.raw(p)).energy_cost, 0); assert.equal(publicGathering(f.raw(p)).duration_seconds, 7.5);
  applied(f.act(p, 'gather', { intent: 'cancel' }));
  f.raw(p).position = { ...PLAZA_RESOURCE_POSITIONS.camp_branches.interaction_position };
  rejected(f.act(p, 'gather', { intent: 'start', node_id: 'camp_branches' }), 'FATIGUE_EXHAUSTED');
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.world.state.resources.nodes.camp_branches.reservation, null);
});

test('v029 reservation, depletion and regeneration are shared; duplicate commands, observing and time never add extra berries', t => {
  const f = fixture(t), p = f.make(), q = f.make();
  const request = f.request(p, 'gather', { intent: 'start', node_id: FALLEN });
  applied(f.world.callTool(p.auth, 'act', request));
  const before = balances(f.raw(q)); rejected(f.act(q, 'gather', { intent: 'start', node_id: FALLEN }), 'RESOURCE_BUSY');
  assert.deepEqual(balances(f.raw(q)), before);
  applied(f.world.callTool(p.auth, 'act', request));
  f.until(() => !f.raw(p).life.gathering);
  applied(f.world.callTool(p.auth, 'act', request));
  assert.equal(f.raw(p).life.inventory.berry, 1); assert.equal(f.world.state.resources.nodes[FALLEN].stock, 0);
  assert.equal(f.world.state.resources.nodes[FALLEN].regrow_at, f.now() + 120000);
  rejected(f.act(q, 'gather', { intent: 'start', node_id: FALLEN }), 'RESOURCE_DEPLETED');
  f.advance(119900); assert.equal(f.world.state.resources.nodes[FALLEN].stock, 0);
  f.advance(100); assert.equal(f.world.state.resources.nodes[FALLEN].stock, 1);
  assert.equal(f.raw(p).life.inventory.berry, 1); assert.equal(f.raw(q).life.inventory.berry, undefined);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(q).life.gathering, null);
  assert.equal(publicResources(f.world.state, f.now()).nodes.find(n => n.id === FALLEN).available, true);
  gather(f, q); f.until(() => f.raw(q).life.gathering?.phase === 'working');
  applied(f.act(q, 'gather', { intent: 'cancel' }));
  assert.equal(f.raw(q).life.inventory.berry, undefined); assert.equal(f.world.state.resources.nodes[FALLEN].stock, 1);
  assert.equal(f.world.state.resources.nodes[FALLEN].reservation, null);
});

test('v029 cancellation, owner pause, run expiry and lost host lease never pay an unfinished pickup or replace it', t => {
  for (const interruption of ['cancel', 'pause', 'expiry', 'offline']) {
    const f = fixture(t), p = f.make(); gather(f, p);
    f.until(() => f.raw(p).life.gathering?.phase === 'working'); f.advance(500);
    if (interruption === 'cancel') applied(f.act(p, 'gather', { intent: 'cancel' }));
    else if (interruption === 'pause') f.world.ownerControl(p.id, 'pause');
    else if (interruption === 'expiry') { f.raw(p).run.expires_at = f.now() + 100; f.jump(1000); }
    else { f.raw(p).last_contact_at = f.now() - 44900; f.jump(1000); }
    f.advance(10000, false);
    assert.equal(f.raw(p).life.inventory.berry, undefined, interruption);
    assert.equal(f.world.state.resources.nodes[FALLEN].stock, 1, interruption);
    assert.equal(f.world.state.resources.nodes[FALLEN].reservation, null, interruption);
    assert.equal(f.raw(p).life.gathering, null, interruption); assert.equal(f.raw(p).adventure.plan, null, interruption);
    assert.equal(f.raw(p).movement, null, interruption);
    assert.equal(f.world.state.events.some(e => e.type === 'life_gather_finished' && e.payload.node_id === FALLEN), false, interruption);
  }
});
