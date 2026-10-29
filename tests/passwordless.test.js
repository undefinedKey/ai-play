import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { AccountStore } from '../server/auth.js';
import { runAdmin } from '../server/admin.js';
import { createApp } from '../server/index.js';

function directory(t) {
  const base = resolve(tmpdir()), path = mkdtempSync(join(base, 'plaza-passwordless-'));
  t.after(() => { assert.equal(dirname(path), base); rmSync(path, { recursive: true, force: true }); });
  return path;
}
async function fixture(t) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://plaza.test:3000', allowHttp: true, frontend: false, seed: false, demo: false });
  const owner = await app.accounts.createAdmin({ username: 'link_admin', name: '链接管理员', passwordless: true });
  const { server, url } = await app.start(0);
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = async (path, body, session = {}, headers = {}) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: app.config.publicUrl.origin, ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  return { app, owner, api, url };
}

test('无密码账号没有可猜默认密码；十分钟登录票据仅存摘要、预览不消费且兑换固定24小时会话', async () => {
  let now = Date.now(); const store = new AccountStore({ now: () => now });
  try {
    const owner = await store.createAdmin({ username: 'only_link', passwordless: true });
    const credentials = store.db.prepare('SELECT password_hash,password_salt,password_params FROM owners WHERE id=?').get(owner.id);
    assert.equal(credentials.password_hash, ''); assert.equal(JSON.parse(credentials.password_params).algorithm, 'disabled');
    await assert.rejects(store.login({ username: owner.username, password: 'some-assumed-default-password' }), { code: 'INVALID_CREDENTIALS' });
    const ticket = store.createLoginTicket(owner.id);
    assert.equal(ticket.expires_at, now + 600000);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM login_tickets').all()).includes(ticket.token));
    assert.deepEqual(store.inspectLoginTicket(ticket.token), { owner, expires_at: ticket.expires_at });
    assert.deepEqual(store.inspectLoginTicket(ticket.token), { owner, expires_at: ticket.expires_at });
    const result = store.consumeLoginTicket(ticket.token);
    assert.deepEqual(result.owner, owner); assert.equal(result.expires_at, now + 86400000); assert.ok(store.session(result.token));
    assert.throws(() => store.consumeLoginTicket(ticket.token), { code: 'INVALID_LOGIN_LINK' });
    assert.throws(() => store.inspectLoginTicket(ticket.token), { code: 'INVALID_LOGIN_LINK' });
    const expired = store.createLoginTicket(owner.id); now += 600000;
    assert.throws(() => store.consumeLoginTicket(expired.token), { code: 'INVALID_LOGIN_LINK' });
    for (const token of [undefined, 'bad', 'x'.repeat(43), {}, 'x'.repeat(1000)]) assert.throws(() => store.inspectLoginTicket(token), { code: 'INVALID_LOGIN_LINK' });
  } finally { store.close(); }
});

test('登录票据跨账号库重启有效，两个数据库连接竞争仅一成功，会话创建失败回滚消费', async t => {
  const path = directory(t), dbPath = join(path, 'auth.sqlite');
  let first = new AccountStore({ dbPath }), second;
  try {
    const owner = await first.createAdmin({ username: 'persist_link', passwordless: true });
    const ticket = first.createLoginTicket(owner.id); first.close();
    first = new AccountStore({ dbPath }); second = new AccountStore({ dbPath });
    const results = await Promise.allSettled([Promise.resolve().then(() => first.consumeLoginTicket(ticket.token)), Promise.resolve().then(() => second.consumeLoginTicket(ticket.token))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'INVALID_LOGIN_LINK');
    assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    const next = first.createLoginTicket(owner.id), original = first.issueSession;
    first.issueSession = () => { throw new Error('injected persistence failure'); };
    assert.throws(() => first.consumeLoginTicket(next.token), { code: 'AUTH_STORAGE_ERROR' });
    first.issueSession = original;
    assert.deepEqual(first.consumeLoginTicket(next.token).owner, owner);
  } finally { second?.close(); first.close(); }
});

test('免密码HTTP：预览无cookie，确认后设置会话；Origin、CSRF、限定本人签发和链接重放校验', async t => {
  const f = await fixture(t), ticket = f.app.accounts.createLoginTicket(f.owner.id);
  const inspected = await f.api('/api/auth/link/inspect', { token: ticket.token });
  assert.equal(inspected.status, 200); assert.equal(inspected.cookie, undefined); assert.deepEqual(inspected.body.owner, f.owner);
  assert.equal(inspected.headers.get('cache-control'), 'no-store');
  assert.equal((await f.api('/api/auth/link', { token: ticket.token }, {}, { Origin: 'http://evil.test' })).status, 403);
  const missingOrigin = await fetch(f.url + '/api/auth/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ticket.token }) });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await f.api('/api/auth/link', { token: ticket.token, owner_id: 'other' })).status, 400);
  const login = await f.api('/api/auth/link', { token: ticket.token });
  assert.equal(login.status, 200); assert.deepEqual(login.body.owner, f.owner);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.equal((await f.api('/api/auth/link', { token: ticket.token })).status, 400);
  const session = { cookie: login.cookie, csrf_token: login.body.csrf_token };
  assert.equal((await f.api('/api/auth/link/create', {}, { cookie: login.cookie })).status, 403);
  assert.equal((await f.api('/api/auth/link/create', { owner_id: 'another' }, session)).status, 400);
  const created = await f.api('/api/auth/link/create', {}, session);
  assert.equal(created.status, 201);
  const link = new URL(created.body.login_url); assert.equal(link.origin, 'http://plaza.test:3000'); assert.equal(link.search, '');
  assert.deepEqual(f.app.accounts.inspectLoginTicket(link.hash.slice('#login='.length)).owner, f.owner);
  const invalid = await f.api('/api/auth/link/inspect', { token: 'z'.repeat(43) });
  assert.equal(invalid.status, 400); assert.ok(!JSON.stringify(invalid.body).includes(f.owner.name));
});

test('成员免密码链接仅恢复自己的权限，不能发管理员邀请、暂停房间或签发他人链接', async t => {
  const f = await fixture(t);
  const member = f.app.accounts.transaction(() => f.app.accounts.insertOwner({ username: 'link_member', name: '成员', role: 'member', passwordless: true }));
  const login = await f.api('/api/auth/link', { token: f.app.accounts.createLoginTicket(member.id).token });
  const session = { cookie: login.cookie, csrf_token: login.body.csrf_token };
  assert.equal(login.body.owner.role, 'member');
  assert.equal((await f.api('/api/admin/invites', {}, session)).status, 403);
  assert.equal((await f.api('/api/admin/ai-invites', {}, session)).status, 403);
  assert.equal((await f.api('/api/room/control', { operation: 'pause' }, session)).status, 403);
  assert.equal((await f.api('/api/auth/link/create', { owner_id: f.owner.id }, session)).status, 400);
  const own = await f.api('/api/auth/link/create', {}, session);
  assert.equal(f.app.accounts.inspectLoginTicket(new URL(own.body.login_url).hash.slice(7)).owner.id, member.id);
});

test('无密码CLI仅可信本机创建账号及签链接，不输出密码、不覆盖旧账号、校验PUBLIC_URL', async t => {
  const path = directory(t), outputs = [], errors = [];
  const env = { PLAZA_AUTH_DB: join(path, 'auth.sqlite'), PLAZA_ADMIN_USERNAME: 'cli_link', PLAZA_PUBLIC_URL: 'http://127.0.0.1:3000' };
  const base = { env, write: text => outputs.push(text), writeError: text => errors.push(text) };
  assert.equal(await runAdmin({ ...base, args: ['create-admin', '--passwordless'] }), 0);
  const first = JSON.parse(outputs[1]); assert.equal(first.username, 'cli_link'); assert.match(first.login_url, /^http:\/\/127\.0\.0\.1:3000\/#login=/);
  assert.equal(await runAdmin({ ...base, args: ['create-admin', '--passwordless'] }), 1);
  assert.equal(await runAdmin({ ...base, args: ['login-link', '--username', 'CLI_LINK'] }), 0);
  assert.notEqual(JSON.parse(outputs.at(-1)).login_url, first.login_url);
  assert.equal(await runAdmin({ ...base, args: ['login-link', '--username', 'missing_user'] }), 1);
  assert.equal(await runAdmin({ ...base, args: ['login-link', '--username', 'cli_link'], env: { ...env, PLAZA_PUBLIC_URL: 'http://user:secret@host' } }), 1);
  const store = new AccountStore({ dbPath: env.PLAZA_AUTH_DB });
  try { assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1); assert.equal(store.firstAdmin().role, 'admin'); }
  finally { store.close(); }
  assert.ok(!errors.join('\n').includes('secret')); assert.ok(!outputs.join('\n').includes('password_hash'));
});

test('免密码公开验证请求限流且不允许匿名HTTP创建管理员或签发链接', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/auth/create-admin', { passwordless: true })).status, 401);
  assert.equal((await f.api('/api/auth/link/create', {})).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await f.api('/api/auth/link/inspect', { token: 'x'.repeat(43) })).status, 400);
  assert.equal((await f.api('/api/auth/link/inspect', { token: 'x'.repeat(43) })).status, 429);
});
