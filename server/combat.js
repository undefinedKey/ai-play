// One source of effective equipment costs; changing a plan never resets cooldowns.
export const BASE_ATTACK_ENERGY = 3;
export const BASE_MOVE_ENERGY = 0.15;
export const EQUIPMENT = [
  { id: 'wooden_sword', name: '木剑', kind: 'equipment', slot: 'weapon', attack_bonus: 2 },
  { id: 'iron_sword', name: '铁剑', kind: 'equipment', slot: 'weapon', attack_bonus: 5 },
  { id: 'wooden_shield', name: '木盾', kind: 'equipment', slot: 'armor', defense: 1 },
  { id: 'iron_armor', name: '铁甲', kind: 'equipment', slot: 'armor', defense: 3 },
  { id: 'hunter_bow', name: '猎弓', kind: 'equipment', slot: 'weapon', attack_bonus: 1, range: 3, attack_interval_ms: 2000, attack_energy: 2 },
  { id: 'heavy_hammer', name: '重锤', kind: 'equipment', slot: 'weapon', attack_bonus: 8, range: 1, attack_interval_ms: 2000, attack_energy: 5 },
  { id: 'heavy_armor', name: '重型护甲', kind: 'equipment', slot: 'armor', defense: 5, extra_attack_interval_ms: 1000, move_energy_multiplier: 2 },
];
export const STRATEGY_EQUIPMENT_RULES = { item_ids: ['hunter_bow', 'heavy_hammer', 'heavy_armor'],
  defaults: { range: 1, attack_interval_ms: 1000, attack_energy: BASE_ATTACK_ENERGY, move_energy_multiplier: 1 } };
const equipped = (a, slot) => {
  const item = EQUIPMENT.find(item => item.id === a.life?.equipment?.[slot] && item.slot === slot);
  return item && Number.isSafeInteger(a.life?.inventory?.[item.id]) && a.life.inventory[item.id] > 0 ? item : null;
};
export function combatStats(a) {
  const weapon = equipped(a, 'weapon'), armor = equipped(a, 'armor');
  const level = Number.isSafeInteger(a.adventure?.level) && a.adventure.level > 0 ? a.adventure.level : 1;
  return { attack_bonus: weapon?.attack_bonus || 0, defense: armor?.defense || 0,
    attack: 4 + level * 2 + (weapon?.attack_bonus || 0), range: weapon?.range || 1,
    attack_interval_ms: (weapon?.attack_interval_ms || 1000) + (armor?.extra_attack_interval_ms || 0),
    attack_energy: weapon?.attack_energy || BASE_ATTACK_ENERGY,
    move_energy_per_tile: BASE_MOVE_ENERGY * (armor?.move_energy_multiplier || 1) };
}
