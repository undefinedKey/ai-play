import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { World } from '../server/world.js';
import { createApp } from '../server/index.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { LIFE_RULES, initializeLife, publicLife, equipmentStats, grantMonsterLoot } from '../server/life.js';

function fixture(t) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }), people = [];
  t.after(() => world.close());
  const make = (name = '田野 AI', owner = 'owner_a') => {
    const agent = world.createAgent({ name, owner_id: owner }), controller = world.createController(agent.agent_id);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 15 });
    const auth = world.authenticate(controller.token), o = world.callTool(auth, 'join_world');
    const p = { agent, controller, auth, session: { run_id: o.run_id, session_epoch: o.session_epoch } }; people.push(p);
    const moved = world.callTool(auth, 'act', { ...p.session, action_id: o.next_action_id, type: 'move', payload: { x: 11, y: 8 } });
    assert.equal(moved.status, 'applied'); return p;
  };
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload = {}) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload = {}) => world.callTool(p.auth, 'act', request(p, type, payload));
  const farm = (p, intent, plot_id = 'plot_1', crop_id) => act(p, 'farm', { intent, plot_id, ...(crop_id ? { crop_id } : {}) });
  const inventory = (p, intent, item_id) => act(p, 'inventory', { intent, item_id });
  const raw = p => world.agent(p.agent.agent_id);
  const advance = (ms, connected = people) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 1000); world.tick();
      for (const p of connected) if (raw(p).status === 'active') observe(p);
    }
  };
  return { world, make, observe, request, act, farm, inventory, raw, advance, now: () => now };
}

test('新旧角色初始物资只发一次，已有合法物品不覆盖，非法数量与幽灵装备不生效', () => {
  const a = { adventure: { level: 1 }, life: { inventory: { wood: 7, ore: 9, turnip: -2, wheat: 1.5, wooden_sword: Infinity }, equipment: { weapon: 'wooden_sword', armor: 'iron_armor' } } };
  initializeLife(a); assert.equal(a.life.inventory.wood, 10); assert.equal(a.life.inventory.ore, 9);
  assert.equal(a.life.inventory.turnip_seed, 3); assert.equal(a.life.inventory.wheat_seed, 3);
  assert.equal(a.life.inventory.turnip, undefined); assert.equal(a.life.inventory.wheat, undefined);
  assert.deepEqual(a.life.equipment, { weapon: null, armor: null }); assert.deepEqual(equipmentStats(a), { attack_bonus: 0, defense: 0 });
  const before = structuredClone(a.life); initializeLife(a); assert.deepEqual(a.life, before);
  assert.deepEqual(grantMonsterLoot(a, '__proto__'), []); assert.deepEqual(grantMonsterLoot(a, 'constructor'), []);
});

test('规则和自己的观察发现农田/仓库；旁观、邻居和其他主人看不到仓库', t => {
  const f = fixture(t), a = f.make('甲', 'owner_a'), b = f.make('乙', 'owner_b');
  const rules = f.world.getRules(); assert.ok(rules.allowed_actions.includes('farm')); assert.ok(rules.allowed_actions.includes('inventory'));
  assert.equal(rules.life.plots_per_agent, 2); assert.deepEqual(rules.life.farm_place.service_center, { x: 11, y: 8 });
  assert.deepEqual(f.observe(a).self.life.inventory, { turnip_seed: 3, wheat_seed: 3, wood: 3 });
  f.raw(a).life.inventory.PRIVATE_ITEM = 123; f.raw(a).life.token = 'PRIVATE_TOKEN';
  f.raw(a).life.plots[0].owner_secret = 'PRIVATE_OWNER';
  assert.equal(f.observe(b).nearby_agents.find(p => p.agent_id === a.agent.agent_id).life.inventory, undefined);
  const owner = f.world.snapshotFor({ id: 'owner_a' });
  assert.ok(owner.agents.find(p => p.agent_id === a.agent.agent_id).life.inventory);
  assert.equal(owner.agents.find(p => p.agent_id === b.agent.agent_id).life.inventory, undefined);
  const spectator = spectatorSnapshot(f.world);
  assert.equal(spectator.agents[0].life.inventory, undefined); assert.doesNotMatch(JSON.stringify(spectator), /PRIVATE_|starter_granted|ready_notified/);
  const own = publicLife(f.raw(a), f.now(), { privateInventory: true }); assert.equal(own.inventory.PRIVATE_ITEM, undefined);
  rules.life.crops[0].grow_seconds = 1; own.plots[0].crop_id = 'hacked';
  assert.equal(f.world.getRules().life.crops[0].grow_seconds, 120); assert.equal(f.raw(a).life.plots[0].crop_id, null);
});

test('种植—浇水—成熟—收获真实循环；成熟不自动奖励且动作重放不重复扣发物品', t => {
  const f = fixture(t), p = f.make();
  assert.equal(f.farm(p, 'till').status, 'applied');
  const planting = f.request(p, 'farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' });
  const planted = f.world.callTool(p.auth, 'act', planting); assert.equal(planted.status, 'applied');
  assert.deepEqual(f.world.callTool(p.auth, 'act', planting), planted); assert.equal(f.observe(p).self.life.inventory.turnip_seed, 2);
  f.advance(180000); assert.equal(f.observe(p).self.life.plots[0].ready, false);
  assert.equal(f.farm(p, 'harvest').error.code, 'CROP_NOT_READY');
  const water = f.request(p, 'farm', { intent: 'water', plot_id: 'plot_1' }); const watered = f.world.callTool(p.auth, 'act', water);
  assert.equal(watered.status, 'applied'); const readyAt = f.observe(p).self.life.plots[0].ready_at;
  assert.deepEqual(f.world.callTool(p.auth, 'act', water), watered); assert.equal(f.farm(p, 'water').error.code, 'ALREADY_WATERED');
  f.advance(119000); assert.equal(f.observe(p).self.life.plots[0].ready, false); assert.equal(f.farm(p, 'harvest').error.code, 'CROP_NOT_READY');
  f.advance(1000); assert.equal(f.observe(p).self.life.plots[0].ready, true); assert.equal(f.now(), readyAt);
  assert.equal(f.observe(p).self.life.inventory.turnip, undefined);
  f.advance(10000); assert.equal(f.world.state.events.filter(e => e.type === 'life_ready').length, 1);
  const harvest = f.request(p, 'farm', { intent: 'harvest', plot_id: 'plot_1' }); const harvested = f.world.callTool(p.auth, 'act', harvest);
  assert.equal(harvested.status, 'applied'); assert.deepEqual(f.world.callTool(p.auth, 'act', harvest), harvested);
  assert.equal(f.observe(p).self.life.inventory.turnip, 2); assert.equal(f.observe(p).self.life.inventory.turnip_seed, 3); assert.equal(f.observe(p).self.life.plots[0].crop_id, null);
  assert.equal(f.farm(p, 'harvest').error.code, 'PLOT_EMPTY'); assert.equal(f.observe(p).self.life.inventory.turnip, 2);
});

test('两块田与两种作物独立计时，暂停/离线仍成熟但不会自动收获', t => {
  const f = fixture(t), p = f.make();
  f.farm(p, 'till', 'plot_1'); f.farm(p, 'till', 'plot_2');
  f.farm(p, 'plant', 'plot_1', 'turnip'); f.farm(p, 'water', 'plot_1');
  f.farm(p, 'plant', 'plot_2', 'wheat'); f.farm(p, 'water', 'plot_2');
  f.world.ownerControl(p.agent.agent_id, 'pause'); f.advance(120000, []);
  assert.equal(publicLife(f.raw(p), f.now()).plots[0].ready, true); assert.equal(publicLife(f.raw(p), f.now()).plots[1].ready, false);
  f.advance(60000, []); assert.equal(publicLife(f.raw(p), f.now()).plots[1].ready, true);
  assert.equal(f.raw(p).life.inventory.turnip, undefined); assert.equal(f.raw(p).life.inventory.wheat, undefined);
  assert.equal(f.world.state.events.filter(e => e.type === 'life_ready').length, 2);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...p.session, action_id: 'stale', type: 'farm', payload: { intent: 'harvest', plot_id: 'plot_1' } }), { code: 'STALE_SESSION' });
  f.world.ownerControl(p.agent.agent_id, 'resume'); const o = f.world.callTool(p.auth, 'join_world'); p.session = { run_id: o.run_id, session_epoch: o.session_epoch };
  assert.equal(f.farm(p, 'harvest', 'plot_2').status, 'applied'); assert.equal(f.observe(p).self.life.inventory.wheat, 2);
});

test('只能操作自己的田和仓库，不能通过附加主人/数量/装备字段越权', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙', 'owner_b');
  f.farm(a, 'till'); f.farm(b, 'till');
  f.farm(a, 'plant', 'plot_1', 'turnip');
  for (const payload of [
    { intent: 'plant', plot_id: `${a.agent.agent_id}:plot_1`, crop_id: 'turnip' },
    { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip', agent_id: a.agent.agent_id },
    { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip', quantity: -1 },
    { intent: 'water', plot_id: 'plot_1', crop_id: 'turnip' },
  ]) assert.equal(f.act(b, 'farm', payload).status, 'rejected');
  assert.equal(f.raw(b).life.plots[0].crop_id, null); assert.equal(f.raw(a).life.plots[0].crop_id, 'turnip');
  const req = f.request(a, 'farm', { intent: 'water', plot_id: 'plot_1' }); assert.throws(() => f.world.callTool(b.auth, 'act', req), { code: 'STALE_SESSION' });
  for (const payload of [{ intent: 'craft', item_id: 'wooden_sword', quantity: -3 }, { intent: 'equip', item_id: 'iron_sword', owner_id: a.agent.agent_id }, { intent: 'unequip', slot: 'weapon', item_id: 'iron_sword' }, { intent: 'unequip', slot: 'body' }]) assert.equal(f.act(b, 'inventory', payload).status, 'rejected');
  assert.equal(f.farm(b, 'plant', 'plot_1', 'wheat').status, 'applied'); assert.equal(f.raw(a).life.plots[0].crop_id, 'turnip');
});

test('农田/制作/换装要求营地和空闲，失败不消耗材料', t => {
  const f = fixture(t), p = f.make(); f.act(p, 'move', { x: 14, y: 8 });
  assert.equal(f.farm(p, 'plant', 'plot_1', 'turnip').error.code, 'NOT_AT_CAMP');
  assert.equal(f.inventory(p, 'craft', 'wooden_sword').error.code, 'NOT_AT_CAMP');
  f.act(p, 'move', { x: 11, y: 8 }); f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'forest' });
  assert.equal(f.farm(p, 'plant', 'plot_1', 'turnip').error.code, 'ACTIVITY_BUSY');
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.act(p, 'start_activity', { activity_id: 'relax' });
  assert.equal(f.inventory(p, 'craft', 'wooden_sword').error.code, 'ACTIVITY_BUSY');
  f.act(p, 'finish_activity'); const group = f.act(p, 'create_group').group_id, game = f.act(p, 'propose_game', { group_id: group }).game_id;
  assert.equal(f.farm(p, 'plant', 'plot_1', 'turnip').error.code, 'GAME_BUSY');
  f.act(p, 'leave_game', { game_id: game });
  assert.equal(f.observe(p).self.life.inventory.wood, 3); assert.equal(f.observe(p).self.life.inventory.turnip_seed, 3);
  assert.equal(f.inventory(p, 'craft', 'wooden_sword').status, 'applied');
});

test('制作消耗真实材料，装备须持有且不消耗/叠加，卸下恢复属性', t => {
  const f = fixture(t), p = f.make();
  const craft = f.request(p, 'inventory', { intent: 'craft', item_id: 'wooden_sword' }); const crafted = f.world.callTool(p.auth, 'act', craft);
  assert.equal(crafted.status, 'applied'); assert.deepEqual(f.world.callTool(p.auth, 'act', craft), crafted);
  assert.equal(f.observe(p).self.life.inventory.wood, undefined); assert.equal(f.observe(p).self.life.inventory.wooden_sword, 1);
  assert.equal(f.inventory(p, 'equip', 'iron_sword').error.code, 'INSUFFICIENT_ITEMS');
  assert.equal(f.inventory(p, 'equip', 'wooden_sword').status, 'applied'); assert.equal(f.observe(p).self.life.stats.attack, 8);
  assert.equal(f.inventory(p, 'equip', 'wooden_sword').error.code, 'ALREADY_EQUIPPED'); assert.equal(f.observe(p).self.life.stats.attack, 8);
  assert.equal(f.observe(p).self.life.inventory.wooden_sword, 1);
  assert.equal(f.act(p, 'inventory', { intent: 'unequip', slot: 'weapon' }).status, 'applied'); assert.equal(f.observe(p).self.life.stats.attack, 6);
  const before = f.observe(p).self.life.inventory; assert.equal(f.inventory(p, 'craft', 'iron_sword').error.code, 'INSUFFICIENT_ITEMS'); assert.deepEqual(f.observe(p).self.life.inventory, before);
});

test('铁剑铁甲材料门槛与属性真实生效，仓库数量上限不溢出或产生负数', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p);
  for (let i = 0; i < 4; i++) grantMonsterLoot(a, 'ruins_guardian');
  assert.equal(a.life.inventory.ore, 8);
  assert.equal(f.inventory(p, 'craft', 'iron_sword').status, 'applied'); assert.equal(f.inventory(p, 'craft', 'iron_armor').status, 'applied');
  assert.equal(f.inventory(p, 'equip', 'iron_sword').status, 'applied'); assert.equal(f.inventory(p, 'equip', 'iron_armor').status, 'applied');
  assert.deepEqual(f.observe(p).self.life.stats, { attack_bonus: 5, defense: 3, attack: 11, effective_attack: 11, attack_multiplier: 1, range: 1, attack_interval_ms: 1000, attack_energy: 3, move_energy_per_tile: 0.15 }); assert.equal(f.observe(p).self.life.inventory.ore, undefined);
  f.raw(p).life.inventory.wooden_sword = Number.MAX_SAFE_INTEGER; f.raw(p).life.inventory.wood = 3;
  const before = f.observe(p).self.life.inventory;
  assert.equal(f.inventory(p, 'craft', 'wooden_sword').error.code, 'INVENTORY_FULL'); assert.deepEqual(f.observe(p).self.life.inventory, before);
});

test('食物可在野外使用但不结束计划、不退出危险、不刷新反应保护，满血不消耗', t => {
  const f = fixture(t), p = f.make(); f.farm(p, 'till'); f.farm(p, 'plant', 'plot_1', 'turnip'); f.farm(p, 'water'); f.advance(120000); f.farm(p, 'harvest');
  assert.equal(f.inventory(p, 'use', 'turnip').error.code, 'FULL_HEALTH'); assert.equal(f.observe(p).self.life.inventory.turnip, 2);
  f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'forest' });
  const a = f.raw(p); a.scene_id = 'adventure'; a.position = { x: 4, y: 11 }; a.adventure.in_field = true; a.adventure.hp = 8; a.adventure.decision_until = f.now() + 30000;
  const until = a.adventure.decision_until, plan = structuredClone(a.adventure.plan);
  assert.equal(f.inventory(p, 'use', 'turnip').status, 'applied'); assert.equal(f.raw(p).adventure.hp, 20);
  assert.equal(f.raw(p).adventure.in_field, true); assert.equal(f.raw(p).adventure.decision_until, until); assert.deepEqual(f.raw(p).adventure.plan, plan);
  assert.equal(f.observe(p).self.life.inventory.turnip, 1); assert.equal(f.inventory(p, 'use', 'wood').error.code, 'INVALID_ACTION');
});

test('武器与护甲实际影响战斗，防御不会让伤害降到0', t => {
  const f = fixture(t), p = f.make(); f.inventory(p, 'craft', 'wooden_sword'); f.inventory(p, 'equip', 'wooden_sword');
  for (let i = 0; i < 3; i++) grantMonsterLoot(f.raw(p), 'forest_slime');
  f.inventory(p, 'craft', 'wooden_shield'); f.inventory(p, 'equip', 'wooden_shield');
  f.raw(p).scene_id = 'adventure'; f.raw(p).position = { x: 19, y: 7 }; f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: 'ruins_guardian' }); f.advance(1000);
  assert.equal(f.world.state.adventure.monsters[2].hp, 62); assert.equal(f.raw(p).adventure.hp, 33);
  const hits = f.world.state.events.filter(e => e.type === 'adventure_combat'); assert.ok(hits.some(e => e.payload.attacker === 'agent' && e.payload.damage === 8)); assert.ok(hits.some(e => e.payload.attacker === 'monster' && e.payload.damage === 7));
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.raw(p).scene_id = 'plaza'; f.raw(p).position = { x: 11, y: 8 }; f.raw(p).adventure.in_field = false;
  for (let i = 0; i < 3; i++) grantMonsterLoot(f.raw(p), 'ruins_guardian');
  f.inventory(p, 'craft', 'iron_armor'); f.inventory(p, 'equip', 'iron_armor');
  f.raw(p).adventure.hp = 40;
  const slime = f.world.state.adventure.monsters[0]; f.raw(p).scene_id = 'adventure'; f.raw(p).position = { x: slime.position.x, y: slime.position.y - 1 };
  f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }); f.advance(1000);
  assert.equal(f.raw(p).adventure.hp, 39); assert.ok(f.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.attacker === 'monster' && e.payload.monster_id === 'forest_slime' && e.payload.damage === 1));
});

test('真实击败怪物只给合格贡献者一份材料，旧动作重放和旁观不重复发奖', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙', 'owner_b');
  const req = f.request(a, 'adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }); const started = f.world.callTool(a.auth, 'act', req);
  f.advance(25000);
  assert.equal(f.observe(a).self.life.inventory.wood, 4); assert.equal(f.observe(b).self.life.inventory.wood, 3);
  assert.deepEqual(f.world.callTool(a.auth, 'act', req), started); spectatorSnapshot(f.world); f.advance(5000);
  assert.equal(f.observe(a).self.life.inventory.wood, 4);
  const loot = f.world.state.events.filter(e => e.type === 'adventure_loot' && e.payload.agent_id === a.agent.agent_id);
  assert.equal(loot.length, 1); assert.deepEqual(loot[0].payload.materials, [{ item_id: 'wood', quantity: 1 }]);
  const saved = JSON.parse(f.world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload);
  assert.equal(saved.agents[a.agent.agent_id].life.inventory.wood, 4); assert.equal(saved.adventure.monsters[0].status, 'respawning');
});

test('重启保留种子/装备/成长，离线成熟通知只发一次且不重复收获奖励', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-life-')), dbPath = join(directory, 'world.sqlite'); let world, now = 1000000;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const a = world.createAgent({ name: '我的旧 AI' }), c = world.createController(a.agent_id); world.ownerControl(a.agent_id, 'start');
    const auth = world.authenticate(c.token); let o = world.callTool(auth, 'join_world');
    const act = (type, payload) => { o = world.callTool(auth, 'observe', { run_id: o.run_id, session_epoch: o.session_epoch }); return world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }); };
    act('move', { x: 11, y: 8 }); act('inventory', { intent: 'craft', item_id: 'wooden_sword' }); act('inventory', { intent: 'equip', item_id: 'wooden_sword' });
    act('farm', { intent: 'till', plot_id: 'plot_1' }); act('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }); act('farm', { intent: 'water', plot_id: 'plot_1' });
    world.close(); world = undefined; now += 180000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); world.tick(); world.tick();
    assert.equal(world.agent(a.agent_id).life.inventory.turnip_seed, 2); assert.equal(world.agent(a.agent_id).life.inventory.turnip, undefined);
    assert.equal(world.agent(a.agent_id).life.inventory.wood, 0); assert.equal(world.agent(a.agent_id).life.equipment.weapon, 'wooden_sword');
    assert.equal(world.state.events.filter(e => e.type === 'life_ready').length, 1);
    o = world.callTool(auth, 'join_world'); assert.equal(act('farm', { intent: 'harvest', plot_id: 'plot_1' }).status, 'applied');
    world.close(); world = undefined; now += 1000;
    world = new World({ dbPath, now: () => now }); world.tick();
    assert.equal(world.agent(a.agent_id).life.inventory.turnip, 2); assert.equal(world.agent(a.agent_id).life.inventory.turnip_seed, 3); assert.equal(world.agent(a.agent_id).life.inventory.wood, 0);
    assert.equal(world.state.events.filter(e => e.type === 'life_ready').length, 1); assert.equal(world.authenticate(c.token).agent_id, a.agent_id);
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('真实HTTP MCP公开生活动作，私有仓库只在本人回应中，匿名旁观只能看农田装备', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false, seed: false, demo: false }); app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), a = app.world.createAgent({ name: '种田 AI' }), controller = app.world.createController(a.agent_id);
  app.world.ownerControl(a.agent_id, 'start'); const client = new Client({ name: 'life-test', version: '0.9.0' });
  t.after(async () => { await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); };
  const types = (await client.listTools()).tools.find(tool => tool.name === 'act').inputSchema.properties.type.enum;
  assert.ok(types.includes('farm') && types.includes('inventory'));
  const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const move = await call('act', { ...session, action_id: joined.next_action_id, type: 'move', payload: { x: 11, y: 8 } });
  const till = await call('act', { ...session, action_id: move.next_action_id, type: 'farm', payload: { intent: 'till', plot_id: 'plot_1' } });
  const plant = await call('act', { ...session, action_id: till.next_action_id, type: 'farm', payload: { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' } });
  assert.equal(plant.status, 'applied'); assert.equal(plant.life.inventory.turnip_seed, 2);
  const publicState = await (await fetch(`${url}/api/public/world`)).json();
  assert.equal(publicState.agents[0].life.plots[0].crop_id, 'turnip'); assert.equal(publicState.agents[0].life.inventory, undefined);
  assert.equal(publicState.life.crops.length, 2); assert.doesNotMatch(JSON.stringify(publicState), /starter_granted|ready_notified|token_hash/);
});
