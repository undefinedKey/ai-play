const site = (id, name, scene_id, x, y, biome) => ({ id, name, scene_id, position: { x, y }, interaction_position: { x: x - 1, y }, biome, radius: 1 });
export const CAMP_SITES = Object.freeze([
  { ...site('journey_camp', '林间营地火塘', 'journey', 44, 16, 'woodland'), interaction_position: { x: 43, y: 16 } },
  site('plaza_hearth', '营地东侧火塘', 'plaza', 14, 11, 'meadow'),
  site('orchard_hearth', '林园空地', 'plaza', 28, 16, 'woodland'),
  site('trail_hearth', '林道宿营地', 'adventure', 17, 15, 'woodland'),
  site('ridge_hearth', '山脊下的宿营地', 'adventure', 31, 17, 'rockland'),
  site('herb_hearth', '深林宿营地', 'adventure', 38, 25, 'woodland'),
]);
export const SURVIVAL_RULES = Object.freeze({
  version: 1, max_satiety: 100, hungry_at: 30, satiety_per_second: .04,
  starvation_damage: 2, starvation_interval_seconds: 10,
  darkness_grace_seconds: 90, darkness_damage: 4, darkness_interval_seconds: 10,
  preparation_notice_seconds: 180, rescue_protection_seconds: 120,
  max_travel_seconds: 120, build_radius: 1, sites: CAMP_SITES,
  structures: [
    { id: 'campfire', name: '篝火', ingredients: { wood: 3, grass: 2 }, initial_fuel_seconds: 90, max_fuel_seconds: 300, light_radius: 5 },
    { id: 'firepit', name: '石围火塘', ingredients: { wood: 3, ore: 4 }, initial_fuel_seconds: 180, max_fuel_seconds: 600, light_radius: 6 },
  ],
  fuels: { wood: 60, grass: 15, pine_cone: 30 }, max_fuel_quantity: 5,
  torch: { item_id: 'torch', fuel_seconds: 90, light_radius: 3 },
  description: '饱食度只在在线且授权有效时每秒消耗0.04；低于30提醒，归零每10秒损失2生命。夜晚所有场景暗处累计90秒警示后每10秒损失4生命，白天或真正照亮后重新计算。篝火按固定可达宿营地建造，建造/添柴/料理必须本人已到附近，approach只走到地点不建火。火光同场景共享但不阻挡怪物；营地没有免费永明火。篝火燃料离线继续燃烧，烧尽须由AI添柴；暂停/断线/重启不会补扣个人饱食或伤害，也不会替AI补给或续任务。倒地沿用营地救援且获得120秒反应保护，保持原授权。',
});
