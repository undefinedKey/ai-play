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
    : { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: data.adventure.monsters.find(row => row[0] === 'forest_slime')[0] } });
  assert.equal(f.a.adventure.plan, null, '安装和连接不替原AI自动开冒险');
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'explore');
  for (let step = 0; step < 20 && f.a.adventure.plan; step++) {
    f.tick();
    if (f.a.adventure.plan) assert.equal(f.runner.decisionDue(), false, '移动只执行原意图');
  }
  assert.equal(f.a.adventure.plan, null); assert.equal(f.runner.checkpoint.calls_used, 1);
  assert.equal(f.runner.decisionDue(), true); assert.ok(f.runner.checkpoint.queue.some(e => e.type === 'adventure_finished'));
  await f.decide(); f.poll();
  assert.equal(f.a.adventure.plan.intent, 'hunt');
  for (let step = 0; step < 10 && f.a.adventure.plan; step++) f.tick();
  assert.equal(f.a.adventure.kills, 1); assert.ok(f.a.adventure.xp > 0); assert.equal(f.a.adventure.plan, null);
  assert.equal(f.runner.checkpoint.calls_used, 2);
  assert.equal(f.calls.filter(c => c.name === 'act').length, 2);
  assert.equal(f.runner.checkpoint.pending_action, null);
  assert.ok(f.prompts.every(p => p.includes('沿用自己的身份和记忆')));
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
  f.a.position = { x: 19, y: 7 }; f.a.adventure.hp = 15;
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
