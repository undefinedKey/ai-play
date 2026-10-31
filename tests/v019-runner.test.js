import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { toolDefinitions } from '../server/mcp.js';
import { movementContext, normalizeMove, motionPromptNotice } from '../skills/ai-plaza/scripts/movement.mjs';

const modes = { walk: { speed: 2, energy_multiplier: 1 }, run: { speed: 3.5, energy_multiplier: 2 } };
const rule = { version: 2, max_step: 3, modes };
const action = (type, payload) => ({ type, payload });
const parse = a => parseModelAction(JSON.stringify(a));

test('原AI可明确选择走跑且可省略mode，停止不隐含速度或新的目标', () => {
  for (const mode of [undefined, 'walk', 'run']) for (const a of [
    action('move', { x: 12, y: 8, ...(mode ? { mode } : {}) }),
    action('adventure_plan', { intent: 'explore', zone_id: 'forest', ...(mode ? { mode } : {}) }),
    action('adventure_plan', { intent: 'hunt', monster_id: 'forest_slime', ...(mode ? { mode } : {}) }),
    action('adventure_plan', { intent: 'retreat', ...(mode ? { mode } : {}) }),
  ]) assert.deepEqual(parse(a), a);
  assert.deepEqual(parse(action('adventure_plan', { intent: 'stop' })), action('adventure_plan', { intent: 'stop' }));
  for (const a of [action('move', { x: 12, y: 8, mode: 'sprint' }), action('move', { x: 12.2, y: 8 }),
    action('adventure_plan', { intent: 'stop', mode: 'walk' }), action('adventure_plan', { intent: 'stop', monster_id: 'm' }),
    action('adventure_plan', { intent: 'explore', zone_id: 'forest', speed: 9 })]) {
    assert.throws(() => parse(a), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

test('连续路径候选保留真实小数起点，按实际长度预算且不接受斜线或另一场景', () => {
  const o = { self: { scene_id: 'plaza', position: { x: 1.4, y: 1 } }, movement: { ...rule, scene_id: 'plaza', map: { width: 8, height: 6 }, candidates: [
    { x: 4, y: 1, path: [{ x: 1.4, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }] },
    { x: 1, y: 3, path: [{ x: 1.4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }] },
    { x: 2, y: 2, path: [{ x: 1.4, y: 1 }, { x: 2, y: 2 }] },
    { x: 4, y: 2, path: [{ x: 1.4, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 2 }] },
    { x: 3, y: 1, path: [{ x: 1.4, y: 1 }, { x: 2.4, y: 1 }, { x: 3, y: 1 }] },
  ] } };
  const result = movementContext(o, {});
  assert.deepEqual(result.candidates.map(p => [p.x, p.y]), [[4, 1], [1, 3]]);
  assert.deepEqual(result.candidates[0].path[0], o.self.position); assert.deepEqual(result.modes, modes);
  const chosen = action('move', { x: 4, y: 1, mode: 'run' });
  assert.deepEqual(normalizeMove(chosen, o).action, chosen, '桥不能替原AI把跑改成走，也不重算已有障碍路径');
  assert.equal(movementContext({ ...o, movement: { ...o.movement, scene_id: 'adventure' } }), null);
  assert.equal(movementContext({ ...o, movement: { ...o.movement, version: undefined } }), null, '旧协议不猜测小数几何');
  const old = normalizeMove(action('move', { x: 99, y: 0, mode: 'run' }), { self: { position: { x: 1, y: 1 } } }, { room: { width: 8, height: 6 }, max_move: 3 });
  assert.equal(old.action.payload.mode, 'run', '旧规则只限制目标，不默默更改调用者选择；旧服可拒绝未支持字段');
});

test('仅本人手动移动结束/耗尽可唤醒，计划每步与显式stop不制造模型循环', () => {
  const events = [
    { event_id: 'arrived', type: 'movement_finished', payload: { agent_id: 'self', reason: 'arrived' } },
    { event_id: 'tired', type: 'movement_finished', payload: { agent_id: 'self', reason: 'exhausted' } },
    { event_id: 'stop', type: 'movement_finished', payload: { agent_id: 'self', reason: 'stopped' } },
    { event_id: 'other', type: 'movement_finished', payload: { agent_id: 'peer', reason: 'arrived' } },
    { event_id: 'step', type: 'adventure_moved', payload: { agent_id: 'self' } },
    { event_id: 'attack', type: 'adventure_attack_started', payload: { agent_id: 'self' } },
  ];
  const state = enqueueEvents({}, events, 'self', ['peer']);
  assert.deepEqual(state.queue.map(e => e.event_id), ['arrived', 'tired']);
  assert.deepEqual(enqueueEvents(state, events, 'self').queue, state.queue);
  const runner = new PlazaRunner({ mode: 'model', now: () => 20000 });
  runner.checkpoint = { ...state, calls_used: 3 }; runner.lastDecisionAt = 18000;
  assert.equal(runner.decisionDue(), false, '结束事件也遵守模型请求间隔');
  runner.lastDecisionAt = 10000; assert.equal(runner.decisionDue(), true);
  assert.equal(runner.checkpoint.calls_used, 3, '唤醒不代表调用或自动接受下一活动');
});

function observation(t) {
  const now = 1793400000000, world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const record = world.createAgent({ name: '原AI' }), a = world.agent(record.agent_id), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const o = world.observation(a), rules = world.getRules();
  rules.movement = structuredClone(rule); Object.assign(o.movement, structuredClone(rule));
  o.self.position = { x: 11.4, y: 8 }; o.self.facing = 'east';
  o.self.movement = { version: 2, scene_id: o.self.scene_id, mode: 'run', path: [{ x: 11.4, y: 8 }, { x: 12, y: 8 }], started_at: now - 100, ends_at: now + 200 };
  o.movement.candidates = [{ x: 12, y: 8, path: [{ x: 11.4, y: 8 }, { x: 12, y: 8 }] }];
  return { o, rules, now };
}

test('旧服不宣传走跑，新服提示给真实走跑代价与动作阶段而非已到达', t => {
  const { o, rules, now } = observation(t);
  assert.equal(motionPromptNotice({ self: { position: { x: 1, y: 1 } } }, {}), '');
  const p = prepareDecisionPrompt({ observation: o, rules });
  assert.match(p.text, /mode:walk\|run/); assert.match(p.text, /走\/跑2\/3\.5格秒、耗体×1\/2/);
  assert.match(p.text, /当前朝东，跑往12,8余0\.2秒/); assert.match(p.text, /接受移动≠已到达/);
  assert.ok(p.text.length <= 2000); assert.doesNotThrow(() => JSON.parse(p.text.split('公开数据：')[1]));
  o.self.movement = null; o.self.action = { type: 'attack', phase: 'prepare', impact_at: now + 200, ends_at: now + 600 };
  assert.match(prepareDecisionPrompt({ observation: o, rules }).text, /攻击准备余0\.6秒/);
});

for (const route of ['hunt', 'pending', 'game', 'cooperation']) test(`连续动作与${route}拥挤提示保留原主人/消息且在2000 UTF-16内`, t => {
  const { o, rules, now } = observation(t), s = o.self, friend = 'agent_' + 'f'.repeat(36), group = 'group_' + 'g'.repeat(36);
  const ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200);
  o.group = { group_id: group, members: [s.agent_id, friend] };
  s.fatigue.energy = 1; s.adventure.hp = 8; s.life.inventory.turnip = 1;
  if (route === 'game') {
    o.game = { game_id: 'game_' + 'g'.repeat(36), turn_id: 'turn_' + 't'.repeat(36), status: 'active', game_type: 'word_chain', participants: [s.agent_id], current_agent_id: s.agent_id, last_word: '气球', deadline: now + 150000 };
    s.movement = null;
  } else {
    s.scene_id = 'adventure'; s.adventure.in_field = true; s.movement = null;
    s.adventure.decision_until = now + 30000;
    o.adventure.monsters.forEach((m, i) => { m.behavior = 'attacking'; m.target_agent_id = i === 1 ? friend : s.agent_id; });
    if (route === 'pending') s.adventure.encounter = { event_id: 'encounter_' + 'e'.repeat(36), status: 'pending', expires_at: now + 150000, choices: [
      { choice_id: 'wood', energy_cost: 4, items: { wood: 2 }, heal: 0, restore_energy: 0 }, { choice_id: 'decline', energy_cost: 0, items: {}, heal: 0, restore_energy: 0 }] };
    else {
      s.adventure.plan = { intent: 'hunt', mode: 'run', monster_id: 'ruins_guardian', zone_id: 'ruins', phase: 'to_target', destination_scene_id: 'adventure', expires_at: now + 90000 };
      s.action = { type: 'attack', phase: 'prepare', impact_at: now + 200, ends_at: now + 600 };
    }
    if (route === 'cooperation') o.cooperation = { cooperation_id: 'coop_' + 'c'.repeat(36), revision: 1, status: 'needs_review', template_id: 'scout_and_guard', expires_at: now + 500000,
      self_role_id: 'guard', members: [{ agent_id: s.agent_id, role_id: 'guard', confirmed: false }, { agent_id: friend, role_id: 'scout', confirmed: true }], progress: [{ step_id: 'scout', progress: 0, target_count: 1 }, { step_id: 'guard', progress: 0, target_count: 1 }] };
  }
  const p = prepareDecisionPrompt({ observation: o, rules, ownerGoal, correction: true,
    lastActionFeedback: { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 11, y: 8 } },
    events: [{ event_id: 'm', type: 'message', payload: { agent_id: friend, channel: 'group', group_id: group, text: message } }] });
  assert.ok(p.text.length <= 2000, `${p.text.length}`); assert.ok(p.text.includes(ownerGoal)); assert.ok(p.text.includes(message));
  assert.match(p.text, /mode:walk\|run/); if (s.action) assert.match(p.text, /攻击准备/);
  assert.doesNotThrow(() => JSON.parse(p.text.split('公开数据：')[1]));
  for (const [ref, id] of Object.entries(p.references || {})) {
    assert.equal(JSON.parse(expandDecisionReferences(JSON.stringify(action('personal_goal', { intent: 'set', kind: 'defeat_monster', target_id: ref, target_count: 1 })), p.references)).payload.target_id, id);
  }
  assert.throws(() => expandDecisionReferences(JSON.stringify(action('adventure_plan', { intent: 'hunt', monster_id: '@V999' })), p.references), { code: 'INVALID_MODEL_OUTPUT' });
});

for (const mode of ['model', 'dsh-pet']) test(`${mode}原AI选run真实提交并分时推进，主动stop不换活动或扩预算`, async t => {
  let now = Date.now(), selected;
  const world = new World({ now: () => now, actionIntervalMs: 0 }), record = world.createAgent({ name: '自由行走的原AI' }), a = world.agent(record.agent_id), c = world.createController(record.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 50 });
  const auth = world.authenticate(c.token), calls = [], prompts = [];
  const client = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }), close: async () => {},
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args: structuredClone(args) }); return { structuredContent: world.callTool(auth, name, args) }; } };
  const runner = new PlazaRunner({ mode, now: () => now, toolClient: client,
    petClient: { initialize: async () => {}, prepareDecision: prepareDecisionPrompt, decide: async (context, { prepared, onRequest }) => {
      prompts.push(prepared.text); await onRequest(); return expandDecisionReferences(JSON.stringify(selected), prepared.references);
    } }, model: { baseUrl: 'https://original.invalid/v1', model: 'original', apiKey: 'TEST_PRIVATE' }, fetchImpl: async (_, options) => {
      prompts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected) } }] }) };
    } });
  runner.running = true; runner.abort = new AbortController();
  t.after(async () => { await runner.stop(); world.close(); });
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const origin = { ...a.position }, destination = runner.observation.movement.candidates.find(p => Math.abs(p.x - origin.x) + Math.abs(p.y - origin.y) >= 2);
  assert.ok(destination); selected = action('move', { x: destination.x, y: destination.y, mode: 'run' });
  const deadline = a.run.expires_at, energy = a.fatigue.energy;
  await runner.decide();
  assert.equal(runner.checkpoint.calls_used, 1); assert.deepEqual(calls.find(c => c.name === 'act').args.payload, selected.payload);
  assert.deepEqual(a.position, origin, '回执只接受，不预先抵达'); assert.equal(a.movement.mode, 'run');
  now += 100; world.tick();
  assert.notDeepEqual(a.position, origin); assert.notDeepEqual(a.position, { x: destination.x, y: destination.y }); assert.ok(a.fatigue.energy < energy);
  const inFlight = { ...a.position };
  // The model has an existing request interval; while this focused fixture waits
  // for it, keep the simulation clock fixed to inspect a mid-route cancellation.
  runner.lastDecisionAt = now - 6000; runner.checkpoint.last_model_at = now - 6000;
  selected = action('adventure_plan', { intent: 'stop' }); await runner.decide();
  assert.equal(runner.checkpoint.calls_used, 2); assert.equal(a.movement, null); assert.equal(a.adventure.plan, null);
  now += 1000; world.tick(); assert.deepEqual(a.position, inFlight); assert.equal(a.run.expires_at, deadline);
  assert.equal(calls.filter(c => c.name === 'act').length, 2); assert.equal(prompts.length, 2);
  assert.equal(runner.capabilities().length, 16);
  if (mode === 'dsh-pet') assert.match(prompts[1], /跑往/); else assert.equal(JSON.parse(prompts[1].messages[1].content).observation.self.movement.mode, 'run');
});

test('极限提示的短ID只绑定本次请求，原主人/消息/选择成本完整且未知短ID不能透传', t => {
  const { o, rules, now } = observation(t), s = o.self, friend = 'agent_' + 'f'.repeat(36);
  s.scene_id = 'adventure'; s.movement = null; s.adventure.hp = 8; s.fatigue.energy = 1;
  s.life.inventory.turnip = 1; s.life.inventory.wheat_bread = 1;
  s.adventure.encounter = { event_id: 'encounter_' + 'a'.repeat(36), status: 'pending', expires_at: now + 150000,
    choices: [{ choice_id: 'wood', energy_cost: 4, items: { wood: 2 }, heal: 0, restore_energy: 0 }, { choice_id: 'ore', energy_cost: 4, items: { ore: 1 }, heal: 0, restore_energy: 0 }, { choice_id: 'decline', energy_cost: 0, items: {}, heal: 0, restore_energy: 0 }] };
  s.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), status: 'needs_review', kind: 'collect_item', target_id: 'wood', progress: 1, target_count: 10, expires_at: now + 500000 };
  o.group = { members: [s.agent_id, friend] };
  o.adventure.monsters.forEach((m, i) => { m.behavior = 'attacking'; m.target_agent_id = i === 2 ? friend : s.agent_id; });
  const ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200), context = { observation: o, rules, ownerGoal, correction: true,
    lastActionFeedback: { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } },
    events: [{ type: 'message', payload: { agent_id: friend, text: message } }] };
  const first = prepareDecisionPrompt(context), originalId = s.adventure.encounter.event_id;
  const data = JSON.parse(first.text.split('公开数据：')[1]);
  assert.ok(first.references?.[data.event[0]], '本例应实际走短ID压缩路径');
  assert.equal(first.references[data.event[0]], originalId); assert.equal(data.event[1], 150); assert.deepEqual(data.event[2][0], ['wood', 4, { wood: 2 }]);
  assert.equal(data.events[0].text, message); assert.ok(first.text.includes(ownerGoal)); assert.equal(data.foes.length, 3);
  const firstRefs = structuredClone(first.references);
  s.adventure.encounter.event_id = 'encounter_' + 'b'.repeat(36);
  const second = prepareDecisionPrompt(context), otherData = JSON.parse(second.text.split('公开数据：')[1]);
  assert.deepEqual(first.references, firstRefs, '准备下一轮不能改写上一轮的响应映射');
  const choose = ref => JSON.stringify(action('adventure_event', { event_id: ref, choice_id: 'decline' }));
  assert.equal(JSON.parse(expandDecisionReferences(choose(data.event[0]), first.references)).payload.event_id, originalId);
  assert.equal(JSON.parse(expandDecisionReferences(choose(otherData.event[0]), second.references)).payload.event_id, s.adventure.encounter.event_id);
  assert.throws(() => expandDecisionReferences(choose('@V999'), first.references), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => expandDecisionReferences(choose(data.event[0]), {}), { code: 'INVALID_MODEL_OUTPUT' }, '映射未提供时短ID不能直接进入服务');
  assert.equal(s.adventure.encounter.choices[0].energy_cost, 4); assert.equal(context.ownerGoal, ownerGoal);
});
