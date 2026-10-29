import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';

async function fixture(t) {
  const app = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false });
  const { server, url } = await app.start(0);
  const response = await fetch(`${url}/api/session`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.close()));
    await app.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });
  async function api(path, data, init = {}) {
    const res = await fetch(url + path, { method: data ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', ...init.headers }, ...(data ? { body: JSON.stringify(data) } : {}), ...init });
    return { status: res.status, body: await res.json() };
  }
  async function character(name = '测试角色') {
    const { body: { agent } } = await api('/api/agents', { name, bio: '集成测试', avatar: '🌿', color: '#527658' });
    const { body: controller } = await api(`/api/agents/${agent.agent_id}/controllers`, { name: 'MCP集成客户端', kind: 'external' });
    const client = new Client({ name: 'plaza-integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    clients.push(client);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result.structuredContent || JSON.parse(result.content[0].text);
    };
    const start = async () => {
      const startResult = await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id, duration_minutes: 15, max_calls: 10, goal: '测试社交' });
      assert.equal(startResult.status, 200, JSON.stringify(startResult.body));
      return call('join_world');
    };
    return { agent, controller, client, call, start };
  }
  return { app, url, cookie, api, character };
}

test('HTTP: owner cookie, Origin and Host boundaries reject unauthorized requests', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/world`)).status, 401);
  assert.equal((await fetch(`${f.url}/api/session`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { http.get(`${f.url}/api/session`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  assert.equal(hostStatus, 403);
  assert.equal((await f.api('/api/world')).status, 200);
  assert.equal((await fetch(`${f.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('MCP: discover 11 tools, isolated tests never occupy a slot or start a run', async t => {
  const f = await fixture(t);
  const c = await f.character();
  assert.equal((await c.client.listTools()).tools.length, 11);
  const before = (await f.api('/api/world')).body;
  for (const step of ['observe','act','wait_events']) assert.ok(!(await c.call('test_connection', { step })).error);
  const after = (await f.api('/api/world')).body;
  assert.equal(after.agents.filter(a => a.status === 'active').length, 0);
  assert.deepEqual(after.agents.map(a => a.run), before.agents.map(a => a.run));
  assert.ok((await c.call('join_world')).error);
});

test('MCP: approved character joins, retries are idempotent and owner pause rejects late actions', async t => {
  const f = await fixture(t);
  const c = await f.character();
  const joined = await c.start();
  assert.equal(joined.self.agent_id, c.agent.agent_id);
  const joinedAgain = await c.call('join_world');
  assert.equal(joinedAgain.run_id, joined.run_id);
  assert.equal(joinedAgain.expires_at, joined.expires_at);
  const args = { run_id: joined.run_id, session_epoch: joined.session_epoch, action_id: joined.next_action_id, type: 'say', payload: { channel: 'nearby', text: '你好，世界！' } };
  const first = await c.call('act', args);
  assert.equal(first.status, 'applied');
  assert.deepEqual(await c.call('act', args), first);
  await f.api(`/api/agents/${c.agent.agent_id}/control`, { operation: 'pause' });
  assert.deepEqual(await c.call('get_action_result', { action_id: args.action_id }), first);
  const late = await c.call('act', { ...args, action_id: first.next_action_id });
  assert.ok(late.error, JSON.stringify(late));
  const snap = (await f.api('/api/world')).body;
  assert.equal(snap.agents[0].status, 'paused');
  assert.equal(snap.events.filter(e => e.payload.text === '你好，世界！').length, 1);
});

test('MCP: owner recall wakes event long-poll promptly and closes admission', async t => {
  const f = await fixture(t);
  const c = await f.character();
  const joined = await c.start();
  const args = { run_id: joined.run_id, session_epoch: joined.session_epoch, cursor: joined.cursor, wait_seconds: 0 };
  const initial = await c.call('get_events', args);
  const started = Date.now();
  const waiting = c.call('get_events', { ...args, cursor: initial.next_cursor, wait_seconds: 10 });
  await new Promise(r => setTimeout(r, 100));
  await f.api(`/api/agents/${c.agent.agent_id}/control`, { operation: 'recall' });
  const result = await waiting;
  assert.ok(Date.now() - started < 1500);
  assert.ok(result.error || result.control_state.status !== 'active');
  assert.ok((await c.call('join_world')).error);
});

test('MCP: transfer prevents the previous controller from affecting a new run', async t => {
  const f = await fixture(t);
  const c = await f.character();
  const old = await c.start();
  const { body: replacement } = await f.api(`/api/agents/${c.agent.agent_id}/controllers`, { name: '新运行器', kind: 'external' });
  const result = await f.api(`/api/agents/${c.agent.agent_id}/control`, { operation: 'transfer', controller_id: replacement.controller_id, duration_minutes: 10, max_calls: 20 });
  assert.equal(result.status, 200);
  assert.ok((await c.call('pause_self', { run_id: old.run_id, session_epoch: old.session_epoch })).error);
  assert.ok((await c.call('leave_world', { run_id: old.run_id, session_epoch: old.session_epoch })).error);
  const state = (await f.api('/api/world')).body.agents[0];
  assert.equal(state.run.controller_id, replacement.controller_id);
  assert.equal(state.run.status, 'active');
});

test('MCP: room caps at five independent clients and public data never exposes credentials', async t => {
  const f = await fixture(t);
  const characters = [];
  for (let i = 0; i < 6; i++) characters.push(await f.character(`角色${i + 1}`));
  for (const c of characters.slice(0, 5)) assert.ok(!(await c.start()).error);
  const sixth = characters[5];
  const permitted = await f.api(`/api/agents/${sixth.agent.agent_id}/control`, { operation: 'start', controller_id: sixth.controller.controller_id });
  if (permitted.status === 200) assert.equal((await sixth.call('join_world')).error.code, 'ROOM_FULL');
  else assert.equal(permitted.body.error.code, 'ROOM_FULL');
  const snapshot = (await f.api('/api/world')).body;
  assert.equal(snapshot.agents.filter(a => a.status === 'active').length, 5);
  for (const c of characters) assert.ok(!JSON.stringify(snapshot).includes(c.controller.token));
  assert.ok(!JSON.stringify(snapshot).includes('credential_hash'));
});

test('HTTP: explicit foreign controller is rejected instead of falling back to demo', async t => {
  const f = await fixture(t);
  const own = await f.character('主人角色');
  const other = await f.character('另一个角色');
  const result = await f.api(`/api/agents/${own.agent.agent_id}/control`, { operation: 'start', controller_id: other.controller.controller_id });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'NOT_AUTHORIZED');
  assert.equal((await own.call('get_control_state')).run, null);
});

test('HTTP: 20 simultaneous spectator streams receive a confirmed world change', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const viewers = await Promise.all(Array.from({ length: 20 }, async () => {
    const response = await fetch(`${f.url}/api/events`, { headers: { cookie: f.cookie }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
    return reader;
  }));
  const started = Date.now();
  await f.api('/api/agents', { name: '广播测试', bio: '', avatar: '🌳', color: '#567658' });
  const messages = await Promise.all(viewers.map(async r => new TextDecoder().decode((await r.read()).value)));
  assert.ok(messages.every(message => message.includes('广播测试')));
  assert.ok(Date.now() - started < 1000);
  abort.abort();
});
