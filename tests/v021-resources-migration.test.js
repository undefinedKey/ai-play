import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { RESOURCE_NODES } from '../shared/resources-layout.js';
import { verifyResources } from '../deploy/verify-resources.mjs';

const legacy = ['camp_branches', 'camp_stones', 'orchard_berries', 'east_pine', 'south_pine', 'wild_pine', 'ridge_ore', 'deep_berries', 'moon_herb'];
const now = 2000000000000;
function historicalV1() {
  return { sequence: 1, events: [], day_cycle: { version: 1, epoch_at: now, last_at: now }, resources: { version: 1, last_at: now,
    nodes: Object.fromEntries(RESOURCE_NODES.filter(n => legacy.includes(n.id)).map(n => [n.id, { stock: n.max_stock, regrow_at: null, reservation: null }])) } };
}
test('v021 verifier still accepts genuine nine-node v1-to-v1 snapshots without requiring new ecology', () => {
  const old = historicalV1(); old.resources.nodes.camp_branches = { stock: 1, regrow_at: now + 45000, reservation: null };
  const current = structuredClone(old); current.events = [{ type: 'server_restarted', cursor: '2', occurred_at: now + 50000 }];
  current.resources.last_at = current.day_cycle.last_at = now + 50000;
  current.resources.nodes.camp_branches = { stock: 2, regrow_at: now + 90000, reservation: null };
  assert.deepEqual(verifyResources(old, current), { resource_state_preserved: true, day_cycle_preserved: true, resource_version: 1, nodes: 9 });
  const forged = structuredClone(current); forged.resources.nodes.east_pine.stock = 2; assert.throws(() => verifyResources(old, forged));
});

function sqliteFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'v021-resource-migrate-')), dbPath = join(dir, 'world.sqlite'); let clock = now;
  let world = new World({ dbPath, now: () => clock });
  t.after(() => { world.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get world() { return world; }, restart(ms = 0) { const old = structuredClone(world.state); world.close(); clock += ms;
    world = new World({ dbPath, now: () => clock }); world.tick(); return { old, current: structuredClone(world.state) }; } };
}

test('v021 actual SQLite v1-to-v2 migration preserves partial/empty old trees and independently validates exact new ecology', t => {
  const f = sqliteFixture(t); f.world.state.resources = historicalV1().resources;
  f.world.state.resources.nodes.east_pine = { stock: 2, regrow_at: now + 120000, reservation: null };
  f.world.state.resources.nodes.south_pine = { stock: 0, regrow_at: now + 120000, reservation: { agent_id: 'old', job_id: 'old-work', expires_at: now + 100000 } };
  f.world.state.resources.nodes.camp_branches = { stock: 1, regrow_at: now + 45000, reservation: null };
  const { old, current } = f.restart(5000);
  const result = verifyResources(old, current); assert.equal(result.resource_version, 2); assert.equal(result.nodes, 32);
  assert.equal(current.resources.nodes.east_pine.stock, 2); assert.equal(current.resources.nodes.east_pine.ecology.stage, 'mature');
  assert.deepEqual(current.resources.nodes.south_pine.ecology, { stage: 'stump', stage_started_at: now + 5000, next_at: now + 65000, generation: 0, origin: 'wild' });
  assert.equal(current.resources.nodes.south_pine.regrow_at, now + 965000);
  assert.equal(current.resources.nodes.planting_plaza.stock, 0); assert.equal(current.resources.nodes.planting_plaza.ecology.next_at, null);
  for (const mutate of [s => s.resources.nodes.east_pine.stock++, s => s.resources.nodes.south_pine.ecology.next_at++,
    s => s.resources.nodes.planting_plaza.ecology.stage = 'mature', s => s.resources.nodes.village_tree_0.ecology.stage_started_at--,
    s => s.resources.nodes.camp_branches.regrow_at++, s => delete s.resources.nodes.wild_pine,
    s => s.resources.nodes.east_pine.reservation = { agent_id: 'old', job_id: 'replay', expires_at: now + 90000 }]) {
    const bad = structuredClone(current); mutate(bad); assert.throws(() => verifyResources(old, bad));
  }
});

test('v021 actual SQLite v2-to-v2 restart advances only elapsed phases and regeneration, preserving manual sites and generations', t => {
  const f = sqliteFixture(t);
  f.world.state.resources.nodes.east_pine = { stock: 0, regrow_at: now + 960000, reservation: null,
    ecology: { stage: 'stump', stage_started_at: now, next_at: now + 60000, generation: 3, origin: 'wild' } };
  f.world.state.resources.nodes.planting_plaza = { stock: 0, regrow_at: now + 600000,
    reservation: { agent_id: 'old', job_id: 'old', expires_at: now + 300000 },
    ecology: { stage: 'sapling', stage_started_at: now, next_at: now + 180000, generation: 2, origin: 'planted' } };
  f.world.state.resources.nodes.camp_branches = { stock: 0, regrow_at: now + 45000, reservation: null };
  const { old, current } = f.restart(200000);
  assert.equal(verifyResources(old, current).resource_state_preserved, true);
  assert.deepEqual(current.resources.nodes.east_pine.ecology, { stage: 'empty', stage_started_at: now + 60000, next_at: now + 360000, generation: 3, origin: 'wild' });
  assert.deepEqual(current.resources.nodes.planting_plaza.ecology, { stage: 'young', stage_started_at: now + 180000, next_at: now + 600000, generation: 2, origin: 'planted' });
  assert.equal(current.resources.nodes.camp_branches.stock, 1); assert.equal(current.resources.nodes.camp_branches.regrow_at, now + 645000, 'old due unit settles once; subsequent branches follow the new 600-second interval');
  assert.equal(current.resources.nodes.planting_adventure.ecology.stage, 'empty');
  for (const mutate of [s => s.resources.nodes.planting_plaza.ecology.generation++, s => s.resources.nodes.planting_adventure.ecology.next_at = now + 300000,
    s => s.resources.nodes.east_pine.ecology.stage_started_at++, s => s.resources.last_at = now - 1, s => s.day_cycle.epoch_at++, s => s.resources.version = 1]) {
    const bad = structuredClone(current); mutate(bad); assert.throws(() => verifyResources(old, bad));
  }
});
