// The renderer and simulation share these footprints. Coordinates refer to feet,
// not the top of a canopy/roof; ground texture never implies an obstacle.
export const WORLD_MAP = Object.freeze({ width: 24, height: 16 });
export const SCENE_IDS = Object.freeze(['plaza', 'adventure']);
const prop = (id, kind, x, y, footprint = [{ x, y }]) => ({ id, kind, position: { x, y }, footprint });
const cells = (x, y, width, height) => Array.from({ length: width * height }, (_, i) => ({ x: x + i % width, y: y + Math.floor(i / width) }));
const plazaProps = [
  prop('pond', 'pond', 3, 3, cells(2, 2, 3, 2)),
  prop('bookshop', 'bookshop', 19, 2, cells(18, 1, 3, 2)),
  prop('cottage', 'cottage', 7, 3, cells(6, 2, 3, 2)),
  prop('tool_shed', 'shed', 14, 5, cells(14, 4, 2, 2)),
  prop('games', 'game_table', 20, 13, cells(20, 13, 2, 1)),
  ...[[1,6],[3,8],[5,6],[7,13],[2,13],[16,13],[22,3],[21,5],[14,1],[10,2],[1,10],[22,14]].map(([x,y], i) => prop(`village_tree_${i}`, ['oak','birch','apple'][i % 3], x, y)),
  prop('well', 'well', 9, 5),
  prop('bench', 'bench', 4, 5),
  prop('portal', 'portal_plaza', 22, 8, []),
];
const adventureProps = [
  ...[[1,2],[3,1],[5,2],[7,1],[8,3],[1,5],[3,6],[5,5],[7,7],[1,9],[2,13],[5,14],[7,12],[8,14],[14,2],[16,1],[17,3],[22,2],[22,5],[15,10],[17,12],[20,13],[22,11],[11,13],[13,14]].map(([x,y], i) => prop(`forest_tree_${i}`, ['pine','pine_tall','dead_tree'][i % 3], x, y)),
  prop('ruin_arch', 'ruin_arch', 19, 4, [{ x: 18, y: 4 }, { x: 20, y: 4 }]),
  prop('ruin_column', 'ruin_column', 21, 7),
  prop('ruin_wall', 'ruin_wall', 18, 9, cells(17, 9, 2, 1)),
  ...[[5,8],[9,5],[14,6],[16,6],[21,10],[3,14]].map(([x,y], i) => prop(`forest_rock_${i}`, i % 2 ? 'rock_large' : 'rock', x, y)),
  prop('portal', 'portal_adventure', 11, 8, []),
];
function define(id, name, portal, props) {
  const blocked = [...new Map(props.flatMap(p => p.footprint).map(p => [`${p.x},${p.y}`, p])).values()];
  return { id, name, map: WORLD_MAP, portal, blocked, props };
}
export const SCENES = Object.freeze([
  define('plaza', '生活广场', { position: { x: 22, y: 8 }, to_scene_id: 'adventure', to_position: { x: 11, y: 8 } }, plazaProps),
  define('adventure', '林地冒险', { position: { x: 11, y: 8 }, to_scene_id: 'plaza', to_position: { x: 22, y: 8 } }, adventureProps),
]);
export function sceneDefinition(id) { return SCENES.find(scene => scene.id === id) || null; }
const blockedKeys = Object.fromEntries(SCENES.map(scene => [scene.id, new Set(scene.blocked.map(p => `${p.x},${p.y}`))]));
export function isWalkable(sceneId, position) {
  return !!blockedKeys[sceneId] && Number.isInteger(position?.x) && Number.isInteger(position?.y) && position.x >= 0 && position.y >= 0 && position.x < WORLD_MAP.width && position.y < WORLD_MAP.height && !blockedKeys[sceneId].has(`${position.x},${position.y}`);
}
