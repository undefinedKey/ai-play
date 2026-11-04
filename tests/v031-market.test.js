import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, WorldError } from '../server/world.js';
import { PEER_MARKET_RULES, initializePeerMarket, peerMarketObservation, performPeerMarket, publicPeerMarket } from '../server/peer-market.js';
import { publicEvent, spectatorSnapshot } from '../server/spectator.js';
import { isWalkable } from '../shared/world-layout.js';
import { findWorldPath, publicMovement } from '../server/spatial.js';
import { LIFE_RULES } from '../server/life.js';

const post = (give = { items: { wood: 2 } }, want = { items: { ore: 1 } }, extra = {}) => ({ intent: 'post', kind: 'exchange', give, want, ...extra });
const ref = offer => ({ offer_id: offer.offer_id, revision: offer.revision });
function fixture(t, count = 2, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options });
  if (!options.manualClose) t.after(() => world.close());
  const players = Array.from({ length: count }, (_, n) => {
    const id = world.createAgent({ name: `集市来客${n}`, bio: `原想法${n}`, owner_id: `owner${n}` }).agent_id, controller = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 10000, goal: `原主人要求${n}` });
    const auth = world.authenticate(controller.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wood: 10, ore: 10, wheat_bread: 3 });
    world.agent(id).adventure.gold = 100;
    return { id, auth, controller,
      get a() { return world.agent(id); },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      request(payload, type = 'peer_market') { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      act(payload, type) { return world.callTool(auth, 'act', this.request(payload, type)); },
      ok(payload, type) { const r = this.act(payload, type); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; },
      market() { this.a.scene_id = 'plaza'; this.a.position = { ...PEER_MARKET_RULES.place.interaction_position }; } };
  });
  const tick = (ms, heartbeat = true) => { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const offer = p => p.observe().peer_market.own_offer;
  return { world, players, tick, offer, now: () => now, time: ms => { now += ms; } };
}

test('v031 catalog is genuine transferable stock, sparse approach is continuous and arrival does not post', t => {
  const f = fixture(t, 1), [p] = f.players, rules = f.world.getRules().peer_market;
  assert.deepEqual(rules, PEER_MARKET_RULES);
  for (const item of rules.catalog) assert.equal(LIFE_RULES.items.find(i => i.id === item.id)?.name, item.name);
  assert.ok(isWalkable('plaza', rules.place.interaction_position));
  assert.ok(findWorldPath(f.world, 'plaza', p.a.position, rules.place.interaction_position));
  assert.equal(p.act(post()).error.code, 'NOT_AT_MARKET');
  const position = { ...p.a.position }, inv = structuredClone(p.a.life.inventory), goal = p.a.goal;
  p.ok({ intent: 'approach', mode: 'run' }); assert.deepEqual(p.a.position, position); assert.equal(publicMovement(p.a, f.world).mode, 'run');
  const end = p.a.movement.ends_at;
  f.tick(100); assert.notDeepEqual(p.a.position, position); assert.notDeepEqual(p.a.position, rules.place.interaction_position);
  f.tick(end - f.now()); assert.equal(p.a.movement, null); assert.deepEqual(p.a.position, rules.place.interaction_position);
  assert.deepEqual(p.a.life.inventory, inv); assert.equal(p.a.goal, goal); assert.equal(f.offer(p), null); assert.equal(publicPeerMarket(f.world).offers.length, 0);
});

test('v031 explicit exchange escrows once, waits, atomically settles exactly once, keeps original identity and intentions', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  const identity = f.players.map(a => ({ id: a.id, goal: a.a.goal, bio: a.a.bio, appearance: structuredClone(a.a.appearance), run: structuredClone(a.a.run) }));
  const request = p.request(post()), result = f.world.callTool(p.auth, 'act', request); assert.equal(result.status, 'applied');
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), result); assert.equal(p.a.life.inventory.wood, 8); assert.equal(q.a.life.inventory.wood, 10);
  const offer = f.offer(p); f.tick(20000); assert.equal(f.offer(p).status, 'open'); assert.equal(q.a.life.inventory.ore, 10);
  const accept = q.request({ intent: 'accept', ...ref(offer) }); const receipt = f.world.callTool(q.auth, 'act', accept); assert.equal(receipt.status, 'applied');
  assert.deepEqual(f.world.callTool(q.auth, 'act', accept), receipt);
  assert.deepEqual([p.a.life.inventory.wood, p.a.life.inventory.ore, q.a.life.inventory.wood, q.a.life.inventory.ore], [8, 11, 12, 9]);
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'MARKET_UNAVAILABLE');
  assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'peer_market_escrow').length, 1);
  assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'peer_market_received').length, 1);
  assert.equal(q.a.life.ledger.entries.filter(e => e.reason === 'peer_market_accepted').length, 1);
  assert.deepEqual(f.players.map(a => ({ id: a.id, goal: a.a.goal, bio: a.a.bio, appearance: a.a.appearance, run: a.a.run })), identity);
  assert.equal(publicPeerMarket(f.world).offers[0].taker_agent_id, q.id);
});

test('v031 seller may leave while online; buyer must physically reach market and pay the exact price', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); p.ok(post({ items: { wheat_bread: 1 } }, { gold: 37 })); const offer = f.offer(p);
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'NOT_AT_MARKET');
  p.a.position = { x: 11, y: 8 }; p.a.scene_id = 'adventure'; p.a.adventure.in_field = true;
  q.market(); q.a.adventure.gold = 36;
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INSUFFICIENT_GOLD'); assert.equal(p.a.adventure.gold, 100);
  q.a.adventure.gold = 37; q.ok({ intent: 'accept', ...ref(offer) });
  assert.deepEqual([p.a.adventure.gold, q.a.adventure.gold, q.a.life.inventory.wheat_bread], [137, 0, 4]); assert.equal(p.a.scene_id, 'adventure');
});

test('v031 request is an AI-authored exact delivery contract, not an assigned task or free generated reward', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  p.ok(post({ items: { wheat_bread: 2 }, gold: 7 }, { items: { ore: 3, grass: 2 } }, { kind: 'request', title: '矿石和干草换两份面包' })); const offer = f.offer(p);
  assert.equal(p.a.life.inventory.wheat_bread, 1); assert.equal(p.a.adventure.gold, 93);
  const before = structuredClone({ goal: q.a.goal, personal_goal: q.a.personal_goal, plan: q.a.adventure.plan });
  q.a.life.inventory.grass = 1; assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INSUFFICIENT_ITEMS');
  assert.deepEqual({ goal: q.a.goal, personal_goal: q.a.personal_goal, plan: q.a.adventure.plan }, before); assert.equal(q.a.life.inventory.ore, 10);
  q.a.life.inventory.grass = 2; q.ok({ intent: 'accept', ...ref(offer) });
  assert.deepEqual([p.a.life.inventory.ore, p.a.life.inventory.grass, q.a.life.inventory.ore, q.a.life.inventory.grass, q.a.life.inventory.wheat_bread, q.a.adventure.gold], [13, 2, 7, 0, 5, 107]);
});

test('v031 a gift needs the selected recipient, may be declined from any scene and never demands reciprocation', t => {
  const f = fixture(t, 3), [p, q, other] = f.players; p.market(); q.market(); other.market();
  p.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { items: { wheat_bread: 1 } }, title: '一份面包' }); const offer = f.offer(p);
  assert.equal(other.act({ intent: 'accept', ...ref(offer) }).error.code, 'NOT_AUTHORIZED');
  assert.ok(!other.observe().peer_market.opportunities.some(o => o.payload.intent === 'accept'));
  assert.equal(q.a.life.inventory.wheat_bread, 3);
  q.a.scene_id = 'ruins'; q.a.position = { x: 6, y: 25 }; q.a.ruins_job = { phase: 'approaching', expires_at: f.now() + 10000 };
  q.ok({ intent: 'decline', ...ref(offer) });
  assert.equal(p.a.life.inventory.wheat_bread, 3); assert.equal(q.a.life.inventory.wheat_bread, 3); assert.equal(publicPeerMarket(f.world).offers[0].status, 'declined');
  q.a.ruins_job = null; q.market(); p.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { gold: 5 } });
  q.ok({ intent: 'accept', ...ref(f.offer(p)) }); assert.deepEqual([p.a.adventure.gold, q.a.adventure.gold], [95, 105]);
});

test('v031 immutable revision and idempotency block changed terms, self-accept and duplicate winners', t => {
  const f = fixture(t, 3), [p, q, r] = f.players; f.players.forEach(a => a.market());
  const req = p.request(post()), receipt = f.world.callTool(p.auth, 'act', req), offer = f.offer(p);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...req, payload: post({ items: { wood: 3 } }) }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(p.act({ intent: 'accept', ...ref(offer) }).error.code, 'NOT_AUTHORIZED');
  assert.equal(q.act({ intent: 'accept', ...ref(offer), revision: 2 }).error.code, 'MARKET_STALE');
  assert.equal(p.act({ intent: 'cancel', ...ref(offer), revision: 0 }).error.code, 'MARKET_STALE');
  assert.equal(q.act({ intent: 'accept', ...ref(offer), want: { gold: 0 } }).error.code, 'INVALID_ACTION');
  const qr = q.request({ intent: 'accept', ...ref(offer) }), rr = r.request({ intent: 'accept', ...ref(offer) });
  assert.equal(f.world.callTool(q.auth, 'act', qr).status, 'applied'); assert.equal(f.world.callTool(r.auth, 'act', rr).error.code, 'MARKET_UNAVAILABLE');
  assert.equal(r.a.life.inventory.wood, 10); assert.equal(r.a.life.inventory.ore, 10); assert.equal(receipt.offer_id, offer.offer_id);
});

test('v031 invalid or stateful assets and malformed terms never reserve or remove stock', t => {
  const f = fixture(t), [p, q] = f.players; p.market();
  const baseline = structuredClone({ inventory: p.a.life.inventory, gold: p.a.adventure.gold });
  const invalid = [post({ items: { wood: 0 } }), post({ items: { wood: 1.5 } }), post({ items: { wood: 100 } }), post({ gold: 10001 }), post({ items: { axe: 1 } }),
    post({ items: { ruins_bronze_key: 1 } }), post({ items: { torch: 1 } }), post({ items: { ruins_star_lens: 2 } }), post({}, { gold: 1 }), post({ gold: 1 }, {}),
    post({ items: { wood: 1 } }, { items: { wood: 1 } }), post({ gold: 1 }, { gold: 2 }), post(undefined, undefined, { duration_seconds: 59 }), post(undefined, undefined, { title: ' ' }),
    post({ items: { wood: 1, ore: 1, grass: 1, berry: 1, wheat: 1 } }), post(undefined, undefined, { target_agent_id: q.id }),
    { intent: 'post', kind: 'gift', target_agent_id: q.id, give: { gold: 1 }, want: {} }];
  for (const payload of invalid) { assert.equal(p.act(payload).error.code, 'INVALID_ACTION', JSON.stringify(payload)); assert.deepEqual({ inventory: p.a.life.inventory, gold: p.a.adventure.gold }, baseline); }
  assert.equal(p.act({ intent: 'post', kind: 'gift', target_agent_id: p.id, give: { gold: 1 } }).error.code, 'MARKET_TARGET');
  assert.equal(publicPeerMarket(f.world).offers.length, 0);
});

for (const cause of ['cancel', 'expiry', 'owner_pause', 'target_pause', 'lease', 'run', 'revoke', 'room']) test(`v031 ${cause} ends unaccepted escrow and returns it exactly once`, t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  p.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { items: { wood: 3 }, gold: 7 }, duration_seconds: 60 }); const offer = f.offer(p);
  if (cause === 'cancel') p.ok({ intent: 'cancel', ...ref(offer) });
  else if (cause === 'owner_pause') f.world.pause(p.a, 'test');
  else if (cause === 'target_pause') f.world.pause(q.a, 'test');
  else if (cause === 'lease') f.tick(45000, false);
  else if (cause === 'expiry') f.tick(60000);
  else if (cause === 'run') { p.a.run.expires_at = f.now() + 1; f.tick(1); }
  else if (cause === 'revoke') { f.world.state.controllers[p.controller.controller_id].revoked = true; f.tick(1); }
  else { f.world.ownerRoom('pause'); }
  f.tick(1000); assert.deepEqual([p.a.life.inventory.wood, p.a.adventure.gold, q.a.life.inventory.wood, q.a.adventure.gold], [10, 100, 10, 100]);
  assert.equal(p.a.life.ledger.entries.filter(e => e.source_id === `peer_market:${offer.offer_id}:return`).length, 1);
  assert.notEqual(publicPeerMarket(f.world).offers[0].status, 'open');
});

test('v031 settlement preflights both capacities before mutation, overflow return stays private until explicitly collected', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market(); p.ok(post()); const offer = f.offer(p);
  q.a.life.inventory.wood = Number.MAX_SAFE_INTEGER;
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INVENTORY_FULL'); assert.equal(q.a.life.inventory.ore, 10); assert.equal(p.a.life.inventory.ore, 10);
  q.a.life.inventory.wood = 10; p.a.life.inventory.ore = Number.MAX_SAFE_INTEGER;
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INVENTORY_FULL'); assert.equal(q.a.life.inventory.ore, 10);
  p.a.life.inventory.wood = Number.MAX_SAFE_INTEGER; p.ok({ intent: 'cancel', ...ref(offer) });
  assert.deepEqual(p.a.peer_market_return, { offer_id: offer.offer_id, assets: { items: { wood: 2 }, gold: 0 } });
  assert.equal(JSON.stringify(spectatorSnapshot(f.world)).includes('peer_market_return'), false);
  assert.equal(q.observe().peer_market.pending_return, null);
  assert.equal(p.act(post()).error.code, 'MARKET_RETURN_PENDING'); assert.equal(q.act({ intent: 'claim_return', offer_id: offer.offer_id }).error.code, 'MARKET_RETURN');
  assert.equal(p.act({ intent: 'claim_return', offer_id: offer.offer_id }).error.code, 'INVENTORY_FULL');
  p.a.life.inventory.wood = 0; p.ok({ intent: 'claim_return', offer_id: offer.offer_id }); assert.equal(p.a.life.inventory.wood, 2); assert.equal(p.a.peer_market_return, null);
  assert.equal(p.act({ intent: 'claim_return', offer_id: offer.offer_id }).error.code, 'MARKET_RETURN');
});

test('v031 stale owner lease rejects immediate settlement even before a world tick can refund', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market(); p.ok(post()); const offer = f.offer(p); f.time(45000); q.a.last_contact_at = f.now();
  assert.throws(() => performPeerMarket(f.world, q.a, { intent: 'accept', ...ref(offer) }, (code, message) => { throw new WorldError(code, message); }, 'test'), { code: 'MARKET_UNAVAILABLE' });
  assert.equal(q.a.life.inventory.ore, 10); assert.equal(p.a.life.inventory.wood, 8); f.world.tick(); assert.equal(p.a.life.inventory.wood, 10);
});

test('v031 incoming gifts and own posts have finite capacity; all other play remains available', t => {
  const f = fixture(t, 4), [p, q, r, s] = f.players; f.players.forEach(a => a.market());
  p.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { gold: 1 } });
  assert.equal(p.act(post()).error.code, 'MARKET_LIMIT');
  r.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { gold: 1 } });
  assert.equal(s.act({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { gold: 1 } }).error.code, 'MARKET_LIMIT');
  p.ok({ intent: 'wait' }, 'wait'); p.ok({ intent: 'browse', page: 0 });
  p.ok({ x: 27, y: 18 }, 'move'); assert.ok(p.a.movement); assert.equal(f.offer(p).status, 'open');
  p.ok({ intent: 'cancel', ...ref(f.offer(p)) }); assert.ok(p.a.movement);
});

test('v031 explicit page selection exposes all 20 offers without ranking or accepting unseen terms', t => {
  const f = fixture(t, 1), [p] = f.players; p.market();
  // The generic market contract is bounded at 20 even if a future room admits
  // more residents. Isolated persisted fixtures exercise that bound directly.
  const template = p.ok(post()).offer_id, record = structuredClone(f.world.state.peer_market.offers[template]);
  p.ok({ intent: 'cancel', offer_id: template, revision: 1 });
  for (let n = 0; n < 20; n++) {
    const id = `agent_fixture_${n}`, agent = structuredClone(p.a); agent.agent_id = id; agent.run.run_id = `run_${n}`;
    f.world.state.agents[id] = agent;
    f.world.state.peer_market.offers[`offer_fixture_${String(n).padStart(2, '0')}`] = { ...structuredClone(record), offer_id: `offer_fixture_${String(n).padStart(2, '0')}`, owner_agent_id: id, created_at: record.created_at + n,
      owner_binding: { run_id: agent.run.run_id, session_epoch: agent.session_epoch } };
  }
  let o = peerMarketObservation(f.world, p.a); assert.equal(o.total_open, 20); assert.equal(o.total_pages, 10); assert.equal(o.offers.length, 2);
  assert.deepEqual(o.offers.map(o => o.offer_id), ['offer_fixture_00', 'offer_fixture_01']);
  assert.equal(o.opportunities.filter(o => o.payload.intent === 'accept').length, 2);
  p.ok({ intent: 'browse', page: 9 }); o = peerMarketObservation(f.world, p.a);
  assert.equal(o.page, 9); assert.deepEqual(o.offers.map(o => o.offer_id), ['offer_fixture_18', 'offer_fixture_19']);
  assert.equal(p.act({ intent: 'browse', page: 10 }).error.code, 'MARKET_PAGE');
  assert.equal(publicPeerMarket(f.world).offers.filter(o => o.status === 'open').length, 20);
  for (let n = 2; n < 20; n++) delete f.world.state.peer_market.offers[`offer_fixture_${String(n).padStart(2, '0')}`];
  assert.equal(peerMarketObservation(f.world, p.a).page, 0); assert.equal(p.a.peer_market_page, 9);
});

test('v031 public offers and events disclose only deliberate terms, including immutable original relic finder', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  p.a.life.inventory.ruins_leaf_medallion = 1; f.world.state.ruins.claims.relic_leaf = { agent_id: p.id, at: f.now() - 1000 };
  p.ok({ intent: 'post', kind: 'gift', target_agent_id: q.id, give: { items: { ruins_leaf_medallion: 1 } } }); const offer = f.offer(p);
  assert.deepEqual(offer.provenance, [{ item_id: 'ruins_leaf_medallion', found_by_agent_id: p.id, found_at: f.now() - 1000 }]);
  const raw = f.world.state.peer_market.offers[offer.offer_id]; raw.secret_goal = 'SECRET'; raw.give.secret = 'SECRET'; raw.provenance[0].secret = 'SECRET';
  const projection = publicPeerMarket(f.world), json = JSON.stringify(projection);
  assert.ok(!json.includes('SECRET')); assert.ok(!json.includes('owner_binding')); assert.ok(!json.includes('escrow')); assert.ok(!json.includes('run_'));
  delete raw.secret_goal; delete raw.give.secret; delete raw.provenance[0].secret;
  q.ok({ intent: 'accept', ...ref(offer) }); assert.deepEqual(f.world.state.ruins.claims.relic_leaf, { agent_id: p.id, at: f.now() - 1000 });
  assert.deepEqual([p.a.life.inventory.ruins_leaf_medallion, q.a.life.inventory.ruins_leaf_medallion], [0, 1]);
  const event = f.world.state.events.filter(e => e.type === 'peer_market_changed').at(-1), safe = publicEvent(event, new Set([p.id, q.id]));
  assert.equal(safe.payload.offer.taker_agent_id, q.id); assert.equal(safe.payload.scene_id, 'plaza'); assert.equal(safe.payload.offer.provenance[0].found_by_agent_id, p.id);
});

test('v031 restart returns escrow once, preserves pending claims, closed history and original actor data', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'world.sqlite'), f = fixture(t, 2, { dbPath, manualClose: true }), [p, q] = f.players; p.market(); q.market();
  p.ok(post({ items: { wood: 2 }, gold: 3 }, { items: { ore: 1 } })); const id = f.offer(p).offer_id;
  q.ok(post({ items: { ore: 2 } }, { items: { wood: 1 } })); q.a.life.inventory.ore = Number.MAX_SAFE_INTEGER;
  const identity = { id: p.id, goal: p.a.goal, bio: p.a.bio, appearance: structuredClone(p.a.appearance), run: structuredClone(p.a.run) }; p.a.peer_market_page = 4; f.world.close();
  const current = new World({ dbPath, now: f.now, actionIntervalMs: 0 });
  assert.deepEqual([current.agent(p.id).life.inventory.wood, current.agent(p.id).adventure.gold], [10, 100]);
  assert.equal(current.state.peer_market.offers[id].end_reason, 'restarted'); assert.ok(current.agent(q.id).peer_market_return);
  assert.deepEqual({ id: p.id, goal: current.agent(p.id).goal, bio: current.agent(p.id).bio, appearance: current.agent(p.id).appearance, run: current.agent(p.id).run }, identity);
  assert.equal(current.agent(p.id).peer_market_page, 4); const total = current.agent(p.id).life.ledger.total_entries; current.close();
  const again = new World({ dbPath, now: f.now }); assert.equal(again.agent(p.id).life.ledger.total_entries, total); assert.ok(again.agent(q.id).peer_market_return); again.close();
});

test('v031 malformed persisted escrow fails closed instead of minting, discarding or normalizing it', t => {
  const f = fixture(t, 1), [p] = f.players; p.market(); p.ok(post());
  const baseline = structuredClone(f.world.state), offer = Object.values(f.world.state.peer_market.offers)[0];
  offer.escrow.items.wood = 3;
  assert.throws(() => initializePeerMarket(f.world, { restore: true }), /escrow/); assert.equal(p.a.life.inventory.wood, 8);
  f.world.state = baseline; const record = Object.values(f.world.state.peer_market.offers)[0]; record.owner_binding.session_epoch = -1;
  assert.throws(() => initializePeerMarket(f.world, { restore: true }), /persisted/); assert.equal(p.a.life.inventory.wood, 8);
});

test('v031 request for an undiscovered relic records its real subsequent finder on delivery', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  p.ok(post({ gold: 17 }, { items: { ruins_stone_bird: 1 } }, { kind: 'request' })); const offer = f.offer(p); assert.deepEqual(offer.provenance, []);
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INSUFFICIENT_ITEMS');
  q.a.life.inventory.ruins_stone_bird = 1; f.world.state.ruins.claims.relic_bird = { agent_id: q.id, at: f.now() };
  q.ok({ intent: 'accept', ...ref(offer) }); const delivered = publicPeerMarket(f.world).offers[0];
  assert.deepEqual(delivered.give, offer.give); assert.deepEqual(delivered.want, offer.want);
  assert.deepEqual(delivered.provenance, [{ item_id: 'ruins_stone_bird', found_by_agent_id: q.id, found_at: f.now() }]);
  assert.deepEqual([p.a.life.inventory.ruins_stone_bird, q.a.life.inventory.ruins_stone_bird, q.a.adventure.gold], [1, 0, 117]);
});

test('v031 gold overflow blocks settlement and preserves a bounded refundable bundle', t => {
  const f = fixture(t), [p, q] = f.players; p.market(); q.market();
  p.ok(post({ gold: 5 }, { items: { ore: 1 } })); const offer = f.offer(p);
  q.a.adventure.gold = Number.MAX_SAFE_INTEGER;
  assert.equal(q.act({ intent: 'accept', ...ref(offer) }).error.code, 'INVENTORY_FULL'); assert.equal(q.a.life.inventory.ore, 10);
  p.a.adventure.gold = Number.MAX_SAFE_INTEGER; p.ok({ intent: 'cancel', ...ref(offer) });
  assert.deepEqual(p.a.peer_market_return.assets, { items: {}, gold: 5 }); assert.equal(p.a.adventure.gold, Number.MAX_SAFE_INTEGER);
  p.a.adventure.gold -= 5; p.ok({ intent: 'claim_return', offer_id: offer.offer_id }); assert.equal(p.a.adventure.gold, Number.MAX_SAFE_INTEGER);
  assert.equal(p.a.peer_market_return, null);
});
