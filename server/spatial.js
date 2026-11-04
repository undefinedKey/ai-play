import { randomUUID } from 'node:crypto';
import { WORLD_MAP, SCENE_IDS, SCENES, sceneDefinition, isWalkable as gridWalkable } from '../shared/world-layout.js';
import { MOTION_RULES, metric, pathLength, samplePath, facingBetween } from '../shared/motion.js';
import { ruinsCellAllowed } from '../shared/ruins-layout.js';
import { COMMUNITY_VENUES } from '../shared/community.js';
export { WORLD_MAP, SCENE_IDS, SCENES, sceneDefinition };
export const MOVEMENT_RULES = { version: 2, modes: { walk: { speed: MOTION_RULES.walk_speed, energy_multiplier: 1 }, run: { speed: MOTION_RULES.run_speed, energy_multiplier: 2 } }, max_step: 3, simulation_ms: 100 };
export const MAX_MOVE = 3;
export const sameScene = (a, b) => SCENE_IDS.includes(a?.scene_id) && a.scene_id === b?.scene_id && (a.home_presence?.home_id || null) === (b.home_presence?.home_id || null);
export function isPositionInBounds(p) { return Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.x <= WORLD_MAP.width-1 && p.y >= 0 && p.y <= WORLD_MAP.height-1; }
// A physical position may be between two walkable cardinal grid centers. Never
// accept a diagonal through the corner of a blocker.
export function isWalkable(sceneId, p) {
  if (!isPositionInBounds(p)) return false;
  if (Number.isInteger(p.x) && Number.isInteger(p.y)) return gridWalkable(sceneId, p);
  if (Number.isInteger(p.x)) return gridWalkable(sceneId, { x:p.x,y:Math.floor(p.y) }) && gridWalkable(sceneId, { x:p.x,y:Math.ceil(p.y) });
  if (Number.isInteger(p.y)) return gridWalkable(sceneId, { x:Math.floor(p.x),y:p.y }) && gridWalkable(sceneId, { x:Math.ceil(p.x),y:p.y });
  return false;
}
function physicalCells(p) {
  if (!isPositionInBounds(p)) return [];
  if (Number.isInteger(p.x) && Number.isInteger(p.y)) return [p];
  if (Number.isInteger(p.x)) return [{ x:p.x, y:Math.floor(p.y) }, { x:p.x, y:Math.ceil(p.y) }];
  if (Number.isInteger(p.y)) return [{ x:Math.floor(p.x), y:p.y }, { x:Math.ceil(p.x), y:p.y }];
  return [];
}
export function isWorldWalkable(world, sceneId, position) {
  if (!isWalkable(sceneId, position)) return false;
  return sceneId !== 'ruins' || physicalCells(position).every(cell => ruinsCellAllowed(world?.state?.ruins, cell));
}
export function boundedPosition(p) {
  const coordinate = (value, size) => Math.max(0, Math.min(size - 1, Number.isFinite(value) ? Math.floor(value) : Math.floor(size / 2)));
  return { x: coordinate(p?.x, WORLD_MAP.width), y: coordinate(p?.y, WORLD_MAP.height) };
}
const key = p => `${p.x},${p.y}`;
const neighbors = p => [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }];
const communityBodies = new Set(COMMUNITY_VENUES.flatMap(v => v.footprint.map(p => `${v.scene_id}:${p.x},${p.y}`)));
// An old save may stand where a newly installed table now is. Keep that exact
// position and permit one outward path, never a new destination or through-path.
const communityLegacyOrigin = (sceneId, p) => {
  const cells = physicalCells(p);
  return cells.length > 0 && cells.some(c => communityBodies.has(`${sceneId}:${key(c)}`))
    && cells.every(c => gridWalkable(sceneId,c) || communityBodies.has(`${sceneId}:${key(c)}`));
};
/** Bounded BFS, deterministic east/south/west/north ties. Includes start/end. */
export function findPath(sceneId, start, target, { maxSteps = WORLD_MAP.width * WORLD_MAP.height, allowed = () => true } = {}) {
  if ((!isWalkable(sceneId, start) && !communityLegacyOrigin(sceneId,start)) || !isWalkable(sceneId, target) || !allowed(target)) return null;
  if (metric(start,target) < 1e-8) return [{...start}];
  if ((start.x===target.x && Math.floor(start.y)===Math.floor(target.y) || start.y===target.y && Math.floor(start.x)===Math.floor(target.x)) && metric(start,target)<=1) return [{...start},{...target}];
  const integer = p => Number.isInteger(p.x) && Number.isInteger(p.y);
  const endpoints = p => integer(p) ? [p] : Number.isInteger(p.x) ? [{x:p.x,y:Math.floor(p.y)},{x:p.x,y:Math.ceil(p.y)}] : [{x:Math.floor(p.x),y:p.y},{x:Math.ceil(p.x),y:p.y}];
  if (!integer(start) || !integer(target)) {
    const candidates = [];
    for (const s of endpoints(start)) for (const t of endpoints(target)) {
      const middle = findPath(sceneId, s, t, { maxSteps: Math.ceil(maxSteps), allowed });
      if (!middle) continue;
      const path = [...(metric(start,s) ? [{...start}] : []), ...middle, ...(metric(t,target) ? [{...target}] : [])];
      if (pathLength(path) <= maxSteps + 1e-8) candidates.push(path);
    }
    return candidates.sort((a,b) => pathLength(a)-pathLength(b))[0] || null;
  }
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
/** Authoritative pathfinding combines authored walls and current mechanism
 * state. Check both cells under a fractional position before findPath's short
 * segment shortcut, so an AI cannot approach or cross a closed gate midway. */
export function findWorldPath(world, sceneId, start, target, { allowed = () => true, ...options } = {}) {
  // Existing scenes have no dynamic blockers. Preserve their original search
  // and avoid checking gate state for every ordinary world-path candidate.
  if (sceneId !== 'ruins') return findPath(sceneId, start, target, { ...options, allowed });
  const permitted = position => isWorldWalkable(world, sceneId, position) && physicalCells(position).every(allowed);
  if (!permitted(start) || !permitted(target)) return null;
  return findPath(sceneId, start, target, { ...options, allowed: permitted });
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
export function movementOptions(position, sceneId = 'plaza', world) {
  const candidates = [], seen = new Set([key(position)]);
  const origin = {x:Math.round(position.x),y:Math.round(position.y)};
  for (const length of [1, MAX_MOVE]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const p = { x: origin.x + dx*length, y: origin.y + dy*length };
    const path = findWorldPath(world, sceneId, position, p, { maxSteps: MAX_MOVE });
    if (!seen.has(key(p)) && path) { candidates.push({ ...p, path }); seen.add(key(p)); }
  }
  return { ...MOVEMENT_RULES, scene_id: sceneId, map: { ...WORLD_MAP }, max_step: MAX_MOVE, candidates };
}
export function initializeScene(a, now) {
  const oldScene = a.scene_id, original = { ...a.position };
  const p = a.adventure?.plan, e = a.adventure?.encounter;
  const wild = a.adventure?.in_field === true || p && (p.zone_id && p.zone_id !== 'camp' || p.monster_id) || e?.status === 'pending';
  a.scene_id = SCENE_IDS.includes(oldScene) ? oldScene : wild ? 'adventure' : 'plaza';
  a.position = isWalkable(a.scene_id, original) || communityLegacyOrigin(a.scene_id, original) ? original : nearestWalkable(a.scene_id, original);
  a.movement = null;
  a.action = null; a.hurt = null; a.position_at = now;
  a.facing = ['north','south','east','west'].includes(a.facing) ? a.facing : 'south';
  if (!SCENE_IDS.includes(oldScene) || key(original) !== key(a.position)) a.scene_migration = {
    version: 1, at: now, reason: SCENE_IDS.includes(oldScene) ? 'terrain_repair' : wild ? 'legacy_adventure' : 'legacy_default_plaza',
    from_scene_id: SCENE_IDS.includes(oldScene) ? oldScene : null, scene_id: a.scene_id,
    from_position: original, position: { ...a.position },
  };
}
export function recordMovement(a, path, now, mode = 'walk') {
  if (path.length < 2 || !pathLength(path)) { stopMovement(a, now); return; }
  mode = mode === 'run' ? 'run' : 'walk';
  const speed = MOVEMENT_RULES.modes[mode].speed, duration = Math.ceil(pathLength(path)/speed*1000);
  a.position_at = now; a.facing = facingBetween(path[0],path[1],a.facing);
  a.movement = { version: 2, movement_id: `move_${randomUUID()}`, scene_id: a.scene_id, path: path.map(p => ({ ...p })), started_at: now, ends_at: now+duration, duration_ms: duration, mode, speed, settled_distance:0 };
}
export function stopMovement(a, now) { if(a.movement || !Number.isFinite(a.position_at)) a.position_at=now; a.movement = null; }
export function advanceMovement(a, now, { until = now, maxDistance = Infinity, onDistance = () => {} } = {}) {
  const m = a.movement;
  if (!m || m.version !== 2) return false;
  const total = pathLength(m.path), previous = m.settled_distance || 0;
  const desired = Math.max(previous,Math.min(total, Math.max(0, Math.min(now,until)-m.started_at)*m.speed/1000));
  const next = Math.min(desired,previous+Math.max(0,maxDistance));
  const sampled = samplePath(m.path,next,a.facing);
  a.position = sampled.position; a.facing = sampled.facing; a.position_at = now;
  m.settled_distance = next;
  if (next > previous) onDistance(next-previous,m.mode,Math.min(now,until,Math.round(m.started_at+next/m.speed*1000)));
  if (next >= total-1e-8 || now >= until && until < now || next < desired) stopMovement(a,now);
  return next !== previous;
}
function publicRoute(sceneId, path, maxPoints, world) {
  if (!Array.isArray(path) || path.length < 1 || path.length > maxPoints || !path.every((p,i) => i===0 && path.length>1 && communityLegacyOrigin(sceneId,p) || isWalkable(sceneId, p) && (!world || isWorldWalkable(world, sceneId, p))) ||
    path.some((p, i) => i > 0 && (!(p.x===path[i-1].x || p.y===path[i-1].y) || metric(p,path[i-1]) > 1 || !metric(p,path[i-1])))) return null;
  return path.map(({ x, y }) => ({ x, y }));
}
export function publicPath(sceneId, path, world) { return publicRoute(sceneId, path, 6, world); }
export function publicMovement(a, world) {
  const m = a.movement;
  // A finite trip may span the map; the old short action-hint limit dropped
  // its entire timeline and made an actually running actor slide in idle pose.
  // Bound routes by map size (plus fractional start/end), validate every edge,
  // and derive duration from the real route and permitted speed instead.
  if (!m || m.version !== 2 || typeof m.movement_id!=='string' || m.movement_id.length>100 || m.scene_id !== a.scene_id || !publicRoute(m.scene_id, m.path, WORLD_MAP.width*WORLD_MAP.height+2, world) || !Number.isSafeInteger(m.started_at) || m.started_at < 0 || !Number.isSafeInteger(m.duration_ms) || m.duration_ms < 1 || !MOVEMENT_RULES.modes[m.mode] || m.speed!==MOVEMENT_RULES.modes[m.mode].speed || m.duration_ms!==Math.ceil(pathLength(m.path)/m.speed*1000) || !Number.isSafeInteger(m.ends_at) || m.ends_at!==m.started_at+m.duration_ms) return null;
  return { version:2, movement_id:m.movement_id, scene_id:m.scene_id, path:m.path.map(({x,y})=>({x,y})), started_at:m.started_at, ends_at:m.ends_at, duration_ms:m.duration_ms, mode:m.mode, speed:m.speed };
}
export function publicAction(a) {
  const x=a.action;
  if (!x || x.type!=='attack' || x.scene_id!==a.scene_id || !['prepare','recovery','cancelled'].includes(x.phase) || typeof x.action_id!=='string' || typeof x.target_id!=='string' || !['agent','monster'].includes(x.target_kind) || !['north','south','east','west'].includes(x.facing) || ![null,'hit','miss','cancelled'].includes(x.outcome) || ![x.started_at,x.impact_at,x.ends_at].every(t=>Number.isSafeInteger(t)&&t>=0) || x.resolved_at!==null && (!Number.isSafeInteger(x.resolved_at)||x.resolved_at<0) || !Number.isFinite(x.damage)||x.damage<0) return null;
  return { action_id:x.action_id,type:x.type,scene_id:x.scene_id,target_id:x.target_id,target_kind:x.target_kind,facing:x.facing,started_at:x.started_at,impact_at:x.impact_at,ends_at:x.ends_at,phase:x.phase,outcome:x.outcome,damage:x.damage,resolved_at:x.resolved_at };
}
export function publicHurt(a) { const x=a.hurt; return x && typeof x.action_id==='string' && [x.started_at,x.ends_at].every(t=>Number.isSafeInteger(t)&&t>=0) && Number.isFinite(x.damage)&&x.damage>=0 ? {action_id:x.action_id,started_at:x.started_at,ends_at:x.ends_at,damage:x.damage} : null; }
