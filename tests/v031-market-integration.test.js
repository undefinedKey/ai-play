import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';
import { RUINS_RULES } from '../shared/ruins-layout.js';

const ref = offer => ({ offer_id: offer.offer_id, revision: offer.revision });
const go = async (f, p) => { await p.act('peer_market', { intent: 'approach' }); await f.until(() => !p.raw.movement); };
const own = async p => (await p.observe()).peer_market.own_offer;

test('v031 real MCP food exchange and delivery commission require explicit original choices; repeated concurrent acceptance settles exactly once', { timeout: 60000 }, async t => {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 12, grass: 4, ore: 4, wheat: 6 } }); t.after(f.close);
  const p = await f.actor('做面包的来客'), q = await f.actor('自愿交矿的人'), r = await f.actor('另一个来客');
  const identity = [p, q, r].map(a => ({ id: a.id, goal: a.raw.goal, run: structuredClone(a.raw.run), appearance: structuredClone(a.raw.appearance) }));
  await p.act('move', { x: 10, y: 8 }); await f.until(() => !p.raw.movement);
  await p.act('inventory', { intent: 'craft', item_id: 'wheat_bread' });
  const bread = p.raw.life.inventory.wheat_bread;
  await go(f, p);
  assert.equal((await own(p)), null, 'walking to the stall is not consent to a transaction');
  await p.act('peer_market', { intent: 'post', kind: 'request', title: '一份面包换两份矿石', give: { items: { wheat_bread: 1 } }, want: { items: { ore: 2 } } });
  const offer = await own(p); assert.equal(p.raw.life.inventory.wheat_bread, bread - 1);
  assert.equal(q.raw.life.inventory.ore, 4, 'reading a commission does not spend or assign a task');
  await p.act('move', { x: 27, y: 18 }); await f.until(() => !p.raw.movement);
  await go(f, q); await go(f, r);
  const before = [p, q, r].map(a => ({ ore: a.raw.life.inventory.ore, bread: a.raw.life.inventory.wheat_bread || 0 }));
  const requests = await Promise.all([q.request('peer_market', { intent: 'accept', ...ref(offer) }), r.request('peer_market', { intent: 'accept', ...ref(offer) })]);
  const receipts = await Promise.all([q.send(requests[0]), r.send(requests[1])]);
  assert.deepEqual(receipts.map(x => x.status).sort(), ['applied', 'rejected']);
  const winner = receipts[0].status === 'applied' ? q : r, loser = winner === q ? r : q;
  const winnerIndex = winner === q ? 1 : 2, loserIndex = loser === q ? 1 : 2;
  assert.equal(p.raw.life.inventory.ore, before[0].ore + 2);
  assert.equal(winner.raw.life.inventory.ore, before[winnerIndex].ore - 2);
  assert.equal(winner.raw.life.inventory.wheat_bread, before[winnerIndex].bread + 1);
  assert.equal(loser.raw.life.inventory.ore, before[loserIndex].ore);
  assert.deepEqual(await winner.send(requests[winnerIndex - 1]), receipts[winnerIndex - 1]);
  assert.equal(winner.raw.life.inventory.wheat_bread, before[winnerIndex].bread + 1);
  const rows = winner.raw.life.ledger.entries.filter(e => e.source_id === requests[winnerIndex - 1].action_id);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].items, { ore: -2, wheat_bread: 1 });
  const publicWorld = (await f.api('/api/public/world')).body;
  assert.equal(publicWorld.peer_market.offers.find(o => o.offer_id === offer.offer_id).status, 'settled');
  const history = f.app.world.state.history.entries.filter(e => e.type === 'peer_market_changed' && e.details.offer.offer_id === offer.offer_id);
  assert.equal(history.length, 1); assert.equal(history[0].outcome, 'completed');
  assert.deepEqual(history[0].actors.map(a => a.agent_id).sort(), [p.id, winner.id].sort());
  for (const a of [p, q, r]) {
    const saved = identity.find(i => i.id === a.id); assert.equal(a.raw.goal, saved.goal); assert.deepEqual(a.raw.run, saved.run); assert.deepEqual(a.raw.appearance, saved.appearance);
    for (const secret of [a.goal, a.token, a.raw.run.run_id]) assert.equal(JSON.stringify(publicWorld).includes(secret), false);
  }
});

test('v031 a genuinely claimed relic can be explicitly gifted and then displayed by its new owner, without rewriting finder or auto-decorating', { timeout: 60000 }, async t => {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 30, grass: 12, ore: 5 } }); t.after(f.close);
  const p = await f.actor('遗物发现者'), q = await f.actor('自己选择收藏的人'), r = await f.actor('不相关的人');
  await q.act('move', { x: 10, y: 8 }); await f.until(() => !q.raw.movement);
  await q.act('home', { intent: 'build', name: '我的陈列小屋' });
  const homeId = `home_${q.id}`;
  await q.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!q.raw.home_presence);
  await q.act('home', { intent: 'craft', kind: 'display_shelf' });
  const shelf = (await q.observe()).homes.own_home.storage.find(x => x.kind === 'display_shelf').instance_id;
  await q.act('home', { intent: 'place', instance_id: shelf, x: 1, y: 4 });
  await q.act('home', { intent: 'leave' }); await f.until(() => !q.raw.home_presence && !q.raw.home_travel);
  // Isolated setup places the explorer inside an already reached room; ownership
  // must still be obtained by the real authenticated claim operation.
  const relic = RUINS_RULES.relics.find(x => x.item_id === 'ruins_leaf_medallion');
  p.raw.scene_id = 'ruins'; p.raw.position = { ...relic.interaction_position };
  await p.act('ruins', { intent: 'claim', object_id: relic.id });
  const provenance = structuredClone(f.app.world.state.ruins.claims[relic.id]);
  p.raw.scene_id = 'plaza'; p.raw.position = { x: 11, y: 8 }; p.raw.adventure.in_field = false;
  await go(f, p);
  await p.act('peer_market', { intent: 'post', kind: 'gift', target_agent_id: q.id, give: { items: { [relic.item_id]: 1 } } });
  let offer = await own(p);
  assert.equal(p.raw.life.inventory[relic.item_id], 0);
  assert.equal(q.raw.life.inventory[relic.item_id] || 0, 0);
  const outsider = await r.send(await r.request('peer_market', { intent: 'decline', ...ref(offer) })); assert.equal(outsider.status, 'rejected');
  await q.act('peer_market', { intent: 'decline', ...ref(offer) });
  assert.equal(p.raw.life.inventory[relic.item_id], 1);
  await p.act('peer_market', { intent: 'post', kind: 'gift', target_agent_id: q.id, give: { items: { [relic.item_id]: 1 } } }); offer = await own(p);
  await go(f, q); assert.equal(q.raw.life.inventory[relic.item_id] || 0, 0);
  await q.act('peer_market', { intent: 'accept', ...ref(offer) });
  assert.equal(q.raw.life.inventory[relic.item_id], 1); assert.equal(p.raw.life.inventory[relic.item_id], 0);
  assert.deepEqual(f.app.world.state.ruins.claims[relic.id], provenance);
  assert.deepEqual(f.app.world.state.homes[homeId].displays, [], 'receiving does not choose a display');
  await q.act('home', { intent: 'visit', home_id: homeId }); await f.until(() => !!q.raw.home_presence);
  await q.act('home', { intent: 'display', instance_id: shelf, item_id: relic.item_id, title: '我接受的礼物', text: '这是我自己选择展示的纪念品。' });
  assert.equal(q.raw.life.inventory[relic.item_id], 0);
  const displayed = f.app.world.state.homes[homeId].displays.find(x => x.item_id === relic.item_id); assert.ok(displayed);
  assert.deepEqual(f.app.world.state.ruins.claims[relic.id], provenance);
  const state = JSON.stringify([p.raw.position, q.raw.home_presence, f.app.world.state.peer_market, f.app.world.state.homes]);
  for (const scene of ['plaza', 'adventure', 'ruins']) assert.equal((await f.api(`/api/public/world?scene=${scene}`)).status, 200);
  assert.equal(JSON.stringify([p.raw.position, q.raw.home_presence, f.app.world.state.peer_market, f.app.world.state.homes]), state, 'observer scene reads cannot move or trade for residents');
});
