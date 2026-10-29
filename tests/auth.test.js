import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { AccountStore, PASSWORD_POLICY } from '../server/auth.js';
import { runAdmin } from '../server/admin.js';

const password = 'Plaza-test-password-2026!';
function fixture(t, options = {}) {
  let now = 1793260000000;
  const store = new AccountStore({ now: () => now, ...options });
  t.after(() => store.close());
  return { store, advance: ms => { now += ms; }, now: () => now };
}
function temporaryDatabase(t) {
  const base = resolve(tmpdir());
  const dir = mkdtempSync(join(base, 'plaza-auth-'));
  const child = relative(base, resolve(dir));
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), '清理目录须位于系统临时目录内');
  return { dir, dbPath: join(dir, 'auth.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const admin = store => store.createAdmin({ username: 'Admin_Test', password, name: '测试管理员' });

test('密码策略与用户名校验在任何持久化前执行', async t => {
  const { store } = fixture(t);
  assert.equal(PASSWORD_POLICY.N, 131072); assert.equal(PASSWORD_POLICY.r, 8); assert.equal(PASSWORD_POLICY.p, 1);
  for (const invalid of ['short', 'x'.repeat(129), undefined]) {
    await assert.rejects(store.createAdmin({ username: 'valid_user', password: invalid }), { code: 'INVALID_PASSWORD' });
  }
  for (const invalid of ['ab', 'has space', '中文账号', "sql' OR 1=1", 'x'.repeat(33)]) {
    await assert.rejects(store.createAdmin({ username: invalid, password }), { code: 'INVALID_USERNAME' });
  }
  assert.equal(store.firstAdmin(), null);
});

test('管理员可登录，用户名大小写标准化且已有账号不可静默覆盖', async t => {
  const { store, now } = fixture(t); const owner = await admin(store);
  assert.deepEqual(owner, { id: owner.id, username: 'admin_test', name: '测试管理员', role: 'admin' });
  assert.deepEqual(store.firstAdmin(), owner); assert.deepEqual(store.getOwner(owner.id), owner);
  await assert.rejects(store.createAdmin({ username: 'ADMIN_TEST', password: 'A-different-password!' }), { code: 'USERNAME_TAKEN' });
  const login = await store.login({ username: '  ADMIN_TEST  ', password });
  assert.deepEqual(login.owner, owner); assert.equal(login.expires_at, now() + 24 * 3600000);
  assert.equal(login.token.length, 43); assert.equal(login.csrf_token.length, 64);
  assert.deepEqual(store.session(login.token), { owner, csrf_token: login.csrf_token, expires_at: login.expires_at });
});

test('错误密码、不存在用户和非法登录输入均为统一认证错误', async t => {
  const { store } = fixture(t); await admin(store);
  for (const input of [
    { username: 'admin_test', password: 'This-is-the-wrong-password' },
    { username: 'missing_user', password },
    { username: "' OR 1=1 --", password },
    { username: 'admin_test', password: 'too-short' },
  ]) await assert.rejects(store.login(input), error => error.code === 'INVALID_CREDENTIALS' && error.message === '用户名或密码不正确');
});

test('邀请码只用一次；注册固定member且非管理员不能创建或读取邀请', async t => {
  const { store } = fixture(t); const owner = await admin(store); const invite = store.createInvite(owner.id);
  const registered = await store.register({ username: 'new_member', password, name: '新成员', invite_code: invite.invite_code, role: 'admin' });
  assert.equal(registered.owner.role, 'member'); assert.deepEqual(store.session(registered.token).owner, registered.owner);
  await assert.rejects(store.register({ username: 'second_member', password, invite_code: invite.invite_code }), { code: 'INVALID_INVITE' });
  assert.throws(() => store.createInvite(registered.owner.id), { code: 'NOT_AUTHORIZED' });
  assert.throws(() => store.listInvites(registered.owner.id), { code: 'NOT_AUTHORIZED' });
  assert.throws(() => store.createInvite('unknown-owner'), { code: 'NOT_AUTHORIZED' });
  const history = store.listInvites(owner.id);
  assert.equal(history[0].used_by, registered.owner.id); assert.equal(history[0].invite_id, invite.invite_id);
  assert.ok(!JSON.stringify(history).includes(invite.invite_code));
  assert.ok(!JSON.stringify(history).includes('code_hash'));
});

test('两个独立连接并发注册同一邀请码，只提交一个账号和一个会话', async t => {
  const { dbPath, cleanup } = temporaryDatabase(t);
  const store1 = new AccountStore({ dbPath }); const store2 = new AccountStore({ dbPath });
  t.after(() => { store2.close(); store1.close(); cleanup(); });
  const owner = await admin(store1); const invite = store1.createInvite(owner.id);
  const results = await Promise.allSettled([
    store1.register({ username: 'first_candidate', password, invite_code: invite.invite_code }),
    store2.register({ username: 'second_candidate', password, invite_code: invite.invite_code }),
  ]);
  const success = results.filter(r => r.status === 'fulfilled'); const failure = results.filter(r => r.status === 'rejected');
  assert.equal(success.length, 1); assert.equal(failure.length, 1); assert.equal(failure[0].reason.code, 'INVALID_INVITE');
  assert.equal(store1.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 2);
  assert.equal(store1.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(store1.listInvites(owner.id)[0].used_by, success[0].value.owner.id);
});

test('并发同名注册失败回滚，另一个邀请码仍可用', async t => {
  const { store } = fixture(t); const owner = await admin(store);
  const invites = [store.createInvite(owner.id), store.createInvite(owner.id)];
  const result = await Promise.allSettled(invites.map(invite => store.register({ username: 'same_username', password, invite_code: invite.invite_code })));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const failedIndex = result.findIndex(r => r.status === 'rejected'); assert.equal(result[failedIndex].reason.code, 'USERNAME_TAKEN');
  const retry = await store.register({ username: 'different_username', password, invite_code: invites[failedIndex].invite_code });
  assert.equal(retry.owner.role, 'member');
});

test('邀请码过期或无效均不能创建账号，有效期参数有边界', async t => {
  const { store, advance } = fixture(t); const owner = await admin(store);
  for (const expires_hours of [0, -1, 721, Infinity, '72']) assert.throws(() => store.createInvite(owner.id, { expires_hours }), { code: 'INVALID_EXPIRY' });
  const invite = store.createInvite(owner.id, { expires_hours: 1 }); advance(3600000);
  for (const invite_code of [invite.invite_code, 'bad-code', undefined, 'plaza_' + 'a'.repeat(32)]) {
    await assert.rejects(store.register({ username: 'late_user', password, invite_code }), { code: 'INVALID_INVITE' });
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1);
});

test('24小时会话固定到期，读取不续期，注销立即作废且不影响其他会话', async t => {
  const { store, advance } = fixture(t); await admin(store);
  const first = await store.login({ username: 'admin_test', password }); const second = await store.login({ username: 'admin_test', password });
  assert.notEqual(first.token, second.token); assert.notEqual(first.csrf_token, second.csrf_token);
  store.logout(first.token); assert.equal(store.session(first.token), null); assert.ok(store.session(second.token));
  advance(24 * 3600000 - 1); assert.equal(store.session(second.token).expires_at, second.expires_at);
  advance(1); assert.equal(store.session(second.token), null);
  for (const value of [undefined, null, '', 'bad', 'a'.repeat(10000), 123]) { assert.equal(store.session(value), null); assert.doesNotThrow(() => store.logout(value)); }
});

test('随机salt产生不同密码摘要；持久化没有明文密码、会话令牌或邀请码', async t => {
  const { dbPath, cleanup } = temporaryDatabase(t); let store = new AccountStore({ dbPath });
  t.after(() => { store.close(); cleanup(); });
  const owner = await admin(store); const invite = store.createInvite(owner.id);
  const member = await store.register({ username: 'persist_member', password, invite_code: invite.invite_code });
  const users = store.db.prepare('SELECT * FROM owners').all();
  assert.notEqual(users[0].password_salt, users[1].password_salt); assert.notEqual(users[0].password_hash, users[1].password_hash);
  assert.equal(users[0].password_hash.length, 128);
  const rawRows = JSON.stringify({ users, sessions: store.db.prepare('SELECT * FROM sessions').all(), invitations: store.db.prepare('SELECT * FROM invitations').all() });
  for (const secret of [password, member.token, member.csrf_token, invite.invite_code]) assert.ok(!rawRows.includes(secret));
  assert.deepEqual(Object.keys(member.owner).sort(), ['id', 'name', 'role', 'username']);
  store.close();
  const file = readFileSync(dbPath); for (const secret of [password, member.token, invite.invite_code]) assert.equal(file.includes(Buffer.from(secret)), false);
  store = new AccountStore({ dbPath });
  assert.deepEqual(store.session(member.token).owner, member.owner);
  assert.deepEqual((await store.login({ username: 'persist_member', password })).owner, member.owner);
});

test('管理员CLI只从环境获取凭据，输出不含密码，重复执行不会覆盖', async t => {
  const { dbPath, dir, cleanup } = temporaryDatabase(t); const outputs = [];
  const env = { PLAZA_DB: join(dir, 'world.sqlite'), PLAZA_ADMIN_USERNAME: 'CLI_Admin', PLAZA_ADMIN_PASSWORD: password, PLAZA_ADMIN_NAME: '站点管理员' };
  const options = { args: ['create-admin'], env, write: s => outputs.push(s), writeError: s => outputs.push(s) };
  assert.equal(await runAdmin(options), 0); assert.equal(await runAdmin(options), 1);
  assert.equal(outputs[0], '管理员账号已创建：cli_admin');
  assert.ok(!outputs.join('\n').includes(password)); assert.ok(!outputs.join('\n').includes('password_hash'));
  const store = new AccountStore({ dbPath }); t.after(() => { store.close(); cleanup(); });
  assert.equal(store.firstAdmin().username, 'cli_admin');
  assert.equal(await runAdmin({ ...options, args: ['create-admin', password] }), 1);
  assert.equal(await runAdmin({ ...options, env: {} }), 1);
  assert.ok(!outputs.join('\n').includes(password));
});

test('数据库不可用返回明确存储错误，不泄露SQL或假装成功', async t => {
  const { store } = fixture(t); store.close();
  assert.throws(() => store.getOwner('any'), error => error.code === 'AUTH_STORAGE_ERROR' && !/SELECT|owners|sqlite/i.test(error.message));
  await assert.rejects(store.createAdmin({ username: 'some_user', password }), { code: 'AUTH_STORAGE_ERROR' });
});
