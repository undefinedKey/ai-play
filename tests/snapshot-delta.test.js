import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDelta } from '../server/snapshot-delta.js';
const event = n => ({ event_id: `evt_${n}`, payload: { text: `记录${n}` } });
function merge(prior, delta) {
  const { event_reset, events, ...rest } = delta;
  return { ...prior, ...rest, events: event_reset ? events : events ? [...prior.events, ...events].slice(-150) : prior.events };
}
test('增量帧重建完整公开状态，仅发送新日志和变化字段', () => {
  const prior = { server_time: 1, room: { world_revision: 2 }, agents: [{ position: { x: 1, y: 1 } }], events: Array.from({ length: 150 }, (_, n) => event(n + 1)) };
  const next = { ...prior, server_time: 2, room: { world_revision: 3 }, agents: [{ position: { x: 2, y: 1 } }], events: [...prior.events.slice(1), event(151)] };
  const delta = snapshotDelta(prior, next);
  assert.deepEqual(delta.events, [event(151)]);
  assert.deepEqual(merge(prior, delta), next);
  assert.ok(JSON.stringify(delta).length < JSON.stringify(next).length / 5);
});
test('日志清理、超出窗口、重置和修改会发送重置，重连使用新快照', () => {
  const prior = { server_time: 1, events: [event(1), event(2)] };
  for (const events of [[], [event(3)], [{ ...event(1), payload: { text: 'changed' } }, event(2)], [event(2)]]) {
    const next = { server_time: 2, events };
    assert.deepEqual(merge(prior, snapshotDelta(prior, next)), next);
  }
});
