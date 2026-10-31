import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const action = (type, payload = {}) => ({ type, payload });
const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);

async function fixture(t, mode = 'dsh-pet') {
  let now = Date.now(), answer = action('wait');
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '原生活者' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const auth = world.authenticate(controller.token), calls = [], contexts = [], systems = [];
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; }, close: async () => {} };
  const runner = new PlazaRunner({ mode, toolClient: client, now: () => now, idleMs: 30000,
    petClient: { decide: async input => { const prompt = decisionPrompt(input); assert.ok(prompt.length <= 2000); contexts.push(decode(prompt)); return JSON.stringify(answer); } },
    model: { baseUrl: 'https://original.invalid/v1', model: 'original-test-double', apiKey: 'PRIVATE' },
    fetchImpl: async (_, options) => { const messages = JSON.parse(options.body).messages; systems.push(messages[0].content); contexts.push(JSON.parse(messages[1].content));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }; } });
  runner.running = true; runner.abort = new AbortController(); await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = () => world.agent(record.agent_id); a().position = { x: 11, y: 8 };
  const refresh = () => { runner.observation = world.observation(a()); runner.observedAt = now; };
  const advance = ms => { while (ms > 0) { const step = Math.min(ms, 5000); now += step; ms -= step; world.callTool(auth, 'observe', runner.session()); world.tick(); } refresh(); };
  const decide = async next => { answer = next; advance(6000); await runner.decide(); };
  refresh(); t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, get a() { return a(); }, calls, contexts, systems, refresh, advance, decide };
}

test('采集和购销动作严格限制字段与数量，不接受目标角色、价格或执行代码', () => {
  for (const value of [action('gather', { intent: 'start', resource_id: 'wood' }), action('gather', { intent: 'cancel' }),
    ...['buy', 'sell'].map(intent => action('trade', { intent, item_id: 'wood', quantity: 1 })),
    ...['craft', 'use'].map(intent => action('inventory', { intent, item_id: 'turnip_soup' }))]) {
    assert.deepEqual(parseModelAction(JSON.stringify(value)), value);
  }
  for (const value of [action('gather', { intent: 'start' }), action('gather', { intent: 'cancel', resource_id: 'camp_wood' }),
    action('gather', { intent: 'start', resource_id: 'camp_wood', duration: 100000 }),
    action('gather', { intent: 'execute', command: 'run' }),
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER].map(quantity => action('trade', { intent: 'buy', item_id: 'wood', quantity })),
    action('trade', { intent: 'buy', item_id: 'wood', quantity: 1, price: 0 }),
    action('trade', { intent: 'sell', item_id: 'wood', quantity: 1, target_agent_id: 'other' })]) {
    assert.throws(() => parseModelAction(JSON.stringify(value)), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}原AI从零补给自行选择采集、出售、买种子；wait不替它开工`, async t => {
  const f = await fixture(t, mode); f.a.life.inventory = {}; f.a.adventure.gold = 0;
  f.a.life.tools.hoe.durability = 0; f.a.life.tools.watering_can.durability = 0; f.refresh();
  await f.decide(action('wait'));
  assert.equal(f.a.life.gathering, null); assert.equal(f.calls.filter(c => c.name === 'act').length, 0);
  await f.decide(action('gather', { intent: 'start', resource_id: 'wood' }));
  assert.equal(f.a.life.gathering.resource_id, 'wood'); assert.equal(f.a.life.inventory.wood || 0, 0);
  f.advance(13000); assert.equal(f.a.life.gathering, null); assert.equal(f.a.life.inventory.wood, 1);
  const modelCalls = f.runner.checkpoint.calls_used; f.advance(22000);
  assert.equal(f.runner.checkpoint.calls_used, modelCalls); assert.equal(f.a.life.inventory.wood, 1, '一次采集不会自动重复');
  await f.decide(action('trade', { intent: 'sell', item_id: 'wood', quantity: 1 }));
  assert.equal(f.a.adventure.gold, 1); assert.equal(f.a.life.inventory.wood || 0, 0);
  await f.decide(action('trade', { intent: 'buy', item_id: 'turnip_seed', quantity: 1 }));
  assert.equal(f.a.adventure.gold, 0); assert.equal(f.a.life.inventory.turnip_seed, 1);
  assert.equal(f.a.adventure.kills, 0); assert.equal(f.runner.checkpoint.calls_used, 4);
  const caps = f.calls.findLast(c => c.name === 'report_status').args.capabilities;
  assert.equal(caps.length, 15); for (const cap of ['gathering', 'cooking', 'trading']) assert.ok(caps.includes(cap));
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}料理制作和食用由本人选择，满血低体力仍能看见面包，不发送整本流水`, async t => {
  const f = await fixture(t, mode); Object.assign(f.a.life.inventory, { turnip: 2, wheat: 2 }); f.a.fatigue.energy = 10;
  f.refresh();
  await f.decide(action('inventory', { intent: 'craft', item_id: 'turnip_soup' }));
  assert.equal(f.a.life.inventory.turnip_soup, 1);
  await f.decide(action('inventory', { intent: 'craft', item_id: 'wheat_bread' }));
  assert.equal(f.a.life.inventory.wheat_bread, 1);
  assert.ok(f.world.observation(f.a).self.life.ledger.entries.length >= 2, '真实账本存在，只有模型每轮的摘要省略它');
  f.a.adventure.hp = f.a.adventure.max_hp; f.a.fatigue.energy = 1; f.refresh();
  await f.decide(action('inventory', { intent: 'use', item_id: 'wheat_bread' }));
  assert.equal(f.a.life.inventory.wheat_bread || 0, 0); assert.ok(f.a.fatigue.energy >= 25);
  if (mode === 'dsh-pet') assert.deepEqual(f.contexts.at(-1).food.find(row => row[0] === 'wheat_bread'), ['wheat_bread', 0, 1, 24]);
  else { assert.equal(f.contexts.at(-1).observation.self.life.ledger, undefined); assert.match(f.systems.at(-1), /trade\{intent:buy\|sell/); }
  assert.ok(!JSON.stringify(f.contexts).includes('"ledger":'));
  f.a.adventure.hp = 1; f.refresh(); await f.decide(action('inventory', { intent: 'use', item_id: 'turnip_soup' }));
  assert.equal(f.a.life.inventory.turnip_soup || 0, 0); assert.ok(f.a.adventure.hp >= 33);
});

test('有限采集不逐步思考，可由原AI选择取消；本人/队友完成唤醒且陌生人不入队', async t => {
  const f = await fixture(t); await f.decide(action('gather', { intent: 'start', resource_id: 'ore' }));
  f.advance(5000); assert.equal(f.runner.decisionDue(), false);
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.runner.rules }), data = decode(prompt);
  assert.equal(data.gathering[0], 'ore'); assert.match(prompt, /gather\{intent:cancel\}/);
  await f.decide(action('gather', { intent: 'cancel' })); assert.equal(f.a.life.gathering, null); assert.equal(f.a.life.inventory.ore || 0, 0);
  const events = ['self', 'friend', 'stranger'].flatMap(agent_id => ['life_gather_started', 'life_gather_finished'].map(type => ({ event_id: `${agent_id}-${type}`, type, payload: { agent_id } })));
  const state = enqueueEvents({ queue: [], seen: [] }, events, 'self', ['friend']);
  assert.deepEqual(state.queue.map(e => e.event_id), ['self-life_gather_finished', 'friend-life_gather_finished']);
});

test('资源、料理、价格与私人额度进入营地短提示，旧服务不宣称新增能力', async t => {
  const f = await fixture(t); Object.assign(f.a.life.inventory, { turnip: 2, wheat: 2 }); f.a.adventure.gold = 20; f.refresh();
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.runner.rules }), data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.equal(data.supply.gold, 20);
  assert.ok(data.supply.gather.some(row => row[0] === 'wood' && row[4] === 12 && row[5] === 4));
  assert.ok(data.supply.cook.some(row => row[0] === 'wheat_bread' && row[3] === 24));
  assert.ok(data.supply.cook.every(row => row[4] === 2));
  assert.ok(data.supply.prices.some(row => row[0] === 'turnip' && row[1] === null && row[2] === 2));
  assert.deepEqual(data.supply.quota.slice(0, 2), [20, 30]); assert.equal(data.supply.max_quantity, 10);
  const old = structuredClone(f.runner.rules); delete old.life.gathering; delete old.life.market; old.life.recipes = old.life.recipes.filter(recipe => recipe.kind !== 'cooking');
  old.allowed_actions = old.allowed_actions.filter(type => !['gather', 'trade'].includes(type)); f.runner.rules = old;
  assert.ok(!f.runner.capabilities().some(cap => ['gathering', 'cooking', 'trading'].includes(cap)));
  f.runner.rules = f.world.getRules(); f.runner.mode = 'demo'; assert.deepEqual(f.runner.capabilities(), []);
});

test('长目标、消息和移动回执下正在采集仍保留取消入口、体力和食物', async t => {
  const f = await fixture(t); await f.decide(action('gather', { intent: 'start', resource_id: 'ore' }));
  f.a.life.inventory.wheat_bread = 1; f.a.fatigue.energy = 1; f.refresh();
  const ownerGoal = '🐾'.repeat(300), message = '🌱'.repeat(200);
  const feedback = { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 11, y: 8 } };
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.runner.rules, ownerGoal, lastActionFeedback: feedback,
    events: [{ type: 'message', payload: { agent_id: 'agent_' + 'f'.repeat(36), text: message } }] }), data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
  assert.equal(data.gathering[0], 'ore'); assert.match(prompt, /gather\{intent:cancel\}/);
  assert.equal(data.energy[0], 1); assert.ok(data.food.some(row => row[0] === 'wheat_bread' && row[3] === 24));
  assert.deepEqual(data.last_action.requested, feedback.requested); assert.deepEqual(data.last_action.applied, feedback.applied);
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}真实金币不足回执供原AI重新决定，不代买也不重复失败交易`, async t => {
  const f = await fixture(t, mode); f.a.adventure.gold = 0;
  await f.decide(action('trade', { intent: 'buy', item_id: 'ore', quantity: 1 }));
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'INSUFFICIENT_GOLD');
  assert.equal(f.a.life.inventory.ore || 0, 0);
  const trades = f.calls.filter(c => c.name === 'act').length;
  await f.decide(action('wait'));
  assert.equal(f.calls.filter(c => c.name === 'act').length, trades);
  const context = f.contexts.at(-1);
  assert.equal(context.last_action.code, 'INSUFFICIENT_GOLD');
});
