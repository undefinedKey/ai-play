import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { SkillPairingStore } from '../server/skill-pairing.js';

const PASSWORD = 'Only-for-pairing-tests-2026!';
const secretInput = pair => ({ pairing_id: pair.pairing_id, device_secret: pair.device_secret });

async function fixture(t) {
  let now = Date.now();
  const application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.example:3000', allowHttp: true, frontend: false, demo: false, seed: false, pairingNow: () => now });
  await application.accounts.createAdmin({ username: 'pair_admin', password: PASSWORD });
  const { server, url } = await application.start(0);
  t.after(async () => { await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = async (path, data, session = {}, extra = {}) => {
    const response = await fetch(url + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: application.config.publicUrl.origin, ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}), ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const device = async (path, data, headers = {}) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const admin = await api('/api/auth/login', { username: 'pair_admin', password: PASSWORD });
  const member = async username => {
    const invite = await api('/api/admin/invites', {}, admin);
    return api('/api/auth/register', { username, name: username, password: PASSWORD, invite_code: invite.body.invite_code });
  };
  return { application, api, device, admin, member, url, advance: ms => { now += ms; } };
}

test('Skill 配对：机密领取凭据与浏览器确认码分离，拒绝、过期及轮询限流不会泄露令牌', () => {
  let now = 1000;
  const store = new SkillPairingStore({ now: () => now });
  const pair = store.create({ client_name: '我的 AI' }, 'ip-a', 'https://plaza.example');
  assert.match(pair.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(pair.verification_url, `https://plaza.example/?connect=${pair.user_code}`);
  assert.ok(!pair.verification_url.includes(pair.device_secret));
  assert.ok(!JSON.stringify(store.describe(pair.user_code)).includes(pair.device_secret));
  assert.throws(() => store.poll({ ...secretInput(pair), device_secret: 'a'.repeat(43) }), { code: 'NOT_AUTHORIZED' });
  assert.equal(store.poll(secretInput(pair)).status, 'pending');
  assert.throws(() => store.poll(secretInput(pair)), { code: 'RATE_LIMITED' });
  assert.equal(store.deny(pair.user_code, 'owner-a').status, 'denied');
  now += 3000;
  assert.deepEqual(store.poll(secretInput(pair)), { status: 'denied', expires_at: pair.expires_at });
  assert.throws(() => store.approve(pair.user_code, 'owner-a', 'agent-a', () => assert.fail()), { code: 'PAIRING_CLOSED' });
  const second = store.create({}, 'ip-a', 'https://plaza.example');
  store.approve(second.user_code, 'owner-a', 'agent-a', () => ({ agent_id: 'agent-a', controller_id: 'controller-a', token: 'private-world-token' }));
  now = second.expires_at;
  assert.deepEqual(store.poll(secretInput(second)), { status: 'expired', expires_at: second.expires_at });
  assert.equal(store.records.get(second.pairing_id).grant, undefined);
  assert.throws(() => store.approve(second.user_code, 'owner-a', 'agent-a', () => assert.fail()), { code: 'PAIRING_CLOSED' });
  now += 60000; store.sweep();
  assert.equal(store.records.size, 0);
});

test('Skill 配对：严格输入检查、每 IP 创建次数与全局存量有界', () => {
  let now = 0;
  const store = new SkillPairingStore({ now: () => now });
  for (const body of [null, [], { client_name: {} }, { client_name: '' }, { client_name: 'x'.repeat(41) }, { client_name: 'AI\nInjected' }, { token: 'unexpected' }]) assert.throws(() => store.create(body, 'one-ip', 'https://plaza.example'), { code: 'INVALID_REQUEST' });
  for (let i = 0; i < 10; i++) store.create({}, 'one-ip', 'https://plaza.example');
  assert.throws(() => store.create({}, 'one-ip', 'https://plaza.example'), { code: 'RATE_LIMITED' });
  for (let i = 10; i < 1000; i++) store.create({}, `ip-${i}`, 'https://plaza.example');
  assert.throws(() => store.create({}, 'new-ip', 'https://plaza.example'), { code: 'RATE_LIMITED' });
  now = 660000;
  assert.ok(store.create({}, 'one-ip', 'https://plaza.example').pairing_id);
  assert.equal(store.records.size, 1);
});

test('Skill 配对 HTTP：免登录仅允许创建与凭据轮询，其他写接口保留 Origin、会话及 CSRF 校验', async t => {
  const f = await fixture(t);
  const health = await f.api('/api/health');
  assert.equal(health.body.capabilities.skill_pairing, true);
  assert.equal((await f.device('/api/skill/pair', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.device('/api/skill/pair', [])).status, 400);
  const started = await f.device('/api/skill/pair', { client_name: '浏览器测试 AI' });
  assert.equal(started.status, 201);
  const pair = started.body;
  assert.equal((await f.device('/api/skill/pair/poll', secretInput(pair))).body.status, 'pending');
  assert.equal((await f.api(`/api/skill/pair/${pair.user_code}`)).status, 401);
  const description = await f.api(`/api/skill/pair/${pair.user_code}`, undefined, f.admin);
  assert.equal(description.status, 200);
  assert.deepEqual(Object.keys(description.body).sort(), ['client_name', 'expires_at', 'status', 'user_code']);
  const role = await f.api('/api/agents', { name: '授权角色' }, f.admin);
  const approvePath = `/api/skill/pair/${pair.user_code}/approve`;
  const body = { agent_id: role.body.agent.agent_id };
  assert.equal((await f.api(approvePath, body)).status, 401);
  assert.equal((await f.api(approvePath, body, { cookie: f.admin.cookie })).status, 403);
  assert.equal((await f.api(approvePath, body, f.admin, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.device(approvePath, body, { Cookie: f.admin.cookie, 'X-CSRF-Token': f.admin.csrf_token })).status, 403);
  assert.equal((await f.device('/api/agents', { name: '不能绕过 Origin' }, { Cookie: f.admin.cookie, 'X-CSRF-Token': f.admin.csrf_token })).status, 403);
  assert.equal((await f.api(`/api/skill/pair/${pair.user_code}/deny`, {}, { cookie: f.admin.cookie })).status, 403);
  assert.equal((await f.api(`/api/skill/pair/${pair.user_code}/deny`, {}, f.admin)).status, 200);
  f.advance(3000);
  assert.deepEqual((await f.device('/api/skill/pair/poll', secretInput(pair))).body, { status: 'denied', expires_at: pair.expires_at });
});

test('Skill 配对 HTTP：主人确认后可通过 MCP 入场；跨用户、管理员冒用及确认重放不扩权', async t => {
  const f = await fixture(t);
  const alice = await f.member('pair_alice');
  const bob = await f.member('pair_bob');
  const role = await f.api('/api/agents', { name: 'Alice 的 AI' }, alice);
  const agentId = role.body.agent.agent_id;
  const pair = (await f.device('/api/skill/pair', { client_name: 'Skill 客户端' })).body;
  const path = `/api/skill/pair/${pair.user_code}/approve`;
  const options = { agent_id: agentId, duration_minutes: 2, max_calls: 8, goal: '认识一位朋友' };
  for (const stranger of [bob, f.admin]) assert.equal((await f.api(path, options, stranger)).status, 403);
  const initialCount = f.application.world.ownerSnapshot().controllers.length;
  for (const invalid of [{ ...options, max_calls: '8' }, { ...options, duration_minutes: 0 }, { ...options, transfer: 'yes' }, { ...options, goal: 'x'.repeat(301) }]) assert.equal((await f.api(path, invalid, alice)).status, 400);
  assert.equal(f.application.world.ownerSnapshot().controllers.length, initialCount);
  const approved = await f.api(path, options, alice);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(!('token' in approved.body));
  assert.equal(f.application.world.ownerSnapshot().controllers.length, initialCount + 1);
  const delivered = await f.device('/api/skill/pair/poll', secretInput(pair));
  assert.equal(delivered.body.status, 'approved');
  assert.equal(delivered.body.mcp_url, 'http://plaza.example:3000/mcp');
  assert.equal(delivered.body.agent_name, 'Alice 的 AI');
  assert.equal(delivered.body.controller_id, approved.body.controller_id);
  assert.ok(!JSON.stringify((await f.api(`/api/skill/pair/${pair.user_code}`, undefined, alice)).body).includes(delivered.body.token));
  const client = new Client({ name: 'skill-pairing-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${delivered.body.token}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'join_world', arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent.run_id);
  const before = f.application.world.controlState(f.application.world.agent(agentId));
  const retry = await f.api(path, { ...options, duration_minutes: 120, max_calls: 10000 }, alice);
  assert.deepEqual(retry.body, approved.body);
  assert.deepEqual(f.application.world.controlState(f.application.world.agent(agentId)), before);
  assert.equal(f.application.world.ownerSnapshot().controllers.length, initialCount + 1);
  f.advance(3000);
  assert.equal((await f.device('/api/skill/pair/poll', secretInput(pair))).body.token, delivered.body.token);
  const bobsRole = await f.api('/api/agents', { name: 'Bob 的 AI' }, bob);
  assert.equal((await f.api(path, { agent_id: bobsRole.body.agent.agent_id }, bob)).status, 403);
  assert.equal((await f.api(`/api/skill/pair/${pair.user_code}/deny`, {}, bob)).status, 400);
});

test('Skill 配对 HTTP：活跃控制权须明确转交，暂停房间与控制端数量限制在创建令牌前检查', async t => {
  const f = await fixture(t);
  const role = await f.api('/api/agents', { name: '已有运行的 AI' }, f.admin);
  const agentId = role.body.agent.agent_id;
  const previous = await f.api(`/api/agents/${agentId}/controllers`, { kind: 'external', name: '旧客户端' }, f.admin);
  await f.api(`/api/agents/${agentId}/control`, { operation: 'start', controller_id: previous.body.controller_id }, f.admin);
  const before = f.application.world.controlState(f.application.world.agent(agentId));
  const pair = (await f.device('/api/skill/pair', {})).body;
  const path = `/api/skill/pair/${pair.user_code}/approve`;
  const count = () => f.application.world.ownerSnapshot().controllers.filter(c => c.agent_id === agentId).length;
  assert.equal(count(), 1);
  const unconfirmed = await f.api(path, { agent_id: agentId }, f.admin);
  assert.equal(unconfirmed.body.error.code, 'CONTROLLER_BUSY');
  assert.equal(count(), 1);
  const approved = await f.api(path, { agent_id: agentId, transfer: true }, f.admin);
  assert.equal(approved.status, 200);
  assert.notEqual(approved.body.controller_id, before.controller_id);
  assert.ok(f.application.world.agent(agentId).session_epoch > before.session_epoch);
  assert.equal(count(), 2);
  const next = (await f.device('/api/skill/pair', {})).body;
  await f.api('/api/room/control', { operation: 'pause' }, f.admin);
  assert.equal((await f.api(`/api/skill/pair/${next.user_code}/approve`, { agent_id: agentId }, f.admin)).body.error.code, 'ROOM_PAUSED');
  assert.equal(count(), 2);
  await f.api('/api/room/control', { operation: 'resume' }, f.admin);
  while (count() < 10) f.application.world.createController(agentId, { name: '占用测试', kind: 'external' });
  assert.equal((await f.api(`/api/skill/pair/${next.user_code}/approve`, { agent_id: agentId }, f.admin)).body.error.code, 'LIMIT_REACHED');
  assert.equal(count(), 10);
});

test('Skill 配对 HTTP：伪造转发地址不能绕过创建限流', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.device('/api/skill/pair', {}, { 'X-Forwarded-For': `192.0.2.${i}` })).status, 201);
  assert.equal((await f.device('/api/skill/pair', {}, { 'X-Forwarded-For': '192.0.2.99' })).status, 429);
});
