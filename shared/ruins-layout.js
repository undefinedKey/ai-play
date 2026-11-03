// Physical objects and approach cells shared by the authority, maps and viewers.
// Puzzle choices remain with the visiting AI; this file contains world facts.
const point = (x, y) => ({ x, y });
const object = (id, kind, name, x, y, ix, iy, extra = {}) => ({ id, kind, name, scene_id: 'ruins', position: point(x, y), interaction_position: point(ix, iy), ...extra });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export const RUINS_ITEMS = freeze([
  { id: 'ruins_bronze_key', name: '苔纹铜钥匙', kind: 'key', description: '在林间遗迹前庭发现的旧钥匙，可打开正门。' },
  { id: 'ruins_leaf_medallion', name: '叶纹纪念章', kind: 'relic', description: '林间遗迹内室仅有的一枚叶纹纪念章。' },
  { id: 'ruins_stone_bird', name: '石雕小鸟', kind: 'relic', description: '从林间遗迹带回的小鸟石雕，底座留着旧刻痕。' },
  { id: 'ruins_star_lens', name: '星光镜片', kind: 'relic', description: '林间遗迹保存的旧观星镜片。' },
]);

export const RUINS_OBJECTS = freeze([
  object('key_cache', 'key', '树洞旧匣', 8, 7, 8, 8, { item_id: 'ruins_bronze_key' }),
  object('main_gate', 'gate', '苔纹锁门', 17, 24, 16, 24, { blocked_cells: [point(17, 24)] }),
  object('broken_bridge', 'bridge', '断裂木桥', 17, 9, 16, 9, { blocked_cells: [point(17, 9)] }),
  object('dial_west', 'dial', '第一符文盘', 30, 12, 29, 12, { dial_index: 0 }),
  object('dial_middle', 'dial', '第二符文盘', 30, 16, 29, 16, { dial_index: 1 }),
  object('dial_east', 'dial', '第三符文盘', 30, 20, 29, 20, { dial_index: 2 }),
  object('rune_console', 'runes', '符文检验台', 32, 16, 32, 17),
  object('archive_gate', 'archive_gate', '内室石门', 34, 16, 33, 16, { blocked_cells: [point(34, 16)] }),
  object('mural', 'mural', '旧壁画', 24, 6, 24, 7),
  object('relic_leaf', 'relic', '叶纹纪念章展台', 39, 10, 38, 10, { item_id: 'ruins_leaf_medallion' }),
  object('relic_bird', 'relic', '石雕小鸟展台', 41, 16, 40, 16, { item_id: 'ruins_stone_bird' }),
  object('relic_lens', 'relic', '星光镜片展台', 39, 23, 38, 23, { item_id: 'ruins_star_lens' }),
]);
const byId = id => RUINS_OBJECTS.find(entry => entry.id === id);
export const RUINS_RULES = freeze({
  version: 1, scene_id: 'ruins', name: '林间遗迹', map: { width: 48, height: 32 },
  entrance: { scene_id: 'adventure', position: point(40, 8) },
  exit: { scene_id: 'ruins', position: point(6, 25) },
  key_item_id: 'ruins_bronze_key', bridge_cost: { wood: 4, ore: 1 }, repair_seconds: 12, repair_energy: 2,
  rune_symbols: ['leaf', 'sun', 'moon'],
  clue: '壁画从左到右刻着：月亮照着落叶，太阳随后升起。符文盘按第一、第二、第三的顺序排列。',
  key: byId('key_cache'), gate: byId('main_gate'), bridge: byId('broken_bridge'),
  runes: byId('rune_console'), archive_gate: byId('archive_gate'), mural: byId('mural'),
  dials: RUINS_OBJECTS.filter(entry => entry.kind === 'dial'), relics: RUINS_OBJECTS.filter(entry => entry.kind === 'relic'),
  objects: RUINS_OBJECTS,
});

// This is only the dynamic layer. Static walls and the cardinal edge geometry
// are enforced separately by spatial.isWorldWalkable/findWorldPath.
export function ruinsCellAllowed(state, position) {
  return [[RUINS_RULES.gate, 'gate_open'], [RUINS_RULES.bridge, 'bridge_repaired'], [RUINS_RULES.archive_gate, 'archive_open']]
    .every(([gate, flag]) => state?.[flag] === true || !gate.blocked_cells.some(cell => cell.x === position?.x && cell.y === position?.y));
}
