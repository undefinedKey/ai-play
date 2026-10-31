import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { initializeEconomy } from '../server/economy.js';

// Real HTTP and MCP, injected game clock. No production records or model calls.
test('v0.13 HTTP: zero-resource pacifist can gather, repair, farm, cook and trade without leaking accounts', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false, demo: false });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close()));
    await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  });
  const actor = async name => {
    const a = app.world.createAgent({ name, owner_id: name });
    const controller = app.world.createController(a.agent_id);
    app.world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 15 });
    const client = new Client({ name: 'v013-http', version: '0.14.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return r.structuredContent || JSON.parse(r.content[0].text);
    };
    const joined = await call('join_world');
    const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload) => ({ ...session, type, payload, action_id: (await observe()).next_action_id });
    const act = async (type, payload) => call('act', await request(type, payload));
    app.world.agent(a.agent_id).position = { x: 11, y: 8 };
    return { id: a.agent_id, client, call, observe, request, act };
  };
  const p = await actor('和平旅人'), raw = app.world.agent(p.id);
  // Deliberately starved saved-state fixture: no gifts, seed, coins or useful tools.
  raw.life.inventory = {}; raw.adventure.gold = 0; raw.fatigue.energy = 0;
  raw.life.tools.hoe.durability = 0; raw.life.tools.watering_can.durability = 0;
  delete raw.life.ledger; initializeEconomy(raw, now);
  const advance = async ms => {
    const end = now + ms;
    while (now < end) { now = Math.min(end, now + 10000); app.world.tick(); await p.observe(); }
  };
  const applied = async (type, payload) => {
    const r = await p.act(type, payload); assert.equal(r.status, 'applied', JSON.stringify(r.error)); return r;
  };
  const types = (await p.client.listTools()).tools.find(t => t.name === 'act').inputSchema.properties.type.enum;
  assert.ok(types.includes('gather') && types.includes('trade'));
  const rules = await p.call('get_rules');
  assert.equal(rules.recommended_skill_version, '0.16.0');
  assert.deepEqual(rules.life.gathering.resources.map(r => r.id), ['wood', 'ore']);
  const health = await (await fetch(`${url}/api/health`)).json();
  for (const cap of ['gathering', 'cooking', 'trading']) assert.equal(health.capabilities[cap], true);
  assert.equal((await p.act('gather', { intent: 'start', resource_id: 'wood' })).error.code, 'FATIGUE_EXHAUSTED');
  await applied('adventure_plan', { intent: 'rest' }); await advance(60000);
  if ((await p.observe()).self.adventure.plan) await applied('adventure_plan', { intent: 'stop' });
  for (let i = 0; i < 5; i++) {
    const before = await p.observe();
    await advance(Math.max(0, (before.self.life.gather_ready_at?.wood || 0) - now));
    const req = await p.request('gather', { intent: 'start', resource_id: 'wood' });
    const first = await p.call('act', req); assert.equal(first.status, 'applied');
    assert.deepEqual(await p.call('act', req), first);
    const job = (await p.observe()).self.life.gathering; assert.equal(job.resource_id, 'wood');
    await advance(job.ends_at - now);
    assert.equal((await p.observe()).self.life.inventory.wood, i + 1);
    assert.equal((await p.observe()).self.life.gathering, null);
  }
  const sell = await p.request('trade', { intent: 'sell', item_id: 'wood', quantity: 3 });
  const receipt = await p.call('act', sell); assert.equal(receipt.status, 'applied');
  assert.deepEqual(await p.call('act', sell), receipt);
  assert.equal((await p.observe()).self.adventure.gold, 3);
  await applied('trade', { intent: 'buy', item_id: 'turnip_seed', quantity: 1 });
  await applied('trade', { intent: 'buy', item_id: 'wheat_seed', quantity: 1 });
  assert.equal((await p.observe()).self.adventure.gold, 0);
  for (const tool of ['hoe', 'watering_can']) await applied('inventory', { intent: 'repair', item_id: tool });
  for (const [plot_id, crop_id] of [['plot_1', 'turnip'], ['plot_2', 'wheat']]) {
    await applied('farm', { intent: 'till', plot_id });
    await applied('farm', { intent: 'plant', plot_id, crop_id });
    await applied('farm', { intent: 'water', plot_id });
  }
  await applied('gather', { intent: 'start', resource_id: 'ore' });
  await advance(180000);
  assert.equal((await p.observe()).self.life.inventory.ore, 1);
  for (const plot_id of ['plot_1', 'plot_2']) await applied('farm', { intent: 'harvest', plot_id });
  await applied('inventory', { intent: 'craft', item_id: 'turnip_soup' });
  await applied('inventory', { intent: 'craft', item_id: 'wheat_bread' });
  const beforeFood = (await p.observe()).self.fatigue.energy; assert.ok(beforeFood < 100);
  await applied('inventory', { intent: 'use', item_id: 'wheat_bread' });
  assert.equal((await p.observe()).self.fatigue.energy, Math.min(100, beforeFood + 24));
  const soup = await p.act('inventory', { intent: 'use', item_id: 'turnip_soup' });
  assert.equal(soup.status, 'rejected'); assert.equal((await p.observe()).self.life.inventory.turnip_soup, 1);
  await applied('trade', { intent: 'sell', item_id: 'ore', quantity: 1 });
  await applied('trade', { intent: 'buy', item_id: 'turnip_seed', quantity: 1 });
  const end = (await p.observe()).self;
  assert.equal(end.adventure.kills, 0); assert.equal(end.adventure.gold, 1);
  assert.ok(end.life.ledger.entries.length > 5); assert.ok(end.life.market.buy_remaining < 20);
  assert.equal(end.life.tools.hoe.durability, 18); assert.equal(end.life.tools.watering_can.durability, 18);
  assert.ok(end.life.inventory.turnip_seed > 0 && end.life.inventory.wheat_seed > 0);
  const other = await actor('其他主人旅人');
  const neighbour = (await other.observe()).nearby_agents.find(a => a.agent_id === p.id);
  assert.ok(neighbour);
  const publicState = await (await fetch(`${url}/api/public/world`)).json();
  for (const a of [neighbour, ...publicState.agents]) {
    for (const key of ['inventory', 'ledger', 'market']) assert.equal(a.life[key], undefined, key);
    for (const key of ['goal', 'run', 'controllers', 'diagnostics']) assert.equal(a[key], undefined, key);
  }
  assert.ok(!/"(?:opening_balance|initial_grant|token_hash|source_id)"/.test(JSON.stringify(publicState)), 'private ledger or credential fields leaked');
  assert.equal(publicState.life.market.items.find(i => i.item_id === 'wood').buy_price, 4);
});
