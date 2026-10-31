// The shared clock contract: positions are continuous tile coordinates, never a
// destination disguised as the current position. This module has no side effects.
export const MOTION_RULES = Object.freeze({ simulation_ms: 100, walk_speed: 2, run_speed: 3.5, run_energy_multiplier: 2, max_prediction_ms: 250 });
export const metric = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const pathLength = path => path.slice(1).reduce((n, p, i) => n + metric(path[i], p), 0);
export function facingBetween(a, b, fallback = 'south') {
  if (Math.abs(b.x-a.x) > 1e-8 && Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)) return b.x > a.x ? 'east' : 'west';
  if (Math.abs(b.y-a.y) > 1e-8) return b.y > a.y ? 'south' : 'north';
  return fallback;
}
export function samplePath(path, distance, fallback = 'south') {
  let remaining = Math.max(0, distance), position = { ...path[0] }, facing = fallback;
  for (let i = 1; i < path.length; i++) {
    const start = path[i-1], end = path[i], length = metric(start, end);
    if (!length) continue;
    facing = facingBetween(start, end, facing);
    if (remaining < length) {
      const t = remaining / length;
      position = { x: start.x+(end.x-start.x)*t, y: start.y+(end.y-start.y)*t };
      return { position, facing };
    }
    remaining -= length; position = { ...end };
  }
  return { position, facing };
}
export function sampleMotion(actor, now) {
  const movement = actor?.movement, position = actor?.position || { x: 0, y: 0 };
  if (movement?.version !== 2 || movement.scene_id !== actor.scene_id || !Array.isArray(movement.path) || movement.path.length < 2 || !Number.isFinite(movement.speed)) return { position: { ...position }, facing: actor?.facing || 'south', moving: false, mode: 'walk' };
  // A bounded prediction smooths broadcasts but cannot keep a disconnected role
  // moving indefinitely. Callers freeze their presentation clock on disconnect.
  const time = Math.min(now, (actor.position_at ?? movement.started_at) + MOTION_RULES.max_prediction_ms, movement.ends_at);
  const sampled = samplePath(movement.path, Math.max(0, time-movement.started_at)*movement.speed/1000, actor.facing);
  const frozen=now>(actor.position_at ?? movement.started_at)+MOTION_RULES.max_prediction_ms && time<movement.ends_at;
  return { ...sampled, moving: !frozen && time>=movement.started_at && time<movement.ends_at, frozen, mode: movement.mode };
}
export function actionPhase(action, now) {
  if (!action || action.type !== 'attack' || now < action.started_at || now >= action.ends_at) return null;
  if (action.outcome === 'cancelled') return 'cancelled';
  return now < action.impact_at ? 'prepare' : 'recovery';
}
