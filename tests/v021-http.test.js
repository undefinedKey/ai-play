import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { findPath, isWalkable } from '../server/spatial.js';

// These are explicit scripted choices through HTTP/MCP, not an AI-preference
// evaluation. Only the clock is controlled: no inventory, position, HP, energy,
// hunger, resource, torch, fire or tree state is injected at any point.
async function fixture(t) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', host: '127.0.0.1', publicUrl: 'http://v021.test:3000', allowHttp: true, frontend: false, demo: false });
  const adminOwner = await app.accounts.createAdmin({ username: 'v021_admin', passwordless: true });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), clients = [], actors = [];
  t.after(async () => { for (const client of clients) await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = async (path, data, session = {}) => {
    const r = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: app.config.publicUrl.origin, 'Content-Type': 'application/json', ...(session.cookie ? { Cookie: session.cookie } : {}), ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await r.json(); return { status: r.status, body, cookie: r.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const ticket = app.accounts.createLoginTicket(adminOwner.id), admin = await api('/api/auth/link', { token: ticket.token }); assert.equal(admin.status, 200);
  async function actor(name, username) {
    const invitation = await api('/api/admin/invites', { expires_hours: 1 }, admin); assert.equal(invitation.status, 201);
    const owner = await api('/api/auth/register', { username, name: username, password: 'Only-for-v021-HTTP-tests-2026!', invite_code: invitation.body.invite_code }); assert.equal(owner.status, 201);
    const created = await api('/api/agents', { name }, owner); assert.equal(created.status, 201); const id = created.body.agent.agent_id;
    const controller = await api(`/api/agents/${id}/controllers`, { kind: 'external', name: '真实生存验收客户端' }, owner); assert.equal(controller.status, 201);
    const goal = `PRIVATE_V021_OWNER_GOAL_${id}`;
    const grant = await api(`/api/agents/${id}/control`, { operation: 'start', controller_id: controller.body.controller_id, duration_minutes: 60, max_calls: 10000, goal }, owner); assert.equal(grant.status, 200);
    const client = new Client({ name: 'v021-http-survival-validation', version: '0.24.2' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.body.token}` } } }));
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent || JSON.parse(result.content.find(c => c.type === 'text').text); };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session), request = async (type, payload) => ({ ...session, action_id: (await observe()).next_action_id, type, payload });
    const applied = async (type, payload) => { const req = await request(type, payload), receipt = await call('act', req); assert.equal(receipt.status, 'applied', JSON.stringify(receipt.error)); return { req, receipt }; };
    const p = { id, client, owner, token: controller.body.token, goal, call, observe, request, applied, get raw() { return app.world.agent(id); } }; actors.push(p); return p;
  }
  const samples = { fractional: 0, working: 0, phases: new Set() }; let heartbeat = now;
  async function advance(ms) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100); app.world.tick(); samples.phases.add(app.world.state.day_cycle.last_phase);
      for (const p of actors) {
        assert.equal(p.raw.status, 'active', 'both controllers stay online throughout the controlled day');
        assert.ok(isWalkable(p.raw.scene_id, p.raw.position));
        if (!Number.isInteger(p.raw.position.x) || !Number.isInteger(p.raw.position.y)) samples.fractional++;
        if (p.raw.life.gathering?.phase === 'working') samples.working++;
      }
      if (now - heartbeat >= 5000) { for (const p of actors) await p.observe(); heartbeat = now; }
    }
  }
  const until = async (predicate, label, timeout = 120000) => { const limit = now + timeout; while (!predicate() && now < limit) await advance(100); assert.ok(predicate(), label); };
  const advanceTo = async at => { assert.ok(at >= now, 'script schedule only moves forward'); await advance(at - now); };
  return { app, api, admin, actor, advance, until, advanceTo, samples, now: () => now };
}
const held = (p, id) => p.raw.life.inventory[id] || 0;
const ledger = (p, source, items) => { const entries = p.raw.life.ledger.entries.filter(e => e.source_id === source); assert.equal(entries.length, 1, source); assert.deepEqual(entries[0].items, items); };
async function gather(f, p, nodeId) {
  const node = (await p.observe()).resources.nodes.find(n => n.id === nodeId), before = held(p, node.item_id); assert.equal(node.available, true, nodeId);
  const result = await p.applied('gather', { intent: 'start', node_id: nodeId });
  await f.until(() => !p.raw.life.gathering, `finite gathering at ${nodeId} finishes`);
  assert.equal(held(p, node.item_id), before + node.yield_count); return result;
}
async function walkTo(f, p, target) {
  for (let tries = 0; tries < 100 && (p.raw.position.x !== target.x || p.raw.position.y !== target.y); tries++) {
    const path = findPath(p.raw.scene_id, p.raw.position, target); assert.ok(path?.length > 1);
    let next = path[1], length = 0;
    for (let i = 1; i < path.length; i++) { const step = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y); if (length + step > 3) break; length += step; next = path[i]; }
    await p.applied('move', { x: next.x, y: next.y }); await f.until(() => !p.raw.movement, 'physical short step arrives', 5000);
  }
  assert.deepEqual(p.raw.position, target);
}

test('v021 real HTTP/MCP survival day: axe, felling, planting, shared fire, cooking and a full night risk contrast', { timeout: 60000 }, async t => {
  const f = await fixture(t), p = await f.actor('自主生存旅人', 'v021_survivor'), dark = await f.actor('暗处风险对照', 'v021_dark');
  const initial = await p.observe(), epoch = f.app.world.state.day_cycle.epoch_at, grants = actorsGrants();
  function actorsGrants() { return [p, dark].map(a => structuredClone(a.raw.run)); }
  assert.equal((await f.api('/api/health')).body.version, '0.24.2');
  assert.deepEqual(initial.self.position, { x: 9, y: 7 }); assert.deepEqual(initial.self.life.inventory, { turnip_seed: 3, wheat_seed: 3, wood: 3 });
  assert.ok((await p.client.listTools()).tools.find(x => x.name === 'act').inputSchema.properties.type.enum.includes('survival'));
  await gather(f, p, 'camp_stones'); assert.equal(held(p, 'ore'), 1);
  const axe = await p.applied('inventory', { intent: 'craft', item_id: 'axe' }); ledger(p, axe.req.action_id, { wood: -2, ore: -1, axe: 1 });
  assert.equal(held(p, 'wood'), 1); assert.equal(p.raw.life.tools.axe.durability, 12);

  const chops = [];
  for (let n = 0; n < 3; n++) {
    const chopped = await gather(f, p, 'east_pine'); chops.push(chopped);
    assert.equal(f.app.world.state.resources.nodes.east_pine.stock, 2 - n); assert.equal(p.raw.life.tools.axe.durability, 11 - n);
    assert.equal(held(p, 'pine_cone'), n === 2 ? 1 : 0);
    ledger(p, chopped.receipt.life.gathering.job_id, n === 2 ? { wood: 3, pine_cone: 1 } : { wood: 3 });
  }
  const felled = structuredClone(f.app.world.state.resources.nodes.east_pine);
  assert.equal(felled.ecology.stage, 'stump'); assert.equal(felled.stock, 0); assert.equal(held(p, 'wood'), 10);
  const replayBaseline = JSON.stringify({ inventory: p.raw.life.inventory, node: f.app.world.state.resources.nodes.east_pine, ledger: p.raw.life.ledger });
  assert.deepEqual(await p.call('act', chops[2].req), chops[2].receipt);
  assert.equal(JSON.stringify({ inventory: p.raw.life.inventory, node: f.app.world.state.resources.nodes.east_pine, ledger: p.raw.life.ledger }), replayBaseline);

  await gather(f, p, 'meadow_grass'); await gather(f, p, 'meadow_grass'); assert.equal(held(p, 'grass'), 4);
  await gather(f, p, 'orchard_berries'); assert.equal(held(p, 'berry'), 2);
  const planted = await p.applied('gather', { intent: 'plant', node_id: 'planting_plaza' });
  assert.equal(held(p, 'pine_cone'), 1, 'seed is reserved by intent, spent only after actual arrival and work');
  await f.until(() => !p.raw.life.gathering, 'explicit planting reaches the site and completes four seconds of work');
  assert.equal(held(p, 'pine_cone'), 0); const plantedAt = f.app.world.state.resources.nodes.planting_plaza.ecology.stage_started_at;
  assert.equal(f.app.world.state.resources.nodes.planting_plaza.ecology.stage, 'sapling');
  assert.equal(f.app.world.state.resources.nodes.planting_plaza.ecology.origin, 'planted');
  ledger(p, planted.receipt.life.gathering.job_id, { pine_cone: -1 });
  const plantCount = p.raw.life.ledger.total_entries; assert.deepEqual(await p.call('act', planted.req), planted.receipt); assert.equal(p.raw.life.ledger.total_entries, plantCount);

  await p.applied('survival', { intent: 'approach', site_id: 'plaza_hearth' });
  await f.until(() => !p.raw.survival.travel, 'chosen site approach truly arrives'); assert.deepEqual(p.raw.position, { x: 13, y: 11 });
  assert.equal(Object.keys(f.app.world.state.survival.fires).length, 0, 'approach never auto-builds');
  const built = await p.applied('survival', { intent: 'build', site_id: 'plaza_hearth', kind: 'campfire' });
  const fireId = Object.keys(f.app.world.state.survival.fires)[0]; assert.ok(fireId);
  ledger(p, built.req.action_id, { wood: -3, grass: -2 }); assert.equal(held(p, 'wood'), 7); assert.equal(held(p, 'grass'), 2);
  assert.deepEqual(await p.call('act', built.req), built.receipt); assert.equal(Object.keys(f.app.world.state.survival.fires).length, 1);
  const roast = await p.applied('inventory', { intent: 'craft', item_id: 'roasted_berry' }); ledger(p, roast.req.action_id, { berry: -1, roasted_berry: 1 });
  const hungerBefore = p.raw.survival.satiety, energyBefore = p.raw.fatigue.energy;
  const eaten = await p.applied('inventory', { intent: 'use', item_id: 'roasted_berry' });
  assert.equal(p.raw.survival.satiety, Math.min(100, Math.round((hungerBefore + 18) * 10000) / 10000));
  assert.equal(p.raw.fatigue.energy, Math.min(100, Math.round((energyBefore + 5) * 100) / 100)); ledger(p, eaten.req.action_id, { roasted_berry: -1 });
  const unusedBerry = held(p, 'berry'); assert.equal(unusedBerry, 1);
  await walkTo(f, dark, { x: 26, y: 11 }); assert.ok(f.now() < epoch + 300000, 'all preparation is achieved during the first daylight period');

  const beforeReads = JSON.stringify({ p: [p.raw.position, p.raw.life.inventory, p.raw.run], d: [dark.raw.position, dark.raw.run], fires: f.app.world.state.survival, resources: f.app.world.state.resources });
  for (const [i, response] of [await f.api('/api/public/world?scene=plaza&site_id=plaza_hearth'), await f.api('/api/world', undefined, dark.owner), await f.api('/api/world', undefined, f.admin)].entries()) {
    assert.equal(response.status, 200); const seen = response.body.agents.find(a => a.agent_id === p.id);
    assert.equal(seen.life.inventory, undefined); assert.equal(seen.life.ledger, undefined); assert.equal(seen.run, undefined); assert.equal(seen.survival.satiety, p.raw.survival.satiety);
    for (const secret of [p.token, dark.token, p.goal, ...(i === 1 ? [] : [dark.goal])]) assert.equal(JSON.stringify(response.body).includes(secret), false);
    assert.equal(response.body.survival.fires.find(x => x.fire_id === fireId).owner_agent_id, p.id);
  }
  assert.equal(JSON.stringify({ p: [p.raw.position, p.raw.life.inventory, p.raw.run], d: [dark.raw.position, dark.raw.run], fires: f.app.world.state.survival, resources: f.app.world.state.resources }), beforeReads);
  assert.equal((await f.api('/api/world')).status, 401);

  await f.advanceTo(epoch + 330000);
  assert.equal(f.app.world.state.day_cycle.last_phase, 'dusk');
  assert.equal(f.app.world.state.survival.fires[fireId].lit, false, 'the original 90-second fuel was allowed to burn out naturally');
  assert.equal(held(p, 'wood'), 7, 'no implicit refueling'); assert.equal(held(p, 'berry'), unusedBerry, 'no implicit food consumption');
  assert.ok(f.app.world.state.events.some(e => e.type === 'survival_warning' && e.payload.agent_id === p.id && e.payload.kind === 'prepare_night'));
  const fueled = await p.applied('survival', { intent: 'fuel', fire_id: fireId, item_id: 'wood', quantity: 5 });
  ledger(p, fueled.req.action_id, { wood: -5 }); assert.equal(held(p, 'wood'), 2);
  const fuelLedger = p.raw.life.ledger.total_entries; assert.deepEqual(await p.call('act', fueled.req), fueled.receipt); assert.equal(p.raw.life.ledger.total_entries, fuelLedger);
  assert.equal(f.app.world.state.survival.fires[fireId].fuel_seconds, 300);

  const hpAtNight = p.raw.adventure.hp, darkHp = dark.raw.adventure.hp;
  await f.advanceTo(epoch + 450000); assert.equal(f.app.world.state.day_cycle.last_phase, 'night');
  assert.equal(p.raw.adventure.hp, hpAtNight); assert.equal(dark.raw.adventure.hp, darkHp);
  assert.equal((await p.observe()).self.survival.light.lit, true); assert.equal((await dark.observe()).self.survival.light.lit, false);
  const darkBefore = held(dark, 'berry'), interrupted = await dark.applied('gather', { intent: 'start', node_id: 'orchard_berries' });
  assert.equal(interrupted.receipt.life.gathering.phase, 'working'); assert.equal(interrupted.receipt.life.gathering.ends_at, epoch + 460000);
  await f.advanceTo(epoch + 460000);
  assert.equal(dark.raw.adventure.hp, darkHp - 4); assert.equal(dark.raw.life.gathering, null); assert.equal(held(dark, 'berry'), darkBefore);
  assert.equal(f.app.world.state.resources.nodes.orchard_berries.reservation, null);
  assert.ok(f.app.world.state.events.some(e => e.type === 'life_gather_cancelled' && e.payload.agent_id === dark.id && e.payload.reason === 'hurt'));
  assert.ok(!dark.raw.life.ledger.entries.some(e => e.source_id === interrupted.receipt.life.gathering.job_id), 'interrupted work grants no materials');
  await f.advanceTo(epoch + 600000);
  assert.equal(f.app.world.state.day_cycle.last_phase, 'day'); assert.equal(f.app.world.state.day_cycle.last_day_index, 2);
  assert.equal(p.raw.adventure.hp, hpAtNight, 'real same-scene fire protects the entire night');
  assert.ok(dark.raw.adventure.hp > 0 && dark.raw.adventure.hp < darkHp, 'online dark control actually lost life without fabricated HP');
  assert.equal(p.raw.survival.darkness_seconds, 0); assert.equal(dark.raw.survival.darkness_seconds, 0);
  assert.equal(f.app.world.state.survival.fires[fireId].fuel_seconds, 30); assert.equal(f.app.world.state.survival.fires[fireId].lit, true);
  assert.equal(held(p, 'wood'), 2); assert.equal(held(p, 'berry'), unusedBerry);
  assert.deepEqual(actorsGrants(), grants, 'world simulation never extends authorization or replaces controller identity');
  assert.equal(f.app.world.state.resources.nodes.east_pine.ecology.stage, 'sapling');
  assert.equal(f.app.world.state.resources.nodes.planting_plaza.ecology.stage, 'young');
  assert.equal(f.app.world.state.resources.nodes.planting_plaza.ecology.stage_started_at, plantedAt + 180000);
  assert.equal(f.app.world.state.events.filter(e => e.type === 'fire_built').length, 1); assert.equal(f.app.world.state.events.filter(e => e.type === 'fire_fueled').length, 1);
  assert.equal(f.app.world.state.events.filter(e => e.type === 'life_consumed' && e.payload.agent_id === p.id).length, 1);
  assert.deepEqual([...f.samples.phases], ['day', 'dusk', 'night', 'dawn']); assert.ok(f.samples.fractional > 0 && f.samples.working > 0);
  t.diagnostic(JSON.stringify({ scenario: 'scripted HTTP/MCP survival day', fabricated_gameplay_state_writes: 0, real_tree_chops: 3, planted_seed: 1,
    craft_and_fire_ledger_exact_once: true, phases: [...f.samples.phases], protected_hp: p.raw.adventure.hp, dark_hp: dark.raw.adventure.hp,
    dark_work_interrupted_without_reward: true, unchanged_owner_grants: true, physics_samples: { fractional: f.samples.fractional, working: f.samples.working } }));
});
