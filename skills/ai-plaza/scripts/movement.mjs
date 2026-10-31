// Portable movement geometry shared by the Skill bridge and standalone runner.
// No hard-coded map size: only server-provided geometry may legalize a direction.
const integer = Number.isSafeInteger;
const point = value => value && integer(value.x) && integer(value.y);
const physicalPoint = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
const EPSILON = 1e-7;
const clamp = (value, maximum) => Math.max(0, Math.min(maximum - 1, value));
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const MOVEMENT_GUIDANCE = 'move{x,y} 的目标使用本场景整数坐标；self.position是实际位置，连续运动时可以是小数。最短合法路径不超过movement.max_step；candidates给合法落点与path（含实际起点和终点），障碍不能直穿，普通move不穿门。支持movement.version=2时move/adventure_plan可选mode:walk|run，默认walk，速度/耗体见movement.modes；run由你选，不能偷偷代改。adventure_plan{intent:stop}停止移动和攻击，不带mode也不代表安全。move的applied只确认接受，是否抵达须读实际位置。旧服无地形时才按边界/曼哈顿截步；MOVE_ADJUSTED只确认applied，不代表到达requested。未知几何先读规则。';
export const SCENE_GUIDANCE = 'self.scene_id才是所在地，plaza广场/adventure冒险，同坐标不等于同地，in_field仅为战斗暴露。rules.scenes给各场景地图、入口和障碍。adventure_plan explore/hunt去冒险，rest/retreat或explore camp回广场；先走到门，再换场景，90秒总期限不续。plan.phase为to_portal走门/to_target走目标/resting休息，destination_scene_id是目的场景。stop停原地；生活/种田需plaza；nearby只同场景，跨场景交谈须显式group与group_id。';
export const sceneLabel = id => id === 'plaza' ? '广场' : id === 'adventure' ? '冒险' : undefined;
export const scenePromptText = (text, self) => self?.scene_id ? text.replaceAll('回营', '回广场').replaceAll('rest双恢复', 'rest回广场双恢复').replaceAll('explore到zone', 'explore走门到zone') : text;
export const inAdventureScene = self => self?.scene_id ? self.scene_id === 'adventure' : !!self?.adventure?.in_field;
export function sceneContext(observation = {}, rules = {}) {
  const id = observation.self?.scene_id;
  if (!id) return undefined;
  const scenes = Array.isArray(rules.scenes) ? rules.scenes : Object.values(rules.scenes || {}), scene = scenes.find(s => s.id === id);
  return { scene_id: id, ...(scene?.portal ? { portal: { position: scene.portal.position, to_scene_id: scene.portal.to_scene_id, to_position: scene.portal.to_position } } : {}) };
}

export function movementContext(observation = {}, rules = {}) {
  const sceneId = observation.self?.scene_id ?? observation.movement?.scene_id;
  if (observation.self?.scene_id && observation.movement?.scene_id && observation.self.scene_id !== observation.movement.scene_id) return null;
  const scenes = Array.isArray(rules.scenes) ? rules.scenes : Object.values(rules.scenes || {});
  const map = observation.movement?.map ?? scenes.find(s => s.id === sceneId)?.map ?? observation.adventure?.map ?? rules.adventure?.map ?? rules.room;
  const maxStep = observation.movement?.max_step ?? rules.max_move;
  const from = observation.self?.position;
  const continuous = observation.movement?.version === 2 || rules.movement?.version === 2;
  if (!map || !integer(map.width) || map.width < 1 || !integer(map.height) || map.height < 1 ||
      !integer(maxStep) || maxStep < 1 || !(continuous && sceneId ? physicalPoint(from) : point(from)) || from.x < 0 || from.x >= map.width || from.y < 0 || from.y >= map.height) return null;
  const legal = p => point(p) && p.x >= 0 && p.x < map.width && p.y >= 0 && p.y < map.height && distance(p, from) <= maxStep + EPSILON;
  const generated = [];
  for (const step of [1, maxStep]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    generated.push({ x: clamp(from.x + dx * step, map.width), y: clamp(from.y + dy * step, map.height) });
  }
  const source = Array.isArray(observation.movement?.candidates) ? observation.movement.candidates : sceneId ? [] : generated;
  const candidates = [], seen = new Set();
  for (const p of source) {
    if (!legal(p) || p.x === from.x && p.y === from.y || seen.has(`${p.x}:${p.y}`)) continue;
    let path;
    if (sceneId) {
      path = p.path;
      // Only the server can supply a walkable route. A v2 route may begin partway
      // along one grid edge; every subsequent waypoint remains an integer tile.
      if (!Array.isArray(path) || path.length < 2 || path.length > maxStep + (continuous ? 2 : 1) ||
          !path.every((q, i) => i === 0 && continuous ? physicalPoint(q) : point(q)) ||
          distance(path[0], from) > EPSILON || distance(path.at(-1), p) > EPSILON ||
          path.some((q, i) => q.x < 0 || q.y < 0 || q.x >= map.width || q.y >= map.height || i > 0 && (
            q.x !== path[i - 1].x && q.y !== path[i - 1].y ||
            (i === 1 && continuous ? distance(q, path[i - 1]) <= 0 || distance(q, path[i - 1]) > 1 + EPSILON : distance(q, path[i - 1]) !== 1))) ||
          path.reduce((length, q, i) => length + (i ? distance(q, path[i - 1]) : 0), 0) > maxStep + EPSILON) continue;
      path = path.map(q => ({ x: q.x, y: q.y }));
    }
    seen.add(`${p.x}:${p.y}`); candidates.push({ x: p.x, y: p.y, ...(path ? { path } : {}) });
    if (candidates.length === 8) break;
  }
  const modes = observation.movement?.modes ?? rules.movement?.modes;
  return { ...(sceneId ? { scene_id: sceneId } : {}), ...(continuous ? { version: 2, ...(modes ? { modes } : {}) } : {}), map: { width: map.width, height: map.height }, max_step: maxStep, candidates };
}

/** Clamp only the chosen direction; never choose a new destination or turn it into wait. */
export function normalizeMove(action, observation = {}, rules = {}) {
  if (action?.type !== 'move') return { action, adjustment: null };
  if (!point(action.payload) || Object.keys(action.payload).some(key => !['x', 'y', 'mode'].includes(key)) ||
      action.payload.mode !== undefined && !['walk', 'run'].includes(action.payload.mode)) {
    throw new TypeError('move 必须包含安全整数 x、y，只可另带 mode:walk|run');
  }
  const movement = movementContext(observation, rules);
  if (!movement) return { action, adjustment: null }; // Unknown geometry is not permission to guess.
  if (movement.scene_id) return { action, adjustment: null }; // Only the authoritative server knows the full blocked grid.
  const from = observation.self.position, requested = { x: action.payload.x, y: action.payload.y };
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
  return { action: { type: 'move', payload: { ...applied, ...(action.payload.mode ? { mode: action.payload.mode } : {}) } }, adjustment: { requested, applied, from: { ...from } } };
}

export function movementPromptContext(observation = {}, rules = {}) {
  const movement = movementContext(observation, rules);
  return movement ? { ...movement, ...(movement.modes ? { modes: Object.entries(movement.modes).map(([mode, spec]) => [mode, spec.speed, spec.energy_multiplier]) } : {}), candidates: movement.candidates.map(p => [p.x, p.y, ...(p.path ? [p.path.map(q => [q.x, q.y])] : [])]) } : undefined;
}

/** A short, public body-state summary, not a new goal or a synthetic decision. */
export function motionPromptNotice(observation = {}, rules = {}, compact = false) {
  const rule = observation.movement?.version === 2 ? observation.movement : rules.movement;
  if (rule?.version !== 2) return '';
  const self = observation.self || {}, now = observation.server_time;
  const left = at => Number.isFinite(at) && Number.isFinite(now) ? Math.max(0, Math.ceil((at - now) / 100) / 10) : null;
  const movement = self.movement, action = self.action;
  const labels = { north: '北', south: '南', east: '东', west: '西', walk: '走', run: '跑', prepare: '准备', recovery: '收招', cancelled: '取消' };
  const parts = [];
  if (labels[self.facing]) parts.push(`朝${labels[self.facing]}`);
  if (movement?.version === 2 && movement.scene_id === self.scene_id && ['walk', 'run'].includes(movement.mode) && Array.isArray(movement.path) && physicalPoint(movement.path.at(-1))) {
    const target = movement.path.at(-1), seconds = left(movement.ends_at);
    if (seconds !== null && seconds > 0) parts.push(`${labels[movement.mode]}往${target.x},${target.y}余${seconds}秒`);
  }
  if (action?.type === 'attack') {
    const seconds = left(action.ends_at), impact = left(action.impact_at);
    if (seconds !== null && seconds > 0) parts.push(`攻击${labels[action.phase] || (impact > 0 ? '准备' : '收招')}余${seconds}秒`);
  }
  const modes = rule.modes ?? rules.movement?.modes;
  const modesText = ['walk', 'run'].every(mode => Number.isFinite(modes?.[mode]?.speed) && Number.isFinite(modes?.[mode]?.energy_multiplier))
    ? `走/跑${modes.walk.speed}/${modes.run.speed}格秒、耗体×${modes.walk.energy_multiplier}/${modes.run.energy_multiplier}。` : '';
  const visibleParts = compact && labels[self.facing] ? parts.slice(1) : parts;
  return (compact ? '移动mode:walk|run走/跑，默认走，跑更耗体；stop禁mode；' :
    'move/adventure_plan可选mode:walk|run，默认walk，由你决定；adventure_plan{intent:stop}停移动/攻击，不带mode。' + modesText) +
    (compact ? '接受≠到达。' : '接受移动≠已到达；') + (visibleParts.length ? `当前${visibleParts.join('，')}。` : '') + '\n';
}
