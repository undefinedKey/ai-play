import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { World } from '../server/world.js';
import { createApp } from '../server/index.js';
import { LIFE_RULES, initializeLife, publicLife } from '../server/life.js';
import { spectatorSnapshot } from '../server/spectator.js';

const FARM_TOOLS = LIFE_RULES.tools.filter(tool => ['hoe', 'watering_can'].includes(tool.id));

function fixture(t, options = {}) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options });
  t.after(() => world.close());
  const make = (name = '农田 AI', owner_id = 'owner-a') => {
    const a = world.createAgent({ name, owner_id }), controller = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 15 });
    const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world');
    world.agent(a.agent_id).position = { x: 11, y: 8 };
    return { id: a.agent_id, auth, controller, session: { run_id: joined.run_id, session_epoch: joined.session_epoch } };
  };
  const raw = p => world.agent(p.id);
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const farm = (p, intent, plot_id = 'plot_1', crop_id) => act(p, 'farm', { intent, plot_id, ...(crop_id ? { crop_id } : {}) });
  const inventory = (p, intent, item_id) => act(p, 'inventory', { intent, item_id });
  return { world, make, raw, observe, request, act, farm, inventory, now: () => now, advance: ms => { now += ms; world.tick(); } };
}
const applied = result => { assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };
const snapshot = a => structuredClone({ life: a.life, fatigue: a.fatigue });

test('工具目录公布各级消耗；新旧角色只迁移一次，不补耐久且旧作物计时不变', () => {
  const a = { life: { starter_granted: true, inventory: { wood: 8 }, plots: [{ plot_id: 'plot_1', crop_id: 'turnip', planted_at: 100, watered_at: 200, ready_at: 120200, ready_notified: true }] } };
  initializeLife(a);
  assert.deepEqual(a.life.tools, {
    hoe: { level: 1, durability: 20, max_durability: 20 }, watering_can: { level: 1, durability: 20, max_durability: 20 },
    axe: { level: 1, durability: 0, max_durability: 12, owned: false }, pickaxe: { level: 1, durability: 0, max_durability: 12, owned: false },
  });
  assert.deepEqual(a.life.plots[0], { plot_id: 'plot_1', tilled: true, tilled_at: 100, crop_id: 'turnip', planted_at: 100, watered_at: 200, ready_at: 120200, ready_notified: true });
  assert.equal(a.life.plots[1].tilled, false);
  a.life.tools.hoe.durability = 0; a.life.tools.watering_can = { level: 2, durability: 7, max_durability: 999, private_note: 'PRIVATE' };
  initializeLife(a); const saved = structuredClone(a.life); initializeLife(a); assert.deepEqual(a.life, saved);
  assert.deepEqual(a.life.tools.hoe, { level: 1, durability: 0, max_durability: 20 });
  assert.deepEqual(a.life.tools.watering_can, { level: 2, durability: 7, max_durability: 40 });
  delete a.life.tools.hoe; initializeLife(a); assert.equal(a.life.tools.hoe.durability, 0, '已迁移后缺失槽不能再次领满耐久');
  for (const tool of FARM_TOOLS) {
    assert.deepEqual(tool.levels.map(level => level.max_durability), [20, 40, 60]);
    assert.deepEqual(tool.levels.map(level => level.energy_cost), tool.id === 'hoe' ? [3, 2, 1] : [1, .75, .5]);
    assert.deepEqual(tool.levels[1].upgrade_cost, { wood: 3, ore: 2 }); assert.deepEqual(tool.levels[2].upgrade_cost, { wood: 5, ore: 4 });
  }
});

test('真实开垦—种植—浇水—收获闭环，收获后必须再次开垦，重试不重复扣工具', t => {
  const f = fixture(t), p = f.make();
  assert.equal(f.farm(p, 'plant', 'plot_1', 'turnip').error.code, 'PLOT_NOT_TILLED');
  assert.equal(f.raw(p).fatigue.energy, 100); assert.equal(f.raw(p).life.inventory.turnip_seed, 3);
  const request = f.request(p, 'farm', { intent: 'till', plot_id: 'plot_1' }), result = applied(f.world.callTool(p.auth, 'act', request));
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), result);
  assert.equal(f.raw(p).life.tools.hoe.durability, 19); assert.equal(f.raw(p).fatigue.energy, 97);
  assert.equal(f.raw(p).life.plots[0].tilled_at, f.now());
  const before = snapshot(f.raw(p)); assert.equal(f.farm(p, 'till').error.code, 'ALREADY_TILLED'); assert.deepEqual(snapshot(f.raw(p)), before);
  applied(f.farm(p, 'plant', 'plot_1', 'turnip'));
  const waterRequest = f.request(p, 'farm', { intent: 'water', plot_id: 'plot_1' }), watered = applied(f.world.callTool(p.auth, 'act', waterRequest));
  assert.deepEqual(f.world.callTool(p.auth, 'act', waterRequest), watered);
  assert.equal(f.raw(p).life.tools.watering_can.durability, 19); assert.equal(f.raw(p).fatigue.energy, 94);
  const planting = snapshot(f.raw(p)); assert.equal(f.farm(p, 'till').error.code, 'PLOT_OCCUPIED'); assert.equal(f.farm(p, 'water').error.code, 'ALREADY_WATERED'); assert.deepEqual(snapshot(f.raw(p)), planting);
  f.raw(p).life.plots[0].ready_at = f.now(); applied(f.farm(p, 'harvest'));
  assert.equal(f.raw(p).life.plots[0].tilled, false); assert.equal(f.raw(p).life.plots[0].tilled_at, null);
  assert.equal(f.raw(p).life.inventory.turnip, 2); assert.equal(f.raw(p).fatigue.energy, 92);
  assert.equal(f.farm(p, 'plant', 'plot_1', 'turnip').error.code, 'PLOT_NOT_TILLED'); applied(f.farm(p, 'till'));
  assert.equal(f.raw(p).life.tools.hoe.durability, 18);
});

test('坏工具拒绝对应动作；维修扣当前等级材料且回满，重复和满耐久维修不扣费', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.tools.hoe.durability = 0;
  const broken = snapshot(f.raw(p)); assert.equal(f.farm(p, 'till').error.code, 'TOOL_BROKEN'); assert.deepEqual(snapshot(f.raw(p)), broken);
  const request = f.request(p, 'inventory', { intent: 'repair', item_id: 'hoe' }), result = applied(f.world.callTool(p.auth, 'act', request));
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), result); assert.equal(f.raw(p).life.inventory.wood, 2);
  assert.equal(f.raw(p).fatigue.energy, 98); assert.equal(f.raw(p).life.tools.hoe.durability, 20);
  const full = snapshot(f.raw(p)); assert.equal(f.inventory(p, 'repair', 'hoe').error.code, 'TOOL_FULL'); assert.deepEqual(snapshot(f.raw(p)), full);
  applied(f.farm(p, 'till')); applied(f.farm(p, 'plant', 'plot_1', 'wheat')); f.raw(p).life.tools.watering_can.durability = 0;
  const dry = snapshot(f.raw(p)); assert.equal(f.farm(p, 'water').error.code, 'TOOL_BROKEN'); assert.deepEqual(snapshot(f.raw(p)), dry);
  applied(f.inventory(p, 'repair', 'watering_can')); applied(f.farm(p, 'water')); assert.equal(f.raw(p).life.tools.watering_can.durability, 19);
});

test('升级逐级扣下一等级配方并回满，等级3封顶，材料不足和体力不足均原子回滚', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.inventory.wood = 20; f.raw(p).life.inventory.ore = 20;
  for (const id of ['hoe', 'watering_can']) {
    for (const target of [2, 3]) {
      const before = snapshot(f.raw(p)), rule = LIFE_RULES.tools.find(tool => tool.id === id).levels[target - 1];
      const request = f.request(p, 'inventory', { intent: 'upgrade', item_id: id }), result = applied(f.world.callTool(p.auth, 'act', request));
      assert.deepEqual(f.world.callTool(p.auth, 'act', request), result);
      assert.deepEqual(f.raw(p).life.tools[id], { level: target, durability: rule.max_durability, max_durability: rule.max_durability });
      for (const [material, quantity] of Object.entries(rule.upgrade_cost)) assert.equal(f.raw(p).life.inventory[material], before.life.inventory[material] - quantity);
      assert.equal(f.raw(p).fatigue.energy, before.fatigue.energy - 2);
    }
    const maxed = snapshot(f.raw(p)); assert.equal(f.inventory(p, 'upgrade', id).error.code, 'TOOL_MAX_LEVEL'); assert.deepEqual(snapshot(f.raw(p)), maxed);
  }
  f.raw(p).life.tools.hoe.durability = 1; f.raw(p).life.inventory.ore = 0;
  const poor = snapshot(f.raw(p)); assert.equal(f.inventory(p, 'repair', 'hoe').error.code, 'INSUFFICIENT_ITEMS'); assert.deepEqual(snapshot(f.raw(p)), poor);
  f.raw(p).life.inventory.ore = 1; applied(f.inventory(p, 'repair', 'hoe')); assert.equal(f.raw(p).life.tools.hoe.durability, 60);
  f.raw(p).life.tools.hoe.durability = 0; f.raw(p).fatigue.energy = 1;
  const tired = snapshot(f.raw(p)); assert.equal(f.inventory(p, 'repair', 'hoe').error.code, 'FATIGUE_EXHAUSTED'); assert.deepEqual(snapshot(f.raw(p)), tired);
});

test('每级工具实际降低开垦/浇水体力，临界值执行与不足拒绝不消耗耐久', t => {
  for (const definition of FARM_TOOLS) for (const level of definition.levels) {
    const f = fixture(t), p = f.make(), id = definition.id, intent = id === 'hoe' ? 'till' : 'water';
    f.raw(p).life.tools[id] = { level: level.level, durability: 1, max_durability: level.max_durability };
    if (intent === 'water') Object.assign(f.raw(p).life.plots[0], { tilled: true, crop_id: 'turnip', planted_at: f.now() });
    f.raw(p).fatigue.energy = level.energy_cost - .01;
    const before = snapshot(f.raw(p)); assert.equal(f.farm(p, intent).error.code, 'FATIGUE_EXHAUSTED'); assert.deepEqual(snapshot(f.raw(p)), before);
    f.raw(p).fatigue.energy = level.energy_cost; applied(f.farm(p, intent));
    assert.equal(f.raw(p).fatigue.energy, 0); assert.equal(f.raw(p).life.tools[id].durability, 0);
    assert.equal(f.observe(p).self.fatigue.recent_exertion.last_kind, intent);
  }
});

test('农具不可复制或放入战斗装备槽，跨主人和注入等级/耐久字段均拒绝', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙', 'owner-b');
  for (const id of ['hoe', 'watering_can']) for (const intent of ['craft', 'equip', 'use']) {
    assert.equal(f.inventory(a, intent, id).error.code, 'INVALID_ACTION');
  }
  for (const [type, payload] of [
    ['farm', { intent: 'till', plot_id: `${b.id}:plot_1` }],
    ['farm', { intent: 'till', plot_id: 'plot_1', owner_id: 'owner-b' }],
    ['farm', { intent: 'till', plot_id: 'plot_1', crop_id: 'turnip' }],
    ['inventory', { intent: 'upgrade', item_id: 'hoe', level: 3 }],
    ['inventory', { intent: 'repair', item_id: 'watering_can', durability: 60 }],
    ['inventory', { intent: 'repair', item_id: 'hoe', slot: 'weapon' }],
    ['inventory', { intent: 'upgrade', item_id: '__proto__' }],
  ]) assert.equal(f.act(a, type, payload).status, 'rejected');
  assert.equal(f.raw(a).fatigue.energy, 100); assert.equal(f.raw(b).life.plots[0].tilled, false);
  assert.deepEqual(f.raw(a).life.equipment, { weapon: null, armor: null });
  const req = f.request(a, 'farm', { intent: 'till', plot_id: 'plot_1' }); assert.throws(() => f.world.callTool(b.auth, 'act', req), { code: 'STALE_SESSION' });
});

test('开垦和维护只允许营地空闲，野外/活动/多人游戏拒绝且保留所有资源', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.tools.hoe.durability = 1;
  const rejected = code => {
    const before = snapshot(f.raw(p));
    assert.equal(f.farm(p, 'till').error.code, code); assert.equal(f.inventory(p, 'repair', 'hoe').error.code, code);
    assert.deepEqual(snapshot(f.raw(p)), before);
  };
  f.raw(p).position = { x: 14, y: 8 }; rejected('NOT_AT_CAMP'); f.raw(p).position = { x: 11, y: 8 };
  applied(f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); rejected('ACTIVITY_BUSY');
  applied(f.act(p, 'adventure_plan', { intent: 'stop' })); applied(f.act(p, 'start_activity', { activity_id: 'relax' })); rejected('ACTIVITY_BUSY');
  applied(f.act(p, 'finish_activity', {})); const group = applied(f.act(p, 'create_group', {})).group_id;
  applied(f.act(p, 'propose_game', { group_id: group })); rejected('GAME_BUSY');
});

test('机会目录按工具/田地/体力过滤，最多六项且保留探索，每个候选均可真实执行', t => {
  const f = fixture(t), p = f.make();
  for (const level of [1, 2, 3]) for (const durability of [0, 1]) for (const energy of [0, .49, .5, .74, .75, .99, 1, 1.99, 2, 2.99, 3, 100]) for (const phase of ['empty', 'tilled', 'dry', 'ready']) {
    for (const tool of FARM_TOOLS) f.raw(p).life.tools[tool.id] = { level, durability, max_durability: level * 20 };
    f.raw(p).life.inventory.wood = 20; f.raw(p).life.inventory.ore = 20; f.raw(p).fatigue.energy = energy;
    for (const plot of f.raw(p).life.plots) Object.assign(plot, { tilled: phase !== 'empty', tilled_at: phase !== 'empty' ? f.now() : null, crop_id: ['dry', 'ready'].includes(phase) ? 'turnip' : null, planted_at: null, watered_at: phase === 'ready' ? f.now() : null, ready_at: phase === 'ready' ? f.now() : null, ready_notified: phase === 'ready' });
    const o = f.observe(p), saved = structuredClone(f.world.state);
    assert.ok(o.opportunities.length <= 6); assert.ok(o.opportunities.some(option => option.action.payload.intent === 'explore'));
    for (const candidate of o.opportunities) {
      f.world.state = structuredClone(saved);
      const result = f.world.callTool(p.auth, 'act', { ...p.session, action_id: o.next_action_id, ...candidate.action });
      assert.equal(result.status, 'applied', `${level}/${durability}/${energy}/${phase}/${candidate.id}: ${JSON.stringify(result.error)}`);
    }
    f.world.state = saved;
  }
});

test('工具等级、耐久、开垦状态跨重启和重连持久，不因迁移或重复入场补发', () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-tools-')), dbPath = join(directory, 'world.sqlite'); let world;
  try {
    world = new World({ dbPath }); const a = world.createAgent({ name: '旧农夫' }), controller = world.createController(a.agent_id);
    world.agent(a.agent_id).life.tools.hoe = { level: 3, durability: 0, max_durability: 60 };
    world.agent(a.agent_id).life.plots[0].tilled = true; world.agent(a.agent_id).life.plots[0].tilled_at = 123;
    world.close(); world = new World({ dbPath });
    world.ownerControl(a.agent_id, 'start'); const auth = world.authenticate(controller.token);
    for (let i = 0; i < 3; i++) {
      const joined = world.callTool(auth, 'join_world'); assert.deepEqual(joined.self.life.tools.hoe, { level: 3, durability: 0, max_durability: 60 });
      assert.equal(joined.self.life.plots[0].tilled_at, 123);
    }
  } finally { world?.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); }
});

test('农具和开垦状态公开，仓库材料与任意嵌套秘密继续私有', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙', 'owner-b');
  applied(f.farm(a, 'till')); applied(f.inventory(a, 'repair', 'hoe'));
  f.raw(a).life.inventory.wood = 3; f.raw(a).life.inventory.ore = 2; applied(f.inventory(a, 'upgrade', 'hoe'));
  f.raw(a).life.tools.hoe.private_note = 'PRIVATE_TOOL'; f.raw(a).life.tools.evil = { private_note: 'PRIVATE_TOOL' };
  f.raw(a).life.plots[0].secret = 'PRIVATE_PLOT'; f.raw(a).life.tools_granted_secret = 'PRIVATE';
  const pub = spectatorSnapshot(f.world), agent = pub.agents.find(p => p.agent_id === a.id);
  assert.deepEqual(agent.life.tools.hoe, { level: 2, durability: 40, max_durability: 40 }); assert.equal(agent.life.inventory, undefined);
  assert.equal(agent.life.plots[0].tilled, true); assert.doesNotMatch(JSON.stringify(pub), /PRIVATE|tools_granted/);
  for (const kind of ['life_tilled', 'life_tool_repaired', 'life_tool_upgraded']) assert.ok(pub.events.some(event => event.type === kind));
  assert.equal(f.observe(b).nearby_agents.find(p => p.agent_id === a.id).life.inventory, undefined);
  assert.ok(publicLife(f.raw(a), f.now(), { privateInventory: true }).inventory);
});

test('真实HTTP MCP支持开垦和升级，公开响应与动作回执均返回工具状态', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false, demo: false }); app.world.actionIntervalMs = 0;
  const clock = Date.now(); app.world.now = () => clock;
  const { server, url } = await app.start(0), a = app.world.createAgent({ name: '农具 MCP' }), c = app.world.createController(a.agent_id);
  app.world.ownerControl(a.agent_id, 'start'); app.world.agent(a.agent_id).position = { x: 11, y: 8 }; app.world.agent(a.agent_id).life.inventory.ore = 2;
  const client = new Client({ name: 'farm-tools-test', version: '0.11.0' });
  t.after(async () => { await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); };
  const rules = await call('get_rules'); assert.deepEqual(rules.life.tools.map(tool => tool.id), ['hoe', 'watering_can', 'axe', 'pickaxe']);
  const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const tilled = applied(await call('act', { ...session, action_id: joined.next_action_id, type: 'farm', payload: { intent: 'till', plot_id: 'plot_1' } }));
  assert.equal(tilled.life.tools.hoe.durability, 19); assert.equal(tilled.life.plots[0].tilled, true);
  const upgraded = applied(await call('act', { ...session, action_id: tilled.next_action_id, type: 'inventory', payload: { intent: 'upgrade', item_id: 'hoe' } }));
  assert.equal(upgraded.life.tools.hoe.level, 2); assert.equal(upgraded.life.tools.hoe.durability, 40);
  const pub = await (await fetch(`${url}/api/public/world`)).json(); assert.deepEqual(pub.agents[0].life.tools, upgraded.life.tools); assert.equal(pub.agents[0].life.inventory, undefined);
});
