import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { expectedPosition, verifyScenes } from '../deploy/verify-scenes.mjs';
import { WORLD_MAP } from '../shared/world-layout.js';

test('v019 restart preserves an actual point on a walkable edge and cancels uncompleted movement/attack', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-motion-migration-'));
  let now = 2000000000000, world;
  try {
    const dbPath = join(directory, 'world.sqlite');
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const created = world.createAgent({ name: '原来的行者', bio: '原性格与记忆', owner_id: 'same-owner' });
    const a = world.agent(created.agent_id);
    a.position = { x: 11.375, y: 8 };
    a.position_at = now; a.facing = 'east';
    a.movement = { version: 2, movement_id: 'saved-move', scene_id: 'plaza', path: [{ x: 11, y: 8 }, { x: 12, y: 8 }], started_at: now - 187, duration_ms: 500, ends_at: now + 313, speed: 2, mode: 'walk' };
    a.action = { action_id: 'saved-attack', type: 'attack', scene_id: 'plaza', target_id: 'absent', target_kind: 'monster', facing: 'east', started_at: now - 10, impact_at: now + 200, ends_at: now + 600, phase: 'prepare', outcome: null, damage: 0, resolved_at: null };
    const before = structuredClone(world.state), hp = a.adventure.hp, inventory = structuredClone(a.life.inventory);
    world.close(); world = null; now += 60000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const after = structuredClone(world.state), restored = after.agents[a.agent_id];
    assert.deepEqual(restored.position, a.position, 'must not round position or complete saved destination');
    assert.equal(restored.adventure.hp, hp, 'restart must not replay unresolved damage');
    assert.deepEqual(restored.life.inventory, inventory);
    assert.equal(restored.facing, 'east');
    assert.equal(verifyScenes(before, after).scene_locations_preserved, true);
    for (const mutate of [
      s => { s.agents[a.agent_id].position.x = 11; },
      s => { s.agents[a.agent_id].position.x = 12; },
      s => { s.agents[a.agent_id].action = structuredClone(a.action); },
      s => { s.agents[a.agent_id].movement = structuredClone(a.movement); },
    ]) {
      const forged = structuredClone(after); mutate(forged);
      assert.throws(() => verifyScenes(before, forged));
    }
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('v019 independent migration verifier preserves only legal cardinal physical points', () => {
  for (const position of [{ x: 11.25, y: 8 }, { x: 11, y: 8.75 }, { x: 11, y: 8 }]) {
    assert.deepEqual(expectedPosition({ scene_id: 'plaza', position }), position);
  }
  for (const position of [{ x: 11.25, y: 8.25 }, { x: -0.1, y: 8 }, { x: WORLD_MAP.width, y: 8 }]) {
    assert.notDeepEqual(expectedPosition({ scene_id: 'plaza', position }), position);
  }
});
