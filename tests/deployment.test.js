import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfig } from '../server/config.js';
import { createApp } from '../server/index.js';

const PASSWORD = 'Only-for-integration-tests-2026!';
async function fixture(t, options = {}) {
  const application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.example:3000', allowHttp: true, demo: false, seed: false, frontend: false, ...options });
  const admin = await application.accounts.createAdmin({ username: 'admin_test', password: PASSWORD, name: '管理员' });
  const { server, url } = await application.start(0);
  t.after(async () => { await application.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = application.config.publicUrl.origin;
  const api = async (path, data, session = {}, extraHeaders = {}) => {
    const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}), ...extraHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    return { status: response.status, body, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const login = async () => api('/api/auth/login', { username: 'admin_test', password: PASSWORD });
  const member = async (username, adminSession) => {
    const invite = await api('/api/admin/invites', { expires_hours: 1 }, adminSession);
    assert.equal(invite.status, 201);
    const registered = await api('/api/auth/register', { username, password: PASSWORD, name: username, invite_code: invite.body.invite_code, role: 'admin' });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.owner.role, 'member');
    return registered;
  };
  return { application, admin, url, origin, api, login, member };
}

test('部署配置：本地模式拒绝公网监听，账号模式要求明确地址及HTTP测试选择', () => {
  assert.throws(() => deploymentConfig({ authMode: 'local', host: '0.0.0.0' }), /禁止监听公网/);
  assert.throws(() => deploymentConfig({ authMode: 'accounts', publicUrl: '' }), /必须设置/);
  assert.throws(() => deploymentConfig({ authMode: 'accounts', publicUrl: 'http://203.0.113.5:3000', allowHttp: false }), /HTTP/);
  assert.throws(() => deploymentConfig({ authMode: 'accounts', publicUrl: 'https://user:password@plaza.example' }), /不含路径或凭证/);
  assert.throws(() => deploymentConfig({ authMode: 'accounts', publicUrl: 'https://plaza.example/mcp' }), /不含路径或凭证/);
  assert.equal(deploymentConfig({ authMode: 'accounts', host: '0.0.0.0', publicUrl: 'https://plaza.example' }).secureCookies, true);
});

test('账号模式没有管理员时拒绝启动，不允许网页抢先创建管理员', async () => {
  const app = await createApp({ dbPath: ':memory:', authMode: 'accounts', publicUrl: 'https://plaza.example', frontend: false, seed: false, demo: false });
  try { await assert.rejects(app.start(0), /初始化管理员/); } finally { await app.close(); }
});

test('账号HTTP：未登录不获得权限；登录cookie与CSRF有效，注销使旧会话失效', async t => {
  const f = await fixture(t);
  const unauthenticated = await f.api('/api/session');
  assert.equal(unauthenticated.status, 200);
  assert.equal(unauthenticated.body.owner, null);
  assert.equal(unauthenticated.cookie, undefined);
  assert.equal((await f.api('/api/world')).status, 401);
  const logged = await f.login();
  assert.equal(logged.status, 200);
  assert.match(logged.headers.get('set-cookie'), /HttpOnly/);
  assert.match(logged.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(!JSON.stringify(logged.body).includes(PASSWORD));
  assert.equal((await f.api('/api/agents', { name: '无CSRF' }, { cookie: logged.cookie })).status, 403);
  assert.equal((await f.api('/api/agents', { name: '跨域' }, logged, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.api('/api/agents', { name: '允许创建' }, logged)).status, 201);
  assert.equal((await f.api('/api/auth/logout', {}, logged)).status, 200);
  assert.equal((await f.api('/api/world', undefined, logged)).status, 401);
});

test('多用户权限：用户只控制自己角色，管理员不冒用成员，私有预算不进入别人快照', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const alice = await f.member('alice', admin);
  const bob = await f.member('bob', admin);
  const created = await f.api('/api/agents', { name: 'Alice的角色', owner_id: bob.body.owner.id, is_platform: true }, alice);
  const id = created.body.agent.agent_id;
  assert.equal(f.application.world.ownerOf(id), alice.body.owner.id);
  assert.equal(created.body.agent.is_platform, false);
  const ctrl = await f.api(`/api/agents/${id}/controllers`, { name: 'Alice运行器', kind: 'external' }, alice);
  assert.equal(ctrl.body.mcp_url, `${f.origin}/mcp`);
  assert.equal((await f.api(`/api/agents/${id}/control`, { operation: 'start', controller_id: ctrl.body.controller_id, goal: 'PRIVATE_GOAL_NOT_FOR_BOB' }, alice)).status, 200);
  const own = (await f.api('/api/world', undefined, alice)).body;
  const other = (await f.api('/api/world', undefined, bob)).body;
  assert.equal(own.agents.find(a => a.agent_id === id).is_mine, true);
  assert.equal(other.agents.find(a => a.agent_id === id).is_mine, false);
  assert.equal(other.agents.find(a => a.agent_id === id).run, undefined);
  assert.equal(other.controllers.length, 0);
  assert.ok(!JSON.stringify(other).includes('PRIVATE_GOAL_NOT_FOR_BOB'));
  for (const identity of [bob, admin]) {
    assert.equal((await f.api(`/api/agents/${id}/control`, { operation: 'recall' }, identity)).status, 403);
    assert.equal((await f.api(`/api/agents/${id}/controllers`, { name: '越权', kind: 'external' }, identity)).status, 403);
    assert.equal((await f.api(`/api/agents/${id}/test`, { controller_id: ctrl.body.controller_id }, identity)).status, 403);
  }
  assert.equal((await f.api('/api/room/control', { operation: 'pause' }, bob)).status, 403);
  assert.equal((await f.api('/api/admin/invites', {}, bob)).status, 403);
  assert.equal((await f.api('/api/room/control', { operation: 'pause' }, admin)).status, 200);
});

test('SSE：快照按会话过滤，注销立即结束自己的实时连接', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const bob = await f.member('bob_sse', admin);
  const created = await f.api('/api/agents', { name: '管理员角色' }, admin);
  const ctrl = await f.api(`/api/agents/${created.body.agent.agent_id}/controllers`, { name: '私有端名', kind: 'external' }, admin);
  await f.api(`/api/agents/${created.body.agent.agent_id}/control`, { operation: 'start', controller_id: ctrl.body.controller_id, goal: 'SECRET_SSE_GOAL' }, admin);
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${f.url}/api/events`, { headers: { Cookie: bob.cookie, Origin: f.origin }, signal: abort.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(!first.includes('SECRET_SSE_GOAL'));
  assert.ok(!first.includes('私有端名'));
  await f.api('/api/auth/logout', {}, bob);
  while (!(await reader.read()).done) { /* Drain already buffered public updates. */ }
  assert.equal((await f.api('/api/world', undefined, bob)).status, 401);
});

test('HTTPS配置发Secure cookie；公网MCP地址不会误返回回环地址', async t => {
  const f = await fixture(t, { publicUrl: 'https://plaza.example' });
  const admin = await f.login();
  assert.match(admin.headers.get('set-cookie'), /Secure/);
  const created = await f.api('/api/agents', { name: 'HTTPS角色' }, admin);
  const ctrl = await f.api(`/api/agents/${created.body.agent.agent_id}/controllers`, { kind: 'external' }, admin);
  assert.equal(ctrl.body.mcp_url, 'https://plaza.example/mcp');
});

test('登录限流不会信任伪造的X-Forwarded-For', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await f.api('/api/auth/login', { username: 'admin_test', password: 'wrong' }, {}, { 'X-Forwarded-For': `192.0.2.${i}` })).status, 401);
  assert.equal((await f.api('/api/auth/login', { username: 'admin_test', password: PASSWORD })).status, 429);
});
