import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedHome, homeActors, homeActorProxy, homePosition, furnitureSize, homeActivity, homeFurnitureOccupant, homeSeatAnchor, homeUsePresentationStyle } from '../src/home-state.js';
import { sampleHomeUsePose } from '../src/home-use-pose.js';
import { sceneActors } from '../src/scene-state.js';
import { activeSpeeches } from '../src/speech-state.js';
import { survivalStatus } from '../src/survival-state.js';

const homes = [{ home_id: 'one', owner_agent_id: 'host' }, { home_id: 'two', owner_agent_id: 'guest' }];
const host = { agent_id: 'host', name: '屋主', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'one', position: { x: 2, y: 3 } } };
const guest = { agent_id: 'guest', name: '朋友', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'one', position: { x: 5, y: 7 } } };
const other = { agent_id: 'other', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'two', position: { x: 2, y: 3 } } };

test('home observation selects explicit room or current visit, without borrowing another home', () => {
  assert.equal(selectedHome(homes, [host, guest], 'guest').home_id, 'one');
  assert.equal(selectedHome(homes, [host, guest], 'guest', 'two').home_id, 'two');
  assert.equal(selectedHome(homes, [], 'new'), null);
  assert.equal(selectedHome(homes, [host], 'host', 'missing'), null);
  assert.deepEqual(homeActors([host, guest, other], 'one').map(a => a.agent_id), ['host', 'guest']);
  assert.deepEqual(sceneActors([host, guest, other], 'plaza'), []);
});

test('home rendering preserves identity and equipment but never uses outdoor motion/action', () => {
  const source = { ...host, appearance: { sprite_id: 'original' }, life: { equipment: { weapon: 'sword' }, gathering: { phase: 'working' } }, movement: { path: [{ x: 12, y: 10 }] }, action: { type: 'attack' }, home_presence: { ...host.home_presence, facing: 'west' } };
  const proxy = homeActorProxy(source);
  assert.deepEqual(proxy.appearance, source.appearance);
  assert.deepEqual(proxy.life.equipment, source.life.equipment);
  assert.deepEqual(proxy.position, { x: 2, y: 3 });
  assert.equal(proxy.movement, null); assert.equal(proxy.action, null); assert.equal(proxy.life.gathering, null);
  assert.equal(proxy.facing, 'west'); assert.equal(source.action.type, 'attack');
  assert.deepEqual(homePosition(source, 90000, false), { x: 2, y: 3 });
  assert.deepEqual(furnitureSize({ kind: 'table', rotation: 90 }), [1, 2]);
});

test('live speech stays in the exact room and old room speech cannot follow an actor outdoors', () => {
  const events = [{ event_id: 1, type: 'message', occurred_at: 900, payload: { agent_id: 'host', scene_id: 'plaza', home_id: 'one', channel: 'nearby', text: '屋内的话' } }];
  assert.equal(activeSpeeches({ events, agents: [host], now: 1000, sceneId: 'plaza' }).length, 1);
  assert.equal(activeSpeeches({ events, agents: [{ ...host, home_presence: null }], now: 1000, sceneId: 'plaza' }).length, 0);
  assert.equal(activeSpeeches({ events, agents: [{ ...host, home_presence: other.home_presence }], now: 1000, sceneId: 'plaza' }).length, 0);
});

test('interior movement samples its own clock and freezes the confirmed position on disconnect', () => {
  const actor = { ...host, home_presence: { home_id: 'one', position: { x: 2, y: 3 }, position_at: 1000,
    movement: { version: 2, scene_id: 'home', speed: 2, path: [{ x: 2, y: 3 }, { x: 3, y: 3 }], started_at: 1000, ends_at: 1500, duration_ms: 500, mode: 'walk' } } };
  assert.deepEqual(homePosition(actor, 1100, true), { x: 2.2, y: 3 });
  assert.deepEqual(homePosition(actor, 1100, false), { x: 2, y: 3 });
  assert.deepEqual(homePosition(actor, 10000, true), { x: 2.5, y: 3 });
  assert.equal(survivalStatus({ ...actor, survival: { light: { lit: true, kind: 'indoor' }, satiety: 80, satiety_state: 'fed' } }, 'night').light, '小屋灯光照亮');
});

test('furniture activity labels and progress come only from a confirmed room job', () => {
  const job = { activity_id: 'use_one', instance_id: 'chair_one', kind: 'read', phase: 'approaching', started_at: 1000, ends_at: null, expires_at: 121000 };
  const actor = { ...host, home_presence: { ...host.home_presence, activity: job } };
  assert.equal(homeActivity(actor, 5000).label, '走过去阅读');
  assert.equal(homeActivity(actor, 5000).progress, 0);
  actor.home_presence.activity = { ...job, phase: 'using', started_at: 6000, ends_at: 51000 };
  assert.equal(homeActivity(actor, 28500).progress, .5);
  assert.equal(homeActivity(actor, 55000).progress, 1);
  assert.equal(homeActivity(actor, 55000).phase, 'using', 'the browser does not invent completion');
  assert.equal(homeActivity({ ...actor, home_presence: null }, 55000), null);
  assert.equal(homeFurnitureOccupant([actor, other], 'chair_one', 'one'), actor);
  assert.equal(homeFurnitureOccupant([actor, other], 'chair_one', 'two'), null);
  assert.deepEqual(furnitureSize({ kind: 'bed', rotation: 0 }), [2, 2]);
  assert.deepEqual(furnitureSize({ kind: 'bookshelf', rotation: 90 }), [1, 2]);
});

test('home sitting, reading and eating articulate limbs without moving the saved foot or changing identity', () => {
  const actor = { ...host, appearance: { sprite_id: 'original' }, life: { equipment: { armor: 'leather' } } };
  const before = JSON.stringify(actor);
  const start = { phase: 'using', started_at: 1000, ends_at: 61000 };
  const sit = sampleHomeUsePose(actor, { ...start, kind: 'sit' }, 2500, { facing: 'east', furnitureKind: 'chair' });
  assert.ok(sit.joints.hip.y > -21.8);
  assert.ok(Math.abs(sit.parts.thigh_l.rotation) > .1, 'sitting bends real knees');
  assert.deepEqual(sit.contacts.l, { x: -1.25, y: 0, grounded: true, phase: 0 });
  for (const kind of ['sit', 'read', 'eat', 'rest']) for (const facing of ['north', 'south', 'east', 'west']) {
    const pose = sampleHomeUsePose(actor, { ...start, kind }, 2900, { facing, furnitureKind: kind === 'rest' ? 'bed' : 'chair' });
    for (const side of ['l', 'r']) {
      const shoulder = pose.joints[`shoulder_${side}`], elbow = pose.joints[`elbow_${side}`], wrist = pose.joints[`wrist_${side}`];
      assert.ok(Math.abs(Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y) - pose.dimensions.upperArm) < 1e-6);
      assert.ok(Math.abs(Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y) - pose.dimensions.forearm) < 1e-6);
      const leg = pose.legSpace[side];
      assert.ok(Math.abs(Math.hypot(leg.hip.depth - leg.knee.depth, leg.hip.height - leg.knee.height) - pose.dimensions.thigh) < 1e-6);
      assert.ok(Math.abs(Math.hypot(leg.ankle.depth - leg.knee.depth, leg.ankle.height - leg.knee.height) - pose.dimensions.shin) < 1e-6);
    }
    assert.equal(pose.homeProp?.kind, kind === 'read' ? 'book' : kind === 'eat' ? 'bowl' : undefined);
    assert.ok(Object.values(pose.parts).every(part => Object.values(part).every(Number.isFinite)));
  }
  assert.equal(JSON.stringify(actor), before);
});

test('home-only poses never show eating during approach and freeze cycles on pause, disconnect or reduced motion', () => {
  const activity = { kind: 'eat', phase: 'using', started_at: 1000, ends_at: 21000 };
  const approaching = sampleHomeUsePose(host, { ...activity, phase: 'approaching' }, 4000, { furnitureKind: 'table' });
  assert.equal(approaching.action, 'idle'); assert.equal(approaching.homeProp, undefined);
  const frozen = time => sampleHomeUsePose(host, activity, time, { enabled: false, furnitureKind: 'table' });
  assert.deepEqual(frozen(5000), frozen(19000));
  const paused = time => sampleHomeUsePose({ ...host, status: 'paused' }, activity, time, { furnitureKind: 'table' });
  assert.deepEqual(paused(5000), paused(19000));
  assert.deepEqual(paused(1100), paused(1400), 'pause freezes the first 650 ms too');
  const ended = time => sampleHomeUsePose(host, activity, time, { furnitureKind: 'table' });
  assert.deepEqual(ended(22000), ended(30000));
});

test('chair presentation anchor requires a confirmed use next to the correct chair', () => {
  const item = { instance_id: 'chair', kind: 'chair', x: 3, y: 3, rotation: 0 };
  const actor = { ...host, position: { x: 3, y: 4 }, home_presence: { ...host.home_presence, activity: { instance_id: 'chair', phase: 'using', kind: 'sit' } } };
  const before = JSON.stringify(actor), offset = homeSeatAnchor(actor, item);
  assert.equal(offset.x, 0); assert.ok(offset.y < 0); assert.equal(offset.facing, 'south');
  assert.equal(homeSeatAnchor({ ...actor, position: { x: 6, y: 7 } }, item), null);
  assert.equal(homeSeatAnchor(actor, { ...item, instance_id: 'another-chair' }), null);
  assert.equal(homeSeatAnchor({ ...actor, home_presence: { ...actor.home_presence, activity: { ...actor.home_presence.activity, phase: 'approaching' } } }, item), null);
  assert.equal(JSON.stringify(actor), before);
});

test('bed rest projects only a confirmed adjacent occupant onto the mattress and articulates a reclined body', () => {
  const bed = { instance_id: 'bed', kind: 'bed', x: 5, y: 4, rotation: 0 };
  const activity = { instance_id: 'bed', phase: 'using', kind: 'rest', started_at: 1000, ends_at: 61000 };
  const actor = { ...host, position: { x: 4, y: 4 }, home_presence: { ...host.home_presence, activity } };
  const before = JSON.stringify(actor), anchor = homeSeatAnchor(actor, bed);
  assert.equal(anchor.kind, 'bed'); assert.equal(anchor.facing, 'east'); assert.ok(anchor.x > 0);
  for (const position of [{ x: 5, y: 3 }, { x: 7, y: 5 }, { x: 6, y: 6 }]) assert.ok(homeSeatAnchor({ ...actor, position }, bed));
  for (const position of [{ x: 5, y: 4 }, { x: 4, y: 3 }, { x: 1, y: 1 }]) assert.equal(homeSeatAnchor({ ...actor, position }, bed), null);
  assert.equal(homeSeatAnchor(actor, { ...bed, instance_id: 'another-bed' }), null);
  for (const change of [{ phase: 'approaching' }, { kind: 'read' }]) assert.equal(homeSeatAnchor({ ...actor, home_presence: { ...actor.home_presence, activity: { ...activity, ...change } } }, bed), null);
  const pose = sampleHomeUsePose(actor, activity, 2000, { facing: 'east', furnitureKind: 'bed', enabled: false });
  assert.ok(pose.parts.torso.rotation < -1, 'the torso reclines through its own joint');
  assert.ok(pose.joints.neck.x < pose.joints.hip.x - 8, 'head and shoulders lie toward the headboard');
  assert.ok(pose.joints.ankle_r.x > pose.joints.hip.x + 12, 'legs extend along the mattress');
  assert.ok(Math.abs(pose.parts.thigh_r.rotation - pose.parts.shin_r.rotation) > .2, 'knees stay bent instead of rotating the whole sprite');
  assert.equal(JSON.stringify(actor), before);
});

test('the name and body share one bounded furniture transition and paused or static views use its final anchor', () => {
  const bed = { instance_id: 'bed', kind: 'bed', x: 5, y: 4 };
  const actor = { ...host, position: { x: 4, y: 4 }, home_presence: { ...host.home_presence, activity: { instance_id: 'bed', phase: 'using', kind: 'rest', started_at: 1000, ends_at: 61000 } } };
  const start = homeUsePresentationStyle(actor, bed, 1000, true), middle = homeUsePresentationStyle(actor, bed, 1325, true), final = homeUsePresentationStyle(actor, bed, 1650, true);
  assert.notDeepEqual(start, middle); assert.notDeepEqual(middle, final);
  assert.deepEqual(final, homeUsePresentationStyle(actor, bed, 5000, true));
  for (const now of [1100, 1400]) {
    assert.deepEqual(homeUsePresentationStyle(actor, bed, now, false), final);
    assert.deepEqual(homeUsePresentationStyle({ ...actor, status: 'paused' }, bed, now, true), final);
  }
});
