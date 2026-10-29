import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { World } from '../server/world.js';
import { AccountStore } from '../server/auth.js';

const secret = () => randomBytes(32).toString('base64url');
async function fixture(t, paths = {}) {
  let app, server, url;
  const launch = async () => {
    app = await createApp({ dbPath: paths.world || ':memory:', authDbPath: paths.auth || ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.test:3000', allowHttp: true, frontend: false, seed: false, demo: false });
    if (!app.accounts.firstAdmin()) await app.accounts.createAdmin({ username: 'invite_admin', passwordless: true });
    ({ server, url } = await app.start(0));
  };
  const close = async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await launch(); t.after(close);
  const api = async (path, body, session = {}, withOrigin = true, extra = {}) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(withOrigin ? { Origin: app.config.publicUrl.origin } : {}), ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = async () => {
    const ticket = app.accounts.createLoginTicket(app.accounts.firstAdmin().id);
    const login = await api('/api/auth/link', { token: ticket.token });
    return { cookie: login.cookie, csrf_token: login.body.csrf_token };
  };
  const issue = async (options = {}) => {
    const result = await api('/api/admin/ai-invites', options, await admin());
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  };
  const redeem = (input, extra = {}) => api('/api/skill/redeem', input, {}, false, extra);
  return { get app() { return app; }, get url() { return url; }, api, admin, issue, redeem, restart: async () => { await close(); await launch(); } };
}

test('AI邀请码直接建立独立member角色和固定授权，可用MCP入场但不发主人会话', async t => {
  const f = await fixture(t), invitation = await f.issue({ duration_minutes: 1440, max_calls: 500, goal: 'PRIVATE_INVITE_GOAL' });
  const input = { invite_code: invitation.invite_code, device_secret: secret(), name: '我的原 AI', bio: '已有身份', avatar: '🐱', color: '#123456' };
  const result = await f.redeem(input);
  assert.equal(result.status, 201); assert.equal(result.cookie, undefined);
  assert.deepEqual(Object.keys(result.body).sort(), ['agent_id', 'agent_name', 'controller_id', 'expires_at', 'max_calls', 'mcp_url', 'owner_username', 'token']);
  assert.equal(result.body.token, createHmac('sha256', input.device_secret).update(`ai-plaza-agent-invite-v1:${input.invite_code}`).digest('base64url'));
  assert.equal(result.body.max_calls, 500); assert.equal(result.body.agent_name, input.name);
  const agent = f.app.world.agent(result.body.agent_id), owner = f.app.accounts.getOwner(agent.owner_id);
  assert.equal(owner.role, 'member'); assert.equal(owner.username, result.body.owner_username); assert.notEqual(owner.id, f.app.accounts.firstAdmin().id);
  assert.equal(agent.run.max_calls, 500); assert.equal(agent.goal, 'PRIVATE_INVITE_GOAL');
  const raw = JSON.stringify(f.app.accounts.db.prepare('SELECT * FROM agent_invitations').all());
  for (const value of [input.invite_code, input.device_secret, result.body.token]) assert.ok(!raw.includes(value));
  assert.equal(f.app.accounts.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id=?').get(owner.id).n, 0);
  const client = new Client({ name: 'invite-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${result.body.token}` } } }));
  try {
    const joined = await client.callTool({ name: 'join_world', arguments: {} });
    assert.equal(joined.structuredContent.self.agent_id, agent.agent_id);
    assert.equal(joined.structuredContent.self.name, input.name);
  } finally { await client.close(); }
  assert.equal((await f.api(`/api/agents/${agent.agent_id}/control`, { operation: 'resume' }, {}, false, { Authorization: `Bearer ${result.body.token}` })).status, 403);
  assert.equal((await f.api('/api/auth/link/create', {}, {}, false, { Authorization: `Bearer ${result.body.token}` })).status, 403);
  const publicWorld = await f.api('/api/public/world'); assert.ok(!JSON.stringify(publicWorld.body).includes('PRIVATE_INVITE_GOAL'));
});

test('同设备重试、服务重启及码过期后重取沿用同角色/预算；其他设备不可领取，已撤销控制端不复活', async t => {
  const base = resolve(tmpdir()), path = mkdtempSync(join(base, 'plaza-invite-persist-'));
  const cleanup = () => { assert.equal(dirname(path), base); rmSync(path, { recursive: true, force: true }); };
  // Explicit cleanup after fixture's close avoids deleting open SQLite/lock files on Windows.
  const f = await fixture(t, { world: join(path, 'world.sqlite'), auth: join(path, 'auth.sqlite') });
  t.after(cleanup);
  const invitation = await f.issue({ duration_minutes: 15, max_calls: 8 });
  const input = { invite_code: invitation.invite_code, device_secret: secret(), name: '重试 AI' };
  const first = await f.redeem(input); assert.equal(first.status, 201);
  const runId = f.app.world.agent(first.body.agent_id).run.run_id;
  assert.deepEqual((await f.redeem({ ...input, name: '不能重命名' })).body, first.body);
  assert.equal((await f.redeem({ ...input, device_secret: secret() })).body.error.code, 'INVITE_ALREADY_USED');
  await f.restart();
  f.app.accounts.db.prepare('UPDATE agent_invitations SET expires_at=0').run();
  assert.deepEqual((await f.redeem(input)).body, first.body);
  assert.equal(f.app.world.agent(first.body.agent_id).run.run_id, runId);
  assert.equal(f.app.accounts.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 2);
  assert.equal(Object.keys(f.app.world.state.agents).length, 1);
  f.app.world.state.controllers[first.body.controller_id].revoked = true; f.app.world.commit();
  assert.equal((await f.redeem(input)).body.error.code, 'NOT_AUTHORIZED');
  assert.equal(f.app.world.state.controllers[first.body.controller_id].revoked, true);
  assert.equal(f.app.world.agent(first.body.agent_id).run.run_id, runId);
});

test('不同设备并发争用邀请码只建立一组账号角色，输入校验与不同邀请码类型不会消费原码', async t => {
  const f = await fixture(t), invitation = await f.issue(), input = { invite_code: invitation.invite_code, device_secret: secret(), name: '原 AI' };
  for (const invalid of [{ ...input, name: '' }, { ...input, name: 'x'.repeat(21) }, { ...input, bio: 'x'.repeat(201) }, { ...input, avatar: 'x'.repeat(21) }, { ...input, color: 'red' }, { ...input, duration_minutes: 10080 }, { ...input, role: 'admin' }, { ...input, device_secret: 'bad' }]) assert.equal((await f.redeem(invalid)).status, 400);
  assert.equal(f.app.accounts.db.prepare('SELECT used_at FROM agent_invitations').get().used_at, null);
  assert.equal((await f.redeem(input, { Origin: 'https://evil.test' })).status, 403);
  const accountInvite = f.app.accounts.createInvite(f.app.accounts.firstAdmin().id);
  assert.equal((await f.redeem({ ...input, invite_code: accountInvite.invite_code })).body.error.code, 'INVALID_INVITE');
  await assert.rejects(f.app.accounts.register({ username: 'wrong_type', password: 'test-long-password', invite_code: invitation.invite_code }), { code: 'INVALID_INVITE' });
  const results = await Promise.all([f.redeem(input), f.redeem({ ...input, device_secret: secret() })]);
  assert.equal(results.filter(result => result.status === 201).length, 1); assert.equal(results.filter(result => result.body.error?.code === 'INVITE_ALREADY_USED').length, 1);
  assert.equal(Object.keys(f.app.world.state.agents).length, 1); assert.equal(f.app.accounts.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 2);
});

test('存储或世界变更失败会补偿世界快照、回滚账号和邀请码，同设备可安全重试', async t => {
  const f = await fixture(t), invitation = await f.issue(), input = { invite_code: invitation.invite_code, device_secret: secret(), name: '故障恢复 AI' };
  const before = structuredClone(f.app.world.state), create = f.app.world.createController;
  f.app.world.createController = function(...args) { create.apply(this, args); throw new Error('injected after world persistence'); };
  assert.equal((await f.redeem(input)).body.error.code, 'AUTH_STORAGE_ERROR');
  f.app.world.createController = create;
  assert.deepEqual(f.app.world.state, before); assert.equal(f.app.accounts.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1);
  assert.equal(f.app.accounts.db.prepare('SELECT used_at FROM agent_invitations').get().used_at, null);
  const originalExec = f.app.accounts.db.exec.bind(f.app.accounts.db); let failCommit = true;
  f.app.accounts.db.exec = sql => { if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('injected auth commit failure'); } return originalExec(sql); };
  assert.equal((await f.redeem(input)).body.error.code, 'AUTH_STORAGE_ERROR');
  f.app.accounts.db.exec = originalExec;
  assert.deepEqual(f.app.world.state, before); assert.equal(f.app.accounts.db.prepare('SELECT used_at FROM agent_invitations').get().used_at, null);
  assert.equal((await f.redeem(input)).status, 201);
  assert.equal(Object.keys(f.app.world.state.agents).length, 1);
});

test('房间暂停、过期与匿名创建受限；邀请额度由签发者预设，成员不能发邀请或控制别人', async t => {
  const f = await fixture(t), invitation = await f.issue({ max_calls: 7 }), input = { invite_code: invitation.invite_code, device_secret: secret(), name: '成员 AI' };
  f.app.world.ownerRoom('pause');
  assert.equal((await f.redeem(input)).body.error.code, 'ROOM_PAUSED');
  assert.equal(f.app.accounts.db.prepare('SELECT used_at FROM agent_invitations').get().used_at, null);
  f.app.world.ownerRoom('resume');
  const redeemed = await f.redeem(input), owner = f.app.accounts.getOwnerByUsername(redeemed.body.owner_username);
  const ticket = f.app.accounts.createLoginTicket(owner.id), login = await f.api('/api/auth/link', { token: ticket.token });
  const session = { cookie: login.cookie, csrf_token: login.body.csrf_token };
  assert.equal((await f.api('/api/admin/ai-invites', {}, session)).status, 403);
  assert.equal((await f.api('/api/admin/ai-invites', {})).status, 401);
  const other = f.app.world.createAgent({ name: '另一主人', owner_id: f.app.accounts.firstAdmin().id });
  assert.equal((await f.api(`/api/agents/${other.agent_id}/control`, { operation: 'pause' }, session)).status, 403);
  const expired = await f.issue(); f.app.accounts.db.prepare('UPDATE agent_invitations SET expires_at=0 WHERE id=?').run(expired.invite_id);
  assert.equal((await f.redeem({ ...input, invite_code: expired.invite_code })).body.error.code, 'INVALID_INVITE');
  assert.equal(f.app.world.agent(redeemed.body.agent_id).run.max_calls, 7);
});

test('内部指定令牌禁止全局复用，公开创建控制端不能指定token；兑换限流', async t => {
  const world = new World();
  try {
    const one = world.createAgent({ name: 'one' }), two = world.createAgent({ name: 'two' }), token = secret();
    world.createController(one.agent_id, { token });
    assert.throws(() => world.createController(two.agent_id, { token }), { code: 'TOKEN_CONFLICT' });
    assert.throws(() => world.createController(two.agent_id, { token: 'bad' }), { code: 'INVALID_ACTION' });
  } finally { world.close(); }
  const f = await fixture(t), admin = await f.admin();
  const agent = await f.api('/api/agents', { name: '普通网页角色' }, admin), supplied = secret();
  const controller = await f.api(`/api/agents/${agent.body.agent.agent_id}/controllers`, { kind: 'external', token: supplied }, admin);
  assert.equal(controller.status, 201); assert.notEqual(controller.body.token, supplied);
  for (let i = 0; i < 20; i++) assert.equal((await f.redeem({ invite_code: 'invalid', device_secret: secret(), name: 'AI' })).status, 400);
  assert.equal((await f.redeem({ invite_code: 'invalid', device_secret: secret(), name: 'AI' })).status, 429);
});

test('真实子进程在world提交与账号COMMIT之间退出：启动前回收明确标记的孤立授权，同码设备可重试', async () => {
  const base = resolve(tmpdir()), path = mkdtempSync(join(base, 'plaza-invite-crash-'));
  const worldPath = join(path, 'world.sqlite'), authPath = join(path, 'auth.sqlite');
  let store, world, app, server;
  try {
    store = new AccountStore({ dbPath: authPath });
    const admin = await store.createAdmin({ username: 'crash_admin', passwordless: true });
    const invitation = store.createAgentInvite(admin.id, { max_calls: 12 });
    const input = { invite_code: invitation.invite_code, device_secret: secret(), name: '崩溃后重试' };
    const token = createHmac('sha256', input.device_secret).update(`ai-plaza-agent-invite-v1:${input.invite_code}`).digest('base64url');
    store.close(); store = null;
    world = new World({ dbPath: worldPath });
    const ordinary = world.createAgent({ name: '无标记的既有角色', owner_id: 'unrelated-missing-owner' });
    world.close(); world = null;
    const appModule = new URL('../server/index.js', import.meta.url).href;
    const code = `import {createApp} from ${JSON.stringify(appModule)};
const app=await createApp(${JSON.stringify({ dbPath: worldPath, authDbPath: authPath, authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.test:3000', allowHttp: true, frontend: false, seed: false, demo: false })});
app.accounts.redeemAgentInvite(${JSON.stringify(input)},(owner,options,invitation_claim)=>{
  const agent=app.world.createAgent({name:'crash-orphan',owner_id:owner.id,invitation_claim});
  const controller=app.world.createController(agent.agent_id,{token:${JSON.stringify(token)}});
  app.world.ownerControl(agent.agent_id,'start',{...options,controller_id:controller.controller_id});
  process.exit(23);
});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    assert.equal(result, 23, errors);
    store = new AccountStore({ dbPath: authPath });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1);
    assert.equal(store.db.prepare('SELECT used_at FROM agent_invitations').get().used_at, null);
    store.close(); store = null;
    world = new World({ dbPath: worldPath });
    const orphan = Object.values(world.state.agents).find(agent => agent.invitation_claim);
    assert.ok(orphan); assert.equal(Object.keys(world.state.controllers).length, 1);
    world.close(); world = null;
    app = await createApp({ dbPath: worldPath, authDbPath: authPath, authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.test:3000', allowHttp: true, frontend: false, seed: false, demo: false });
    assert.equal(app.world.state.agents[orphan.agent_id], undefined);
    assert.ok(app.world.state.agents[ordinary.agent_id], '不清理无邀请标记的既有角色');
    assert.equal(Object.keys(app.world.state.controllers).length, 0);
    assert.ok(!JSON.stringify(app.world.state.events).includes(orphan.agent_id));
    assert.throws(() => app.world.authenticate(token), { code: 'NOT_AUTHORIZED' });
    let url; ({ server, url } = await app.start(0));
    const response = await fetch(url + '/api/skill/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const redeemed = await response.json();
    assert.equal(response.status, 201, JSON.stringify(redeemed)); assert.equal(redeemed.token, token);
    assert.equal(app.world.agent(redeemed.agent_id).run.max_calls, 12);
    assert.equal(app.world.agent(redeemed.agent_id).invitation_claim, undefined);
    assert.equal(Object.keys(app.world.state.controllers).length, 1);
    assert.equal(app.accounts.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 2);
  } finally {
    store?.close(); world?.close();
    if (app) await app.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(dirname(path), base); rmSync(path, { recursive: true, force: true });
  }
});
