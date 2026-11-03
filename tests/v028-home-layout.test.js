import test from 'node:test';
import assert from 'node:assert/strict';
import { homeActorDepth, homeFurnitureLayout, homeFurnitureFootprint, homeRoomFoot } from '../src/home-pixel-layout.js';
import { homeActorProxy, homeSeatAnchor, homeUsePresentationStyle } from '../src/home-state.js';
import { sampleHomeUsePose } from '../src/home-use-pose.js';

const chair = { instance_id: 'saved-chair', kind: 'chair', x: 3, y: 3, rotation: 0 };
const using = { instance_id: chair.instance_id, phase: 'using', kind: 'sit', started_at: 1000, ends_at: 61000 };
const actor = { agent_id: 'original-agent', status: 'active', appearance: { sprite_id: 'original-skin' }, position: { x: 99, y: 99 },
  home_presence: { home_id: 'saved-home', position: { x: 3, y: 4 }, activity: using } };

test('art anchors preserve the saved floor layout and intrinsic proportions at every orientation', () => {
  const item = Object.freeze({ instance_id: 'old-table', kind: 'table', x: 2, y: 4, rotation: 90 });
  const spec = { variants: {
    0: { width: 100, height: 66, anchor: { x: 50, y: 62 } },
    90: { width: 50, height: 112, anchor: { x: 25, y: 106 } },
    180: { width: 100, height: 66, anchor: { x: 50, y: 62 } },
    270: { width: 50, height: 112, anchor: { x: 25, y: 106 } },
  } };
  for (const rotation of [0, 90, 180, 270]) {
    const layout = homeFurnitureLayout({ ...item, rotation }, undefined, spec), art = spec.variants[rotation];
    assert.equal(layout.width / layout.height, art.width / art.height);
    assert.equal(layout.x + art.anchor.x, layout.foot.x);
    assert.equal(layout.y + art.anchor.y, layout.foot.y);
    assert.deepEqual(layout.footprint, rotation % 180 ? [1, 2] : [2, 1]);
  }
  const changedCatalog = homeFurnitureLayout(item, { furniture_catalog: { table: { width: 3, height: 2 } } }, spec);
  assert.deepEqual(changedCatalog.footprint, [2, 3]);
  assert.equal(changedCatalog.width / changedCatalog.height, 50 / 112, 'physical footprint never stretches the sprite');
  assert.deepEqual(item, { instance_id: 'old-table', kind: 'table', x: 2, y: 4, rotation: 90 });
});

test('rugs remain below feet while furniture depth orders passing actors on the correct side', () => {
  const layout = homeFurnitureLayout(chair), rug = homeFurnitureLayout({ kind: 'rug', x: 3, y: 3 });
  assert.ok(rug.depth < homeActorDepth({ x: 3, y: 3 }));
  assert.ok(homeActorDepth({ x: 3, y: 2 }) < layout.depth, 'a person behind the chair is behind its solid wood');
  assert.ok(homeActorDepth({ x: 3, y: 4 }) > layout.foregroundDepth, 'a passer-by in front is never covered by its foreground');
  assert.ok(homeActorDepth({ x: 3, y: 4 }, layout) > layout.depth);
  assert.ok(homeActorDepth({ x: 3, y: 4 }, layout) < layout.foregroundDepth, 'only the actual seated occupant is between the two furniture layers');
  assert.equal(rug.y, 135 + 3 * 42, 'the rug has no arbitrary upright lift');
});

test('the exact art seat anchors only confirmed adjacent use, leaving server position and original identity intact', () => {
  const original = JSON.stringify(actor), proxy = homeActorProxy(actor);
  const art = { width: 50, height: 66, anchor: { x: 25, y: 66 }, seat: { x: 25, y: 40 }, facing: 'south' };
  const layout = homeFurnitureLayout(chair, undefined, art), offset = homeSeatAnchor(proxy, chair, art);
  const foot = homeRoomFoot(proxy.position);
  assert.deepEqual({ x: foot.x + offset.x, y: foot.y + offset.y }, layout.seat);
  for (const phase of ['approaching', 'ended']) assert.equal(homeSeatAnchor({ ...proxy, home_presence: { ...proxy.home_presence, activity: { ...using, phase } } }, chair, art), null);
  assert.equal(homeSeatAnchor({ ...proxy, position: { x: 7, y: 7 } }, chair, art), null);
  assert.equal(homeSeatAnchor(proxy, { ...chair, instance_id: 'other-chair' }, art), null);
  assert.equal(homeUsePresentationStyle(proxy, { ...chair, instance_id: 'other-chair' }, 2000, true, 21.8, art), undefined);
  assert.equal(JSON.stringify(actor), original);
  assert.deepEqual(proxy.appearance, actor.appearance);
});

test('directional bed poses articulate toward the mattress axis, retaining limb lengths and frozen accessibility state', () => {
  const job = { ...using, kind: 'rest' }, proxy = homeActorProxy(actor);
  for (const facing of ['east', 'south', 'west', 'north']) {
    const pose = sampleHomeUsePose(proxy, job, 6000, { facing, furnitureKind: 'bed', enabled: false });
    const delta = { x: pose.joints.ankle_r.x - pose.joints.neck.x, y: pose.joints.ankle_r.y - pose.joints.neck.y };
    if (facing === 'east') assert.ok(delta.x > 20);
    if (facing === 'west') assert.ok(delta.x < -20);
    if (facing === 'south') assert.ok(delta.y > 20);
    if (facing === 'north') assert.ok(delta.y < -20);
    for (const side of ['l', 'r']) {
      const [a, b, c] = ['shoulder', 'elbow', 'wrist'].map(key => pose.joints[`${key}_${side}`]);
      assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - pose.dimensions.upperArm) < 1e-6);
      assert.ok(Math.abs(Math.hypot(b.x - c.x, b.y - c.y) - pose.dimensions.forearm) < 1e-6);
    }
    assert.deepEqual(pose, sampleHomeUsePose(proxy, job, 20000, { facing, furnitureKind: 'bed', enabled: false }));
    assert.ok(Math.abs(pose.parts.thigh_r.rotation - pose.parts.shin_r.rotation) > .2, 'the knees are articulated, not a frozen upright sprite');
  }
});

test('chair directions and foot mapping remain compatible with all legacy room positions', () => {
  assert.deepEqual(homeRoomFoot({ x: 0, y: 0 }), { x: 95, y: 164.4 });
  const farCorner = homeRoomFoot({ x: 9, y: 7 });
  assert.equal(farCorner.x, 545); assert.ok(Math.abs(farCorner.y - 458.4) < 1e-8);
  assert.deepEqual(homeFurnitureFootprint({ kind: 'bookshelf', rotation: 270 }), [1, 2]);
  const proxy = homeActorProxy(actor);
  for (const [rotation, expected] of [[0, 'south'], [90, 'west'], [180, 'north'], [270, 'east']]) {
    assert.equal(homeSeatAnchor(proxy, { ...chair, rotation }).facing, expected);
  }
});
