import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDelta } from '../server/snapshot-delta.js';
import { mergeSpectatorDelta } from '../src/spectator-frame.js';

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
