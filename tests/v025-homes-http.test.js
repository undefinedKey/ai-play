import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';

test('v025 real HTTP/MCP: owned house assets, consent, physical visiting, public privacy and read-only camera data', { timeout: 60000 }, async t => {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 40, grass: 20, ore: 5, pine_cone: 2 } });
  t.after(f.close);
  const p = await f.actor('造屋人'), q = await f.actor('被邀请的朋友'), r = await f.actor('另一个居民');
  const first = await p.observe();
  assert.equal(first.homes.own_home, null); assert.deepEqual(f.app.world.state.homes, {});
  assert.ok((await p.client.listTools()).tools.find(x => x.name === 'act').inputSchema.properties.type.enum.includes('home'));
  const baseline = [p, q, r].map(a => ({ id: a.id, run_id: a.raw.run.run_id, max_calls: a.raw.run.max_calls, expires_at: a.raw.run.expires_at, appearance: structuredClone(a.raw.appearance) }));
  await p.act('move', { x: 10, y: 8 }); await f.until(() => !p.raw.movement);
  const built = await p.applied('home', { intent: 'build', name: '松果与旅途' }), homeId = `home_${p.id}`;
  assert.equal(p.raw.life.inventory.wood, 34); assert.equal(p.raw.life.inventory.grass, 18);
  assert.deepEqual(await p.send(built.req), built.receipt); assert.equal(p.raw.life.inventory.wood, 34);
  await p.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!p.raw.home_presence);
  assert.deepEqual(p.raw.position, { x: 9, y: 8 }); assert.equal(p.raw.home_presence.home_id, homeId);
  for (const [kind, x, y] of [['display_shelf', 1, 1], ['table', 5, 2], ['chair', 7, 3], ['rug', 2, 4]]) {
    await p.act('home', { intent: 'craft', kind });
    const item = (await p.observe()).homes.own_home.storage.find(i => i.kind === kind);
    await p.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
  }
  const shelf = (await p.observe()).homes.own_home.furniture.find(i => i.kind === 'display_shelf');
  const shown = await p.applied('home', { intent: 'display', instance_id: shelf.instance_id, item_id: 'pine_cone', title: '第一次旅途', text: '作为公开题注的数据。' });
  assert.equal(p.raw.life.inventory.pine_cone, 1); assert.deepEqual(await p.send(shown.req), shown.receipt); assert.equal(p.raw.life.inventory.pine_cone, 1);
  await p.act('home', { intent: 'craft', kind: 'chair' });
  const storedId = (await p.observe()).homes.own_home.storage[0].instance_id;
  await p.act('home', { intent: 'invite', target_agent_id: q.id });
  const invitation = (await q.observe()).homes.invitations[0]; assert.equal(invitation.home_id, homeId);
  assert.deepEqual((await r.observe()).homes.invitations, []);
  const outsider = await r.send(await r.request('home', { intent: 'visit', home_id: homeId })); assert.equal(outsider.status, 'rejected');
  await q.act('home', { intent: 'respond', invitation_id: invitation.invitation_id, accept: true });
  assert.equal(q.raw.home_presence ?? null, null, 'consent does not move the actor'); assert.equal(q.raw.home_travel ?? null, null);
  await q.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!q.raw.home_presence);
  assert.ok((await p.observe()).nearby_agents.some(a => a.agent_id === q.id));
  assert.ok(!(await r.observe()).nearby_agents.some(a => a.agent_id === p.id || a.agent_id === q.id));
  await q.act('home', { intent: 'message', text: '你的小屋很温暖，下次再来。' });
  await p.act('say', { channel: 'nearby', text: '欢迎回来。' });
  const publicHouse = f.app.world.publicSnapshot().homes.find(h => h.home_id === homeId); assert.equal(publicHouse.messages.length, 1);
  assert.equal(publicHouse.furniture.length, 4); assert.equal(publicHouse.storage, undefined);
  const readBaseline = JSON.stringify([p.raw.position, p.raw.home_presence, q.raw.position, q.raw.home_presence, f.app.world.state.homes]);
  for (const result of [await f.api('/api/public/world'), await f.api('/api/public/world?scene=adventure'), await f.api('/api/world', undefined, r.owner), await f.api('/api/world', undefined, f.admin)]) {
    assert.equal(result.status, 200);
    const json = JSON.stringify(result.body);
    for (const secret of [p.token, p.goal, q.token, q.goal, invitation.invitation_id, storedId]) assert.equal(json.includes(secret), false, secret.slice(0, 20));
    assert.equal(result.body.home_invitations, undefined);
  }
  assert.equal(JSON.stringify([p.raw.position, p.raw.home_presence, q.raw.position, q.raw.home_presence, f.app.world.state.homes]), readBaseline);
  await q.act('home', { intent: 'leave' }); assert.equal(q.raw.home_presence ?? null, null); assert.deepEqual(q.raw.position, { x: 9, y: 8 });
  const display = (await p.observe()).homes.own_home.displays[0];
  const withdrawn = await p.applied('home', { intent: 'withdraw', display_id: display.display_id });
  assert.equal(p.raw.life.inventory.pine_cone, 2); assert.deepEqual(await p.send(withdrawn.req), withdrawn.receipt); assert.equal(p.raw.life.inventory.pine_cone, 2);
  const saved = structuredClone(f.app.world.state.homes);
  await p.api(`/api/agents/${p.id}/control`, { operation: 'pause' }); assert.equal(p.raw.home_presence, null);
  assert.deepEqual(f.app.world.state.homes, saved, 'pause keeps house, furniture and visitor message');
  for (const a of [p, q, r]) { const b = baseline.find(b => b.id === a.id); assert.equal(a.raw.run.run_id, b.run_id); assert.equal(a.raw.run.max_calls, b.max_calls); assert.equal(a.raw.run.expires_at, b.expires_at); assert.deepEqual(a.raw.appearance, b.appearance); }
});
