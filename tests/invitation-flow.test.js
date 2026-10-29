import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { main as skillMain } from '../skills/ai-plaza/scripts/plaza.mjs';

test('真实 HTTP 全链路：免密码管理→AI邀请码→响应丢失重试→免网页登录MCP入场', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'plaza-invite-flow-'));
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', publicUrl: 'http://127.0.0.1:3000', allowHttp: true, demo: false, seed: false, frontend: false });
  const admin = await app.accounts.createAdmin({ username: 'passwordless_admin', passwordless: true });
  const { server, url } = await app.start(0);
  app.config.publicUrl = new URL(url);
  t.after(async () => {
    await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  });
  const ticket = app.accounts.createLoginTicket(admin.id);
  const post = async (path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = await post('/api/auth/link', { token: ticket.token });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await post('/api/admin/ai-invites', { duration_minutes: 1440, max_calls: 300, goal: 'INVITER_PRIVATE_REQUIREMENT' }, { Cookie: cookie, 'X-CSRF-Token': session.csrf_token });
  assert.equal(response.status, 201);
  const invite = await response.json();
  const statePath = join(folder, 'client.json');
  let loseResponse = true;
  const requests = [];
  const fetchImpl = async (address, options) => {
    requests.push({ path: new URL(address).pathname, headers: options.headers });
    assert.equal(options.headers.Cookie, undefined, 'AI 不需要浏览器账号会话');
    const result = await fetch(address, options);
    if (address.endsWith('/api/skill/redeem') && loseResponse && result.ok) {
      loseResponse = false;
      await result.arrayBuffer();
      throw new Error('Simulated loss after committed response');
    }
    return result;
  };
  await assert.rejects(skillMain(['connect', '--url', url, '--invite', invite.invite_code, '--name', '原来的小树'], { statePath, fetchImpl }), { code: 'NETWORK_ERROR' });
  const pending = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(pending.pending_redeem.device_secret);
  const original = app.world.ownerSnapshot().agents.filter(agent => !agent.is_platform);
  assert.equal(original.length, 1);
  const originalRun = structuredClone(original[0].run);

  const { result: connected } = await skillMain(['connect'], { statePath, fetchImpl });
  assert.equal(connected.status, 'connected');
  assert.equal(connected.agent_name, '原来的小树');
  assert.match(connected.owner_username, /^ai_/);
  assert.equal(connected.max_calls, 300);
  assert.ok(!JSON.stringify(connected).includes(invite.invite_code));
  assert.ok(!JSON.stringify(connected).includes(pending.pending_redeem.device_secret));
  assert.equal(app.world.ownerSnapshot().agents.length, 1);
  assert.deepEqual(app.world.agent(connected.agent_id).run, originalRun);
  const stored = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(stored.pending_redeem, undefined);
  assert.ok(!JSON.stringify(connected).includes(stored.token));
  const owner = app.accounts.getOwnerByUsername(connected.owner_username);
  assert.equal(owner.role, 'member');
  assert.equal(app.world.ownerOf(connected.agent_id), owner.id);

  const { result: entered } = await skillMain(['enter'], { statePath, fetchImpl });
  assert.equal(entered.status, 'entered');
  assert.equal(entered.observation.self.name, '原来的小树');
  assert.equal(entered.observation.run_id, originalRun.run_id);
  assert.ok(!requests.some(request => ['/api/auth/login', '/api/auth/register', '/api/session', '/api/skill/pair'].includes(request.path)));
  assert.equal((await fetch(url + '/api/world', { headers: { Authorization: `Bearer ${stored.token}` } })).status, 401);
  assert.equal((await post('/api/auth/link/create', {}, { Authorization: `Bearer ${stored.token}` })).status, 401);
  assert.equal((await post('/api/admin/ai-invites', {}, { Authorization: `Bearer ${stored.token}` })).status, 401);
  const publicWorld = await (await fetch(url + '/api/public/world')).json();
  const publicText = JSON.stringify(publicWorld);
  for (const secret of [ticket.token, invite.invite_code, pending.pending_redeem.device_secret, stored.token, 'INVITER_PRIVATE_REQUIREMENT']) assert.ok(!publicText.includes(secret));
  await skillMain(['call', 'pause_self', '{"reason":"主人让我先回来"}'], { statePath, fetchImpl });
  assert.equal(app.world.agent(connected.agent_id).status, 'paused');
});
