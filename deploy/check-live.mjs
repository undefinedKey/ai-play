import assert from 'node:assert/strict';
import { SCENES, isWalkable } from '../shared/world-layout.js';

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
for (const capability of ['adventure', 'monster_ai', 'monster_patrol', 'movement_candidates', 'farming', 'farm_tools', 'inventory', 'equipment', 'opportunities', 'fatigue', 'persistent_appearance', 'pixel_world', 'runtime_health', 'recovery', 'reliable_events', 'gathering', 'cooking', 'trading', 'exploration_events', 'strategic_equipment', 'personal_goals']) assert.equal(health.capabilities[capability], true, capability);
const world = await (await response('/api/public/world')).json();
for (const capability of ['cooperation', 'public_history', 'head_speech_bubbles', 'independent_scenes', 'terrain_collision','phaser_renderer','scene_subscriptions']) assert.equal(health.capabilities[capability], true, capability);
for(const scene of ['plaza','adventure']) {
  const scoped=await(await response(`/api/public/world?scene=${scene}`)).json();
  assert.deepEqual(scoped.scope,{scene_id:scene,events:'scene',roster:'world'});
  assert.deepEqual(scoped.agents.map(a=>a.agent_id).sort(),world.agents.map(a=>a.agent_id).sort());
  if(scene==='plaza')assert.equal(scoped.adventure.monsters.length,0);
}
assert.deepEqual(world.scenes, SCENES);
assert.equal(world.life.plots_per_agent, 2);
assert.equal(world.life.crops.length, 2);
assert.deepEqual(world.life.tools.map(tool => tool.id), ['hoe', 'watering_can', 'axe', 'pickaxe']);
for (const tool of world.life.tools) assert.deepEqual(tool.levels.map(level => level.max_durability), ['axe', 'pickaxe'].includes(tool.id) ? [12, 24, 36] : [20, 40, 60]);
assert.equal(world.life.gathering.tool_required, false);
assert.deepEqual(world.life.gathering.resources.map(r => r.id), ['wood', 'ore']);
assert.deepEqual(world.life.recipes.filter(r => r.kind === 'cooking').map(r => r.item_id), ['turnip_soup', 'wheat_bread', 'trail_ration', 'moon_stew']);
assert.equal(health.capabilities.resource_nodes, true); assert.equal(health.capabilities.day_cycle, true);
assert.equal(world.resources.version, 1); assert.equal(world.resources.nodes.length, 9);
assert.ok(['day', 'dusk', 'night', 'dawn'].includes(world.day_cycle.phase));
assert.equal(world.day_cycle.cycle_seconds, 600);
for (const node of world.resources.nodes) {
  assert.ok(node.stock >= 0 && node.stock <= node.max_stock);
  assert.ok(isWalkable(node.scene_id, node.interaction_position));
}
assert.equal(world.life.market.stock_policy, 'per_agent_window');
assert.ok(world.life.market.items.some(i => i.buy_price > 0) && world.life.market.items.some(i => i.sell_price > 0));
assert.equal(world.fatigue.max_energy, 100);
assert.deepEqual(world.adventure.map, { width: world.room.width, height: world.room.height });
assert.equal(world.adventure.zones.length, 5);
assert.equal(world.adventure.monsters.length, 3);
for (const monster of world.adventure.monsters) {
  assert.ok(monster.home_position && monster.behavior);
  assert.equal(monster.aggro_radius, 3);
  assert.equal(monster.patrol_radius, 2);
  assert.equal(monster.patrol_interval_ms, 2000);
}
const manifest = await (await response('/pixel-world/manifest.json')).json();
// Scenes may reuse a ground texture; their authored terrain and prop placement
// are independent, and the renderer draws scene-specific paths over that texture.
assert.notDeepEqual(SCENES[0].props, SCENES[1].props);
for (const scene of SCENES) {
  assert.equal(manifest.scenes[scene.id].width, scene.map.width * 32);
  assert.equal(manifest.scenes[scene.id].height, scene.map.height * 32);
  assert.ok(isWalkable(scene.id, scene.portal.position));
  for (const prop of scene.props) {
    // The pond is painted into the scene's ground image; other props have sprites.
    if (prop.kind !== 'pond') assert.ok(manifest.props[prop.kind], prop.kind);
    for (const cell of prop.footprint) assert.equal(isWalkable(scene.id, cell), false);
  }
}
for (const agent of world.agents) {
  assert.ok(['plaza', 'adventure'].includes(agent.scene_id));
  assert.ok(isWalkable(agent.scene_id, agent.position));
  assert.equal(agent.life.plots.length, 2);
  for (const plot of agent.life.plots) assert.equal(typeof plot.tilled, 'boolean');
  for (const id of ['hoe', 'watering_can']) {
    const tool = agent.life.tools[id];
    assert.ok([1, 2, 3].includes(tool.level));
    assert.equal(tool.max_durability, tool.level * 20);
    assert.ok(Number.isInteger(tool.durability) && tool.durability >= 0 && tool.durability <= tool.max_durability);
  }
  assert.equal(agent.life.inventory, undefined);
  assert.equal(agent.life.ledger, undefined);
  assert.equal(agent.life.market, undefined);
  for (const id of ['wood', 'ore']) assert.ok(Number.isSafeInteger(agent.life.gather_ready_at[id]));
  if (agent.life.gathering) {
    const job = agent.life.gathering, node = world.resources.nodes.find(n => n.id === job.node_id);
    assert.ok(node ? node.item_id === job.resource_id : ['wood', 'ore'].includes(job.resource_id));
    assert.equal(agent.life.gathering.run_id, undefined);
    assert.equal(agent.life.gathering.session_epoch, undefined);
  }
  for (const field of ['owner_id', 'budget', 'goal', 'controllers', 'token', 'diagnostics', 'run', 'scene_migration', 'scene_stale_actions', 'next_action_id']) assert.equal(agent[field], undefined, field);
  assert.ok(['active', 'paused', 'offline', 'never_joined', 'unknown'].includes(agent.presence.state));
  assert.ok([true, false, null].includes(agent.presence.has_joined));
  for (const field of ['first_joined_at', 'last_seen_at', 'last_departed_at']) assert.ok(agent.presence[field] === null || Number.isSafeInteger(agent.presence[field]));
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
await response('/watch?view=plaza');
await response('/watch?view=farm');
assert.equal((await fetch(`${base}/api/world`, { signal: AbortSignal.timeout(10000) })).status, 401);
console.log(JSON.stringify({ version, agents: world.agents.length, active: world.agents.filter(a => a.status === 'active').length, pixel_images: paths.size, independent_scenes: true, scene_locations_valid: true, fatigue: true, appearance: true, public_privacy: true }));
