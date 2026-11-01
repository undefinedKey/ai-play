import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server/index.js';

// Isolated test world. Optional starterItems are explicitly seeded setup stock;
// every house, object, invitation, visit and message must go through HTTP/MCP.
export async function createHomesFixture({ frontend = true, authMode = 'local', starterItems = {} } = {}) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode, production: frontend, frontend, demo: false,
    ...(authMode === 'accounts' ? { publicUrl: 'http://homes.test:3000', allowHttp: true } : {}) });
  let clock = Date.now(), heartbeat = clock;
  app.world.now = () => clock; app.world.actionIntervalMs = 0;
  const adminOwner = authMode === 'accounts' ? await app.accounts.createAdmin({ username: 'homes_admin', passwordless: true }) : null;
  const { server, url: base } = await app.start(0), clients = [], actors = [];
  const api = async (path, data, session = {}) => {
    const r = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      Origin: app.config.publicUrl?.origin || base, 'Content-Type': 'application/json',
      ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await r.json(); return { status: r.status, body, cookie: r.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  let admin;
  if (authMode === 'accounts') {
    admin = await api('/api/auth/link', { token: app.accounts.createLoginTicket(adminOwner.id).token }); assert.equal(admin.status, 200);
  }
  async function actor(name, options = {}) {
    let owner;
    if (authMode === 'accounts') {
      const invite = await api('/api/admin/invites', { expires_hours: 1 }, admin); assert.equal(invite.status, 201);
      owner = await api('/api/auth/register', { username: `home_owner_${actors.length}`, name,
        password: 'Homes-isolated-test-2026!', invite_code: invite.body.invite_code }); assert.equal(owner.status, 201);
    } else { const s = await api('/api/session'); owner = { cookie: s.cookie, csrf_token: s.body.csrf_token }; }
    const created = await api('/api/agents', { name }, owner); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.agent.agent_id;
    const ctl = await api(`/api/agents/${id}/controllers`, { kind: 'external', name: '隔离家园测试' }, owner); assert.equal(ctl.status, 201);
    const goal = `PRIVATE_HOMES_GOAL_${id}`;
    const grant = await api(`/api/agents/${id}/control`, { operation: 'start', controller_id: ctl.body.controller_id,
      duration_minutes: 60, max_calls: 10000, goal }, owner); assert.equal(grant.status, 200);
    const client = new Client({ name: 'homes-real-mcp-test', version: '0.25.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${ctl.body.token}` } } }));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args }); assert.notEqual(r.isError, true, JSON.stringify(r.content));
      return r.structuredContent || JSON.parse(r.content.find(c => c.type === 'text').text);
    };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload = {}) => ({ ...session, action_id: (await observe()).next_action_id, type, payload });
    const send = req => call('act', req);
    const applied = async (type, payload = {}) => { const req = await request(type, payload), receipt = await send(req); assert.equal(receipt.status, 'applied', JSON.stringify(receipt)); return { req, receipt }; };
    const p = { id, agent: created.body.agent, client, owner, token: ctl.body.token, goal, session, call, observe, request, send, applied,
      act: async (type, payload = {}) => (await applied(type, payload)).receipt,
      api: (path, data) => api(path, data, owner), get raw() { return app.world.agent(id); } };
    Object.assign(p.raw.life.inventory, starterItems, options.starterItems || {}); app.world.commit(); actors.push(p); return p;
  }
  async function advance(ms) {
    const end = clock + ms;
    while (clock < end) { clock = Math.min(end, clock + 100); app.world.tick();
      if (clock - heartbeat >= 5000) { for (const p of actors) if (p.raw.status === 'active') await p.observe(); heartbeat = clock; }
    }
  }
  async function until(predicate, label = 'bounded action completes', timeout = 120000) {
    const deadline = clock + timeout; while (!predicate() && clock < deadline) await advance(100); assert.ok(predicate(), label);
  }
  const close = async () => { for (const c of clients) await c.close(); await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); };
  return { app, server, base, api, admin, actor, actors, advance, until, close, now: () => clock };
}
