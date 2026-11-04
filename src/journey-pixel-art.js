// Original hand-authored pixel clusters. No copied game assets or downsampled
// ink illustrations: every rectangle is an integer cell in a 48×48 sprite.
export const JOURNEY_SPRITE_GEOMETRY = Object.freeze({ width: 48, height: 48, foot: { x: 24, y: 43 } });
const palettes = [
  { hair: '#714631', hairLight: '#a76e40', coat: '#65a744', coatLight: '#a6d96b', pants: '#516443' },
  { hair: '#8d442e', hairLight: '#bc6b3d', coat: '#e5a43e', coatLight: '#ffe08c', pants: '#766145' },
  { hair: '#294b70', hairLight: '#437da0', coat: '#36a3af', coatLight: '#9be3dd', pants: '#43576e' },
  { hair: '#64416f', hairLight: '#9260a2', coat: '#a677c5', coatLight: '#d6b1eb', pants: '#655c7d' },
  { hair: '#aa4e34', hairLight: '#d67b49', coat: '#d56e43', coatLight: '#f3af68', pants: '#76524b' },
  { hair: '#6b543b', hairLight: '#a78c58', coat: '#6cb77e', coatLight: '#c0e597', pants: '#536b55' },
  { hair: '#ccad62', hairLight: '#f4dc8b', coat: '#cb7796', coatLight: '#f3bdcb', pants: '#71617d' },
  { hair: '#b7c1b5', hairLight: '#e6e9cf', coat: '#718c82', coatLight: '#b8c9a3', pants: '#505e60' },
];
const hash = value => { let n = 2166136261; for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0; return n; };
export function journeyIdentity(actor) {
  const a = actor?.appearance || {}, seed = typeof a.seed === 'string' ? a.seed : actor?.agent_id || 'visitor';
  const number = /^wanderer_[1-8]$/.test(a.sprite_id || '') ? Number(a.sprite_id.slice(-1)) - 1 : hash(seed) % 8;
  const palette = palettes[number], accessory = ['leaf', 'scarf', 'ribbon', 'star'].includes(a.accessory_id) ? a.accessory_id : ['leaf', 'scarf', 'ribbon', 'star'][hash(seed) % 4];
  return { ...palette, variant: number, seed, accessory, accent: /^#[0-9a-f]{6}$/i.test(a.accent || '') ? a.accent : palette.coatLight,
    skin: ['#ffdbb1', '#efbd8b', '#dba775'][hash(seed + ':skin') % 3], skinLight: '#ffe7c7', outline: '#30394b', boots: '#735141' };
}
function drawing() {
  const pixels = [];
  return { pixels, r(x, y, w, h, color, part = 'body') { if (w > 0 && h > 0) pixels.push({ x, y, w, h, color, part }); } };
}
const leg = (d, x, y, p, far = false, raised = false) => {
  d.r(x, y, 5, raised ? 4 : 6, p.outline, far ? 'far-leg' : 'near-leg');
  d.r(x + 1, y, 3, raised ? 3 : 4, p.pants, far ? 'far-leg' : 'near-leg');
  d.r(x, y + (raised ? 3 : 4), 7, 3, p.outline, far ? 'far-leg' : 'near-leg');
  d.r(x + 1, y + (raised ? 3 : 4), 5, 2, far ? '#594439' : p.boots, far ? 'far-leg' : 'near-leg');
};
const hand = (d, x, y, p, part = 'near-arm') => { d.r(x, y, 5, 5, p.outline, part); d.r(x + 1, y, 3, 4, p.skin, part); d.r(x + 2, y, 2, 1, p.skinLight, part); };
function foodPixels(d, itemId, frame) {
  const y = 25 + frame % 2, r = (x, dy, w, h, color) => d.r(x, y + dy, w, h, color, 'food');
  if (['berry', 'roasted_berry'].includes(itemId)) {
    const roasted = itemId === 'roasted_berry';
    r(31, 2, 7, 5, roasted ? '#70473a' : '#783d69');
    r(32, 1, 3, 4, roasted ? '#c47c4f' : '#d96b9c'); r(35, 3, 3, 3, roasted ? '#c99160' : '#b84d88');
    r(33, 0, 2, 2, roasted ? '#76513a' : '#57994e'); r(32, 2, 1, 1, roasted ? '#eab680' : '#f4b0c9');
  } else if (itemId === 'turnip') {
    r(32, 2, 6, 4, '#a99782'); r(33, 2, 4, 4, '#fff0c9'); r(34, 6, 2, 2, '#d9c7a7');
    r(34, 0, 2, 3, '#61a859'); r(32, 0, 2, 1, '#91ca69'); r(36, 0, 2, 2, '#91ca69');
  } else if (itemId === 'wheat_bread') {
    r(31, 1, 8, 5, '#9c6339'); r(32, 0, 6, 4, '#edc37a'); r(33, 0, 3, 1, '#ffdf9b');
  } else if (['turnip_soup', 'moon_stew'].includes(itemId)) {
    r(30, 2, 9, 2, '#647d82'); r(31, 4, 7, 3, '#d5e6db'); r(32, 3, 5, 1, itemId === 'moon_stew' ? '#a4b47e' : '#ead09a');
  } else if (['pond_fish', 'silver_fish', 'grilled_fish'].includes(itemId)) {
    const grilled = itemId === 'grilled_fish';
    r(32, 2, 7, 4, grilled ? '#af7848' : '#88b8c1'); r(30, 1, 2, 6, grilled ? '#c29455' : '#b8dacf'); r(33, 2, 3, 1, grilled ? '#e4b779' : '#e4eee0'); r(37, 3, 1, 1, '#3b4b4b');
  } else if (['wheat', 'moon_herb'].includes(itemId)) {
    r(34, 1, 1, 6, '#65954b'); r(31, 1, 3, 2, itemId === 'wheat' ? '#ecc96c' : '#acccad'); r(35, 2, 3, 2, itemId === 'wheat' ? '#d5b35c' : '#76ae96');
  } else if (itemId === 'trail_ration') {
    r(31, 1, 8, 6, '#718350'); r(32, 2, 6, 4, '#b7bf77'); r(34, 1, 1, 6, '#ece0a6');
  } else {
    // A new/unknown edible keeps a neutral morsel rather than inventing bread.
    r(32, 2, 5, 4, '#c1c7ae'); r(33, 2, 3, 2, '#e6ead3');
  }
}
function toolPixels(d, id, pose, p) {
  const raised = pose === 'raised', strike = pose === 'strike';
  if (id === 'hunter_bow') {
    d.r(36, 22, 2, 16, '#90623b', 'tool'); d.r(38, 25, 2, 10, '#d1a353', 'tool'); d.r(35, 23, 1, 14, '#e9d3aa', 'tool');
    if (strike) { d.r(32, 29, 13, 1, '#654936', 'tool'); d.r(43, 28, 3, 3, '#c3d2dc', 'tool'); }
    return;
  }
  if (id === 'axe' || id === 'pickaxe' || id === 'heavy_hammer') {
    const x = raised ? 32 : strike ? 38 : 34, y = raised ? 11 : strike ? 27 : 27;
    d.r(x, y, 2, 13, '#654936', 'tool'); d.r(x + 1, y, 1, 11, '#d3a55c', 'tool');
    if (id === 'pickaxe') { d.r(x - 4, y, 11, 2, '#304957', 'tool'); d.r(x - 5, y + 2, 3, 3, '#8da6aa', 'tool'); d.r(x + 5, y + 2, 3, 3, '#bad3cf', 'tool'); }
    else { d.r(x - 1, y, id === 'heavy_hammer' ? 10 : 8, 7, '#3d5360', 'tool'); d.r(x + 1, y + 1, id === 'heavy_hammer' ? 7 : 5, 4, '#bcd4d3', 'tool'); d.r(x + 4, y + 1, 2, 2, '#ebf5dc', 'tool'); }
    return;
  }
  if (!['wooden_sword', 'iron_sword'].includes(id)) return;
  const blade = id === 'wooden_sword' ? '#d7ab69' : '#c9e5e4', edge = id === 'wooden_sword' ? '#95663c' : '#7495a5';
  if (strike) { d.r(34, 29, 10, 4, edge, 'tool'); d.r(36, 29, 9, 2, blade, 'tool'); d.r(44, 30, 2, 2, blade, 'tool'); d.r(33, 27, 2, 8, '#e2b345', 'tool'); }
  else { const x = raised ? 33 : 35, y = raised ? 9 : 24; d.r(x, y + 2, 3, 12, edge, 'tool'); d.r(x + 1, y, 2, 12, blade, 'tool'); d.r(x - 2, y + 13, 7, 2, '#e2b345', 'tool'); d.r(x, y + 15, 2, 4, '#674d3a', 'tool'); }
}
export function journeyCharacterPixels(actor, state) {
  const p = journeyIdentity(actor), d = drawing(), r = d.r;
  const frame = state.frame || 0, moving = ['walk', 'run'].includes(state.action), seated = state.action === 'rest';
  const stride = moving ? (state.action === 'run' ? [-4, 0, 4, 0] : [-2, 0, 2, 0])[frame % 4] : 0;
  const bob = moving ? frame % 2 === 1 ? -1 : 0 : state.action === 'gather' && frame === 2 ? 1 : 0;
  const by = bob + (seated ? 5 : 0), toolPose = state.action === 'attack' ? frame < 2 ? 'raised' : 'strike' : state.action === 'gather' ? frame < 2 ? 'raised' : 'strike' : 'idle';
  if (seated) { r(16, 38, 17, 4, p.outline, 'legs'); r(17, 38, 14, 2, p.pants, 'legs'); r(28, 40, 8, 3, p.boots, 'legs'); }
  else { leg(d, 18 - stride, 36 + (moving && frame === 1 ? -1 : 0), p, true, moving && frame === 1); leg(d, 25 + stride, 36 + (moving && frame === 3 ? -1 : 0), p, false, moving && frame === 3); }
  // Far arm, short tunic, and collar make a two-head-high silhouette.
  r(13 - Math.round(stride / 2), 28 + by, 7, 9, p.outline, 'far-arm'); r(14 - Math.round(stride / 2), 29 + by, 4, 5, p.coat, 'far-arm');
  hand(d, 14 - Math.round(stride / 2), 34 + by, p, 'far-arm');
  r(17, 27 + by, 14, 11, p.outline); r(18, 28 + by, 12, 8, p.coat); r(19, 28 + by, 4, 8, p.coatLight); r(18, 35 + by, 12, 2, p.coat);
  r(22, 26 + by, 7, 3, p.skin); r(21, 28 + by, 9, 2, p.coatLight); r(25, 30 + by, 2, 6, '#fff0b0'); r(26, 32 + by, 1, 1, '#956d46');
  r(28, 33 + by, 2, 2, p.accent, 'identity-badge');
  // Keep equipped armor visible, while all body and identity colors remain stable.
  const armor = actor.life?.equipment?.armor;
  if (armor === 'wooden_shield') {
    r(9, 29 + by, 10, 9, p.outline, 'armor-shield'); r(11, 28 + by, 6, 12, p.outline, 'armor-shield');
    r(10, 30 + by, 8, 7, '#b17d43', 'armor-shield'); r(12, 29 + by, 4, 10, '#d7ad65', 'armor-shield');
    r(13, 29 + by, 1, 10, '#997042', 'armor-shield'); r(12, 33 + by, 4, 2, '#efe0a6', 'armor-shield');
  } else if (armor === 'iron_armor') {
    r(19, 30 + by, 10, 6, '#647f94', 'armor-iron'); r(20, 30 + by, 3, 5, '#bed8de', 'armor-iron'); r(24, 30 + by, 4, 1, '#e1ecdc', 'armor-iron');
  } else if (armor === 'heavy_armor') {
    r(17, 29 + by, 14, 8, '#3f5266', 'armor-heavy'); r(18, 30 + by, 12, 5, '#708b9d', 'armor-heavy');
    r(16, 28 + by, 6, 5, '#a7bac6', 'armor-heavy'); r(27, 28 + by, 6, 5, '#a7bac6', 'armor-heavy');
    r(20, 31 + by, 3, 4, '#c7d8d7', 'armor-heavy'); r(18, 35 + by, 12, 2, '#b19663', 'armor-heavy');
  }
  // Rounded head built with stepped one-pixel corners; no vector smoothing.
  const hy = by;
  r(17, 7 + hy, 12, 1, p.outline, 'head'); r(14, 8 + hy, 18, 3, p.outline, 'head'); r(12, 11 + hy, 22, 12, p.outline, 'head'); r(15, 23 + hy, 18, 3, p.outline, 'head'); r(19, 26 + hy, 11, 1, p.outline, 'head');
  r(16, 12 + hy, 17, 11, p.skin, 'face'); r(18, 23 + hy, 13, 3, p.skin, 'face'); r(20, 13 + hy, 12, 4, p.skinLight, 'face'); r(33, 18 + hy, 2, 4, p.outline, 'face'); r(33, 19 + hy, 1, 2, p.skin, 'face');
  r(13, 10 + hy, 7, 12, p.hair, 'hair'); r(15, 8 + hy, 16, 6, p.hair, 'hair'); r(14, 12 + hy, 18, 3, p.hair, 'hair'); r(16, 9 + hy, 10, 2, p.hairLight, 'hair'); r(19, 14 + hy, 4, 3, p.hair, 'hair'); r(26, 14 + hy, 3, 2, p.hair, 'hair'); r(13, 21 + hy, 4, 4, p.hair, 'hair');
  if (p.variant === 2) { r(17, 5 + hy, 5, 4, p.hair, 'hair'); r(20, 3 + hy, 4, 3, p.hair, 'hair'); r(21, 4 + hy, 2, 3, p.hairLight, 'hair'); }
  else if (p.variant === 3) { r(14, 5 + hy, 3, 5, p.hair, 'hair'); r(28, 5 + hy, 3, 5, p.hair, 'hair'); }
  else if (p.variant === 4 || p.variant === 6) { r(9, 10 + hy, 5, 12, p.hair, 'hair'); r(10, 11 + hy, 2, 9, p.hairLight, 'hair'); }
  else if (p.variant === 7) { r(12, 7 + hy, 4, 18, p.coat, 'hood'); r(14, 6 + hy, 17, 3, p.coat, 'hood'); }
  if (state.action === 'rest') { r(24, 20 + hy, 3, 1, p.outline, 'eyes'); r(30, 20 + hy, 2, 1, p.outline, 'eyes'); }
  else if (state.action === 'hurt') { r(24, 19 + hy, 3, 1, p.outline, 'eyes'); r(26, 20 + hy, 1, 2, p.outline, 'eyes'); r(30, 19 + hy, 2, 1, p.outline, 'eyes'); r(30, 20 + hy, 1, 2, p.outline, 'eyes'); }
  else { r(24, 18 + hy, 3, 4, p.outline, 'eyes'); r(30, 18 + hy, 2, 4, p.outline, 'eyes'); r(24, 18 + hy, 1, 1, '#fffdf0', 'eyes'); r(30, 18 + hy, 1, 1, '#fffdf0', 'eyes'); }
  r(20, 22 + hy, 3, 1, '#e8957a', 'face'); r(30, 23 + hy, 2, 1, '#e8957a', 'face'); r(27, 24 + hy, 2, 1, '#a26555', 'face');
  if (p.variant === 1) { r(14, 5 + hy, 17, 7, '#9d723e', 'hat'); r(16, 6 + hy, 13, 5, '#e4bb68', 'hat'); r(10, 11 + hy, 26, 3, p.outline, 'hat'); r(11, 11 + hy, 24, 2, '#f0d285', 'hat'); }
  if (p.accessory === 'leaf') { r(13, 9 + hy, 4, 2, '#a8d55f', 'accessory'); r(11, 7 + hy, 4, 3, '#5fa64e', 'accessory'); r(12, 8 + hy, 2, 1, '#cbe78c', 'accessory'); }
  else if (p.accessory === 'ribbon') { r(12, 10 + hy, 4, 3, p.accent, 'accessory'); r(16, 11 + hy, 2, 2, '#ffe39d', 'accessory'); r(18, 10 + hy, 4, 3, p.accent, 'accessory'); }
  else if (p.accessory === 'star') { r(14, 9 + hy, 2, 6, '#ffe482', 'accessory'); r(12, 11 + hy, 6, 2, '#f0bd48', 'accessory'); }
  else { r(18, 27 + by, 13, 3, p.accent, 'accessory'); r(17, 29 + by, 4, 6, p.accent, 'accessory'); r(18, 33 + by, 2, 1, '#ffe9ae', 'accessory'); }
  let armX = 29 + Math.round(stride / 2), armY = 29 + by;
  if (['attack', 'gather'].includes(state.action)) { armX = toolPose === 'raised' ? 28 : 32; armY = toolPose === 'raised' ? 24 : 29 + by; }
  if (state.action === 'eat') { armX = 29; armY = 24 + (frame % 2); }
  r(armX, armY, 6, 6, p.outline, 'near-arm'); r(armX + 1, armY, 4, 4, p.coatLight, 'near-arm'); hand(d, armX + 1, armY + 4, p);
  const held = state.action === 'gather' ? actor.life?.gathering?.tool_id : ['rest', 'eat'].includes(state.action) ? null : actor.life?.equipment?.weapon;
  toolPixels(d, held, toolPose, p);
  if (state.action === 'eat') foodPixels(d, state.itemId, frame);
  return d.pixels;
}
export function journeyMonsterPixels(monster, state) {
  const d = drawing(), r = d.r, boar = monster.monster_id?.includes('boar'), frame = state.frame || 0;
  const bounce = ['walk', 'run'].includes(state.action) ? frame % 2 ? -1 : 0 : state.action === 'attack' && frame < 2 ? 1 : 0;
  if (!boar) {
    const low = state.action === 'attack' && frame < 2, y = low ? 27 : 24;
    r(13, 41, 25, 2, '#315a4f'); r(9, y + 6, 31, 11 + (low ? 0 : 3), '#315a4f'); r(12, y + 2, 25, 5, '#315a4f'); r(17, y, 16, 3, '#315a4f');
    r(11, y + 7, 27, 9 + (low ? 0 : 3), '#67bb77'); r(14, y + 3, 21, 8, '#8ad78b'); r(18, y + 1, 13, 4, '#b8ec9b'); r(13, 38, 23, 3, '#58a66e');
    r(15, y + 6, 5, 2, '#e4f6be'); r(14, y + 8, 3, 2, '#c5edaa');
    r(23, y - 3, 2, 4, '#3a7953'); r(19, y - 5, 5, 3, '#6eb85b'); r(25, y - 4, 5, 2, '#91cf67');
    if (state.action === 'hurt') { r(24, y + 11, 3, 1, '#294d49'); r(26, y + 12, 1, 2, '#294d49'); r(33, y + 11, 2, 1, '#294d49'); }
    else { r(25, y + 9, 3, 4, '#294d49'); r(33, y + 9, 2, 4, '#294d49'); r(25, y + 9, 1, 1, '#fffceb'); }
    r(21, y + 14, 3, 1, '#c4de7c'); r(35, y + 14, 2, 1, '#c4de7c'); r(29, y + 15, 3, 1, '#46755a');
  } else {
    const y = bounce, stride = ['walk', 'run'].includes(state.action) ? [-2, 0, 2, 0][frame % 4] : 0;
    for (const [x, offset] of [[13, -stride], [20, stride], [29, -stride], [35, stride]]) { r(x + offset, 35 + y, 4, 7 - y, '#553f3a'); r(x + offset, 40, 5, 3, '#353b43'); }
    r(9, 25 + y, 30, 12, '#513f39'); r(12, 21 + y, 24, 7, '#513f39'); r(11, 25 + y, 26, 11, '#aa7750'); r(14, 23 + y, 19, 6, '#ca925e'); r(13, 26 + y, 10, 2, '#dfb27d');
    r(12, 18 + y, 5, 6, '#654c3e'); r(17, 17 + y, 4, 6, '#73513c'); r(21, 19 + y, 4, 5, '#73513c');
    r(29, 20 + y, 8, 7, '#664b3e'); r(31, 21 + y, 3, 4, '#d69b76'); r(32, 26 + y, 9, 10, '#b78358');
    r(38, 29 + y, 7, 7, '#654b42'); r(39, 30 + y, 5, 5, '#d99c7e'); r(40, 32 + y, 1, 2, '#79594d'); r(43, 32 + y, 1, 2, '#79594d');
    r(33, 27 + y, 3, state.action === 'hurt' ? 1 : 3, '#303b42'); if (state.action !== 'hurt') r(33, 27 + y, 1, 1, '#fff7d8');
    r(36, 34 + y, 2, 5, '#faf0c7'); r(38, 32 + y, 2, 4, '#faf0c7'); r(7, 29 + y, 4, 2, '#73513c'); r(6, 27 + y, 2, 3, '#73513c');
  }
  return d.pixels;
}
