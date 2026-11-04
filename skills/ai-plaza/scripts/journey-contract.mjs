// Portable authoritative contract: hosts and the world share the same choices.
export const JOURNEY_NODES = Object.freeze([
  { id: 'entry', name: '村口', position: { x: 2, y: 16 } },
  { id: 'path', name: '林间小径', position: { x: 12, y: 16 } },
  { id: 'clearing', name: '采集空地', position: { x: 26, y: 16 } },
  { id: 'camp', name: '林间营地', position: { x: 43, y: 16 } },
]);
export const JOURNEY_MONSTERS = Object.freeze([
  { monster_id: 'journey_slime', name: '苔光史莱姆', position: { x: 18, y: 16 }, max_hp: 24, attack: 3, xp: 12, gold: 6 },
  { monster_id: 'journey_boar', name: '林间野猪', position: { x: 35, y: 16 }, max_hp: 40, attack: 5, xp: 20, gold: 10 },
]);
export const JOURNEY_GEOMETRY = Object.freeze({
  width: 48, height: 32, ground_y: 16, from_x: 2, to_x: 44,
  detours: [{ from_x: 15, to_x: 21, y: 18 }, { from_x: 32, to_x: 38, y: 18 }],
  entrance: { scene_id: 'plaza', position: { x: 22, y: 8 } },
  return_position: { x: 22, y: 8 },
});
export const JOURNEY_RULES = Object.freeze({
  version: 1, scene_id: 'journey', view: 'sideview', map: JOURNEY_GEOMETRY, nodes: JOURNEY_NODES, monsters: JOURNEY_MONSTERS,
  max_job_seconds: 90, rest_seconds: { min: 15, max: 60 }, rest_energy_per_second: 2, rest_hp_per_second: 2,
  encounter_distance: 3, monster_attack_range: 3, monster_respawn_seconds: 120,
  traversal_policy: '只在接受本次有限行程时检查活怪；途中重生不追击或追溯取消已获准通过的路段，下次选择路线时重新检查。',
  resource_ids: ['journey_pine', 'journey_ore', 'journey_berries'], camp_site_id: 'journey_camp',
  description: '横版森林是一处真实共享场景。enter从广场实际步行到(22,8)入口后进入村口；travel只前往指定节点，direct在活怪3格前结束本次行程并报告遭遇，bypass是本人明确选择沿y18支路绕行，怪物不在世界追逐。hunt仅挑战一只明确怪物，90秒内执行攻击；怪物只对实际交战者反击。被打到四分之一血以下或体力不足会停止本次战斗；无自动吃药、撤退或下一场。rest须已在营地(43,16)，有饱食且满足实际光照才恢复，15至60秒后停止；夜晚可自行建火/点火或使用火把。采集沿用gather，食物沿用inventory use，取得食物不等于吃下。leave按本人所选路线返回村口后出场，stop只停止本人本次行程。所有同行者须各自选择行动，旁观镜头不改变位置。',
});
const obj = p => p && typeof p === 'object' && !Array.isArray(p);
const exact = (p, keys) => Object.keys(p).every(k => keys.includes(k));
const mode = p => p.mode === undefined || ['walk', 'run'].includes(p.mode);
const route = p => p.route === undefined || ['direct', 'bypass'].includes(p.route);
export function validJourney(p) {
  if (!obj(p)) return false;
  if (['browse', 'stop'].includes(p.intent)) return exact(p, ['intent']);
  if (p.intent === 'enter') return exact(p, ['intent', 'mode']) && mode(p);
  if (p.intent === 'leave') return exact(p, ['intent', 'mode', 'route']) && mode(p) && route(p);
  if (p.intent === 'travel') return exact(p, ['intent', 'node_id', 'mode', 'route']) && mode(p) && route(p) && JOURNEY_NODES.some(n => n.id === p.node_id);
  if (p.intent === 'hunt') return exact(p, ['intent', 'monster_id', 'mode']) && mode(p) && JOURNEY_MONSTERS.some(m => m.monster_id === p.monster_id);
  return p.intent === 'rest' && exact(p, ['intent', 'duration_seconds']) && Number.isInteger(p.duration_seconds) && p.duration_seconds >= 15 && p.duration_seconds <= 60;
}
