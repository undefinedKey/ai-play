import { LIFE_RULES, publicLife } from './life.js';
import { ADVENTURE_ZONES } from './adventure.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Suggestions are observations, never queued commands or authorization to act. */
export function opportunitiesFor(world, a) {
  if (world.state.room.status !== 'active' || a.status !== 'active') return [];
  const options = [];
  const add = (id, label, reason, type, payload) => options.push({ id, label, reason, action: { type, payload } });
  const f = a.adventure;
  const life = publicLife(a, world.now(), { privateInventory: true });
  const inventory = life.inventory || {};
  const held = id => inventory[id] || 0;
  const atCamp = distance(a.position, ADVENTURE_ZONES[0]) <= ADVENTURE_ZONES[0].radius;
  if (f.hp < f.max_hp) {
    const food = LIFE_RULES.items.find(item => item.kind === 'food' && held(item.id));
    if (food) add('eat', `吃${food.name}`, `生命${f.hp}/${f.max_hp}，恢复最多${food.heal}点；野外危险仍在`, 'inventory', { intent: 'use', item_id: food.id });
  }
  // A different member's game must not conceal this AI's free choices.
  const game = world.state.game;
  if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) return options;
  if (a.activity) {
    if (a.activity.activity_id !== 'treasure_hunt') add('finish_activity', '结束当前活动', '也可继续活动；有题目的活动需要按题型提交答案', 'finish_activity', {});
    else if (!distance(a.position, a.activity.target)) add('collect', '收集找到的宝物', '已抵达当前藏宝点', 'finish_activity', {});
    return options;
  }
  if (f.plan) return options;

  const farmOptions = [];
  if (atCamp && !f.in_field) {
    for (const plot of life.plots) {
      const crop = LIFE_RULES.crops.find(c => c.id === plot.crop_id);
      if (crop && plot.ready_at !== null && plot.ready_at <= world.now()
        && held(crop.produce_id) <= Number.MAX_SAFE_INTEGER - crop.yield_count && held(crop.seed_id) <= Number.MAX_SAFE_INTEGER - crop.seed_return) {
        farmOptions.push({ id: `harvest_${plot.plot_id}`, label: `收获${crop.name}`, reason: '已成熟，收获存入自己的仓库并返还种子', action: { type: 'farm', payload: { intent: 'harvest', plot_id: plot.plot_id } } });
      } else if (crop && plot.watered_at === null) {
        farmOptions.push({ id: `water_${plot.plot_id}`, label: `浇灌${crop.name}`, reason: `浇水后${crop.grow_seconds}秒成熟，可先去做别的事`, action: { type: 'farm', payload: { intent: 'water', plot_id: plot.plot_id } } });
      }
    }
    // Expose one plot with both seed choices; avoid filling every slot with planting.
    const empty = life.plots.find(plot => !plot.crop_id);
    if (empty) for (const crop of LIFE_RULES.crops) if (held(crop.seed_id)) {
      farmOptions.push({ id: `plant_${crop.id}`, label: `种${crop.name}`, reason: '用自己的种子种在空田，之后需要浇水', action: { type: 'farm', payload: { intent: 'plant', plot_id: empty.plot_id, crop_id: crop.id } } });
    }
    options.push(...farmOptions.slice(0, 2));
    const equipment = LIFE_RULES.items.filter(item => item.kind === 'equipment');
    const strength = item => (item?.attack_bonus || 0) + (item?.defense || 0);
    const better = equipment.filter(item => strength(item) > strength(equipment.find(current => current.id === life.equipment[item.slot])));
    const equip = better.filter(item => held(item.id)).sort((x, y) => strength(y) - strength(x))[0];
    if (equip) add('equip', `装备${equip.name}`, '已有物品，穿戴后实际改变战斗属性', 'inventory', { intent: 'equip', item_id: equip.id });
    else {
      const recipe = LIFE_RULES.recipes.filter(recipe => !held(recipe.item_id) && better.some(item => item.id === recipe.item_id) && Object.entries(recipe.ingredients).every(([id, count]) => held(id) >= count))
        .sort((x, y) => strength(equipment.find(item => item.id === y.item_id)) - strength(equipment.find(item => item.id === x.item_id)))[0];
      if (recipe) add('craft', `制作${equipment.find(item => item.id === recipe.item_id).name}`, '材料足够，制成后还需自己选择穿戴', 'inventory', { intent: 'craft', item_id: recipe.item_id });
    }
  } else {
    add('return_camp', '回营地休息或照料农田', '安全区可种植、收获、制作和穿戴装备', 'adventure_plan', { intent: 'rest' });
  }
  if (atCamp && f.hp < f.max_hp) add('rest', '营地休息', '恢复生命后计划结束，再决定下一步', 'adventure_plan', { intent: 'rest' });
  add('explore_forest', '探索苔光森林', '自由探索；走出安全区可能遇到巡逻怪物', 'adventure_plan', { intent: 'explore', zone_id: 'forest' });
  const target = world.state.adventure.monsters.filter(m => m.status === 'alive' && m.hp > 0)
    .sort((x, y) => x.attack - y.attack || distance(a.position, x.position) - distance(a.position, y.position))[0];
  if (target) add('hunt', `挑战${target.name}`, `目标生命${target.hp}、攻击${target.attack}；击败可获得经验、金币和材料`, 'adventure_plan', { intent: 'hunt', monster_id: target.monster_id });
  if (options.length < 6) add('explore_ruins', '探索风蚀遗迹', '较危险，可以先邀请同伴；是否参战各自决定', 'adventure_plan', { intent: 'explore', zone_id: 'ruins' });
  return options.slice(0, 6);
}
