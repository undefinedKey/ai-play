import { createHash } from 'node:crypto';

const sprites = Array.from({ length: 8 }, (_, i) => `wanderer_${i + 1}`);
const accessories = ['leaf', 'scarf', 'ribbon', 'star'];
const accents = ['#466d73', '#97634d', '#566d9a', '#765786', '#667b42', '#a46c32', '#9a566a', '#447b65'];
const valid = value => value?.version === 1 && /^[a-f0-9]{16}$/.test(value.seed || '') && sprites.includes(value.sprite_id)
  && accessories.includes(value.accessory_id) && /^#[a-f0-9]{6}$/i.test(value.accent || '');
const hash = id => createHash('sha256').update(`plaza-appearance-v1:${id}`).digest('hex');

/** Cosmetic identity is assigned once; repeated reads, joins and restarts never reroll it. */
export function initializeAppearance(a, agents = {}) {
  if (valid(a.appearance)) return;
  const seed = hash(a.agent_id || 'unassigned').slice(0, 16);
  const offset = parseInt(seed.slice(0, 4), 16) % sprites.length;
  const peers = Object.values(agents).filter(peer => peer.agent_id !== a.agent_id && valid(peer.appearance));
  const count = id => peers.filter(peer => peer.appearance.sprite_id === id).length;
  const choices = Array.from({ length: 8 }, (_, index) => sprites[(offset + index) % sprites.length]);
  const whale = /肥鱼|whale|🐳|🐋/iu.test(`${a.name || ''} ${a.avatar || ''}`);
  choices.sort((left, right) => count(left) - count(right));
  const sprite_id = whale ? 'wanderer_3' : choices[0], accessoryOffset = parseInt(seed.slice(4, 8), 16) % accessories.length;
  const accessoryChoices = Array.from({ length: 4 }, (_, index) => accessories[(accessoryOffset + index) % accessories.length]);
  const occupied = id => peers.filter(peer => peer.appearance.sprite_id === sprite_id && peer.appearance.accessory_id === id).length;
  accessoryChoices.sort((left, right) => occupied(left) - occupied(right));
  a.appearance = { version: 1, seed, sprite_id, accessory_id: accessoryChoices[0], accent: accents[parseInt(seed.slice(8, 12), 16) % accents.length] };
}

export function publicAppearance(a) {
  const value = a.appearance;
  if (!valid(value)) return null;
  return { version: 1, seed: value.seed, sprite_id: value.sprite_id, accessory_id: value.accessory_id, accent: value.accent };
}
