import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDelta } from '../server/snapshot-delta.js';
import { mergeSpectatorDelta, SpectatorFrameError } from '../src/spectator-frame.js';

const event = id => ({ event_id: `evt_${id}`, type: 'adventure_started', payload: { text: `event ${id}` } });
const frame = (revision, x, events) => ({ room: { world_revision: revision }, server_time: revision * 1000, agents: [{ agent_id: 'a', position: { x, y: 8 } }], events });

test('cooperation list and catalog survive public delta, progress replacement and terminal cleanup',()=>{
  let prior={...frame(1,1,[]),cooperation:{templates:[{template_id:'camp_meal'}]},cooperations:[]};
  for(const projects of [[{cooperation_id:'c',status:'proposed',progress:[]}],[{cooperation_id:'c',status:'active',progress:[{step_id:'supply',progress:4}]}],[{cooperation_id:'c',status:'completed',progress:[]}],[]]){
    const next={...prior,server_time:prior.server_time+1000,cooperations:projects};
    const delta=snapshotDelta(prior,next);assert.deepEqual(delta.cooperations,projects);assert.equal(delta.cooperation,undefined);
    assert.deepEqual(mergeSpectatorDelta(prior,delta),next);prior=next;
  }
});

test('HTTP can arrive before an equivalent SSE delta without duplicating public events', () => {
  let stream = frame(1, 1, [event(1)]);
  let displayed = stream;
  const next = frame(2, 2, [event(1), event(2)]);
  displayed = structuredClone(next); // A concurrent HTTP poll arrives first.
  stream = mergeSpectatorDelta(stream, snapshotDelta(stream, next));
  if (stream.room.world_revision >= displayed.room.world_revision) displayed = stream;
  assert.deepEqual(displayed, next);
  assert.equal(displayed.events.length, 2);
});

test('a newer HTTP display must not corrupt the stream baseline when state later returns to its old value', () => {
  let stream = frame(1, 1, [event(1)]);
  let displayed = frame(3, 9, [event(1), event(2), event(3)]);
  const intermediate = frame(2, 1, [event(1), event(2)]);
  stream = mergeSpectatorDelta(stream, snapshotDelta(stream, intermediate));
  if (stream.room.world_revision >= displayed.room.world_revision) displayed = stream;
  assert.equal(displayed.agents[0].position.x, 9);
  const next = frame(4, 1, [event(1), event(2), event(3), event(4)]);
  const delta = snapshotDelta(intermediate, next);
  assert.equal(delta.agents, undefined); // Both SSE baselines have x=1.
  stream = mergeSpectatorDelta(stream, delta);
  if (stream.room.world_revision >= displayed.room.world_revision) displayed = stream;
  assert.equal(displayed.agents[0].position.x, 1);
  assert.deepEqual(displayed.events, next.events);
});

test('delta event cleanup replaces history and an empty new stream ignores deltas until its snapshot', () => {
  const initial = frame(5, 1, [event(1), event(2), event(3)]);
  const clean = frame(6, 1, [event(3)]);
  const delta = snapshotDelta(initial, clean);
  assert.equal(delta.event_reset, true);
  assert.deepEqual(mergeSpectatorDelta(initial, delta), clean);
  assert.equal(mergeSpectatorDelta(null, delta), null);
  const reconnected = frame(1, 0, []); // Full snapshots reset the stream after a restart.
  const first = frame(2, 1, [event(1)]);
  assert.deepEqual(mergeSpectatorDelta(reconnected, snapshotDelta(reconnected, first)), first);
});

test('movement-only delta replaces agents without losing prior history and history stays bounded', () => {
  const prior = frame(150, 1, Array.from({ length: 150 }, (_, i) => event(i)));
  const next = frame(151, 2, prior.events);
  assert.deepEqual(mergeSpectatorDelta(prior, snapshotDelta(prior, next)), next);
  const moved = mergeSpectatorDelta(next, { server_time: 152000, events: [event(150)] });
  assert.equal(moved.events.length, 150);
  assert.equal(moved.events[0].event_id, 'evt_1');
});

const v2 = (patch, extra = {}) => ({ protocol: 2, base_frame_id: 'start:1', frame_id: 'start:2', patch, ...extra });
const baseline = () => ({ ...frame(1, 1, [event(1)]), stream_frame_id: 'start:1' });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('v2 applies nested replacements without mutating the baseline or exposing envelope fields', () => {
  const previous = freeze(baseline()), update = freeze(v2([
    { op: 'replace', path: '/agents/0/position/x', value: 3 },
    { op: 'replace', path: '/room/world_revision', value: 2 },
    { op: 'replace', path: '/server_time', value: 2000 },
  ], { events: [event(2)] }));
  const next = mergeSpectatorDelta(previous, update);
  assert.deepEqual(next, { ...frame(2, 3, [event(1), event(2)]), stream_frame_id: 'start:2' });
  assert.equal(previous.agents[0].position.x, 1); assert.equal(previous.events.length, 1);
  assert.notEqual(next.agents, previous.agents);
  for (const key of ['protocol', 'base_frame_id', 'frame_id', 'patch', 'event_reset']) assert.equal(Object.hasOwn(next, key), false);
});

test('v2 supports removal, explicit null, nested array edits and reordered actors', () => {
  const previous = freeze({ ...baseline(), obsolete: true, selected: 'a', agents: [{ agent_id: 'a' }, { agent_id: 'b' }], choices: [1, 2] });
  const next = mergeSpectatorDelta(previous, v2([
    { op: 'remove', path: '/obsolete' }, { op: 'replace', path: '/selected', value: null },
    { op: 'move', from: '/agents/1', path: '/agents/0' },
    { op: 'remove', path: '/choices/0' }, { op: 'add', path: '/choices/-', value: 3 },
    { op: 'copy', from: '/choices', path: '/copied' }, { op: 'test', path: '/agents/0/agent_id', value: 'b' },
  ]));
  assert.equal(Object.hasOwn(next, 'obsolete'), false); assert.equal(next.selected, null);
  assert.deepEqual(next.agents.map(a => a.agent_id), ['b', 'a']); assert.deepEqual(next.choices, [2, 3]); assert.deepEqual(next.copied, [2, 3]);
  assert.deepEqual(previous.agents.map(a => a.agent_id), ['a', 'b']); assert.deepEqual(previous.choices, [1, 2]);
});

test('v2 rejects a missing, stale or different-connection baseline and deduplicates current frame IDs', () => {
  for (const previous of [null, frame(1, 1, []), { ...baseline(), stream_frame_id: 'other:1' }]) {
    assert.throws(() => mergeSpectatorDelta(previous, v2([])), error => error instanceof SpectatorFrameError && error.code === 'SPECTATOR_BASELINE_MISMATCH' && error.resync === true);
  }
  const previous = baseline(), next = mergeSpectatorDelta(previous, v2([], { events: [event(2)] }));
  assert.equal(mergeSpectatorDelta(next, v2([], { events: [event(2)] })), next);
  assert.equal(next.events.length, 2);
  assert.throws(() => mergeSpectatorDelta(next, v2([], { frame_id: 'start:3' })), { code: 'SPECTATOR_BASELINE_MISMATCH' });
  const reset = { ...baseline(), stream_frame_id: 'reconnect:1' };
  assert.equal(mergeSpectatorDelta(reset, v2([], { base_frame_id: 'reconnect:1', frame_id: 'reconnect:2' })).stream_frame_id, 'reconnect:2');
});

test('v2 append/reset and v1 reset both cap events at 150 without modifying input arrays', () => {
  const previous = freeze({ ...baseline(), events: Array.from({ length: 150 }, (_, i) => event(i)) });
  const appended = mergeSpectatorDelta(previous, v2([], { events: [event(150), event(151)] }));
  assert.equal(appended.events.length, 150); assert.equal(appended.events[0].event_id, 'evt_2'); assert.equal(previous.events[0].event_id, 'evt_0');
  const replacements = Array.from({ length: 151 }, (_, i) => event(1000 + i));
  for (const update of [v2([], { events: replacements, event_reset: true }), { events: replacements, event_reset: true }]) {
    const next = mergeSpectatorDelta(previous, update); assert.equal(next.events.length, 150); assert.equal(next.events[0].event_id, 'evt_1001');
    assert.equal(replacements.length, 151);
  }
  assert.deepEqual(mergeSpectatorDelta(previous, v2([], { event_reset: true })).events, []);
});

test('v2 invalid RFC6902 or prototype operations fail closed and leave baseline untouched', () => {
  const previous = freeze(baseline());
  for (const patch of [
    [{ op: 'unknown', path: '/agents' }], [{ op: 'remove', path: '/missing' }], [{ op: 'replace', path: '/agents/99', value: {} }],
    [{ op: 'test', path: '/room/world_revision', value: 999 }], [{ op: 'add', path: 'bad-pointer', value: 1 }],
    [{ op: 'add', path: '/__proto__/polluted', value: true }], [{ op: 'add', path: '/constructor/prototype/polluted', value: true }],
    [{ op: 'copy', from: '/__proto__', path: '/leaked' }], [{ op: 'replace', path: '', value: null }],
    [{ op: 'replace', path: '/agents/0/position/x', value: 9 }, { op: 'remove', path: '/missing' }],
  ]) assert.throws(() => mergeSpectatorDelta(previous, v2(patch)), { code: 'SPECTATOR_INVALID_PATCH', resync: true });
  assert.equal(previous.agents[0].position.x, 1); assert.equal({}.polluted, undefined);
});

test('v2 reserved stream metadata cannot be changed through patch, from or root replacement', () => {
  for (const key of ['events', 'stream_frame_id']) {
    for (const patch of [
      [{ op: 'add', path: '/' + key, value: [] }], [{ op: 'add', path: '/' + key + '/0', value: 'bad' }],
      [{ op: 'copy', from: '/' + key, path: '/copied' }], [{ op: 'move', from: '/' + key, path: '/moved' }],
      [{ op: 'replace', path: '', value: { [key]: 'injected' } }],
    ]) assert.throws(() => mergeSpectatorDelta(baseline(), v2(patch)), { code: 'SPECTATOR_INVALID_PATCH' });
  }
  for (const extra of [{ patch: {} }, { patch: [null] }, { events: {} }, { event_reset: 'yes' }, { frame_id: '' }, { frame_id: 2 }]) {
    assert.throws(() => mergeSpectatorDelta(baseline(), v2([], extra)), { code: 'SPECTATOR_INVALID_PATCH' });
  }
});

test('v1 deltas remain usable alongside v2 and HTTP display frames do not replace the SSE baseline', () => {
  const legacy = frame(1, 1, [event(1)]), legacyNext = frame(2, 2, [event(1), event(2)]);
  assert.deepEqual(mergeSpectatorDelta(legacy, snapshotDelta(legacy, legacyNext)), legacyNext);
  assert.equal(mergeSpectatorDelta(null, snapshotDelta(legacy, legacyNext)), null);
  const stream = baseline(), display = { ...frame(100, 99, []), stream_frame_id: 'http:100' };
  const delta = v2([{ op: 'replace', path: '/agents/0/position/x', value: 2 }]);
  assert.throws(() => mergeSpectatorDelta(display, delta), { code: 'SPECTATOR_BASELINE_MISMATCH' });
  assert.equal(mergeSpectatorDelta(stream, delta).agents[0].position.x, 2);
});
