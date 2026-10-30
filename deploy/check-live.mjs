import assert from 'node:assert/strict';

const version = process.argv[2];
const base = process.env.PLAZA_CHECK_URL || 'http://127.0.0.1:3000';
async function response(path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200, path);
  return res;
}
const health = await (await response('/api/health')).json();
assert.equal(health.ok, true);
assert.equal(health.version, version);
assert.equal(health.mode, 'accounts');
for (const capability of ['adventure', 'monster_ai', 'monster_patrol', 'movement_candidates', 'farming', 'inventory', 'equipment', 'opportunities', 'fatigue', 'persistent_appearance', 'pixel_world']) assert.equal(health.capabilities[capability], true, capability);
const world = await (await response('/api/public/world')).json();
assert.equal(world.life.plots_per_agent, 2);
assert.equal(world.life.crops.length, 2);
assert.equal(world.fatigue.max_energy, 100);
assert.deepEqual(world.adventure.map, { width: world.room.width, height: world.room.height });
assert.equal(world.adventure.zones.length, 3);
assert.equal(world.adventure.monsters.length, 3);
for (const monster of world.adventure.monsters) {
  assert.ok(monster.home_position && monster.behavior);
  assert.equal(monster.aggro_radius, 3);
  assert.equal(monster.patrol_radius, 2);
  assert.equal(monster.patrol_interval_ms, 2000);
}
const manifest = await (await response('/pixel-world/manifest.json')).json();
for (const agent of world.agents) {
  assert.equal(agent.life.plots.length, 2);
  assert.equal(agent.life.inventory, undefined);
  for (const field of ['owner_id', 'budget', 'goal', 'controllers', 'token']) assert.equal(agent[field], undefined, field);
  assert.ok(agent.life.stats.attack > 0 && agent.life.stats.effective_attack > 0);
  assert.ok(Number.isFinite(agent.fatigue.energy) && agent.fatigue.energy >= 0 && agent.fatigue.energy <= 100);
  assert.equal(agent.appearance.version, 1);
  assert.ok(manifest.characters[agent.appearance.sprite_id]);
  assert.ok(manifest.accessories[agent.appearance.accessory_id]);
}
const paths = new Set();
function images(value) {
  if (!value || typeof value !== 'object') return;
  if (value.image) paths.add(value.image);
  for (const child of Object.values(value)) images(child);
}
images(manifest);
for (const path of paths) {
  assert.match(path, /^\/pixel-world\/[a-z0-9_]+\.png$/);
  const bytes = Buffer.from(await (await response(path)).arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
}
await response('/watch?view=adventure');
assert.equal((await fetch(`${base}/api/world`, { signal: AbortSignal.timeout(10000) })).status, 401);
console.log(JSON.stringify({ version, agents: world.agents.length, active: world.agents.filter(a => a.status === 'active').length, pixel_images: paths.size, fatigue: true, appearance: true, public_privacy: true }));
