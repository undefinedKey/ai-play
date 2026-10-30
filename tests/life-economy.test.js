import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { World } from '../server/world.js';
import { LIFE_RULES, publicLife, initializeLife } from '../server/life.js';
import { MARKET_RULES, LEDGER_LIMIT } from '../server/economy.js';
import { spectatorSnapshot } from '../server/spectator.js';

function fixture(t, options = {}) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }), people = [];
  t.after(() => world.close());
  const make = (name = '和平旅人', owner_id = 'owner-a') => {
    const a = world.createAgent({ name, owner_id }), controller = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60 });
    const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world');
    const person = { id: a.agent_id, auth, controller, session: { run_id: joined.run_id, session_epoch: joined.session_epoch } };
    world.agent(a.agent_id).position = { x: 11, y: 8 }; people.push(person); return person;
  };
  const raw = p => world.agent(p.id), observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const advance = (ms, connected = people) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 1000); world.tick();
      for (const p of connected) if (raw(p).status === 'active') observe(p);
    }
  };
  return { world, make, raw, observe, request, act, advance, jump: ms => { now += ms; world.tick(); }, now: () => now };
}
const applied = result => { assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };
const rejected = (result, code) => { assert.equal(result.status, 'rejected'); assert.equal(result.error.code, code); };
const resources = a => structuredClone({ life: a.life, fatigue: a.fatigue, gold: a.adventure.gold });

test('v0.13目录明确所有成本/价格；节点交互范围处于安全区，买回同物必亏', () => {
  assert.equal(LIFE_RULES.gathering.tool_required, false);
  assert.deepEqual(LIFE_RULES.gathering.resources.map(r => [r.id, r.duration_seconds, r.energy_cost]), [['wood', 12, 4], ['ore', 18, 6]]);
  for (const r of LIFE_RULES.gathering.resources) {
    assert.ok(Math.abs(r.x - 11) + Math.abs(r.y - 8) + r.radius <= 2);
    assert.ok(r.yield_count > 0 && r.cooldown_seconds > 0);
  }
  for (const item of MARKET_RULES.items) if (item.buy_price && item.sell_price) assert.ok(item.buy_price > item.sell_price);
  assert.equal(MARKET_RULES.max_quantity, 10); assert.equal(MARKET_RULES.window_seconds, 300);
  assert.equal(LIFE_RULES.recipes.filter(recipe => recipe.kind === 'cooking').length, 2);
});

test('真实动作开始只扣一次体力，工作期间不恢复，完成只发一次且写同job来源账本', t => {
  const f = fixture(t), p = f.make(), initial = f.raw(p).life.inventory.wood;
  const req = f.request(p, 'gather', { intent: 'start', resource_id: 'wood' }), first = applied(f.world.callTool(p.auth, 'act', req));
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), first); assert.equal(f.raw(p).fatigue.energy, 96);
  const job = f.observe(p).self.life.gathering;
  assert.equal(job.ends_at - job.started_at, 12000); assert.equal(f.raw(p).life.inventory.wood, initial);
  f.advance(11000); assert.equal(f.raw(p).fatigue.energy, 96); assert.ok(f.raw(p).life.gathering);
  f.advance(1000); assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).life.inventory.wood, initial + 1);
  const entries = f.raw(p).life.ledger.entries.filter(entry => entry.source_id === job.job_id);
  assert.equal(entries.length, 1); assert.deepEqual(entries[0].items, { wood: 1 });
  assert.equal(f.world.state.events.filter(event => event.type === 'life_gather_finished').length, 1);
  f.advance(3000); assert.equal(f.raw(p).fatigue.energy, 96.9); assert.equal(f.raw(p).life.inventory.wood, initial + 1);
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), first); assert.equal(f.raw(p).life.gathering, null);
});

test('延迟tick按有限工作结束边界恢复体力，不补做多轮也不把工作秒算成休息', t => {
  const f = fixture(t), p = f.make();
  applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' })); f.jump(17000);
  assert.equal(f.raw(p).fatigue.energy, 97.5); assert.equal(f.raw(p).life.inventory.wood, 4);
  assert.equal(f.raw(p).life.gathering, null); assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_finished').length, 1);
});

test('本人取消不领奖不退体力，不绕过采集冷却；无效取消/非法移动保持原工作', t => {
  const f = fixture(t), p = f.make(); applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }));
  f.advance(5000); const before = resources(f.raw(p));
  rejected(f.act(p, 'gather', { intent: 'cancel', resource_id: 'wood' }), 'INVALID_ACTION'); assert.deepEqual(resources(f.raw(p)), before);
  rejected(f.act(p, 'move', { x: -1, y: 8 }), 'INVALID_ACTION'); assert.deepEqual(resources(f.raw(p)), before);
  const req = f.request(p, 'gather', { intent: 'cancel' }), result = applied(f.world.callTool(p.auth, 'act', req));
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), result); assert.equal(f.raw(p).fatigue.energy, 96); assert.equal(f.raw(p).life.inventory.wood, 3);
  rejected(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }), 'GATHER_COOLDOWN');
  rejected(f.act(p, 'gather', { intent: 'cancel' }), 'NO_GATHERING'); f.advance(15000);
  applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }));
  applied(f.act(p, 'move', { x: 11, y: 7 })); assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).life.inventory.wood, 3);
});

for (const boundary of ['pause', 'recall', 'transfer', 'expiry', 'lease', 'room']) test(`采集遇${boundary}中断不领奖、不重启旧工作`, t => {
  const f = fixture(t), p = f.make(); applied(f.act(p, 'gather', { intent: 'start', resource_id: 'ore' }));
  const original = f.raw(p).life.gathering.job_id;
  if (boundary === 'pause' || boundary === 'recall') { f.advance(2000); f.world.ownerControl(p.id, boundary); }
  if (boundary === 'transfer') { const other = f.world.createController(p.id); f.world.ownerControl(p.id, 'transfer', { controller_id: other.controller_id }); }
  if (boundary === 'expiry') { f.raw(p).run.expires_at = f.now() + 5000; f.jump(7000); }
  if (boundary === 'lease') f.jump(45000);
  if (boundary === 'room') f.world.ownerRoom('pause');
  f.advance(60000, []); assert.equal(f.raw(p).life.gathering, null); assert.equal(f.raw(p).life.inventory.ore || 0, 0);
  assert.equal(f.raw(p).life.ledger.entries.some(entry => entry.source_id === original), false);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_gather_cancelled' && e.payload.job_id === original).length, 1);
});

test('采集中的聊天等待与补给可用，其他工作/交易/活动须明确取消；两人可同时采同一资源', t => {
  const f = fixture(t), p = f.make(), other = f.make('另一旅人', 'owner-b');
  for (const person of [p, other]) applied(f.act(person, 'gather', { intent: 'start', resource_id: 'wood' }));
  for (const [type, payload] of [['farm', { intent: 'till', plot_id: 'plot_1' }], ['inventory', { intent: 'craft', item_id: 'wooden_sword' }],
    ['trade', { intent: 'sell', item_id: 'wood', quantity: 1 }], ['adventure_plan', { intent: 'rest' }], ['start_activity', { activity_id: 'relax' }]]) {
    const before = resources(f.raw(p)); rejected(f.act(p, type, payload), 'GATHER_BUSY'); assert.deepEqual(resources(f.raw(p)), before);
  }
  applied(f.act(p, 'wait', {})); applied(f.act(p, 'say', { channel: 'nearby', text: '我在拾枝，你可以自由选择。' }));
  f.raw(p).life.inventory.wheat_bread = 1; applied(f.act(p, 'inventory', { intent: 'use', item_id: 'wheat_bread' }));
  assert.ok(f.raw(p).life.gathering); f.advance(12000);
  assert.equal(f.raw(p).life.inventory.wood, 4); assert.equal(f.raw(other).life.inventory.wood, 4);
});

test('采集拒绝越权/非法目录/不在范围/体力不足；开始与完成时库存上限不会溢出', t => {
  const f = fixture(t), p = f.make();
  for (const payload of [{ intent: 'start', resource_id: 'wood', agent_id: 'other' }, { intent: 'start', resource_id: 'wood', quantity: 999 }, { intent: 'start', resource_id: 'secret' }, { intent: 'start' }]) {
    const before = resources(f.raw(p)); rejected(f.act(p, 'gather', payload), 'INVALID_ACTION'); assert.deepEqual(resources(f.raw(p)), before);
  }
  f.raw(p).position = { x: 13, y: 8 }; rejected(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }), 'NOT_AT_RESOURCE');
  f.raw(p).position = { x: 11, y: 8 }; f.raw(p).fatigue.energy = 3;
  rejected(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }), 'FATIGUE_EXHAUSTED');
  f.raw(p).fatigue.energy = 100; f.raw(p).life.inventory.wood = Number.MAX_SAFE_INTEGER;
  rejected(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }), 'INVENTORY_FULL');
  f.raw(p).life.inventory.wood--; applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }));
  f.raw(p).life.inventory.wood++; f.advance(12000);
  assert.equal(f.raw(p).life.inventory.wood, Number.MAX_SAFE_INTEGER); assert.equal(f.raw(p).life.gathering, null);
  assert.equal(f.world.state.events.at(-1).payload.reason, 'inventory_full');
});

test('购销真实扣款/库存/额度，原ID重放一次结算；窗口刷新按时间不按重连', t => {
  const f = fixture(t), p = f.make(); f.raw(p).adventure.gold = 1000; f.raw(p).life.inventory.wood = 50;
  const req = f.request(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 10 }), first = applied(f.world.callTool(p.auth, 'act', req));
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), first);
  assert.equal(f.raw(p).life.inventory.wood, 60); assert.equal(f.raw(p).adventure.gold, 960); assert.equal(f.observe(p).self.life.market.buy_remaining, 10);
  applied(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 10 })); rejected(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 1 }), 'TRADE_LIMIT');
  for (let i = 0; i < 3; i++) applied(f.act(p, 'trade', { intent: 'sell', item_id: 'wood', quantity: 10 }));
  rejected(f.act(p, 'trade', { intent: 'sell', item_id: 'wood', quantity: 1 }), 'TRADE_LIMIT');
  f.world.callTool(p.auth, 'join_world', { run_id: p.session.run_id }); assert.equal(f.observe(p).self.life.market.sell_remaining, 0);
  f.advance(300000); assert.equal(f.observe(p).self.life.market.buy_remaining, 20); assert.equal(f.observe(p).self.life.market.sell_remaining, 30);
  assert.equal(f.raw(p).life.ledger.entries.filter(entry => entry.source_id === req.action_id).length, 1);
});

test('非法交易、缺币缺物、数值溢出和上限失败完全回滚，不消耗额度或写流水', t => {
  const f = fixture(t), p = f.make();
  for (const [payload, code] of [
    [{ intent: 'buy', item_id: 'wood', quantity: 1 }, 'INSUFFICIENT_GOLD'], [{ intent: 'sell', item_id: 'ore', quantity: 1 }, 'INSUFFICIENT_ITEMS'],
    [{ intent: 'buy', item_id: 'turnip', quantity: 1 }, 'TRADE_UNAVAILABLE'], [{ intent: 'sell', item_id: 'turnip_seed', quantity: 1 }, 'TRADE_UNAVAILABLE'],
    ...[0, -1, 11, 1.5, '1', Number.MAX_SAFE_INTEGER].map(quantity => [{ intent: 'sell', item_id: 'wood', quantity }, 'INVALID_ACTION']),
    [{ intent: 'sell', item_id: 'wood', quantity: 1, gold: 999 }, 'INVALID_ACTION'],
    [{ intent: 'sell', item_id: 'wood', quantity: 1, owner_id: 'other' }, 'INVALID_ACTION'],
  ]) { const before = resources(f.raw(p)); rejected(f.act(p, 'trade', payload), code); assert.deepEqual(resources(f.raw(p)), before); }
  f.raw(p).adventure.gold = Number.MAX_SAFE_INTEGER; const full = resources(f.raw(p));
  rejected(f.act(p, 'trade', { intent: 'sell', item_id: 'wood', quantity: 1 }), 'INVALID_ACTION'); assert.deepEqual(resources(f.raw(p)), full);
  f.raw(p).life.inventory.wood = Number.MAX_SAFE_INTEGER; const stock = resources(f.raw(p));
  rejected(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 1 }), 'INVENTORY_FULL'); assert.deepEqual(resources(f.raw(p)), stock);
});

test('两料理用实际农产制作且瞬时；分别恢复生命/体力，满值拒绝不消耗，不解除危险', t => {
  const f = fixture(t), p = f.make(); Object.assign(f.raw(p).life.inventory, { turnip: 2, wheat: 2 });
  for (const item_id of ['turnip_soup', 'wheat_bread']) applied(f.act(p, 'inventory', { intent: 'craft', item_id }));
  assert.equal(f.raw(p).fatigue.energy, 96); assert.equal(f.raw(p).life.inventory.turnip, 0); assert.equal(f.raw(p).life.inventory.wheat, 0);
  assert.equal(f.raw(p).activity, null); assert.equal(f.raw(p).life.gathering, null);
  rejected(f.act(p, 'inventory', { intent: 'use', item_id: 'turnip_soup' }), 'FULL_HEALTH');
  f.raw(p).fatigue.energy = 100; rejected(f.act(p, 'inventory', { intent: 'use', item_id: 'wheat_bread' }), 'FULL_ENERGY');
  Object.assign(f.raw(p), { position: { x: 2, y: 2 } }); Object.assign(f.raw(p).adventure, { hp: 5, in_field: true, decision_until: f.now() + 30000 });
  f.raw(p).fatigue.energy = 90; applied(f.act(p, 'inventory', { intent: 'use', item_id: 'wheat_bread' }));
  assert.equal(f.raw(p).fatigue.energy, 100); assert.equal(f.raw(p).adventure.hp, 5); assert.equal(f.raw(p).adventure.in_field, true);
  applied(f.act(p, 'inventory', { intent: 'use', item_id: 'turnip_soup' })); assert.equal(f.raw(p).adventure.hp, 37); assert.equal(f.raw(p).adventure.decision_until, f.now() + 30000);
});

test('经济账本有来源/余额，超过100条截断；动作回执不复制完整历史', t => {
  const f = fixture(t), p = f.make(); f.raw(p).adventure.gold = 1000;
  for (let i = 0; i < 120; i++) {
    f.raw(p).life.market.bought = 0; f.raw(p).life.market.sold = 0; // Isolate ledger retention from the separately tested window limits.
    const result = applied(f.act(p, 'trade', { intent: i % 2 ? 'sell' : 'buy', item_id: 'wood', quantity: 1 }));
    assert.equal(result.life.ledger, undefined);
  }
  const ledger = f.observe(p).self.life.ledger;
  assert.equal(ledger.entries.length, LEDGER_LIMIT); assert.equal(ledger.total_entries, 121);
  assert.equal(new Set(ledger.entries.map(entry => entry.source_id)).size, 100);
  assert.equal(ledger.entries.at(-1).balances.gold, f.raw(p).adventure.gold);
  assert.equal(ledger.entries.at(-1).balances.inventory.wood, f.raw(p).life.inventory.wood);
  assert.ok(Object.values(f.world.state.receipts).every(receipt => !receipt.result.life?.ledger));
  assert.ok(JSON.stringify(f.world.state).length < 500000, '有界流水不应被200条动作回执重复复制');
});

test('公开状态仅展示采集/作品/购销，库存/额度/账本和任意内部字段继续私有', t => {
  const f = fixture(t), p = f.make('甲', 'owner-a'), other = f.make('乙', 'owner-b');
  applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }));
  f.raw(p).life.gathering.private_note = 'PRIVATE_JOB'; f.raw(p).life.market.private_note = 'PRIVATE_QUOTA'; f.raw(p).life.ledger.private_note = 'PRIVATE_LEDGER';
  const self = f.observe(p).self; assert.ok(self.life.ledger.entries.length); assert.ok(self.life.market);
  const neighbour = f.observe(other).nearby_agents.find(a => a.agent_id === p.id), publicState = spectatorSnapshot(f.world);
  for (const agent of [neighbour, ...publicState.agents, f.world.snapshotFor({ id: 'owner-b' }).agents.find(a => a.agent_id === p.id)]) {
    for (const key of ['inventory', 'market', 'ledger']) assert.equal(agent.life[key], undefined);
    if (agent.life.gathering) for (const key of ['private_note', 'run_id', 'session_epoch']) assert.equal(agent.life.gathering[key], undefined);
  }
  assert.equal(/PRIVATE_|opening_balance|initial_grant|"source_id"/.test(JSON.stringify(publicState)), false, '公开投影不能含内部哨兵、流水或来源字段');
  assert.ok(publicState.events.some(event => event.type === 'life_gather_started' && Number.isInteger(event.payload.ends_at)));
});

test('候选保留和平恢复/料理/交易和探索；采集中只给真实合法取消与补给', t => {
  const f = fixture(t), p = f.make();
  Object.assign(f.raw(p).life, { inventory: {} }); f.raw(p).life.tools.hoe.durability = 0; f.raw(p).life.tools.watering_can.durability = 0;
  assert.ok(f.observe(p).opportunities.some(option => option.action.type === 'gather'));
  f.raw(p).life.inventory.wood = 1;
  assert.ok(f.observe(p).opportunities.some(option => option.action.type === 'trade' && option.action.payload.intent === 'sell'));
  f.raw(p).adventure.gold = 2;
  assert.ok(f.observe(p).opportunities.some(option => option.action.type === 'trade' && option.action.payload.intent === 'buy'));
  Object.assign(f.raw(p).life.inventory, { turnip: 2, wheat: 2, turnip_seed: 1, wheat_seed: 1 });
  assert.ok(f.observe(p).opportunities.some(option => option.action.type === 'inventory' && option.action.payload.item_id === 'turnip_soup'));
  const backup = structuredClone(f.world.state), options = f.observe(p).opportunities;
  assert.ok(options.length <= 6); assert.ok(options.some(option => option.action.type === 'adventure_plan'));
  for (const option of options) { f.world.state = structuredClone(backup); applied(f.act(p, option.action.type, option.action.payload)); }
  f.world.state = structuredClone(backup); applied(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' }));
  assert.deepEqual(f.observe(p).opportunities.map(option => option.action.type), ['gather']);
});

test('六项候选为可用狩猎/探索/采集保留位置，重复恢复与同类田地不挤掉生活动作', t => {
  const f = fixture(t), p = f.make();
  Object.assign(f.raw(p).life.inventory, { turnip: 2, wheat: 2, ore: 3 });
  const check = ({ energy, hp, monsters, hunt, living }) => {
    const a = f.raw(p); a.fatigue.energy = energy; a.adventure.hp = hp;
    for (const m of f.world.state.adventure.monsters) m.status = monsters ? 'alive' : 'respawning';
    const observation = f.observe(p), options = observation.opportunities, saved = structuredClone(f.world.state);
    assert.ok(options.length <= 6);
    assert.equal(options.some(o => o.action.payload.intent === 'hunt'), hunt);
    assert.ok(options.some(o => o.action.payload.intent === 'explore'));
    assert.ok(options.some(o => o.action.type === 'gather'));
    assert.ok(options.some(o => o.action.type === 'farm'));
    assert.ok(options.filter(o => ['farm', 'inventory', 'trade'].includes(o.action.type) && o.action.payload.intent !== 'use').length >= living);
    assert.equal(options.filter(o => o.id === 'relax' || o.id === 'rest').length, 1);
    for (const option of options) {
      f.world.state = structuredClone(saved);
      applied(f.world.callTool(p.auth, 'act', { ...p.session, action_id: observation.next_action_id, ...option.action }));
    }
    f.world.state = saved;
  };
  check({ energy: 100, hp: 40, monsters: true, hunt: true, living: 2 });
  check({ energy: 50, hp: 20, monsters: true, hunt: true, living: 1 });
  check({ energy: 10, hp: 20, monsters: true, hunt: false, living: 2 });
  check({ energy: 100, hp: 40, monsters: false, hunt: false, living: 3 });
});

test('旧存档只迁移期初余额；重启取消旧采集并保留库存、额度、工具、外观和冷却', () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-economy-')), dbPath = join(directory, 'world.sqlite');
  let now = 1000000, world;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); const agent = world.createAgent({ name: '旧旅人' }), controller = world.createController(agent.agent_id);
    const a = world.agent(agent.agent_id); a.position = { x: 11, y: 8 }; a.adventure.gold = 21;
    a.life.inventory = { wood: 8, ore: 9, wheat_seed: 1 }; a.life.tools.hoe.level = 2; a.life.tools.hoe.max_durability = 40; a.life.tools.hoe.durability = 7;
    delete a.life.ledger; delete a.life.market; const appearance = structuredClone(a.appearance); world.close();
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); const old = world.agent(agent.agent_id);
    assert.equal(old.life.ledger.entries.length, 1); assert.equal(old.life.ledger.entries[0].reason, 'opening_balance'); assert.equal(old.life.ledger.entries[0].balances.gold, 21);
    assert.deepEqual(old.life.inventory, { wood: 8, ore: 9, wheat_seed: 1 }); assert.deepEqual(old.appearance, appearance); assert.equal(old.life.tools.hoe.durability, 7);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id }); const auth = world.authenticate(controller.token), obs = world.callTool(auth, 'join_world');
    world.callTool(auth, 'act', { run_id: obs.run_id, session_epoch: obs.session_epoch, action_id: obs.next_action_id, type: 'trade', payload: { intent: 'buy', item_id: 'turnip_seed', quantity: 1 } });
    const observed = world.observation(old);
    world.callTool(auth, 'act', { run_id: observed.run_id, session_epoch: observed.session_epoch, action_id: observed.next_action_id, type: 'gather', payload: { intent: 'start', resource_id: 'wood' } });
    const ready = old.life.gather_ready_at.wood, entries = old.life.ledger.total_entries; world.close(); now += 2000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); const restored = world.agent(agent.agent_id);
    assert.equal(restored.life.gathering, null); assert.equal(restored.life.inventory.wood, 8); assert.equal(restored.life.gather_ready_at.wood, ready);
    assert.equal(restored.life.ledger.total_entries, entries); assert.equal(restored.life.ledger.entries.filter(entry => entry.reason === 'opening_balance').length, 1);
    assert.equal(publicLife(restored, now, { privateInventory: true }).market.buy_remaining, 19);
    const stable = structuredClone(restored.life); initializeLife(restored); initializeLife(restored); assert.deepEqual(restored.life, stable);
  } finally { world?.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); }
});
