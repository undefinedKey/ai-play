// One authoritative grid for social movement, adventure plans and monster AI.
export const WORLD_MAP = Object.freeze({ width: 24, height: 16 });
export const MAX_MOVE = 3;

export function isPositionInBounds(position) {
  return Number.isInteger(position?.x) && Number.isInteger(position?.y)
    && position.x >= 0 && position.x < WORLD_MAP.width
    && position.y >= 0 && position.y < WORLD_MAP.height;
}

// Recovery for old persisted coordinates and deterministic server movement only.
// Client move requests are validated separately and are never silently changed.
export function boundedPosition(position) {
  const coordinate = (value, size) => Math.max(0, Math.min(size - 1,
    Number.isFinite(value) ? Math.floor(value) : Math.floor(size / 2)));
  return { x: coordinate(position?.x, WORLD_MAP.width), y: coordinate(position?.y, WORLD_MAP.height) };
}

export function stepToward(position, target, maxStep = 1) {
  const start = boundedPosition(position), end = boundedPosition(target);
  const limit = Number.isFinite(maxStep) ? Math.max(0, Math.floor(maxStep)) : 0;
  const dx = Math.sign(end.x - start.x) * Math.min(Math.abs(end.x - start.x), limit);
  const dy = Math.sign(end.y - start.y) * Math.min(Math.abs(end.y - start.y), limit - Math.abs(dx));
  return { x: start.x + dx, y: start.y + dy };
}

export function movementOptions(position) {
  const origin = boundedPosition(position), candidates = [], seen = new Set([`${origin.x},${origin.y}`]);
  for (const length of [1, MAX_MOVE]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const point = boundedPosition({ x: origin.x + dx * length, y: origin.y + dy * length });
    const key = `${point.x},${point.y}`;
    if (!seen.has(key)) { candidates.push(point); seen.add(key); }
  }
  return { map: { ...WORLD_MAP }, max_step: MAX_MOVE, candidates };
}
