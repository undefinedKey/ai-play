import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { DshPetClient, decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { movementContext, normalizeMove } from '../skills/ai-plaza/scripts/movement.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
const move = (x, y) => ({ type: 'move', payload: { x, y } });
const oldRules = { room: { width: 8, height: 6 }, max_move: 3 };

test('桌宠拥挤战况仍保留三名追击者、主人目标、队友消息及移动回执，含格式重试不超2000字', t => {
  const world = new World({ actionIntervalMs: 0 });
  t.after(() => world.close());
  const record = world.createAgent({ name: '原AI' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  world.callTool(world.authenticate(controller.token), 'join_world', {});
  const observation = world.observation(world.agent(record.agent_id));
  const friend = 'agent_' + 'f'.repeat(36), ownerGoal = '主'.repeat(300), message = '友'.repeat(200);
  Object.assign(observation.self.adventure, { in_field: true, hp: 8, decision_until: observation.server_time + 30000 });
  observation.group = { group_id: 'group_' + 'g'.repeat(36), members: [record.agent_id, friend] };
  observation.adventure.monsters.forEach((m, i) => { m.target_agent_id = i === 1 ? friend : record.agent_id; m.behavior = 'chasing'; });
  const requested = { x: 100, y: -100 }, applied = { x: 11, y: 6 };
  const prompt = decisionPrompt({ observation, rules: world.getRules(), ownerGoal, correction: true,
    lastActionFeedback: { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested, applied },
    events: [{ type: 'adventure_aggro', payload: { agent_id: record.agent_id, monster_id: 'forest_slime', target_agent_id: record.agent_id, text: '已锁定' } },
      { type: 'message', payload: { agent_id: friend, text: message } }] });
  const context = decode(prompt);
  assert.ok(prompt.length <= 2000);
  assert.ok(prompt.includes(ownerGoal));
  assert.equal(context.events.at(-1).text, message);
  assert.equal(context.adventure.monsters.length, 3);
  assert.ok(context.adventure.monsters.every(row => row[5] === 'chasing'));
  assert.deepEqual(context.last_action.requested, requested);
  assert.deepEqual(context.last_action.applied, applied);
  assert.equal(context.self.adventure.decision_seconds, 30);
  assert.equal(context.movement.max_step, 3);
});

test('旧服从已知规则给出合法候选，新服尺寸/步长优先，未知几何不猜', () => {
  const observation = { self: { position: { x: 0, y: 0 } } };
  const legacy = movementContext(observation, oldRules);
  assert.deepEqual(legacy.map, { width: 8, height: 6 });
  assert.deepEqual(legacy.candidates, [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: 0 }, { x: 0, y: 3 }]);
  const current = { ...observation, movement: { map: { width: 4, height: 4 }, max_step: 2, candidates: [{ x: 2, y: 0 }, { x: 1, y: 1 }, { x: 9, y: 0 }, { x: 0, y: 0 }] } };
  assert.deepEqual(movementContext(current, oldRules), { map: { width: 4, height: 4 }, max_step: 2, candidates: [{ x: 2, y: 0 }, { x: 1, y: 1 }] });
  assert.equal(movementContext(observation, {}), null);
  assert.deepEqual(normalizeMove(move(99, 99), observation, {}).action, move(99, 99));
  assert.equal(movementContext({ ...observation, movement: { map: { width: 0, height: 4 }, max_step: 2 } }, oldRules), null);
});

test('整数目标只沿原方向截边界和步长，合法细步不吸附到候选，原地仍是move', () => {
  const observation = { self: { position: { x: 2, y: 2 } } };
  const result = normalizeMove(move(99, -10), observation, oldRules);
  assert.deepEqual(result.action, move(4, 1));
  assert.deepEqual(result.adjustment, { requested: { x: 99, y: -10 }, applied: { x: 4, y: 1 }, from: { x: 2, y: 2 } });
  assert.deepEqual(normalizeMove(move(3, 3), observation, oldRules), { action: move(3, 3), adjustment: null });
  assert.equal(movementContext(observation, oldRules).candidates.some(p => p.x === 3 && p.y === 3), false);
  const corner = normalizeMove(move(-99, -99), { self: { position: { x: 0, y: 0 } } }, oldRules);
  assert.deepEqual(corner.action, move(0, 0));
  for (const [x, y] of [[99, 99], [-99, -99], [7, 0], [0, 5], [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]]) {
    const p = normalizeMove(move(x, y), observation, oldRules).action.payload;
    assert.ok(p.x >= 0 && p.x < 8 && p.y >= 0 && p.y < 6);
    assert.ok(Math.abs(p.x - 2) + Math.abs(p.y - 2) <= 3);
    assert.ok((p.x - 2) * (x - 2) >= 0 && (p.y - 2) * (y - 2) >= 0);
  }
  for (const action of [move('3', 1), move(1.1, 2), move(NaN, 2), move(Infinity, 2), move(Number.MAX_SAFE_INTEGER + 1, 2)]) {
    assert.throws(() => normalizeMove(action, observation, oldRules), TypeError);
    assert.throws(() => parseModelAction(JSON.stringify(action)), { code: 'INVALID_MODEL_OUTPUT' });
  }
});

async function fixture(t, { mode = 'model', choose = () => move(100, -100), duringModel, beforeAct, loseFirstReceipt = false } = {}) {
  let now = Date.now(), lost = false;
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-movement-runner-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const record = world.createAgent({ name: '原AI' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const auth = world.authenticate(controller.token), requests = [], tools = [], logs = [];
  const client = {
    listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      tools.push({ name, args: structuredClone(args) });
      if (name === 'act') await beforeAct?.({ world, a: world.agent(record.agent_id) });
      const result = world.callTool(auth, name, args);
      if (name === 'act' && loseFirstReceipt && !lost) { lost = true; throw new Error('simulated lost response'); }
      return { structuredContent: result };
    }, close: async () => {},
  };
  const originalReply = async context => {
    requests.push(context);
    await duringModel?.({ world, a: world.agent(record.agent_id), advance: ms => { now += ms; } });
    return JSON.stringify(choose(context));
  };
  const pet = new DshPetClient({ petId: 'original', url: 'http://127.0.0.1:32991', runtimePath: join(directory, 'absent.json'), fetchImpl: async (url, options) => ({ ok: true, json: async () => url.endsWith('/config')
    ? { main: { pets: [{ id: 'original', name: '原AI', display: 'both' }] } }
    : { ok: true, text: await originalReply(decode(JSON.parse(options.body).text)) } }) });
  const runner = new PlazaRunner({ mode, toolClient: client, petClient: pet, now: () => now, checkpointPath, logger: text => logs.push(text),
    model: { baseUrl: 'https://model.invalid/v1', model: 'test', apiKey: 'MODEL_SECRET' }, fetchImpl: async (_, options) => ({ ok: true, json: async () => ({ choices: [{ message: { content: await originalReply(JSON.parse(JSON.parse(options.body).messages[1].content)) } }] }) }) });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  t.after(async () => { await runner.stop(); world.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  return { runner, world, get a() { return world.agent(record.agent_id); }, requests, tools, logs, checkpointPath, advance: ms => { now += ms; } };
}

for (const mode of ['model', 'dsh-pet']) test(`${mode}共享运行器用最新位置截步并保留requested/applied真实回执`, async t => {
  const f = await fixture(t, { mode, duringModel: ({ world, advance }) => { advance(2000); world.tick(); } });
  f.world.perform(f.a, 'adventure_plan', { intent: 'explore', zone_id: 'ruins' });
  await f.runner.decide();
  const submitted = f.tools.find(call => call.name === 'act').args;
  assert.deepEqual(submitted.payload, { x: 12, y: 6 }, '模型思考时角色从9,7走到10,7，应以最新10,7截步');
  assert.deepEqual(f.a.position, submitted.payload);
  assert.deepEqual(f.runner.checkpoint.last_action_feedback, { type: 'move', status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 100, y: -100 }, applied: { x: 12, y: 6 } });
  assert.equal(f.runner.checkpoint.calls_used, 1); assert.equal(f.runner.checkpoint.pending_movement, undefined);
  assert.ok(f.tools.filter(call => call.name === 'observe').length >= 3);
  assert.equal(f.requests[0].movement.max_step, 3); assert.equal(f.requests[0].movement.map.width, 24);
  assert.ok(f.logs.some(log => log.includes('未宣称到达原目标')));
  f.advance(6000); await f.runner.decide();
  assert.equal(f.requests.at(-1).last_action.code, 'MOVE_ADJUSTED');
  assert.deepEqual(f.requests.at(-1).last_action.applied, { x: 12, y: 6 });
});

test('移动结果未知时保持归一化pending与元信息，恢复回执不按新位置二次改坐标', async t => {
  const f = await fixture(t, { loseFirstReceipt: true });
  await assert.rejects(f.runner.decide(), /lost response/);
  const saved = JSON.parse(readFileSync(f.checkpointPath, 'utf8'));
  assert.deepEqual(saved.pending_action.payload, { x: 11, y: 6 });
  assert.deepEqual(saved.pending_movement.requested, { x: 100, y: -100 });
  assert.deepEqual(saved.pending_movement.applied, saved.pending_action.payload);
  f.a.position = { x: 20, y: 15 }; // World may advance after an acknowledged action whose reply was lost.
  await f.runner.recoverPending();
  assert.equal(f.tools.filter(call => call.name === 'act').length, 1);
  assert.equal(f.runner.checkpoint.pending_action, null); assert.equal(f.runner.checkpoint.pending_movement, undefined);
  assert.deepEqual(f.runner.checkpoint.last_action_feedback.applied, { x: 11, y: 6 });
  assert.equal(f.runner.checkpoint.calls_used, 1);
});

test('归一化之后世界再次变化仍由服务拒绝，反馈不能把尝试落点说成已到达', async t => {
  const f = await fixture(t, { beforeAct: ({ a }) => { a.position = { x: 20, y: 15 }; } });
  await f.runner.decide();
  assert.equal(f.runner.checkpoint.last_action_feedback.status, 'rejected');
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'INVALID_ACTION');
  assert.deepEqual(f.runner.checkpoint.last_action_feedback.requested, { x: 100, y: -100 });
  assert.deepEqual(f.runner.checkpoint.last_action_feedback.applied, { x: 11, y: 6 });
  assert.deepEqual(f.a.position, { x: 20, y: 15 });
  assert.ok(!f.logs.some(log => log.includes('服务已确认移动到')));
});

test('动态地图/合法候选进入原桌宠，不硬编码24×16；巡逻/普通位置事件不唤醒', () => {
  const observation = { self: { agent_id: 'self', name: '原AI', position: { x: 3, y: 2 } }, movement: { map: { width: 5, height: 4 }, max_step: 2, candidates: [{ x: 4, y: 2 }, { x: 3, y: 3 }] } };
  const prompt = decisionPrompt({ observation, rules: {} });
  const data = decode(prompt);
  assert.deepEqual(data.movement, { map: { width: 5, height: 4 }, max_step: 2, candidates: [[4, 2], [3, 3]] });
  assert.ok(!prompt.includes('地图24×16')); assert.ok(prompt.length <= 2000);
  const queue = enqueueEvents({ queue: [], seen: [] }, [
    { event_id: 'patrol', type: 'adventure_patrolling', payload: { agent_id: 'self', monster_id: 'm' } },
    { event_id: 'position', type: 'monster_position', payload: { agent_id: 'self' } },
    { event_id: 'lock', type: 'adventure_aggro', payload: { agent_id: 'self', monster_id: 'm', target_agent_id: 'self' } },
  ], 'self');
  assert.deepEqual(queue.queue.map(event => event.event_id), ['lock']);
});
