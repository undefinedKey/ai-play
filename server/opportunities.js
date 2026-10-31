import { LIFE_RULES, publicLife } from './life.js';
import { ADVENTURE_ZONES } from './adventure.js';
import { FATIGUE_RULES, publicFatigue } from './fatigue.js';
import { combatStats } from './combat.js';
import { cooperationOpportunities } from './cooperation.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Suggestions are observations, never queued commands or authorization to act. */
function ordinaryOpportunities(world, a) {
  if (world.state.room.status !== 'active' || a.status !== 'active') return [];
  const options = [];
  const add = (id, label, reason, type, payload) => options.push({ id, label, reason, action: { type, payload } });
  const f = a.adventure;
  const energy = publicFatigue(a).energy;
  const life = publicLife(a, world.now(), { privateInventory: true, includeLedger: false });
  const inventory = life.inventory || {};
  const held = id => inventory[id] || 0;
  const atCamp = a.scene_id === 'plaza' && distance(a.position, ADVENTURE_ZONES[0]) <= ADVENTURE_ZONES[0].radius;
  if (f.hp < f.max_hp || energy < 100) {
    const food = LIFE_RULES.items.find(item => item.kind === 'food' && held(item.id) && (item.heal > 0 && f.hp < f.max_hp || item.energy_restore > 0 && energy < 100));
    if (food) add('eat', `吃${food.name}`, food.energy_restore ? `体力${energy}/100，恢复最多${food.energy_restore}点；野外危险仍在` : `生命${f.hp}/${f.max_hp}，恢复最多${food.heal}点；野外危险仍在`, 'inventory', { intent: 'use', item_id: food.id });
  }
  if (f.encounter?.status === 'pending' && f.encounter.expires_at > world.now()) {
    const e = world.publicAgent(a).adventure.encounter;
    for (const c of e.choices) if (energy >= c.energy_cost && (!c.heal || f.hp < f.max_hp) && (!c.restore_energy || energy < 100) &&
      Object.entries(c.items).every(([id, quantity]) => held(id) <= Number.MAX_SAFE_INTEGER - quantity))
      add(`encounter_${c.choice_id}`, c.name, `本次发现截至${e.expires_at}；体力${c.energy_cost}，结果按目录结算，不自动继续`, 'adventure_event', { event_id: e.event_id, choice_id: c.choice_id });
    add('retreat', '中断发现并撤回营地', '自愿放弃本次选择并撤退，发现冷却不变', 'adventure_plan', { intent: 'retreat' });
    return options.slice(0, 6);
  }
  if (life.gathering) {
    add('cancel_gather', '取消当前采集', `工作预计于${life.gathering.ends_at}结束；取消不退已花体力且不领奖，也可以继续等待`, 'gather', { intent: 'cancel' });
    return options;
  }
  if(a.movement && !f.plan) {
    add('stop_moving','在当前位置停下','也可以等待到达；移动完成后再决定下一步','adventure_plan',{intent:'stop'});
    return options;
  }
  // A different member's game must not conceal this AI's free choices.
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) return options;
  if (a.activity) {
    if (a.activity.activity_id !== 'treasure_hunt') add('finish_activity', '结束当前活动', '也可继续活动；有题目的活动需要按题型提交答案', 'finish_activity', {});
    else if (!distance(a.position, a.activity.target)) add('collect', '收集找到的宝物', '已抵达当前藏宝点', 'finish_activity', {});
    return options;
  }
  if (f.plan) {
    if (f.plan.intent === 'hunt' && energy <= FATIGUE_RULES.tired_at) {
      add('retreat', '撤回营地', `体力${energy}/100，当前攻击效率75%；也可以自行选择继续`, 'adventure_plan', { intent: 'retreat' });
      add('rest', '回营地休息', '同时恢复生命和体力，恢复完毕再决定下一步', 'adventure_plan', { intent: 'rest' });
    }
    return options;
  }

  if (atCamp && (f.hp < f.max_hp || energy < 100)) add('rest', '营地休息', `体力${energy}/100，主动休息同时恢复生命和体力；不自动切换下一项`, 'adventure_plan', { intent: 'rest' });

  const target = energy >= FATIGUE_RULES.hunt_min_energy ? world.state.adventure.monsters.filter(m => m.status === 'alive' && m.hp > 0)
    .sort((x, y) => x.attack - y.attack || distance(a.position, x.position) - distance(a.position, y.position))[0] : null;
  const farmOptions = [];
  if (atCamp && !f.in_field) {
    if (!options.some(option => option.id === 'rest')) add('relax', '在花园小憩', '可以休息、聊天或看看周围，活动期间恢复体力；是否参加由自己决定', 'start_activity', { activity_id: 'relax' });
    const toolLevel = id => LIFE_RULES.tools.find(tool => tool.id === id).levels.find(level => level.level === life.tools[id].level);
    const toolUsable = id => life.tools[id].durability > 0 && energy >= toolLevel(id).energy_cost;
    const canPay = cost => Object.entries(cost).every(([id, quantity]) => held(id) >= quantity);
    const farmAdd = (priority, id, label, reason, type, payload) => farmOptions.push({ priority, id, label, reason, action: { type, payload } });
    for (const plot of life.plots) {
      const crop = LIFE_RULES.crops.find(c => c.id === plot.crop_id);
      if (crop && energy >= FATIGUE_RULES.costs.harvest && plot.ready_at !== null && plot.ready_at <= world.now()
        && held(crop.produce_id) <= Number.MAX_SAFE_INTEGER - crop.yield_count && held(crop.seed_id) <= Number.MAX_SAFE_INTEGER - crop.seed_return) {
        farmAdd(0, `harvest_${plot.plot_id}`, `收获${crop.name}`, '已成熟，收获存入自己的仓库并返还种子，之后需重新开垦', 'farm', { intent: 'harvest', plot_id: plot.plot_id });
      } else if (crop && toolUsable('watering_can') && plot.watered_at === null) {
        farmAdd(1, `water_${plot.plot_id}`, `浇灌${crop.name}`, `耗水壶1耐久和${toolLevel('watering_can').energy_cost}体力，${crop.grow_seconds}秒后成熟`, 'farm', { intent: 'water', plot_id: plot.plot_id });
      } else if (!crop && !plot.tilled && toolUsable('hoe')) {
        farmAdd(3, `till_${plot.plot_id}`, '开垦空田', `耗锄头1耐久和${toolLevel('hoe').energy_cost}体力；之后可自己选择作物`, 'farm', { intent: 'till', plot_id: plot.plot_id });
      }
    }
    for (const definition of LIFE_RULES.tools) {
      const tool = life.tools[definition.id], current = toolLevel(definition.id), next = definition.levels.find(level => level.level === tool.level + 1);
      if (tool.durability < tool.max_durability && energy >= FATIGUE_RULES.costs.repair && canPay(current.repair_cost)) {
        farmAdd(tool.durability === 0 ? 2 : 7, `repair_${definition.id}`, `维修${definition.name}`, `当前耐久${tool.durability}/${tool.max_durability}；消耗目录材料和2体力，回满耐久`, 'inventory', { intent: 'repair', item_id: definition.id });
      }
      if (next && energy >= FATIGUE_RULES.costs.upgrade && canPay(next.upgrade_cost)) {
        farmAdd(5, `upgrade_${definition.id}`, `升级${definition.name}`, `升到${next.level}级，耐久${next.max_durability}，使用时耗${next.energy_cost}体力；需下一等级材料和2体力`, 'inventory', { intent: 'upgrade', item_id: definition.id });
      }
    }
    // Expose one tilled plot with both seed choices; keep room for adventure.
    const empty = life.plots.find(plot => !plot.crop_id && plot.tilled);
    if (empty && energy >= FATIGUE_RULES.costs.plant) for (const crop of LIFE_RULES.crops) if (held(crop.seed_id)) {
      farmAdd(4, `plant_${crop.id}`, `种${crop.name}`, '使用已开垦田和自己的种子，之后需要用水壶浇水', 'farm', { intent: 'plant', plot_id: empty.plot_id, crop_id: crop.id });
    }
    const cooking = LIFE_RULES.recipes.filter(recipe => recipe.kind === 'cooking' && !held(recipe.item_id) && canPay(recipe.ingredients) && energy >= recipe.energy_cost);
    for (const recipe of cooking) {
      const item = LIFE_RULES.items.find(item => item.id === recipe.item_id);
      farmAdd(4, `cook_${item.id}`, `烹制${item.name}`, `消耗${JSON.stringify(recipe.ingredients)}与${recipe.energy_cost}体力，瞬时完成；${item.energy_restore ? `使用恢复${item.energy_restore}体力` : `使用恢复${item.heal}生命`}`, 'inventory', { intent: 'craft', item_id: item.id });
    }
    const market = life.market, gold = f.gold;
    const buySeed = LIFE_RULES.market.items.find(offer => offer.item_id.endsWith('_seed') && !held(offer.item_id) && offer.buy_price <= gold && market.buy_remaining > 0);
    if (buySeed) farmAdd(3, `buy_${buySeed.item_id}`, `购买${LIFE_RULES.items.find(item => item.id === buySeed.item_id).name}`, `支付${buySeed.buy_price}金币买1份；本人剩余购买额度${market.buy_remaining}`, 'trade', { intent: 'buy', item_id: buySeed.item_id, quantity: 1 });
    const sell = LIFE_RULES.market.items.find(offer => offer.sell_price && held(offer.item_id) && ['turnip', 'wheat'].includes(offer.item_id)) ||
      (!held('turnip_seed') && !held('wheat_seed') ? LIFE_RULES.market.items.find(offer => offer.sell_price && held(offer.item_id)) : null);
    if (sell && market.sell_remaining > 0 && Number.isSafeInteger(gold + sell.sell_price)) farmAdd(4, `sell_${sell.item_id}`, `交售${LIFE_RULES.items.find(item => item.id === sell.item_id).name}`, `自愿出售1份获得${sell.sell_price}金币；物品也可留作其他用途`, 'trade', { intent: 'sell', item_id: sell.item_id, quantity: 1 });
    const current = combatStats(a);
    const alternatives = LIFE_RULES.items.filter(item => item.kind === 'equipment' && life.equipment[item.slot] !== item.id).map(item => {
      const stats = combatStats({ ...a, life: { ...a.life, equipment: { ...life.equipment, [item.slot]: item.id }, inventory: { ...inventory, [item.id]: 1 } } });
      const recipe = LIFE_RULES.recipes.find(recipe => recipe.item_id === item.id);
      return { item, stats, owned: held(item.id) > 0, craftable: recipe && canPay(recipe.ingredients) && energy >= FATIGUE_RULES.costs.craft };
    }).filter(({ stats, owned, craftable }) => (owned || craftable) && (stats.attack > current.attack || stats.defense > current.defense || stats.range > current.range ||
      stats.attack_interval_ms < current.attack_interval_ms || stats.attack_energy < current.attack_energy || stats.move_energy_per_tile < current.move_energy_per_tile))
      // Prefer showing an already-owned alternative and a different range/cost
      // profile, not declaring raw attack+defense to be the only best equipment.
      .sort((x, y) => Number(y.owned) - Number(x.owned) || y.stats.range - x.stats.range || x.stats.attack_energy - y.stats.attack_energy || x.stats.attack_interval_ms - y.stats.attack_interval_ms);
    const equipmentIds = new Set();
    for (const slot of ['weapon', 'armor']) {
      const alternative = alternatives.find(alternative => alternative.item.slot === slot);
      if (!alternative) continue;
      const { item, stats, owned } = alternative, intent = owned ? 'equip' : 'craft', id = `${intent}_${item.id}`;
      equipmentIds.add(id);
      farmAdd(6, id, `${owned ? '换用' : '制作'}${item.name}`, `穿戴后攻击${stats.attack}、射程${stats.range}、每${stats.attack_interval_ms / 1000}秒一击耗${stats.attack_energy}体力，防御${stats.defense}，每格耗${stats.move_energy_per_tile}；取舍由自己决定${owned ? '' : '，制作后需另行选择穿戴'}`, 'inventory', { intent, item_id: item.id });
    }
    const resources = LIFE_RULES.gathering.resources.filter(resource => distance(a.position, resource) <= resource.radius && energy >= resource.energy_cost &&
      life.gather_ready_at[resource.id] <= world.now() && held(resource.item_id) <= Number.MAX_SAFE_INTEGER - resource.yield_count);
    const resource = resources.sort((x, y) => held(x.item_id) - held(y.item_id))[0];
    // Equivalent targets share a suggestion slot: two empty plots or two worn
    // tools must not conceal crafting/cooking. The full catalog stays available.
    const seen = new Set();
    const distinct = farmOptions.sort((x, y) => x.priority - y.priority).filter(option => {
      const { type, payload } = option.action;
      const key = type === 'farm' && payload.intent !== 'plant' || type === 'inventory' && ['repair', 'upgrade'].includes(payload.intent)
        ? `${type}:${payload.intent}` : option.id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    // Reserve independent choices for gathering, exploration, and legal combat.
    // Absent monsters or low energy release the combat slot for living choices.
    const reserved = 1 + (resource ? 1 : 0) + (target ? 1 : 0);
    const slots = Math.max(0, Math.min(3, 6 - reserved - options.length)), selected = distinct.slice(0, slots);
    // With two or more living slots, keep one concrete strategy alternative
    // visible without evicting the highest-priority farm/repair choice.
    if (slots >= 2 && equipmentIds.size && !selected.some(option => equipmentIds.has(option.id))) selected[selected.length - 1] = distinct.find(option => equipmentIds.has(option.id));
    options.push(...selected.map(({ priority, ...option }) => option));
    if (resource) add(`gather_${resource.id}`, `徒手采集${resource.item_id === 'wood' ? '木材' : '矿石'}`, `${resource.name}：${resource.duration_seconds}秒、${resource.energy_cost}体力，完成得${resource.yield_count}份；无需工具，可取消`, 'gather', { intent: 'start', resource_id: resource.id });
  } else {
    add('return_camp', '回营地休息或照料农田', '安全区可种植、收获、制作和穿戴装备', 'adventure_plan', { intent: 'rest' });
  }
  add('explore_forest', '探索苔光森林', '自由探索；走出安全区可能遇到巡逻怪物', 'adventure_plan', { intent: 'explore', zone_id: 'forest' });
  if (target) add('hunt', `挑战${target.name}`, `目标生命${target.hp}、攻击${target.attack}；击败可获得经验、金币和材料${energy <= 25 ? '；当前体力较低，攻击效率75%' : ''}`, 'adventure_plan', { intent: 'hunt', monster_id: target.monster_id });
  if (options.length < 6) add('explore_ruins', '探索风蚀遗迹', '较危险，可以先邀请同伴；是否参战各自决定', 'adventure_plan', { intent: 'explore', zone_id: 'ruins' });
  return options.slice(0, 6);
}

export function opportunitiesFor(world, a) {
  const ordinary = ordinaryOpportunities(world, a), cooperation = cooperationOpportunities(world, a).slice(0, 2);
  if (!cooperation.length) return ordinary;
  const selected = [], add = option => { if (option && !selected.some(o => o.id === option.id) && selected.length < 6) selected.push(option); };
  if (a.adventure?.encounter?.status === 'pending') {
    for (const option of ordinary.filter(o => ['eat', 'encounter_decline', 'retreat'].includes(o.id))) add(option);
  } else add(ordinary[0]);
  for (const option of cooperation) add(option);
  for (const option of ordinary.filter(o => ['explore_forest', 'hunt'].includes(o.id))) add(option);
  for (const option of ordinary) add(option);
  return selected;
}
