import { WORLD_MAP, SCENE_IDS, SCENES, sceneDefinition, isWalkable } from '../shared/world-layout.js';
export { WORLD_MAP, SCENE_IDS, SCENES, sceneDefinition, isWalkable };
export const MAX_MOVE = 3;
export const sameScene = (a, b) => SCENE_IDS.includes(a?.scene_id) && a.scene_id === b?.scene_id;
export function isPositionInBounds(p) { return Number.isInteger(p?.x) && Number.isInteger(p?.y) && p.x >= 0 && p.x < WORLD_MAP.width && p.y >= 0 && p.y < WORLD_MAP.height; }
export function boundedPosition(p) {
  const coordinate = (value, size) => Math.max(0, Math.min(size - 1, Number.isFinite(value) ? Math.floor(value) : Math.floor(size / 2)));
  return { x: coordinate(p?.x, WORLD_MAP.width), y: coordinate(p?.y, WORLD_MAP.height) };
}
const key = p => `${p.x},${p.y}`;
const neighbors = p => [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }];
/** Bounded BFS, deterministic east/south/west/north ties. Includes start/end. */
export function findPath(sceneId, start, target, { maxSteps = WORLD_MAP.width * WORLD_MAP.height, allowed = () => true } = {}) {
  if (!isWalkable(sceneId, start) || !isWalkable(sceneId, target) || !allowed(target)) return null;
  const queue = [{ ...start }], previous = new Map([[key(start), null]]), depths = new Map([[key(start), 0]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i], depth = depths.get(key(p));
    if (key(p) === key(target)) { const path = []; for (let q = p; q; q = previous.get(key(q))) path.push(q); return path.reverse(); }
    if (depth >= maxSteps) continue;
    for (const next of neighbors(p)) if (isWalkable(sceneId, next) && allowed(next) && !previous.has(key(next))) {
      previous.set(key(next), p); depths.set(key(next), depth + 1); queue.push(next);
    }
  }
  return null;
}
export function nearestWalkable(sceneId, position) {
  const p = boundedPosition(position), candidates = [];
  for (let y = 0; y < WORLD_MAP.height; y++) for (let x = 0; x < WORLD_MAP.width; x++) if (isWalkable(sceneId, { x, y })) candidates.push({ x, y });
  return candidates.sort((a, b) => Math.abs(a.x-p.x)+Math.abs(a.y-p.y)-Math.abs(b.x-p.x)-Math.abs(b.y-p.y) || a.y-b.y || a.x-b.x)[0];
}
export function stepToward(position, target, maxStep = 1, sceneId = 'adventure', allowed) {
  const path = findPath(sceneId, position, target, { allowed });
  return path ? path[Math.min(path.length - 1, Math.max(0, Math.floor(maxStep)))] : { ...position };
}
export function movementOptions(position, sceneId = 'plaza') {
  const candidates = [], seen = new Set([key(position)]);
  for (const length of [1, MAX_MOVE]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const p = { x: position.x + dx*length, y: position.y + dy*length };
    const path = findPath(sceneId, position, p, { maxSteps: MAX_MOVE });
    if (!seen.has(key(p)) && path) { candidates.push({ ...p, path }); seen.add(key(p)); }
  }
  return { scene_id: sceneId, map: { ...WORLD_MAP }, max_step: MAX_MOVE, candidates };
}
export function initializeScene(a, now) {
  const oldScene = a.scene_id, original = { ...a.position };
  const p = a.adventure?.plan, e = a.adventure?.encounter;
  const wild = a.adventure?.in_field === true || p && (p.zone_id && p.zone_id !== 'camp' || p.monster_id) || e?.status === 'pending';
  a.scene_id = SCENE_IDS.includes(oldScene) ? oldScene : wild ? 'adventure' : 'plaza';
  a.position = nearestWalkable(a.scene_id, original);
  a.movement = null;
  if (!SCENE_IDS.includes(oldScene) || key(original) !== key(a.position)) a.scene_migration = {
    version: 1, at: now, reason: SCENE_IDS.includes(oldScene) ? 'terrain_repair' : wild ? 'legacy_adventure' : 'legacy_default_plaza',
    from_scene_id: SCENE_IDS.includes(oldScene) ? oldScene : null, scene_id: a.scene_id,
    from_position: original, position: { ...a.position },
  };
}
export function recordMovement(a, path, now, duration = 600) {
  a.position = { ...path.at(-1) };
  a.movement = { scene_id: a.scene_id, path: path.map(p => ({ ...p })), started_at: now, duration_ms: duration };
}
export function publicPath(sceneId, path) {
  if (!Array.isArray(path) || path.length < 1 || path.length > 4 || !path.every(p => isWalkable(sceneId, p)) ||
    path.some((p, i) => i > 0 && Math.abs(p.x-path[i-1].x)+Math.abs(p.y-path[i-1].y) !== 1)) return null;
  return path.map(({ x, y }) => ({ x, y }));
}
export function publicMovement(a) {
  const m = a.movement;
  if (!m || m.scene_id !== a.scene_id || !publicPath(m.scene_id, m.path) || key(m.path.at(-1)) !== key(a.position) || !Number.isSafeInteger(m.started_at) || m.started_at < 0 || !Number.isSafeInteger(m.duration_ms) || m.duration_ms < 1 || m.duration_ms > 1000) return null;
  return { scene_id: m.scene_id, path: m.path.map(({ x, y }) => ({ x, y })), started_at: m.started_at, duration_ms: m.duration_ms };
}
