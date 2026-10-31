import plaza from './maps/plaza.json' with { type: 'json' };
import adventure from './maps/adventure.json' with { type: 'json' };
import { compileWorldMaps } from './tiled-map.js';

// One authored source serves server collision, map editing and browser drawing.
export const WORLD_MAP = Object.freeze({ width: 24, height: 16 });
export const SCENE_IDS = Object.freeze(['plaza', 'adventure']);
export const SCENES = Object.freeze(compileWorldMaps([plaza, adventure]));
export function sceneDefinition(id) { return SCENES.find(scene => scene.id === id) || null; }
const blockedKeys = Object.fromEntries(SCENES.map(scene => [scene.id, new Set(scene.blocked.map(p => `${p.x},${p.y}`))]));
export function isWalkable(sceneId, position) {
  return !!blockedKeys[sceneId] && Number.isInteger(position?.x) && Number.isInteger(position?.y) && position.x >= 0 && position.y >= 0 && position.x < WORLD_MAP.width && position.y < WORLD_MAP.height && !blockedKeys[sceneId].has(`${position.x},${position.y}`);
}
