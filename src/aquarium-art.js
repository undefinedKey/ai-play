import { AQUARIUM_FISH, AQUARIUM_DECORATIONS } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';

const fishCatalog = new Map(AQUARIUM_FISH.map(item => [item.id, item]));
const decorationCatalog = new Map(AQUARIUM_DECORATIONS.map(item => [item.id, item]));
export function publicAquarium(item) {
  const tank = item?.kind === 'aquarium' ? item.aquarium : null;
  const fish = (Array.isArray(tank?.fish) ? tank.fish : []).filter(row => row?.fish_id && fishCatalog.has(row.item_id)).slice(0, 4)
    .map(row => ({ fish_id: row.fish_id, item_id: row.item_id, name: row.name || '', species: fishCatalog.get(row.item_id).name }));
  const decorations = (Array.isArray(tank?.decorations) ? tank.decorations : []).filter(row => [0, 1, 2].includes(row?.slot) && decorationCatalog.has(row.decoration_id)).slice(0, 3)
    .map(row => ({ slot: row.slot, decoration_id: row.decoration_id, name: decorationCatalog.get(row.decoration_id).name }));
  return { fish, decorations };
}

export function aquariumGeometry(rotation = 0) {
  const normal = [0, 90, 180, 270].includes(Number(rotation)) ? Number(rotation) : 0;
  const side = normal === 90 || normal === 270;
  return { width: side ? 48 : 96, height: side ? 104 : 82,
    water: side ? { x: 6, y: 12, width: 36, height: 55 } : { x: 7, y: 12, width: 82, height: 36 },
    rotation: normal, side, back: normal === 180, west: normal === 90 };
}

const pixelDrawing = (width, height) => {
  const rects = [];
  return { width, height, rects, r(x, y, width, height, fill) { rects.push({ x, y, width, height, fill }); } };
};
export function aquariumFishPixels(species) {
  if (!fishCatalog.has(species)) return { width: 13, height: 9, rects: [] };
  const d = pixelDrawing(13, 9), r = d.r;
  if (species === 'pond_fish') {
    r(0, 2, 2, 5, '#915731'); r(2, 3, 2, 3, '#efbd57'); r(4, 2, 7, 5, '#b97742');
    r(6, 1, 3, 7, '#e5a85b'); r(4, 3, 8, 3, '#efbd57'); r(6, 3, 3, 2, '#ffdf88');
    r(10, 3, 1, 1, '#30394b'); r(6, 6, 2, 2, '#df7f61');
  } else {
    r(0, 2, 3, 5, '#426849'); r(1, 3, 3, 3, '#73b8c9'); r(4, 3, 8, 3, '#73b8c9');
    r(5, 2, 6, 4, '#bfd1d6'); r(6, 1, 3, 1, '#849e96'); r(5, 3, 7, 2, '#eff5df');
    r(7, 6, 2, 1, '#426849'); r(10, 3, 1, 1, '#30394b');
  }
  return { width: d.width, height: d.height, rects: d.rects };
}
export function aquariumDecorationPixels(id) {
  const d = pixelDrawing(16, 18), r = d.r;
  if (id === 'water_grass') {
    r(7, 4, 2, 14, '#426849'); r(5, 2, 3, 7, '#73ab65'); r(9, 0, 2, 6, '#acd88a');
    r(3, 7, 3, 4, '#73ab65'); r(4, 10, 4, 2, '#426849'); r(10, 7, 3, 5, '#73ab65');
    r(9, 12, 3, 3, '#426849'); r(3, 16, 10, 2, '#849e96');
  } else if (id === 'pebbles') {
    r(1, 13, 7, 5, '#426849'); r(2, 12, 5, 4, '#849e96'); r(3, 12, 3, 2, '#bfd1b3');
    r(8, 15, 7, 3, '#426849'); r(9, 13, 5, 4, '#849e96'); r(10, 13, 3, 2, '#bfd1b3');
  } else if (id === 'driftwood') {
    r(1, 14, 13, 4, '#634632'); r(2, 14, 11, 2, '#b97742'); r(5, 8, 3, 7, '#915731');
    r(3, 6, 3, 5, '#634632'); r(9, 11, 3, 4, '#915731'); r(11, 8, 3, 5, '#b97742');
  }
  return { width: d.width, height: d.height, rects: d.rects };
}

// Decorative swimming is local presentation of these exact saved fish, never
// a feeding, breeding or other world action. Every path stays inside the glass.
export function aquariumFishTrack(fish, index, rotation = 0) {
  const { water, side } = aquariumGeometry(rotation);
  let seed = 0; for (const character of String(fish.fish_id)) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  return { x: water.x + 2, y: water.y + 3 + index * (side ? 10 : 5), travel: water.width - 18,
    duration: 9 + seed % 6, delay: -(seed % 100) / 10, steps: water.width - 18 };
}
