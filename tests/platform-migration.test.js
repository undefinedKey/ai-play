import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { createApp } from '../server/index.js';
import { removePlatformAgents } from '../server/remove-platform-agents.js';

test('new installation is empty; creating a profile does not create a demo controller', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false });
  const { server, url } = await app.start(0);
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  assert.equal(app.world.ownerSnapshot().agents.length, 0);
  const session = await fetch(`${url}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await session.json()).demo_enabled, false);
  const response = await fetch(`${url}/api/agents`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '小禾', is_platform: true }) });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.agent.is_platform, false);
  assert.equal(result.controller, null);
  assert.equal(app.world.ownerSnapshot().controllers.length, 0);
});

test('migration removes platform identities and references, preserves same-name user and budget, backs up once', () => {
  const world = new World();
  try {
    const platform = world.createAgent({ name: '小禾', is_platform: true });
    const user = world.createAgent({ name: '小禾', owner_id: 'real-owner' });
    const demo = world.createController(platform.agent_id, { kind: 'demo' });
    const external = world.createController(user.agent_id);
    world.ownerControl(user.agent_id, 'start', { controller_id: external.controller_id, max_calls: 42, duration_minutes: 7 });
    const run = structuredClone(world.agent(user.agent_id).run);
    world.state.game = { participants: [platform.agent_id, user.agent_id], status: 'finished', scores: { [platform.agent_id]: 1 } };
    world.state.groups.old = { group_id: 'old', members: [platform.agent_id, user.agent_id] };
    world.state.groups.unrelated = { group_id: 'unrelated', members: [user.agent_id] };
    world.agent(user.agent_id).group_id = 'old';
    world.state.receipts[`${platform.agent_id}:old`] = { controller_id: demo.controller_id };
    world.state.receipts.keep = { controller_id: external.controller_id, result: { ok: true } };
    world.event('message', { agent_id: platform.agent_id, text: 'old demo' }, [user.agent_id]);
    world.event('message', { agent_id: user.agent_id, text: 'my message' }, [platform.agent_id, user.agent_id]);
    assert.deepEqual(removePlatformAgents(world), [platform.agent_id]);
    assert.throws(() => world.authenticate(demo.token));
    assert.equal(world.authenticate(external.token).agent_id, user.agent_id);
    assert.deepEqual(world.agent(user.agent_id).run, run);
    assert.equal(world.agent(user.agent_id).group_id, null);
    assert.equal(world.agent(user.agent_id).owner_id, 'real-owner');
    assert.equal(world.state.game, null);
    assert.deepEqual(world.state.groups.unrelated.members, [user.agent_id]);
    assert.deepEqual(Object.keys(world.state.receipts), ['keep']);
    assert.equal(JSON.stringify(world.state).includes(platform.agent_id), false);
    assert.equal(world.state.events.some(event => event.payload.text === 'my message'), true);
    assert.deepEqual(removePlatformAgents(world), []);
    const backup = world.db.prepare('SELECT payload FROM world_migration_backups').all();
    assert.equal(backup.length, 1);
    assert.ok(JSON.parse(backup[0].payload).agents[platform.agent_id]);
  } finally { world.close(); }
});

test('persisted defaults and credentials are removed on upgrade and never respawn on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-migration-'));
  const dbPath = join(directory, 'world.sqlite');
  let app;
  try {
    const old = new World({ dbPath });
    const platform = old.createAgent({ name: '阿橘', is_platform: true });
    const user = old.createAgent({ name: '阿橘' });
    const demo = old.createController(platform.agent_id, { kind: 'demo' });
    writeFileSync(join(directory, 'demo-credentials.json'), JSON.stringify([demo]));
    old.close();
    for (let i = 0; i < 2; i++) {
      app = await createApp({ dbPath, frontend: false, demo: true });
      assert.deepEqual(app.world.ownerSnapshot().agents.map(agent => agent.agent_id), [user.agent_id]);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'demo-credentials.json'), 'utf8')), []);
      await app.close(); app = null;
    }
  } finally { if (app) await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
