import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { acquireClientLock, createBridge, migrateCheckpoint } from '../skills/ai-plaza/scripts/bridge.mjs';
import { main as skillMain } from '../skills/ai-plaza/scripts/plaza.mjs';
import { OFFICIAL_SOURCE } from '../skills/ai-plaza/scripts/update.mjs';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';

const skillRoot = fileURLToPath(new URL('../skills/ai-plaza/', import.meta.url));
const json = result => ({ ok: true, json: async () => result });
function temporary(t) {
  const root = resolve(tmpdir()); const path = mkdtempSync(join(root, 'plaza-bridge-test-'));
  t.after(() => { assert.equal(dirname(path), root); rmSync(path, { recursive: true, force: true }); });
  return path;
}
function fixture(t) {
  const directory = temporary(t); const statePath = join(directory, 'client.json');
  let now = Date.now(); const requests = [];
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const agent = world.createAgent({ name: '桥测试' }); const controller = world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
  const auth = world.authenticate(controller.token);
  const state = { version: 1, url: 'http://world.example', token: controller.token, agent_id: agent.agent_id, controller_id: controller.controller_id };
  writeFileSync(statePath, JSON.stringify(state));
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.headers['X-DSH-Pet-Token'], undefined);
    const body = JSON.parse(options.body); let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    if (body.method === 'notifications/initialized') result = {};
    if (body.method === 'tools/list') result = { tools: Object.keys(toolDefinitions).map(name => ({ name })) };
    if (body.method === 'tools/call') result = { structuredContent: world.callTool(auth, body.params.name, body.params.arguments) };
    return json({ jsonrpc: '2.0', id: body.id, result });
  };
  const petClient = { petId: 'original', name: '原宠物', connection: { baseUrl: 'http://127.0.0.1:32995/dsh-pet-7340' }, initialize: async () => {}, decide: async () => '{"type":"wait","payload":{}}' };
  return { statePath, state, world, auth, agent, directory, requests, options: { statePath, fetchImpl, petClient, start: false, now: () => now }, advance: ms => { now += ms; } };
}
async function initialize(bridge, f) {
  bridge.runner.running = true; bridge.runner.abort = new AbortController();
  await bridge.runner.initialize(); await bridge.runner.activate(f.world.callTool(f.auth, 'get_control_state'));
}

test('桥持有与Skill命令相同的整个生命周期锁，不能双开或绕过CLI控制', async t => {
  const f = fixture(t); const bridge = await createBridge(f.options); t.after(() => bridge.stop());
  assert.equal(existsSync(f.statePath + '.lock'), true);
  await assert.rejects(createBridge(f.options), e => e.code === 'CLIENT_BUSY');
  await assert.rejects(skillMain(['call', 'get_control_state'], { statePath: f.statePath }), e => e.code === 'CLIENT_BUSY');
  await bridge.stop(); assert.equal(existsSync(f.statePath + '.lock'), false);
  const release = acquireClientLock(f.statePath); release();
});

test('接管已enter的Skill迁移cursor、pending、用量，取服务器较大计数且不重播旧动作', async t => {
  const f = fixture(t);
  const observation = f.world.callTool(f.auth, 'join_world');
  const pending = { run_id: observation.run_id, session_epoch: observation.session_epoch, action_id: observation.next_action_id, type: 'say', payload: { channel: 'nearby', text: '仅执行一次' } };
  const receipt = f.world.callTool(f.auth, 'act', pending);
  f.world.callTool(f.auth, 'report_status', { run_id: observation.run_id, session_epoch: observation.session_epoch, calls_used: 9 });
  f.state.session = { run_id: observation.run_id, session_epoch: observation.session_epoch, expires_at: observation.expires_at };
  Object.assign(f.state, { cursor: observation.cursor, next_action_id: observation.next_action_id, pending, calls_used: 7, budget_run_id: observation.run_id });
  writeFileSync(f.statePath, JSON.stringify(f.state));
  const bridge = await createBridge(f.options);
  try {
  const migrated = JSON.parse(readFileSync(bridge.checkpointPath, 'utf8'));
  assert.equal(migrated.calls_used, 9); assert.equal(migrated.cursor, observation.cursor);
  assert.equal(migrated.pending_action.action_id, pending.action_id);
  await initialize(bridge, f);
  assert.equal(bridge.runner.checkpoint.calls_used, 9);
  assert.equal(bridge.runner.checkpoint.pending_action, null);
  assert.equal(bridge.runner.checkpoint.next_action_id, receipt.next_action_id);
  assert.equal(f.world.state.events.filter(e => e.type === 'message').length, 1);
  const tools = f.requests.map(r => JSON.parse(r.options.body)).filter(r => r.method === 'tools/call');
  assert.equal(tools.filter(r => r.params.name === 'act').length, 0);
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).calls_used, 9);
  } finally { await bridge.stop(); }
});

test('迁移不扩大既有额度/期限，并拒绝损坏预算与冲突未确认动作', () => {
  const state = { session: { run_id: 'r', session_epoch: 1, expires_at: 900 }, budget_run_id: 'r', calls_used: 8, cursor: '12', next_action_id: 'a', pending: { action_id: 'x' } };
  const control = { run: { run_id: 'r', controller_id: 'c', max_calls: 30, expires_at: 1000 }, diagnostics: { calls_used: 9 } };
  const old = { version: 1, run_id: 'r', session_epoch: 1, calls_used: 10, max_calls: 20, expires_at: 800, cursor: '10', queue: [], next_action_id: 'old' };
  const cp = migrateCheckpoint(state, control, old);
  assert.equal(cp.calls_used, 10); assert.equal(cp.max_calls, 20); assert.equal(cp.expires_at, 800); assert.equal(cp.cursor, '12');
  assert.throws(() => migrateCheckpoint({ ...state, calls_used: -1 }, control, old), e => e.code === 'STATE_INVALID');
  assert.throws(() => migrateCheckpoint(state, control, { ...old, pending_action: { action_id: 'other' } }), e => e.code === 'ACTION_PENDING_CONFLICT');
});

test('损坏桥checkpoint不能归零，启动错误会释放锁且不调用原AI', async t => {
  const f = fixture(t); writeFileSync(f.statePath + '.bridge.json', '{broken');
  let generated = 0; f.options.petClient.decide = async () => { generated++; return '{}'; };
  await assert.rejects(createBridge(f.options), e => e.code === 'CHECKPOINT_INVALID');
  assert.equal(existsSync(f.statePath + '.lock'), false); assert.equal(generated, 0);
});

test('已绑定原宿主暂不可用时保留预算启动等待，恢复后沿原来源的新端口继续', async t => {
  const f = fixture(t), runtimePath = join(f.directory, 'runtime.json');
  writeFileSync(runtimePath, JSON.stringify({ port: 32980, token: 'a'.repeat(43) }));
  const observation = f.world.callTool(f.auth, 'join_world');
  Object.assign(f.state, { session: { run_id: observation.run_id, session_epoch: observation.session_epoch, expires_at: observation.expires_at },
    cursor: observation.cursor, next_action_id: observation.next_action_id, calls_used: 7, budget_run_id: observation.run_id });
  writeFileSync(f.statePath, JSON.stringify(f.state));
  let online = true, posts = 0;
  const options = { ...f.options, petClient: undefined, petId: 'original', runtimePath, petUrl: 'http://127.0.0.1:32980', petFetchImpl: async (url, request) => {
    if (!online) throw new Error('host down');
    if (request.method === 'POST') { posts++; return json({ ok: true, text: '{"type":"wait","payload":{}}' }); }
    return json({ main: { pets: [{ id: 'original', display: 'both', name: '原宠物' }] } });
  } };
  const initial = await createBridge(options); await initial.stop(); online = false;
  const waiting = await createBridge(options); assert.equal(waiting.pet.petId, 'original');
  assert.equal(JSON.parse(readFileSync(waiting.checkpointPath)).calls_used, 7); assert.equal(posts, 0);
  writeFileSync(runtimePath, JSON.stringify({ port: 32981, token: 'b'.repeat(43) })); online = true;
  await waiting.pet.initialize(); assert.equal(waiting.pet.connection.baseUrl, 'http://127.0.0.1:32981/dsh-pet-7340');
  assert.equal(waiting.pet.petId, 'original'); await waiting.stop();
  await assert.rejects(createBridge({ ...options, petId: 'different' }), { code: 'PET_BINDING_CHANGED' });
});

test('已有预算记录可在服务启动前等待重连，不丢弃manual较高计数；新连接不伪造成功', async t => {
  const f = fixture(t), observation = f.world.callTool(f.auth, 'join_world');
  Object.assign(f.state, { session: { run_id: observation.run_id, session_epoch: observation.session_epoch, expires_at: observation.expires_at },
    cursor: observation.cursor, next_action_id: observation.next_action_id, calls_used: 7, budget_run_id: observation.run_id });
  writeFileSync(f.statePath, JSON.stringify(f.state));
  const initial = await createBridge(f.options); await initial.stop();
  const state = JSON.parse(readFileSync(f.statePath)); state.calls_used = 9; writeFileSync(f.statePath, JSON.stringify(state));
  const offline = { ...f.options, fetchImpl: async () => { throw new Error('world offline'); } };
  const waiting = await createBridge(offline);
  assert.equal(JSON.parse(readFileSync(waiting.checkpointPath)).calls_used, 9); await waiting.stop();
  rmSync(f.statePath + '.bridge.json');
  await assert.rejects(createBridge(offline), { code: 'NETWORK_ERROR' });
});

test('真实CLI启动时世界503仍保持恢复循环，服务恢复后原授权入场', { timeout: 15000 }, async t => {
  const f = fixture(t), observation = f.world.callTool(f.auth, 'join_world');
  Object.assign(f.state, { session: { run_id: observation.run_id, session_epoch: observation.session_epoch, expires_at: observation.expires_at },
    cursor: observation.cursor, next_action_id: observation.next_action_id, calls_used: 7, budget_run_id: observation.run_id });
  writeFileSync(f.statePath, JSON.stringify(f.state));
  const initial = await createBridge(f.options); await initial.stop();
  let available = false, joined = false, posts = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/config')) return res.end(JSON.stringify({ main: { pets: [{ id: 'original', display: 'both' }] } }));
    if (req.url.startsWith('/dsh-pet-7340/chat?')) { posts++; return res.end(JSON.stringify({ ok: true, text: '{"type":"wait","payload":{}}' })); }
    if (!available) { res.statusCode = 503; return res.end('{}'); }
    const request = JSON.parse(body); if (request.params?.name === 'join_world') joined = true;
    const reply = await f.options.fetchImpl('', { body, headers: {} }); res.end(JSON.stringify(await reply.json()));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const url = `http://127.0.0.1:${server.address().port}`, cpPath = f.statePath + '.bridge.json';
  f.state.url = url; writeFileSync(f.statePath, JSON.stringify(f.state));
  const cp = JSON.parse(readFileSync(cpPath)); cp.bridge_binding.pet_url = url + '/dsh-pet-7340'; writeFileSync(cpPath, JSON.stringify(cp));
  const version = JSON.parse(readFileSync(join(skillRoot, 'version.json'))).version;
  writeFileSync(f.statePath + '.updates.json', JSON.stringify({ source: OFFICIAL_SOURCE, local_version: version, checked_at: Date.now(), status: 'unavailable' }));
  const child = spawn(process.execPath, [join(skillRoot, 'scripts/bridge.mjs'), 'run', '--pet', 'original', '--pet-url', url],
    { windowsHide: true, env: { ...process.env, AI_PLAZA_STATE: f.statePath, DSH_HOME: f.directory, DSH_PET_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => child.once('exit', done));
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  const until = async check => { const deadline = Date.now() + 8000; while (!check()) { assert.equal(child.exitCode, null, stderr); assert.ok(Date.now() < deadline, stdout + stderr); await new Promise(done => setTimeout(done, 25)); } };
  await until(() => stdout.includes('已启动')); assert.equal(posts, 0);
  available = true; await until(() => joined && posts > 0);
  assert.equal(child.exitCode, null); assert.equal(JSON.parse(readFileSync(cpPath)).run_id, observation.run_id);
  assert.ok(JSON.parse(readFileSync(cpPath)).calls_used >= 7);
});

test('单独复制Skill目录可import共享runtime并运行pets，无node_modules依赖', async t => {
  const directory = temporary(t); const destination = join(directory, 'portable'); cpSync(skillRoot, destination, { recursive: true });
  const server = createServer((req, res) => { assert.equal(req.url, '/dsh-pet-7340/config'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ main: { pets: [{ id: 'same-pet', name: '原宠物', display: 'both' }] } })); });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolvePromise => server.close(resolvePromise)); });
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(destination, 'scripts', 'bridge.mjs'), 'pets', '--pet-url', `http://127.0.0.1:${server.address().port}`],
      { cwd: directory, windowsHide: true, env: { ...process.env, DSH_HOME: directory } });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr); assert.equal(JSON.parse(output.stdout).pets[0].id, 'same-pet');
  assert.equal(existsSync(join(directory, 'node_modules')), false);
});
