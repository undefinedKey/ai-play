import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlazaRunner, parseModelAction, enqueueEvents, decodeToolResult } from '../runner/runner.js';
import { MODEL_REQUEST_MS, HOST_PREFLIGHT_MS, DECISION_WATCHDOG_MS } from '../skills/ai-plaza/scripts/timing.mjs';

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

test('持续坏输出跨轮直接纠错且不再双调，真实成功后清错并保留事件与预算', async () => {
  const prompts = [];
  const f = fixture({ mode: 'model', fetchImpl: async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[1].content); f.advance(6000);
    return { ok: true, json: async () => ({ choices: [{ message: { content: prompts.length < 4 ? '坏格式' : '{"type":"inventory","payload":{"intent":"use","item_id":"turnip"}}' } }] }) };
  } });
  await activate(f);
  f.runner.rules.allowed_actions = ['inventory'];
  f.runner.checkpoint.queue.push({ event_id: 'hungry-1', type: 'survival_warning', payload: { agent_id: 'agent-a', kind: 'hunger' } });
  const maxCalls = f.runner.checkpoint.max_calls, expiresAt = f.runner.checkpoint.expires_at;
  try {
    await f.runner.decide();
    const batchId = f.runner.checkpoint.event_batch.id;
    assert.equal(prompts.length, 2); assert.equal(f.runner.decisionDue(), false);
    f.advance(31000); await f.runner.decide();
    assert.equal(prompts.length, 3, '后续故障轮只发一次纠错请求');
    assert.equal(f.runner.checkpoint.event_batch.id, batchId);
    assert.deepEqual(f.runner.checkpoint.event_batch.events.map(e => e.event_id), ['hungry-1']);
    assert.equal(f.calls.filter(c => c.name === 'act').length, 0);
    assert.ok(JSON.parse(prompts[2]).format_correction);
    f.advance(31000); await f.runner.decide();
    assert.equal(prompts.length, 4); assert.ok(JSON.parse(prompts[3]).format_correction);
    assert.equal(f.runner.checkpoint.calls_used, 4); assert.equal(f.runner.checkpoint.max_calls, maxCalls); assert.equal(f.runner.checkpoint.expires_at, expiresAt);
    assert.equal(f.runner.checkpoint.consecutive_errors, 0); assert.equal(f.runner.checkpoint.model_retry_at, 0);
    assert.equal(f.runner.health.error_code, null);
    assert.equal(f.runner.checkpoint.output_correction_pending, undefined);
    assert.equal(f.runner.checkpoint.pending_action, null); assert.equal(f.runner.checkpoint.event_batch, undefined);
    assert.deepEqual(f.runner.checkpoint.last_acked_batch.event_ids, ['hungry-1']);
    const actions = f.calls.filter(c => c.name === 'act');
    assert.equal(actions.length, 1); assert.equal(actions[0].args.payload.item_id, 'turnip');
    assert.equal(f.calls.filter(c => c.name === 'report_status').at(-1).args.last_error, null);
  } finally { await f.runner.stop(); }
});

test('旧checkpoint中的坏输出状态在重启后仍直接纠错，不清批次或增加授权', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-correction-'));
  const path = join(directory, 'checkpoint.json'); let prompts = [];
  const first = fixture({ mode: 'model', checkpointPath: path, fetchImpl: async () => {
    first.advance(6000); return { ok: true, json: async () => ({ choices: [{ message: { content: '坏格式' } }] }) };
  } });
  await activate(first); await first.runner.decide(); await first.runner.stop();
  const legacy = JSON.parse(readFileSync(path, 'utf8')); delete legacy.output_correction_pending;
  writeFileSync(path, JSON.stringify(legacy));
  const restored = fixture({ mode: 'model', checkpointPath: path, fetchImpl: async (_url, options) => {
    prompts.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"type":"wait","payload":{}}' } }] }) };
  } });
  restored.control.run.has_joined = true;
  try {
    await activate(restored); restored.advance(60000); await restored.runner.decide();
    assert.equal(prompts.length, 1); assert.ok(prompts[0].format_correction, '旧版持久错误应在首次恢复请求中纠正');
    assert.equal(restored.runner.checkpoint.calls_used, 3); assert.equal(restored.runner.checkpoint.max_calls, legacy.max_calls);
    assert.equal(restored.runner.checkpoint.expires_at, legacy.expires_at); assert.equal(restored.runner.checkpoint.output_correction_pending, undefined);
    assert.equal(restored.runner.checkpoint.last_acked_batch.id, legacy.event_batch.id);
    assert.equal(restored.calls.filter(c => c.name === 'act').length, 0, 'AI选择wait仍不替它行动');
  } finally { await restored.runner.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('坏输出消耗最后一个预算时不追加纠错，也不丢弃未确认事件伪造成功', async () => {
  let requests = 0;
  const f = fixture({ mode: 'model', fetchImpl: async () => {
    requests++; return { ok: true, json: async () => ({ choices: [{ message: { content: '坏格式' } }] }) };
  } });
  await activate(f); f.runner.checkpoint.max_calls = 1;
  try {
    await f.runner.decide();
    assert.equal(requests, 1); assert.equal(f.runner.checkpoint.calls_used, 1); assert.ok(f.runner.checkpoint.event_batch);
    assert.equal(f.runner.checkpoint.last_acked_batch, undefined); assert.equal(f.calls.filter(c => c.name === 'act').length, 0);
    await assert.rejects(f.runner.modelDecision(f.observation, []), { code: 'BUDGET_EXHAUSTED' });
    assert.equal(requests, 1); assert.equal(f.runner.checkpoint.max_calls, 1);
  } finally { await f.runner.stop(); }
});

test('历史救援风暴合为一次待确认摘要，保留聊天且不每五秒打断已运行计划', async () => {
  const f = fixture({ mode: 'model' }); await activate(f);
  f.runner.mode = 'dsh-pet'; const inputs = [];
  f.runner.petClient = { decide: async context => { inputs.push(context); f.advance(6000); return '{"type":"wait","payload":{}}'; } };
  f.observation.self.adventure = { hp: 100, max_hp: 100, plan: { intent: 'rest', expires_at: f.control.run.expires_at } };
  f.observation.self.survival = { satiety: 70 };
  const rescues = Array.from({ length: 30 }, (_, i) => ({ event_id: `rescue-${i}`, type: 'survival_rescued', occurred_at: f.runner.now() - 300000 + i * 1000,
    payload: { agent_id: 'agent-a', kind: 'starving', text: '倒地获救，恢复10点生命并获得120秒保护' } }));
  const chat = { event_id: 'friend-chat', type: 'message', payload: { agent_id: 'agent-b', text: '一起探索吗？' } };
  f.runner.checkpoint.queue.push(...rescues, chat);
  try {
    await f.runner.decide();
    assert.equal(inputs.length, 1); assert.equal(inputs[0].events.length, 1); assert.equal(inputs[0].events[0].event_id, 'rescue-29');
    assert.match(inputs[0].events[0].payload.text, /历史救援/); assert.match(inputs[0].events[0].payload.text, /当前观察/);
    assert.equal(f.runner.checkpoint.last_acked_batch.event_ids.length, 30);
    assert.deepEqual(new Set(f.runner.checkpoint.last_acked_batch.event_ids), new Set(rescues.map(e => e.event_id)));
    assert.deepEqual(f.runner.checkpoint.queue.map(e => e.event_id), ['friend-chat']);
    f.advance(6000); await f.runner.decide();
    assert.equal(inputs[1].events[0].payload.text, chat.payload.text);
    f.advance(6000); assert.equal(f.runner.decisionDue(), false, '历史库存耗尽后遵守计划复查间隔');
    assert.equal(f.runner.checkpoint.calls_used, 2); assert.equal(f.calls.filter(c => c.name === 'act').length, 0);
  } finally { await f.runner.stop(); }
});

test('救援摘要只有有效决定才确认，模型请求期间的新救援保持独立唤醒', async () => {
  const f = fixture({ mode: 'model' }); await activate(f); f.runner.mode = 'dsh-pet'; let sent = 0;
  f.runner.petClient = { decide: async () => {
    sent++; f.advance(6000);
    if (sent === 3) f.runner.checkpoint.queue.push({ event_id: 'new-rescue', type: 'survival_rescued', occurred_at: f.runner.now(), payload: { agent_id: 'agent-a' } });
    return sent < 3 ? '坏格式' : '{"type":"wait","payload":{}}';
  } };
  f.runner.checkpoint.queue.push(...[1, 2, 3].map(i => ({ event_id: `old-${i}`, type: 'survival_rescued', occurred_at: f.runner.now() - 60000 + i, payload: { agent_id: 'agent-a' } })));
  try {
    await f.runner.decide();
    assert.equal(f.runner.checkpoint.last_acked_batch, undefined);
    assert.equal(f.runner.checkpoint.event_batch.events[0].event_id, 'old-3');
    assert.deepEqual(f.runner.checkpoint.event_batch.coalesced_event_ids, ['old-1', 'old-2']);
    assert.equal(f.runner.healthReport().pending_events, 3, '合批尚未确认的原通知仍计入积压');
    f.advance(31000); await f.runner.decide();
    assert.deepEqual(new Set(f.runner.checkpoint.last_acked_batch.event_ids), new Set(['old-1', 'old-2', 'old-3']));
    assert.deepEqual(f.runner.checkpoint.queue.map(e => e.event_id), ['new-rescue']);
    f.advance(6000); assert.equal(f.runner.decisionDue(), true); await f.runner.decide();
    assert.deepEqual(f.runner.checkpoint.last_acked_batch.event_ids, ['new-rescue']);
    assert.equal(f.runner.healthReport().pending_events, 0);
    assert.equal(f.runner.checkpoint.calls_used, 4);
  } finally { await f.runner.stop(); }
});

test('带救援摘要的未知动作仍用原ID恢复，恢复回执后才确认整个批次', async () => {
  const f = fixture(); await activate(f);
  const action = { ...f.runner.session(), action_id: 'already-paid', type: 'inventory', payload: { intent: 'use', item_id: 'turnip' } };
  f.runner.checkpoint.pending_action = structuredClone(action);
  f.runner.checkpoint.pending_batch_id = 'saved-rescue-batch';
  f.runner.checkpoint.event_batch = { id: 'saved-rescue-batch', events: [{ event_id: 'rescue-latest', type: 'survival_rescued', payload: { agent_id: 'agent-a' } }], coalesced_event_ids: ['rescue-earlier'] };
  try {
    await f.runner.performDecision();
    assert.deepEqual(f.calls.find(c => c.name === 'act').args, action);
    assert.deepEqual(new Set(f.runner.checkpoint.last_acked_batch.event_ids), new Set(['rescue-earlier', 'rescue-latest']));
    assert.equal(f.runner.checkpoint.pending_action, null); assert.equal(f.runner.checkpoint.calls_used, 0);
  } finally { await f.runner.stop(); }
});

test('两次65秒格式纠错均在有限生成窗口内，重读观察、不扩大预算或触发旧120秒看门狗', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sent = 0, release;
  const reachRequest = async count => {
    for (let i = 0; i < 20 && sent < count; i++) { await new Promise(setImmediate); t.mock.timers.tick(0); }
    assert.equal(sent, count);
  };
  const f = fixture({ mode: 'model', fetchImpl: async (url, options) => {
    sent++; await new Promise(resolve => { release = resolve; });
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ choices: [{ message: { content: sent === 1 ? '无效格式' : '{"type":"wait","payload":{}}' } }] }) };
  } });
  await activate(f); const originalDeadline = f.runner.checkpoint.expires_at;
  const decision = f.runner.decide(); await reachRequest(1);
  f.advance(65000); t.mock.timers.tick(65000); release();
  await reachRequest(2); f.advance(65000); t.mock.timers.tick(65000); release(); await decision;
  assert.equal(sent, 2); assert.equal(f.runner.checkpoint.calls_used, 2); assert.equal(f.runner.active, true);
  assert.equal(f.runner.checkpoint.expires_at, originalDeadline);
  assert.ok(f.calls.filter(call => call.name === 'observe').length >= 2);
  assert.equal(MODEL_REQUEST_MS, 75000); assert.equal(HOST_PREFLIGHT_MS, 10000);
  assert.ok(DECISION_WATCHDOG_MS >= 2 * (MODEL_REQUEST_MS + HOST_PREFLIGHT_MS) && DECISION_WATCHDOG_MS <= 180000);
  await f.runner.stop();
});

test('75秒真实请求上限仍取消并记一次预算，不能无限等待或自动补动作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sent = 0, signal;
  const f = fixture({ mode: 'model', fetchImpl: async (url, options) => {
    sent++; signal = options.signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('超时'), { name: 'AbortError' })), { once: true }));
  } });
  await activate(f); const decision = f.runner.decide();
  for (let i = 0; i < 20 && !sent; i++) { await new Promise(setImmediate); t.mock.timers.tick(0); }
  assert.equal(sent, 1); t.mock.timers.tick(74999); assert.equal(signal.aborted, false);
  f.advance(75000); t.mock.timers.tick(1); await decision;
  assert.equal(signal.aborted, true); assert.equal(f.runner.checkpoint.calls_used, 1);
  assert.equal(f.calls.filter(call => call.name === 'act').length, 0); assert.ok(f.runner.checkpoint.event_batch);
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
