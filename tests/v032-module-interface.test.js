import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { World } from '../server/world.js';
import { COMMUNITY_RULES } from '../shared/community.js';
import { PEER_MARKET_RULES } from '../shared/peer-market.js';

function fixture(t, { dbPath = ':memory:', count = 1, cleanupDirectory = null } = {}) {
  let now = 2000000000000;
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  t.after(() => {
    world.close();
    if (cleanupDirectory) {
      const target = resolve(cleanupDirectory);
      assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('v032-modules-'));
      rmSync(target, { recursive: true, force: true });
    }
  });
  const players = Array.from({ length: count }, (_, index) => {
    const id = world.createAgent({ name: `边界来客${index}`, bio: '本人的原想法', owner_id: `module-owner-${index}` }).agent_id;
    const ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: null, goal: `原主人的要求${index}` });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wood: 8, wheat_bread: 3 });
    return { id, auth,
      get a() { return world.agent(id); },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      request(type, payload) { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      send(request) { return world.callTool(auth, 'act', request); },
      act(type, payload) { return this.send(this.request(type, payload)); },
      ok(type, payload) { const result = this.act(type, payload); assert.equal(result.status, 'applied', JSON.stringify(result)); return result; },
    };
  });
  return { players, get world() { return world; }, now: () => now,
    advance(ms, { fine = false, heartbeat = true } = {}) {
      const end = now + ms;
      do {
        now = fine ? Math.min(end, now + 100) : end;
        if (heartbeat) for (const player of players) if (player.a.status === 'active') player.a.last_contact_at = now;
        world.tick();
      } while (now < end);
    },
    restart() { world.close(); world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); },
  };
}
const picnic = COMMUNITY_RULES.venues.find(venue => venue.id === 'picnic');
const seat = picnic.seats.find(slot => slot.activities.includes('eat'));
const ownMeal = { intent: 'use', seat_id: seat.id, activity: 'eat', item_id: 'wheat_bread', duration_seconds: 20 };

test('v032 both real modules expose rules, actions and projections through authenticated World API without granting stock or intentions', t => {
  const f = fixture(t), [p] = f.players;
  const before = structuredClone({ inventory: p.a.life.inventory, goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance, run: p.a.run });
  const rules = f.world.callTool(p.auth, 'get_rules');
  assert.deepEqual(rules.community, COMMUNITY_RULES); assert.deepEqual(rules.peer_market, PEER_MARKET_RULES);
  assert.equal(rules.max_capabilities, 16);
  assert.equal(rules.allowed_actions.filter(action => action === 'community').length, 1);
  assert.equal(rules.allowed_actions.filter(action => action === 'peer_market').length, 1);
  for (const type of ['community', 'peer_market']) p.ok(type, { intent: 'browse', page: 0 });
  const observation = p.observe(), publicWorld = f.world.publicSnapshot();
  assert.ok(observation.community); assert.ok(observation.peer_market);
  assert.ok(publicWorld.community); assert.ok(publicWorld.peer_market);
  assert.equal(observation.self.community_job, null);
  assert.deepEqual({ inventory: p.a.life.inventory, goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance, run: p.a.run }, before);
});

test('v032 delayed World tick settles physical arrival and own-food debit once, matching fine ticks without granting extra food or a new plan', t => {
  const results = [];
  for (const fine of [false, true]) {
    const f = fixture(t), [p] = f.players;
    p.a.survival.satiety = 30;
    const position = { ...p.a.position }, request = p.request('community', ownMeal), receipt = p.send(request);
    assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
    assert.deepEqual(p.a.position, position); assert.equal(p.a.life.inventory.wheat_bread, 3);
    assert.equal(p.a.community_job.phase, 'approaching');
    assert.deepEqual(p.send(request), receipt); assert.equal(p.a.life.inventory.wheat_bread, 3);
    f.advance(35000, { fine });
    assert.deepEqual(p.a.position, seat.position); assert.equal(p.a.community_job, null);
    assert.equal(p.a.movement, null); assert.equal(p.a.life.inventory.wheat_bread, 2);
    assert.equal(p.a.life.ledger.entries.filter(row => row.items?.wheat_bread === -1).length, 1);
    f.advance(5000, { fine }); assert.equal(p.a.life.inventory.wheat_bread, 2); assert.equal(p.a.community_job, null);
    results.push({ satiety: p.a.survival.satiety, energy: p.a.fatigue.energy, hp: p.a.adventure.hp });
  }
  for (const key of ['satiety', 'energy', 'hp']) assert.ok(Math.abs(results[0][key] - results[1][key]) < 0.02, `${key}: ${JSON.stringify(results)}`);
});

test('v032 rejected legacy actions roll back cleanly while module job, reading and original intention remain intact', t => {
  const f = fixture(t), [p] = f.players;
  p.ok('community', { intent: 'use', seat_id: seat.id, activity: 'sit', duration_seconds: 60 });
  const original = structuredClone({ job: p.a.community_job, movement: p.a.movement, goal: p.a.goal, run: p.a.run });
  for (const [type, payload] of [
    ['move', { x: 12, y: 8 }], ['adventure_plan', { intent: 'explore', zone_id: 'forest' }],
    ['home', { intent: 'build' }], ['peer_market', { intent: 'approach' }], ['community', ownMeal],
  ]) {
    const result = p.act(type, payload); assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'COMMUNITY_BUSY');
    assert.deepEqual({ job: p.a.community_job, movement: p.a.movement, goal: p.a.goal, run: p.a.run }, original);
  }
  p.ok('community', { intent: 'browse', page: 0 }); p.ok('peer_market', { intent: 'browse', page: 0 });
  p.ok('say', { channel: 'nearby', text: '这是我自己说的。' });
  assert.deepEqual({ job: p.a.community_job, movement: p.a.movement, goal: p.a.goal, run: p.a.run }, original);
  const during = p.observe();
  assert.ok(!during.opportunities.some(opportunity => ['gather', 'adventure_plan', 'move'].includes(opportunity.action?.type)));
  assert.deepEqual(during.movement.candidates, []);
  for (const name of ['fishing', 'homes', 'ruins', 'peer_market', 'community']) {
    for (const choice of during[name].opportunities) {
      const action = choice.action || choice;
      assert.ok(f.world.features.allows(p.a, action.type, action.payload), `${name} must not advertise blocked work`);
    }
  }
  p.ok('community', { intent: 'cancel_use' }); assert.equal(p.a.community_job, null); assert.equal(p.a.movement, null);
  p.ok('peer_market', { intent: 'approach' }); assert.ok(p.a.movement);
});

test('v032 both module lifecycles pause safely and restart valid SQLite without changing identity, owner goal, or escrow ownership', t => {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'v032-modules-'));
  const f = fixture(t, { dbPath: join(directory, 'world.sqlite'), cleanupDirectory: directory }), [p] = f.players;
  const preserved = structuredClone({ id: p.id, goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance });
  p.a.position = { ...PEER_MARKET_RULES.place.interaction_position };
  p.ok('peer_market', { intent: 'post', kind: 'exchange', give: { items: { wood: 2 } }, want: { items: { ore: 1 } } });
  assert.equal(p.a.life.inventory.wood, 6);
  p.a.survival.satiety = 30;
  p.ok('community', ownMeal); assert.equal(p.a.life.inventory.wheat_bread, 3);
  f.world.ownerControl(p.id, 'pause');
  assert.equal(p.a.community_job, null); assert.equal(p.a.movement, null);
  assert.equal(p.a.life.inventory.wood, 8); assert.equal(p.a.life.inventory.wheat_bread, 3);
  const offer = Object.values(f.world.state.peer_market.offers)[0];
  assert.equal(offer.status, 'interrupted'); assert.equal(offer.end_reason, 'authorization_ended');
  f.restart();
  assert.deepEqual({ id: p.id, goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance }, preserved);
  assert.equal(p.a.life.inventory.wood, 8); assert.equal(p.a.life.inventory.wheat_bread, 3);
  assert.equal(p.a.community_job, null);
});

test('v032 permission boundary stops real community travel before the seat and never starts an unpermitted meal', t => {
  const f = fixture(t), [p] = f.players;
  p.a.survival.satiety = 30;
  p.ok('community', ownMeal);
  p.a.run.expires_at = f.now() + 1000;
  f.advance(30000, { heartbeat: false });
  assert.notDeepEqual(p.a.position, seat.position); assert.equal(p.a.community_job, null);
  assert.equal(p.a.life.inventory.wheat_bread, 3);
});

test('v032 exhaustion releases only the selected finite trip and never restarts it after idle recovery', t => {
  const f = fixture(t), [p] = f.players;
  const before = { ...p.a.position }; p.a.fatigue.energy = 0.01;
  p.ok('community', { intent: 'approach', venue_id: 'stage', mode: 'run' });
  assert.ok(p.a.movement); assert.ok(p.a.community_job);
  f.advance(1000);
  assert.equal(p.a.community_job, null); assert.equal(p.a.movement, null);
  assert.notDeepEqual(p.a.position, before);
  assert.notDeepEqual(p.a.position, COMMUNITY_RULES.venues.find(venue => venue.id === 'stage').interaction_position);
  const stopped = { ...p.a.position };
  f.advance(30000);
  assert.equal(p.a.community_job, null); assert.equal(p.a.movement, null); assert.deepEqual(p.a.position, stopped);
  assert.equal(p.a.life.inventory.wheat_bread, 3); assert.equal(p.a.goal, '原主人的要求0');
});
