import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, enqueueEvents, parseModelAction } from '../runner/runner.js';
import { DshPetClient, decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
const json = value => ({ ok: true, json: async () => value });
async function fixture(t, choose = () => ({ type: 'wait', payload: {} })) {
  let now = Date.now();
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '原来的我' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 100 });
  const auth = world.authenticate(controller.token), prompts = [], calls = [];
  const client = {
    listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; },
    close: async () => {},
  };
  const pet = new DshPetClient({ petId: 'original', url: 'http://127.0.0.1:32991', runtimePath: 'missing-test-pet-runtime', fetchImpl: async (url, options) => {
    if (url.endsWith('/config')) return json({ main: { pets: [{ id: 'original', name: '原来的我', display: 'both', whisperPrompt: 'PRIVATE_PERSONA' }] } });
    const prompt = JSON.parse(options.body).text;
    assert.ok(prompt.length <= 2000); assert.ok(!prompt.includes('PRIVATE_PERSONA')); assert.ok(!prompt.includes(controller.token));
    prompts.push(prompt); return json({ ok: true, text: JSON.stringify(await choose(decode(prompt))) });
  } });
  const runner = new PlazaRunner({ mode: 'dsh-pet', toolClient: client, petClient: pet, now: () => now, idleMs: 60000 });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const a = world.agent(record.agent_id);
  const refresh = () => { runner.observation = world.observation(a); runner.observedAt = now; };
  const poll = () => {
    const result = world.callTool(auth, 'get_events', { ...runner.session(), cursor: runner.checkpoint.cursor, wait_seconds: 0 });
    runner.checkpoint = enqueueEvents(runner.checkpoint, result.events, a.agent_id, world.state.groups[a.group_id]?.members || []);
    runner.checkpoint.cursor = result.next_cursor;
  };
  t.after(async () => { await runner.stop(); world.close(); });
  return { world, get a() { return world.agent(record.agent_id); }, auth, runner, prompts, calls, refresh, poll,
    advance: ms => { now += ms; },
    tick: () => { now += 1000; world.tick(); poll(); },
    decide: async () => { now += 6000; await runner.decide(); },
  };
}

test('冒险动作仅接受有限意图与目录ID字段，不接受凭据、执行命令或缺失目标', () => {
  for (const payload of [{ intent: 'explore', zone_id: 'forest' }, { intent: 'hunt', monster_id: 'forest_slime' }, { intent: 'hunt', zone_id: 'ruins' }, { intent: 'rest' }, { intent: 'retreat' }, { intent: 'stop' }]) {
    const action = { type: 'adventure_plan', payload };
    assert.deepEqual(parseModelAction(JSON.stringify(action)), action);
  }
  for (const payload of [{ intent: 'explore' }, { intent: 'hunt' }, { intent: 'farm_forever' }, { intent: 'explore', zone_id: 'other' }, { intent: 'rest', token: 'secret' }, { intent: 'stop', monster_id: 'x' }, { intent: 'hunt', monster_id: 42 }]) {
    assert.throws(() => parseModelAction(JSON.stringify({ type: 'adventure_plan', payload })), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

test('真实World中原桌宠决定探索，自动移动不逐步调用模型，完成唤醒后能自主打怪', async t => {
  let decisions = 0;
  const f = await fixture(t, data => ++decisions === 1
    ? { type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest' } }
    : data.event ? { type: 'adventure_event', payload: { event_id: data.event[0], choice_id: 'decline' } }
    : { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: data.adventure.monsters.find(row => row[0] === 'forest_slime')[0] } });
  assert.equal(f.a.adventure.plan, null, '安装和连接不替原AI自动开冒险');
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'explore');
  for (let step = 0; step < 40 && f.a.adventure.plan; step++) {
    f.tick();
    if (f.a.adventure.plan && !f.runner.checkpoint.queue.some(event => ['adventure_aggro','scene_changed'].includes(event.type))) assert.equal(f.runner.decisionDue(), false, '普通格子移动不触发模型；真实穿门或怪物锁定会重新观察');
  }
  assert.equal(f.a.adventure.plan, null); assert.equal(f.runner.checkpoint.calls_used, 1);
  assert.equal(f.runner.decisionDue(), true); assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'adventure_finished'));
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.encounter.status, 'declined');
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'hunt');
  for (let step = 0; step < 10 && f.a.adventure.plan; step++) f.tick();
  assert.equal(f.a.adventure.kills, 1); assert.ok(f.a.adventure.xp > 0); assert.equal(f.a.adventure.plan, null);
  assert.equal(f.runner.checkpoint.calls_used, 3);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 3);
  assert.equal(f.runner.checkpoint.pending_action, null);
  assert.ok(f.prompts.every(p => /沿用.*身份.*记忆|沿用自身/.test(p)));
});

test('普通战斗和他人事件不唤醒，自己与队友的危险/结束、社交邀请保留且去重', () => {
  const routine = ['adventure_started', 'adventure_arrived', 'adventure_combat', 'adventure_loot', 'adventure_respawn'];
  const events = routine.map(type => ({ event_id: type, type, payload: { agent_id: 'self' } }));
  events.push(...[
    { event_id: 'danger', type: 'adventure_danger', payload: { agent_id: 'self' } },
    { event_id: 'friend', type: 'adventure_defeated', payload: { agent_id: 'teammate' } },
    { event_id: 'distant', type: 'adventure_finished', payload: { agent_id: 'stranger' } },
    { event_id: 'invite', type: 'group_invitation', payload: { agent_id: 'stranger', invite_id: 'i' } },
  ]);
  const cp = enqueueEvents({ queue: [], seen: [] }, events, 'self', ['self', 'teammate']);
  assert.deepEqual(cp.queue.map(e => e.event_id), ['danger', 'friend', 'invite']);
  assert.deepEqual(enqueueEvents(cp, events, 'self', ['teammate']).queue, cp.queue);
});

test('危险唤醒原AI选择撤退，保持原动作回执和预算；计划中仍有30秒复查', async t => {
  const f = await fixture(t, data => data.events.some(e => e.type === 'adventure_danger')
    ? { type: 'adventure_plan', payload: { intent: 'retreat' } }
    : { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: 'ruins_guardian' } });
  await f.decide(); f.poll();
  // This danger fixture begins already in the ruins, not at coincident plaza coordinates.
  f.a.scene_id = 'adventure'; f.a.position = { x: 19, y: 7 }; f.a.adventure.hp = 15;
  f.tick(); f.advance(4000);
  assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'adventure_danger'));
  assert.equal(f.runner.decisionDue(), true);
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'retreat'); assert.equal(f.runner.checkpoint.calls_used, 2);
  f.runner.checkpoint.queue = []; f.advance(6000);
  assert.equal(f.runner.decisionDue(), false);
  f.advance(24000); assert.equal(f.runner.decisionDue(), true, '可以主动重新考虑，不锁定90秒计划');
  assert.equal(f.runner.checkpoint.pending_action, null);
});

test('目标不可用的真实拒绝进入原AI观察，下一次可以改为休息', async t => {
  const f = await fixture(t, data => data.last_action
    ? { type: 'adventure_plan', payload: { intent: 'rest' } }
    : { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: 'unknown_monster' } });
  await f.decide();
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'TARGET_UNAVAILABLE');
  assert.equal(f.a.adventure.plan, null);
  await f.decide();
  assert.equal(decode(f.prompts.at(-1)).last_action.code, 'TARGET_UNAVAILABLE');
  assert.ok(f.a.adventure.plan, JSON.stringify({ result: f.a.adventure.last_result, feedback: f.runner.checkpoint.last_action_feedback, calls: f.calls.slice(-5), error: f.runner.lastError }));
  assert.equal(f.a.adventure.plan.intent, 'rest');
  assert.equal(f.runner.checkpoint.last_action_feedback, undefined);
});

test('拥挤冒险上下文在2000字内保留本人生命、当前目标、主人要求、邀请和最后消息', async t => {
  const f = await fixture(t);
  const observation = structuredClone(f.runner.observation);
  const id = 'agent_' + 'a'.repeat(36), groupId = 'group_' + 'g'.repeat(36);
  observation.self.scene_id = 'adventure';
  observation.self.adventure.plan = { intent: 'hunt', zone_id: 'ruins', monster_id: 'ruins_guardian', started_at: Date.now(), expires_at: Date.now() + 90000 };
  observation.self.adventure.hp = 8;
  observation.nearby_agents = Array.from({ length: 4 }, (_, index) => ({ agent_id: id + index, name: '友'.repeat(20), position: { x: 19, y: 7 }, group_id: groupId, adventure: { hp: 30, plan: { intent: 'hunt', monster_id: 'ruins_guardian' } } }));
  observation.group = { group_id: groupId, members: [observation.self.agent_id, ...observation.nearby_agents.map(a => a.agent_id)] };
  observation.invitations = [{ invite_id: 'invite_' + 'i'.repeat(36), from_agent_id: id, group_id: groupId }];
  observation.private_memory = 'PRIVATE';
  const message = '友'.repeat(200), goal = '主'.repeat(300);
  const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal: goal,
    lastActionFeedback: { type: 'adventure_plan', code: 'TARGET_UNAVAILABLE', message: '目标已被击败，请重新观察。'.repeat(8), retry_after_ms: 0 },
    events: [{ type: 'adventure_danger', payload: { agent_id: f.a.agent_id, text: '生命不足四分之一，请自行决定' } }, { type: 'message', payload: { agent_id: id, text: message } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(goal)); assert.ok(!prompt.includes('PRIVATE'));
  assert.equal(data.self.adventure.hp, 8); assert.equal(data.self.adventure.plan.monster_id, 'ruins_guardian');
  assert.ok(data.adventure.monsters.some(row => row[0] === 'ruins_guardian'));
  assert.equal(data.events.at(-1).text, message); assert.equal(data.invitations[0].invite_id, observation.invitations[0].invite_id);
  assert.equal(data.last_action.code, 'TARGET_UNAVAILABLE');
});

test('新版独立模型请求保留完整冒险环境，原AI输出才会生成行动', async t => {
  const f = await fixture(t); let request;
  f.runner.mode = 'model'; f.runner.model = { baseUrl: 'https://model.invalid/v1', model: 'test', apiKey: 'MODEL_SECRET' };
  f.runner.fetchImpl = async (_, options) => {
    request = JSON.parse(options.body);
    return json({ choices: [{ message: { content: '{"type":"adventure_plan","payload":{"intent":"explore","zone_id":"ruins"}}' } }] });
  };
  await f.decide();
  const context = JSON.parse(request.messages[1].content);
  assert.equal(context.observation.adventure.monsters.length, 3);
  assert.ok(request.messages[0].content.includes('adventure_plan'));
  assert.ok(!JSON.stringify(context).includes('MODEL_SECRET'));
  assert.equal(f.a.adventure.plan.zone_id, 'ruins');
});

test('探索遭遇主动锁定唤醒原AI，原AI可选择撤退，未下hunt不会自动反击', async t => {
  let decisions = 0;
  const f = await fixture(t, data => ++decisions === 1
    ? { type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest' } }
    : (data.event || data.events.some(e => e.type === 'adventure_aggro')) ? { type: 'adventure_plan', payload: { intent: 'retreat' } } : { type: 'wait', payload: {} });
  await f.decide(); f.poll();
  for (let step = 0; step < 40 && !f.runner.checkpoint.queue.some(e => e.type === 'adventure_aggro'); step++) f.tick();
  assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'adventure_aggro'));
  assert.equal(f.runner.decisionDue(), true);
  assert.equal(f.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent'), false);
  await f.decide(); f.poll();
  const context = decode(f.prompts.at(-1));
  assert.ok(context.event || context.adventure.monsters.some(row => row[6] === 'self' && ['chasing', 'attacking'].includes(row[5])));
  assert.equal(f.a.adventure.plan.intent, 'retreat'); assert.equal(f.runner.checkpoint.calls_used, 2);
  for (let step = 0; step < 40 && f.a.adventure.plan; step++) f.tick();
  assert.equal(f.a.adventure.in_field, false);
  assert.equal(f.a.scene_id, 'plaza'); assert.deepEqual(f.a.position, { x: 11, y: 8 });
  assert.equal(f.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent'), false);
});

test('同样的探索遭遇可由另一原AI选择应战，模型明确hunt后才攻击', async t => {
  let decisions = 0;
  const f = await fixture(t, data => ++decisions === 1
    ? { type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest' } }
    : data.event ? { type: 'adventure_event', payload: { event_id: data.event[0], choice_id: 'decline' } }
    : { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: (data.adventure.monsters.find(row => row[6] === 'self') || data.adventure.monsters.find(row => row[0] === 'forest_slime'))[0] } });
  await f.decide(); f.poll();
  for (let step = 0; step < 40 && f.a.adventure.encounter?.status !== 'pending'; step++) f.tick();
  assert.equal(f.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent'), false);
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.encounter.status, 'declined');
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'hunt');
  const chosen = f.a.adventure.plan.monster_id;
  for (let step = 0; step < 5; step++) f.tick();
  assert.ok(f.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent' && e.payload.monster_id === chosen));
  assert.equal(f.runner.checkpoint.calls_used, 3);
});

test('怪物同次锁定合并，普通高频攻击与陌生人被锁定不唤醒，队友锁定会保留', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ event_id: `hit${i}`, type: 'adventure_combat', payload: { agent_id: 'self', monster_id: 'slime', attacker: 'monster' } }));
  for (let i = 0; i < 20; i++) events.push({ event_id: `lock${i}`, type: 'adventure_aggro', payload: { agent_id: 'self', target_agent_id: 'self', monster_id: 'slime' } });
  events.push({ event_id: 'friend', type: 'adventure_aggro', payload: { agent_id: 'friend', target_agent_id: 'friend', monster_id: 'boar' } });
  events.push({ event_id: 'stranger', type: 'adventure_aggro', payload: { agent_id: 'stranger', target_agent_id: 'stranger', monster_id: 'guardian' } });
  const cp = enqueueEvents({ queue: [], seen: [] }, events, 'self', ['friend']);
  assert.deepEqual(cp.queue.map(e => e.event_id), ['lock19', 'friend']);
  assert.deepEqual(enqueueEvents(cp, events, 'self', ['friend']).queue, cp.queue);
});

test('即使普通空闲为90秒，反应保护到期前也给原AI复查机会', async t => {
  const f = await fixture(t);
  f.runner.idleMs = 90000; f.runner.lastDecisionAt = f.runner.now();
  f.runner.observation.self.adventure.in_field = true;
  f.runner.observation.self.adventure.decision_until = f.runner.now() + 30000;
  f.advance(15000); assert.equal(f.runner.decisionDue(), false);
  f.advance(6000); assert.equal(f.runner.decisionDue(), true);
  f.advance(10000); assert.equal(f.runner.decisionDue(), false, '旧快照中的已过期保护不能导致每10秒无限唤醒');
  assert.equal(f.calls.filter(call => call.name === 'act').length, 0, '唤醒只请求原AI决定，不自动生成撤退或反击');
});

test('拥挤观察优先保留本人/队友追击者和保护期限，不被最后陌生人aggro覆盖', async t => {
  const f = await fixture(t);
  const observation = structuredClone(f.runner.observation), friend = 'agent_' + 'f'.repeat(36), stranger = 'agent_' + 's'.repeat(36);
  observation.self.scene_id = 'adventure';
  observation.self.adventure.in_field = true;
  observation.self.adventure.hp = 8;
  observation.self.adventure.decision_until = observation.server_time + 30000;
  observation.group = { group_id: 'group_' + 'g'.repeat(36), members: [f.a.agent_id, friend] };
  observation.adventure.monsters.forEach((monster, index) => {
    monster.target_agent_id = index === 1 ? friend : f.a.agent_id;
    monster.behavior = 'chasing';
  });
  const message = '友'.repeat(200), goal = '主'.repeat(300);
  const prompt = decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal: goal, events: [
    { type: 'adventure_aggro', payload: { agent_id: f.a.agent_id, monster_id: 'forest_slime', target_agent_id: f.a.agent_id, text: '史莱姆盯上了你' } },
    { type: 'message', payload: { agent_id: friend, text: message } },
    { type: 'adventure_aggro', payload: { agent_id: stranger, monster_id: 'distant_monster', target_agent_id: stranger, text: '远处怪物盯上了陌生人' } },
  ] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(goal));
  assert.ok(data.adventure.monsters.some(row => row[0] === 'forest_slime' && row[6] === 'self'));
  assert.ok(data.adventure.monsters.some(row => row[0] === 'forest_boar' && row[6] === friend));
  assert.ok(data.adventure.monsters.some(row => row[0] === 'ruins_guardian' && row[6] === 'self'));
  assert.equal(data.self.adventure.decision_until, observation.self.adventure.decision_until);
  assert.equal(data.self.adventure.decision_seconds, 30);
  assert.equal(data.events[0].monster_id, 'forest_slime'); assert.equal(data.events.at(-1).text, message);
});

test('同组其他角色在报名游戏时，本人在野外仍优先读取怪物威胁且不推荐旧活动', async t => {
  const f = await fixture(t);
  const bRecord = f.world.createAgent({ name: '营地同伴' }), bController = f.world.createController(bRecord.agent_id);
  f.world.ownerControl(bRecord.agent_id, 'start', { controller_id: bController.controller_id });
  f.world.callTool(f.world.authenticate(bController.token), 'join_world');
  const b = f.world.agent(bRecord.agent_id); b.position = { ...f.a.position };
  f.world.perform(f.a, 'create_group', {});
  const invite = f.world.perform(f.a, 'invite', { group_id: f.a.group_id, target_agent_id: b.agent_id });
  f.world.perform(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  f.world.perform(f.a, 'adventure_plan', { intent: 'explore', zone_id: 'forest' });
  f.a.scene_id = 'adventure'; f.a.position = { x: 4, y: 11 }; f.tick();
  f.world.perform(f.a, 'adventure_event', { event_id: f.a.adventure.encounter.event_id, choice_id: 'decline' }); f.tick();
  f.world.perform(b, 'propose_game', { group_id: b.group_id, game_type: 'word_chain' });
  f.refresh();
  assert.equal(f.runner.observation.game.status, 'recruiting');
  assert.ok(!f.runner.observation.game.participants.includes(f.a.agent_id));
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules(), events: f.runner.checkpoint.queue });
  const data = decode(prompt);
  assert.ok(data.adventure.monsters.some(row => row[6] === 'self'));
  assert.equal(data.self.adventure.in_field, true);
  assert.equal(data.activities, undefined); assert.equal(data.games, undefined);
  assert.ok(!prompt.includes('start_activity{')); assert.ok(!prompt.includes('propose_game{'));
  f.runner.lastDecisionAt = f.runner.now(); f.runner.checkpoint.queue = [];
  f.advance(10000); assert.equal(f.runner.decisionDue(), false, '无新威胁时不为不能参加的报名反复唤醒');
});
