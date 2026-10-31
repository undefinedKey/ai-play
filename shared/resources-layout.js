// Authored entity positions are shared by simulation and rendering. Keep each
// interaction_position and its connecting route walkable when editing terrain.
const node = (id, kind, scene_id, x, y, ix, iy, item_id, options = {}) => ({
  id, kind, scene_id, position: { x, y }, interaction_position: { x: ix, y: iy }, item_id,
  radius: 1, max_stock: 3, regrow_seconds: 120, duration_seconds: 12, energy_cost: 4,
  yield_count: 1, tool_id: null, available_phases: ['day', 'dusk', 'night', 'dawn'], ...options,
});
export const RESOURCE_NODES = Object.freeze([
  node('camp_branches', 'branches', 'plaza', 10, 8, 11, 8, 'wood', { name: '营地枯枝', regrow_seconds: 45 }),
  node('camp_stones', 'stones', 'plaza', 12, 8, 11, 8, 'ore', { name: '营地碎石', max_stock: 2, regrow_seconds: 60, duration_seconds: 18, energy_cost: 6 }),
  node('orchard_berries', 'berry_bush', 'plaza', 27, 11, 26, 11, 'berry', { name: '荒园浆果丛', max_stock: 4, duration_seconds: 8, energy_cost: 3, yield_count: 2 }),
  node('east_pine', 'tree', 'plaza', 29, 7, 28, 7, 'wood', { name: '东坡松木', tool_id: 'axe', yield_count: 3, duration_seconds: 14, energy_cost: 6 }),
  node('south_pine', 'tree', 'plaza', 30, 21, 29, 21, 'wood', { name: '南坡老松', tool_id: 'axe', yield_count: 3, duration_seconds: 14, energy_cost: 6 }),
  node('wild_pine', 'tree', 'adventure', 29, 12, 28, 12, 'wood', { name: '林地松木', tool_id: 'axe', yield_count: 4, duration_seconds: 16, energy_cost: 7 }),
  node('ridge_ore', 'ore_vein', 'adventure', 37, 9, 36, 9, 'ore', { name: '山脊矿脉', tool_id: 'pickaxe', yield_count: 3, duration_seconds: 20, energy_cost: 8, regrow_seconds: 180 }),
  node('deep_berries', 'berry_bush', 'adventure', 34, 22, 33, 22, 'berry', { name: '深林浆果丛', max_stock: 4, duration_seconds: 8, energy_cost: 3, yield_count: 3 }),
  node('moon_herb', 'herb', 'adventure', 41, 24, 40, 24, 'moon_herb', { name: '月光草', max_stock: 2, duration_seconds: 10, energy_cost: 4, available_phases: ['night', 'dawn'] }),
]);
