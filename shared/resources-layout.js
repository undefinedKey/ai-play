// Authored entity positions are shared by simulation and rendering. Keep each
// interaction_position and its connecting route walkable when editing terrain.
import { PLAZA_RESOURCE_POSITIONS } from './plaza-layout.js';
const node = (id, kind, scene_id, x, y, ix, iy, item_id, options = {}) => ({
  id, kind, scene_id, position: { x, y }, interaction_position: { x: ix, y: iy }, item_id,
  radius: 1, max_stock: 3, regrow_seconds: 120, duration_seconds: 12, energy_cost: 4,
  yield_count: 1, tool_id: null, available_phases: ['day', 'dusk', 'night', 'dawn'], ...options,
});
const tree = (id, scene, x, y, options = {}) => node(id, 'tree', scene, x, y, x - 1, y, 'wood', {
  name: scene === 'plaza' ? '林间树木' : '荒野松木', tool_id: 'axe', yield_count: 3,
  duration_seconds: 14, energy_cost: 6, natural_regrowth: true, initial_stage: 'mature', ...options,
});
// Plaza positions come only from the portable layout; resource economics stay here.
const plazaNode = (id, kind, item, options={}) => {
  const geometry=PLAZA_RESOURCE_POSITIONS[id]; if(!geometry) throw new Error('Missing plaza resource geometry: '+id);
  return node(id,kind,'plaza',geometry.position.x,geometry.position.y,geometry.interaction_position.x,geometry.interaction_position.y,item,options);
};
const plazaTree = (id, options={}) => plazaNode(id,'tree','wood',{name:'林间树木',tool_id:'axe',yield_count:3,duration_seconds:14,energy_cost:6,natural_regrowth:true,initial_stage:'mature',...options});
export const RESOURCE_NODES = Object.freeze([
  tree('journey_pine', 'journey', 24, 15, { name: '林间空地松木', interaction_position: { x: 24, y: 16 }, yield_count: 3 }),
  node('journey_ore', 'ore_vein', 'journey', 29, 15, 29, 16, 'ore', { name: '空地露天矿', tool_id: 'pickaxe', yield_count: 3, duration_seconds: 18, energy_cost: 6, regrow_seconds: 180 }),
  node('journey_berries', 'berry_bush', 'journey', 40, 15, 40, 16, 'berry', { name: '营地浆果丛', max_stock: 3, duration_seconds: 8, energy_cost: 2, yield_count: 2 }),
  plazaNode('camp_branches', 'branches', 'wood', { name: '营地枯枝', regrow_seconds: 600 }),
  plazaNode('camp_stones', 'stones', 'ore', { name: '营地碎石', max_stock: 2, regrow_seconds: 60, duration_seconds: 18, energy_cost: 6 }),
  // Fallen fruit is a small shared resource, not a rescue grant. Anyone can
  // explicitly spend time collecting one portion; eating is a separate action.
  plazaNode('camp_fallen_berries', 'berry_bush', 'berry', { name: '营地落果处', max_stock: 1, regrow_seconds: 120, duration_seconds: 6, energy_cost: 0 }),
  plazaNode('orchard_berries', 'berry_bush', 'berry', { name: '荒园浆果丛', max_stock: 4, duration_seconds: 8, energy_cost: 3, yield_count: 2 }),
  plazaTree('east_pine', { name: '东坡松木' }),
  plazaTree('south_pine', { name: '南坡老松' }),
  tree('wild_pine', 'adventure', 29, 12, { name: '林地松木', yield_count: 4, duration_seconds: 16, energy_cost: 7 }),
  node('ridge_ore', 'ore_vein', 'adventure', 37, 9, 36, 9, 'ore', { name: '山脊矿脉', tool_id: 'pickaxe', yield_count: 3, duration_seconds: 20, energy_cost: 8, regrow_seconds: 180 }),
  node('deep_berries', 'berry_bush', 'adventure', 34, 22, 33, 22, 'berry', { name: '深林浆果丛', max_stock: 4, duration_seconds: 8, energy_cost: 3, yield_count: 3 }),
  node('moon_herb', 'herb', 'adventure', 41, 24, 40, 24, 'moon_herb', { name: '月光草', max_stock: 2, duration_seconds: 10, energy_cost: 4, available_phases: ['night', 'dawn'] }),
  plazaNode('meadow_grass', 'grass', 'grass', { name: '草甸草丛', max_stock: 4, regrow_seconds: 90, duration_seconds: 6, energy_cost: 2, yield_count: 2 }),
  node('wild_grass', 'grass', 'adventure', 25, 19, 24, 19, 'grass', { name: '荒野草丛', max_stock: 4, regrow_seconds: 90, duration_seconds: 6, energy_cost: 2, yield_count: 2 }),
  ...['village_tree_0','village_tree_1','village_tree_3','village_tree_6','village_tree_8','village_tree_9','village_tree_11'].map(id=>plazaTree(id)),
  plazaTree('village_tree_2', { name: '岸边树木' }),
  ...[
    ['forest_tree_0', 1, 2], ['forest_tree_1', 25, 3], ['forest_tree_3', 34, 3], ['forest_tree_4', 39, 4],
    ['forest_tree_9', 26, 15], ['forest_tree_10', 29, 17], ['forest_tree_13', 39, 15],
    ['forest_tree_16', 27, 25], ['forest_tree_18', 37, 28], ['forest_tree_24', 21, 22],
  ].map(([id, x, y]) => tree(id, 'adventure', x, y)),
  plazaTree('planting_plaza', { name: '广场植树空地', natural_regrowth: false, initial_stage: 'empty' }),
  tree('planting_adventure', 'adventure', 33, 26, { name: '荒野植树空地', natural_regrowth: false, initial_stage: 'empty' }),
]);
