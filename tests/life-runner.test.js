import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
const action = (type, payload = {}) => ({ type, payload });
const opportunities = [
  { id: 'explore', label: '探索森林', reason: '发现新地方', action: action('adventure_plan', { intent: 'explore', zone_id: 'forest' }) },
  { id: 'plant', label: '种萝卜', reason: '空地可种植', action: action('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }) },
  { id: 'hunt', label: '讨伐史莱姆', reason: '可以挑战', action: action('adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }) },
  { id: 'craft', label: '制作装备', reason: '材料齐全', action: action('inventory', { intent: 'craft', item_id: 'wooden_sword' }) },
  { id: 'equip', label: '穿戴装备', reason: '背包有装备', action: action('inventory', { intent: 'equip', item_id: 'wooden_sword' }) },
  { id: 'rest', label: '休息', reason: '生命未满', action: action('adventure_plan', { intent: 'rest' }) },
];

async function fixture(t, { mode = 'dsh-pet', choose = () => action('wait') } = {}) {
  let now = Date.now();
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '已有的我' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const auth = world.authenticate(controller.token), calls = [], prompts = [], contexts = [];
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; }, close: async () => {} };
  // Only the original AI's answer is substituted. World state, validation,
  // receipts, permissions, budget and runner scheduling are real.
  const reply = context => { contexts.push(context); return JSON.stringify(choose(context)); };
  const runner = new PlazaRunner({ mode, toolClient: client, now: () => now, idleMs: 30000,
    petClient: { initialize: async () => {}, decide: async input => { const prompt = decisionPrompt(input); prompts.push(prompt); return reply(decode(prompt)); } },
    model: { baseUrl: 'https://model.invalid/v1', model: 'original-ai-test-double', apiKey: 'PRIVATE_MODEL_KEY' },
    fetchImpl: async (_, options) => ({ ok: true, json: async () => ({ choices: [{ message: { content: reply(JSON.parse(JSON.parse(options.body).messages[1].content)) } }] }) }) });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = world.agent(record.agent_id);
  const refresh = () => { runner.observation = world.observation(a); runner.observedAt = now; };
  const advance = ms => { while (ms > 0) { const step = Math.min(ms, 10000); now += step; ms -= step; world.callTool(auth, 'observe', runner.session()); world.tick(); } refresh(); };
  t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, a, calls, contexts, prompts, refresh, advance, decide: async () => { advance(6000); await runner.decide(); } };
}

test('生活动作严格校验意图、地块、种子和装备槽，拒绝附加指令或互斥字段', () => {
  const valid = [action('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }), action('farm', { intent: 'water', plot_id: 'plot_2' }),
    action('farm', { intent: 'harvest', plot_id: 'plot_1' }), ...['craft', 'equip', 'use'].map(intent => action('inventory', { intent, item_id: 'bread' })),
    action('inventory', { intent: 'unequip', slot: 'weapon' })];
  for (const value of valid) assert.deepEqual(parseModelAction(JSON.stringify(value)), value);
  for (const value of [action('farm', { intent: 'plant', plot_id: 'plot_1' }), action('farm', { intent: 'plant', plot_id: 'plot_3', crop_id: 'turnip' }),
    action('farm', { intent: 'water', plot_id: 'plot_1', crop_id: 'turnip' }), action('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'money' }),
    action('inventory', { intent: 'use' }), action('inventory', { intent: 'equip', item_id: 'sword', slot: 'weapon' }),
    action('inventory', { intent: 'unequip', item_id: 'sword', slot: 'weapon' }), action('inventory', { intent: 'unequip', slot: 'head' }),
    action('inventory', { intent: 'craft', item_id: 'sword', command: 'run code' })]) assert.throws(() => parseModelAction(JSON.stringify(value)), { code: 'INVALID_MODEL_OUTPUT' });
});

test('未参与的同组游戏、可选报名与游戏结束后仍能发现冒险和生活机会', async t => {
  const f = await fixture(t);
  for (const status of ['active', 'recruiting', 'finished']) {
    const observation = { ...f.runner.observation, opportunities,
      game: { game_id: 'other-game', status, game_type: 'word_chain', participants: ['friend', 'other'], current_agent_id: 'friend', responses: {} } };
    const prompt = decisionPrompt({ observation, rules: f.world.getRules() }), data = decode(prompt);
    assert.ok(prompt.includes('无需邀请才探索'));
    assert.ok(data.opportunities.some(o => o.action.type === 'adventure_plan'));
    assert.ok(data.opportunities.some(o => o.action.type === 'farm'));
    assert.equal(data.game?.status === 'active', false);
    if (status === 'recruiting') { assert.equal(data.game.game_id, 'other-game'); assert.match(prompt, /respond_game/); }
  }
});

test('本人已加入的招募与进行中游戏保留退出入口，先退出才能自由冒险或种田', async t => {
  const f = await fixture(t);
  for (const status of ['recruiting', 'active']) {
    const observation = { ...f.runner.observation, opportunities: [],
      game: { game_id: 'own-game', status, game_type: 'word_chain', participants: [f.a.agent_id, 'friend'], current_agent_id: 'friend', responses: { [f.a.agent_id]: true }, last_word: '气球', turn_id: 'turn-1' } };
    observation.self.adventure.hp = 10; observation.self.life.inventory.turnip = 2;
    const prompt = decisionPrompt({ observation, rules: f.world.getRules() }), data = decode(prompt);
    assert.equal(data.game.game_id, 'own-game'); assert.equal(data.game.joined, true);
    assert.match(prompt, /leave_game\{game_id\}/);
    assert.equal(data.opportunities, undefined);
    assert.equal(prompt.includes('无需邀请才探索'), false);
    assert.ok(data.food.some(row => row[0] === 'turnip'));
    assert.match(prompt, /inventory\{intent:use,item_id\}/);
  }
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}入场立即有决策机会，连续wait后仍可按本人回答自主探索`, async t => {
  let answer = action('wait');
  const f = await fixture(t, { mode, choose: () => answer });
  assert.equal(f.runner.decisionDue(), true);
  await f.runner.decide();
  assert.equal(f.a.adventure.plan, null);
  f.advance(5000); assert.equal(f.runner.decisionDue(), false);
  f.advance(25000); assert.equal(f.runner.decisionDue(), true);
  await f.runner.decide();
  assert.equal(f.a.adventure.plan, null);
  answer = action('adventure_plan', { intent: 'explore', zone_id: 'forest' });
  f.advance(30000); await f.runner.decide();
  assert.equal(f.a.adventure.plan.intent, 'explore');
  assert.equal(f.runner.checkpoint.calls_used, 3);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 1, '等待不会由桥替换成系统选定的冒险');
  const reports = f.calls.filter(c => c.name === 'report_status').map(c => c.args);
  const version = JSON.parse(readFileSync(new URL('../skills/ai-plaza/version.json', import.meta.url), 'utf8')).version;
  assert.equal(reports.at(-1).runtime_version, version);
  assert.equal(reports.at(-1).mode, mode);
  assert.deepEqual(reports.at(-1).capabilities, ['adventure', 'farming', 'inventory', 'equipment', 'farm_tools', 'fatigue', 'gathering', 'cooking', 'trading', 'recovery', 'reliable_events', 'runtime_health']);
  assert.equal(reports.at(-1).last_decision_type, 'adventure_plan');
  assert.ok(reports.some(r => r.last_decision_type === 'wait'));
});

test('真实开垦、种植、浇水、成熟唤醒、收获和食用均由原AI的动作完成', async t => {
  let answer = action('farm', { intent: 'till', plot_id: 'plot_1' });
  const f = await fixture(t, { choose: () => answer });
  f.a.position = { x: 11, y: 8 }; f.refresh();
  await f.decide();
  assert.equal(f.a.life.plots[0].tilled, true);
  answer = action('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }); await f.decide();
  assert.equal(f.a.life.plots[0].crop_id, 'turnip');
  answer = action('farm', { intent: 'water', plot_id: 'plot_1' }); await f.decide();
  assert.ok(f.a.life.plots[0].watered_at);
  f.advance(Math.max(0, f.a.life.plots[0].ready_at - f.runner.now()) + 1000);
  const ready = f.world.state.events.filter(e => e.type === 'life_ready' && e.payload.agent_id === f.a.agent_id);
  assert.equal(ready.length, 1);
  f.runner.checkpoint = enqueueEvents(f.runner.checkpoint, ready, f.a.agent_id);
  assert.equal(f.runner.decisionDue(), true);
  answer = action('farm', { intent: 'harvest', plot_id: 'plot_1' }); await f.decide();
  const crop = f.world.getRules().life.crops.find(c => c.id === 'turnip');
  assert.ok(f.a.life.inventory[crop.produce_id] >= 2);
  const food = f.world.getRules().life.items.find(item => item.id === crop.produce_id);
  assert.ok(food.heal > 0);
  f.a.adventure.hp = 15;
  const before = f.a.life.inventory[food.id];
  answer = action('inventory', { intent: 'use', item_id: food.id }); await f.decide();
  assert.equal(f.a.life.inventory[food.id], before - 1);
  assert.ok(f.a.adventure.hp > 15);
  assert.equal(f.runner.checkpoint.calls_used, 5);
});

test('桌宠可直接选择服务提供的制作/装备机会，穿戴改变真实属性而非本地模拟', async t => {
  let intent = 'craft';
  const f = await fixture(t, { choose: data => data.opportunities.find(o => o.action.type === 'inventory' && o.action.payload.intent === intent)?.action || action('wait') });
  f.a.position = { x: 11, y: 8 };
  // Already-growing fields keep this scenario focused on equipment candidates.
  for (const plot of f.a.life.plots) Object.assign(plot, { tilled: true, crop_id: 'turnip', planted_at: f.runner.now(), watered_at: f.runner.now(), ready_at: f.runner.now() + 60000 });
  f.refresh();
  await f.decide();
  assert.equal(f.a.life.inventory.wooden_sword, 1);
  intent = 'equip'; await f.decide();
  assert.equal(f.a.life.equipment.weapon, 'wooden_sword');
  assert.equal(f.runner.observation.self.life.stats.attack, 8);
  assert.equal(f.runner.checkpoint.calls_used, 2);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 2);
});

test('空闲长消息与满仓装备不挤掉冒险/生活机会，缩略库存明确标示而非伪造空仓', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation);
  observation.opportunities = opportunities;
  observation.self.life.inventory = Object.fromEntries(f.world.getRules().life.items.map(item => [item.id, Number.MAX_SAFE_INTEGER]));
  observation.self.life.equipment = { weapon: 'iron_sword', armor: 'iron_armor' };
  const ownerGoal = '主'.repeat(300), message = '友'.repeat(200);
  const feedback = { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 100, y: -100 }, applied: { x: 11, y: 6 } };
  const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, correction: true, lastActionFeedback: feedback,
    events: [{ type: 'message', payload: { agent_id: 'agent_' + 'f'.repeat(36), text: message } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
  assert.ok(data.opportunities.some(o => o.action.type === 'adventure_plan'));
  assert.ok(data.opportunities.some(o => o.action.type === 'farm'));
  assert.deepEqual(data.life.equipment, observation.self.life.equipment);
  assert.equal(data.life.inventory_omitted, true); assert.equal(data.life.inventory, undefined);
  assert.deepEqual(data.last_action.requested, feedback.requested); assert.deepEqual(data.last_action.applied, feedback.applied);
});

test('生活事件只唤醒自己或队友，成熟通知按event_id去重且队列满时保留', () => {
  const own = { event_id: 'own', type: 'life_ready', payload: { agent_id: 'self', plot_id: 'plot_1' } };
  const result = enqueueEvents({ queue: [], seen: [] }, [own, own,
    { event_id: 'friend', type: 'life_harvested', payload: { agent_id: 'friend' } },
    { event_id: 'stranger', type: 'life_ready', payload: { agent_id: 'stranger' } },
    ...Array.from({ length: 120 }, (_, i) => ({ event_id: `message-${i}`, type: 'message', payload: { agent_id: 'other', text: 'hi' } }))], 'self', ['friend']);
  assert.equal(result.queue.filter(e => e.event_id === 'own').length, 1);
  assert.equal(result.queue.some(e => e.event_id === 'stranger'), false);
  assert.equal(result.queue.length, 100);
});

test('拥挤生活机会与三名追击者同时存在时保留关键战况和完整主人/消息/移动回执', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation);
  const friend = 'agent_' + 'f'.repeat(36), ownerGoal = '主'.repeat(300), message = '友'.repeat(200);
  observation.opportunities = opportunities;
  observation.self.life.inventory.turnip = 2;
  observation.self.life.inventory.wheat = 2;
  observation.group = { group_id: 'group_' + 'g'.repeat(36), members: [f.a.agent_id, friend] };
  Object.assign(observation.self.adventure, { in_field: true, hp: 8, decision_until: observation.server_time + 30000 });
  observation.adventure.monsters.forEach((m, i) => { m.behavior = 'attacking'; m.target_agent_id = i === 1 ? friend : f.a.agent_id; });
  const feedback = { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 100, y: -100 }, applied: { x: 11, y: 6 } };
  const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, correction: true, lastActionFeedback: feedback,
    events: [{ type: 'adventure_aggro', payload: { agent_id: f.a.agent_id, monster_id: 'forest_slime' } }, { type: 'message', payload: { agent_id: friend, text: message } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal));
  assert.equal(data.events.at(-1).text, message);
  assert.equal(data.adventure.monsters.length, 3);
  assert.ok(data.adventure.monsters.some(row => row[6] === friend));
  assert.equal(data.self.adventure.hp, 8); assert.equal(data.self.adventure.decision_seconds, 30);
  assert.deepEqual(data.last_action.requested, feedback.requested); assert.deepEqual(data.last_action.applied, feedback.applied);
  assert.equal(data.last_action.status, 'applied'); assert.ok(data.movement.candidates.length >= 2);
  assert.ok(data.food.some(row => row[0] === 'turnip'));
  assert.match(prompt, /inventory\{intent:use,item_id\}/);
});
