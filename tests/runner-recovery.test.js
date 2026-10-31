import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server/index.js';
import { PlazaRunner, RunnerError, enqueueEvents } from '../runner/runner.js';

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(30); }
  assert.fail(message);
}

async function fixture(t) {
  const temporaryRoot = resolve(tmpdir()), directory = mkdtempSync(join(temporaryRoot, 'plaza-recovery-'));
  const checkpointPath = join(directory, 'runner.json'), dbPath = join(directory, 'world.sqlite');
  let offset = 0, application, server, port, url;
  const clock = () => Date.now() + offset, runners = [], requests = [], logs = [];
  const model = { reply: () => ({ status: 200, content: '{"type":"wait","payload":{}}' }) };
  const modelServer = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString()); requests.push(request);
    const stored = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    assert.ok(stored.calls_used >= requests.length, '真实 HTTP 模型请求发出前必须已有持久预算');
    assert.ok(stored.counters.requests >= requests.length, '真实请求统计同样先落盘');
    const response = await model.reply(request);
    if (res.destroyed) return;
    res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: response.content } }], ...(response.usage ? { usage: response.usage } : {}) }));
  });
  await new Promise(resolvePromise => modelServer.listen(0, '127.0.0.1', resolvePromise));
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  async function open() {
    application = await createApp({ dbPath, frontend: false, demo: false });
    application.world.now = clock;
    const started = await application.start(port || 0); server = started.server; url = started.url; port = server.address().port;
  }
  async function close() {
    if (!server) return;
    const old = server; server = null;
    await application.close(); old.closeAllConnections(); await new Promise(resolvePromise => old.close(resolvePromise));
  }
  await open();
  const profile = application.world.createAgent({ name: '恢复测试原角色' });
  const controller = application.world.createController(profile.agent_id, { kind: 'external' });
  application.world.ownerControl(profile.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 100 });
  const originalRun = structuredClone(application.world.agent(profile.agent_id).run);
  async function runner({ manual = false, ...options } = {}) {
    const next = new PlazaRunner({ mode: 'model', url: `${url}/mcp`, token: controller.token, checkpointPath, now: clock, pollSeconds: 0,
      idleMs: 90000, model: { baseUrl: modelUrl, model: 'test', apiKey: 'private-local-key' }, logger: line => logs.push(line), ...options });
    runners.push(next);
    if (manual) {
      next.running = true; next.abort = new AbortController(); await next.initialize(); await next.activate(await next.call('get_control_state', {}));
    } else { next.start(); await next.ready; }
    return next;
  }
  t.after(async () => {
    await Promise.allSettled(runners.map(value => value.stop())); await close();
    modelServer.closeAllConnections(); await new Promise(resolvePromise => modelServer.close(resolvePromise));
    assert.equal(dirname(directory), temporaryRoot); rmSync(directory, { recursive: true, force: true });
  });
  return { get app() { return application; }, profile, controller, originalRun, runner, close, open, requests, model, logs, clock,
    checkpointPath, disk: () => JSON.parse(readFileSync(checkpointPath, 'utf8')), advance: ms => { offset += ms; } };
}

for (const elapsed of [0, 46000]) test(`真实 MCP 服务重启恢复同一身份预算并重新读取规则（额外时钟停机 ${elapsed}ms）`, { timeout: 20000 }, async t => {
  const f = await fixture(t), runner = await f.runner();
  await until(() => runner.checkpoint?.calls_used === 1 && !runner.modelAbort, '初次模型决策未完成');
  const before = f.disk(), oldGeneration = runner.connectionGeneration;
  await f.close();
  await until(() => !runner.connected, '服务关闭未识别为断线');
  await sleep(400); // Separate real socket outage, not only a mocked exception/clock.
  f.advance(elapsed); await f.open();
  const baseRules = f.app.world.getRules.bind(f.app.world);
  f.app.world.getRules = () => ({ ...baseRules(), rules_version: 'recovery-test-refreshed' });
  const restoredAt = Date.now();
  await until(() => runner.active && runner.observation?.session_epoch > before.session_epoch && runner.rules?.rules_version === 'recovery-test-refreshed', '未用原授权恢复并刷新规则');
  assert.ok(Date.now() - restoredAt < 90000);
  t.diagnostic(`依赖恢复至同身份入场 ${Date.now() - restoredAt} ms；测试注入额外 ${elapsed} ms 时钟`);
  assert.equal(runner.checkpoint.run_id, before.run_id);
  assert.equal(runner.observation.self.agent_id, f.profile.agent_id);
  assert.equal(runner.checkpoint.expires_at, before.expires_at);
  assert.equal(runner.checkpoint.max_calls, before.max_calls);
  assert.ok(runner.checkpoint.calls_used >= before.calls_used);
  assert.ok(runner.connectionGeneration > oldGeneration);
  assert.equal(f.app.world.agent(f.profile.agent_id).run.run_id, f.originalRun.run_id);
});

test('真实墙钟停服46秒后复用持久身份与预算恢复（按需长探针）', { timeout: 90000, skip: process.env.PLAZA_LONG_RECOVERY !== '1' }, async t => {
  const f = await fixture(t), runner = await f.runner();
  await until(() => runner.checkpoint?.calls_used === 1 && !runner.modelAbort, '首次模型请求未完成');
  const before = f.disk(); await f.close(); const stoppedAt = Date.now();
  // Windows timers may wake slightly before their requested delay. Keep the
  // actual outage threshold; do not treat one timer callback as elapsed time.
  while (Date.now() - stoppedAt < 46000) await sleep(Math.max(1, 46000 - (Date.now() - stoppedAt)));
  assert.ok(Date.now() - stoppedAt >= 46000);
  await f.open(); const restoredAt = Date.now();
  await until(() => runner.active && runner.observation.session_epoch > before.session_epoch, '真实长停服后未恢复', 35000);
  const recoveryMs = Date.now() - restoredAt;
  assert.equal(runner.checkpoint.run_id, before.run_id); assert.equal(runner.observation.self.agent_id, f.profile.agent_id);
  assert.equal(runner.checkpoint.expires_at, before.expires_at); assert.equal(runner.checkpoint.max_calls, before.max_calls);
  assert.ok(runner.checkpoint.calls_used >= before.calls_used); assert.ok(recoveryMs < 90000);
  t.diagnostic(`真实墙钟停服 ${restoredAt - stoppedAt} ms，恢复耗时 ${recoveryMs} ms，原 run/agent/deadline/max_calls 均保留；calls_used ${before.calls_used} → ${runner.checkpoint.calls_used}`);
});

test('进程启动时服务未就绪仍恢复；暂停、转交和过期后保持原授权边界', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.close(); const runner = await f.runner();
  assert.equal(runner.active, false); await f.open();
  await until(() => runner.active && runner.checkpoint?.calls_used >= 1 && !runner.modelAbort, '启动故障后未恢复');
  f.app.world.ownerControl(f.profile.agent_id, 'pause');
  await until(() => !runner.active && runner.health.waiting_reason === 'owner_paused', '未识别主人暂停');
  const count = runner.checkpoint.calls_used;
  await f.close(); await sleep(100); await f.open(); await sleep(1600);
  assert.equal(runner.active, false); assert.equal(runner.checkpoint.calls_used, count);
  assert.equal(f.app.world.agent(f.profile.agent_id).run.status, 'paused');
  const other = f.app.world.createController(f.profile.agent_id);
  f.app.world.ownerControl(f.profile.agent_id, 'transfer', { controller_id: other.controller_id });
  await until(() => runner.health.waiting_reason === 'controller_busy', '转交后未明确报告控制冲突');
  assert.equal(runner.active, false);
  f.app.world.ownerControl(f.profile.agent_id, 'transfer', { controller_id: f.controller.controller_id, duration_minutes: 0.001 });
  f.advance(1000);
  await until(() => runner.health.waiting_reason === 'grant_expired', '过期授权被误恢复');
  assert.equal(runner.active, false); assert.equal(runner.checkpoint.calls_used, count);
});

test('模型失败保留已落盘消息批次，进程重启后成功 wait 才 ACK；新消息不被旧批次吞掉', { timeout: 20000 }, async t => {
  const f = await fixture(t); let runner = await f.runner({ manual: true });
  const events = [{ event_id: 'friend-1', type: 'message', payload: { agent_id: 'friend', text: '一起看看田地？' } }];
  runner.checkpoint = enqueueEvents(runner.checkpoint, events, f.profile.agent_id); runner.save();
  f.model.reply = () => ({ status: 503 }); await runner.decide();
  assert.equal(f.disk().event_batch.events[0].event_id, 'friend-1');
  assert.equal(f.disk().last_acked_batch, undefined); assert.equal(f.disk().calls_used, 1);
  const batchId = f.disk().event_batch.id;
  await runner.stop(); f.advance(6000); runner = await f.runner({ manual: true });
  runner.checkpoint.queue.push({ event_id: 'friend-2', type: 'message', payload: { agent_id: 'friend', text: '我在这里。' } });
  f.model.reply = request => {
    assert.equal(JSON.parse(request.messages.at(-1).content).events[0].event_id, 'friend-1');
    return { content: '{"type":"wait","payload":{}}', usage: { prompt_tokens: 31, completion_tokens: 8 } };
  };
  await runner.decide();
  assert.equal(f.disk().event_batch, undefined); assert.equal(f.disk().last_acked_batch.id, batchId);
  assert.deepEqual(f.disk().last_acked_batch.event_ids, ['friend-1']);
  assert.deepEqual(f.disk().queue.map(event => event.event_id), ['friend-2']);
  assert.equal(f.disk().calls_used, 2); assert.equal(f.disk().counters.requests, 2); assert.equal(f.disk().counters.retries, 1);
  assert.deepEqual(f.disk().token_usage, { input_tokens: 31, output_tokens: 8, source: 'provider' });
});

test('动作已在真实 HTTP 服务提交但回复丢失，重启查询旧回执仅执行一次并 ACK', { timeout: 15000 }, async t => {
  const f = await fixture(t); let runner = await f.runner({ manual: true });
  runner.checkpoint.queue.push({ event_id: 'friend-1', type: 'message', payload: { agent_id: 'friend', text: '你好' } });
  f.model.reply = () => ({ content: '{"type":"say","payload":{"channel":"nearby","text":"只发送这一次"}}' });
  const call = runner.call.bind(runner);
  runner.call = async (name, args) => {
    const result = await call(name, args);
    if (name === 'act') throw new RunnerError('WORLD_UNAVAILABLE', '模拟收到服务提交后的连接中断');
    return result;
  };
  await assert.rejects(runner.decide(), { code: 'WORLD_UNAVAILABLE' });
  const pending = f.disk().pending_action, batch = f.disk().event_batch;
  assert.ok(pending); assert.ok(batch);
  await runner.stop(); await f.close(); await sleep(150); await f.open();
  runner = await f.runner({ manual: true });
  assert.equal(runner.checkpoint.pending_action, null); assert.equal(runner.checkpoint.event_batch, undefined);
  assert.equal(runner.checkpoint.last_acked_batch.id, batch.id);
  assert.equal(f.requests.length, 1, '恢复旧意图不再次调用模型');
  assert.equal(f.app.world.state.events.filter(event => event.type === 'message' && event.payload.text === '只发送这一次').length, 1);
  assert.equal(f.app.world.callTool(f.app.world.authenticate(f.controller.token), 'get_action_result', { action_id: pending.action_id }).status, 'applied');
});

test('本机预检失败不花请求预算，宿主恢复后真实 onRequest 计数；暂停丢弃迟到回复和旧批次', { timeout: 15000 }, async t => {
  const f = await fixture(t); let available = false, complete, began;
  const started = new Promise(resolvePromise => { began = resolvePromise; });
  const pet = {
    prepareDecision: context => ({ text: JSON.stringify(context.events) }),
    async decide(_context, { onRequest }) {
      if (!available) throw new RunnerError('PET_NOT_FOUND', '桌宠未启动');
      await onRequest(); began(); return new Promise(resolvePromise => { complete = resolvePromise; });
    },
  };
  const runner = await f.runner({ manual: true, mode: 'dsh-pet', petClient: pet });
  runner.checkpoint.queue.push({ event_id: 'hello', type: 'message', payload: { agent_id: 'friend', text: '来吗？' } });
  await runner.decide();
  assert.equal(f.disk().calls_used, 0); assert.equal(f.disk().counters.requests, 0); assert.equal(f.disk().counters.local_failures, 1);
  assert.equal(runner.health.waiting_reason, 'host_unavailable'); assert.equal(f.disk().event_batch.events[0].event_id, 'hello');
  available = true; f.advance(6000); const decision = runner.decide(); await started;
  f.app.world.ownerControl(f.profile.agent_id, 'pause');
  complete('{"type":"say","payload":{"channel":"nearby","text":"暂停后不能发送"}}'); await decision;
  assert.equal(runner.active, false); assert.equal(f.disk().event_batch, undefined);
  assert.equal(f.disk().calls_used, 1); assert.equal(f.disk().counters.requests, 1);
  assert.equal(f.app.world.state.events.filter(event => event.payload.text === '暂停后不能发送').length, 0);
});

test('新授权立即暂停时诊断绑定新run，不把旧预算计数算到新run', { timeout: 10000 }, async t => {
  const f = await fixture(t), runner = await f.runner();
  await until(() => runner.checkpoint?.calls_used === 1 && !runner.modelAbort, '首次决策未完成');
  const oldRun = runner.checkpoint.run_id;
  f.app.world.ownerControl(f.profile.agent_id, 'pause');
  f.app.world.ownerControl(f.profile.agent_id, 'resume', { controller_id: f.controller.controller_id });
  f.app.world.ownerControl(f.profile.agent_id, 'pause');
  await until(() => f.app.world.agent(f.profile.agent_id).diagnostics.health?.waiting_reason === 'owner_paused', '新暂停诊断被旧run阻塞');
  const actual = f.app.world.agent(f.profile.agent_id);
  assert.notEqual(actual.run.run_id, oldRun); assert.equal(runner.checkpoint.run_id, oldRun);
  assert.equal(actual.diagnostics.health.counters, undefined); assert.equal(actual.diagnostics.calls_used, 0);
  assert.equal(runner.active, false);
});

test('暂停期间只读宿主健康检查不请求模型、不恢复角色、不花预算', { timeout: 10000 }, async t => {
  const f = await fixture(t); let checks = 0;
  f.app.world.ownerControl(f.profile.agent_id, 'pause');
  const petClient = { verifiedAt: f.clock(), async preflight() { checks++; if (checks > 1) throw new RunnerError('PET_UNAVAILABLE', '桌宠已关闭'); }, async decide() { assert.fail('暂停不应请求原AI'); } };
  const runner = await f.runner({ mode: 'dsh-pet', petClient });
  await until(() => runner.health.waiting_reason === 'owner_paused', '未读取暂停状态');
  assert.equal(runner.health.host, 'ready');
  f.advance(31000); await until(() => checks === 1, '暂停期间缺少宿主探测');
  f.advance(31000); await until(() => runner.health.host === 'unavailable', '未发现桌宠关闭');
  assert.equal(runner.active, false); assert.equal(runner.checkpoint, null); assert.equal(f.requests.length, 0);
  assert.equal(f.app.world.agent(f.profile.agent_id).run.status, 'paused');
});

test('消息批次取最早未处理文本，紧急事件最多连续插队两次并报告真实积压', { timeout: 10000 }, async t => {
  const f = await fixture(t), delivered = [];
  const petClient = {
    prepareDecision: context => ({ text: JSON.stringify(context.events) }),
    async decide(context, { onRequest }) { await onRequest(); delivered.push(context.events[0].event_id); return '{"type":"wait","payload":{}}'; },
  };
  const runner = await f.runner({ manual: true, mode: 'dsh-pet', petClient });
  runner.checkpoint.queue = [{ event_id: 'old-message', type: 'message', payload: { agent_id: 'friend', text: '先前的话' } },
    { event_id: 'new-message', type: 'message', payload: { agent_id: 'friend', text: '后来的话' } }];
  runner.checkpoint.dropped_events = 3;
  for (let attempt = 0; attempt < 3; attempt++) {
    runner.checkpoint.queue.push({ event_id: `danger-${attempt}`, type: 'adventure_danger', payload: { agent_id: f.profile.agent_id, text: '危险' } });
    f.advance(6000); await runner.decide();
  }
  assert.deepEqual(delivered, ['danger-0', 'danger-1', 'old-message']);
  assert.ok(runner.checkpoint.queue.some(event => event.event_id === 'new-message'));
  assert.equal(runner.healthReport().pending_events, 2); assert.equal(runner.healthReport().dropped_events, 3);
});

test('暂停中的后台宿主预检与决策预检串行，校验后不会被并发发现切换端口', { timeout: 10000 }, async t => {
  const f = await fixture(t); let finish, entered, probing = false;
  const began = new Promise(resolvePromise => { entered = resolvePromise; });
  const petClient = {
    async preflight() { probing = true; entered(); await new Promise(resolvePromise => { finish = resolvePromise; }); probing = false; },
    prepareDecision: () => ({ text: '{}' }),
    async decide(_context, { onRequest }) { assert.equal(probing, false); await onRequest(); return '{"type":"wait","payload":{}}'; },
  };
  const runner = await f.runner({ manual: true, mode: 'dsh-pet', petClient });
  const probe = runner.checkHost(); await began; const decision = runner.decide(); await sleep(30);
  assert.equal(f.disk().calls_used, 0); finish(); await probe; await decision;
  assert.equal(f.disk().calls_used, 1);
});

test('旧epoch未发送的pending动作在重启后不重放，事件保留供原AI重新选择', { timeout: 10000 }, async t => {
  const f = await fixture(t); let runner = await f.runner({ manual: true });
  runner.checkpoint.queue.push({ event_id: 'friend', type: 'message', payload: { agent_id: 'friend', text: '你好' } });
  f.model.reply = () => ({ content: '{"type":"say","payload":{"channel":"nearby","text":"旧会话意图"}}' });
  const call = runner.call.bind(runner);
  runner.call = async (name, args) => { if (name === 'act') throw new RunnerError('WORLD_UNAVAILABLE', '在动作发出前断线'); return call(name, args); };
  await assert.rejects(runner.decide(), { code: 'WORLD_UNAVAILABLE' });
  const before = f.disk(); await runner.stop(); await f.close(); await sleep(150); await f.open();
  runner = await f.runner({ manual: true });
  assert.equal(runner.checkpoint.pending_action, null); assert.equal(runner.checkpoint.event_batch.id, before.event_batch.id);
  assert.equal(f.app.world.state.events.filter(event => event.payload.text === '旧会话意图').length, 0);
  f.advance(6000); f.model.reply = () => ({ content: '{"type":"wait","payload":{}}' }); await runner.decide();
  assert.equal(f.disk().event_batch, undefined); assert.equal(f.disk().calls_used, 2);
  assert.equal(f.app.world.state.events.filter(event => event.payload.text === '旧会话意图').length, 0);
});

for (const boundary of ['pause', 'transfer', 'expired']) test(`${boundary}边界拒绝迟到wait且不ACK旧消息`, { timeout: 10000 }, async t => {
  const f = await fixture(t), runner = await f.runner({ manual: true });
  let finish, started; const began = new Promise(resolvePromise => { started = resolvePromise; });
  f.model.reply = async () => { started(); return new Promise(resolvePromise => { finish = resolvePromise; }); };
  runner.checkpoint.queue.push({ event_id: 'old', type: 'message', payload: { agent_id: 'friend', text: '这是之前的话题' } });
  const decision = runner.decide(); await began;
  if (boundary === 'pause') f.app.world.ownerControl(f.profile.agent_id, 'pause');
  if (boundary === 'transfer') {
    const next = f.app.world.createController(f.profile.agent_id); f.app.world.ownerControl(f.profile.agent_id, 'transfer', { controller_id: next.controller_id });
  }
  if (boundary === 'expired') f.advance(3600001);
  finish({ content: '{"type":"wait","payload":{}}' }); await decision;
  assert.equal(runner.active, false); assert.equal(f.disk().last_acked_batch, undefined);
  assert.equal(f.disk().event_batch, undefined); assert.equal(f.disk().calls_used, 1);
});

test('规则升级为不兼容时停止生成动作并报告，修复规则后重新握手恢复同预算', { timeout: 15000 }, async t => {
  const f = await fixture(t), runner = await f.runner();
  await until(() => runner.checkpoint?.calls_used === 1 && !runner.modelAbort, '初次决策未完成');
  const before = f.disk(), baseRules = f.app.world.getRules.bind(f.app.world);
  f.app.world.getRules = () => ({ ...baseRules(), required_skill_version: '9.0.0', skill_version: '9.0.0' });
  f.advance(61000);
  await until(() => runner.health.world === 'incompatible' && !runner.active, '未发现不兼容规则');
  const requests = f.requests.length; await sleep(1200);
  assert.equal(f.requests.length, requests);
  f.app.world.getRules = () => ({ ...baseRules(), rules_version: 'recovered-compatible' });
  await until(() => runner.active && runner.rules.rules_version === 'recovered-compatible', '兼容规则恢复后未重握手');
  assert.equal(runner.checkpoint.run_id, before.run_id); assert.equal(runner.checkpoint.expires_at, before.expires_at);
});
