import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, enqueueEvents } from '../runner/runner.js';
import { decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
const action = (type, payload = {}) => ({ type, payload });
async function fixture(t, choose, mode = 'dsh-pet') {
  let now = Date.now();
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '原来的我' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const auth = world.authenticate(controller.token), calls = [], prompts = [], contexts = [];
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; }, close: async () => {} };
  // World/permissions/receipts/fatigue are real. Only the original model's answer
  // is substituted so both choosing rest and choosing wait are deterministic.
  const reply = data => { contexts.push(data); return JSON.stringify(choose(data)); };
  const runner = new PlazaRunner({ mode, toolClient: client, now: () => now, idleMs: 30000,
    petClient: { initialize: async () => {}, decide: async input => { const prompt = decisionPrompt(input); prompts.push(prompt); return reply(decode(prompt)); } },
    model: { baseUrl: 'https://original.invalid/v1', model: 'test-double', apiKey: 'PRIVATE' },
    fetchImpl: async (_, options) => ({ ok: true, json: async () => ({ choices: [{ message: { content: reply(JSON.parse(JSON.parse(options.body).messages[1].content)) } }] }) }) });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = world.agent(record.agent_id);
  const refresh = () => { runner.observation = world.observation(world.agent(record.agent_id)); runner.observedAt = now; };
  const advance = ms => { while (ms > 0) { const step = Math.min(1000, ms); now += step; ms -= step; world.callTool(auth, 'observe', runner.session()); world.tick(); } refresh(); };
  const enqueue = () => { runner.checkpoint = enqueueEvents(runner.checkpoint, world.state.events, a.agent_id); };
  t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, get a() { return world.agent(record.agent_id); }, calls, prompts, contexts, advance, refresh, enqueue };
}

for (const mode of ['dsh-pet', 'model']) test(`${mode}真实狩猎耗尽后唤醒本人，wait不变成休息，随后本人可选择rest`, async t => {
  let answer = action('adventure_plan', { intent: 'hunt', monster_id: 'ruins_guardian' });
  const f = await fixture(t, () => answer, mode);
  f.a.position = { x: 19, y: 7 }; f.a.fatigue.energy = 12;
  f.a.adventure.hp = f.a.adventure.max_hp = 1000;
  const monster = f.world.state.adventure.monsters[2]; monster.hp = monster.max_hp = 1000; monster.attack = 0;
  await f.runner.decide(); f.advance(5000); f.enqueue();
  assert.equal(f.a.adventure.plan, null); assert.equal(f.a.fatigue.energy, 0);
  assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'fatigue_exhausted'));
  assert.equal(f.runner.decisionDue(), true);
  answer = action('wait'); await f.runner.decide();
  assert.equal(f.a.adventure.plan, null); assert.equal(f.a.adventure.in_field, true);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 1);
  const context = f.contexts.at(-1);
  assert.equal(mode === 'model' ? context.observation.self.fatigue.energy : context.energy[0], 0);
  answer = action('adventure_plan', { intent: 'rest' }); f.advance(30000);
  assert.equal(f.runner.decisionDue(), true); await f.runner.decide();
  assert.equal(f.a.adventure.plan?.intent, 'rest', JSON.stringify({ error: f.runner.lastError, feedback: f.runner.checkpoint.last_action_feedback, context: f.contexts.at(-1) }));
  assert.equal(f.runner.checkpoint.calls_used, 3);
  assert.ok(f.calls.findLast(c => c.name === 'report_status').args.capabilities.includes('fatigue'));
  f.advance(12000); assert.ok(f.a.fatigue.energy > 0);
});

for (const resting of [false, true]) test(`真实劳作疲劳通知后原AI选择${resting ? 'relax' : 'wait'}，没有强制换玩法`, async t => {
  const f = await fixture(t, () => resting ? action('start_activity', { activity_id: 'relax' }) : action('wait'));
  f.a.position = { x: 11, y: 8 }; f.a.fatigue.energy = 26;
  f.world.perform(f.a, 'inventory', { intent: 'craft', item_id: 'wooden_sword' }); f.refresh(); f.enqueue();
  assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'fatigue_tired'));
  await f.runner.decide();
  assert.equal(f.a.activity?.activity_id || null, resting ? 'relax' : null);
  assert.equal(f.calls.filter(c => c.name === 'act').length, resting ? 1 : 0);
  assert.equal(f.a.adventure.plan, null);
  assert.equal(f.contexts.at(-1).energy[0], 24);
  f.advance(5000);
  assert.equal(f.a.fatigue.energy, resting ? 32 : 25.2);
});

test('低体力hunt真实拒绝反馈与门槛交回原AI，不重复每轮询请求；下一次可选择rest', async t => {
  const f = await fixture(t, data => data.last_action?.code === 'FATIGUE_EXHAUSTED'
    ? action('adventure_plan', { intent: 'rest' }) : action('adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }));
  f.a.position = { x: 19, y: 7 }; f.a.fatigue.energy = 5; f.refresh();
  await f.runner.decide();
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'FATIGUE_EXHAUSTED');
  f.advance(5000); assert.equal(f.runner.decisionDue(), false);
  f.advance(25000); assert.equal(f.runner.decisionDue(), true); await f.runner.decide();
  assert.equal(f.a.adventure.plan?.intent, 'rest', JSON.stringify({ error: f.runner.lastError, feedback: f.runner.checkpoint.last_action_feedback, context: f.contexts.at(-1) }));
  const context = f.contexts.at(-1);
  assert.deepEqual(context.energy, [5, 0.75, 12]);
  assert.equal(context.last_action.status, 'rejected');
  assert.equal(context.opportunities?.some(o => o.action.payload.intent === 'hunt') || false, false);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 2);
});

test('疲劳仅本人/组友已知事件唤醒，陌生人和每秒未知事件不入队，重复ID不重复', () => {
  const own = { event_id: 'own', type: 'fatigue_exhausted', payload: { agent_id: 'self' } };
  const events = [own, own, { event_id: 'friend', type: 'fatigue_tired', payload: { agent_id: 'friend' } },
    { event_id: 'stranger', type: 'fatigue_tired', payload: { agent_id: 'stranger' } },
    { event_id: 'tick', type: 'fatigue_tick', payload: { agent_id: 'self' } }];
  assert.deepEqual(enqueueEvents({ queue: [], seen: [] }, events, 'self', ['friend']).queue.map(e => e.event_id), ['own', 'friend']);
  const crowded = enqueueEvents({ queue: [], seen: [] }, [...events, ...Array.from({ length: 130 }, (_, i) => ({ event_id: `m${i}`, type: 'message', payload: { agent_id: 'other' } }))], 'self', ['friend']);
  assert.ok(crowded.queue.some(e => e.event_id === 'own')); assert.ok(crowded.queue.some(e => e.event_id === 'friend'));
});

test('疲劳事实进入本人游戏和独处路由，保留回合/题面、原目标与最新消息', async t => {
  const f = await fixture(t, () => action('wait')); f.a.fatigue.energy = 10;
  for (const kind of ['game', 'solo']) {
    const observation = f.world.observation(f.a);
    if (kind === 'game') observation.game = { game_id: 'game-current', game_type: 'word_chain', status: 'active', participants: [f.a.agent_id], current_agent_id: f.a.agent_id, turn_id: 'turn-current', last_word: '气球' };
    else observation.self.activity = { activity_id: 'riddle', place_id: 'game_corner', started_at: 1000000, ends_at: 1100000, task: { kind: 'riddle', prompt: '什么东西越洗越脏？', answer_type: 'string' } };
    const ownerGoal = '主'.repeat(300), message = '友'.repeat(200);
    const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, correction: true, events: [{ type: 'message', payload: { agent_id: 'friend', text: message } }] });
    const data = decode(prompt);
    assert.ok(prompt.length <= 2000); assert.deepEqual(data.energy, [10, 0.75, 12]);
    assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message); assert.match(prompt, /rest\/relax/);
    if (kind === 'game') assert.equal(data.game.turn_id, 'turn-current'); else assert.equal(data.task.prompt, observation.self.activity.task.prompt);
  }
});

test('UTF-16游戏和题目保留300字目标、200字消息、疲劳、当前回合与移动实际回执', async t => {
  const f = await fixture(t, () => action('wait')); f.a.fatigue.energy = 10;
  const friend = 'agent_' + 'f'.repeat(36), ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200);
  const feedback = { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 100, y: -100 }, applied: { x: 11, y: 6 } };
  for (const kind of ['word_chain', 'rock_paper_scissors', 'riddle']) {
    const observation = f.world.observation(f.a);
    observation.group = { group_id: 'group_' + 'g'.repeat(36), members: [f.a.agent_id, friend] };
    if (kind === 'riddle') observation.self.activity = { activity_id: 'riddle', place_id: 'game_corner', ends_at: observation.server_time + 60000, task: { kind: 'riddle', prompt: '什么东西越洗越脏？', answer_type: 'string' } };
    else observation.game = { game_id: 'game_' + 'g'.repeat(36), game_type: kind, status: 'active', participants: [f.a.agent_id], current_agent_id: f.a.agent_id, turn_id: 'turn_' + 't'.repeat(36), last_word: '气球' };
    const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, correction: true, lastActionFeedback: feedback,
      events: [{ type: 'message', payload: { agent_id: friend, text: message } }] });
    const data = decode(prompt);
    assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
    assert.deepEqual(data.energy, [10, 0.75, 12]); assert.deepEqual(data.last_action.requested, feedback.requested); assert.deepEqual(data.last_action.applied, feedback.applied);
    if (kind === 'riddle') assert.equal(data.task.prompt, observation.self.activity.task.prompt);
    else { assert.equal(data.game.turn_id, observation.game.turn_id); assert.equal(data.game.game_id, observation.game.game_id); }
  }
});

for (const activePlan of [false, true]) test(`UTF-16极限${activePlan ? '含进行中狩猎' : '无计划'}：300个emoji目标、200个emoji消息、三追击者、疲劳/食物/移动回执和格式重试完整保留`, async t => {
  const f = await fixture(t, () => action('wait')), observation = f.world.observation(f.a);
  const friend = 'agent_' + 'f'.repeat(36), ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200);
  observation.self.fatigue.energy = 0; observation.self.fatigue.attack_multiplier = 0.75;
  observation.self.life.inventory.turnip = 2; observation.self.life.inventory.wheat = 2;
  observation.self.name = '🌷'.repeat(20);
  Object.assign(observation.self.adventure, { in_field: true, hp: 8, decision_until: observation.server_time + 30000 });
  if (activePlan) observation.self.adventure.plan = { intent: 'hunt', monster_id: 'ruins_guardian', zone_id: 'ruins', expires_at: observation.server_time + 90000 };
  observation.group = { group_id: 'group_' + 'g'.repeat(36), members: [f.a.agent_id, friend] };
  observation.adventure.monsters.forEach((m, i) => { m.behavior = 'attacking'; m.target_agent_id = i === 1 ? friend : f.a.agent_id; });
  const feedback = { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 100, y: -100 }, applied: { x: 11, y: 6 } };
  const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, correction: true, lastActionFeedback: feedback,
    events: [{ type: 'fatigue_exhausted', payload: { agent_id: f.a.agent_id, text: '体力不足' } }, { type: 'message', payload: { agent_id: friend, text: message } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal)); assert.equal(data.events.at(-1).text, message);
  assert.deepEqual(data.energy, [0, 0.75, 12]); assert.equal(data.adventure.monsters.length, 3);
  assert.ok(data.adventure.monsters.some(row => row[6] === friend)); assert.ok(data.food.some(row => row[0] === 'turnip'));
  assert.equal(data.self.adventure.hp, 8); assert.equal(data.self.adventure.decision_seconds, 30);
  if (activePlan) assert.deepEqual({ intent: data.self.adventure.plan.intent, monster_id: data.self.adventure.plan.monster_id }, { intent: 'hunt', monster_id: 'ruins_guardian' });
  assert.deepEqual(data.last_action.requested, feedback.requested); assert.deepEqual(data.last_action.applied, feedback.applied);
  assert.match(prompt, /rest\/relax/); assert.match(prompt, /不强制/); assert.match(prompt, /不向广场复述/);
});
