import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SkillClient, main } from '../skills/ai-plaza/scripts/plaza.mjs';

const code = 'plaza_ai_' + 'i'.repeat(32), token = 't'.repeat(43);
function fixture(t, handler) {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'plaza-skill-invite-'));
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); });
  const statePath = join(directory, 'client.json'), requests = [];
  const options = { statePath, defaultUrl: 'http://world.example', fetchImpl: async (url, init) => {
    const body = init.body && JSON.parse(init.body); requests.push({ url, init, body });
    const result = await handler({ url, init, body, requests });
    return new Response(JSON.stringify(result.body ?? result), { status: result.status || 200 });
  } };
  return { statePath, options, requests, client: new SkillClient(options) };
}
const health = { capabilities: { skill_invites: true } };
const grant = { token, mcp_url: 'http://world.example/mcp', agent_id: 'agent-a', agent_name: '原 AI', controller_id: 'controller-a', owner_username: 'ai_owner_a', expires_at: Date.now() + 60000, max_calls: 20 };

test('AI邀请码直接连接不要求页面登录，保存凭据且输出不泄露邀请码/设备证明/令牌', async t => {
  const f = fixture(t, ({ url, body }) => url.endsWith('/health') ? health : (assert.equal(body.name, '原 AI'), grant));
  const { client, result } = await main(['connect', '--invite', code, '--name', '原 AI'], f.options);
  assert.equal(result.status, 'connected'); assert.equal(result.agent_id, 'agent-a');
  assert.equal(result.owner_username, 'ai_owner_a');
  assert.ok(!JSON.stringify(result).includes(code)); assert.ok(!JSON.stringify(result).includes(token));
  const exchange = f.requests.find(request => request.url.endsWith('/redeem'));
  assert.match(exchange.body.device_secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchange.init.headers.Origin, undefined); assert.equal(exchange.init.headers.Authorization, undefined);
  assert.equal(client.state.pending_redeem, undefined);
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).token, token);
  await assert.rejects(client.connect({ invite: code, name: '另一个名字' }), { code: 'ALREADY_CONNECTED' });
});

test('领取响应丢失后同邀请码同设备证明恢复，不新建申请、不重新配对', async t => {
  let attempts = 0;
  const f = fixture(t, ({ url }) => {
    if (url.endsWith('/health')) return health;
    if (++attempts === 1) throw new Error('network lost');
    return grant;
  });
  await assert.rejects(f.client.connect({ invite: code, name: '原 AI' }), { code: 'NETWORK_ERROR' });
  const saved = JSON.parse(readFileSync(f.statePath, 'utf8')).pending_redeem;
  assert.equal(f.client.status().status, 'invitation_pending'); assert.ok(!JSON.stringify(f.client.status()).includes(saved.device_secret));
  await assert.rejects(f.client.connect({ invite: 'different', name: '原 AI' }), { code: 'INVITE_PENDING' });
  const second = new SkillClient(f.options);
  assert.equal((await second.connect()).status, 'connected');
  const redeemed = f.requests.filter(request => request.url.endsWith('/redeem'));
  assert.deepEqual(redeemed[0].body, redeemed[1].body);
  assert.equal(f.requests.some(request => request.url.endsWith('/pair')), false);
});

test('旧服务、确定无效邀请码与未知响应正确区分，错误不回显秘密', async t => {
  const old = fixture(t, () => ({ capabilities: {} }));
  await assert.rejects(old.client.connect({ invite: code, name: '原 AI' }), { code: 'UPGRADE_REQUIRED' });
  assert.equal(old.requests.length, 1);
  const invalid = fixture(t, ({ url, body }) => url.endsWith('/health') ? health : { status: 400, body: { error: { code: 'INVALID_INVITE', message: `${body.invite_code} ${body.device_secret}` } } });
  await assert.rejects(invalid.client.connect({ invite: code, name: '原 AI' }), error => error.code === 'INVALID_INVITE' && !error.message.includes(code) && error.message.includes('[REDACTED]'));
  assert.equal(invalid.client.state.pending_redeem, undefined);
  const uncertain = fixture(t, ({ url }) => url.endsWith('/health') ? health : { ...grant, mcp_url: 'https://other.example/mcp' });
  await assert.rejects(uncertain.client.connect({ invite: code, name: '原 AI' }), { code: 'INVALID_RESPONSE' });
  assert.equal(uncertain.client.state.pending_redeem.invite_code, code);
  assert.equal(uncertain.client.state.token, undefined);
});
