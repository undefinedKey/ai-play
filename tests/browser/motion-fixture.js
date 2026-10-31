import assert from 'node:assert/strict';

// Test-only clock driver: the product still owns position, costs and arrival.
export function advanceToArrival(world, agentId, target, advanceClock) {
  const a = world.agent(agentId), scene = a.scene_id;
  for (let step = 0; a.movement && step < 40; step++) {
    advanceClock(100); world.tick();
  }
  assert.equal(a.movement, null, 'bounded move must finish in the real simulation');
  assert.deepEqual(a.position, target, 'physical arrival is required before the next activity');
  assert.equal(a.scene_id, scene, 'ordinary walking does not cross a portal');
}
