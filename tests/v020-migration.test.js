import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { verifyResources } from '../deploy/verify-resources.mjs';
import { verifyScenes } from '../deploy/verify-scenes.mjs';
import { RESOURCE_NODES } from '../shared/resources-layout.js';

test('v020 actual SQLite upgrade preserves old identity, physical location and property; new tools start unowned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v020-upgrade-'));
  let now = 2000000000000, world;
  try {
    const dbPath = join(dir, 'world.sqlite');
    world = new World({ dbPath, now: () => now });
    const created = world.createAgent({ name: '原世界旅人', owner_id: 'original-owner', bio: '保留原身份与性格' });
    const a = world.agent(created.agent_id), controller = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 50, duration_minutes: 20 });
    a.position = { x: 11.25, y: 8 }; a.position_at = now;
    a.life.tools.hoe.durability = 4;
    a.life.inventory.wood = 7; a.life.inventory.ore = 3;
    a.adventure.gold = 27;
    // A v0.19 snapshot has no resource-world clock or resource tools.
    delete a.life.tools.axe; delete a.life.tools.pickaxe;
    delete world.state.resources; delete world.state.day_cycle;
    world.state.room.width = 24; world.state.room.height = 16;
    const before = structuredClone(world.state), oldAgent = before.agents[a.agent_id];
    world.close(); world = null; now += 5000;
    world = new World({ dbPath, now: () => now });
    const current = structuredClone(world.state), restored = current.agents[a.agent_id];
    for (const field of ['agent_id', 'owner_id', 'name', 'bio', 'appearance', 'position', 'run']) assert.deepEqual(restored[field], oldAgent[field], field);
    for (const field of ['inventory', 'equipment', 'plots', 'ledger', 'market']) assert.deepEqual(restored.life[field], oldAgent.life[field], field);
    assert.deepEqual(restored.life.tools.hoe, oldAgent.life.tools.hoe);
    assert.deepEqual(restored.life.tools.watering_can, oldAgent.life.tools.watering_can);
    for (const id of ['axe', 'pickaxe']) assert.deepEqual(restored.life.tools[id], { level: 1, durability: 0, max_durability: 12, owned: false });
    assert.equal(restored.adventure.gold, 27); assert.equal(restored.status, 'offline');
    assert.equal(current.room.width, 48); assert.equal(current.room.height, 32);
    assert.equal(verifyResources(before, current).nodes, RESOURCE_NODES.length);
    assert.equal(verifyScenes(before, current).scene_locations_preserved, true);
    for (const def of RESOURCE_NODES) assert.deepEqual(current.resources.nodes[def.id], { stock: def.max_stock, regrow_at: null, reservation: null });
    const forged = structuredClone(current); forged.resources.nodes.camp_branches.stock--;
    assert.throws(() => verifyResources(before, forged));
    const badClock = structuredClone(current); badClock.day_cycle.epoch_at = now + 1;
    assert.throws(() => verifyResources(before, badClock));
  } finally { world?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v020 restart keeps world epoch and resources, releases reservations, then regenerates only elapsed units', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v020-resource-restart-'));
  let now = 2000000000000, world;
  try {
    const dbPath = join(dir, 'world.sqlite');
    world = new World({ dbPath, now: () => now });
    const node = world.state.resources.nodes.camp_branches;
    node.stock = 0; node.regrow_at = now + 45000;
    node.reservation = { agent_id: 'old-worker', job_id: 'old-job', expires_at: now + 120000 };
    const before = structuredClone(world.state), epoch = before.day_cycle.epoch_at;
    world.close(); world = null; now += 60000;
    world = new World({ dbPath, now: () => now }); world.tick();
    const current = structuredClone(world.state);
    assert.equal(current.day_cycle.epoch_at, epoch);
    assert.deepEqual(current.resources.nodes.camp_branches, { stock: 1, regrow_at: epoch + 90000, reservation: null });
    assert.equal(verifyResources(before, current).day_cycle_preserved, true);
    const forged = structuredClone(current); forged.day_cycle.epoch_at++;
    assert.throws(() => verifyResources(before, forged));
    const forgedStock = structuredClone(current); forgedStock.resources.nodes.camp_branches.stock = 3;
    assert.throws(() => verifyResources(before, forgedStock));
  } finally { world?.close(); rmSync(dir, { recursive: true, force: true }); }
});
