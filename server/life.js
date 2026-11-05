import { isPositionInBounds, findWorldPath, recordMovement, stopMovement, sceneDefinition } from './spatial.js';
import { plazaServicePlace, PLAZA_RESOURCE_POSITIONS } from '../shared/plaza-layout.js';
import { FATIGUE_RULES, spendEnergy, attackMultiplier } from './fatigue.js';
import { randomUUID } from 'node:crypto';
import { MARKET_RULES, economyBalance, recordEconomyDelta, marketWindow, publicMarket, publicLedger } from './economy.js';
import { EQUIPMENT, STRATEGY_EQUIPMENT_RULES, combatStats } from './combat.js';
import { RESOURCE_RULES, TREE_RULES, resourceDefinition, reserveResource, resourceWorkAvailable, resourceHarvestItems, releaseResource, consumeResource, plantResource } from './resources.js';
import { DAY_RULES, publicDayCycle } from './day-cycle.js';
import { foodWouldRestoreSatiety, applyFoodSatiety, litCampfireNear } from './survival-state.js';
import { RUINS_ITEMS } from '../shared/ruins-layout.js';
export { combatStats } from './combat.js';

const ITEMS = [
  ...RUINS_ITEMS,
  { id: 'fishing_rod', name: '木制鱼竿', kind: 'tool' },
  { id: 'fish_bait', name: '草编鱼饵', kind: 'material' },
  { id: 'pond_fish', name: '池塘鱼', kind: 'food', heal: 4, satiety_restore: 15 },
  { id: 'silver_fish', name: '银鳞鱼', kind: 'food', heal: 8, energy_restore: 8, satiety_restore: 20 },
  { id: 'grilled_fish', name: '香烤池塘鱼', kind: 'food', heal: 16, energy_restore: 12, satiety_restore: 30 },
  { id: 'turnip_seed', name: '萝卜种子', kind: 'seed' },
  { id: 'wheat_seed', name: '小麦种子', kind: 'seed' },
  { id: 'turnip', name: '萝卜', kind: 'food', heal: 12, satiety_restore: 15 },
  { id: 'wheat', name: '小麦', kind: 'food', heal: 18, satiety_restore: 10 },
  { id: 'turnip_soup', name: '萝卜浓汤', kind: 'food', heal: 32, energy_restore: 0, satiety_restore: 35 },
  { id: 'wheat_bread', name: '麦香面包', kind: 'food', heal: 0, energy_restore: 24, satiety_restore: 35 },
  { id: 'berry', name: '野生浆果', kind: 'food', heal: 4, energy_restore: 2, satiety_restore: 12 },
  { id: 'roasted_berry', name: '篝火烤浆果', kind: 'food', heal: 4, energy_restore: 5, satiety_restore: 18 },
  { id: 'moon_herb', name: '月光草', kind: 'food', heal: 0, energy_restore: 12 },
  { id: 'trail_ration', name: '烤浆果口粮', kind: 'food', heal: 12, energy_restore: 18, satiety_restore: 30 },
  { id: 'moon_stew', name: '月草炖果', kind: 'food', heal: 20, energy_restore: 25, satiety_restore: 30 },
  { id: 'pine_cone', name: '松果', kind: 'seed' },
  { id: 'grass', name: '干草', kind: 'material' },
  { id: 'torch', name: '火把', kind: 'light' },
  { id: 'axe', name: '斧头', kind: 'tool' },
  { id: 'pickaxe', name: '镐', kind: 'tool' },
  { id: 'wood', scene_id: 'plaza', name: '木材', kind: 'material' },
  { id: 'ore', scene_id: 'plaza', name: '矿石', kind: 'material' },
  ...EQUIPMENT,
];
const CROPS = [
  { id: 'turnip', name: '萝卜', seed_id: 'turnip_seed', produce_id: 'turnip', grow_seconds: 120, yield_count: 2, seed_return: 1 },
  { id: 'wheat', name: '小麦', seed_id: 'wheat_seed', produce_id: 'wheat', grow_seconds: 180, yield_count: 2, seed_return: 1 },
];
const RECIPES = [
  { item_id: 'fishing_rod', ingredients: { wood: 2, grass: 2, ore: 1 }, kind: 'tool' },
  { item_id: 'fish_bait', ingredients: { grass: 1 }, kind: 'supply', energy_cost: 2, duration_seconds: 0, station_id: 'portable' },
  { item_id: 'grilled_fish', ingredients: { pond_fish: 1 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'lit_campfire' },
  { item_id: 'wooden_sword', ingredients: { wood: 3 } },
  { item_id: 'iron_sword', ingredients: { wood: 2, ore: 3 } },
  { item_id: 'wooden_shield', ingredients: { wood: 3 } },
  { item_id: 'iron_armor', ingredients: { ore: 5 } },
  { item_id: 'hunter_bow', ingredients: { wood: 5, ore: 1 } },
  { item_id: 'heavy_hammer', ingredients: { wood: 3, ore: 5 } },
  { item_id: 'heavy_armor', ingredients: { wood: 2, ore: 8 } },
  { item_id: 'turnip_soup', ingredients: { turnip: 2 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
  { item_id: 'wheat_bread', ingredients: { wheat: 2 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
  { item_id: 'trail_ration', ingredients: { berry: 2, wood: 1 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
  { item_id: 'moon_stew', ingredients: { berry: 1, moon_herb: 1 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
  { item_id: 'roasted_berry', ingredients: { berry: 1 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'lit_campfire' },
  { item_id: 'torch', ingredients: { wood: 1, grass: 2 }, kind: 'light', energy_cost: 2, duration_seconds: 0, station_id: 'portable' },
  { item_id: 'axe', ingredients: { wood: 2, ore: 1 }, kind: 'tool' },
  { item_id: 'pickaxe', ingredients: { wood: 2, ore: 2 }, kind: 'tool' },
];
const TOOLS = [
  { id: 'fishing_rod', name: '木制鱼竿', crafted: true, levels: [
    { level: 1, max_durability: 12, energy_cost: 3, upgrade_cost: {}, repair_cost: { wood: 1, grass: 1 } },
    { level: 2, max_durability: 24, energy_cost: 2, upgrade_cost: { wood: 3, grass: 2, ore: 2 }, repair_cost: { wood: 1, grass: 1 } },
    { level: 3, max_durability: 36, energy_cost: 1, upgrade_cost: { wood: 5, grass: 3, ore: 4 }, repair_cost: { wood: 2, grass: 1 } },
  ] },
  { id: 'hoe', name: '锄头', levels: [
    { level: 1, max_durability: 20, energy_cost: 3, upgrade_cost: {}, repair_cost: { wood: 1 } },
    { level: 2, max_durability: 40, energy_cost: 2, upgrade_cost: { wood: 3, ore: 2 }, repair_cost: { wood: 1, ore: 1 } },
    { level: 3, max_durability: 60, energy_cost: 1, upgrade_cost: { wood: 5, ore: 4 }, repair_cost: { wood: 2, ore: 1 } },
  ] },
  { id: 'watering_can', name: '水壶', levels: [
    { level: 1, max_durability: 20, energy_cost: 1, upgrade_cost: {}, repair_cost: { wood: 1 } },
    { level: 2, max_durability: 40, energy_cost: 0.75, upgrade_cost: { wood: 3, ore: 2 }, repair_cost: { wood: 1, ore: 1 } },
    { level: 3, max_durability: 60, energy_cost: 0.5, upgrade_cost: { wood: 5, ore: 4 }, repair_cost: { wood: 2, ore: 1 } },
  ] },
  ...['axe', 'pickaxe'].map((id, i) => ({ id, name: i ? '镐' : '斧头', crafted: true, levels: [
    { level: 1, max_durability: 12, energy_cost: i ? 8 : 6, duration_multiplier: 1, upgrade_cost: {}, repair_cost: { wood: 1, ore: 1 } },
    { level: 2, max_durability: 24, energy_cost: i ? 6 : 4, duration_multiplier: .85, upgrade_cost: { wood: 3, ore: 3 }, repair_cost: { wood: 1, ore: 2 } },
    { level: 3, max_durability: 36, energy_cost: i ? 4 : 3, duration_multiplier: .7, upgrade_cost: { wood: 5, ore: 5 }, repair_cost: { wood: 2, ore: 2 } },
  ] })),
];
export const LIFE_RULES = {
  camp_place: plazaServicePlace('camp'), farm_place: plazaServicePlace('farm'),
  crafting_place: plazaServicePlace('tools'), tool_place: plazaServicePlace('tools'),
  plots_per_agent: 2, crops: CROPS, items: ITEMS, recipes: RECIPES, tools: TOOLS,
  gathering: { version: 2, max_job_seconds: RESOURCE_RULES.max_job_seconds, stock_policy: 'global_shared', tool_required: false, resources: [
    { id: 'wood', scene_id: 'plaza', item_id: 'wood', name: '工坊拾枝处', ...PLAZA_RESOURCE_POSITIONS.camp_branches.position, service_center:PLAZA_RESOURCE_POSITIONS.camp_branches.position, interaction_position:PLAZA_RESOURCE_POSITIONS.camp_branches.interaction_position, radius: 1, duration_seconds: 12, energy_cost: 4, yield_count: 1, cooldown_seconds: 8 },
    { id: 'ore', scene_id: 'plaza', item_id: 'ore', name: '工坊碎矿堆', ...PLAZA_RESOURCE_POSITIONS.camp_stones.position, service_center:PLAZA_RESOURCE_POSITIONS.camp_stones.position, interaction_position:PLAZA_RESOURCE_POSITIONS.camp_stones.interaction_position, radius: 1, duration_seconds: 18, energy_cost: 6, yield_count: 1, cooldown_seconds: 12 },
  ], planting: TREE_RULES.planting, description: '旧wood/ore指令使用共享营地库存。start加node_id选择同场景资源，一次预约、真实走到开工，仅完成一份工作；成熟树最后一段另得松果，幼树/树桩不可砍。plant加node_id明确选择空林地，走到后工作4秒、2体力，完成扣1松果，不需斧头；cancel可中断。砍伐/采矿开工耗对应工具1耐久，夜间和等级影响采集成本；种树成本固定。任何完成不自动续采、换树或种植。' },
  cooking_place: plazaServicePlace('kitchen'),
  market: MARKET_RULES,
  strategy_equipment: STRATEGY_EQUIPMENT_RULES,
  description: '每个角色有两块专属田、个人仓库和持久的锄头/水壶。空地先用锄头开垦，种植消耗1种子，用水壶浇水一次后开始120/180秒生长，成熟需自己收获，得到2份食物并返还1种子，收获后需重新开垦。开垦/浇水各耗对应工具1耐久，工具升级降低该动作体力消耗；repair按当前等级repair_cost维修，upgrade消耗下一等级upgrade_cost，均回满耐久、各耗2体力；最高3级。工具独立于战斗装备，不可复制或装备到武器护甲槽。离线仍生长，没人替你耕作。农事在farm_place，非随身制作在crafting_place，工具维护在tool_place，料理在cooking_place，补给在market.place，各自须在对应service_center/radius内；穿脱装备在camp_place，且须先结束冒险计划、独处活动和参与中的多人游戏。食物可在野外使用，但不会退出危险状态或延长反应保护。',
};
const byId = new Map(ITEMS.map(item => [item.id, item]));
const slots = ['weapon', 'armor'];
const starter = { turnip_seed: 3, wheat_seed: 3, wood: 3 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validQuantity = value => Number.isSafeInteger(value) && value >= 0;
const count = (a, item) => validQuantity(a.life?.inventory?.[item]) ? a.life.inventory[item] : 0;
/** Shared validation for immediate inventory meals and explicitly chosen furniture meals. */
export function foodUseAvailable(a, itemId, fail) {
  const item = byId.get(itemId);
  if (item?.kind !== 'food') fail('INVALID_ACTION', '只有食物可以使用');
  if (!count(a, item.id)) fail('INSUFFICIENT_ITEMS', '仓库中没有这份食物');
  if (!a.adventure || !Number.isFinite(a.adventure.hp) || !Number.isFinite(a.adventure.max_hp)) fail('INVALID_ACTION', '角色生命状态不可用');
  if (!(item.heal > 0 && a.adventure.hp < a.adventure.max_hp || item.energy_restore > 0 && a.fatigue.energy < 100 || foodWouldRestoreSatiety(a, item))) fail(item.energy_restore ? 'FULL_ENERGY' : 'FULL_HEALTH', '这份食物能恢复的生命、体力和饱食状态均已满，未消耗食物');
  return item;
}
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyPlot = plot_id => ({ plot_id, tilled: false, tilled_at: null, crop_id: null, planted_at: null, watered_at: null, ready_at: null, ready_notified: false });
const ready = (plot, now) => plot.crop_id !== null && Number.isSafeInteger(plot.ready_at) && plot.ready_at <= now;
function normalizedTool(value, definition, grant = false) {
  const level = definition.levels.find(entry => entry.level === value?.level) || definition.levels[0];
  return { level: level.level, durability: validQuantity(value?.durability) ? Math.min(value.durability, level.max_durability) : grant ? level.max_durability : 0, max_durability: level.max_durability, ...(definition.crafted ? { owned: value?.owned === true } : {}) };
}
function normalizedPlot(p, id) {
  if (!p || !CROPS.some(crop => crop.id === p.crop_id)) return { ...emptyPlot(id), tilled: p?.tilled === true, tilled_at: p?.tilled === true ? time(p.tilled_at) : null };
  return { plot_id: id, tilled: true, tilled_at: time(p.tilled_at) ?? time(p.planted_at), crop_id: p.crop_id, planted_at: time(p.planted_at), watered_at: time(p.watered_at), ready_at: time(p.ready_at), ready_notified: p.ready_notified === true };
}

/** Idempotent compatibility initialization. Existing valid quantities are retained. */
export function initializeLife(a) {
  if (!plain(a.life)) a.life = {};
  const life = a.life;
  if (!plain(life.inventory)) life.inventory = {};
  for (const item of ITEMS) if (Object.hasOwn(life.inventory, item.id) && !validQuantity(life.inventory[item.id])) delete life.inventory[item.id];
  if (life.starter_granted !== true) {
    for (const [id, quantity] of Object.entries(starter)) life.inventory[id] = Math.min(Number.MAX_SAFE_INTEGER, count(a, id) + quantity);
    life.starter_granted = true;
  }
  const previous = Array.isArray(life.plots) ? life.plots : [];
  life.plots = ['plot_1', 'plot_2'].map(id => normalizedPlot(previous.find(plot => plot?.plot_id === id), id));
  const tools = plain(life.tools) ? life.tools : {};
  life.tools = Object.fromEntries(TOOLS.map(definition => [definition.id, normalizedTool(definition.crafted ? { ...tools[definition.id], owned: count(a, definition.id) > 0 } : tools[definition.id], definition, !definition.crafted && life.tools_granted !== true && !Object.hasOwn(tools, definition.id))]));
  life.tools_granted = true;
  life.gather_ready_at = Object.fromEntries(['wood', 'ore'].map(id => [id, time(life.gather_ready_at?.[id]) ?? 0]));
  if (!plain(life.gathering) || !(resourceDefinition(life.gathering.node_id) || LIFE_RULES.gathering.resources.some(resource => resource.id === life.gathering.resource_id)) ||
    typeof life.gathering.job_id !== 'string' || time(life.gathering.started_at) === null || life.gathering.phase !== 'approaching' && time(life.gathering.ends_at) === null) life.gathering = null;
  const equipment = plain(life.equipment) ? life.equipment : {};
  life.equipment = Object.fromEntries(slots.map(slot => {
    const item = byId.get(equipment[slot]);
    return [slot, item?.slot === slot && count(a, item.id) > 0 ? item.id : null];
  }));
}

export function equipmentStats(a) {
  const { attack_bonus, defense } = combatStats(a);
  return { attack_bonus, defense };
}

export function publicLife(a, now, { privateInventory = false, includeLedger = true } = {}) {
  const life = a.life || {}, stats = combatStats(a);
  return {
    plots: ['plot_1', 'plot_2'].map(id => {
      const p = normalizedPlot(life.plots?.find(plot => plot.plot_id === id), id);
      return { plot_id: id, tilled: p.tilled, tilled_at: p.tilled_at, crop_id: p.crop_id, planted_at: p.planted_at, watered_at: p.watered_at, ready_at: p.ready_at, ready: ready(p, now) };
    }),
    tools: Object.fromEntries(TOOLS.map(definition => [definition.id, normalizedTool(life.tools?.[definition.id], definition)])),
    equipment: Object.fromEntries(slots.map(slot => {
      const item = byId.get(life.equipment?.[slot]);
      return [slot, item?.slot === slot && count(a, item.id) > 0 ? item.id : null];
    })),
    stats: { ...stats, effective_attack: Math.max(1, Math.floor(stats.attack * attackMultiplier(a))), attack_multiplier: attackMultiplier(a) },
    gathering: publicGathering(a), gather_ready_at: Object.fromEntries(['wood', 'ore'].map(id => [id, time(life.gather_ready_at?.[id]) ?? 0])),
    ...(privateInventory ? { inventory: Object.fromEntries(ITEMS.filter(item => count(a, item.id) > 0).map(item => [item.id, count(a, item.id)])),
      market: publicMarket(a, now), ...(includeLedger ? { ledger: publicLedger(a, ITEMS.map(item => item.id)) } : {}) } : {}),
  };
}

function announce(world, a, type, text, extra = {}) {
  world.event(type, { agent_id: a.agent_id, name: a.name, text, ...extra }, [...new Set([a.agent_id, ...world.activeIds()])]);
}
export function serviceAvailable(world, a, place, fail) {
  if (a.fishing) fail('FISHING_BUSY', '请先结束当前垂钓');
  if (a.home_presence || a.home_travel) fail('HOME_BUSY', '家园室内与赴屋行程不能使用室外营地设施；请先用 home leave/cancel 返回室外并重新观察');
  if (a.scene_id !== place.scene_id) fail('SCENE_REQUIRED', '此生活设施在plaza；请自行选择返回及行走');
  const position = a.position;
  if (!isPositionInBounds(position) || Math.abs(position.x - place.service_center.x) + Math.abs(position.y - place.service_center.y) > place.radius)
    fail(place.id==='camp'?'NOT_AT_CAMP':'NOT_AT_SERVICE', `请先自行走到${place.name}站位(${place.service_center.x},${place.service_center.y})的${place.radius}格内`, { service_id:place.id, interaction_position:place.service_center, radius:place.radius });
  if (a.adventure?.plan || a.adventure?.in_field || a.survival?.travel || a.activity || a.movement) fail('ACTIVITY_BUSY', '请先结束当前计划、移动或活动，并返回安全营地');
  if (a.life?.gathering) fail('GATHER_BUSY', '请先取消当前采集或等待完成');
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前多人游戏，再照料农田、制作或换装');
}
export function campAvailable(world,a,fail) { return serviceAvailable(world,a,LIFE_RULES.camp_place,fail); }
export function lifeServiceFor(type,payload) {
  if(type==='farm') return LIFE_RULES.farm_place;
  if(type==='trade') return LIFE_RULES.market.place;
  if(type!=='inventory'||payload.intent==='use') return null;
  if(['repair','upgrade'].includes(payload.intent)) return LIFE_RULES.tool_place;
  if(payload.intent!=='craft') return LIFE_RULES.camp_place;
  const recipe=RECIPES.find(r=>r.item_id===payload.item_id);
  return ['portable','lit_campfire'].includes(recipe?.station_id)?null:recipe?.station_id==='kitchen'?LIFE_RULES.cooking_place:LIFE_RULES.crafting_place;
}
function craftAvailable(world, a, recipe, fail) {
  if (a.fishing) fail('FISHING_BUSY', '请先结束当前垂钓');
  if (!['portable', 'lit_campfire'].includes(recipe.station_id)) return serviceAvailable(world, a, recipe.station_id==='kitchen'?LIFE_RULES.cooking_place:LIFE_RULES.crafting_place, fail);
  if (a.adventure?.plan || a.survival?.travel || a.activity || a.movement) fail('ACTIVITY_BUSY', '请先结束当前计划、活动或移动再制作');
  if (a.life?.gathering) fail('GATHER_BUSY', '请先取消当前采集或等待完成');
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前多人游戏再制作');
  if (recipe.station_id === 'lit_campfire' && !litCampfireNear(world, a)) fail('FIRE_REQUIRED', '请实际走到同场景燃烧篝火的2格交互范围内再烹饪');
}
export function adjustInventory(a, changes, fail) {
  const next = {};
  for (const [id, delta] of Object.entries(changes)) {
    const value = count(a, id) + delta;
    if (!byId.has(id) || !Number.isSafeInteger(delta) || !Number.isSafeInteger(value) || value < 0) fail(value < 0 ? 'INSUFFICIENT_ITEMS' : 'INVENTORY_FULL', value < 0 ? '仓库里的材料或物品不足' : '该物品数量已达安全上限');
    next[id] = value;
  }
  for (const [id, value] of Object.entries(next)) a.life.inventory[id] = value;
}
function exact(payload, keys, fail) {
  if (!plain(payload) || Object.keys(payload).some(key => !keys.includes(key))) fail('INVALID_ACTION', '动作参数包含不支持的字段');
}

export function performLife(world, a, type, payload, fail) {
  initializeLife(a);
  if (type === 'gather') return performGather(world, a, payload, fail);
  if (type === 'trade') return performTrade(world, a, payload, fail);
  if (type === 'farm') {
    exact(payload, ['intent', 'plot_id', 'crop_id'], fail);
    if (!['till', 'plant', 'water', 'harvest'].includes(payload.intent) || typeof payload.plot_id !== 'string' || payload.intent !== 'plant' && payload.crop_id !== undefined) fail('INVALID_ACTION', 'farm 只接受 till/plant/water/harvest 与自己的 plot_id，只有种植可提供 crop_id');
    const plot = a.life.plots.find(p => p.plot_id === payload.plot_id);
    if (!plot) fail('NOT_AUTHORIZED', '只能操作自己的 plot_1 或 plot_2');
    serviceAvailable(world, a, LIFE_RULES.farm_place, fail);
    const toolId = payload.intent === 'till' ? 'hoe' : payload.intent === 'water' ? 'watering_can' : null;
    const tool = toolId ? a.life.tools[toolId] : null;
    const toolLevel = tool ? TOOLS.find(item => item.id === toolId).levels.find(entry => entry.level === tool.level) : null;
    if (tool && tool.durability < 1) fail('TOOL_BROKEN', '农具耐久已耗尽，请先维修或升级');
    if (!spendEnergy(world, a, payload.intent, toolLevel ? toolLevel.energy_cost / FATIGUE_RULES.costs[payload.intent] : 1)) fail('FATIGUE_EXHAUSTED', '体力不足以完成这次农事，可在营地休息后再试');
    if (payload.intent === 'till') {
      if (plot.crop_id !== null) fail('PLOT_OCCUPIED', '田里已有作物，不能重复开垦');
      if (plot.tilled) fail('ALREADY_TILLED', '这块田已经开垦，可直接种植');
      plot.tilled = true; plot.tilled_at = world.now(); tool.durability--;
      announce(world, a, 'life_tilled', `${a.name}用锄头开垦了自己的田地`, { plot_id: plot.plot_id, item_id: toolId, level: tool.level, durability: tool.durability });
    } else if (payload.intent === 'plant') {
      const crop = CROPS.find(crop => crop.id === payload.crop_id);
      if (!crop) fail('INVALID_ACTION', '请选择农田目录中的作物');
      if (plot.crop_id !== null) fail('PLOT_OCCUPIED', '这块田已有作物，请成熟收获后再种植');
      if (!plot.tilled) fail('PLOT_NOT_TILLED', '请先用 farm till 开垦这块空地');
      adjustInventory(a, { [crop.seed_id]: -1 }, fail);
      Object.assign(plot, { crop_id: crop.id, planted_at: world.now(), watered_at: null, ready_at: null, ready_notified: false });
      announce(world, a, 'life_planted', `${a.name}在自己的${plot.plot_id === 'plot_1' ? '一号' : '二号'}田种下了${crop.name}，等待浇水`, { plot_id: plot.plot_id, crop_id: crop.id });
    } else {
      const crop = CROPS.find(crop => crop.id === plot.crop_id);
      if (!crop) fail('PLOT_EMPTY', '这块田还没有作物');
      if (payload.intent === 'water') {
        if (plot.watered_at !== null) fail('ALREADY_WATERED', '已经浇水，无需重复浇水');
        tool.durability--;
        plot.watered_at = world.now(); plot.ready_at = world.now() + crop.grow_seconds * 1000; plot.ready_notified = false;
        announce(world, a, 'life_watered', `${a.name}用水壶给${crop.name}浇水，开始生长`, { plot_id: plot.plot_id, crop_id: crop.id, ready_at: plot.ready_at, item_id: toolId, level: tool.level, durability: tool.durability });
      } else {
        if (!ready(plot, world.now())) fail('CROP_NOT_READY', plot.watered_at === null ? '请先浇水，作物才会开始生长' : '作物尚未成熟');
        adjustInventory(a, { [crop.produce_id]: crop.yield_count, [crop.seed_id]: crop.seed_return }, fail);
        Object.assign(plot, emptyPlot(plot.plot_id));
        announce(world, a, 'life_harvested', `${a.name}收获了${crop.yield_count}份${crop.name}，并留下${crop.seed_return}颗种子`, { plot_id: plot.plot_id, crop_id: crop.id, item_id: crop.produce_id, quantity: crop.yield_count });
      }
    }
    return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }) };
  }
  if (type !== 'inventory') fail('INVALID_ACTION', '未知生活动作');
  exact(payload, ['intent', 'item_id', 'slot'], fail);
  if (!['craft', 'equip', 'unequip', 'use', 'repair', 'upgrade'].includes(payload.intent)) fail('INVALID_ACTION', '仓库只支持 craft/equip/unequip/use/repair/upgrade');
  if (['repair', 'upgrade'].includes(payload.intent)) {
    const definition = TOOLS.find(tool => tool.id === payload.item_id);
    if (payload.slot !== undefined || !definition) fail('INVALID_ACTION', '请选择工具目录中的 item_id');
    serviceAvailable(world, a, LIFE_RULES.tool_place, fail);
    const tool = a.life.tools[definition.id], current = definition.levels.find(level => level.level === tool.level);
    if (definition.crafted && !tool.owned) fail('TOOL_REQUIRED', '请先制作自己的采集工具');
    const next = payload.intent === 'upgrade' ? definition.levels.find(level => level.level === tool.level + 1) : current;
    if (!next) fail('TOOL_MAX_LEVEL', '工具已经达到最高3级');
    if (payload.intent === 'repair' && tool.durability >= tool.max_durability) fail('TOOL_FULL', '工具耐久已满，无需维修');
    if (!spendEnergy(world, a, payload.intent)) fail('FATIGUE_EXHAUSTED', '体力不足以维护工具，可在营地休息后再试');
    const cost = payload.intent === 'upgrade' ? next.upgrade_cost : current.repair_cost;
    adjustInventory(a, Object.fromEntries(Object.entries(cost).map(([id, quantity]) => [id, -quantity])), fail);
    Object.assign(tool, { level: next.level, durability: next.max_durability, max_durability: next.max_durability });
    announce(world, a, payload.intent === 'upgrade' ? 'life_tool_upgraded' : 'life_tool_repaired', `${a.name}${payload.intent === 'upgrade' ? '升级' : '维修'}了${definition.name}，等级${tool.level}，耐久恢复到${tool.durability}`, { item_id: definition.id, level: tool.level, durability: tool.durability, max_durability: tool.max_durability });
  } else if (payload.intent === 'unequip') {
    if (payload.item_id !== undefined || !slots.includes(payload.slot)) fail('INVALID_ACTION', '卸下装备只接受 slot: weapon 或 armor');
    campAvailable(world, a, fail);
    const itemId = a.life.equipment[payload.slot];
    if (!itemId) fail('NOT_EQUIPPED', '这个位置没有装备');
    a.life.equipment[payload.slot] = null;
    announce(world, a, 'life_equipped', `${a.name}卸下了${byId.get(itemId).name}`, { item_id: itemId, slot: payload.slot });
  } else {
    if (payload.slot !== undefined || typeof payload.item_id !== 'string' || !byId.has(payload.item_id)) fail('INVALID_ACTION', '请选择仓库目录中的 item_id');
    const item = byId.get(payload.item_id);
    if (payload.intent === 'craft') {
      const recipe = RECIPES.find(recipe => recipe.item_id === item.id);
      if (!recipe) fail('INVALID_ACTION', '这件物品没有制作配方');
      craftAvailable(world, a, recipe, fail);
      if (item.kind === 'tool' && count(a, item.id) > 0) fail('ALREADY_CRAFTED', '已经拥有这件工具，可选择维修或升级');
      if (!spendEnergy(world, a, 'craft')) fail('FATIGUE_EXHAUSTED', '体力不足以制作装备，可在营地休息后再试');
      adjustInventory(a, { ...Object.fromEntries(Object.entries(recipe.ingredients).map(([id, amount]) => [id, -amount])), [item.id]: 1 }, fail);
      if (item.kind === 'tool') { const definition = TOOLS.find(t => t.id === item.id), first = definition.levels[0]; a.life.tools[item.id] = { owned: true, level: 1, durability: first.max_durability, max_durability: first.max_durability }; }
      announce(world, a, 'life_crafted', `${a.name}${recipe.kind === 'cooking' ? '烹制' : '制作'}了${item.name}`, { item_id: item.id, quantity: 1 });
    } else if (payload.intent === 'equip') {
      campAvailable(world, a, fail);
      if (item.kind !== 'equipment') fail('INVALID_ACTION', '这件物品不能装备');
      if (!count(a, item.id)) fail('INSUFFICIENT_ITEMS', '需要先在自己的仓库中持有这件装备');
      if (a.life.equipment[item.slot] === item.id) fail('ALREADY_EQUIPPED', '已经装备了这件物品，不会叠加属性');
      a.life.equipment[item.slot] = item.id;
      announce(world, a, 'life_equipped', `${a.name}装备了${item.name}`, { item_id: item.id, slot: item.slot });
    } else {
      foodUseAvailable(a, item.id, fail);
      adjustInventory(a, { [item.id]: -1 }, fail);
      applyFoodSatiety(a, item.satiety_restore, world.now());
      a.adventure.hp = Math.min(a.adventure.max_hp, a.adventure.hp + (item.heal || 0));
      if (item.energy_restore) {
        a.fatigue.energy = Math.min(100, a.fatigue.energy + item.energy_restore);
        a.fatigue.updated_at = Math.max(a.fatigue.updated_at, world.now());
        if (a.fatigue.energy >= FATIGUE_RULES.rearm_at) a.fatigue.tired_notified = false;
      }
      announce(world, a, 'life_consumed', `${a.name}吃了${item.name}，补充身体所需`, { item_id: item.id, quantity: 1, hp: a.adventure.hp, energy: a.fatigue.energy, satiety: a.survival.satiety });
    }
  }
  return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }), hp: a.adventure?.hp };
}

const resourceDistance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const legacyNode = id => ({ wood: 'camp_branches', ore: 'camp_stones' })[id];
export function publicGathering(a) {
  const job = a.life?.gathering, resource = resourceDefinition(job?.node_id || legacyNode(job?.resource_id));
  if (!resource || typeof job.job_id !== 'string' || time(job.started_at) === null) return null;
  const phase = job.phase === 'approaching' ? 'approaching' : 'working', planting = job.intent === 'plant';
  return { job_id: job.job_id, node_id: resource.id, intent: planting ? 'plant' : 'harvest', resource_id: planting ? 'pine_cone' : ['wood', 'ore'].includes(job.resource_id) ? job.resource_id : resource.item_id,
    item_id: planting ? 'pine_cone' : resource.item_id, quantity: planting ? 0 : resource.yield_count, yield_count: planting ? 0 : resource.yield_count, scene_id: resource.scene_id, position: { ...resource.position },
    phase, mode: job.mode === 'run' ? 'run' : 'walk', started_at: job.started_at, work_started_at: time(job.work_started_at), ends_at: time(job.ends_at), expires_at: time(job.expires_at),
    duration_seconds: Number.isFinite(job.duration_seconds) ? job.duration_seconds : planting ? TREE_RULES.planting.duration_seconds : resource.duration_seconds,
    energy_cost: Number.isFinite(job.energy_cost) ? job.energy_cost : planting ? TREE_RULES.planting.energy_cost : resource.energy_cost, tool_id: planting ? null : resource.tool_id,
    day_phase: ['day', 'dusk', 'night', 'dawn'].includes(job.day_phase) ? job.day_phase : null };
}
export function cancelGather(world, a, reason = 'cancelled') {
  const raw = a.life?.gathering, job = publicGathering(a);
  if (raw) {
    releaseResource(world, raw);
    if (raw.movement_id && a.movement?.movement_id === raw.movement_id) stopMovement(a, world.now());
  }
  if (a.life) a.life.gathering = null;
  if (!job) return !!raw;
  const reasons = { cancelled: '本人取消', moved: '离开采集位置', interrupted: '控制已停止或中断', restarted: '服务重启', inventory_full: '仓库达到上限',
    expired: '本次有限采集期限已到', exhausted: '体力不足', hurt: '受到攻击', unavailable: '资源预约或时段已变化', unreachable: '交互位置不可达', tool_broken: '工具不可用', seed_missing: '松果已不足' };
  if (!Object.hasOwn(reasons, reason)) reason = 'interrupted';
  announce(world, a, 'life_gather_cancelled', `${a.name}停止了${job.intent === 'plant' ? '种树' : '采集'}：${reasons[reason]}，本次未完成`, { job_id: job.job_id, node_id: job.node_id, resource_id: job.resource_id, intent: job.intent, reason });
  return true;
}
function gatherTool(a, def) {
  const definition = TOOLS.find(tool => tool.id === def.tool_id), tool = a.life.tools[def.tool_id];
  return definition && tool?.owned && tool.durability > 0 ? { tool, level: definition.levels.find(l => l.level === tool.level), definition } : null;
}
function beginGatherWork(world, a, job, announceWork = true) {
  const def = resourceDefinition(job.node_id), current = publicDayCycle(world.state, world.now()), planting = job.intent === 'plant', tool = !planting && def.tool_id ? gatherTool(a, def) : null;
  if (!resourceWorkAvailable(world, a, job) || !def.available_phases.includes(current.phase)) return 'unavailable';
  if (planting && count(a, 'pine_cone') < 1) return 'seed_missing';
  if (!planting && def.tool_id && !tool) return 'tool_broken';
  const night = current.phase === 'night';
  const multiplier = tool ? tool.level.energy_cost / tool.definition.levels[0].energy_cost : 1;
  const energyCost = planting ? TREE_RULES.planting.energy_cost : Math.round(def.energy_cost * multiplier * (night ? DAY_RULES.night_work_energy_multiplier : 1) * 100) / 100;
  const duration = planting ? TREE_RULES.planting.duration_seconds * 1000 : Math.ceil(def.duration_seconds * (tool?.level.duration_multiplier || 1) * (night ? DAY_RULES.night_work_duration_multiplier : 1) * 1000);
  if (world.now() + duration >= job.expires_at) return 'expired';
  if (!spendEnergy(world, a, 'gather', energyCost)) return 'exhausted';
  if (tool) tool.tool.durability--;
  Object.assign(job, { phase: 'working', work_started_at: world.now(), ends_at: world.now() + duration, duration_seconds: duration / 1000, energy_cost: energyCost, day_phase: current.phase, movement_id: null });
  if (job.legacy) {
    const old = LIFE_RULES.gathering.resources.find(r => r.id === job.resource_id);
    a.life.gather_ready_at[job.resource_id] = job.ends_at + old.cooldown_seconds * 1000;
  }
  if (announceWork) announce(world, a, 'life_gather_working', `${a.name}已实际到达${def.name}，开始工作`, publicGathering(a));
  return null;
}
function advanceGatherApproach(world, a, job) {
  const def = resourceDefinition(job.node_id);
  if (a.movement) return { changed: false, durable: false };
  if (resourceDistance(a.position, def.position) <= def.radius) {
    const reason = beginGatherWork(world, a, job);
    if (reason) cancelGather(world, a, reason);
    return { changed: true, durable: true };
  }
  if (job.mode === 'run' && a.fatigue.energy <= 0) { cancelGather(world, a, 'exhausted'); return { changed: true, durable: true }; }
  const path = findWorldPath(world, a.scene_id, a.position, def.interaction_position);
  if (!path || path.length < 2) { cancelGather(world, a, 'unreachable'); return { changed: true, durable: true }; }
  recordMovement(a, path.slice(0, 2), world.now(), job.mode); job.movement_id = a.movement.movement_id;
  return { changed: true, durable: false };
}
function performGather(world, a, payload, fail) {
  exact(payload, ['intent', 'resource_id', 'node_id', 'mode'], fail);
  if (!['start', 'plant', 'cancel'].includes(payload.intent)) fail('INVALID_ACTION', '采集支持 start、plant 或 cancel');
  if (payload.intent === 'cancel') {
    if (payload.resource_id !== undefined || payload.node_id !== undefined || payload.mode !== undefined) fail('INVALID_ACTION', '取消采集只接受 intent');
    if (!a.life.gathering) fail('NO_GATHERING', '当前没有采集工作');
    cancelGather(world, a); return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }) };
  }
  const planting = payload.intent === 'plant', legacy = !planting && payload.node_id === undefined;
  if (legacy ? !['wood', 'ore'].includes(payload.resource_id) || payload.mode !== undefined : payload.resource_id !== undefined || typeof payload.node_id !== 'string') fail('INVALID_ACTION', '请选择一个 node_id；旧 wood/ore 与 node_id 不可混用');
  if (payload.mode !== undefined && !['walk', 'run'].includes(payload.mode)) fail('INVALID_ACTION', 'mode 只接受 walk 或 run');
  const resource = resourceDefinition(legacy ? legacyNode(payload.resource_id) : payload.node_id);
  if (!resource) fail('INVALID_ACTION', '请选择目录中的资源点');
  if (legacy) serviceAvailable(world, a, {id:resource.id,name:resource.name,scene_id:resource.scene_id,service_center:resource.position,radius:resource.radius}, (code,message,details)=>fail(code==='NOT_AT_SERVICE'?'NOT_AT_RESOURCE':code,message,details));
  else {
    if (a.scene_id !== resource.scene_id) fail('SCENE_REQUIRED', '请先自行选择探索或撤退进入该资源所在场景');
    if (a.life.gathering || a.adventure?.plan || a.survival?.travel || a.activity || a.movement || a.adventure?.encounter?.status === 'pending') fail('ACTIVITY_BUSY', '请先结束当前计划、移动、发现或采集');
    const game = world.state.game;
    if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前游戏');
  }
  if (legacy && resourceDistance(a.position, resource.position) > resource.radius) fail('NOT_AT_RESOURCE', '请先走到该资源点交互范围内');
  if (legacy && a.life.gather_ready_at[payload.resource_id] > world.now()) fail('GATHER_COOLDOWN', '采集冷却尚未结束', { retry_after_ms: a.life.gather_ready_at[payload.resource_id] - world.now() });
  if (planting && count(a, 'pine_cone') < 1) fail('INSUFFICIENT_ITEMS', '种树需要自己的1颗松果');
  if (!planting && resource.tool_id && !gatherTool(a, resource)) fail('TOOL_REQUIRED', '请先制作并维护对应工具');
  if (!planting && Object.entries(resourceHarvestItems(world.state, resource.id) || { [resource.item_id]: resource.yield_count }).some(([id, quantity]) => count(a, id) > Number.MAX_SAFE_INTEGER - quantity)) fail('INVENTORY_FULL', '本次采集或砍倒树的产物将超出仓库上限');
  if (payload.mode === 'run' && a.fatigue.energy <= 0) fail('FATIGUE_EXHAUSTED', '体力不足以奔跑，可自行选择步行');
  if (!findWorldPath(world, a.scene_id, a.position, resource.interaction_position)) fail('UNREACHABLE', '资源交互位置暂不可达');
  const job = { job_id: `gather_${randomUUID()}`, node_id: resource.id, intent: planting ? 'plant' : 'harvest', resource_id: planting ? 'pine_cone' : legacy ? payload.resource_id : resource.item_id, legacy,
    scene_id: a.scene_id, phase: 'approaching', mode: payload.mode || 'walk', started_at: world.now(), work_started_at: null, ends_at: null,
    expires_at: Math.min(a.run.expires_at, world.now() + RESOURCE_RULES.max_job_seconds * 1000), run_id: a.run.run_id, session_epoch: a.session_epoch,
    hp_at_start: a.adventure.hp, hurt_id_at_start: a.hurt?.action_id || null, movement_id: null };
  reserveResource(world, a, resource.id, job.job_id, job.expires_at, fail, job.intent); a.life.gathering = job;
  if (a.scene_id === 'adventure' && resourceDistance(a.position, sceneDefinition('adventure').portal.position) > 2) a.adventure.in_field = true;
  if (resourceDistance(a.position, resource.position) <= resource.radius) {
    const reason = beginGatherWork(world, a, job, false);
    if (reason) fail(reason === 'exhausted' ? 'FATIGUE_EXHAUSTED' : 'GATHER_UNAVAILABLE', '当前无法开始这次工作，请重新观察');
  } else advanceGatherApproach(world, a, job);
  announce(world, a, 'life_gather_started', `${a.name}选择在${resource.name}${planting ? '种树' : '采集'}，${job.phase === 'working' ? '开始一次工作' : '正在前往交互位置'}，完成后等待自己决定下一步`, publicGathering(a));
  return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }) };
}
function performTrade(world, a, payload, fail) {
  exact(payload, ['intent', 'item_id', 'quantity'], fail);
  if (!['buy', 'sell'].includes(payload.intent) || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > MARKET_RULES.max_quantity) fail('INVALID_ACTION', '交易只接受 buy/sell 与1至10的整数数量');
  const offer = MARKET_RULES.items.find(entry => entry.item_id === payload.item_id), buying = payload.intent === 'buy';
  const price = offer?.[buying ? 'buy_price' : 'sell_price'];
  if (!Number.isSafeInteger(price) || price <= 0) fail('TRADE_UNAVAILABLE', '补给柜不支持这件物品的该方向交易');
  serviceAvailable(world, a, LIFE_RULES.market.place, fail);
  const window = marketWindow(a, world.now()), key = buying ? 'bought' : 'sold', limit = buying ? MARKET_RULES.buy_limit : MARKET_RULES.sell_limit;
  if (window[key] + payload.quantity > limit) fail('TRADE_LIMIT', '本窗口交易额度不足，可等待刷新或选择其他事情');
  const amount = price * payload.quantity, gold = a.adventure.gold;
  if (!Number.isSafeInteger(gold) || gold < 0 || !Number.isSafeInteger(gold + (buying ? -amount : amount))) fail('INVALID_ACTION', '金币余额不符合安全范围');
  if (buying && gold < amount) fail('INSUFFICIENT_GOLD', '金币不足，可自行采集或交售已有物品');
  adjustInventory(a, { [offer.item_id]: buying ? payload.quantity : -payload.quantity }, fail);
  a.adventure.gold = gold + (buying ? -amount : amount);
  window[key] += payload.quantity; a.life.market = window;
  announce(world, a, 'life_traded', `${a.name}${buying ? '购买' : '交售'}了${payload.quantity}份${byId.get(offer.item_id).name}，${buying ? '支付' : '获得'}${amount}金币`,
    { intent: payload.intent, item_id: offer.item_id, quantity: payload.quantity, total_price: amount });
  return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }), gold: a.adventure.gold };
}

export function tickLife(world) {
  let changed = false, durable = false;
  for (const a of Object.values(world.state.agents)) {
    const job = a.life?.gathering;
    if (job) {
      const resource = resourceDefinition(job.node_id);
      const authorized = world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() &&
        a.run.run_id === job.run_id && a.session_epoch === job.session_epoch && a.last_contact_at !== null && world.now() - a.last_contact_at < 45000;
      let reason = !authorized ? 'interrupted' : job.expires_at <= world.now() ? 'expired' : !resource || !resourceWorkAvailable(world, a, job) ? 'unavailable' :
        a.scene_id !== resource.scene_id ? 'moved' : a.adventure.hp < job.hp_at_start || a.hurt && a.hurt.action_id !== job.hurt_id_at_start ? 'hurt' : null;
      if (reason) { changed = cancelGather(world, a, reason) || changed; durable = true; }
      else {
      // Resource travel is still a real trip into the wilderness; it does not
      // grant immunity merely because its bounded intent is not adventure_plan.
      if (a.scene_id === 'adventure' && resourceDistance(a.position, sceneDefinition('adventure').portal.position) > 2 && !a.adventure.in_field) { a.adventure.in_field = true; changed = true; durable = true; }
      if (job.phase === 'approaching') {
        const progress = advanceGatherApproach(world, a, job); changed = progress.changed || changed; durable = progress.durable || durable;
      } else if (a.movement || resourceDistance(a.position, resource.position) > resource.radius) { changed = cancelGather(world, a, 'moved') || changed; durable = true; }
      else if (job.ends_at <= world.now()) {
        const planting = job.intent === 'plant', items = planting ? { pine_cone: -1 } : resourceHarvestItems(world.state, job.node_id);
        if (!items) cancelGather(world, a, 'unavailable');
        else if (Object.entries(items).some(([id, delta]) => !Number.isSafeInteger(count(a, id) + delta) || count(a, id) + delta < 0)) cancelGather(world, a, planting ? 'seed_missing' : 'inventory_full');
        else {
          const before = economyBalance(a), published = publicGathering(a);
          if (!(planting ? plantResource(world, a, job) : consumeResource(world, a, job))) cancelGather(world, a, 'unavailable');
          else {
            for (const [id, delta] of Object.entries(items)) a.life.inventory[id] = count(a, id) + delta;
            a.life.gathering = null;
            recordEconomyDelta(a, before, { source_id: job.job_id, reason: planting ? 'tree_planted' : 'gather_finished', at: world.now(), world });
            announce(world, a, 'life_gather_finished', planting ? `${a.name}用1颗松果种下树苗，等待自然生长` : `${a.name}完成一次采集，获得${resource.yield_count}份${byId.get(resource.item_id).name}${items.pine_cone ? '和1颗松果，树木已砍倒' : ''}`, published);
          }
        }
        changed = true; durable = true;
      }
      }
    }
    for (const plot of a.life?.plots || []) {
      if (ready(plot, world.now()) && !plot.ready_notified) {
        plot.ready_notified = true; changed = true; durable = true;
        announce(world, a, 'life_ready', `${a.name}的${CROPS.find(crop => crop.id === plot.crop_id)?.name || '作物'}成熟了，等待本人收获`, { plot_id: plot.plot_id, crop_id: plot.crop_id, ready_at: plot.ready_at });
      }
    }
  }
  if (changed) world.state.room.world_revision++;
  return { changed, durable };
}

export function grantMonsterLoot(a, monsterId) {
  initializeLife(a);
  const loot = new Map([['forest_slime', { item_id: 'wood', quantity: 1 }], ['forest_boar', { item_id: 'ore', quantity: 1 }], ['ruins_guardian', { item_id: 'ore', quantity: 2 }]]).get(monsterId);
  if (!loot) return [];
  const available = Number.MAX_SAFE_INTEGER - count(a, loot.item_id), quantity = Math.min(loot.quantity, available);
  if (!quantity) return [];
  a.life.inventory[loot.item_id] = count(a, loot.item_id) + quantity;
  return [{ item_id: loot.item_id, quantity }];
}
