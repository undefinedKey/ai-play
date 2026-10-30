import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction } from '../runner/runner.js';
import { decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const action = (type, payload = {}) => ({ type, payload });
const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
async function fixture(t, mode = 'dsh-pet') {
  let now = Date.now(), answer = action('wait');
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '原来的我' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const auth = world.authenticate(controller.token), calls = [], contexts = [], systems = [];
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; }, close: async () => {} };
  // Only the original model's reply is controlled. Tool results, materials,
  // durability, permissions, fatigue, rejection receipts and budgets are real.
  const reply = data => { contexts.push(data); return JSON.stringify(answer); };
  const runner = new PlazaRunner({ mode, toolClient: client, now: () => now, idleMs: 30000,
    petClient: { initialize: async () => {}, decide: async input => reply(decode(decisionPrompt(input))) },
    model: { baseUrl: 'https://original.invalid/v1', model: 'original-test-double', apiKey: 'PRIVATE' },
    fetchImpl: async (_, options) => {
      const messages = JSON.parse(options.body).messages; systems.push(messages[0].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: reply(JSON.parse(messages[1].content)) } }] }) };
    } });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = world.agent(record.agent_id); a.position = { x: 11, y: 8 };
  const refresh = () => { runner.observation = world.observation(world.agent(record.agent_id)); runner.observedAt = now; };
  const advance = ms => { while (ms > 0) { const step = Math.min(ms, 5000); now += step; ms -= step; world.callTool(auth, 'observe', runner.session()); world.tick(); } refresh(); };
  const decide = async next => { answer = next; advance(6000); await runner.decide(); };
  refresh(); t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, get a() { return world.agent(record.agent_id); }, calls, contexts, systems, refresh, advance, decide };
}

test('开垦与工具动作保留严格字段验证，不把武器或附加指令当农具', () => {
  for (const value of [action('farm', { intent: 'till', plot_id: 'plot_1' }),
    ...['repair', 'upgrade'].flatMap(intent => ['hoe', 'watering_can'].map(item_id => action('inventory', { intent, item_id })))]) {
    assert.deepEqual(parseModelAction(JSON.stringify(value)), value);
  }
  for (const value of [action('farm', { intent: 'till', plot_id: 'plot_1', crop_id: 'turnip' }),
    action('farm', { intent: 'till', plot_id: 'plot_3' }), action('inventory', { intent: 'repair', item_id: 'wooden_sword' }),
    action('inventory', { intent: 'upgrade', item_id: 'hoe', slot: 'weapon' }), action('inventory', { intent: 'repair' }),
    action('inventory', { intent: 'upgrade', item_id: 'hoe', command: 'run' })]) {
    assert.throws(() => parseModelAction(JSON.stringify(value)), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}原AI可等待、选择开垦和种小麦，桥不会自动劳作或换作物`, async t => {
  const f = await fixture(t, mode), plot = () => f.a.life.plots[0];
  await f.decide(action('wait'));
  assert.equal(plot().tilled, false); assert.equal(f.a.life.tools.hoe.durability, 20);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 0);
  await f.decide(action('farm', { intent: 'till', plot_id: 'plot_1' }));
  assert.equal(plot().tilled, true); assert.equal(f.a.life.tools.hoe.durability, 19);
  await f.decide(action('farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'wheat' }));
  assert.equal(plot().crop_id, 'wheat');
  await f.decide(action('farm', { intent: 'water', plot_id: 'plot_1' }));
  assert.equal(f.a.life.tools.watering_can.durability, 19); assert.ok(plot().ready_at > f.runner.now());
  const context = f.contexts.at(-1);
  if (mode === 'model') {
    assert.equal(context.observation.self.life.tools.hoe.durability, 19);
    assert.match(f.systems.at(-1), /先开垦再种植/);
  } else {
    assert.equal(context.life.tools.find(row => row[0] === 'hoe')[2], 19);
    assert.equal(context.life.plots.find(row => row[0] === 'plot_1')[5], true);
  }
  assert.ok(f.calls.findLast(c => c.name === 'report_status').args.capabilities.includes('farm_tools'));
  assert.equal(f.runner.checkpoint.calls_used, 4);
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}损坏锄头的真实拒绝交给原AI，等待不自动维修，后续本人选择维修和升级`, async t => {
  const f = await fixture(t, mode);
  f.a.life.tools.hoe.durability = 0; Object.assign(f.a.life.inventory, { wood: 20, ore: 20 }); f.refresh();
  await f.decide(action('farm', { intent: 'till', plot_id: 'plot_1' }));
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'TOOL_BROKEN');
  assert.equal(f.a.life.tools.hoe.durability, 0); assert.equal(f.a.life.plots[0].tilled, false);
  await f.decide(action('wait'));
  assert.equal(f.contexts.at(-1).last_action?.code || f.contexts.at(-1).last_action?.error?.code, 'TOOL_BROKEN');
  assert.equal(f.a.life.inventory.wood, 20); assert.equal(f.a.life.tools.hoe.durability, 0);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 1);
  await f.decide(action('inventory', { intent: 'repair', item_id: 'hoe' }));
  assert.deepEqual(f.a.life.tools.hoe, { level: 1, durability: 20, max_durability: 20 });
  assert.equal(f.a.life.inventory.wood, 19); assert.equal(f.a.life.inventory.ore, 20);
  await f.decide(action('inventory', { intent: 'upgrade', item_id: 'hoe' }));
  assert.deepEqual(f.a.life.tools.hoe, { level: 2, durability: 40, max_durability: 40 });
  assert.equal(f.a.life.inventory.wood, 16); assert.equal(f.a.life.inventory.ore, 18);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 3);
  assert.equal(f.runner.checkpoint.calls_used, 4);
});

test('营地提示提供真实工具等级/耐久/下一档材料，当前机会可直接选择且不伪造仓库', async t => {
  const f = await fixture(t);
  f.a.life.tools.hoe = { level: 2, durability: 0, max_durability: 40 };
  Object.assign(f.a.life.inventory, { wood: 10, ore: 10 }); f.refresh();
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules() }), data = decode(prompt);
  assert.ok(prompt.length <= 2000);
  assert.deepEqual(data.life.tools.find(row => row[0] === 'hoe'), ['hoe', 2, 0, 40, 2, [5, 4], [1, 1]]);
  const option = data.opportunities.find(o => o.action.type === 'inventory' && o.action.payload.intent === 'repair' && o.action.payload.item_id === 'hoe');
  assert.ok(option); await f.decide(option.action);
  assert.equal(f.a.life.tools.hoe.durability, 40); assert.equal(f.a.life.inventory.wood, 9); assert.equal(f.a.life.inventory.ore, 9);
  assert.match(prompt, /材料=\[木材,矿石\]/);
});

test('旧服务器没有工具目录时不制造工具状态或暗示新动作成功', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation), rules = structuredClone(f.world.getRules());
  delete rules.life.tools; delete observation.life.tools; delete observation.self.life.tools;
  observation.opportunities = observation.opportunities.filter(o => !['till', 'repair', 'upgrade'].includes(o.action.payload.intent));
  const data = decode(decisionPrompt({ observation, rules }));
  assert.equal(data.life?.tools, undefined);
  f.runner.rules = rules; await f.runner.report('waiting');
  assert.ok(!f.calls.findLast(c => c.name === 'report_status').args.capabilities.includes('farm_tools'));
});
