import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { initializeEconomy } from '../server/economy.js';

// All decisions are scripted test assertions. HTTP/MCP is real; no production
// actor, model, credential or database participates in these tests.
async function fixture(t, accounts = false) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', frontend: false, demo: false,
    ...(accounts ? { authMode: 'accounts', publicUrl: 'http://cooperation.example:3000', allowHttp: true } : {}) });
  const password = 'Cooperation-fixture-only-2026!';
  if (accounts) await app.accounts.createAdmin({ username: 'coop_admin', password, name: 'fixture admin' });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), actors = [];
  t.after(async () => { await Promise.all(actors.map(p => p.client.close())); await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const api = async (path, data, auth = {}) => {
    const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', ...(accounts ? { Origin: app.config.publicUrl.origin } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf_token ? { 'X-CSRF-Token': auth.csrf_token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const actor = async (name, owner) => {
    const a = app.world.createAgent({ name, owner_id: owner?.id || name }), controller = app.world.createController(a.agent_id);
    app.world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 100, goal: 'PRIVATE_' + name });
    const client = new Client({ name: 'cooperation-http-test', version: '0.15.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return result.structuredContent || JSON.parse(result.content[0].text); };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload) => ({ ...session, type, payload, action_id: (await observe()).next_action_id });
    const act = async (type, payload) => call('act', await request(type, payload));
    const applied = async (type, payload) => { const result = await act(type, payload); assert.equal(result.status, 'applied', JSON.stringify(result)); return result; };
    const p = { id: a.agent_id, get raw() { return app.world.agent(a.agent_id); }, client, call, observe, request, act, applied, session, token: controller.token };
    p.raw.position = { x: 11, y: 8 }; actors.push(p); return p;
  };
  const advance = async ms => { const end = now + ms; while (now < end) { now = Math.min(now + 1000, end); app.world.tick(); for (const p of actors) if (p.raw.status === 'active') await p.observe(); } };
  const publicWorld = async () => (await api('/api/public/world')).body;
  const propose = async (from, to, template_id, role_id) => {
    await from.applied('cooperation', { intent: 'propose', template_id, role_id, target_agent_id: to.id, duration_seconds: 900 });
    const invite = (await to.observe()).cooperation_invitations[0]; assert.ok(invite);
    return invite;
  };
  const accept = async (to, invite) => to.applied('cooperation', { intent: 'respond', cooperation_id: invite.cooperation_id, revision: invite.revision, accept: true, role_id: invite.role_id });
  return { app, url, api, actor, advance, publicWorld, propose, accept, password, time: () => now };
}
const actionRef = project => ({ cooperation_id: project.cooperation_id, revision: project.revision });
const publicTypes = new Set(['cooperation_proposed', 'cooperation_started', 'cooperation_progress', 'cooperation_review', 'cooperation_completed', 'cooperation_ended']);

test('v0.15 HTTP: two AIs consent, explicitly escrow/cook, and receive the agreed meal exactly once', async t => {
  const f = await fixture(t), supplier = await f.actor('供菜者'), chef = await f.actor('厨师'), stranger = await f.actor('旁人');
  supplier.raw.life.inventory.turnip = 8;
  for (const p of [supplier, chef]) { delete p.raw.life.ledger; initializeEconomy(p.raw, f.time()); }
  const rules = await supplier.call('get_rules'), tools = await supplier.client.listTools();
  assert.equal(rules.recommended_skill_version, '0.15.0'); assert.equal(rules.max_capabilities, 16);
  assert.ok(tools.tools.find(t => t.name === 'act').inputSchema.properties.type.enum.includes('cooperation'));
  assert.equal((await f.api('/api/health')).body.capabilities.cooperation, true);
  const invite = await f.propose(supplier, chef, 'camp_meal', 'supplier');
  assert.equal(invite.role_id, 'cook'); assert.equal(invite.invite_expires_at - f.time(), 150000);
  const proposed = (await f.publicWorld()).cooperations.find(p => p.cooperation_id === invite.cooperation_id);
  assert.equal(proposed.status, 'proposed'); assert.deepEqual(proposed.members.map(m => m.agent_id), [supplier.id]);
  assert.ok(!JSON.stringify(proposed).includes(chef.id), 'unaccepted target is not public');
  assert.deepEqual((await stranger.observe()).cooperation_invitations, []);
  const trespass = await stranger.act('cooperation', { intent: 'respond', ...actionRef(invite), accept: true, role_id: 'cook' });
  assert.equal(trespass.status, 'rejected');
  await f.accept(chef, invite);
  let project = (await supplier.observe()).cooperation;
  assert.equal(project.status, 'active'); assert.equal(supplier.raw.life.inventory.turnip, 8);
  assert.equal(chef.raw.adventure.plan, null); assert.equal(supplier.raw.life.gathering, null);
  const deposit = await supplier.request('cooperation', { intent: 'contribute', ...actionRef(project) });
  const deposited = await supplier.call('act', deposit); assert.equal(deposited.status, 'applied');
  assert.deepEqual(await supplier.call('act', deposit), deposited);
  assert.equal(supplier.raw.life.inventory.turnip, 4);
  project = (await chef.observe()).cooperation; assert.equal(project.escrow.turnip, 4);
  const before = chef.raw.fatigue.energy, cook = await chef.request('cooperation', { intent: 'cook', ...actionRef(project) });
  const cooked = await chef.call('act', cook); assert.equal(cooked.status, 'applied');
  const completed = (await f.publicWorld()).cooperations.find(p => p.cooperation_id === project.cooperation_id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.escrow.turnip, 0);
  assert.equal(supplier.raw.life.inventory.turnip_soup, 1); assert.equal(chef.raw.life.inventory.turnip_soup, 1);
  assert.equal(chef.raw.fatigue.energy, before - 4);
  const ledgers = [supplier.raw.life.ledger.total_entries, chef.raw.life.ledger.total_entries];
  assert.deepEqual(await chef.call('act', cook), cooked);
  assert.deepEqual([supplier.raw.life.ledger.total_entries, chef.raw.life.ledger.total_entries], ledgers);
  for (const p of [supplier, chef]) assert.ok(p.raw.life.ledger.entries.some(e => e.items.turnip_soup === 1));
  const visible = JSON.stringify(await f.publicWorld());
  for (const secret of ['PRIVATE_供菜者', 'PRIVATE_厨师', supplier.token, chef.token, 'source_id', 'token_hash', 'cooperation_return']) assert.ok(!visible.includes(secret), secret);
});

test('v0.15 HTTP: sequential patrol works with 40-second decisions and a level-20 one-hit guard', async t => {
  const f = await fixture(t), scout = await f.actor('侦察员'), guard = await f.actor('护卫');
  scout.raw.adventure.discovery_sequence = 0;
  guard.raw.adventure.level = 20; guard.raw.adventure.xp = 570; guard.raw.adventure.max_hp = guard.raw.adventure.hp = 135;
  const invite = await f.propose(scout, guard, 'scout_and_guard', 'scout');
  await f.advance(40000); await f.accept(guard, invite);
  await f.advance(40000);
  await scout.applied('adventure_plan', { intent: 'explore', zone_id: 'forest' });
  for (let i = 0; i < 30 && (await scout.observe()).self.adventure.encounter?.status !== 'pending'; i++) await f.advance(1000);
  const encounter = (await scout.observe()).self.adventure.encounter; assert.equal(encounter.status, 'pending');
  await f.advance(40000);
  await scout.applied('adventure_event', { event_id: encounter.event_id, choice_id: 'wood' });
  const scouted = (await scout.observe()).cooperation;
  assert.equal(scouted.progress.find(p => p.step_id === 'scout').progress, 1);
  assert.equal(scouted.progress.find(p => p.step_id === 'guard').progress, 0);
  const scoutGold = scout.raw.adventure.gold;
  await scout.applied('adventure_plan', { intent: 'retreat' }); await f.advance(40000);
  await guard.applied('adventure_plan', { intent: 'hunt', monster_id: 'forest_boar' });
  for (let i = 0; i < 60 && guard.raw.adventure.plan; i++) await f.advance(1000);
  const finished = (await f.publicWorld()).cooperations.find(p => p.cooperation_id === invite.cooperation_id);
  assert.equal(finished.status, 'completed'); assert.equal(finished.progress.find(p => p.step_id === 'guard').progress, 1);
  assert.equal(scout.raw.adventure.gold, scoutGold, 'no invented share for the nonfighter');
  assert.ok(guard.raw.adventure.kills >= 1);
});

test('v0.15 accounts HTTP: private targeted invitations and responses never leak to another owner or spectator', async t => {
  const f = await fixture(t, true);
  const admin = await f.api('/api/auth/login', { username: 'coop_admin', password: f.password }); assert.equal(admin.status, 200);
  const member = async username => {
    const invitation = await f.api('/api/admin/invites', { expires_hours: 1 }, admin); assert.equal(invitation.status, 201);
    const result = await f.api('/api/auth/register', { username, password: f.password, name: username, invite_code: invitation.body.invite_code });
    assert.equal(result.status, 201); return result;
  };
  const aOwner = await member('cooperation_a'), bOwner = await member('cooperation_b');
  const a = await f.actor('私密邀请发起者', aOwner.body.owner), b = await f.actor('私密受邀者', bOwner.body.owner);
  const invite = await f.propose(a, b, 'camp_meal', 'supplier');
  const checkOthers = async () => {
    for (const snapshot of [(await f.api('/api/world', undefined, admin)).body, await f.publicWorld()]) {
      for (const event of snapshot.events.filter(e => e.type.startsWith('cooperation_'))) assert.ok(publicTypes.has(event.type), event.type);
      const p = snapshot.cooperations.find(p => p.cooperation_id === invite.cooperation_id);
      assert.ok(p); assert.ok(!JSON.stringify(p).includes(b.id));
      assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_私密受邀者'));
    }
  };
  await checkOthers();
  await b.applied('cooperation', { intent: 'respond', ...actionRef(invite), accept: false });
  await checkOthers();
  const ended = (await f.publicWorld()).cooperations.find(p => p.cooperation_id === invite.cooperation_id);
  assert.equal(ended.status, 'ended'); assert.equal(ended.end_reason, 'not_formed');
  assert.equal(a.raw.life.inventory.turnip_soup, undefined); assert.equal(b.raw.life.inventory.turnip_soup, undefined);
  assert.equal((await b.observe()).cooperation_invitations.length, 0);
});
