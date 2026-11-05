import {PLAZA_SERVICES} from '../shared/plaza-layout.js';
import {walkHomesTo} from './helpers/plaza-walk.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';

async function fixture(t) {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 80, grass: 50, ore: 10, turnip: 4 } });
  t.after(f.close);
  const p = await f.actor('原居民'), q = await f.actor('来访读者');
  for (const a of [p, q]) {
    await a.act('move', { x: 23, y: 16 }); await f.until(() => !a.raw.movement);
  }
  return { ...f, p, q };
}

async function room(f) {
  const { p } = f;
  await p.act('home', { intent: 'build', name: '池畔小屋' });
  const homeId = `home_${p.id}`;
  await p.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!p.raw.home_presence);
  const furniture = {};
  for (const [kind, x, y] of [['table', 5, 2], ['chair', 2, 2], ['bookshelf', 0, 3]]) {
    await p.act('home', { intent: 'craft', kind });
    const item = (await p.observe()).homes.own_home.storage.find(i => i.kind === kind);
    furniture[kind] = item.instance_id;
    await p.act('home', { intent: 'place', instance_id: item.instance_id, x, y });
  }
  return { homeId, furniture };
}

test('v027 real HTTP/MCP fishing: crafted supplies, shore reservation, exact-once costs/catch and finite finish', { timeout: 60000 }, async t => {
  const f = await fixture(t), { p, q } = f;
  const grant = structuredClone(p.raw.run), appearance = structuredClone(p.raw.appearance);
  for (const a of [p,q]) await walkHomesTo(f,a,PLAZA_SERVICES.tools.interaction_position);
  for (const a of [p, q]) for (const item_id of ['fishing_rod', 'fish_bait', 'fish_bait']) await a.act('inventory', { intent: 'craft', item_id });
  const rules = await p.call('get_rules'); assert.equal(rules.fishing.version, 1);
  const spot = rules.fishing.spots[0];
  const choice = { intent: 'start', spot_id: spot.id, bait_id: 'fish_bait' };
  const before = { bait: p.raw.life.inventory.fish_bait, wear: p.raw.life.tools.fishing_rod.durability };
  await p.act('fish', choice);
  assert.equal(p.raw.fishing.phase, 'approaching'); assert.ok(p.raw.movement);
  assert.equal(p.raw.life.inventory.fish_bait, before.bait);
  await p.act('fish', { intent: 'cancel' });
  assert.equal(p.raw.fishing, null); assert.equal(p.raw.life.inventory.fish_bait, before.bait);
  const started = await p.applied('fish', choice);
  const rejected = await q.send(await q.request('fish', choice));
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error.code, 'FISHING_OCCUPIED');
  await f.until(() => p.raw.fishing?.phase === 'fishing');
  assert.deepEqual(p.raw.position, spot.interaction_position);
  assert.equal(p.raw.life.inventory.fish_bait, before.bait - 1);
  assert.equal(p.raw.life.tools.fishing_rod.durability, before.wear - 1);
  assert.deepEqual(await p.send(started.req), started.receipt);
  const ends = p.raw.fishing.ends_at;
  await p.act('wait'); assert.equal(p.raw.fishing.ends_at, ends);
  const snapshot = (await f.api('/api/public/world')).body;
  const publicActor = snapshot.agents.find(a => a.agent_id === p.id);
  assert.equal(publicActor.fishing.phase, 'fishing');
  for (const privateKey of ['run_id', 'session_epoch', 'hp_at_start', 'movement_id']) assert.equal(publicActor.fishing[privateKey], undefined);
  for (const secret of [p.token, q.token, p.goal, q.goal]) assert.equal(JSON.stringify(snapshot).includes(secret), false);
  await f.until(() => !p.raw.fishing);
  const count = () => (p.raw.life.inventory.pond_fish || 0) + (p.raw.life.inventory.silver_fish || 0);
  assert.equal(count(), 1); await f.advance(35000); assert.equal(count(), 1);
  assert.deepEqual(await p.send(started.req), started.receipt); assert.equal(count(), 1);
  assert.deepEqual(p.raw.run, grant); assert.deepEqual(p.raw.appearance, appearance);
  assert.equal(f.app.world.state.events.filter(e => e.type === 'fish_finished' && e.payload.agent_id === p.id).length, 1);
});

test('v027 real HTTP/MCP books: unpublished draft stays private, authentic signed work, shelf/read/comment consent', { timeout: 60000 }, async t => {
  const f = await fixture(t), { p, q } = f, { homeId, furniture } = await room(f);
  const draft = 'UNFINISHED_DRAFT_MUST_NOT_APPEAR_PUBLIC';
  const wood = p.raw.life.inventory.wood;
  await p.act('home', { intent: 'write_book', instance_id: furniture.table, title: '未完成', text: draft });
  assert.equal(p.raw.home_presence.activity.phase, 'approaching');
  assert.equal(p.raw.life.inventory.wood, wood);
  assert.equal(JSON.stringify((await f.api('/api/public/world')).body).includes(draft), false);
  await p.act('home', { intent: 'cancel' });
  assert.equal(p.raw.life.inventory.wood, wood);
  assert.deepEqual((await f.api('/api/public/world')).body.homes.find(h => h.home_id === homeId).books, []);
  const body = '<script>neverExecute()</script> 今天去池塘看了看。';
  const written = await p.applied('home', { intent: 'write_book', instance_id: furniture.table, title: '池边随笔', text: body });
  await f.until(() => p.raw.home_presence.activity?.phase === 'using');
  assert.equal(p.raw.life.inventory.wood, wood - 1);
  assert.equal(JSON.stringify((await f.api('/api/public/world')).body).includes(body), false);
  await f.until(() => !p.raw.home_presence.activity);
  assert.deepEqual(await p.send(written.req), written.receipt);
  const publicHome = (await f.api('/api/public/world')).body.homes.find(h => h.home_id === homeId);
  assert.equal(publicHome.books.length, 1);
  const book = publicHome.books[0];
  assert.equal(book.text, body); assert.equal(book.author_agent_id, p.id); assert.equal(book.author_name, p.raw.name);
  assert.equal(book.instance_id, null);
  await p.act('home', { intent: 'invite', target_agent_id: q.id });
  const invitation = (await q.observe()).homes.invitations[0];
  await q.act('home', { intent: 'respond', invitation_id: invitation.invitation_id, accept: true });
  await q.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!q.raw.home_presence);
  const unavailable = await q.send(await q.request('home', { intent: 'use', instance_id: furniture.chair, activity: 'read', book_id: book.book_id }));
  assert.equal(unavailable.status, 'rejected');
  await p.act('home', { intent: 'shelve_book', book_id: book.book_id, instance_id: furniture.bookshelf });
  await q.act('home', { intent: 'use', instance_id: furniture.chair, activity: 'read', book_id: book.book_id });
  await f.until(() => q.raw.home_presence.activity?.phase === 'using');
  assert.equal((await q.observe()).self.home_presence.activity.reading.text, body);
  await f.until(() => !q.raw.home_presence.activity);
  const comment = await q.applied('home', { intent: 'book_comment', book_id: book.book_id, text: '下次一起去看看。' });
  assert.deepEqual(await q.send(comment.req), comment.receipt);
  const published = (await f.api('/api/public/world')).body.homes.find(h => h.home_id === homeId).books[0];
  assert.equal(published.comments.length, 1); assert.equal(published.comments[0].author_agent_id, q.id);
  const malicious = await q.send(await q.request('home', { intent: 'unshelve_book', book_id: book.book_id }));
  assert.equal(malicious.status, 'rejected');
  const saved = structuredClone(f.app.world.state.homes);
  await p.api(`/api/agents/${p.id}/control`, { operation: 'pause' });
  assert.deepEqual(f.app.world.state.homes, saved);
  assert.equal(p.raw.home_presence, null); assert.equal(q.raw.home_presence, null);
});

test('v027 MCP strict action schema rejects fabricated catches and forged book author without mutation', { timeout: 60000 }, async t => {
  const f = await fixture(t), { p } = f;
  const baseline = structuredClone([p.raw.position, p.raw.life.inventory, f.app.world.state.homes]);
  for (const [type, payload] of [
    ['fish', { intent: 'start', spot_id: 'plaza_pond_south', bait_id: 'fish_bait', catch: 'silver_fish' }],
    ['fish', { intent: 'cancel', quantity: 9 }],
    ['home', { intent: 'write_book', instance_id: 'invalid', title: 'Book', text: 'body', author_agent_id: 'another-ai' }],
    ['home', { intent: 'book_comment', book_id: 'invalid', text: 'comment', author_name: 'Someone else' }],
  ]) {
    const result = await p.client.callTool({ name: 'act', arguments: await p.request(type, payload) });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.deepEqual([p.raw.position, p.raw.life.inventory, f.app.world.state.homes], baseline);
  }
});
