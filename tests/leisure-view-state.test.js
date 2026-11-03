import test from 'node:test';
import assert from 'node:assert/strict';
import { fishingState, fishingReceipts, fishingReel } from '../src/fishing-view-state.js';
import { sampleFishingPose } from '../src/fishing-pose.js';
import { characterAction } from '../src/pixel-state.js';
import { homeActivity } from '../src/home-state.js';
import { sampleHomeUsePose } from '../src/home-use-pose.js';

const actor = { agent_id: 'original', status: 'active', scene_id: 'plaza', position: { x: 3, y: 4 }, facing: 'north', fishing: { job_id: 'one', phase: 'fishing', spot_id: 'south', scene_id: 'plaza', interaction_position: { x: 3, y: 4 }, started_at: 1000, ends_at: 31000 } };

test('fishing visuals require a confirmed job at its real shore and never infer catches', () => {
  const before = JSON.stringify(actor);
  assert.equal(fishingState(actor, 16000).progress, .5);
  assert.equal(characterAction(actor, [], 16000), 'fish');
  for (const value of [{ ...actor, position: { x: 5, y: 5 } }, { ...actor, fishing: { ...actor.fishing, phase: 'approaching' } }]) assert.equal(fishingState(value, 16000).working, false);
  for (const value of [{ ...actor, scene_id: 'adventure' }, { ...actor, home_presence: { home_id: 'home' } }, { ...actor, status: 'offline' }, { ...actor, fishing: null }]) assert.equal(fishingState(value, 16000), null);
  assert.equal(fishingState(actor, 99999).remaining, 0);
  assert.deepEqual(fishingReceipts({ events: [{ type: 'fish_started', payload: { spot_id: 'south' } }, { type: 'fish_finished', payload: { spot_id: 'east' } }] }, 'south'), []);
  assert.equal(JSON.stringify(actor), before);
});

test('rod pose preserves the feet and identity, holds anatomically bounded arms, and freezes on disconnect', () => {
  const before = JSON.stringify(actor), pose = sampleFishingPose(actor, 10000);
  assert.equal(pose.action, 'fish');
  const d = pose.dimensions;
  for (const side of ['l', 'r']) {
    const [a, b, c] = ['shoulder', 'elbow', 'wrist'].map(key => pose.joints[`${key}_${side}`]);
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - d.upperArm) < .001);
    assert.ok(Math.abs(Math.hypot(c.x - b.x, c.y - b.y) - d.forearm) < .001);
  }
  assert.deepEqual(sampleFishingPose(actor, 1100, { enabled: false }), sampleFishingPose(actor, 20000, { enabled: false }));
  assert.equal(sampleFishingPose({ ...actor, fishing: { ...actor.fishing, phase: 'approaching' } }, 10000).action, 'idle');
  assert.equal(JSON.stringify(actor), before);
});

test('reeling requires a real completed catch receipt and cannot repeat or follow an actor into another scene', () => {
  const spot = { id: 'south', scene_id: 'plaza', interaction_position: { x: 3, y: 4 } }, idle = { ...actor, fishing: null };
  const event = { type: 'fish_finished', occurred_at: 31000, payload: { agent_id: 'original', spot_id: 'south', item_id: 'pond_fish', quantity: 1 } };
  assert.equal(fishingReel(idle, spot, [event], 31450).progress, .5);
  for (const events of [[], [{ ...event, type: 'fish_cancelled' }], [{ ...event, payload: { ...event.payload, quantity: 0 } }]]) assert.equal(fishingReel(idle, spot, events, 31450), null);
  assert.equal(fishingReel(idle, spot, [event], 32000), null);
  assert.equal(fishingReel({ ...idle, scene_id: 'adventure' }, spot, [event], 31450), null);
  assert.equal(fishingReel({ ...idle, position: { x: 4, y: 4 } }, spot, [event], 31450), null);
});

test('writing only animates confirmed table use and never manufactures a public book', () => {
  const activity = { kind: 'write', phase: 'using', instance_id: 'table', title: '池塘边', started_at: 1000, ends_at: 46000 }, author = { ...actor, fishing: null, home_presence: { home_id: 'home', activity } };
  assert.equal(homeActivity(author, 16000).label, '写作');
  const pose = sampleHomeUsePose(author, activity, 10000, { furnitureKind: 'table' });
  assert.equal(pose.homeProp.kind, 'writing'); assert.equal(pose.action, 'write');
  assert.equal(sampleHomeUsePose(author, { ...activity, phase: 'approaching' }, 10000).homeProp, undefined);
  assert.deepEqual(sampleHomeUsePose(author, activity, 5000, { enabled: false }), sampleHomeUsePose(author, activity, 30000, { enabled: false }));
  assert.equal(homeActivity(author, 999999).remaining, 0); assert.equal(author.home_presence.activity.phase, 'using');
  assert.equal(author.home_presence.books, undefined);
});
