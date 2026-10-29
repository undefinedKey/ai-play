import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createApp } from '../server/index.js';
import { SkillClient } from '../skills/ai-plaza/scripts/plaza.mjs';

const skillRoot = fileURLToPath(new URL('../skills/ai-plaza/', import.meta.url));
const script = join(skillRoot, 'scripts', 'plaza.mjs');

function temporary(t) {
  const base = resolve(tmpdir());
  const folder = mkdtempSync(join(base, 'plaza-skill-test-'));
  t.after(() => {
    if (dirname(resolve(folder)) !== base || !folder.startsWith(join(base, 'plaza-skill-test-'))) throw new Error('Unsafe temporary directory');
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

async function command(file, args, statePath, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, AI_PLAZA_STATE: statePath }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise(resolvePromise => instance.listen(0, '127.0.0.1', resolvePromise));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolvePromise => instance.close(resolvePromise)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

async function fixture(t) {
  const folder = temporary(t);
  let now = Date.now();
  const application = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false, authMode: 'local', pairingNow: () => now });
  application.world.now = () => now;
  const { server: instance, url } = await application.start(0);
  t.after(async () => { await application.close(); instance.closeAllConnections(); await new Promise(resolvePromise => instance.close(resolvePromise)); });
  const session = await fetch(`${url}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const api = async (path, body) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const role = (await api('/api/agents', { name: 'Skill 测试角色' })).agent;
  const options = { statePath: join(folder, 'state', 'client.json'), defaultUrl: url, now: () => now, sleep: async ms => { now += ms; } };
  const client = new SkillClient(options);
  const approve = async (instanceClient, grant = {}) => {
    const pairing = instanceClient.state.pairing;
    await api(`/api/skill/pair/${pairing.user_code}/approve`, { agent_id: role.agent_id, duration_minutes: 5, max_calls: 20, ...grant });
    now += 3000;
    assert.equal((await instanceClient.connect()).status, 'connected');
  };
  return { folder, application, url, api, role, options, client, approve, advance: ms => { now += ms; } };
}

test('Skill 客户端：独立复制 Skill 目录即可运行，不依赖项目 node_modules 或包配置', async t => {
  const folder = temporary(t);
  const destination = join(folder, 'isolated-skill');
  cpSync(skillRoot, destination, { recursive: true });
  const statePath = join(folder, 'local-state', 'client.json');
  const output = await command(join(destination, 'scripts', 'plaza.mjs'), ['status'], statePath, folder);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).status, 'not_connected');
  assert.equal(existsSync(join(folder, 'node_modules')), false);
  assert.equal(existsSync(statePath), false);
});

test('Skill 客户端：真实网页配对保存凭据，输出不含秘密，按 MCP 初始化与授权会话实际入场', async t => {
  const f = await fixture(t);
  const requests = [];
  f.client.fetch = async (url, options) => { requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null }); return fetch(url, options); };
  const pending = await f.client.connect();
  assert.equal(pending.status, 'pending');
  const pairSecret = f.client.state.pairing.device_secret;
  assert.ok(!JSON.stringify(pending).includes(pairSecret));
  const stored = JSON.parse(readFileSync(f.options.statePath, 'utf8'));
  assert.equal(stored.pairing.device_secret, pairSecret);
  assert.equal(stored.token, undefined);
  const resumed = new SkillClient({ ...f.options, fetchImpl: f.client.fetch });
  await f.approve(resumed);
  const token = resumed.state.token;
  const connectedFile = JSON.parse(readFileSync(f.options.statePath, 'utf8'));
  assert.equal(connectedFile.token, token);
  assert.equal(connectedFile.pairing, undefined);
  assert.ok(!resumed.redact({ ...resumed.status(), echo: token }).includes(token));
  if (process.platform !== 'win32') assert.equal(statSync(f.options.statePath).mode & 0o777, 0o600);
  const entered = await resumed.enter();
  assert.equal(entered.status, 'entered');
  assert.equal(entered.observation.self.agent_id, f.role.agent_id);
  assert.ok(entered.observation.next_action_id);
  const messages = requests.filter(r => r.url.endsWith('/mcp'));
  assert.deepEqual(messages.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call', 'tools/call']);
  const initialize = messages[0].body;
  assert.equal(initialize.jsonrpc, '2.0'); assert.equal(typeof initialize.id, 'string');
  assert.equal(initialize.params.protocolVersion, '2025-03-26');
  assert.deepEqual(initialize.params.capabilities, {});
  assert.equal(initialize.params.clientInfo.name, 'ai-plaza-skill');
  assert.equal(messages[1].body.id, undefined);
  for (const request of messages) { assert.equal(request.options.redirect, 'error'); assert.equal(request.options.headers.Authorization, `Bearer ${token}`); }
  assert.equal(messages[2].options.headers['MCP-Protocol-Version'], resumed.protocol);
  await resumed.call('observe', { run_id: 'forged', session_epoch: 999 });
  const observationArgs = requests.at(-1).body.params.arguments;
  assert.equal(observationArgs.run_id, resumed.state.session.run_id);
  assert.equal(observationArgs.session_epoch, resumed.state.session.session_epoch);
  const output = await command(script, ['status'], f.options.statePath, f.folder);
  assert.equal(output.code, 0, output.stderr);
  assert.ok(!output.stdout.includes(token)); assert.ok(!output.stderr.includes(token));
});

test('Skill 客户端：拒绝或到期不自动重新申请授权，等待有界且旧服务不触发配对', async t => {
  const f = await fixture(t);
  await f.client.connect();
  await f.api(`/api/skill/pair/${f.client.state.pairing.user_code}/deny`, {});
  f.advance(3000);
  assert.equal((await f.client.connect()).status, 'denied');
  const deniedId = f.client.state.pairing.pairing_id;
  assert.equal((await f.client.connect({ wait: true })).status, 'denied');
  assert.equal(f.client.state.pairing.pairing_id, deniedId);
  await f.client.connect();
  assert.notEqual(f.client.state.pairing.pairing_id, deniedId);
  const before = f.client.now();
  assert.equal((await f.client.connect({ wait: true })).status, 'pending');
  assert.ok(f.client.now() - before <= 25000);
  const pendingId = f.client.state.pairing.pairing_id;
  f.advance(600000);
  assert.equal((await f.client.connect({ wait: true })).status, 'expired');
  assert.equal(f.client.state.pairing.pairing_id, pendingId);
  let posts = 0;
  const legacyUrl = await server(t, (req, res) => { if (req.method === 'POST') posts++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, version: '0.2.0' })); });
  const legacy = new SkillClient({ statePath: join(f.folder, 'legacy.json'), defaultUrl: legacyUrl });
  await assert.rejects(legacy.connect(), { code: 'UPGRADE_REQUIRED' });
  assert.equal(posts, 0);
  assert.equal(existsSync(legacy.path), false);
});

test('Skill 客户端：MCP 重定向不携带凭据到其他地址，命令错误输出也隐藏服务回显的令牌', async t => {
  const folder = temporary(t);
  const token = 'Test-only-token-never-use-in-production';
  let downstream = 0;
  const target = await server(t, (_req, res) => { downstream++; res.end('{}'); });
  const redirector = await server(t, (_req, res) => { res.writeHead(307, { Location: `${target}/mcp` }); res.end(); });
  const statePath = join(folder, 'client.json');
  writeFileSync(statePath, JSON.stringify({ version: 1, url: redirector, token }), { mode: 0o600 });
  const client = new SkillClient({ statePath });
  await assert.rejects(client.call('get_rules'), { code: 'NETWORK_ERROR' });
  assert.equal(downstream, 0);
  const reflector = await server(t, (_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'TEST_ERROR', message: `Rejected credential ${token}` } })); });
  writeFileSync(statePath, JSON.stringify({ version: 1, url: reflector, token }), { mode: 0o600 });
  const result = await command(script, ['call', 'get_rules'], statePath, folder);
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token), 'CLI errors must redact reflected credentials');
});

test('Skill 客户端：动作已落地但响应丢失时，跨进程恢复原动作并去重；新动作不能越过未决动作', async t => {
  const f = await fixture(t);
  await f.client.connect(); await f.approve(f.client); await f.client.enter();
  const action = { type: 'say', payload: { text: '只发一次', channel: 'nearby', extra: { nested: 'original' } } };
  const initialId = f.client.state.next_action_id;
  let drop = true;
  f.client.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    const response = await fetch(url, options);
    if (drop && body?.method === 'tools/call' && body.params.name === 'act') { drop = false; await response.arrayBuffer(); throw new Error('Simulated lost reply after commit'); }
    return response;
  };
  await assert.rejects(f.client.call('act', action), { code: 'NETWORK_ERROR' });
  const pending = JSON.parse(readFileSync(f.options.statePath, 'utf8')).pending;
  assert.equal(pending.action_id, initialId);
  assert.equal(f.application.world.state.events.filter(e => e.type === 'message' && e.payload.text === action.payload.text).length, 1);
  const resumed = new SkillClient(f.options);
  await assert.rejects(resumed.call('act', { ...action, payload: { ...action.payload, extra: { nested: 'changed' } } }), { code: 'ACTION_PENDING' });
  // Rejoining the same authorization must not silently discard an unknown action.
  await resumed.enter();
  assert.equal(resumed.state.pending.action_id, initialId);
  const result = await resumed.call('act', action);
  assert.equal(result.status, 'applied'); assert.equal(result.action_id, initialId);
  assert.equal(f.application.world.state.events.filter(e => e.type === 'message' && e.payload.text === action.payload.text).length, 1);
  assert.equal(resumed.state.pending, undefined);
  assert.notEqual(resumed.state.next_action_id, initialId);
});

test('Skill 客户端：响应未知可查询原回执，主人暂停后不能继续提交旧会话动作', async t => {
  const f = await fixture(t);
  await f.client.connect(); await f.approve(f.client); await f.client.enter();
  const action = { type: 'wait', payload: {} };
  let drop = true;
  f.client.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    const response = await fetch(url, options);
    if (drop && body?.method === 'tools/call' && body.params.name === 'act') { drop = false; await response.arrayBuffer(); throw new Error('Lost reply'); }
    return response;
  };
  await assert.rejects(f.client.call('act', action), { code: 'NETWORK_ERROR' });
  const pendingId = f.client.state.pending.action_id;
  const result = await f.client.call('get_action_result');
  assert.equal(result.status, 'applied'); assert.equal(result.action_id, pendingId);
  assert.equal(f.client.state.pending, undefined);
  await f.api(`/api/agents/${f.role.agent_id}/control`, { operation: 'pause' });
  await assert.rejects(f.client.call('observe'), { code: 'STALE_SESSION' });
  assert.equal(f.client.state.session, undefined);
  await assert.rejects(f.client.call('act', action), { code: 'NOT_IN_WORLD' });
});

test('Skill 客户端：活动预算跨进程与重连保留，未知结果重试只计一次，额度耗尽须主人重新授权', async t => {
  const f = await fixture(t);
  f.application.world.actionIntervalMs = 0;
  await f.client.connect(); await f.approve(f.client, { max_calls: 2 }); await f.client.enter();
  const action = { type: 'wait', payload: {} };
  let drop = true;
  f.client.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    const response = await fetch(url, options);
    if (drop && body?.method === 'tools/call' && body.params.name === 'act') { drop = false; await response.arrayBuffer(); throw new Error('Lost first action reply'); }
    return response;
  };
  await assert.rejects(f.client.call('act', action), { code: 'NETWORK_ERROR' });
  assert.equal(JSON.parse(readFileSync(f.options.statePath, 'utf8')).calls_used, 1);
  const resumed = new SkillClient(f.options);
  await resumed.enter();
  assert.equal(resumed.state.calls_used, 1);
  await resumed.call('act', action);
  assert.equal(resumed.state.calls_used, 1);
  assert.equal(f.application.world.agent(f.role.agent_id).diagnostics.calls_used, 1);
  assert.equal(Object.keys(f.application.world.state.receipts).length, 1);
  await resumed.call('act', action);
  assert.equal(resumed.state.calls_used, 2);
  assert.equal(f.application.world.agent(f.role.agent_id).diagnostics.calls_used, 2);
  await assert.rejects(resumed.call('act', action), error => ['BUDGET_EXHAUSTED', 'STALE_SESSION', 'NOT_IN_WORLD'].includes(error.code));
  assert.equal(Object.keys(f.application.world.state.receipts).length, 2);
  assert.equal(f.application.world.agent(f.role.agent_id).run.status, 'paused');
  const exhausted = new SkillClient(f.options);
  await assert.rejects(exhausted.enter(), error => ['NOT_AUTHORIZED', 'STALE_SESSION', 'RUN_EXPIRED'].includes(error.code));
  assert.equal(exhausted.state.calls_used, 2);
  await f.api(`/api/agents/${f.role.agent_id}/control`, { operation: 'resume', controller_id: exhausted.state.controller_id, duration_minutes: 5, max_calls: 1 });
  await exhausted.enter();
  assert.equal(exhausted.state.calls_used, 0);
  let loseFinal = true;
  exhausted.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    const response = await fetch(url, options);
    if (loseFinal && body?.method === 'tools/call' && body.params.name === 'act') { loseFinal = false; await response.arrayBuffer(); throw new Error('Lost reply at final budget slot'); }
    return response;
  };
  await assert.rejects(exhausted.call('act', action), { code: 'NETWORK_ERROR' });
  assert.equal(exhausted.state.calls_used, 1);
  const finalRetry = new SkillClient(f.options);
  await finalRetry.enter();
  assert.equal(finalRetry.state.calls_used, 1);
  assert.equal((await finalRetry.call('act', action)).status, 'applied');
  assert.equal(finalRetry.state.calls_used, 1);
  assert.equal(Object.keys(f.application.world.state.receipts).length, 3);
});
