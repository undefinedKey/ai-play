// Portable world rules. Garments and fish belong to the original AI; none of
// these operations assigns a personality, memory, preference or next action.
export const WARDROBE_CATALOG = Object.freeze([
  { id: 'linen_shirt', name: '便装衬衫', slot: 'outfit', cost: { grass: 2 } },
  { id: 'garden_apron', name: '园艺围裙', slot: 'outfit', cost: { grass: 3, wood: 1 } },
  { id: 'traveler_coat', name: '旅行外套', slot: 'outfit', cost: { grass: 4, ore: 1 } },
  { id: 'straw_hat', name: '草帽', slot: 'head', cost: { grass: 2 } },
  { id: 'soft_cap', name: '软帽', slot: 'head', cost: { grass: 2, wood: 1 } },
  { id: 'cloth_satchel', name: '布挎包', slot: 'back', cost: { grass: 3 } },
  { id: 'travel_pack', name: '旅行背包', slot: 'back', cost: { grass: 3, wood: 2 } },
]);
export const WARDROBE_DYES = Object.freeze([
  { id: 'natural', name: '原色', color: '#d6b782', cost: {} },
  { id: 'leaf', name: '叶绿', color: '#78a85c', cost: { grass: 1 } },
  { id: 'sky', name: '天蓝', color: '#69a9cf', cost: { moon_herb: 1 } },
  { id: 'rose', name: '莓红', color: '#d97b8c', cost: { berry: 1 } },
  { id: 'ochre', name: '暖黄', color: '#dda64f', cost: { turnip: 1 } },
]);
export const WARDROBE_HAIRSTYLES = Object.freeze([
  { id: 'original', name: '原来发型' }, { id: 'short', name: '短发' },
  { id: 'bob', name: '齐耳短发' }, { id: 'ponytail', name: '马尾' },
]);
export const WARDROBE_RULES = Object.freeze({ version: 1, max_owned: 24, page_size: 4, max_pages: 6,
  slots: ['outfit', 'head', 'back'], catalog: WARDROBE_CATALOG, dyes: WARDROBE_DYES, hairstyles: WARDROBE_HAIRSTYLES,
  notice: '本人在空闲营地或自己小屋中选择制作、穿脱、染色和发型。制作消耗真实材料，染色不返还旧染料，换回原色不花材料。外观覆盖独立于原始身份和战斗装备；脱下恢复原来外观，不改变属性。衣橱库存仅本人可见，公开只展示当前穿着。不会自动搭配或续做。',
});
export const WARDROBE_INTENTS = Object.freeze({ browse: ['page'], craft: ['style_id'], wear: ['garment_id'], remove: ['slot'], dye: ['garment_id', 'color_id'], hairstyle: ['style_id'] });
export const WARDROBE_ID_FIELDS = ['garment_id'];
export const AQUARIUM_FISH = Object.freeze([{ id: 'pond_fish', name: '池塘鱼' }, { id: 'silver_fish', name: '银鳞鱼' }]);
export const AQUARIUM_DECORATIONS = Object.freeze([
  { id: 'water_grass', name: '水草布景', cost: { grass: 1 } },
  { id: 'pebbles', name: '石景', cost: { ore: 1 } },
  { id: 'driftwood', name: '沉木布景', cost: { wood: 1 } },
]);
export const AQUARIUM_RULES = Object.freeze({ version: 1, furniture_kind: 'aquarium', max_fish: 4, decoration_slots: [0, 1, 2], page_size: 1, max_pages: 16, fish: AQUARIUM_FISH, decorations: AQUARIUM_DECORATIONS,
  furniture: { name: '水族箱', width: 2, height: 1, cost: { wood: 4, ore: 3 } }, name_chars: 20,
  notice: '用home craft aquarium制作实物，再由本人摆放。approach只沿屋内真实路线走到鱼缸旁，不自动操作；inspect在缸旁只读查看。放鱼、取鱼、命名和布景须房主在自己已摆放鱼缸旁且停止走动。只接受仓库中真实的未烹饪鱼，每次一条；取回同种鱼，不复制鱼获或奖励。布景保管实际材料，替换/撤下返还旧材料。收起鱼缸保留鱼和布景，仓储内容不公开。无自动喂养、死亡、繁殖或奖励循环。',
});
export const AQUARIUM_INTENTS = Object.freeze({ browse: ['page'], inspect: ['instance_id'], approach: ['instance_id'], put: ['instance_id', 'item_id', 'name'], remove: ['instance_id', 'fish_id'], name: ['instance_id', 'fish_id', 'name'], decorate: ['instance_id', 'slot', 'decoration_id'], clear_decoration: ['instance_id', 'slot'] });
export const AQUARIUM_ID_FIELDS = ['instance_id', 'fish_id'];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const text = (value, max) => typeof value === 'string' && !!value.trim() && [...value].length <= max;
const fields = (p, intents) => object(p) && Object.hasOwn(intents, p.intent) && Object.keys(p).every(key => key === 'intent' || intents[p.intent].includes(key));
export function validWardrobe(p) {
  if (!fields(p, WARDROBE_INTENTS)) return false;
  if (p.intent === 'browse') return integer(p.page, 0, WARDROBE_RULES.max_pages - 1);
  if (p.intent === 'craft') return WARDROBE_CATALOG.some(v => v.id === p.style_id);
  if (p.intent === 'hairstyle') return WARDROBE_HAIRSTYLES.some(v => v.id === p.style_id);
  if (p.intent === 'remove') return WARDROBE_RULES.slots.includes(p.slot);
  if (!id(p.garment_id)) return false;
  return p.intent !== 'dye' || WARDROBE_DYES.some(v => v.id === p.color_id);
}
export function validAquarium(p) {
  if (!fields(p, AQUARIUM_INTENTS)) return false;
  if (p.intent === 'browse') return integer(p.page, 0, AQUARIUM_RULES.max_pages - 1);
  if (!id(p.instance_id)) return false;
  if (p.intent === 'put') return AQUARIUM_FISH.some(v => v.id === p.item_id) && (p.name === undefined || text(p.name, AQUARIUM_RULES.name_chars));
  if (p.intent === 'name') return id(p.fish_id) && text(p.name, AQUARIUM_RULES.name_chars);
  if (p.intent === 'remove') return id(p.fish_id);
  if (['decorate', 'clear_decoration'].includes(p.intent)) return integer(p.slot, 0, 2) && (p.intent === 'clear_decoration' || AQUARIUM_DECORATIONS.some(v => v.id === p.decoration_id));
  return true;
}
export const validateWardrobe = validWardrobe;
export const validateAquarium = validAquarium;
