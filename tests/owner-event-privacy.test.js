import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';

test('accounts HTTP: three owners receive only their private controls/invitations and projected public events', async t => {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', frontend: false, demo: false,
    authMode: 'accounts', publicUrl: 'http://privacy.example:3000', allowHttp: true });
  const password = 'Only-a-local-privacy-fixture-2026!';
  await app.accounts.createAdmin({ username: 'privacy_admin', password, name: '第三位主人' });
  app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const api = async (path, data, auth = {}) => {
    const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: app.config.publicUrl.origin,
      ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf_token ? { 'X-CSRF-Token': auth.csrf_token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return { body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const admin = await api('/api/auth/login', { username: 'privacy_admin', password });
  const member = async username => {
    const invitation = await api('/api/admin/invites', { expires_hours: 1 }, admin);
    return api('/api/auth/register', { username, password, name: username, invite_code: invitation.body.invite_code });
  };
  const ownerA = await member('privacy_owner_a'), ownerB = await member('privacy_owner_b');
  const actor = async (name, owner) => {
    const { body: { agent } } = await api('/api/agents', { name }, owner);
    const { body: controller } = await api(`/api/agents/${agent.agent_id}/controllers`, { kind: 'external' }, owner);
    await api(`/api/agents/${agent.agent_id}/control`, { operation: 'start', controller_id: controller.controller_id,
      duration_minutes: 15, max_calls: 10, goal: `PRIVATE_GOAL_${name}` }, owner);
    const client = new Client({ name: 'owner-event-privacy', version: '0.15.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return response.structuredContent || JSON.parse(response.content[0].text);
    };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const act = async (type, payload = {}) => {
      const observed = await call('observe', session);
      const result = await call('act', { ...session, action_id: observed.next_action_id, type, payload });
      assert.equal(result.status, 'applied', JSON.stringify(result)); return result;
    };
    return { id: agent.agent_id, owner, call, session, act };
  };
  const a = await actor('甲', ownerA), b = await actor('乙', ownerB), c = await actor('丙', admin);
  const snapshots = async () => Promise.all([ownerA, ownerB, admin, null].map(async owner =>
    (await api(owner ? '/api/world' : '/api/public/world', undefined, owner || {})).body));
  const eventBy = (snapshot, type, id) => snapshot.events.find(e => e.type === type && (!id || e.event_id === id));
  const assertPrivate = async (type, audience, id) => {
    const views = await snapshots();
    views.forEach((view, index) => assert.equal(!!eventBy(view, type, id), audience.includes(index), `${type}: viewer ${index}`));
  };
  const group = await a.act('create_group');
  const invitation = await a.act('invite', { group_id: group.group_id, target_agent_id: b.id });
  await assertPrivate('invitation', [0, 1]);
  await b.act('respond_invite', { invite_id: invitation.invite_id, accept: false });
  await assertPrivate('invitation_declined', [0, 1]);
  await a.act('cooperation', { intent: 'propose', template_id: 'camp_meal', role_id: 'supplier', target_agent_id: b.id });
  await assertPrivate('cooperation_invitation', [0, 1]);
  const offer = (await b.call('observe', b.session)).cooperation_invitations[0];
  await b.act('cooperation', { intent: 'respond', cooperation_id: offer.cooperation_id, revision: offer.revision, accept: false });
  await assertPrivate('cooperation_response', [0, 1]);

  const authorized = app.world.state.events.find(e => e.type === 'run_authorized' && e.payload.agent_id === a.id);
  await assertPrivate('run_authorized', [0], authorized.event_id);
  await api(`/api/agents/${a.id}/control`, { operation: 'pause' }, ownerA);
  const paused = app.world.state.events.findLast(e => e.type === 'agent_paused');
  await assertPrivate('agent_paused', [0], paused.event_id);
  assert.equal((await snapshots())[0].events.find(e => e.event_id === paused.event_id).payload.reason, '主人暂停');

  // agent_left intentionally broadcasts to active peers. Its recipient list
  // must never grant those peers' owners access to the private reason.
  app.world.recall(app.world.agent(b.id), 'PRIVATE_RECALL_REASON');
  const left = app.world.state.events.findLast(e => e.type === 'agent_left');
  assert.ok(left.recipients.includes(c.id));
  const views = await snapshots();
  views.forEach((view, index) => {
    const projected = eventBy(view, 'agent_left', left.event_id); assert.ok(projected);
    assert.equal(projected.payload.reason, index === 1 ? 'PRIVATE_RECALL_REASON' : undefined);
    assert.equal(Object.hasOwn(projected, 'recipients'), false);
  });

  const publicMessage = app.world.event('message', { agent_id: b.id, name: '乙', channel: 'nearby', text: '大家好',
    private_owner_goal: 'PRIVATE_PUBLIC_PAYLOAD' }, [c.id]);
  app.world.event('future_private_control', { agent_id: b.id, text: 'PRIVATE_UNKNOWN_EVENT' }, [a.id, b.id, c.id]);
  for (const view of await snapshots()) {
    assert.equal(eventBy(view, 'message', publicMessage.event_id).payload.text, '大家好');
    assert.ok(!JSON.stringify(view.events).includes('PRIVATE_PUBLIC_PAYLOAD'));
    assert.ok(!JSON.stringify(view.events).includes('PRIVATE_UNKNOWN_EVENT'));
    assert.ok(view.events.every(event => !Object.hasOwn(event, 'recipients')));
  }
  const thirdOwner = (await snapshots())[2];
  assert.ok(!JSON.stringify(thirdOwner).includes('PRIVATE_GOAL_甲'));
  assert.ok(!JSON.stringify(thirdOwner).includes('PRIVATE_GOAL_乙'));
  assert.ok(!JSON.stringify(thirdOwner).includes('PRIVATE_RECALL_REASON'));
  assert.ok(thirdOwner.events.some(e => e.type === 'group_created'), 'public gameplay remains visible');
  assert.ok(thirdOwner.events.some(e => e.type === 'cooperation_ended'), 'public cooperation result remains visible');
});
