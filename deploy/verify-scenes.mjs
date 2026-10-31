// Independent, read-only release check: shared authored terrain is data, not the
// runtime migration implementation. Never print private states in release logs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SCENE_IDS, SCENES, WORLD_MAP } from '../shared/world-layout.js';

export function expectedScene(agent) {
  if (SCENE_IDS.includes(agent.scene_id)) return agent.scene_id;
  const a = agent.adventure || {}, plan = a.plan;
  return a.in_field === true || plan && (plan.zone_id && plan.zone_id !== 'camp' || plan.monster_id) || a.encounter?.status === 'pending' ? 'adventure' : 'plaza';
}

export function expectedPosition(agent) {
  const scene = expectedScene(agent), blocked = new Set(SCENES.find(s => s.id === scene).blocked.map(p => `${p.x},${p.y}`));
  const clamp = (n, size) => Number.isFinite(n) ? Math.max(0, Math.min(size - 1, Math.floor(n))) : Math.floor(size / 2);
  const origin = { x: clamp(agent.position?.x, WORLD_MAP.width), y: clamp(agent.position?.y, WORLD_MAP.height) };
  let best, bestDistance = Infinity;
  // Ascending rows/columns independently establish the deterministic tie break.
  for (let y = 0; y < WORLD_MAP.height; y++) for (let x = 0; x < WORLD_MAP.width; x++) {
    const distance = Math.abs(x - origin.x) + Math.abs(y - origin.y);
    if (!blocked.has(`${x},${y}`) && distance < bestDistance) { best = { x, y }; bestDistance = distance; }
  }
  assert.ok(best, 'each scene must have a legal cell');
  return best;
}

export function verifyScenes(old, current) {
  assert.deepEqual(Object.keys(current.agents).sort(), Object.keys(old.agents).sort(), 'same residents');
  const restart = current.events?.find(e => e.type === 'server_restarted' && Number(e.cursor) > old.sequence);
  let migrated = 0, repaired = 0;
  for (const [id, before] of Object.entries(old.agents)) {
    const after = current.agents[id], scene = expectedScene(before), position = expectedPosition(before);
    assert.equal(after.scene_id, scene, 'scene follows only authoritative saved evidence');
    assert.deepEqual(after.position, position, 'coordinates preserved unless authored terrain requires repair');
    assert.equal(after.movement, null, 'restart cannot replay movement');
    for (const field of ['agent_id', 'name', 'bio', 'avatar', 'color', 'owner_id', 'is_platform']) assert.deepEqual(after[field], before[field], 'identity unchanged');
    const changed = !SCENE_IDS.includes(before.scene_id) || before.position?.x !== position.x || before.position?.y !== position.y;
    if (!changed) { assert.deepEqual(after.scene_migration, before.scene_migration, 'existing migration record unchanged'); continue; }
    const record = after.scene_migration;
    assert.ok(Number.isSafeInteger(record?.at) && record.at >= 0, 'migration time recorded');
    assert.ok(restart && record.at <= restart.occurred_at && record.at >= Math.max(0, ...old.events.map(e => e.occurred_at)), 'migration took place at restart');
    assert.deepEqual(record, { version: 1, at: record.at,
      reason: SCENE_IDS.includes(before.scene_id) ? 'terrain_repair' : scene === 'adventure' ? 'legacy_adventure' : 'legacy_default_plaza',
      from_scene_id: SCENE_IDS.includes(before.scene_id) ? before.scene_id : null,
      scene_id: scene, from_position: { ...before.position }, position }, 'exact migration evidence retained');
    migrated++;
    if (before.position?.x !== position.x || before.position?.y !== position.y) repaired++;
  }
  assert.ok(!current.events.some(e => Number(e.cursor) > old.sequence && ['scene_changed', 'agent_moved'].includes(e.type)), 'migration must not invent gameplay');
  return { scene_locations_preserved: true, migrated, repaired };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifyScenes(old, current))); }
  catch (error) { process.stderr.write(`Scene migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
