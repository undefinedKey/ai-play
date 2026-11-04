import { WARDROBE_RULES, WARDROBE_CATALOG, WARDROBE_DYES, WARDROBE_HAIRSTYLES, AQUARIUM_RULES, AQUARIUM_FISH, AQUARIUM_DECORATIONS } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';

export const emptyWardrobe = () => ({ version: 1, hairstyle: 'original', items: [], wearing: { outfit: null, head: null, back: null }, page: 0 });
export const emptyAquarium = () => ({ version: 1, fish: [], decorations: [] });
export function initializeWardrobe(a) {
  if (!a.wardrobe) a.wardrobe = emptyWardrobe();
}
const validItem = item => item && typeof item.garment_id === 'string' && WARDROBE_CATALOG.some(s => s.id === item.style_id)
  && WARDROBE_DYES.some(c => c.id === item.color_id) && Number.isSafeInteger(item.created_at);
export function publicGarment(item) {
  return validItem(item) ? { garment_id: item.garment_id, style_id: item.style_id, color_id: item.color_id, created_at: item.created_at } : null;
}
export function publicWardrobe(a) {
  const wardrobe = a.wardrobe || emptyWardrobe();
  return { version: 1, hairstyle: WARDROBE_HAIRSTYLES.some(h => h.id === wardrobe.hairstyle) ? wardrobe.hairstyle : 'original',
    wearing: Object.fromEntries(WARDROBE_RULES.slots.map(slot => {
      const item = (wardrobe.items || []).find(v => v.garment_id === wardrobe.wearing?.[slot]);
      return [slot, WARDROBE_CATALOG.find(s => s.id === item?.style_id)?.slot === slot ? publicGarment(item) : null];
    })) };
}
export function publicAquarium(value) {
  const tank = value || emptyAquarium();
  return { version: 1,
    fish: (tank.fish || []).filter(f => f && typeof f.fish_id === 'string' && AQUARIUM_FISH.some(s => s.id === f.item_id) && typeof f.name === 'string').slice(0, AQUARIUM_RULES.max_fish)
      .map(f => ({ fish_id: f.fish_id, item_id: f.item_id, name: [...f.name].slice(0, AQUARIUM_RULES.name_chars).join(''), added_at: f.added_at })),
    decorations: (tank.decorations || []).filter(d => AQUARIUM_RULES.decoration_slots.includes(d?.slot) && AQUARIUM_DECORATIONS.some(v => v.id === d.decoration_id))
      .slice(0, AQUARIUM_RULES.decoration_slots.length).map(d => ({ slot: d.slot, decoration_id: d.decoration_id })),
  };
}
