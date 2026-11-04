import { WARDROBE_CATALOG, WARDROBE_DYES, WARDROBE_HAIRSTYLES } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';

const catalog = new Map(WARDROBE_CATALOG.map(item => [item.id, item]));
const dyes = new Map(WARDROBE_DYES.map(item => [item.id, item]));
const hairstyles = new Map(WARDROBE_HAIRSTYLES.map(item => [item.id, item]));
export function visibleWardrobe(actor) {
  const record = actor?.wardrobe;
  const hairstyle = hairstyles.has(record?.hairstyle) ? record.hairstyle : 'original';
  const wearing = {};
  for (const slot of ['outfit', 'head', 'back']) {
    const item = record?.wearing?.[slot], definition = catalog.get(item?.style_id);
    wearing[slot] = definition?.slot === slot && dyes.has(item?.color_id) ? { ...item, name: definition.name, color_name: dyes.get(item.color_id).name } : null;
  }
  return { hairstyle, hair_name: hairstyles.get(hairstyle).name, wearing };
}

export function wardrobeLayerKeys(actor) {
  const { hairstyle, wearing } = visibleWardrobe(actor), id = actor?.appearance?.sprite_id;
  return {
    bodyGroup: hairstyle !== 'original' ? 'characters_no_hair' : wearing.head ? 'characters_no_hat' : 'characters',
    bodyId: id,
    hair: hairstyle !== 'original' && /^wanderer_[1-8]$/.test(id || '') ? `hair_${hairstyle}_${id}` : null,
    outfit: wearing.outfit ? `${wearing.outfit.style_id}_${wearing.outfit.color_id}` : null,
    head: wearing.head ? `${wearing.head.style_id}_${wearing.head.color_id}` : null,
    back: wearing.back ? `${wearing.back.style_id}_${wearing.back.color_id}` : null,
  };
}

// All wardrobe atlases use the same 48px cells and animation clock as the body.
// Only this explicit, bounded template is allowed; no reference chains or eval.
export function hydrateWardrobeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Missing pixel manifest');
  const template = manifest.characters?.wanderer_1;
  for (const group of ['wardrobe', 'hairstyles', 'characters_no_hat', 'characters_no_hair', 'wardrobe_hands']) {
    if (!manifest[group]) continue;
    for (const [id, entry] of Object.entries(manifest[group])) {
      if (!entry.animation_template) continue;
      if (entry.animation_template !== 'characters.wanderer_1' || !template?.animations || template.animation_template)
        throw new Error(`Invalid wardrobe animation template: ${group}.${id}`);
      for (const key of ['width', 'height', 'sheet_width', 'sheet_height', 'native_scale'])
        if (entry[key] !== template[key]) throw new Error(`Wardrobe atlas geometry differs: ${group}.${id}.${key}`);
      if (entry.anchor?.x !== 24 || entry.anchor?.y !== 43 || entry.overlay_mode !== 'registered-canvas')
        throw new Error(`Unregistered wardrobe atlas: ${group}.${id}`);
      entry.animations = template.animations;
    }
  }
  return manifest;
}

export function wardrobeDescription(actor) {
  const { hairstyle, hair_name, wearing } = visibleWardrobe(actor);
  return [hairstyle !== 'original' ? hair_name : null, ...Object.values(wearing).filter(Boolean).map(item => `${item.color_name}·${item.name}`)].filter(Boolean);
}
