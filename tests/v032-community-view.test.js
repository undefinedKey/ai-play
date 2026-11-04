import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMUNITY_VENUES } from '../shared/community.js';
import { communityArtwork, communityEvents, communityEventState, communityPerformances, communityPerformanceHistory, communityUseState } from '../src/community-state.js';
import { sampleCommunityPose } from '../src/community-pose.js';
import { characterAction, actorFacing } from '../src/pixel-state.js';
import { renderSpace, spriteRenderPacket } from '../src/render-packet.js';
import { observerExecution, observerActionResult } from '../src/world-services-state.js';

function actor(activity = 'eat') {
  const venue = COMMUNITY_VENUES.find(value => value.id === (activity === 'perform' || activity === 'listen' ? 'stage' : 'table'));
  const seat = venue.seats.find(value => value.activities.includes(activity));
  return { agent_id: 'fixture_actor', name: '原角色', status: 'active', scene_id: 'plaza', position: { ...seat.position }, position_at: 1000,
    appearance: { sprite_id: 'original_skin' }, community_job: { job_id: 'job_fixture', kind: 'use', venue_id: venue.id, seat_id: seat.id, phase: 'using', activity,
      interaction_position: { ...seat.position }, use_started_at: 1000, ends_at: 31000, expires_at: 40000, title: '自己的故事', text: '自己选择公开的文字。' } };
}

test('v032 clocks qualify stale and expired-deadline events without inventing a server transition', () => {
  const event = { status: 'active', expires_at: 2000 }, before = structuredClone(event);
  assert.deepEqual(communityEventState(event, 3000), { key: 'active', ongoing: true, label: '活动进行中', deadline: '期限已到，等待服务器确认' });
  assert.equal(communityEventState(event, 3000, false).deadline, '连接恢复后更新期限');
  assert.match(communityEventState(event, 3000, false).label, /最近记录/);
  assert.equal(communityEventState({ ...event, status: 'expired' }, 3000).label, '已到期');
  assert.deepEqual(event, before);
});

test('v032 board filters actual event records and does not create participants or reorder source state', () => {
  const community = { events: [{ event_id: 'early', venue_id: 'picnic', status: 'open', expires_at: 3000 }, { event_id: 'stage', venue_id: 'stage', status: 'active', expires_at: 5000 },
    { event_id: 'ended', venue_id: 'picnic', status: 'ended', ended_at: 4000 }, { event_id: 'cancelled', venue_id: 'table', status: 'cancelled', ended_at: 6000 }] }, before = structuredClone(community);
  assert.deepEqual(communityEvents(community).map(value => value.event_id), ['stage', 'early']);
  assert.deepEqual(communityEvents(community, 'current', 'picnic').map(value => value.event_id), ['early']);
  assert.deepEqual(communityEvents(community, 'history').map(value => value.event_id), ['cancelled', 'ended']);
  assert.deepEqual(community, before);
});

test('v032 neither an invitation nor a predicted arrival creates a stage performance or seated pose', () => {
  const a = actor('perform');
  assert.equal(communityPerformances({ agents: [a] }, 2000).length, 1);
  assert.equal(characterAction(a, [], 2000), 'perform');
  assert.equal(actorFacing(a, 'perform', 2000), 'south');
  for (const patch of [{ community_job: null }, { home_presence: { home_id: 'another_space' } }, { scene_id: 'adventure' }, { position: { x: 0, y: 0 } },
    { community_job: { ...a.community_job, phase: 'approaching', use_started_at: null } }, { movement: { version: 2 } }]) {
    const b = { ...a, ...patch };
    assert.equal(communityPerformances({ agents: [b] }, 999999).length, 0);
    assert.notEqual(communityUseState(b, 2000)?.using, true);
  }
});

test('v032 real seating and eating articulate the existing body with fixed feet and bounded animation', () => {
  const a = actor(), before = structuredClone(a), t = 2500;
  const use = communityUseState(a, t), eating = sampleCommunityPose(a, t, { facing: use.facing });
  const later = sampleCommunityPose(a, t + 500, { facing: use.facing });
  assert.equal(eating.action, 'eat'); assert.equal(eating.playing, true);
  assert.notDeepEqual(eating.joints.wrist_r, later.joints.wrist_r);
  assert.deepEqual(eating.joints.ankle_l, later.joints.ankle_l);
  const stopped = sampleCommunityPose(a, 32000, { facing: use.facing }); assert.equal(stopped.playing, false);
  const staticA = sampleCommunityPose(a, t, { facing: use.facing, enabled: false }), staticB = sampleCommunityPose(a, t + 500, { facing: use.facing, enabled: false });
  assert.deepEqual(staticA.parts, staticB.parts); assert.deepEqual(a, before);
  assert.equal(characterAction({ ...a, community_job: { ...a.community_job, phase: 'approaching', use_started_at: null } }, [], t), 'idle');
});

test('v032 completed stage history keeps only real completion receipts, never drafts or interrupted performances', () => {
  const a = actor('perform'), payload = { ...a.community_job, name: a.name };
  const world = { events: [{ type: 'community_use_started', payload }, { type: 'community_use_cancelled', payload },
    { type: 'community_use_finished', occurred_at: 31000, payload }, { type: 'community_use_finished', occurred_at: 31000, payload }] };
  const history = communityPerformanceHistory(world);
  assert.equal(history.length, 1); assert.equal(history[0].text, a.community_job.text); assert.equal(history[0].completed_at, 31000);
  assert.deepEqual(communityPerformanceHistory({ events: world.events.slice(0, 2) }), []);
});

test('v032 selected actor execution describes physical community jobs instead of false idle or mere signup', () => {
  const a = actor('perform'), world = { community: { venues: COMMUNITY_VENUES, events: [{ status: 'active', member_agent_ids: [a.agent_id] }] } };
  assert.deepEqual(observerExecution(world, a, 2000), { kind: 'community', text: '正在公开表演 · 29 秒' });
  assert.match(observerExecution(world, a, 32000).text, /正在公开表演.*等待服务器确认/);
  for (const [activity, label] of [['sit', '已坐下'], ['eat', '正在用餐'], ['listen', '正在聆听']]) assert.match(observerExecution(world, actor(activity), 2000).text, new RegExp(label));
  const approaching = { ...a, community_job: { ...a.community_job, phase: 'approaching', use_started_at: null }, position: { x: 0, y: 0 } };
  assert.equal(observerExecution(world, approaching, 2000).text, '正在走向所选站位 · 公开表演');
  assert.match(observerExecution(world, { ...approaching, community_job: { ...approaching.community_job, kind: 'approach', venue_id: 'board' } }, 2000).text, /正在前往活动公告板/);
  assert.equal(observerExecution(world, { ...a, community_job: null }, 2000).kind, 'idle');
  assert.equal(observerExecution(world, { ...a, status: 'paused' }, 2000).kind, 'paused');
  assert.equal(observerExecution(world, { ...a, status: 'offline' }, 2000).kind, 'inactive');
  assert.equal(observerExecution(world, { ...a, scene_id: 'adventure' }, 2000).kind, 'idle');
  assert.equal(observerActionResult({ action_status: { type: 'community', status: 'applied', at: 2000 } }).text, '公共场地操作已受理');
});

test('v032 every landmark is rendered at its shared physical position and assets stay within a small footprint', () => {
  for (const venue of COMMUNITY_VENUES) {
    const art = communityArtwork[venue.id], anchor = [art.anchor.x * art.native_scale, art.anchor.y * art.native_scale];
    const packet = spriteRenderPacket(art, art.animations.idle.frames[0], renderSpace(venue.position, { anchor, depth: 100 + venue.position.y * 10 }));
    assert.equal(packet.x, (venue.position.x + .5) * 32); assert.equal(packet.y, (venue.position.y + .5) * 32);
    assert.ok(art.sheet_width * packet.scale <= 116);
    const source = readFileSync(new URL(`../public/pixel-world/community-${venue.id}.svg`, import.meta.url), 'utf8');
    assert.match(source, /<svg /); assert.doesNotMatch(source, /<script|foreignObject|https?:\/\/(?!www\.w3\.org)/);
  }
});
