import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDayCycle, publicDayCycle, tickDayCycle, DAY_RULES } from '../server/day-cycle.js';

test('v020 day clock uses persistent absolute phase boundaries and cannot move backwards', () => {
  const state = {}; initializeDayCycle(state, 1000000);
  assert.equal(DAY_RULES.phases.reduce((sum, p) => sum + p.seconds, 0), 600);
  for (const [elapsed, phase, next, day] of [[0, 'day', 300000, 1], [299999, 'day', 300000, 1], [300000, 'dusk', 360000, 1], [360000, 'night', 540000, 1], [540000, 'dawn', 600000, 1], [600000, 'day', 900000, 2]]) {
    const read = publicDayCycle(state, 1000000 + elapsed);
    assert.equal(read.phase, phase); assert.equal(read.next_at, 1000000 + next); assert.equal(read.day_index, day);
  }
  initializeDayCycle(state, 1500000); const before = publicDayCycle(state, 1500000);
  initializeDayCycle(state, 1400000); assert.deepEqual(publicDayCycle(state, 1400000), before);
});

test('v020 a stalled clock publishes only its current phase, including a whole-cycle jump; no automatic AI action', () => {
  const state = {}; let now = 1000000; const events = [];
  const world = { state, now: () => now, activeIds: () => [], event: (...args) => events.push(args) };
  initializeDayCycle(state, now);
  assert.deepEqual(tickDayCycle(world), { changed: false, durable: false });
  now += 600000; assert.deepEqual(tickDayCycle(world), { changed: true, durable: true });
  assert.equal(events.length, 1); assert.equal(events[0][0], 'day_phase_changed'); assert.equal(events[0][1].phase, 'day'); assert.equal(events[0][1].day_index, 2);
  assert.deepEqual(tickDayCycle(world), { changed: false, durable: false }); assert.equal(events.length, 1);
  assert.equal(state.agents, undefined);
});
