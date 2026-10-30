import { isPositionInBounds } from './spatial.js';

const ITEMS = [
  { id: 'turnip_seed', name: '萝卜种子', kind: 'seed' },
  { id: 'wheat_seed', name: '小麦种子', kind: 'seed' },
  { id: 'turnip', name: '萝卜', kind: 'food', heal: 12 },
  { id: 'wheat', name: '小麦', kind: 'food', heal: 18 },
  { id: 'wood', name: '木材', kind: 'material' },
  { id: 'ore', name: '矿石', kind: 'material' },
  { id: 'wooden_sword', name: '木剑', kind: 'equipment', slot: 'weapon', attack_bonus: 2 },
  { id: 'iron_sword', name: '铁剑', kind: 'equipment', slot: 'weapon', attack_bonus: 5 },
  { id: 'wooden_shield', name: '木盾', kind: 'equipment', slot: 'armor', defense: 1 },
  { id: 'iron_armor', name: '铁甲', kind: 'equipment', slot: 'armor', defense: 3 },
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
];
export const LIFE_RULES = {
  farm_place: { id: 'farm', name: '营地农田', x: 12, y: 8, service_center: { x: 11, y: 8 }, radius: 2 },
  plots_per_agent: 2, crops: CROPS, items: ITEMS, recipes: RECIPES,
  description: '每个角色有两块专属田和个人仓库。种植消耗1种子，浇水一次后开始120/180秒生长，成熟需自己收获，得到2份食物并返还1种子。离线仍生长，没人替你种植或收获。农田、制作与换装在营地半径2内进行，且须先结束冒险计划、独处活动和参与中的多人游戏。食物可在野外使用，但不会退出危险状态或延长反应保护。',
};
const byId = new Map(ITEMS.map(item => [item.id, item]));
const slots = ['weapon', 'armor'];
const starter = { turnip_seed: 3, wheat_seed: 3, wood: 3 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validQuantity = value => Number.isSafeInteger(value) && value >= 0;
const count = (a, item) => validQuantity(a.life?.inventory?.[item]) ? a.life.inventory[item] : 0;
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyPlot = plot_id => ({ plot_id, crop_id: null, planted_at: null, watered_at: null, ready_at: null, ready_notified: false });
const ready = (plot, now) => plot.crop_id !== null && Number.isSafeInteger(plot.ready_at) && plot.ready_at <= now;

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
  life.plots = ['plot_1', 'plot_2'].map(id => {
    const p = previous.find(plot => plot?.plot_id === id);
    if (!p || !CROPS.some(crop => crop.id === p.crop_id)) return emptyPlot(id);
    return { plot_id: id, crop_id: p.crop_id, planted_at: time(p.planted_at), watered_at: time(p.watered_at), ready_at: time(p.ready_at), ready_notified: p.ready_notified === true };
  });
  const equipment = plain(life.equipment) ? life.equipment : {};
  life.equipment = Object.fromEntries(slots.map(slot => {
    const item = byId.get(equipment[slot]);
    return [slot, item?.slot === slot && count(a, item.id) > 0 ? item.id : null];
  }));
}

export function equipmentStats(a) {
  const weapon = byId.get(a.life?.equipment?.weapon), armor = byId.get(a.life?.equipment?.armor);
  return { attack_bonus: weapon?.slot === 'weapon' && count(a, weapon.id) > 0 ? weapon.attack_bonus || 0 : 0,
    defense: armor?.slot === 'armor' && count(a, armor.id) > 0 ? armor.defense || 0 : 0 };
}

export function publicLife(a, now, { privateInventory = false } = {}) {
  const life = a.life || {}, stats = equipmentStats(a);
  const level = Number.isSafeInteger(a.adventure?.level) && a.adventure.level > 0 ? a.adventure.level : 1;
  return {
    plots: ['plot_1', 'plot_2'].map(id => {
      const p = life.plots?.find(plot => plot.plot_id === id) || emptyPlot(id);
      return { plot_id: id, crop_id: p.crop_id, planted_at: p.planted_at, watered_at: p.watered_at, ready_at: p.ready_at, ready: ready(p, now) };
    }),
    equipment: Object.fromEntries(slots.map(slot => {
      const item = byId.get(life.equipment?.[slot]);
      return [slot, item?.slot === slot && count(a, item.id) > 0 ? item.id : null];
    })),
    stats: { ...stats, attack: 4 + level * 2 + stats.attack_bonus },
    ...(privateInventory ? { inventory: Object.fromEntries(ITEMS.filter(item => count(a, item.id) > 0).map(item => [item.id, count(a, item.id)])) } : {}),
  };
}

function announce(world, a, type, text, extra = {}) {
  world.event(type, { agent_id: a.agent_id, name: a.name, text, ...extra }, [...new Set([a.agent_id, ...world.activeIds()])]);
}
function campAvailable(world, a, fail) {
  const farm = LIFE_RULES.farm_place, position = a.position;
  if (!isPositionInBounds(position) || Math.abs(position.x - farm.service_center.x) + Math.abs(position.y - farm.service_center.y) > farm.radius) fail('NOT_AT_CAMP', '请先返回营地半径2格内，再照料农田、制作或换装');
  if (a.adventure?.plan || a.adventure?.in_field || a.activity) fail('ACTIVITY_BUSY', '请先结束当前计划或活动，并返回安全营地');
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前多人游戏，再照料农田、制作或换装');
}
function adjustInventory(a, changes, fail) {
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
  if (type === 'farm') {
    exact(payload, ['intent', 'plot_id', 'crop_id'], fail);
    if (!['plant', 'water', 'harvest'].includes(payload.intent) || typeof payload.plot_id !== 'string' || payload.intent !== 'plant' && payload.crop_id !== undefined) fail('INVALID_ACTION', 'farm 只接受 plant/water/harvest 与自己的 plot_id，只有种植可提供 crop_id');
    const plot = a.life.plots.find(p => p.plot_id === payload.plot_id);
    if (!plot) fail('NOT_AUTHORIZED', '只能操作自己的 plot_1 或 plot_2');
    campAvailable(world, a, fail);
    if (payload.intent === 'plant') {
      const crop = CROPS.find(crop => crop.id === payload.crop_id);
      if (!crop) fail('INVALID_ACTION', '请选择农田目录中的作物');
      if (plot.crop_id !== null) fail('PLOT_OCCUPIED', '这块田已有作物，请成熟收获后再种植');
      adjustInventory(a, { [crop.seed_id]: -1 }, fail);
      Object.assign(plot, { crop_id: crop.id, planted_at: world.now(), watered_at: null, ready_at: null, ready_notified: false });
      announce(world, a, 'life_planted', `${a.name}在自己的${plot.plot_id === 'plot_1' ? '一号' : '二号'}田种下了${crop.name}，等待浇水`, { plot_id: plot.plot_id, crop_id: crop.id });
    } else {
      const crop = CROPS.find(crop => crop.id === plot.crop_id);
      if (!crop) fail('PLOT_EMPTY', '这块田还没有作物');
      if (payload.intent === 'water') {
        if (plot.watered_at !== null) fail('ALREADY_WATERED', '已经浇水，无需重复浇水');
        plot.watered_at = world.now(); plot.ready_at = world.now() + crop.grow_seconds * 1000; plot.ready_notified = false;
        announce(world, a, 'life_watered', `${a.name}给${crop.name}浇了水，开始生长`, { plot_id: plot.plot_id, crop_id: crop.id, ready_at: plot.ready_at });
      } else {
        if (!ready(plot, world.now())) fail('CROP_NOT_READY', plot.watered_at === null ? '请先浇水，作物才会开始生长' : '作物尚未成熟');
        adjustInventory(a, { [crop.produce_id]: crop.yield_count, [crop.seed_id]: crop.seed_return }, fail);
        Object.assign(plot, emptyPlot(plot.plot_id));
        announce(world, a, 'life_harvested', `${a.name}收获了${crop.yield_count}份${crop.name}，并留下${crop.seed_return}颗种子`, { plot_id: plot.plot_id, crop_id: crop.id, item_id: crop.produce_id, quantity: crop.yield_count });
      }
    }
    return { life: publicLife(a, world.now(), { privateInventory: true }) };
  }
  if (type !== 'inventory') fail('INVALID_ACTION', '未知生活动作');
  exact(payload, ['intent', 'item_id', 'slot'], fail);
  if (!['craft', 'equip', 'unequip', 'use'].includes(payload.intent)) fail('INVALID_ACTION', '仓库只支持 craft/equip/unequip/use');
  if (payload.intent === 'unequip') {
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
      adjustInventory(a, { ...Object.fromEntries(Object.entries(recipe.ingredients).map(([id, amount]) => [id, -amount])), [item.id]: 1 }, fail);
      announce(world, a, 'life_crafted', `${a.name}制作了${item.name}`, { item_id: item.id, quantity: 1 });
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
      if (a.adventure.hp >= a.adventure.max_hp) fail('FULL_HEALTH', '生命已满，未消耗食物');
      adjustInventory(a, { [item.id]: -1 }, fail);
      a.adventure.hp = Math.min(a.adventure.max_hp, a.adventure.hp + item.heal);
      announce(world, a, 'life_consumed', `${a.name}吃了${item.name}，恢复生命`, { item_id: item.id, quantity: 1, hp: a.adventure.hp });
    }
  }
  return { life: publicLife(a, world.now(), { privateInventory: true }), hp: a.adventure?.hp };
}

export function tickLife(world) {
  let changed = false;
  for (const a of Object.values(world.state.agents)) for (const plot of a.life?.plots || []) {
    if (ready(plot, world.now()) && !plot.ready_notified) {
      plot.ready_notified = true; changed = true;
      announce(world, a, 'life_ready', `${a.name}的${CROPS.find(crop => crop.id === plot.crop_id)?.name || '作物'}成熟了，等待本人收获`, { plot_id: plot.plot_id, crop_id: plot.crop_id, ready_at: plot.ready_at });
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
