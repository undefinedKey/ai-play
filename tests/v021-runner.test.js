import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { PlazaRunner, RunnerError, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { survivalPromptNotice, supportsSurvival } from '../skills/ai-plaza/scripts/survival-context.mjs';
import { resourcePromptNotice, resourceJobContext } from '../skills/ai-plaza/scripts/resources-context.mjs';
import { actInputSchema, toolDefinitions } from '../server/mcp.js';
import { createApp } from '../server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const action = (type, payload = {}) => ({ type, payload });
const parse = a => parseModelAction(JSON.stringify(a));
const decode = p => JSON.parse(p.split('公开数据：')[1]);

test('survival六种意图的桥与MCP都严格校验，不能夹带坐标/预算/自动续柴', () => {
  const valid = [{ intent: 'approach', site_id: 'camp_hearth' }, { intent: 'approach', site_id: 'camp_hearth', mode: 'run' },
    { intent: 'build', site_id: 'camp_hearth', kind: 'campfire' }, { intent: 'build', site_id: 'camp_hearth', kind: 'firepit' },
    ...['wood', 'grass', 'pine_cone'].map(item_id => ({ intent: 'fuel', fire_id: 'fire_a', item_id, quantity: 2 })),
    { intent: 'extinguish', fire_id: 'fire_a' }, { intent: 'torch', lit: true }, { intent: 'torch', lit: false }, { intent: 'cancel' }];
  const invalid = [{ intent: 'approach', x: 1, y: 2 }, { ...valid[1], mode: 'teleport' }, { ...valid[2], mode: 'walk' },
    { ...valid[2], kind: 'castle' }, { ...valid[4], quantity: 0 }, { ...valid[4], quantity: 6 }, { ...valid[4], quantity: 1.5 },
    { ...valid[4], item_id: 'ore' }, { ...valid[4], repeat: true }, { ...valid[4], agent_id: 'other' },
    { ...valid[7], quantity: 1 }, { ...valid[8], lit: 'true' }, { intent: 'cancel', fire_id: 'fire_a' }, { ...valid[0], site_id: 'not a site' }];
  for (const p of valid) {
    const a = action('survival', p); assert.deepEqual(parse(a), a);
    assert.equal(actInputSchema.safeParse({ run_id: 'run', session_epoch: 1, action_id: 'a', ...a }).success, true);
  }
  for (const p of invalid) {
    const a = action('survival', p); assert.throws(() => parse(a), { code: 'INVALID_MODEL_OUTPUT' });
    assert.equal(actInputSchema.safeParse({ run_id: 'run', session_epoch: 1, action_id: 'a', ...a }).success, false);
  }
  for (const mode of [undefined, 'walk', 'run']) assert.deepEqual(parse(action('gather', { intent: 'plant', node_id: 'pine_plot', ...(mode ? { mode } : {}) })).payload.node_id, 'pine_plot');
  for (const p of [{ intent: 'plant', resource_id: 'wood' }, { intent: 'plant', node_id: 'pine_plot', resource_id: 'wood' }, { intent: 'plant', node_id: 'pine_plot', quantity: 2 }]) assert.throws(() => parse(action('gather', p)), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => expandDecisionReferences(JSON.stringify(action('survival', { intent: 'fuel', fire_id: '@V999', item_id: 'wood', quantity: 1 })), {}), { code: 'INVALID_MODEL_OUTPUT' });
  assert.equal(JSON.parse(expandDecisionReferences(JSON.stringify(action('survival', { intent: 'approach', site_id: '@V1' })), { '@V1': 'real_site' })).payload.site_id, 'real_site');
});

test('真实HTTP MCP发现新动作且在世界副作用前拒绝非法survival字段', async t => {
  const app = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false });
  const { server, url } = await app.start(0);
  const client = new Client({ name: 'survival-wire-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const created = app.world.createAgent({ name: 'MCP生存校验' }), controller = app.world.createController(created.agent_id);
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const tools = await client.listTools(); assert.ok(tools.tools.find(x => x.name === 'act').inputSchema.properties.type.enum.includes('survival'));
  const a = app.world.agent(created.agent_id), before = structuredClone(a.life.inventory);
  const original = app.world.callTool.bind(app.world); let acted = false;
  app.world.callTool = (...args) => { if (args[1] === 'act') acted = true; return original(...args); };
  const rejected = await client.callTool({ name: 'act', arguments: { run_id: 'not-active', session_epoch: 1, action_id: 'unused', type: 'survival', payload: { intent: 'fuel', fire_id: 'fire', item_id: 'wood', quantity: 1, repeat: true } } });
  assert.equal(rejected.isError, true); assert.equal(acted, false); assert.deepEqual(a.life.inventory, before);
});

function observed(t) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const created = world.createAgent({ name: '原来的生存者' }), a = world.agent(created.agent_id), c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 50 });
  const o = world.observation(a), rules = world.getRules();
  rules.allowed_actions = [...new Set([...rules.allowed_actions, 'survival'])]; rules.survival = { version: 1 };
  o.day_cycle = { phase: 'night', day_index: 1, next_at: now + 70000 };
  o.survival = { version: 1, server_time: now, sites: [{ id: 'camp_hearth', scene_id: o.self.scene_id, position: { x: 13, y: 8 }, interaction_position: { x: 12, y: 8 } }],
    fires: [{ fire_id: 'fire_' + 'f'.repeat(36), site_id: 'camp_hearth', kind: 'campfire', scene_id: o.self.scene_id, position: { x: 13, y: 8 }, owner_agent_id: 'peer', lit: false, fuel_seconds: 0, max_fuel_seconds: 300, light_radius: 5 }] };
  o.self.survival = { satiety: 9, max_satiety: 100, satiety_state: 'hungry', light: { lit: false, source_id: null, kind: null, radius: 0 }, darkness_seconds: 85, danger_in_seconds: 5, torch: null, travel: null };
  o.self.adventure.hp = o.self.adventure.max_hp; o.self.fatigue.energy = 100;
  o.self.life.inventory.berry = 2;
  o.life.items = o.life.items.filter(x => x.id !== 'berry').concat({ id: 'berry', kind: 'food', heal: 0, energy_restore: 0, satiety_restore: 8 });
  return { world, a, c, o, rules, get now() { return now; }, advance(ms) { now += ms; } };
}

test('满血满体但饥饿仍看到可食食物；暗处、火源真实状态与旧服边界进入提示', t => {
  const f = observed(t), p = prepareDecisionPrompt({ observation: f.o, rules: f.rules }), data = decode(p.text);
  assert.ok(p.text.length <= 2000); assert.match(p.text, /生存\[饱0~100/); assert.match(p.text, /9,false,85,5,null/); assert.match(p.text, /夜暗营地也危险/);
  assert.ok(data.food.some(row => row[0] === 'berry' && row[4] === 8));
  assert.match(p.text, /intent:approach/); assert.match(p.text, /intent:build/); assert.match(p.text, /intent:torch/);
  const notice = survivalPromptNotice(f.o, f.rules);
  assert.match(notice, /camp_hearth/); assert.match(notice, /fire_fff/); assert.match(notice, /false,0,5,false,false/); assert.match(notice, /不建/);
  assert.equal(survivalPromptNotice(f.o, { ...f.rules, survival: undefined }), '');
  assert.equal(supportsSurvival(f.o, { ...f.rules, allowed_actions: f.rules.allowed_actions.filter(a => a !== 'survival') }), false);
  const legacy = structuredClone(f.o); delete legacy.survival; delete legacy.self.survival;
  assert.doesNotMatch(prepareDecisionPrompt({ observation: legacy, rules: { ...f.rules, survival: undefined } }).text, /生存\[|survival\{/);
});

test('准备过夜提醒保留服务期限，原主人要求中的地图词句不会被说明适配改写', t => {
  const f = observed(t), ownerGoal = '我说“回营”时先聊天；不要复述 rest双恢复 或 explore到zone；保留这句原话。';
  const event = { type: 'survival_warning', payload: { agent_id: f.o.self.agent_id, kind: 'prepare_night', deadline: f.now + 180000 } };
  const p = prepareDecisionPrompt({ observation: f.o, rules: f.rules, ownerGoal, events: [event] });
  assert.ok(p.text.includes(JSON.stringify(ownerGoal))); assert.match(p.text, /距入夜180秒，自选准备/); assert.match(p.text, /rest需亮且饱>0/);
  assert.equal(survivalPromptNotice(f.o, f.rules, 'critical', [{ ...event, payload: { ...event.payload, agent_id: 'someone_else' } }]).includes('180秒'), false);
});

test('实际服务完整目录在夜间仍给原AI真实火点、建造成本、便携火把和食物选择', t => {
  const f = observed(t), o = f.world.observation(f.a), rules = f.world.getRules();
  o.day_cycle.phase = 'night';
  o.self.survival = { satiety: 25, max_satiety: 100, light: { lit: false }, darkness_seconds: 70, danger_in_seconds: 20, torch: null, travel: null };
  Object.assign(o.self.life.inventory, { wood: 4, grass: 2, berry: 2 });
  const p = prepareDecisionPrompt({ observation: o, rules }), data = decode(p.text);
  assert.ok(p.text.length <= 2000); assert.match(p.text, /25,false,70,20,null/);
  const site = o.survival.sites.find(site => site.scene_id === o.self.scene_id);
  assert.ok(p.text.includes(site.id)); assert.match(p.text, /intent:approach/); assert.match(p.text, /intent:build/);
  assert.ok(p.text.includes(JSON.stringify(rules.survival.structures.map(fire => [fire.id, fire.ingredients, fire.initial_fuel_seconds, fire.max_fuel_seconds, fire.light_radius]))));
  assert.match(p.text, /intent:craft,item_id:torch/); assert.ok(data.food.some(row => row[0] === 'berry' && row[4] > 0));
});

for (const mode of ['ordinary', 'gather', 'travel', 'cooperation', 'story']) test(`UTF16极限${mode}仍保留生存事实、原主人目标/消息和正在执行的约定`, t => {
  const f = observed(t), o = f.o, s = o.self, friend = 'agent_' + 'q'.repeat(36);
  const ownerGoal = '🐾'.repeat(300), message = '🌱'.repeat(200);
  const context = { observation: o, rules: f.rules, ownerGoal, correction: true, events: [{ type: 'message', payload: { agent_id: friend, text: message } }] };
  if (mode === 'gather') s.life.gathering = { node_id: 'pine_plot', intent: 'plant', phase: 'approaching', ends_at: null, expires_at: f.now + 100000, mode: 'walk', energy_cost: 2, yield_count: 0 };
  if (mode === 'travel') s.survival.travel = { site_id: 'camp_hearth', expires_at: f.now + 80000 };
  if (['cooperation', 'story'].includes(mode)) {
    o.cooperation = { cooperation_id: 'coop_' + 'c'.repeat(36), revision: 2, template_id: 'camp_meal', status: 'needs_review', expires_at: f.now + 600000, self_role_id: 'supplier',
      members: [{ agent_id: s.agent_id, role_id: 'supplier', confirmed: false }, { agent_id: friend, role_id: 'cook', confirmed: false }], progress: [{ step_id: 'supply', progress: 4, target_count: 4 }, { step_id: 'cook', progress: 0, target_count: 1 }], escrow: { turnip: 4 } };
  }
  if (mode === 'story') {
    o.game = { game_id: 'game_' + 'g'.repeat(36), turn_id: 'turn_' + 't'.repeat(36), deadline: f.now + 150000, status: 'active', game_type: 'story_chain', current_agent_id: s.agent_id, participants: [s.agent_id], segments: [{ agent_id: friend, text: '🐈'.repeat(200) }] };
    o.group = { group_id: 'group_' + 'h'.repeat(36), members: [s.agent_id, friend] }; context.events[0].payload.channel = 'group';
  }
  const p = prepareDecisionPrompt(context);
  assert.ok(p.text.length <= 2000, `${mode}: ${p.text.length}`); assert.ok(p.text.includes(ownerGoal)); assert.ok(p.text.includes(message));
  assert.match(p.text, /生存\[饱0~100/); assert.match(p.text, /9,false,85,5,null/); assert.doesNotThrow(() => decode(p.text));
  if (mode === 'travel') { assert.match(p.text, /camp_hearth/); assert.match(p.text, /期限80秒/); }
  if (mode === 'gather') assert.ok(JSON.stringify(decode(p.text)).includes('plant'));
  if (mode === 'cooperation') { assert.match(p.text, /4萝卜/); assert.match(p.text, /confirm/); }
  if (mode === 'story') assert.ok(p.text.includes('🐈'.repeat(200)));
});

test('生态阶段与种树进度没有冒充木材产出，也不会假定幼树可砍', t => {
  const f = observed(t), o = f.o, node = structuredClone(o.resources.nodes.find(n => n.kind === 'tree') || o.resources.nodes[0]);
  Object.assign(node, { id: 'pine_plot', scene_id: o.self.scene_id, stock: 0, available: false, plantable: true, ecology: { stage: 'empty', next_at: null, origin: 'planted' } });
  o.resources.nodes = [node]; o.self.life.inventory.pine_cone = 1;
  const notice = resourcePromptNotice(o, f.rules, true); assert.match(notice, /树态empty/); assert.match(notice, /intent:plant/); assert.match(notice, /完成耗松果1/);
  o.self.life.gathering = { node_id: node.id, intent: 'plant', phase: 'working', ends_at: f.now + 4000, expires_at: f.now + 120000, energy_cost: 2, yield_count: 0 };
  assert.deepEqual(resourceJobContext(o), ['pine_plot', 'working', 4, 120, 'walk', 2, 0, 'plant']);
});

test('只自身风险跨阈值和有限前往终态唤醒，环境/火焰变化不制造模型循环', () => {
  const events = [{ event_id: 'a', type: 'survival_warning', payload: { agent_id: 'self', kind: 'darkness' } },
    { event_id: 'b', type: 'survival_warning', payload: { agent_id: 'self', kind: 'darkness' } },
    { event_id: 'c', type: 'survival_warning', payload: { agent_id: 'peer', kind: 'starving' } },
    ...['fire_fueled', 'fire_built', 'fire_extinguished', 'torch_changed', 'day_phase_changed', 'resource_growth', 'resource_stage_changed'].map((type, i) => ({ event_id: 'env' + i, type, payload: { agent_id: 'self' } })),
    { event_id: 'd', type: 'survival_arrived', payload: { agent_id: 'self', reason: 'arrived' } }];
  const cp = enqueueEvents({ seen: [], queue: [] }, events, 'self', ['peer']); assert.deepEqual(cp.queue.map(e => e.event_id), ['b', 'd']);
  const flooded = enqueueEvents(cp, Array.from({ length: 150 }, (_, i) => ({ event_id: 'join' + i, type: 'joined' })), 'self');
  assert.ok(flooded.queue.some(e => e.event_id === 'b'));
  const runner = new PlazaRunner({ mode: 'model', now: () => 15000 }); runner.lastDecisionAt = 10000; runner.rules = {};
  runner.checkpoint = { queue: [], model_retry_at: 0 }; runner.observation = { server_time: 15000, self: { survival: { travel: { site_id: 'site', expires_at: 120000 } } } }; runner.observedAt = 15000;
  assert.equal(runner.decisionDue(), false);
});

for (const mode of ['model', 'dsh-pet']) test(`${mode}真实MCP只执行本人有限前往/建火/添柴，丢失回执不重复扣料或换身份预算`, async t => {
  const app = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), world = app.world;
  let runner;
  const client = new Client({ name: 'survival-runner-test', version: '1.0.0' });
  t.after(async () => { await runner?.stop(); await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const created = world.createAgent({ name: '原宿主生存决策' }), a = world.agent(created.agent_id), controller = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 30 });
  a.life.inventory.wood = 10; a.life.inventory.grass = 10;
  const prompts = [], requests = [];
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  let selected = action('survival', { intent: 'approach', site_id: 'plaza_hearth', mode: 'walk' });
  const callTool = client.callTool.bind(client); client.callTool = async req => { requests.push(structuredClone(req)); return callTool(req); };
  runner = new PlazaRunner({ mode, toolClient: client, now: () => now,
    petClient: { initialize: async () => {}, prepareDecision: prepareDecisionPrompt, decide: async (_, { prepared, onRequest }) => { prompts.push(prepared.text); await onRequest(); return expandDecisionReferences(JSON.stringify(selected), prepared.references); } },
    model: { baseUrl: 'https://original.invalid/v1', model: 'same-original-model', apiKey: 'PRIVATE_TEST' },
    fetchImpl: async (_, request) => { prompts.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected) } }] }) }; } });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(await runner.call('get_control_state', {}));
  const original = { agent: a.agent_id, run: a.run.run_id, max: a.run.max_calls, deadline: a.run.expires_at }, position = { ...a.position };
  await runner.decide();
  assert.equal(a.survival.travel.site_id, 'plaza_hearth'); assert.deepEqual(a.position, position);
  assert.equal(Object.keys(world.state.survival.fires).length, 0); assert.equal(runner.checkpoint.calls_used, 1);
  for (let i = 0; i < 200 && a.survival.travel; i++) { now += 100; world.tick(); if (i % 10 === 0) await runner.call('observe', runner.session()); }
  assert.equal(a.survival.travel, null); assert.deepEqual(a.position, world.getRules().survival.sites.find(s => s.id === 'plaza_hearth').interaction_position);
  assert.equal(Object.keys(world.state.survival.fires).length, 0, '前往不会顺带建火'); assert.equal(runner.checkpoint.calls_used, 1);
  async function loseReceiptOnce(a) {
    selected = a;
    const call = runner.call.bind(runner); let dropped = false;
    runner.call = async (name, args) => { const result = await call(name, args); if (name === 'act' && !dropped) { dropped = true; throw new RunnerError('WORLD_UNAVAILABLE', '测试：提交后丢失响应'); } return result; };
    await assert.rejects(runner.decide(), { code: 'WORLD_UNAVAILABLE' });
    const id = runner.checkpoint.pending_action.action_id, used = runner.checkpoint.calls_used;
    runner.call = call; await runner.recoverPending();
    assert.equal(runner.checkpoint.pending_action, null); assert.equal(runner.checkpoint.calls_used, used);
    assert.equal(requests.filter(r => r.name === 'act' && r.arguments.action_id === id).length, 1);
    assert.ok(requests.some(r => r.name === 'get_action_result' && r.arguments.action_id === id));
  }
  await loseReceiptOnce(action('survival', { intent: 'build', site_id: 'plaza_hearth', kind: 'campfire' }));
  const fire = Object.values(world.state.survival.fires)[0]; assert.ok(fire); assert.equal(Object.keys(world.state.survival.fires).length, 1);
  assert.equal(a.life.inventory.wood, 7); assert.equal(a.life.inventory.grass, 8); assert.equal(fire.fuel_seconds, 90);
  await loseReceiptOnce(action('survival', { intent: 'fuel', fire_id: fire.fire_id, item_id: 'wood', quantity: 1 }));
  assert.equal(a.life.inventory.wood, 6); assert.equal(fire.fuel_seconds, 150); assert.equal(runner.checkpoint.calls_used, 3);
  selected = action('wait'); await runner.decide(); assert.equal(requests.filter(r => r.name === 'act').length, 3);
  assert.deepEqual({ agent: a.agent_id, run: a.run.run_id, max: a.run.max_calls, deadline: a.run.expires_at }, original);
  assert.equal(runner.capabilities().length, 16); assert.equal(runner.checkpoint.calls_used, 4);
  if (mode === 'model') { assert.match(prompts[0].messages[0].content, /survival\{intent:approach/); assert.equal(JSON.parse(prompts[0].messages[1].content).observation.survival.version, 1); }
  else for (const prompt of prompts) { assert.ok(prompt.length <= 2000); assert.match(prompt, /生存(?:\[饱0~100|:饱[\d.]+\/100)/); }
});
