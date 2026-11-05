import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';

async function room(t) {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 60, grass: 30, ore: 10, turnip: 4 } });
  t.after(f.close);
  const p = await f.actor('原来的居民'), q = await f.actor('受邀的朋友');
  await p.act('move', { x: 23, y: 16 }); await f.until(() => !p.raw.movement);
  await p.act('home', { intent: 'build', name: '晚风小屋' });
  const homeId = `home_${p.id}`;
  await p.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!p.raw.home_presence);
  const furniture = {};
  for (const [kind, x, y] of [['chair', 2, 2], ['table', 5, 2], ['bed', 6, 4], ['bookshelf', 0, 3]]) {
    await p.act('home', { intent: 'craft', kind });
    const item = (await p.observe()).homes.own_home.storage.find(i => i.kind === kind);
    furniture[kind] = item.instance_id;
    await p.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
  }
  return { ...f, p, q, homeId, furniture };
}

test('v026 actual HTTP/MCP: arrival precedes eating, one food per explicit action, all four uses finish without choosing another', { timeout: 60000 }, async t => {
  const f = await room(t), { p, furniture } = f;
  const grant = structuredClone(p.raw.run), appearance = structuredClone(p.raw.appearance);
  const rules = await p.call('get_rules');
  assert.equal(rules.homes.use_version, 1);
  p.raw.survival.satiety = 40;
  const food = p.raw.life.inventory.turnip;
  const cancelled = await p.applied('home', { intent: 'use', instance_id: furniture.table, activity: 'eat', item_id: 'turnip' });
  assert.equal(p.raw.home_presence.activity.phase, 'approaching');
  assert.equal(p.raw.life.inventory.turnip, food);
  assert.deepEqual(await p.send(cancelled.req), cancelled.receipt);
  await p.act('home', { intent: 'cancel' });
  assert.equal(p.raw.life.inventory.turnip, food, 'cancelled travel does not consume food');
  const meal = await p.applied('home', { intent: 'use', instance_id: furniture.table, activity: 'eat', item_id: 'turnip' });
  await f.until(() => p.raw.home_presence.activity?.phase === 'using');
  assert.equal(p.raw.life.inventory.turnip, food - 1);
  const mealId = p.raw.home_presence.activity.activity_id, endsAt = p.raw.home_presence.activity.ends_at;
  assert.deepEqual(await p.send(meal.req), meal.receipt);
  await p.act('wait');
  assert.equal(p.raw.home_presence.activity.activity_id, mealId);
  assert.equal(p.raw.home_presence.activity.ends_at, endsAt, 'wait never renews the chosen use');
  await f.until(() => !p.raw.home_presence.activity);
  assert.equal(p.raw.life.inventory.turnip, food - 1);
  const positionAfterMeal = structuredClone(p.raw.home_presence.position);
  await f.advance(1000);
  assert.equal(p.raw.home_presence.activity, null);
  assert.deepEqual(p.raw.home_presence.position, positionAfterMeal);
  for (const [kind, activity] of [['chair', 'sit'], ['bookshelf', 'read'], ['bed', 'rest']]) {
    if (activity === 'rest') { p.raw.fatigue.energy = 15; p.raw.fatigue.updated_at = f.now(); }
    await p.act('home', { intent: 'use', instance_id: furniture[kind], activity });
    await f.until(() => p.raw.home_presence.activity?.phase === 'using');
    const actual = p.raw.home_presence.activity;
    assert.equal(actual.kind, activity);
    assert.deepEqual(p.raw.home_presence.position, actual.interaction_position);
    if (activity === 'read') {
      const reading = (await p.observe()).self.home_presence.activity.reading;
      assert.ok(reading?.title && reading.text);
    }
    await f.until(() => !p.raw.home_presence.activity);
    if (activity === 'rest') assert.ok(p.raw.fatigue.energy > 15);
  }
  assert.deepEqual(p.raw.run, grant);
  assert.deepEqual(p.raw.appearance, appearance);
  assert.equal(f.app.world.state.events.filter(e => e.type === 'life_consumed' && e.payload.agent_id === p.id).length, 1);
});

test('v026 HTTP privacy and furniture reservation: guest consent, real occupancy and readonly observer', { timeout: 60000 }, async t => {
  const f = await room(t), { p, q, furniture, homeId } = f;
  await p.act('home', { intent: 'invite', target_agent_id: q.id });
  const invitation = (await q.observe()).homes.invitations[0];
  await q.act('home', { intent: 'respond', invitation_id: invitation.invitation_id, accept: true });
  await q.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!q.raw.home_presence);
  await p.act('home', { intent: 'use', instance_id: furniture.chair, activity: 'sit' });
  const used = await q.send(await q.request('home', { intent: 'use', instance_id: furniture.chair, activity: 'sit' }));
  assert.equal(used.status, 'rejected'); assert.equal(used.error.code, 'HOME_USE_OCCUPIED');
  const before = structuredClone(f.app.world.state.homes);
  const moved = await p.send(await p.request('home', { intent: 'store', instance_id: furniture.chair }));
  assert.equal(moved.status, 'rejected'); assert.deepEqual(f.app.world.state.homes, before);
  await q.act('home', { intent: 'use', instance_id: furniture.bookshelf, activity: 'read' });
  await f.until(() => p.raw.home_presence.activity?.phase === 'using' && q.raw.home_presence.activity?.phase === 'using');
  assert.notDeepEqual(p.raw.home_presence.position, q.raw.home_presence.position);
  const stateBeforeRead = structuredClone([p.raw.home_presence, q.raw.home_presence, f.app.world.state.homes]);
  for (const path of ['/api/public/world', '/api/public/world?scene=plaza', '/api/public/world?scene=adventure']) {
    const response = await f.api(path); assert.equal(response.status, 200);
    const encoded = JSON.stringify(response.body);
    for (const secret of [p.token, q.token, p.goal, q.goal, invitation.invitation_id]) assert.equal(encoded.includes(secret), false);
    const self = response.body.agents.find(a => a.agent_id === p.id);
    assert.equal(self.home_presence.activity.kind, 'sit');
    assert.equal(self.home_presence.activity.movement_id, undefined);
    assert.equal(self.home_presence.activity.hp_at_start, undefined);
  }
  assert.deepEqual([p.raw.home_presence, q.raw.home_presence, f.app.world.state.homes], stateBeforeRead);
  await p.api(`/api/agents/${p.id}/control`, { operation: 'pause' });
  assert.equal(p.raw.home_presence, null); assert.equal(q.raw.home_presence, null);
  assert.deepEqual(f.app.world.state.homes, before);
});

test('v026 MCP rejects ambiguous furniture use fields before any movement or item changes', { timeout: 60000 }, async t => {
  const f = await room(t), { p, furniture } = f;
  const baseline = structuredClone([p.raw.home_presence, p.raw.life.inventory]);
  for (const payload of [
    { intent: 'use', instance_id: furniture.table, activity: 'eat' },
    { intent: 'use', instance_id: furniture.chair, activity: 'sit', item_id: 'turnip' },
    { intent: 'use', instance_id: furniture.chair, activity: 'sit', duration_seconds: 999999 },
    { intent: 'use', instance_id: furniture.chair, activity: 'sleep' },
  ]) {
    const request = await p.request('home', payload);
    const result = await p.client.callTool({ name: 'act', arguments: request });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.deepEqual([p.raw.home_presence, p.raw.life.inventory], baseline);
  }
});
