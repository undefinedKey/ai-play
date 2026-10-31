import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';

// Real HTTP/MCP and public endpoint. Deterministic setup/clock is test-only;
// decisions are scripted assertions, never evidence of real AI preferences.
async function fixture(t) {
  const app = await createApp({ dbPath: ':memory:', frontend: false, demo: false });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), actors = [];
  t.after(async () => {
    await Promise.all(actors.map(p => p.client.close()));
    await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  });
  const actor = async name => {
    const a = app.world.createAgent({ name, owner_id: name });
    const c = app.world.createController(a.agent_id);
    app.world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 30 });
    const client = new Client({ name: 'v014-http', version: '0.14.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } }));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text);
    };
    const joined = await call('join_world');
    const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload) => ({ ...session, type, payload, action_id: (await observe()).next_action_id });
    const act = async (type, payload) => call('act', await request(type, payload));
    const applied = async (type, payload) => { const r = await act(type, payload); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; };
    const p = { id: a.agent_id, get raw() { return app.world.agent(a.agent_id); }, client, call, observe, request, act, applied, session };
    p.raw.position = { x: 11, y: 8 }; actors.push(p); return p;
  };
  const advance = async ms => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 1000); app.world.tick();
      for (const p of actors) if (p.raw.status === 'active') await p.observe();
    }
  };
  return { app, url, actor, advance, time: () => now };
}

test('v0.14 HTTP: exploration offers real choices, rejects stale movement and settles a public goal once', async t => {
  const f = await fixture(t), p = await f.actor('发现旅人');
  const rules = await p.call('get_rules');
  assert.equal(rules.recommended_skill_version, '0.17.0');
  assert.equal(rules.max_capabilities, 16);
  assert.equal(rules.adventure.exploration.pending_seconds, 150);
  const types = (await p.client.listTools()).tools.find(t => t.name === 'act').inputSchema.properties.type.enum;
  for (const type of ['adventure_event', 'personal_goal']) assert.ok(types.includes(type));
  const health = await (await fetch(`${f.url}/api/health`)).json();
  for (const cap of ['exploration_events', 'strategic_equipment', 'personal_goals']) assert.equal(health.capabilities[cap], true);
  await p.applied('personal_goal', { intent: 'set', kind: 'resolve_exploration', target_id: 'forest', target_count: 1, title: '观察一次森林发现', duration_seconds: 900 });
  const goal = (await p.observe()).self.personal_goal;
  assert.equal(goal.progress, 0); assert.equal(goal.status, 'active'); assert.equal(p.raw.adventure.plan, null);
  await p.applied('adventure_plan', { intent: 'explore', zone_id: 'forest' });
  for (let i = 0; i < 30 && !(await p.observe()).self.adventure.encounter; i++) await f.advance(1000);
  const found = (await p.observe()).self.adventure.encounter;
  assert.equal(found.status, 'pending'); assert.equal(found.expires_at - found.found_at, 150000);
  const hp = p.raw.adventure.hp;
  const move = await p.act('move', { x: p.raw.position.x + 1, y: p.raw.position.y });
  assert.equal(move.status, 'rejected'); assert.equal(move.error.code, 'ENCOUNTER_PENDING');
  assert.equal((await p.observe()).self.adventure.encounter.event_id, found.event_id);
  await f.advance(5000); assert.equal(p.raw.adventure.hp, hp);
  // Every template has a payable choice once some HP and energy are missing.
  p.raw.adventure.hp = Math.min(p.raw.adventure.hp, p.raw.adventure.max_hp - 20); p.raw.fatigue.energy = 60;
  const choice = found.choices.find(c => c.choice_id !== 'decline');
  const request = await p.request('adventure_event', { event_id: found.event_id, choice_id: choice.choice_id });
  const receipt = await p.call('act', request); assert.equal(receipt.status, 'applied');
  const after = (await p.observe()).self;
  assert.equal(after.personal_goal.progress, 1); assert.equal(after.personal_goal.status, 'completed');
  const ledgerCount = after.life.ledger.total_entries;
  assert.deepEqual(await p.call('act', request), receipt);
  assert.equal((await p.observe()).self.life.ledger.total_entries, ledgerCount);
  const second = await p.act('adventure_event', { event_id: found.event_id, choice_id: choice.choice_id });
  assert.equal(second.status, 'rejected'); assert.equal((await p.observe()).self.personal_goal.progress, 1);
  const state = await (await fetch(`${f.url}/api/public/world`)).json();
  const visible = state.agents.find(a => a.agent_id === p.id);
  assert.equal(visible.personal_goal.title, '观察一次森林发现'); assert.equal(visible.personal_goal.progress, 1);
  assert.equal(visible.adventure.encounter.status, 'resolved');
  for (const key of ['inventory', 'ledger', 'market']) assert.equal(visible.life[key], undefined);
  for (const key of ['goal', 'run', 'diagnostics']) assert.equal(visible[key], undefined);
  assert.ok(!/"(?:source_plan_id|source_run_id|source_epoch|token_hash|owner_goal)"/.test(JSON.stringify(state)));
});

test('v0.14 HTTP: public acquisition goal counts new gains, exposes no existing stock and pauses for review', async t => {
  const f = await fixture(t), p = await f.actor('材料旅人');
  p.raw.life.inventory.wood = 70;
  await p.applied('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 3, duration_seconds: 600, title: '<img src=x onerror=alert(1)>' });
  const initial = (await p.observe()).self.personal_goal;
  assert.equal(initial.progress, 0);
  await p.applied('gather', { intent: 'start', resource_id: 'wood' }); await f.advance(12000);
  assert.equal((await p.observe()).self.personal_goal.progress, 1);
  await p.applied('inventory', { intent: 'craft', item_id: 'wooden_sword' });
  assert.equal((await p.observe()).self.personal_goal.progress, 1, 'spending cannot undo a published acquisition');
  const bad = await p.act('personal_goal', { intent: 'confirm', goal_id: 'stale_goal' }); assert.equal(bad.status, 'rejected');
  const lateRequest = await p.request('personal_goal', { intent: 'confirm', goal_id: initial.goal_id });
  f.app.world.ownerControl(p.id, 'pause');
  const publicState = await (await fetch(`${f.url}/api/public/world`)).json();
  const publicGoal = publicState.agents.find(a => a.agent_id === p.id).personal_goal;
  assert.equal(publicGoal.status, 'needs_review'); assert.equal(publicGoal.expires_at, initial.expires_at);
  assert.equal(publicGoal.progress, 1);
  const late = await p.client.callTool({ name: 'act', arguments: lateRequest });
  assert.ok(late.isError || late.structuredContent?.status === 'rejected' || late.structuredContent?.error);
  assert.equal(p.raw.personal_goal.status, 'needs_review');
});

test('v0.14 HTTP: strategy recipes and equipped effective attributes agree through MCP', async t => {
  const f = await fixture(t), p = await f.actor('装备旅人');
  Object.assign(p.raw.life.inventory, { wood: 60, ore: 60 });
  const rules = await p.call('get_rules');
  for (const id of ['hunter_bow', 'heavy_hammer', 'heavy_armor']) {
    assert.ok(rules.life.strategy_equipment.item_ids.includes(id));
    await p.applied('inventory', { intent: 'craft', item_id: id });
  }
  await p.applied('inventory', { intent: 'equip', item_id: 'hunter_bow' });
  let a = (await p.observe()).self;
  assert.equal(a.life.stats.range, 3); assert.equal(a.life.stats.attack_interval_ms, 2000); assert.equal(a.life.stats.attack_energy, 2);
  await p.applied('inventory', { intent: 'equip', item_id: 'heavy_armor' });
  a = (await p.observe()).self;
  assert.equal(a.life.stats.defense, 5); assert.equal(a.life.stats.attack_interval_ms, 3000);
  const energy = a.fatigue.energy;
  await p.applied('move', { x: 12, y: 8 });
  a = (await p.observe()).self;
  assert.ok(Math.abs(energy - a.fatigue.energy - a.life.stats.move_energy_per_tile) < 0.00001);
  await p.applied('inventory', { intent: 'equip', item_id: 'heavy_hammer' });
  a = (await p.observe()).self;
  assert.equal(a.life.stats.range, 1); assert.equal(a.life.stats.attack_energy, 5);
});
