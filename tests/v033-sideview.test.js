import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyActors, journeyPoint, journeyCamera, journeyExecution, journeyMonsterLabel } from '../src/sideview-state.js';
import { characterAction } from '../src/pixel-state.js';
import { observerExecution } from '../src/world-services-state.js';

test('side-view renders real journey presence and the actual lower bypass lane', () => {
  const residents = [
    { agent_id: 'journey', scene_id: 'journey', status: 'active' },
    { agent_id: 'paused', scene_id: 'journey', status: 'paused' },
    { agent_id: 'legacy', scene_id: 'adventure', status: 'active' },
    { agent_id: 'plaza', scene_id: 'plaza', status: 'active' },
    { agent_id: 'home', scene_id: 'journey', status: 'active', home_presence: {} },
    { agent_id: 'offline', scene_id: 'journey', status: 'offline' },
  ];
  assert.deepEqual(journeyActors({ agents: residents }).map(a => a.agent_id), ['journey', 'paused']);
  assert.deepEqual(journeyPoint({ x: 18, y: 16 }), { x: 1184, lane: 0 });
  assert.deepEqual(journeyPoint({ x: 18, y: 18 }), { x: 1184, lane: 56 });
});

test('camera pans and stale snapshots never advance an actor or overwrite its world position', () => {
  const actor = { scene_id: 'journey', status: 'active', position: { x: 26, y: 16 } };
  const original = structuredClone(actor);
  assert.equal(journeyCamera({ actor, now: 5000, live: false, width: 800 }), 1408);
  assert.equal(journeyCamera({ actor: { ...actor, scene_id: 'plaza' }, now: 5000, live: true, width: 800, center: 2 }), 0);
  assert.equal(journeyCamera({ now: 5000, live: true, width: 800, center: 100 }), 2272);
  assert.deepEqual(actor, original);
});

test('execution and rest pose come only from a real bounded journey job', () => {
  const actor = { scene_id: 'journey', status: 'active', position: { x: 43, y: 16 }, journey_job: { intent: 'rest', phase: 'resting', started_at: 1000, ends_at: 20000, expires_at: 21000 } };
  assert.equal(journeyExecution(actor, 1500).text, '正在营地休息');
  assert.equal(observerExecution({}, actor, 1500).kind, 'journey');
  assert.equal(characterAction(actor, [], 1500), 'rest');
  assert.equal(characterAction(actor, [], 20001), 'idle');
  assert.equal(characterAction({ ...actor, scene_id: 'plaza' }, [], 1500), 'idle');
  assert.equal(characterAction({ ...actor, status: 'paused' }, [], 1500), 'idle');
  assert.equal(journeyExecution({ ...actor, journey_job: null }, 1500), null);
  assert.equal(journeyExecution(actor, 21001).text, '旅途行动等待服务器确认');
  assert.equal(observerExecution({}, { ...actor, status: 'paused' }, 1500).kind, 'paused');
});

test('monster labels distinguish genuine defeat from stale state without predicting a respawn', () => {
  assert.equal(journeyMonsterLabel({ status: 'alive', behavior: 'attacking' }, true), '正在交战');
  assert.equal(journeyMonsterLabel({ status: 'respawning', respawn_at: 10 }, true), '已被击败 · 等待重生');
  assert.equal(journeyMonsterLabel({ status: 'alive', behavior: 'attacking' }, false), '最近记录');
});
