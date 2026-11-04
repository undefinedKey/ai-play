// Read-only migration proof. Uses authored data, never runtime initializers.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { JOURNEY_MONSTERS } from '../shared/journey.js';

export function verifyJourney(old, current) {
  if (!old.journey && !current.journey) return { journey_state_preserved: true };
  const events = current.events.filter(e => Number(e.cursor) > old.sequence);
  const restarts = events.filter(e => e.type === 'server_restarted');
  assert.equal(restarts.length, 1);
  const at = restarts[0].occurred_at;
  const observedAt = Math.max(at, current.day_cycle?.last_at || 0, current.resources?.last_at || 0);
  const state = current.journey, previous = old.journey;
  assert.deepEqual(Object.keys(state).sort(), ['monsters','version']);
  assert.equal(state.version, 1);
  if (previous) {
    assert.deepEqual(Object.keys(previous).sort(), ['monsters','version']);
    assert.equal(previous.version, 1);
    assert.deepEqual(previous.monsters.map(m => m.monster_id).sort(), JOURNEY_MONSTERS.map(m => m.monster_id).sort());
  }
  assert.deepEqual(state.monsters.map(m => m.monster_id).sort(), JOURNEY_MONSTERS.map(m => m.monster_id).sort());
  const respawns = new Set();
  for (const def of JOURNEY_MONSTERS) {
    const before = previous?.monsters.find(m => m.monster_id === def.monster_id);
    const after = state.monsters.find(m => m.monster_id === def.monster_id);
    const initializedAt = after.position_at;
    assert.ok(Number.isSafeInteger(initializedAt) && initializedAt >= Math.max(0, ...old.events.map(e => e.occurred_at)) && initializedAt <= at);
    const revived = before?.status === 'respawning' && before.respawn_at <= observedAt;
    if (revived) respawns.add(def.monster_id);
    assert.deepEqual(after, {
      ...def, scene_id: 'journey', position_at: initializedAt, facing: 'west',
      hp: revived ? def.max_hp : before?.hp ?? def.max_hp,
      status: revived ? 'alive' : before?.status || 'alive',
      respawn_at: !revived && before?.status === 'respawning' ? before.respawn_at : null,
      contributions: {}, next_attack_at: revived ? observedAt : Math.max(initializedAt, before?.next_attack_at || 0),
      action: null, hurt: null, target_agent_id: null, behavior: 'idle',
    }, 'restart preserves damage and respawn deadline; it does not replay a battle');
  }
  const ended = events.filter(e => e.type === 'journey_finished');
  const jobs = Object.values(old.agents).filter(a => a.journey_job);
  assert.equal(ended.length, jobs.length);
  for (const [id, before] of Object.entries(old.agents)) {
    const after = current.agents[id];
    assert.equal(after.journey_job, null, 'no resumed journey after restart');
    if (!before.journey_job) assert.deepEqual(after.journey_last_result, before.journey_last_result ?? null);
    else {
      const resultAt = after.journey_last_result?.at;
      assert.ok(Number.isSafeInteger(resultAt) && resultAt >= before.journey_job.started_at && resultAt <= at);
      assert.deepEqual(after.journey_last_result, { kind: 'restarted', at: resultAt, intent: before.journey_job.intent });
      const matches = ended.filter(e => e.payload.agent_id === id);
      assert.equal(matches.length, 1);
      const event = matches[0];
      assert.ok(event.occurred_at >= resultAt && event.occurred_at <= at); assert.ok(Number(event.cursor) < Number(restarts[0].cursor));
      assert.deepEqual(event.payload, { scene_id: after.scene_id, agent_id: id, name: before.name,
        intent: before.journey_job.intent, reason: 'restarted',
        text: `${before.name}本次森林行程已结束（restarted），下一步由本人决定` });
    }
  }
  for (const event of events.filter(e => e.type.startsWith('journey_'))) {
    if (event.type === 'journey_finished') continue;
    assert.equal(event.type, 'journey_respawn', 'migration must not invent travel, fights, meals or rewards');
    const id = event.payload.monster_id, def = JOURNEY_MONSTERS.find(m => m.monster_id === id);
    assert.ok(respawns.delete(id), 'one real respawn per elapsed deadline');
    assert.deepEqual(event.payload, { scene_id: 'journey', monster_id: id, text: `${def.name}重新出现在林间路段` });
  }
  assert.equal(respawns.size, 0);
  return { journey_state_preserved: true };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifyJourney(old, current))); }
  catch (error) { process.stderr.write(`Journey migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
