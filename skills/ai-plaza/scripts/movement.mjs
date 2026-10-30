// Portable movement geometry shared by the Skill bridge and standalone runner.
// No hard-coded map size: only server-provided geometry may legalize a direction.
const integer = Number.isSafeInteger;
const point = value => value && integer(value.x) && integer(value.y);
const clamp = (value, maximum) => Math.max(0, Math.min(maximum - 1, value));
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const MOVEMENT_GUIDANCE = 'move{x,y} 必须为整数：0≤x<movement.map.width、0≤y<movement.map.height，曼哈顿单步不超过 movement.max_step。movement.candidates 是合法落点示例，不限制其他合法细步。MOVE_ADJUSTED 表示原请求 requested 被截成本步 applied，只有服务确认 applied 才算执行，不能声称已到原目标。缺少可靠地图和步长时先观察规则，不猜尺寸。';

export function movementContext(observation = {}, rules = {}) {
  const map = observation.movement?.map ?? observation.adventure?.map ?? rules.adventure?.map ?? rules.room;
  const maxStep = observation.movement?.max_step ?? rules.max_move;
  const from = observation.self?.position;
  if (!map || !integer(map.width) || map.width < 1 || !integer(map.height) || map.height < 1 ||
      !integer(maxStep) || maxStep < 1 || !point(from) || from.x < 0 || from.x >= map.width || from.y < 0 || from.y >= map.height) return null;
  const legal = p => point(p) && p.x >= 0 && p.x < map.width && p.y >= 0 && p.y < map.height && distance(p, from) <= maxStep;
  const generated = [];
  for (const step of [1, maxStep]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    generated.push({ x: clamp(from.x + dx * step, map.width), y: clamp(from.y + dy * step, map.height) });
  }
  const source = Array.isArray(observation.movement?.candidates) ? observation.movement.candidates : generated;
  const candidates = [], seen = new Set();
  for (const p of source) {
    if (!legal(p) || p.x === from.x && p.y === from.y || seen.has(`${p.x}:${p.y}`)) continue;
    seen.add(`${p.x}:${p.y}`); candidates.push({ x: p.x, y: p.y });
    if (candidates.length === 8) break;
  }
  return { map: { width: map.width, height: map.height }, max_step: maxStep, candidates };
}

/** Clamp only the chosen direction; never choose a new destination or turn it into wait. */
export function normalizeMove(action, observation = {}, rules = {}) {
  if (action?.type !== 'move') return { action, adjustment: null };
  if (!point(action.payload) || Object.keys(action.payload).some(key => !['x', 'y'].includes(key))) {
    throw new TypeError('move 必须包含且只包含安全整数 x、y');
  }
  const movement = movementContext(observation, rules);
  if (!movement) return { action, adjustment: null }; // Unknown geometry is not permission to guess.
  const from = observation.self.position, requested = { ...action.payload };
  const target = { x: clamp(requested.x, movement.map.width), y: clamp(requested.y, movement.map.height) };
  const dx = target.x - from.x, dy = target.y - from.y;
  const x = BigInt(Math.abs(dx)), y = BigInt(Math.abs(dy)), total = x + y, maximum = BigInt(movement.max_step);
  let applied = target;
  if (total > maximum) {
    // Largest-remainder allocation keeps integer Manhattan steps in the requested
    // quadrant, approximately proportional to both axes; ties consistently use X.
    let sx = x * maximum / total, sy = y * maximum / total;
    if (sx + sy < maximum) {
      if (x * maximum % total >= y * maximum % total) sx++;
      else sy++;
    }
    applied = { x: from.x + Math.sign(dx) * Number(sx), y: from.y + Math.sign(dy) * Number(sy) };
  }
  if (applied.x === requested.x && applied.y === requested.y) return { action, adjustment: null };
  return { action: { type: 'move', payload: applied }, adjustment: { requested, applied, from: { ...from } } };
}

export function movementPromptContext(observation = {}, rules = {}) {
  const movement = movementContext(observation, rules);
  return movement ? { ...movement, candidates: movement.candidates.map(p => [p.x, p.y]) } : undefined;
}
