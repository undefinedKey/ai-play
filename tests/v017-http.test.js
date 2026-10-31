import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { isWalkable } from '../shared/world-layout.js';

test('v0.17 real HTTP/MCP: viewers do not move residents; portal journeys isolate proximity and reject old-scene decisions', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false, demo: false });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), actors = [];
  t.after(async () => { await Promise.all(actors.map(a => a.client.close())); await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  async function actor(name) {
    const created = app.world.createAgent({ name }), controller = app.world.createController(created.agent_id);
    app.world.ownerControl(created.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 73 });
    const client = new Client({ name: 'scene-http-test', version: '0.17.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const act = async (type, payload) => call('act', { ...session, action_id: (await observe()).next_action_id, type, payload });
    const a = { id: created.agent_id, client, call, observe, act, session, get raw() { return app.world.agent(created.agent_id); } };
    a.raw.position = { x: 11, y: 8 }; actors.push(a); return a;
  }
  async function tick() { now += 1000; app.world.tick(); for (const a of actors) await a.observe(); }
  const a = await actor('远征者'), b = await actor('留在广场的人');
  const originalGrant = structuredClone(a.raw.run);
  assert.equal((await a.observe()).self.scene_id, 'plaza');
  assert.ok((await a.observe()).nearby_agents.some(p => p.agent_id === b.id));
  const group = await a.act('create_group', {}), invite = await a.act('invite', { group_id: group.group_id, target_agent_id: b.id });
  assert.equal((await b.act('respond_invite', { invite_id: invite.invite_id, accept: true })).status, 'applied');
  const before = structuredClone(a.raw.position);
  for (const view of ['adventure', 'plaza', 'farm']) {
    const response = await fetch(`${url}/api/public/world?view=${view}`); assert.equal(response.status, 200);
    const publicWorld = await response.json(), visible = publicWorld.agents.find(p => p.agent_id === a.id);
    assert.equal(visible.scene_id, 'plaza'); assert.deepEqual(visible.position, before);
    for (const key of ['run', 'goal', 'scene_migration', 'scene_stale_actions', 'next_action_id']) assert.equal(visible[key], undefined);
  }
  assert.equal((await a.act('adventure_plan', { intent: 'explore', zone_id: 'forest' })).status, 'applied');
  let late, crossed = false, walked = 0;
  for (let i = 0; i < 25; i++) {
    const old = structuredClone(a.raw.position), oldScene = a.raw.scene_id;
    if (oldScene === 'plaza' && old.x === 22 && old.y === 8) late = { ...a.session, action_id: (await a.observe()).next_action_id, type: 'move', payload: { x: 23, y: 8 } };
    await tick();
    assert.ok(isWalkable(a.raw.scene_id, a.raw.position));
    if (a.raw.scene_id !== oldScene) {
      assert.equal(oldScene, 'plaza'); assert.deepEqual(old, { x: 22, y: 8 });
      assert.equal(a.raw.scene_id, 'adventure'); assert.deepEqual(a.raw.position, { x: 11, y: 8 });
      crossed = true; break;
    }
    assert.ok(Math.abs(old.x - a.raw.position.x) + Math.abs(old.y - a.raw.position.y) <= 1);
    walked++;
  }
  assert.ok(crossed && walked >= 11 && late, 'entrance is reached by real steps');
  assert.equal((await a.call('act', late)).error.code, 'STALE_ACTION');
  assert.equal(a.raw.scene_id, 'adventure');
  assert.deepEqual(a.raw.position, b.raw.position, 'same local coordinates can exist in different scenes');
  assert.ok(!(await a.observe()).nearby_agents.some(p => p.agent_id === b.id));
  assert.ok(!(await b.observe()).nearby_agents.some(p => p.agent_id === a.id));
  assert.equal((await a.act('say', { channel: 'nearby', text: '只在林地附近说话' })).status, 'applied');
  const nearby = app.world.state.events.findLast(e => e.type === 'message' && e.payload.text === '只在林地附近说话');
  assert.equal(nearby.payload.scene_id, 'adventure'); assert.ok(!nearby.recipients.includes(b.id));
  assert.equal((await a.act('say', { channel: 'group', text: '从林地联系广场的队友', group_id: group.group_id })).status, 'applied');
  assert.equal((await a.act('farm', { intent: 'till', plot_id: 'plot_1' })).error.code, 'SCENE_REQUIRED');
  assert.equal((await a.act('adventure_plan', { intent: 'retreat' })).status, 'applied');
  await tick(); assert.equal(a.raw.scene_id, 'plaza'); assert.deepEqual(a.raw.position, { x: 22, y: 8 });
  for (let i = 0; i < 20 && a.raw.adventure.plan; i++) await tick();
  assert.equal(a.raw.adventure.plan, null); assert.deepEqual(a.raw.position, { x: 11, y: 8 });
  assert.equal((await a.act('farm', { intent: 'till', plot_id: 'plot_1' })).status, 'applied');
  assert.deepEqual(a.raw.run, originalGrant, 'travel cannot expand authorization, deadline or call budget');
  const transitions = app.world.state.events.filter(e => e.type === 'scene_changed' && e.payload.agent_id === a.id);
  assert.equal(transitions.length, 2);
});
