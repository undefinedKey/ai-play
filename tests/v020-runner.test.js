import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { resourcePromptNotice, resourceJobContext } from '../skills/ai-plaza/scripts/resources-context.mjs';
import { toolDefinitions } from '../server/mcp.js';

const action = (type, payload = {}) => ({ type, payload });
const parse = value => parseModelAction(JSON.stringify(value));
const decode = value => JSON.parse(value.split('公开数据：')[1]);

test('节点采集与旧资源请求互斥，工具维护和新区域可表达，不能添预算/目标人/续采', () => {
  for (const mode of [undefined, 'walk', 'run']) {
    const a = action('gather', { intent: 'start', node_id: 'east_pine', ...(mode ? { mode } : {}) });
    assert.deepEqual(parse(a), a);
  }
  for (const a of [action('gather', { intent: 'start', resource_id: 'wood' }), action('gather', { intent: 'cancel' }),
    ...['axe', 'pickaxe'].flatMap(item_id => ['craft', 'repair', 'upgrade'].map(intent => action('inventory', { intent, item_id }))),
    ...['grove', 'quarry'].map(zone_id => action('adventure_plan', { intent: 'explore', zone_id }))]) assert.deepEqual(parse(a), a);
  for (const payload of [
    { intent: 'start', node_id: 'east_pine', resource_id: 'wood' }, { intent: 'start', resource_id: 'wood', mode: 'run' },
    { intent: 'cancel', node_id: 'east_pine' }, { intent: 'cancel', mode: 'walk' }, { intent: 'start' },
    { intent: 'start', node_id: 'east_pine', mode: 'fly' }, { intent: 'start', node_id: 'east_pine', repeat: true },
    { intent: 'start', node_id: 'east_pine', duration_seconds: 100000 }, { intent: 'start', node_id: 'east_pine', agent_id: 'peer' },
    { intent: 'start', node_id: 'not a node' }, { intent: 'start', node_id: 'x'.repeat(101) },
  ]) assert.throws(() => parse(action('gather', payload)), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => expandDecisionReferences(JSON.stringify(action('gather', { intent: 'start', node_id: '@V999' })), {}), { code: 'INVALID_MODEL_OUTPUT' });
});

function observed(t) {
  let now = Date.now();
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const created = world.createAgent({ name: '原来的采集者' }), a = world.agent(created.agent_id), c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 50 });
  a.position = { x: 26, y: 11 };
  return { world, a, c, get now() { return now; }, advance(ms) { now += ms; }, get o() { return world.observation(a); }, get rules() { return world.getRules(); } };
}

test('真实节点库存/预约/工具和时段进入提示；共享available不冒充本人能开工', t => {
  const f = observed(t), o = f.o, rules = f.rules;
  assert.equal(o.resources.version, 1); assert.equal(rules.life.gathering.version, 2);
  const pine = o.resources.nodes.find(n => n.id === 'east_pine');
  pine.stock = 0; pine.available = false; pine.regrow_at = f.now + 45000;
  pine.reservation = { agent_id: 'other', job_id: 'job', expires_at: f.now + 10000 };
  o.resources.nodes = [pine]; o.self.life.tools.axe = { owned: true, level: 1, durability: 0, max_durability: 12 };
  const notice = resourcePromptNotice(o, rules);
  assert.match(notice, /east_pine/); assert.match(notice, /\["axe",true,0\]/); assert.match(notice, /45,true/);
  assert.match(notice, /可预约不代表工具\/体力足/); assert.match(notice, /夜间开工秒×1.25\/体×1.2/);
  assert.match(notice, /先走再采一次≤120秒/); assert.match(notice, /不跨场景\/续采/);
  const prepared = prepareDecisionPrompt({ observation: o, rules });
  assert.ok(prepared.text.length <= 2000); assert.match(prepared.text, /east_pine/); assert.doesNotThrow(() => decode(prepared.text));
  const oldO = structuredClone(o), oldRules = structuredClone(rules); delete oldO.resources; delete oldO.day_cycle; delete oldRules.resources; delete oldRules.day_cycle;
  assert.equal(resourcePromptNotice(oldO, oldRules), '');
  assert.doesNotMatch(prepareDecisionPrompt({ observation: oldO, rules: oldRules }).text, /先走再采一次|node_id/);
});

test('夜间与月光草开放条件不被短提示丢弃，候选采用实际机会ID而非默认采木', t => {
  const f = observed(t), o = f.o;
  o.self.scene_id = 'adventure'; o.self.position = { x: 39, y: 24 };
  o.day_cycle.phase = 'night';
  o.opportunities = [{ action: action('gather', { intent: 'start', node_id: 'moon_herb' }) }];
  const moon = o.resources.nodes.find(n => n.id === 'moon_herb'); moon.available = true;
  const notice = resourcePromptNotice(o, f.rules, true);
  assert.match(notice, /moon_herb/); assert.match(notice, /限night\/dawn/);
  assert.match(notice, /夜间开工时间×1.25\/体力×1.2/); assert.match(notice, /库存2/);
  assert.ok(!notice.includes('camp_branches'));
  o.cooperation = { status: 'completed' }; o.self.personal_goal = { status: 'completed' };
  assert.match(resourcePromptNotice(o, f.rules, true), /moon_herb/, '历史合作/目标不永久遮蔽之后的资源选择');
});

test('接近和工作阶段保留节点、固定期限、原主人和消息，不把null结束时间当成完成', t => {
  const f = observed(t), o = f.o, ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200);
  o.self.fatigue.energy = 5; o.self.life.inventory.wheat_bread = 1;
  o.self.life.gathering = { node_id: 'east_pine', resource_id: 'wood', phase: 'approaching', ends_at: null, expires_at: f.now + 120000, mode: 'walk', energy_cost: null, yield_count: 3 };
  const context = { observation: o, rules: f.rules, ownerGoal, events: [{ type: 'message', payload: { agent_id: 'agent_' + 'p'.repeat(36), text: message } }] };
  let prepared = prepareDecisionPrompt(context), data = decode(prepared.text);
  assert.ok(prepared.text.length <= 2000); assert.ok(prepared.text.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
  assert.deepEqual(data.gathering, ['east_pine', 'approaching', null, 120, 'walk', null, 3]);
  assert.match(prepared.text, /gather\{intent:cancel\}/); assert.equal(data.energy[0], 5);
  Object.assign(o.self.life.gathering, { phase: 'working', ends_at: f.now + 14000, energy_cost: 6 });
  prepared = prepareDecisionPrompt(context); data = decode(prepared.text);
  assert.equal(data.gathering[1], 'working'); assert.equal(data.gathering[2], 14); assert.equal(data.gathering[5], 6);
});

test('环境变化和接近开工不唤醒模型，仅本人/队友终态按原节流复核', () => {
  const events = ['life_gather_started', 'life_gather_working', 'life_gather_finished', 'life_gather_cancelled', 'resource_regrown', 'day_phase_changed'].flatMap(type => ['self', 'friend', 'stranger'].map(agent_id => ({ event_id: `${type}-${agent_id}`, type, payload: { agent_id } })));
  const state = enqueueEvents({}, events, 'self', ['friend']);
  assert.deepEqual(state.queue.map(e => e.event_id), ['life_gather_finished-self', 'life_gather_finished-friend', 'life_gather_cancelled-self', 'life_gather_cancelled-friend']);
  const crowded = enqueueEvents(state, Array.from({ length: 120 }, (_, i) => ({ event_id: `chat-${i}`, type: 'message', payload: { agent_id: 'stranger', text: 'hello' } })), 'self');
  assert.equal(crowded.queue.length, 100); assert.ok(crowded.queue.some(e => e.event_id === 'life_gather_cancelled-self'));
  const runner = new PlazaRunner({ mode: 'model', now: () => 15000 });
  runner.rules = {}; runner.checkpoint = { queue: [], calls_used: 7 }; runner.lastDecisionAt = 5000; runner.observedAt = 15000;
  runner.observation = { server_time: 15000, self: { agent_id: 'self', life: { gathering: { phase: 'approaching', ends_at: null, expires_at: 120000 } } } };
  assert.equal(runner.decisionDue(), false, '接近中不因null结束时间逐格请求'); assert.equal(runner.checkpoint.calls_used, 7);
});

for (const mode of ['model', 'dsh-pet']) test(`${mode}原AI一次选择节点后真实走路采集，只有一次产出且身份预算期限不变`, async t => {
  const f = observed(t), { world, a, c } = f; a.position = { x: 11, y: 8 };
  const auth = world.authenticate(c.token), calls = [], prompts = [];
  let selected = action('gather', { intent: 'start', node_id: 'orchard_berries', mode: 'walk' });
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }), close: async () => {},
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args: structuredClone(args) }); return { structuredContent: world.callTool(auth, name, args) }; } };
  const runner = new PlazaRunner({ mode, now: () => f.now, toolClient: client,
    petClient: { initialize: async () => {}, prepareDecision: prepareDecisionPrompt, decide: async (_, { prepared, onRequest }) => { prompts.push(prepared.text); await onRequest(); return expandDecisionReferences(JSON.stringify(selected), prepared.references); } },
    model: { baseUrl: 'https://original.invalid/v1', model: 'original', apiKey: 'PRIVATE_TEST' },
    fetchImpl: async (_, request) => { prompts.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected) } }] }) }; } });
  runner.running = true; runner.abort = new AbortController(); t.after(async () => runner.stop());
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const startPosition = { ...a.position }, run = { id: a.run.run_id, expires: a.run.expires_at, max: a.run.max_calls }, identity = a.agent_id;
  await runner.decide();
  assert.equal(a.life.gathering.node_id, 'orchard_berries'); assert.equal(a.life.gathering.phase, 'approaching'); assert.deepEqual(a.position, startPosition);
  assert.equal(a.life.inventory.berry || 0, 0); assert.equal(runner.checkpoint.calls_used, 1);
  for (let i = 0; i < 10; i++) { f.advance(100); world.tick(); }
  assert.notDeepEqual(a.position, startPosition);
  runner.observation = world.observation(a); runner.observedAt = f.now; assert.equal(runner.decisionDue(), false);
  for (let i = 0; i < 400 && a.life.gathering; i++) { f.advance(100); world.callTool(auth, 'observe', runner.session()); world.tick(); }
  assert.equal(a.life.gathering, null); assert.equal(a.life.inventory.berry, 2); assert.equal(world.state.resources.nodes.orchard_berries.stock, 3);
  for (let i = 0; i < 100; i++) { f.advance(100); world.callTool(auth, 'observe', runner.session()); world.tick(); }
  assert.equal(a.life.inventory.berry, 2); assert.equal(runner.checkpoint.calls_used, 1); assert.equal(calls.filter(c => c.name === 'act').length, 1);
  assert.equal(a.agent_id, identity); assert.deepEqual({ id: a.run.run_id, expires: a.run.expires_at, max: a.run.max_calls }, run);
  assert.equal(runner.capabilities().length, 16); assert.ok(runner.capabilities().includes('gathering'));
  if (mode === 'model') { assert.match(prompts[0].messages[0].content, /node_id/); assert.equal(JSON.parse(prompts[0].messages[1].content).observation.resources.version, 1); }
  else assert.ok(prompts[0].length <= 2000);
  selected = action('wait'); await runner.decide(); assert.equal(a.life.gathering, null); assert.equal(calls.filter(c => c.name === 'act').length, 1);
});
