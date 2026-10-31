import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';

function fixture(t, { hazard = 'darkness', endsIn = 200, protectedFor = 0 } = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const created = world.createAgent({ name: '原寻宝旅人' }), controller = world.createController(created.agent_id);
  world.ownerControl(created.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 20, max_calls: 100 });
  const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world'), a = world.agent(created.agent_id);
  const request = { run_id: joined.run_id, session_epoch: joined.session_epoch, action_id: joined.next_action_id, type: 'start_activity', payload: { activity_id: 'treasure_hunt' } };
  const receipt = world.callTool(auth, 'act', request); assert.equal(receipt.status, 'applied');
  // A saved in-progress treasure hunt with one collected item isolates the time
  // boundary; the normal activity, hazard and completion handlers are exercised.
  a.activity.progress.collected = 1; a.activity.ends_at = now + endsIn;
  a.survival.protected_until = now + protectedFor;
  if (hazard === 'darkness') { world.state.day_cycle.epoch_at = now - 360000; a.survival.darkness_seconds = 99.9; }
  else { a.survival.satiety = 0; a.survival.starvation_seconds = 9.9; }
  const grant = structuredClone(a.run), inventory = structuredClone(a.life.inventory);
  return { world, a, auth, request, receipt, grant, inventory,
    tick(ms) { now += ms; world.tick(); },
    completed() { return world.state.events.filter(e => e.type === 'activity_finished' && e.payload.agent_id === a.agent_id); },
  };
}

for (const hazard of ['darkness', 'starving']) for (const endsIn of [50, 100, 200]) test(`v021 ${hazard} at 100ms versus activity end at ${endsIn}ms respects actual order even in a late tick`, t => {
  const stepped = fixture(t, { hazard, endsIn }), delayed = fixture(t, { hazard, endsIn });
  for (let i = 0; i < 5; i++) stepped.tick(100); delayed.tick(500);
  const shouldComplete = endsIn < 100;
  for (const f of [stepped, delayed]) {
    assert.equal(f.a.activity, null); assert.equal(f.completed().length, 1);
    const finished = f.completed()[0].payload;
    assert.equal(finished.outcome, shouldComplete ? 'completed' : 'cancelled');
    if (shouldComplete) { assert.equal(finished.result.score, 1); assert.equal(finished.result.max_score, 3); assert.equal(finished.interrupted, undefined); }
    else { assert.equal(finished.interrupted, true); assert.equal(finished.result, undefined, 'interrupted work must not publish a completed score'); }
    assert.equal(f.a.adventure.hp, hazard === 'darkness' ? 36 : 38);
    assert.equal(f.world.state.events.filter(e => e.type === 'survival_damage' && e.payload.kind === hazard).length, 1);
    assert.deepEqual(f.a.run, f.grant); assert.deepEqual(f.a.life.inventory, f.inventory);
    assert.deepEqual(f.world.callTool(f.auth, 'act', f.request), f.receipt, 'retrying the original start request cannot start a replacement activity');
    f.tick(0); assert.equal(f.completed().length, 1); assert.equal(f.a.activity, null);
  }
  assert.equal(delayed.completed()[0].payload.outcome, stepped.completed()[0].payload.outcome);
  assert.deepEqual(delayed.completed()[0].payload.result, stepped.completed()[0].payload.result);
});

test('v021 protected activity still completes when no real survival hit is due', t => {
  const f = fixture(t, { endsIn: 200, protectedFor: 1000 }); f.tick(500);
  assert.equal(f.completed().length, 1); assert.equal(f.completed()[0].payload.outcome, 'completed'); assert.equal(f.completed()[0].payload.result.score, 1);
  assert.equal(f.a.adventure.hp, 40); assert.equal(f.world.state.events.filter(e => e.type === 'survival_damage').length, 0);
});
