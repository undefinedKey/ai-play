import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlazaRunner, parseModelAction, enqueueEvents, decodeToolResult } from '../runner/runner.js';

const toolNames = ['get_rules', 'test_connection', 'join_world', 'observe', 'get_events', 'act', 'get_action_result', 'get_control_state', 'report_status', 'pause_self', 'leave_world'];
const snapshot = () => ({ run_id: 'run-1', session_epoch: 2, expires_at: Date.now() + 600000,
  self: { agent_id: 'agent-a', name: '小白', status: 'active', position: { x: 10, y: 7 }, group_id: null },
  nearby_agents: [], group: null, game: null, invitations: [], cursor: '3', next_action_id: 'action-1' });
function fixture({ mode = 'demo', checkpointPath, fetchImpl, observation = snapshot() } = {}) {
  let time = Date.now();
  const calls = [];
  const control = { agent_id: 'agent-a', auth_controller_id: 'c-1', controller_id: 'c-1', status: 'active', session_epoch: 2,
    run: { run_id: 'run-1', controller_id: 'c-1', status: 'active', expires_at: time + 600000, max_calls: 100, has_joined: false, goal: '认识新朋友' } };
  const client = {
    async listTools() { return { tools: toolNames.map(name => ({ name })) }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      let result = {};
      if (name === 'get_rules') result = { skill_version: '0.1.0', words: ['天气', '气球', '球场', '场地'] };
      if (name === 'observe' || name === 'join_world') result = observation;
      if (name === 'get_control_state') result = structuredClone(control);
      if (name === 'get_events') result = { events: [], next_cursor: '3', control_state: structuredClone(control) };
      if (name === 'get_action_result') result = { status: 'not_found' };
      if (name === 'act') result = { status: 'applied', next_action_id: 'action-2' };
      if (name === 'pause_self') { control.status = 'paused'; control.run.status = 'paused'; control.session_epoch++; result = structuredClone(control); }
      return { structuredContent: result };
    },
    async close() {},
  };
  const runner = new PlazaRunner({ toolClient: client, mode, checkpointPath, now: () => time, pollSeconds: 0, fetchImpl,
    model: { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'secret-never-sent-to-world' } });
  return { runner, calls, control, observation, advance: ms => { time += ms; } };
}
async function activate(f) {
  f.runner.running = true;
  f.runner.abort = new AbortController();
  await f.runner.initialize();
  f.control.status = 'offline';
  await f.runner.activate(f.control);
  f.control.status = 'active';
}

test('模型动作解析只接受已知动作，身份与凭证不由模型生成', () => {
  assert.deepEqual(parseModelAction('```json\n{"type":"say","payload":{"text":"你好","channel":"nearby"},"run_id":"evil"}\n```'), { type: 'say', payload: { text: '你好', channel: 'nearby' } });
  assert.throws(() => parseModelAction('{"type":"shell","payload":{"cmd":"anything"}}'), /已知 type/);
  assert.throws(() => parseModelAction('这就发言'), /有效的动作 JSON/);
  assert.throws(() => parseModelAction('{"type":"wait","payload":[]}'), /已知 type/);
});

test('MCP 业务错误保留稳定错误码', () => {
  assert.throws(() => decodeToolResult({ isError: true, structuredContent: { error: { code: 'STALE_SESSION', message: '已暂停' } } }), e => e.code === 'STALE_SESSION');
  assert.equal(decodeToolResult({ structuredContent: { status: 'rejected', error: { code: 'INVALID_WORD' } } }).status, 'rejected');
});

test('事件去重、忽略自身消息与移动，保留当前游戏轮次', () => {
  const current = { queue: [], seen: [] };
  const events = [
    { event_id: 'a', type: 'message', payload: { agent_id: 'self' } },
    { event_id: 'b', type: 'agent_moved', payload: { agent_id: 'other' } },
    { event_id: 'c', type: 'message', payload: { agent_id: 'other', text: '你好' } },
    { event_id: 'd', type: 'game_turn', payload: { agent_id: 'self' } },
  ];
  const first = enqueueEvents(current, events, 'self');
  const repeated = enqueueEvents(first, events, 'self');
  assert.deepEqual(repeated.queue.map(e => e.event_id), ['c', 'd']);
  assert.equal(repeated.seen.length, 4);
});

test('队列溢出保持 100 条上限并优先保留游戏与控制事件', () => {
  const events = [{ event_id: 'control', type: 'control_paused', payload: {} },
    ...Array.from({ length: 140 }, (_, i) => ({ event_id: `m-${i}`, type: 'message', payload: { agent_id: 'other' } }))];
  const result = enqueueEvents({ queue: [], seen: [] }, events, 'self');
  assert.equal(result.queue.length, 100);
  assert.ok(result.queue.some(e => e.event_id === 'control'));
  assert.equal(result.dropped_events, 41);
});

test('模拟决策尊重邀请，接龙答案来自当前固定词库与轮次', async () => {
  const f = fixture(); await activate(f);
  f.runner.checkpoint.demo.greeted = true;
  f.observation.invitations = [{ invite_id: 'inv-1', status: 'pending', expires_at: Date.now() + 30000 }];
  assert.deepEqual(f.runner.demoDecision(f.observation), { type: 'respond_invite', payload: { invite_id: 'inv-1', accept: true } });
  f.observation.group = { group_id: 'group-1', members: ['agent-a', 'agent-b'] };
  f.observation.game = { game_id: 'game-1', status: 'active', current_agent_id: 'agent-a', turn_id: 8, last_word: '气球', words: ['天气', '气球'] };
  assert.deepEqual(f.runner.demoDecision(f.observation), { type: 'submit_word', payload: { game_id: 'game-1', turn_id: 8, word: '球场' } });
  await f.runner.stop();
});

test('模型请求发出前持久化预算，密钥不进入世界工具与checkpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-runner-'));
  const path = join(directory, 'checkpoint.json');
  let sent = 0;
  const f = fixture({ mode: 'model', checkpointPath: path, fetchImpl: async (_url, options) => {
    sent++;
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).calls_used, 1);
    assert.equal(options.headers.Authorization, 'Bearer secret-never-sent-to-world');
    assert.ok(!options.body.includes('secret-never-sent-to-world'));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"type":"wait","payload":{}}' } }] }) };
  } });
  try {
    await activate(f); await f.runner.decide();
    assert.equal(sent, 1); assert.equal(f.runner.checkpoint.calls_used, 1);
    assert.ok(!JSON.stringify(f.calls).includes('secret-never-sent-to-world'));
    assert.ok(!readFileSync(path, 'utf8').includes('secret-never-sent-to-world'));
  } finally { await f.runner.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('真实失败请求计入预算，临时模型故障退避且不伪装为主人暂停', async () => {
  const f = fixture({ mode: 'model', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await activate(f);
  for (let i = 0; i < 3; i++) {
    await f.runner.decide();
    assert.equal(f.runner.decisionDue(), false);
    f.advance(31000);
  }
  assert.equal(f.runner.checkpoint.calls_used, 3);
  assert.equal(f.runner.checkpoint.counters.requests, 3);
  assert.equal(f.runner.checkpoint.counters.retries, 2);
  assert.equal(f.runner.active, true);
  assert.equal(f.calls.filter(x => x.name === 'pause_self').length, 0);
  assert.equal(f.runner.health.waiting_reason, 'model_unavailable');
  await f.runner.stop();
});

test('暂停期间收到迟到模型结果不会提交动作', async () => {
  let finish;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture({ mode: 'model', fetchImpl: async () => {
    began();
    return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"type":"say","payload":{"channel":"nearby","text":"迟到"}}' } }] }) }); });
  } });
  await activate(f);
  const decision = f.runner.decide();
  await started;
  f.runner.deactivate();
  finish();
  await decision;
  assert.equal(f.calls.filter(x => x.name === 'act').length, 0);
  assert.equal(f.runner.checkpoint.calls_used, 1);
  await f.runner.stop();
});

test('动作结果不明按原动作ID恢复，不生成第二次动作', async () => {
  const f = fixture(); await activate(f);
  f.runner.checkpoint.pending_action = { run_id: 'run-1', session_epoch: 2, action_id: 'uncertain-1', type: 'say', payload: { text: '一次', channel: 'nearby' } };
  await f.runner.recoverPending();
  assert.equal(f.calls.find(x => x.name === 'get_action_result').args.action_id, 'uncertain-1');
  assert.equal(f.calls.find(x => x.name === 'act').args.action_id, 'uncertain-1');
  assert.equal(f.runner.checkpoint.pending_action, null);
  await f.runner.stop();
});

test('断线恢复后未执行的旧epoch动作不会卡住或在新会话重放', async () => {
  const f = fixture(); await activate(f);
  f.runner.checkpoint.pending_action = { run_id: 'run-1', session_epoch: 1, action_id: 'old-action', type: 'say', payload: { text: '旧意图', channel: 'nearby' } };
  await f.runner.recoverPending();
  assert.equal(f.calls.filter(x => x.name === 'act').length, 0);
  assert.equal(f.runner.checkpoint.pending_action, null);
  assert.equal(f.runner.checkpoint.next_action_id, 'action-1');
  await f.runner.stop();
});

test('无效模型输出只纠正一次，两个实际请求都计入预算', async () => {
  let sent = 0;
  const f = fixture({ mode: 'model', fetchImpl: async () => {
    sent++; f.advance(6000);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '不是 JSON' } }] }) };
  } });
  await activate(f); await f.runner.decide();
  assert.equal(sent, 2);
  assert.equal(f.runner.checkpoint.calls_used, 2);
  assert.equal(f.calls.filter(x => x.name === 'act').length, 0);
  await f.runner.stop();
});

test('同一预算段恢复不重置调用计数和截止时间', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-runner-'));
  const path = join(directory, 'checkpoint.json');
  const f = fixture({ mode: 'model', checkpointPath: path });
  await activate(f);
  f.runner.checkpoint.calls_used = 37;
  const deadline = f.runner.checkpoint.expires_at;
  f.runner.save(); await f.runner.stop();
  const restored = fixture({ mode: 'model', checkpointPath: path });
  restored.control.run.has_joined = true;
  try {
    await activate(restored);
    assert.equal(restored.runner.checkpoint.calls_used, 37);
    assert.equal(restored.runner.checkpoint.expires_at, deadline);
    assert.equal(restored.runner.active, true);
  } finally { await restored.runner.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('已入场预算段缺失或损坏本地记录会暂停，禁止归零继续', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-runner-'));
  const path = join(directory, 'checkpoint.json');
  writeFileSync(path, '{broken');
  const f = fixture({ mode: 'model', checkpointPath: path });
  f.control.run.has_joined = true;
  try {
    await activate(f);
    assert.equal(f.runner.active, false);
    assert.equal(f.calls.filter(x => x.name === 'pause_self').length, 1);
    assert.equal(f.calls.filter(x => x.name === 'act').length, 0);
  } finally { await f.runner.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('空等待不会持续调用模型，事件循环在模型等待时仍独立运行', async () => {
  let sent = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  const f = fixture({ mode: 'model', fetchImpl: async () => {
    sent++;
    inFlight++;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 500));
    inFlight--;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"type":"wait","payload":{}}' } }] }) };
  } });
  f.control.status = 'offline';
  const original = f.runner.client.callTool;
  f.runner.client.callTool = async request => {
    if (request.name === 'join_world') f.control.status = 'active';
    return original(request);
  };
  f.runner.start();
  await f.runner.ready;
  await new Promise(resolve => setTimeout(resolve, 900));
  await f.runner.stop();
  assert.equal(sent, 1);
  assert.equal(maximumInFlight, 1);
  assert.ok(f.calls.filter(x => x.name === 'get_events').length >= 2);
  assert.equal(f.calls.filter(x => x.name === 'act').length, 0);
});

test('两个独立参考运行器通过真实 MCP 自主往返交流、邀请入组并报名', { timeout: 20000 }, async t => {
  const { createApp } = await import('../server/index.js');
  const application = await createApp({ dbPath: ':memory:', frontend: false, demo: false, seed: false });
  const { server, url } = await application.start(0);
  const runners = [];
  t.after(async () => {
    await Promise.allSettled(runners.map(r => r.stop()));
    await application.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  for (const name of ['协议测试小禾', '协议测试阿橘']) {
    const agent = application.world.createAgent({ name, bio: '独立运行器测试' });
    const controller = application.world.createController(agent.agent_id, { name: '独立MCP运行器', kind: 'external' });
    application.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
    const runner = new PlazaRunner({ url: `${url}/mcp`, token: controller.token, mode: 'demo', decisionIntervalMs: 2000, pollSeconds: 1 });
    runners.push(runner); runner.start();
  }
  await Promise.all(runners.map(r => r.ready));
  const deadline = Date.now() + 15000;
  let world;
  while (Date.now() < deadline) {
    world = application.world.ownerSnapshot();
    if (world.groups.some(g => g.members.length === 2) && world.game?.participants.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(world.agents.filter(a => a.status === 'active').length, 2);
  assert.ok(world.groups.some(g => g.members.length === 2), JSON.stringify(world.events));
  assert.equal(world.game?.status, 'recruiting');
  assert.equal(world.game?.participants.length, 2);
  assert.equal(new Set(world.events.filter(e => e.type === 'message').map(e => e.payload.agent_id)).size, 2);
  assert.ok(world.agents.every(a => a.diagnostics.calls_used === 0), '模拟运行不能冒充模型调用');
});
