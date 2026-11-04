import { randomUUID } from 'node:crypto';
import { adjustInventory, campAvailable } from './life.js';
import { economyBalance, recordEconomyDelta } from './economy.js';
import { homeFurnitureInteraction, approachHomeFurniture } from './homes.js';
import { emptyWardrobe, emptyAquarium, initializeWardrobe, publicGarment, publicWardrobe, publicAquarium } from './lifestyle-state.js';
import { WARDROBE_RULES, WARDROBE_CATALOG, WARDROBE_DYES, WARDROBE_HAIRSTYLES, AQUARIUM_RULES, AQUARIUM_FISH, AQUARIUM_DECORATIONS, validWardrobe, validAquarium } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';
export { WARDROBE_RULES, AQUARIUM_RULES, publicWardrobe };
const copy = value => structuredClone(value);
const placed = f => Number.isInteger(f.x) && Number.isInteger(f.y);
const canPay = (a, cost) => Object.entries(cost).every(([id, quantity]) => (a.life.inventory[id] || 0) >= quantity);
const rejection = () => { throw new Error('unavailable'); };
const available = fn => { try { fn(); return true; } catch { return false; } };
const signedCost = (cost, sign = -1) => Object.fromEntries(Object.entries(cost).map(([id, n]) => [id, n * sign]));
const active = (world, a) => world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() && (a.last_contact_at ?? -45000) + 45000 > world.now();
const publicNotice = (world, a, type, text, extra = {}) => world.event(type, { agent_id: a.agent_id, name: a.name, text, ...extra }, world.activeIds());
function ownIdleHome(world, a, fail) {
  const home = world.state.homes?.[a.home_presence?.home_id];
  if (!home || home.owner_agent_id !== a.agent_id) fail('HOME_OWNER_REQUIRED', '须在自己的小屋内操作');
  if (a.home_presence.movement || a.home_presence.activity) fail('HOME_USE_BUSY', '须先完成或取消屋内行走/家具使用');
  return home;
}
function wardrobeAvailable(world, a, fail) {
  if (a.home_presence) { ownIdleHome(world, a, fail); return; }
  campAvailable(world, a, fail);
}
function ownItem(a, id, fail) {
  const item = a.wardrobe.items.find(v => v.garment_id === id);
  if (!item) fail('WARDROBE_OWNER_REQUIRED', '只能操作自己衣橱中的实物');
  return item;
}
export function initializeLifestyle(world) {
  for (const a of Object.values(world.state.agents)) initializeWardrobe(a);
  for (const h of Object.values(world.state.homes || {})) for (const f of h.furniture || []) if (f.kind === 'aquarium' && !f.aquarium) f.aquarium = emptyAquarium();
}
export function wardrobeObservation(world, a, requestedPage = a.wardrobe?.page || 0) {
  const wardrobe = a.wardrobe || emptyWardrobe(), items = wardrobe.items || [], page = Math.min(5, Math.max(0, requestedPage)),
    owned = items.slice(page * WARDROBE_RULES.page_size, (page + 1) * WARDROBE_RULES.page_size).map(publicGarment).filter(Boolean),
    can_change = active(world, a) && available(() => wardrobeAvailable(world, a, rejection)) && world.features.allows(a, 'wardrobe', { intent: 'craft' });
  const opportunities = [], add = payload => opportunities.push({ type: 'wardrobe', payload });
  if (can_change) {
    if (items.length < WARDROBE_RULES.max_owned) for (const style of WARDROBE_CATALOG) if (canPay(a, style.cost)) add({ intent: 'craft', style_id: style.id });
    for (const item of owned) {
      const slot = WARDROBE_CATALOG.find(s => s.id === item.style_id).slot;
      if (wardrobe.wearing[slot] !== item.garment_id) add({ intent: 'wear', garment_id: item.garment_id });
      for (const dye of WARDROBE_DYES) if (item.color_id !== dye.id && canPay(a, dye.cost)) add({ intent: 'dye', garment_id: item.garment_id, color_id: dye.id });
    }
    for (const slot of WARDROBE_RULES.slots) if (wardrobe.wearing[slot]) add({ intent: 'remove', slot });
    for (const h of WARDROBE_HAIRSTYLES) if (h.id !== wardrobe.hairstyle) add({ intent: 'hairstyle', style_id: h.id });
  }
  return { ...publicWardrobe(a), page, page_size: WARDROBE_RULES.page_size, pages: Math.max(1, Math.ceil(items.length / WARDROBE_RULES.page_size)), owned_count: items.length, owned, can_change, opportunities };
}
export function performWardrobe(world, a, p, fail) {
  if (!validWardrobe(p)) fail('INVALID_ACTION', '衣橱动作字段无效');
  initializeWardrobe(a);
  if (p.intent === 'browse') { a.wardrobe.page = p.page; return { wardrobe: wardrobeObservation(world, a) }; }
  wardrobeAvailable(world, a, fail); const w = a.wardrobe;
  if (p.intent === 'craft') {
    if (w.items.length >= WARDROBE_RULES.max_owned) fail('WARDROBE_FULL', '衣橱最多保管24件衣物');
    const style = WARDROBE_CATALOG.find(s => s.id === p.style_id); adjustInventory(a, signedCost(style.cost), fail);
    const item = { garment_id: `garment_${randomUUID()}`, style_id: style.id, color_id: 'natural', created_at: world.now() }; w.items.push(item);
    w.page = Math.floor((w.items.length - 1) / WARDROBE_RULES.page_size);
    publicNotice(world, a, 'wardrobe_crafted', `${a.name}制作了一件衣物`);
    return { garment: publicGarment(item), wardrobe: wardrobeObservation(world, a) };
  }
  if (p.intent === 'wear') {
    const item = ownItem(a, p.garment_id, fail), slot = WARDROBE_CATALOG.find(s => s.id === item.style_id).slot;
    if (w.wearing[slot] === item.garment_id) fail('WARDROBE_UNCHANGED', '已经穿着这件衣物');
    w.wearing[slot] = item.garment_id;
  } else if (p.intent === 'remove') {
    if (!w.wearing[p.slot]) fail('WARDROBE_UNCHANGED', '这个外观槽已经恢复原貌'); w.wearing[p.slot] = null;
  } else if (p.intent === 'dye') {
    const item = ownItem(a, p.garment_id, fail), dye = WARDROBE_DYES.find(d => d.id === p.color_id);
    if (item.color_id === dye.id) fail('WARDROBE_UNCHANGED', '衣物已经是此颜色'); adjustInventory(a, signedCost(dye.cost), fail); item.color_id = dye.id;
    if (!Object.values(w.wearing).includes(item.garment_id)) { publicNotice(world, a, 'wardrobe_dyed', `${a.name}给衣橱中的衣物换了颜色`); return { wardrobe: wardrobeObservation(world, a) }; }
  } else if (p.intent === 'hairstyle') {
    if (w.hairstyle === p.style_id) fail('WARDROBE_UNCHANGED', '已经是这个发型'); w.hairstyle = p.style_id;
  }
  publicNotice(world, a, 'wardrobe_changed', `${a.name}调整了自己的穿着或发型`);
  return { wardrobe: wardrobeObservation(world, a) };
}

function aquariumHome(world, a) {
  return world.state.homes?.[a.home_presence?.home_id] || world.state.homes?.[`home_${a.agent_id}`] || null;
}
function tankRows(world, a) {
  const home = aquariumHome(world, a); return { home, furniture: (home?.furniture || []).filter(f => f.kind === 'aquarium' && (placed(f) || home.owner_agent_id === a.agent_id)) };
}
function aquariumTarget(world, a, instanceId, fail, { owner = false, adjacent = true } = {}) {
  const current = world.state.homes?.[a.home_presence?.home_id];
  if (!current) fail('HOME_REQUIRED', '须实际进入水族箱所在小屋');
  if (owner && current.owner_agent_id !== a.agent_id) fail('HOME_OWNER_REQUIRED', '只有房主可改变鱼和布景');
  const furniture = current.furniture.find(f => f.instance_id === instanceId && f.kind === 'aquarium' && placed(f));
  if (!furniture) fail('AQUARIUM_UNAVAILABLE', '所在小屋内没有这个已摆放水族箱');
  const interaction = homeFurnitureInteraction(world, a, current, furniture);
  if (a.home_presence.movement || a.home_presence.activity) fail('HOME_USE_BUSY', '请先完成或取消屋内行走/家具使用');
  if (adjacent && !interaction.nearby) fail('AQUARIUM_TOO_FAR', '须先选择 aquarium approach 真实走到鱼缸旁', { interaction_position: interaction.interaction_position });
  return { home: current, furniture, interaction };
}
function aquariumRow(world, a, home, f) {
  const interaction = placed(f) && a.home_presence?.home_id === home.home_id ? homeFurnitureInteraction(world, a, home, f) : { nearby: false, interaction_position: null };
  return { instance_id: f.instance_id, kind: f.kind, x: f.x, y: f.y, rotation: f.rotation, placed: placed(f), aquarium: publicAquarium(f.aquarium), nearby: interaction.nearby, interaction_position: interaction.interaction_position };
}
export function aquariumObservation(world, a, requestedPage = a.aquarium_page || 0) {
  const { home, furniture } = tankRows(world, a), page = Math.min(15, Math.max(0, requestedPage)), selected = furniture.slice(page, page + 1), opportunities = [], add = payload => opportunities.push({ type: 'aquarium', payload });
  if (active(world, a)) for (const f of selected) {
    if (available(() => aquariumTarget(world, a, f.instance_id, rejection))) add({ intent: 'inspect', instance_id: f.instance_id });
    if (!world.features.allows(a, 'aquarium', { intent: 'approach' })) continue;
    if (available(() => aquariumTarget(world, a, f.instance_id, rejection, { adjacent: false }))) {
      const interaction = homeFurnitureInteraction(world, a, home, f);
      if (!interaction.nearby && interaction.interaction_position) add({ intent: 'approach', instance_id: f.instance_id });
    }
    if (!available(() => aquariumTarget(world, a, f.instance_id, rejection, { owner: true }))) continue;
    const tank = f.aquarium || emptyAquarium();
    if (tank.fish.length < AQUARIUM_RULES.max_fish) for (const fish of AQUARIUM_FISH) if ((a.life.inventory[fish.id] || 0) > 0) add({ intent: 'put', instance_id: f.instance_id, item_id: fish.id });
    for (const fish of tank.fish) if (Number.isSafeInteger((a.life.inventory[fish.item_id] || 0) + 1)) add({ intent: 'remove', instance_id: f.instance_id, fish_id: fish.fish_id });
    for (const slot of AQUARIUM_RULES.decoration_slots) {
      const old = tank.decorations.find(d => d.slot === slot), oldCost = AQUARIUM_DECORATIONS.find(d => d.id === old?.decoration_id)?.cost || {};
      if (old && Object.entries(oldCost).every(([id, n]) => Number.isSafeInteger((a.life.inventory[id] || 0) + n))) add({ intent: 'clear_decoration', instance_id: f.instance_id, slot });
      for (const d of AQUARIUM_DECORATIONS) if (old?.decoration_id !== d.id && Object.keys({ ...oldCost, ...d.cost }).every(id => {
        const n = (a.life.inventory[id] || 0) + (oldCost[id] || 0) - (d.cost[id] || 0); return Number.isSafeInteger(n) && n >= 0;
      })) add({ intent: 'decorate', instance_id: f.instance_id, slot, decoration_id: d.id });
    }
  }
  return { version: 1, page, page_size: 1, pages: Math.max(1, furniture.length), tank_count: furniture.length, home_id: home?.home_id || null, owner_agent_id: home?.owner_agent_id || null,
    tanks: selected.map(f => aquariumRow(world, a, home, f)), available_fish: AQUARIUM_FISH.map(s => ({ item_id: s.id, count: a.life.inventory[s.id] || 0 })), opportunities };
}
export function performAquarium(world, a, p, fail, actionId) {
  if (!validAquarium(p)) fail('INVALID_ACTION', '水族箱动作字段无效');
  if (p.intent === 'browse') { a.aquarium_page = p.page; return { aquarium: aquariumObservation(world, a) }; }
  if (p.intent === 'approach') {
    const { home, furniture } = aquariumTarget(world, a, p.instance_id, fail, { adjacent: false });
    approachHomeFurniture(world, a, home, furniture, fail);
    return { aquarium: aquariumObservation(world, a) };
  }
  const { home, furniture } = aquariumTarget(world, a, p.instance_id, fail, { owner: p.intent !== 'inspect' });
  if (p.intent === 'inspect') return { aquarium: aquariumRow(world, a, home, furniture) };
  furniture.aquarium ??= emptyAquarium(); const tank = furniture.aquarium, before = economyBalance(a);
  let fish;
  if (p.intent === 'put') {
    if (tank.fish.length >= AQUARIUM_RULES.max_fish) fail('AQUARIUM_FULL', '每个水族箱最多保管4条鱼');
    adjustInventory(a, { [p.item_id]: -1 }, fail);
    fish = { fish_id: `tankfish_${randomUUID()}`, item_id: p.item_id, name: p.name?.trim() || AQUARIUM_FISH.find(f => f.id === p.item_id).name, added_at: world.now() };
    tank.fish.push(fish);
  } else if (p.intent === 'remove' || p.intent === 'name') {
    fish = tank.fish.find(f => f.fish_id === p.fish_id); if (!fish) fail('AQUARIUM_FISH_NOT_FOUND', '这个鱼缸中没有这条鱼');
    if (p.intent === 'name') fish.name = p.name.trim();
    else { adjustInventory(a, { [fish.item_id]: 1 }, fail); tank.fish = tank.fish.filter(f => f !== fish); }
  } else if (p.intent === 'decorate' || p.intent === 'clear_decoration') {
    const old = tank.decorations.find(d => d.slot === p.slot), replacement = p.intent === 'decorate' ? AQUARIUM_DECORATIONS.find(d => d.id === p.decoration_id) : null;
    if (old?.decoration_id === replacement?.id || !old && !replacement) fail('AQUARIUM_UNCHANGED', '这个位置的布景没有变化');
    const changes = signedCost(AQUARIUM_DECORATIONS.find(d => d.id === old?.decoration_id)?.cost || {}, 1);
    for (const [id, n] of Object.entries(replacement?.cost || {})) changes[id] = (changes[id] || 0) - n;
    adjustInventory(a, changes, fail); tank.decorations = tank.decorations.filter(d => d.slot !== p.slot);
    if (replacement) tank.decorations.push({ slot: p.slot, decoration_id: replacement.id }); tank.decorations.sort((a, b) => a.slot - b.slot);
  }
  home.updated_at = world.now();
  recordEconomyDelta(a, before, { source_id: actionId, reason: `aquarium_${p.intent}`, at: world.now(), world, countProgress: false });
  publicNotice(world, a, 'aquarium_changed', `${a.name}${{ put: '把一条鱼放进水族箱', remove: '从水族箱取回了一条鱼', name: '为鱼起了名字', decorate: '调整了水族箱布景', clear_decoration: '收回了水族箱布景' }[p.intent]}`, { home_id: home.home_id, instance_id: furniture.instance_id, intent: p.intent });
  return { ...(fish && p.intent === 'put' ? { fish: copy(fish) } : {}), aquarium: aquariumRow(world, a, home, furniture) };
}
