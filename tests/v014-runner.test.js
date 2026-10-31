import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { prepareDecisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const action = (type, payload = {}) => ({ type, payload });
const preparedByText = new Map();
const decisionPrompt = context => { const p = prepareDecisionPrompt(context); preparedByText.set(p.text, p.references || {}); return p.text; };
const decode = prompt => {
  const references = preparedByText.get(prompt) || {};
  const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : Object.hasOwn(references, value) ? references[value] : value;
  return expand(JSON.parse(prompt.split('公开数据：')[1]));
};
async function fixture(t, mode = 'dsh-pet') {
  let now = Date.now(), answer = action('wait');
  const world = new World({ now: () => now, actionIntervalMs: 0 }), record = world.createAgent({ name: '原探索者' });
  const controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100, duration_minutes: 30 });
  const auth = world.authenticate(controller.token), calls = [], contexts = [], prompts = [];
  const runner = new PlazaRunner({ mode, now: () => now, idleMs: 60000,
    toolClient: { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
      callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; }, close: async () => {} },
    petClient: { decide: async input => { const prompt = decisionPrompt(input); assert.ok(prompt.length <= 2000); prompts.push(prompt); contexts.push(decode(prompt)); return JSON.stringify(answer); } },
    model: { baseUrl: 'https://original.invalid/v1', model: 'original-test-double', apiKey: 'PRIVATE' },
    fetchImpl: async (_, options) => { const messages = JSON.parse(options.body).messages; prompts.push(messages[0].content); contexts.push(JSON.parse(messages[1].content));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }; } });
  runner.running = true; runner.abort = new AbortController(); await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = () => world.agent(record.agent_id); a().position = { x: 11, y: 8 };
  const refresh = () => { runner.observation = world.observation(a()); runner.observedAt = now; };
  const advance = ms => { while (ms > 0) { const step = Math.min(ms, 1000); now += step; ms -= step; world.callTool(auth, 'observe', runner.session()); world.tick(); } refresh(); };
  const decide = async next => { answer = next; advance(6000); await runner.decide(); };
  refresh(); t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, auth, get a() { return a(); }, calls, contexts, prompts, refresh, advance, decide };
}

test('探索与公开目标解析严格，不接收自报奖励、私人身份、无界队列或过时确认参数', () => {
  for (const value of [action('adventure_event', { event_id: 'event1', choice_id: 'decline' }),
    action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 2, title: '想收集木材' }),
    action('inventory', { intent: 'equip', item_id: 'hunter_bow' }),
    ...['confirm', 'cancel'].map(intent => action('personal_goal', { intent, goal_id: 'goal1' }))]) assert.deepEqual(parseModelAction(JSON.stringify(value)), value);
  for (const value of [action('inventory', { intent: 'equip', item_id: 'hunter_bow', slot: 'weapon' }), action('adventure_event', { event_id: 'event1', choice_id: 'wood', reward: 999 }),
    action('personal_goal', { intent: 'confirm' }), action('personal_goal', { intent: 'cancel', goal_id: 'goal1', duration_seconds: 1800 }),
    ...[0, 11, 1.5].map(target_count => action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count })),
    action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 1, goal_id: 'old' }),
    action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 1, duration_seconds: 1801 }),
    action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 1, title: '🐾'.repeat(61) })]) assert.throws(() => parseModelAction(JSON.stringify(value)), { code: 'INVALID_MODEL_OUTPUT' });
});

test('pending选择在极限2000UTF16内保留主人/消息/三威胁/成本/食物/移动回执', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation), self = observation.self;
  self.scene_id = 'adventure';
  self.adventure.encounter = { event_id: 'encounter_' + 'e'.repeat(36), status: 'pending', expires_at: observation.server_time + 150000,
    choices: [{ choice_id: 'wood', energy_cost: 4, items: { wood: 2 }, heal: 0, restore_energy: 0 }, { choice_id: 'ore', energy_cost: 4, items: { ore: 1 }, heal: 0, restore_energy: 0 }, { choice_id: 'decline', energy_cost: 0, items: {}, heal: 0, restore_energy: 0 }] };
  self.adventure.hp = 8; self.fatigue.energy = 1; self.life.inventory.wheat_bread = 1; self.life.inventory.turnip = 1;
  const friend = 'agent_' + 'f'.repeat(36); observation.group = { members: [self.agent_id, friend] };
  observation.adventure.monsters.forEach((monster, i) => Object.assign(monster, { behavior: 'attacking', target_agent_id: i === 2 ? friend : self.agent_id }));
  self.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), kind: 'collect_item', target_id: 'wood', target_count: 10, progress: 1, status: 'needs_review', title: '🐾'.repeat(60), expires_at: observation.server_time + 500000 };
  const ownerGoal = '🐾'.repeat(300), message = '🌱'.repeat(200), feedback = { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } };
  const prompt = decisionPrompt({ observation, rules: f.runner.rules, ownerGoal, correction: true, lastActionFeedback: feedback,
    events: [{ type: 'message', payload: { agent_id: friend, text: message } }] }), data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events[0].text, message);
  const original = decisionPrompt({ observation, rules: f.runner.rules, ownerGoal, correction: false, lastActionFeedback: feedback, events: [{ type: 'message', payload: { agent_id: friend, text: message } }] });
  assert.ok(original.length <= 2000); assert.notEqual(prompt, original); assert.match(prompt, /纠正\{type,payload\}的键\/类型/); assert.deepEqual(decode(original), data);
  assert.match(prompt, /adventure_event\{event_id,choice_id\}/);
  assert.equal(data.event[0], self.adventure.encounter.event_id); assert.equal(data.event[2].length, 3); assert.equal(data.event[1], 150);
  assert.equal(data.foes.length, 3); assert.equal(data.E, 1); assert.equal(data.food.length, 2);
  assert.match(prompt, /personal_goal\{intent:confirm\|cancel,goal_id\}/);
  assert.deepEqual(data.receipt.slice(2), [[999, -999], [4, 11]]);
  assert.deepEqual(data.goal, [self.personal_goal.goal_id, 'needs_review', 'collect_item', 'wood', 1, 10, 500]);
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}探索发现可等待或拒绝，旧hunt被真实拒绝，选择由原AI提交`, async t => {
  const f = await fixture(t, mode); f.a.scene_id = 'adventure'; f.a.adventure.discovery_sequence = 0;
  await f.decide(action('adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(16000);
  const encounter = f.a.adventure.encounter; assert.equal(encounter.status, 'pending');
  const deadline = encounter.expires_at, inventory = structuredClone(f.a.life.inventory);
  await f.decide(action('wait')); assert.equal(f.a.adventure.encounter.expires_at, deadline); assert.deepEqual(f.a.life.inventory, inventory);
  f.advance(5000); assert.equal(f.runner.decisionDue(), false);
  await f.decide(action('adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }));
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'ENCOUNTER_PENDING'); assert.equal(f.a.adventure.encounter.status, 'pending');
  await f.decide(action('adventure_event', { event_id: encounter.event_id, choice_id: 'decline' }));
  assert.equal(f.a.adventure.encounter.status, 'declined'); assert.deepEqual(f.a.life.inventory, inventory);
});

for (const mode of ['dsh-pet', 'model']) test(`${mode}公开短期目标仅记录选择后的实际结果，暂停后须本人确认且不自动工作`, async t => {
  const f = await fixture(t, mode);
  await f.decide(action('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 2, title: '准备两份木材' }));
  const goalId = f.a.personal_goal.goal_id, deadline = f.a.personal_goal.expires_at;
  assert.equal(f.a.personal_goal.progress, 0); assert.equal(f.a.life.gathering, null);
  await f.decide(action('wait')); assert.equal(f.a.personal_goal.progress, 0);
  f.world.ownerControl(f.a.agent_id, 'pause'); f.runner.deactivate();
  f.world.ownerControl(f.a.agent_id, 'resume'); await f.runner.activate(f.world.callTool(f.auth, 'get_control_state')); f.refresh();
  assert.equal(f.a.personal_goal.status, 'needs_review'); assert.equal(f.a.personal_goal.expires_at, deadline);
  await f.decide(action('wait')); assert.equal(f.a.personal_goal.status, 'needs_review'); assert.equal(f.a.life.gathering, null);
  await f.decide(action('personal_goal', { intent: 'confirm', goal_id: goalId })); assert.equal(f.a.personal_goal.status, 'active');
  await f.decide(action('gather', { intent: 'start', resource_id: 'wood' })); f.advance(13000);
  assert.equal(f.a.personal_goal.progress, 1); assert.equal(f.a.life.gathering, null);
  await f.decide(action('personal_goal', { intent: 'cancel', goal_id: goalId })); assert.equal(f.a.personal_goal.status, 'cancelled');
});

test('发现和目标复核按本人/队友筛选，普通目标进度不触发自动劳动循环', () => {
  const types = ['exploration_found', 'exploration_resolved', 'exploration_ended', 'personal_goal_set', 'personal_goal_progress', 'personal_goal_review', 'personal_goal_ended'];
  const events = ['self', 'friend', 'stranger'].flatMap(agent_id => types.map(type => ({ event_id: `${agent_id}:${type}`, type, payload: { agent_id } })));
  const result = enqueueEvents({ queue: [], seen: [] }, events, 'self', ['friend']);
  assert.equal(result.queue.length, 10); assert.ok(result.queue.every(e => !/stranger|personal_goal_set|personal_goal_progress/.test(e.event_id)));
});

test('装备有效属性与比较可读，16能力只在完整支持时报告，旧服保持12', async t => {
  const f = await fixture(t); Object.assign(f.a.life.inventory, { hunter_bow: 1, heavy_hammer: 1, heavy_armor: 1 }); f.refresh();
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.runner.rules }), data = decode(prompt);
  assert.match(prompt, /personal_goal\{intent:set/); assert.ok(data.goals.some(([kind, ids]) => kind === 'resolve_exploration' && ids.includes('forest')));
  assert.deepEqual(data.gear.find(row => row[0] === 'heavy_armor').slice(4, 7), [null, null, null]); assert.ok(data.combat); assert.ok(data.gear?.some(row => row[0] === 'hunter_bow' && row[4] === 3 && row[5] === 2000 && row[6] === 2));
  assert.match(prompt, /inventory\{intent:craft\|equip,item_id\}仅这两键/); assert.match(prompt, /槽\(只读\)/);
  assert.equal(f.runner.capabilities().length, 16);
  const old = structuredClone(f.runner.rules); old.max_capabilities = 12; delete old.personal_goals; delete old.adventure.exploration; delete old.life.strategy_equipment;
  old.allowed_actions = old.allowed_actions.filter(type => !['personal_goal', 'adventure_event'].includes(type)); f.runner.rules = old;
  assert.equal(f.runner.capabilities().length, 12); f.runner.mode = 'demo'; assert.deepEqual(f.runner.capabilities(), []);
});


test('长消息下野外目标复核仍含完整目标语义，不能盲目确认ID', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation), self = observation.self;
  const friend = 'agent_' + 'f'.repeat(36), message = '🌱'.repeat(200), ownerGoal = '🐾'.repeat(300);
  Object.assign(self.adventure, { in_field: true, hp: 8, decision_until: observation.server_time + 30000,
    plan: { intent: 'hunt', monster_id: 'ruins_guardian', zone_id: 'ruins', expires_at: observation.server_time + 90000 } });
  self.fatigue.energy = 1; self.life.inventory.turnip = 2; self.life.inventory.wheat_bread = 1;
  self.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), kind: 'collect_item', target_id: 'wood', target_count: 10, progress: 1, status: 'needs_review', expires_at: observation.server_time + 500000 };
  observation.group = { members: [self.agent_id, friend] }; observation.adventure.monsters.forEach((m, i) => Object.assign(m, { behavior: 'attacking', target_agent_id: i === 1 ? friend : self.agent_id }));
  const prompt = decisionPrompt({ observation, rules: f.runner.rules, ownerGoal,
    lastActionFeedback: { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } },
    events: [{ type: 'message', payload: { agent_id: friend, text: message } }] });
  const data = decode(prompt); assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events[0].text, message);
  assert.deepEqual(data.goal, [self.personal_goal.goal_id, 'needs_review', 'collect_item', 'wood', 1, 10, 500]);
  assert.equal(data.foes.length, 3); assert.equal(data.E[0], 1); assert.equal(data.food.length, 2); assert.equal(data.protection, 30);
  assert.equal(data.plan[1], 'ruins_guardian'); assert.ok(data.combat); assert.deepEqual(data.receipt.slice(2), [[999, -999], [4, 11]]);
  const corrected = decisionPrompt({ observation, rules: f.runner.rules, ownerGoal, correction: true, lastActionFeedback: { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } }, events: [{ type: 'message', payload: { agent_id: friend, text: message } }] });
  assert.ok(corrected.length <= 2000); assert.notEqual(corrected, prompt); assert.deepEqual(decode(corrected), data); assert.match(corrected, /纠正\{type,payload\}的键\/类型/);
});


test('营地老玩家有金币和料理时仍知道可自选公开目标，等待不自动设置', async t => {
  const f = await fixture(t); f.a.adventure.gold = 20; f.a.life.inventory.turnip = 2; f.a.life.inventory.wheat = 2; Object.assign(f.a.life.plots[0], { tilled: true, crop_id: 'wheat', planted_at: f.runner.now(), ready_at: f.runner.now() + 60000 }); f.refresh();
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.runner.rules });
  assert.ok(prompt.length <= 2000); assert.match(prompt, /personal_goal\{intent:set/); assert.match(prompt, /仅这两键，勿传slot/); for (const id of ['hunter_bow', 'heavy_hammer', 'heavy_armor', 'collect_item/', 'cook_item/', 'resolve_exploration/', 'defeat_monster/']) assert.ok(prompt.includes(id)); assert.equal(f.a.personal_goal, null);
});


for (const kind of ['word_chain', 'riddle']) test(kind + '在长主人要求和消息下仍可理解目标复核', async t => {
  const f = await fixture(t), observation = structuredClone(f.runner.observation), self = observation.self;
  self.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), kind: 'cook_item', target_id: 'wheat_bread', target_count: 2, progress: 1, status: 'needs_review', expires_at: observation.server_time + 500000, title: '🐾'.repeat(60) };
  if (kind === 'riddle') self.activity = { activity_id: 'riddle', started_at: observation.server_time, ends_at: observation.server_time + 60000, task: { kind: 'riddle', prompt: '什么东西越洗越脏？', answer_type: 'string' } };
  else observation.game = { game_id: 'game_' + 'g'.repeat(36), game_type: kind, status: 'active', participants: [self.agent_id], current_agent_id: self.agent_id, turn_id: 'turn_' + 't'.repeat(36), last_word: '气球' };
  const ownerGoal = '🐾'.repeat(300), message = '🌱'.repeat(200);
  const prompt = decisionPrompt({ observation, rules: f.runner.rules, ownerGoal, events: [{ type: 'message', payload: { agent_id: 'friend', text: message } }] });
  const data = decode(prompt); assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
  assert.deepEqual(data.personal_goal, [self.personal_goal.goal_id, 'needs_review', 'cook_item', 'wheat_bread', 1, 2, 500]);
  if (kind === 'riddle') assert.equal(data.task.prompt, self.activity.task.prompt); else assert.equal(data.game.turn_id, observation.game.turn_id);
});


for (const mode of ['dsh-pet', 'model']) test(mode + '探索实际收益在新聊天到来后仍交还原AI', async t => {
  const f = await fixture(t, mode); f.a.scene_id = 'adventure'; f.a.adventure.discovery_sequence = 0;
  await f.decide(action('adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(16000);
  const eventId = f.a.adventure.encounter.event_id; assert.ok(f.runner.observation.self.adventure.encounter.choices.some(c => c.choice_id === 'wood'));
  await f.decide(action('adventure_event', { event_id: eventId, choice_id: 'wood' }));
  const result = structuredClone(f.a.adventure.encounter.public_result); assert.equal(result.items.wood, 2); assert.equal(result.energy, -4);
  f.runner.goal = '主'.repeat(300); const message = '友'.repeat(200);
  f.runner.checkpoint.queue = [{ event_id: 'social-after-result', type: 'message', payload: { agent_id: 'friend', text: message } }];
  await f.decide(action('wait')); const context = f.contexts.at(-1);
  if (mode === 'dsh-pet') { assert.deepEqual(context.discovery, ['resolved', 'wood', { wood: 2 }, 0, -4]); assert.equal(context.events.at(-1).text, message); }
  else assert.deepEqual(context.observation.self.adventure.encounter.public_result, result);
});


test('pending的格式重试实际告知原AI纠正，只有后续合法回答才执行', async t => {
  const f = await fixture(t); f.a.scene_id = 'adventure'; await f.decide(action('adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(16000);
  const eventId = f.a.adventure.encounter.event_id, prompts = [], flags = [], before = f.runner.checkpoint.calls_used;
  f.runner.petClient.decide = async context => {
    const prompt = decisionPrompt(context); assert.ok(prompt.length <= 2000); prompts.push(prompt); flags.push(context.correction);
    return JSON.stringify(context.correction ? action('adventure_event', { event_id: eventId, choice_id: 'decline' }) : action('inventory', { intent: 'equip', item_id: 'hunter_bow', slot: 'weapon' }));
  };
  await f.decide(action('wait'));
  assert.deepEqual(flags, [false, true]); assert.notEqual(prompts[0], prompts[1]); assert.deepEqual(decode(prompts[0]), decode(prompts[1]));
  assert.equal(f.runner.checkpoint.calls_used, before + 2); assert.equal(f.a.adventure.encounter.status, 'declined');
  assert.equal(f.calls.filter(c => c.name === 'act' && c.args.type === 'inventory').length, 0);
  assert.equal(f.calls.filter(c => c.name === 'act' && c.args.type === 'adventure_event').length, 1);
});
