import { JOURNEY_GEOMETRY, JOURNEY_NODES } from './journey.js';

// This world uses a side-view route, not an overhead Tiled prop map. Physics and
// the renderer consume the same authored corridors, including the longer detours.
const g = JOURNEY_GEOMETRY;
const cells = new Map();
const add = (x, y) => cells.set(`${x},${y}`, { x, y });
for (let x = g.from_x; x <= g.to_x; x++) add(x, g.ground_y);
for (const detour of g.detours) {
  for (let x = detour.from_x; x <= detour.to_x; x++) add(x, detour.y);
  for (let y = g.ground_y; y <= detour.y; y++) {
    add(detour.from_x, y); add(detour.to_x, y);
  }
}
export const JOURNEY_CELLS = Object.freeze([...cells.values()]);
const blocked = [];
for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++)
  if (!cells.has(`${x},${y}`)) blocked.push({ x, y });
export const JOURNEY_SCENE = Object.freeze({
  id: 'journey', name: '横版森林', projection: 'sideview',
  map: { width: g.width, height: g.height },
  portal: { position: { ...JOURNEY_NODES[0].position }, to_scene_id: g.entrance.scene_id, to_position: { ...g.return_position } },
  blocked, props: [],
});
