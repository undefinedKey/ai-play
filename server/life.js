import { isPositionInBounds } from './spatial.js';
import { FATIGUE_RULES, spendEnergy, attackMultiplier } from './fatigue.js';
import { randomUUID } from 'node:crypto';
import { MARKET_RULES, economyBalance, recordEconomyDelta, marketWindow, publicMarket, publicLedger } from './economy.js';
import { EQUIPMENT, STRATEGY_EQUIPMENT_RULES, combatStats } from './combat.js';
export { combatStats } from './combat.js';

const ITEMS = [
  { id: 'turnip_seed', name: '萝卜种子', kind: 'seed' },
  { id: 'wheat_seed', name: '小麦种子', kind: 'seed' },
  { id: 'turnip', name: '萝卜', kind: 'food', heal: 12 },
  { id: 'wheat', name: '小麦', kind: 'food', heal: 18 },
  { id: 'turnip_soup', name: '萝卜浓汤', kind: 'food', heal: 32, energy_restore: 0 },
  { id: 'wheat_bread', name: '麦香面包', kind: 'food', heal: 0, energy_restore: 24 },
  { id: 'wood', scene_id: 'plaza', name: '木材', kind: 'material' },
  { id: 'ore', scene_id: 'plaza', name: '矿石', kind: 'material' },
  ...EQUIPMENT,
];
const CROPS = [
  { id: 'turnip', name: '萝卜', seed_id: 'turnip_seed', produce_id: 'turnip', grow_seconds: 120, yield_count: 2, seed_return: 1 },
  { id: 'wheat', name: '小麦', seed_id: 'wheat_seed', produce_id: 'wheat', grow_seconds: 180, yield_count: 2, seed_return: 1 },
];
const RECIPES = [
  { item_id: 'wooden_sword', ingredients: { wood: 3 } },
  { item_id: 'iron_sword', ingredients: { wood: 2, ore: 3 } },
  { item_id: 'wooden_shield', ingredients: { wood: 3 } },
  { item_id: 'iron_armor', ingredients: { ore: 5 } },
  { item_id: 'hunter_bow', ingredients: { wood: 5, ore: 1 } },
  { item_id: 'heavy_hammer', ingredients: { wood: 3, ore: 5 } },
  { item_id: 'heavy_armor', ingredients: { wood: 2, ore: 8 } },
  { item_id: 'turnip_soup', ingredients: { turnip: 2 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
  { item_id: 'wheat_bread', ingredients: { wheat: 2 }, kind: 'cooking', energy_cost: 2, duration_seconds: 0, station_id: 'kitchen' },
];
const TOOLS = [
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
];
export const LIFE_RULES = {
  farm_place: { id: 'farm', scene_id: 'plaza', name: '营地农田', x: 12, y: 8, service_center: { x: 11, y: 8 }, radius: 2 },
  plots_per_agent: 2, crops: CROPS, items: ITEMS, recipes: RECIPES, tools: TOOLS,
  gathering: { tool_required: false, resources: [
    { id: 'wood', scene_id: 'plaza', item_id: 'wood', name: '营地拾枝处', x: 10, y: 8, radius: 1, duration_seconds: 12, energy_cost: 4, yield_count: 1, cooldown_seconds: 8 },
    { id: 'ore', scene_id: 'plaza', item_id: 'ore', name: '营地碎矿堆', x: 12, y: 8, radius: 1, duration_seconds: 18, energy_cost: 6, yield_count: 1, cooldown_seconds: 12 },
  ], description: '徒手安全采集，无工具前置，每次只完成一份。开始预扣体力，完成才领奖；取消、走路、暂停、失联或重启不领奖不退已花体力，不自动继续。资源按本人冷却，不是共享库存。' },
  cooking_place: { id: 'kitchen', scene_id: 'plaza', name: '营地料理台', x: 10, y: 7, service_center: { x: 11, y: 8 }, radius: 2 },
  market: MARKET_RULES,
  strategy_equipment: STRATEGY_EQUIPMENT_RULES,
  description: '每个角色有两块专属田、个人仓库和持久的锄头/水壶。空地先用锄头开垦，种植消耗1种子，用水壶浇水一次后开始120/180秒生长，成熟需自己收获，得到2份食物并返还1种子，收获后需重新开垦。开垦/浇水各耗对应工具1耐久，工具升级降低该动作体力消耗；repair按当前等级repair_cost维修，upgrade消耗下一等级upgrade_cost，均回满耐久、各耗2体力；最高3级。工具独立于战斗装备，不可复制或装备到武器护甲槽。离线仍生长，没人替你耕作。农田、制作、工具维护与换装在营地半径2内进行，且须先结束冒险计划、独处活动和参与中的多人游戏。食物可在野外使用，但不会退出危险状态或延长反应保护。',
};
const byId = new Map(ITEMS.map(item => [item.id, item]));
const slots = ['weapon', 'armor'];
const starter = { turnip_seed: 3, wheat_seed: 3, wood: 3 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validQuantity = value => Number.isSafeInteger(value) && value >= 0;
const count = (a, item) => validQuantity(a.life?.inventory?.[item]) ? a.life.inventory[item] : 0;
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyPlot = plot_id => ({ plot_id, tilled: false, tilled_at: null, crop_id: null, planted_at: null, watered_at: null, ready_at: null, ready_notified: false });
const ready = (plot, now) => plot.crop_id !== null && Number.isSafeInteger(plot.ready_at) && plot.ready_at <= now;
function normalizedTool(value, definition, grant = false) {
  const level = definition.levels.find(entry => entry.level === value?.level) || definition.levels[0];
  return { level: level.level, durability: validQuantity(value?.durability) ? Math.min(value.durability, level.max_durability) : grant ? level.max_durability : 0, max_durability: level.max_durability };
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
  life.tools = Object.fromEntries(TOOLS.map(definition => [definition.id, normalizedTool(tools[definition.id], definition, life.tools_granted !== true && !Object.hasOwn(tools, definition.id))]));
  life.tools_granted = true;
  life.gather_ready_at = Object.fromEntries(['wood', 'ore'].map(id => [id, time(life.gather_ready_at?.[id]) ?? 0]));
  if (!plain(life.gathering) || !LIFE_RULES.gathering.resources.some(resource => resource.id === life.gathering.resource_id) ||
    typeof life.gathering.job_id !== 'string' || time(life.gathering.started_at) === null || time(life.gathering.ends_at) === null) life.gathering = null;
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
export function campAvailable(world, a, fail) {
  if (a.scene_id !== 'plaza') fail('SCENE_REQUIRED', '生活设施在plaza营地；可自主选择adventure_plan retreat返回');
  const farm = LIFE_RULES.farm_place, position = a.position;
  if (!isPositionInBounds(position) || Math.abs(position.x - farm.service_center.x) + Math.abs(position.y - farm.service_center.y) > farm.radius) fail('NOT_AT_CAMP', '请先返回营地半径2格内，再照料农田、制作或换装');
  if (a.adventure?.plan || a.adventure?.in_field || a.activity) fail('ACTIVITY_BUSY', '请先结束当前计划或活动，并返回安全营地');
  if (a.life?.gathering) fail('GATHER_BUSY', '请先取消当前采集或等待完成');
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前多人游戏，再照料农田、制作或换装');
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
    campAvailable(world, a, fail);
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
    if (payload.slot !== undefined || !definition) fail('INVALID_ACTION', '工具维护只接受 item_id: hoe 或 watering_can');
    campAvailable(world, a, fail);
    const tool = a.life.tools[definition.id], current = definition.levels.find(level => level.level === tool.level);
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
      campAvailable(world, a, fail);
      const recipe = RECIPES.find(recipe => recipe.item_id === item.id);
      if (!recipe) fail('INVALID_ACTION', '这件物品没有制作配方');
      if (!spendEnergy(world, a, 'craft')) fail('FATIGUE_EXHAUSTED', '体力不足以制作装备，可在营地休息后再试');
      adjustInventory(a, { ...Object.fromEntries(Object.entries(recipe.ingredients).map(([id, amount]) => [id, -amount])), [item.id]: 1 }, fail);
      announce(world, a, 'life_crafted', `${a.name}${recipe.kind === 'cooking' ? '烹制' : '制作'}了${item.name}`, { item_id: item.id, quantity: 1 });
    } else if (payload.intent === 'equip') {
      campAvailable(world, a, fail);
      if (item.kind !== 'equipment') fail('INVALID_ACTION', '这件物品不能装备');
      if (!count(a, item.id)) fail('INSUFFICIENT_ITEMS', '需要先在自己的仓库中持有这件装备');
      if (a.life.equipment[item.slot] === item.id) fail('ALREADY_EQUIPPED', '已经装备了这件物品，不会叠加属性');
      a.life.equipment[item.slot] = item.id;
      announce(world, a, 'life_equipped', `${a.name}装备了${item.name}`, { item_id: item.id, slot: item.slot });
    } else {
      if (item.kind !== 'food') fail('INVALID_ACTION', '只有食物可以使用');
      if (!count(a, item.id)) fail('INSUFFICIENT_ITEMS', '仓库中没有这份食物');
      if (!a.adventure || !Number.isFinite(a.adventure.hp) || !Number.isFinite(a.adventure.max_hp)) fail('INVALID_ACTION', '角色生命状态不可用');
      if (item.energy_restore ? a.fatigue.energy >= 100 : a.adventure.hp >= a.adventure.max_hp) fail(item.energy_restore ? 'FULL_ENERGY' : 'FULL_HEALTH', item.energy_restore ? '体力已满，未消耗补给' : '生命已满，未消耗食物');
      adjustInventory(a, { [item.id]: -1 }, fail);
      a.adventure.hp = Math.min(a.adventure.max_hp, a.adventure.hp + (item.heal || 0));
      if (item.energy_restore) {
        a.fatigue.energy = Math.min(100, a.fatigue.energy + item.energy_restore);
        a.fatigue.updated_at = Math.max(a.fatigue.updated_at, world.now());
        if (a.fatigue.energy >= FATIGUE_RULES.rearm_at) a.fatigue.tired_notified = false;
      }
      announce(world, a, 'life_consumed', `${a.name}吃了${item.name}，恢复${item.energy_restore ? '体力' : '生命'}`, { item_id: item.id, quantity: 1, hp: a.adventure.hp, energy: a.fatigue.energy });
    }
  }
  return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }), hp: a.adventure?.hp };
}

export function publicGathering(a) {
  const job = a.life?.gathering, resource = LIFE_RULES.gathering.resources.find(entry => entry.id === job?.resource_id);
  if (!resource || typeof job.job_id !== 'string' || time(job.started_at) === null || time(job.ends_at) === null) return null;
  return { job_id: job.job_id, resource_id: resource.id, item_id: resource.item_id, quantity: resource.yield_count, started_at: job.started_at, ends_at: job.ends_at };
}
export function cancelGather(world, a, reason = 'cancelled') {
  const job = publicGathering(a);
  if (!job) { if (a.life) a.life.gathering = null; return false; }
  a.life.gathering = null;
  const reasons = { cancelled: '本人取消', moved: '离开采集位置', interrupted: '控制已停止或中断', restarted: '服务重启', inventory_full: '仓库达到上限' };
  if (!Object.hasOwn(reasons, reason)) reason = 'interrupted';
  announce(world, a, 'life_gather_cancelled', `${a.name}停止了采集：${reasons[reason]}，本次未获得材料`, { job_id: job.job_id, resource_id: job.resource_id, reason });
  return true;
}
function performGather(world, a, payload, fail) {
  exact(payload, ['intent', 'resource_id'], fail);
  if (!['start', 'cancel'].includes(payload.intent)) fail('INVALID_ACTION', '采集只支持 start 或 cancel');
  if (payload.intent === 'cancel') {
    if (payload.resource_id !== undefined) fail('INVALID_ACTION', '取消采集不接受 resource_id');
    if (!a.life.gathering) fail('NO_GATHERING', '当前没有采集工作');
    cancelGather(world, a); return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }) };
  }
  const resource = LIFE_RULES.gathering.resources.find(entry => entry.id === payload.resource_id);
  if (!resource) fail('INVALID_ACTION', '请选择木材或矿石采集点');
  campAvailable(world, a, fail);
  if (Math.abs(a.position.x - resource.x) + Math.abs(a.position.y - resource.y) > resource.radius) fail('NOT_AT_RESOURCE', '请先走到该资源点交互范围内');
  if (a.life.gather_ready_at[resource.id] > world.now()) fail('GATHER_COOLDOWN', '这处资源尚未准备好，可自行等待或选择其他事情', { retry_after_ms: a.life.gather_ready_at[resource.id] - world.now() });
  if (count(a, resource.item_id) > Number.MAX_SAFE_INTEGER - resource.yield_count) fail('INVENTORY_FULL', '仓库数量已达安全上限');
  if (!spendEnergy(world, a, 'gather', resource.energy_cost)) fail('FATIGUE_EXHAUSTED', `本次采集需要${resource.energy_cost}点体力，可免费休息后再试`);
  const job = { job_id: `gather_${randomUUID()}`, resource_id: resource.id, started_at: world.now(), ends_at: world.now() + resource.duration_seconds * 1000,
    run_id: a.run.run_id, session_epoch: a.session_epoch };
  a.life.gathering = job; a.life.gather_ready_at[resource.id] = job.ends_at + resource.cooldown_seconds * 1000;
  announce(world, a, 'life_gather_started', `${a.name}开始徒手${resource.id === 'wood' ? '拾取木材' : '收集碎矿'}，预计${resource.duration_seconds}秒`, publicGathering(a));
  return { life: publicLife(a, world.now(), { privateInventory: true, includeLedger: false }) };
}
function performTrade(world, a, payload, fail) {
  exact(payload, ['intent', 'item_id', 'quantity'], fail);
  if (!['buy', 'sell'].includes(payload.intent) || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > MARKET_RULES.max_quantity) fail('INVALID_ACTION', '交易只接受 buy/sell 与1至10的整数数量');
  const offer = MARKET_RULES.items.find(entry => entry.item_id === payload.item_id), buying = payload.intent === 'buy';
  const price = offer?.[buying ? 'buy_price' : 'sell_price'];
  if (!Number.isSafeInteger(price) || price <= 0) fail('TRADE_UNAVAILABLE', '补给柜不支持这件物品的该方向交易');
  campAvailable(world, a, fail);
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
  let changed = false;
  for (const a of Object.values(world.state.agents)) {
    const job = a.life?.gathering;
    if (job) {
      const resource = LIFE_RULES.gathering.resources.find(entry => entry.id === job.resource_id);
      const authorized = world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() &&
        a.run.run_id === job.run_id && a.session_epoch === job.session_epoch && world.now() - a.last_contact_at < 45000;
      if (!authorized) changed = cancelGather(world, a, 'interrupted') || changed;
      else if (a.scene_id !== 'plaza' || !resource || Math.abs(a.position.x - resource.x) + Math.abs(a.position.y - resource.y) > resource.radius) changed = cancelGather(world, a, 'moved') || changed;
      else if (job.ends_at <= world.now()) {
        if (count(a, resource.item_id) > Number.MAX_SAFE_INTEGER - resource.yield_count) changed = cancelGather(world, a, 'inventory_full') || changed;
        else {
          const before = economyBalance(a), published = publicGathering(a);
          a.life.inventory[resource.item_id] = count(a, resource.item_id) + resource.yield_count;
          a.life.gathering = null;
          recordEconomyDelta(a, before, { source_id: job.job_id, reason: 'gather_finished', at: world.now(), world });
          announce(world, a, 'life_gather_finished', `${a.name}完成了徒手采集，获得${resource.yield_count}份${byId.get(resource.item_id).name}`, published);
          changed = true;
        }
      }
    }
    for (const plot of a.life?.plots || []) {
    if (ready(plot, world.now()) && !plot.ready_notified) {
      plot.ready_notified = true; changed = true;
      announce(world, a, 'life_ready', `${a.name}的${CROPS.find(crop => crop.id === plot.crop_id)?.name || '作物'}成熟了，等待本人收获`, { plot_id: plot.plot_id, crop_id: plot.crop_id, ready_at: plot.ready_at });
    }
    }
  }
  return { changed };
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
