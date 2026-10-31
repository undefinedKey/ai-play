import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { findPath, isWalkable } from '../server/spatial.js';

// Scripted decisions test the real HTTP/MCP pipeline. Only the simulation clock
// is controlled. Spawn positions, starting inventory, HP, tools, drops and all
// intermediate gains remain untouched; this is not a claim about AI preferences.
async function fixture(t) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://v020.test:3000', allowHttp: true, frontend: false, seed: false, demo: false });
  const adminOwner = await app.accounts.createAdmin({ username: 'v020_admin', passwordless: true });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), clients = [], actors = [];
  t.after(async () => { for (const client of clients) await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = async (path, data, session = {}) => {
    const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: app.config.publicUrl.origin, 'Content-Type': 'application/json', ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json(); return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const ticket = app.accounts.createLoginTicket(adminOwner.id), admin = await api('/api/auth/link', { token: ticket.token }); assert.equal(admin.status, 200);
  const member = async username => {
    const invite = await api('/api/admin/invites', { expires_hours: 1 }, admin); assert.equal(invite.status, 201);
    const result = await api('/api/auth/register', { username, name: username, password: 'Only-for-v020-HTTP-tests-2026!', invite_code: invite.body.invite_code }); assert.equal(result.status, 201); return result;
  };
  const actor = async (owner, name) => {
    const created = await api('/api/agents', { name }, owner); assert.equal(created.status, 201);
    const id = created.body.agent.agent_id;
    const control = await api(`/api/agents/${id}/controllers`, { kind: 'external', name: '受控HTTP验收客户端' }, owner); assert.equal(control.status, 201);
    const goal = `PRIVATE_V020_ORIGINAL_OWNER_GOAL_${id}`;
    const grant = await api(`/api/agents/${id}/control`, { operation: 'start', controller_id: control.body.controller_id, duration_minutes: 60, max_calls: 1000, goal }, owner); assert.equal(grant.status, 200);
    const client = new Client({ name: 'v020-real-http-validation', version: '0.20.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${control.body.token}` } } }));
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text); };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload) => ({ ...session, type, payload, action_id: (await observe()).next_action_id });
    const act = async (type, payload) => call('act', await request(type, payload));
    const applied = async (type, payload) => { const result = await act(type, payload); assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result; };
    const actor = { id, client, token: control.body.token, goal, call, observe, request, act, applied, owner, get raw() { return app.world.agent(id); } }; actors.push(actor); return actor;
  };
  const samples = { fractional: 0, walk: 0, run: 0, working: 0 };
  let heartbeat = now;
  const advance = async ms => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100); app.world.tick();
      for (const p of actors) {
        assert.ok(isWalkable(p.raw.scene_id, p.raw.position));
        if (!Number.isInteger(p.raw.position.x) || !Number.isInteger(p.raw.position.y)) samples.fractional++;
        if (p.raw.movement) samples[p.raw.movement.mode]++;
        if (p.raw.life.gathering?.phase === 'working') samples.working++;
      }
      if (now - heartbeat >= 1000) { for (const p of actors) if (p.raw.status === 'active') await p.observe(); heartbeat = now; }
    }
  };
  const until = async (predicate, label, timeout = 120000) => { const end = now + timeout; while (!predicate() && now < end) await advance(100); assert.ok(predicate(), label); };
  return { app, api, admin, member, actor, advance, until, samples, now: () => now };
}
const held = (p, id) => p.raw.life.inventory[id] || 0;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

async function gather(f, p, nodeId, mode) {
  const before = structuredClone(p.raw.life.inventory), node = (await p.observe()).resources.nodes.find(n => n.id === nodeId);
  if (!node.available) {
    assert.equal(node.stock, 0, 'script only waits for a depleted shared node, never steals a reservation');
    await p.applied('wait', {}); await f.advance(Math.max(100, node.regrow_at - f.now()));
  }
  const accepted = await p.applied('gather', { intent: 'start', node_id: nodeId, ...(mode ? { mode } : {}) });
  const jobId = accepted.life.gathering.job_id;
  await f.until(() => !p.raw.life.gathering, `finite work at ${nodeId} must finish`);
  assert.equal(held(p, node.item_id), (before[node.item_id] || 0) + node.yield_count, `actual ${nodeId} yield`);
  assert.equal(p.raw.life.ledger.entries.filter(entry => entry.source_id === jobId).length, 1);
  return jobId;
}

async function returnCamp(f, p) {
  await p.applied('adventure_plan', { intent: 'retreat', mode: 'run' });
  await f.until(() => p.raw.scene_id === 'plaza' && !p.raw.adventure.plan, 'explicit return must reach camp');
  assert.deepEqual(p.raw.position, { x: 11, y: 8 });
}

async function walkRoute(f, p, waypoints) {
  // The test controller chooses legal short steps from authored terrain. All
  // movement still goes through MCP and the same physical simulation as AI use.
  for (const target of waypoints) {
    for (let tries = 0; tries < 80 && (p.raw.position.x !== target.x || p.raw.position.y !== target.y); tries++) {
      const path = findPath(p.raw.scene_id, p.raw.position, target); assert.ok(path?.length > 1, `reachable route from ${JSON.stringify(p.raw.position)} to ${JSON.stringify(target)}`);
      let next = path[1], length = 0;
      for (let i = 1; i < path.length; i++) { const distance = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y); if (length + distance > 3) break; length += distance; next = path[i]; }
      await p.applied('move', { x: next.x, y: next.y }); await f.until(() => !p.raw.movement, 'chosen physical step must finish', 5000);
    }
    assert.deepEqual(p.raw.position, target);
  }
}

test('v020 HTTP/MCP complete real resource loop, shared action receipt and owner/observer isolation', { timeout: 60000 }, async t => {
  const f = await fixture(t), owner = await f.member('v020_owner'), otherOwner = await f.member('v020_other');
  const p = await f.actor(owner, '原来的采集旅人'), other = await f.actor(otherOwner, '另一位原AI');
  const initial = await p.observe();
  assert.deepEqual(initial.self.position, { x: 9, y: 7 }, 'keep the ordinary spawn, no teleport fixture');
  assert.deepEqual(initial.self.life.inventory, { turnip_seed: 3, wheat_seed: 3, wood: 3 }, 'only normal first-join supplies');
  const grant = structuredClone(p.raw.run), health = await f.api('/api/health'); assert.equal(health.body.version, '0.20.0');
  const types = (await p.client.listTools()).tools.find(tool => tool.name === 'act').inputSchema.properties.type.enum; assert.ok(types.includes('gather'));

  const request = await p.request('gather', { intent: 'start', node_id: 'camp_branches' });
  const receipt = await p.call('act', request); assert.equal(receipt.status, 'applied'); const acceptedPosition = { ...p.raw.position };
  assert.deepEqual(await p.call('act', request), receipt); assert.deepEqual(p.raw.position, acceptedPosition);
  await f.until(() => !p.raw.life.gathering, 'bootstrap branches complete once'); assert.equal(held(p, 'wood'), 4);
  const ledgerCount = p.raw.life.ledger.total_entries;
  assert.deepEqual(await p.call('act', request), receipt); assert.equal(held(p, 'wood'), 4); assert.equal(p.raw.life.ledger.total_entries, ledgerCount);
  await gather(f, p, 'camp_stones'); assert.equal(held(p, 'ore'), 1);
  const craftBefore = { wood: held(p, 'wood'), ore: held(p, 'ore'), energy: p.raw.fatigue.energy };
  await p.applied('inventory', { intent: 'craft', item_id: 'axe' });
  assert.equal(held(p, 'wood'), craftBefore.wood - 2); assert.equal(held(p, 'ore'), craftBefore.ore - 1); close(p.raw.fatigue.energy, craftBefore.energy - 2);
  assert.deepEqual(p.raw.life.tools.axe, { level: 1, durability: 12, max_durability: 12, owned: true });

  // Anonymous selection is only a GET query; it cannot move, reserve, spend or
  // renew the owner's grant. Other owners and the administrator get public tools,
  // while only the owning session/controller receives the personal warehouse.
  const beforeReads = { positions: [p.raw.position, other.raw.position], inventory: p.raw.life.inventory, resources: f.app.world.state.resources, grant: p.raw.run, next: p.raw.next_action_id };
  const readBaseline = JSON.stringify(beforeReads);
  const anonymous = await f.api('/api/public/world?scene=plaza&node_id=east_pine'), own = await f.api('/api/world', undefined, owner), foreign = await f.api('/api/world', undefined, otherOwner), admin = await f.api('/api/world', undefined, f.admin);
  for (const response of [anonymous, own, foreign, admin]) assert.equal(response.status, 200);
  assert.equal(JSON.stringify({ positions: [p.raw.position, other.raw.position], inventory: p.raw.life.inventory, resources: f.app.world.state.resources, grant: p.raw.run, next: p.raw.next_action_id }), readBaseline);
  for (const response of [anonymous, foreign, admin]) {
    const visible = response.body.agents.find(a => a.agent_id === p.id);
    assert.equal(visible.life.tools.axe.owned, true); assert.equal(visible.life.inventory, undefined); assert.equal(visible.life.ledger, undefined); assert.equal(visible.life.market, undefined); assert.equal(visible.run, undefined);
    const text = JSON.stringify(response.body); assert.equal(text.includes(p.token), false); assert.equal(text.includes(p.goal), false);
    for (const node of response.body.resources.nodes) if (node.reservation) assert.deepEqual(Object.keys(node.reservation).sort(), ['agent_id', 'expires_at', 'job_id']);
  }
  assert.deepEqual(own.body.agents.find(a => a.agent_id === p.id).life.inventory, (await p.observe()).self.life.inventory);
  const nearby = (await other.observe()).nearby_agents.find(a => a.agent_id === p.id); assert.ok(nearby); assert.equal(nearby.life.inventory, undefined); assert.equal(nearby.life.tools.axe.owned, true);
  assert.equal((await f.api('/api/world')).status, 401);
  assert.equal((await f.api(`/api/agents/${p.id}/control`, { operation: 'pause' }, otherOwner)).status, 403);
  assert.equal((await f.api(`/api/agents/${p.id}/control`, { operation: 'pause' }, f.admin)).status, 403);
  assert.equal(p.raw.status, 'active');

  await gather(f, p, 'east_pine'); assert.equal(p.raw.life.tools.axe.durability, 11);
  await returnCamp(f, p); await gather(f, p, 'camp_stones'); await gather(f, p, 'camp_stones');
  const pickBefore = { wood: held(p, 'wood'), ore: held(p, 'ore') }; await p.applied('inventory', { intent: 'craft', item_id: 'pickaxe' });
  assert.equal(held(p, 'wood'), pickBefore.wood - 2); assert.equal(held(p, 'ore'), pickBefore.ore - 2); assert.equal(p.raw.life.tools.pickaxe.durability, 12);
  await gather(f, p, 'orchard_berries'); assert.equal(held(p, 'berry'), 2); await returnCamp(f, p);

  await p.applied('adventure_plan', { intent: 'explore', zone_id: 'quarry' });
  await f.until(() => p.raw.scene_id === 'adventure' && p.raw.adventure.in_field, 'cross the real portal and leave the camp safety circle');
  await p.applied('adventure_plan', { intent: 'stop' });
  await walkRoute(f, p, [{ x: 14, y: 14 }, { x: 35, y: 14 }, { x: 36, y: 10 }]);
  assert.equal(p.raw.adventure.in_field, true);
  await gather(f, p, 'ridge_ore'); assert.equal(p.raw.life.tools.pickaxe.durability, 11); assert.equal(held(p, 'ore'), 3);

  // Choose a real encounter with a native monster to verify restorative food
  // against actual damage; no HP assignment or fabricated combat callback.
  await walkRoute(f, p, [{ x: 35, y: 14 }, { x: 14, y: 14 }]);
  if (p.raw.adventure.hp === p.raw.adventure.max_hp) {
    await p.applied('adventure_plan', { intent: 'explore', zone_id: 'forest' });
    const limit = f.now() + 60000;
    while (p.raw.adventure.hp === p.raw.adventure.max_hp && f.now() < limit) {
      await f.advance(100);
      const encounter = p.raw.adventure.encounter;
      if (encounter?.status === 'pending') await p.applied('adventure_event', { event_id: encounter.event_id, choice_id: 'decline' });
    }
  }
  assert.ok(p.raw.adventure.hp > 0 && p.raw.adventure.hp < p.raw.adventure.max_hp, 'native monster caused real damage');
  assert.ok(f.app.world.state.events.some(e => e.type === 'adventure_combat' && e.payload.agent_id === p.id && e.payload.attacker === 'monster'));
  await returnCamp(f, p);
  const rationBefore = { berry: held(p, 'berry'), wood: held(p, 'wood'), energy: p.raw.fatigue.energy };
  await p.applied('inventory', { intent: 'craft', item_id: 'trail_ration' });
  assert.equal(held(p, 'berry'), rationBefore.berry - 2); assert.equal(held(p, 'wood'), rationBefore.wood - 1); close(p.raw.fatigue.energy, rationBefore.energy - 2);
  const beforeUse = { hp: p.raw.adventure.hp, energy: p.raw.fatigue.energy };
  assert.ok(beforeUse.hp < p.raw.adventure.max_hp && beforeUse.energy < 100);
  await p.applied('inventory', { intent: 'use', item_id: 'trail_ration' });
  close(p.raw.adventure.hp, Math.min(p.raw.adventure.max_hp, beforeUse.hp + 12)); close(p.raw.fatigue.energy, Math.min(100, beforeUse.energy + 18)); assert.equal(held(p, 'trail_ration'), 0);
  const afterUse = { hp: p.raw.adventure.hp, energy: p.raw.fatigue.energy };

  if (held(p, 'wood') < 3) await gather(f, p, 'camp_branches');
  const woodBeforeSword = held(p, 'wood'); await p.applied('inventory', { intent: 'craft', item_id: 'wooden_sword' }); assert.equal(held(p, 'wood'), woodBeforeSword - 3);
  await p.applied('inventory', { intent: 'equip', item_id: 'wooden_sword' }); assert.equal(p.raw.life.equipment.weapon, 'wooden_sword');
  await p.applied('adventure_plan', { intent: 'explore', zone_id: 'grove', mode: 'run' });
  await f.until(() => p.raw.scene_id === 'adventure' && !p.raw.adventure.plan, 'equipped AI completes its explicitly selected grove journey');
  assert.deepEqual(p.raw.position, { x: 28, y: 11 }); assert.equal(p.raw.adventure.last_result.kind, 'completed');
  assert.deepEqual(p.raw.run, grant, 'resource/equipment/travel never extends the owner grant or changes controller');
  assert.ok(f.samples.fractional > 0 && f.samples.walk > 0 && f.samples.run > 0 && f.samples.working > 0);
  t.diagnostic(JSON.stringify({ scenario: 'scripted decisions through real HTTP/MCP', direct_midrun_inventory_or_position_writes: 0,
    physics_samples: f.samples, actual_food_restoration: { before: beforeUse, after: afterUse },
    final_tool_durability: { axe: p.raw.life.tools.axe.durability, pickaxe: p.raw.life.tools.pickaxe.durability },
    final_equipment: p.raw.life.equipment.weapon, final_scene: p.raw.scene_id, final_position: p.raw.position,
    same_owner_grant: true, anonymous_foreign_admin_private_inventory_leaks: 0, receipt_replay_extra_rewards: 0 }));
});
