import { randomUUID } from 'node:crypto';
import { adjustInventory, campAvailable } from './life.js';
import { findPath, recordMovement, advanceMovement, stopMovement } from './spatial.js';
import { spendEnergy, publicFatigue } from './fatigue.js';

export const HOME_RULES = Object.freeze({
  version: 1, map: { width: 10, height: 8 }, door: { x: 5, y: 7 }, entrance: { scene_id: 'plaza', x: 9, y: 8 },
  build_cost: { wood: 6, grass: 2 }, max_furniture: 12, max_displays: 4, max_guests: 2,
  visit_seconds: 120, invitation_seconds: 600, invitation_cooldown_seconds: 60, max_pending_invitations: 2,
  message_seconds: 10, max_messages: 20, max_move: 3, souvenir_items: ['wood', 'ore', 'pine_cone'],
  furniture_catalog: {
    chair: { name: '木椅', width: 1, height: 1, cost: { wood: 2 } },
    table: { name: '木桌', width: 2, height: 1, cost: { wood: 3 } },
    rug: { name: '草编地毯', width: 2, height: 2, cost: { grass: 3 } },
    display_shelf: { name: '纪念品展架', width: 2, height: 1, cost: { wood: 3, ore: 1 } },
  },
  notice: '建造、布置、邀请和来访均由本人选择；室内照明安全但饥饿仍消耗。站立沿用营地缓慢恢复，不自动吃东西或执行计划。所有家具占格，门到所有空格必须连通。',
});
export const HOME_INTENTS = {
  build: ['name'], rename: ['name'], craft: ['kind'], place: ['instance_id', 'x', 'y', 'rotation'], store: ['instance_id'],
  display: ['instance_id', 'item_id', 'title', 'text'], withdraw: ['display_id'], invite: ['target_agent_id'],
  respond: ['invitation_id', 'accept'], visit: ['home_id', 'mode'], cancel: [], leave: [], move: ['x', 'y'],
  message: ['text'], remove_message: ['message_id'],
};
const uid = prefix => `${prefix}_${randomUUID()}`;
const copy = value => structuredClone(value);
const key = p => `${p.x},${p.y}`;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const inside = p => Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.x < 10 && p.y >= 0 && p.y < 8;
const integer = p => inside(p) && Number.isInteger(p.x) && Number.isInteger(p.y);
const cells = (f, kind = f.kind) => {
  const def = HOME_RULES.furniture_catalog[kind]; if (!def || !Number.isInteger(f.x) || !Number.isInteger(f.y)) return [];
  const rotated = f.rotation === 90 || f.rotation === 270, w = rotated ? def.height : def.width, h = rotated ? def.width : def.height;
  return Array.from({ length: w * h }, (_, i) => ({ x: f.x + i % w, y: f.y + Math.floor(i / w) }));
};
const placed = f => Number.isInteger(f.x) && Number.isInteger(f.y);
const active = (world, a) => world.state.room.status === 'active' && a?.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() && (a.last_contact_at ?? -45000) + 45000 > world.now();
const homeFor = (world, a) => world.state.homes?.[`home_${a.agent_id}`] || null;
const occupants = (world, id) => Object.values(world.state.agents).filter(a => a.home_presence?.home_id === id);
const recipients = (world, id) => occupants(world, id).filter(a => a.status === 'active').map(a => a.agent_id);
const announce = (world, a, home, type, text, extra = {}) => {
  const audience = [...new Set([...recipients(world, home.home_id), a.agent_id, home.owner_agent_id])];
  return world.event(type, { agent_id: a.agent_id, name: a.name, home_id: home.home_id, owner_agent_id: home.owner_agent_id, recipient_agent_ids: audience, text, ...extra }, audience);
};
function text(value, max, fail, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) fail('INVALID_ACTION', `文字须为 1–${max} 字`);
  return value.trim();
}
function identifier(value, fail) { if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{1,160}$/.test(value)) fail('INVALID_ACTION', '标识符无效'); return value; }
function validate(p, fail) {
  if (typeof p.intent !== 'string' || !Object.hasOwn(HOME_INTENTS, p.intent) || Object.keys(p).some(k => k !== 'intent' && !HOME_INTENTS[p.intent].includes(k))) fail('INVALID_ACTION', '家园动作字段无效');
  for (const k of ['instance_id', 'display_id', 'target_agent_id', 'invitation_id', 'home_id', 'message_id']) if (HOME_INTENTS[p.intent].includes(k)) identifier(p[k], fail);
  if (['place', 'move'].includes(p.intent) && !integer(p)) fail('INVALID_ACTION', '室内目标须为 10×8 内整数坐标');
  if (p.rotation !== undefined && ![0, 90, 180, 270].includes(p.rotation)) fail('INVALID_ACTION', '旋转只能是 0/90/180/270');
  if (p.mode !== undefined && !['walk', 'run'].includes(p.mode)) fail('INVALID_ACTION', 'mode 只能为 walk/run');
  if (p.intent === 'respond' && typeof p.accept !== 'boolean') fail('INVALID_ACTION', 'accept 必须为布尔值');
}
export function initializeHomes(world, { restore = false } = {}) {
  world.state.homes ??= {}; world.state.home_invitations ??= {};
  for (const a of Object.values(world.state.agents)) {
    if (a.home_presence) { a.scene_id = 'plaza'; a.position = { x: 9, y: 8 }; a.position_at = world.now(); a.movement = null; }
    a.home_presence = null; a.home_travel = null;
  }
  if (restore) world.state.home_invitations = {};
}
export function publicHome(home, { storage = false } = {}) {
  if (!home) return null;
  return { home_id: home.home_id, owner_agent_id: home.owner_agent_id, name: home.name, created_at: home.created_at, updated_at: home.updated_at,
    furniture: home.furniture.filter(placed).map(f => ({ instance_id: f.instance_id, kind: f.kind, x: f.x, y: f.y, rotation: f.rotation })),
    displays: home.displays.map(d => ({ display_id: d.display_id, instance_id: d.instance_id, item_id: d.item_id, title: d.title, text: d.text, placed_at: d.placed_at })),
    messages: home.messages.map(m => ({ message_id: m.message_id, author_agent_id: m.author_agent_id, author_name: m.author_name, text: m.text, created_at: m.created_at })),
    ...(storage ? { storage: home.furniture.filter(f => !placed(f)).map(f => ({ instance_id: f.instance_id, kind: f.kind })) } : {}) };
}
export const publicHomes = world => Object.values(world.state.homes || {}).map(h => publicHome(h));
export function publicHomePresence(a) {
  const p = a.home_presence; if (!p || !inside(p.position)) return null;
  const m = p.movement;
  return { home_id: p.home_id, position: { ...p.position }, entered_at: p.entered_at, position_at: p.position_at, facing: p.facing,
    movement: m ? { version: 2, movement_id: m.movement_id, scene_id: 'home', path: m.path.map(q => ({ x: q.x, y: q.y })), started_at: m.started_at, ends_at: m.ends_at, duration_ms: m.duration_ms, mode: m.mode, speed: m.speed } : null };
}
export const publicHomeTravel = a => a.home_travel ? { home_id: a.home_travel.home_id, expires_at: a.home_travel.expires_at } : null;
function freshAction(a) {
  if (a.next_action_id) a.scene_stale_actions = [...(a.scene_stale_actions || []), a.next_action_id].slice(-8);
  a.next_action_id = uid('act');
}
function validInvite(world, i) {
  const from = world.state.agents[i?.from_agent_id], to = world.state.agents[i?.target_agent_id];
  return !!i && ['pending', 'accepted'].includes(i.status) && i.expires_at > world.now() && active(world, from) && active(world, to)
    && from.run.run_id === i.from_run_id && to.run.run_id === i.target_run_id && from.session_epoch === i.from_epoch && to.session_epoch === i.target_epoch;
}
function acceptedInvite(world, a, home) {
  return Object.values(world.state.home_invitations).find(i => i.home_id === home.home_id && i.target_agent_id === a.agent_id && i.status === 'accepted' && validInvite(world, i));
}
function guestCount(world, home, except) {
  return Object.values(world.state.agents).filter(a => a.agent_id !== except && a.agent_id !== home.owner_agent_id && (a.home_presence?.home_id === home.home_id || a.home_travel?.home_id === home.home_id)).length;
}
function roomBlocked(home, except = null) { return new Set(home.furniture.filter(f => f.instance_id !== except && placed(f)).flatMap(f => cells(f)).map(key)); }
function nearbyCells(p) {
  return [{ x: Math.floor(p.x), y: Math.floor(p.y) }, { x: Math.ceil(p.x), y: Math.ceil(p.y) }];
}
function occupiedCells(world, home, except) {
  return new Set(occupants(world, home.home_id).filter(a => a.agent_id !== except).flatMap(a => [...nearbyCells(a.home_presence.position), ...(a.home_presence.movement?.path || [])]).map(key));
}
function roomPath(home, start, target, { maxSteps = 80, blocked = roomBlocked(home) } = {}) {
  if (!inside(start) || !integer(target) || blocked.has(key(target))) return null;
  const starts = nearbyCells(start).filter(p => integer(p) && !blocked.has(key(p)));
  const candidates = [];
  for (const s of starts) {
    const queue = [s], previous = new Map([[key(s), null]]);
    for (let n = 0; n < queue.length; n++) {
      const p = queue[n];
      if (key(p) === key(target)) {
        const route = []; for (let q = p; q; q = previous.get(key(q))) route.push(q); route.reverse();
        if (distance(start, s)) route.unshift({ ...start });
        if (route.slice(1).reduce((sum, q, i) => sum + distance(q, route[i]), 0) <= maxSteps) candidates.push(route);
        break;
      }
      for (const q of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }])
        if (integer(q) && !blocked.has(key(q)) && !previous.has(key(q))) { previous.set(key(q), p); queue.push(q); }
    }
  }
  return candidates.sort((a, b) => a.length - b.length)[0] || null;
}
function placementAllowed(world, home, f) {
  const footprint = cells(f), blocked = roomBlocked(home, f.instance_id), occupied = occupiedCells(world, home);
  if (!footprint.length || footprint.some(p => !integer(p) || blocked.has(key(p)) || occupied.has(key(p)) || p.y === 7 && p.x >= 4 && p.x <= 6)) return false;
  footprint.forEach(p => blocked.add(key(p)));
  // Every remaining free tile must remain connected to the doorway: no sealed rooms or trapped visitors.
  const queue = [{ ...HOME_RULES.door }], seen = new Set([key(HOME_RULES.door)]);
  for (let n = 0; n < queue.length; n++) {
    const p = queue[n];
    for (const q of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }])
      if (integer(q) && !blocked.has(key(q)) && !seen.has(key(q))) { seen.add(key(q)); queue.push(q); }
  }
  return seen.size + blocked.size === 80;
}
function ownInside(world, a, fail) {
  const home = homeFor(world, a);
  if (!home || a.home_presence?.home_id !== home.home_id) fail('HOME_OWNER_REQUIRED', '须在自己的小屋内操作');
  if (a.home_presence.movement) fail('MOVEMENT_BUSY', '请等待室内行走结束');
  return home;
}
function idleOutside(world, a, fail) {
  if (a.home_presence || a.home_travel || a.movement || a.adventure?.plan || a.activity || a.life?.gathering || a.survival?.travel || a.group_id || (world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id))) fail('HOME_BUSY', '请先结束当前行程、活动或小组，再自主前往小屋');
  if (a.scene_id !== 'plaza' || a.adventure?.in_field) fail('SCENE_REQUIRED', '先自主返回广场再前往小屋');
}
function charge(a, cost, fail) { adjustInventory(a, Object.fromEntries(Object.entries(cost).map(([id, n]) => [id, -n])), fail); }
function canAfford(a, cost) { return Object.entries(cost).every(([id, n]) => (a.life?.inventory?.[id] || 0) >= n); }
export function cancelHomeTravel(world, a, reason = 'cancelled') {
  const travel = a.home_travel; if (!travel) return false;
  a.home_travel = null; stopMovement(a, world.now());
  world.event('home_travel_cancelled', { agent_id: a.agent_id, home_id: travel.home_id, reason, text: `${a.name}的家园行程已结束` }, [a.agent_id]); return true;
}
function leaveHome(world, a, reason) {
  const presence = a.home_presence; if (!presence) return false;
  const ids = recipients(world, presence.home_id);
  a.home_presence = null; a.home_travel = null; a.scene_id = 'plaza'; a.position = { x: 9, y: 8 }; a.position_at = world.now(); stopMovement(a, world.now()); freshAction(a);
  const ownerId = world.state.homes[presence.home_id]?.owner_agent_id, audience = [...new Set([...ids, a.agent_id, ...(ownerId ? [ownerId] : [])])];
  world.event('home_left', { agent_id: a.agent_id, home_id: presence.home_id, owner_agent_id: ownerId, recipient_agent_ids: audience, reason, text: `${a.name}离开了小屋` }, audience); return true;
}
export function detachHomes(world, a, reason = 'interrupted') {
  let changed = cancelHomeTravel(world, a, reason); changed = leaveHome(world, a, reason) || changed;
  for (const i of Object.values(world.state.home_invitations || {})) if (['pending', 'accepted'].includes(i.status) && [i.from_agent_id, i.target_agent_id].includes(a.agent_id)) { i.status = 'cancelled'; changed = true; }
  // A disconnected host cannot silently keep guests under an obsolete invitation.
  for (const guest of Object.values(world.state.agents)) if (guest.agent_id !== a.agent_id && (guest.home_presence?.home_id === `home_${a.agent_id}` || guest.home_travel?.home_id === `home_${a.agent_id}`)) {
    changed = leaveHome(world, guest, 'host_unavailable') || changed; changed = cancelHomeTravel(world, guest, 'host_unavailable') || changed;
  }
  return changed;
}
function enterHome(world, a, home) {
  const blocked = roomBlocked(home), occupied = occupiedCells(world, home);
  const candidates = Array.from({ length: 80 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10) })).sort((p, q) => distance(p, HOME_RULES.door) - distance(q, HOME_RULES.door));
  const position = candidates.find(p => !occupied.has(key(p)) && roomPath(home, HOME_RULES.door, p, { blocked }));
  if (!position) return false;
  a.home_travel = null; stopMovement(a, world.now()); a.position = { x: 9, y: 8 }; a.position_at = world.now();
  a.home_presence = { home_id: home.home_id, scene_id: 'home', position: { ...position }, position_at: world.now(), facing: 'north', movement: null, entered_at: world.now(), run_id: a.run.run_id, session_epoch: a.session_epoch };
  freshAction(a); announce(world, a, home, 'home_entered', `${a.name}走进了「${home.name}」`); return true;
}
export function performHome(world, a, p, fail) {
  validate(p, fail); const now = world.now(); let home = homeFor(world, a);
  if (p.intent === 'cancel') { cancelHomeTravel(world, a); if (a.home_presence?.movement) stopMovement(a.home_presence, now); }
  else if (p.intent === 'leave') { cancelHomeTravel(world, a); leaveHome(world, a, 'left'); }
  else if (p.intent === 'build') {
    if (home) fail('HOME_EXISTS', '每个角色只有一间小屋');
    if (a.home_presence || a.home_travel) fail('HOME_BUSY', '请先离开小屋或结束家园行程');
    campAvailable(world, a, fail); const name = text(p.name, 30, fail, `${a.name}的小家`); charge(a, HOME_RULES.build_cost, fail);
    home = { home_id: `home_${a.agent_id}`, owner_agent_id: a.agent_id, name, created_at: now, updated_at: now, furniture: [], displays: [], messages: [] };
    world.state.homes[home.home_id] = home; announce(world, a, home, 'home_built', `${a.name}建好了「${name}」`);
  } else if (p.intent === 'rename') {
    if (!home) fail('HOME_OWNER_REQUIRED', '还没有自己的小屋'); home.name = text(p.name, 30, fail); home.updated_at = now;
    announce(world, a, home, 'home_renamed', `${a.name}把小屋命名为「${home.name}」`);
  } else if (p.intent === 'craft') {
    home = ownInside(world, a, fail); if (typeof p.kind !== 'string' || !Object.hasOwn(HOME_RULES.furniture_catalog, p.kind)) fail('INVALID_ACTION', '请选择家具目录内种类');
    if (home.furniture.length >= 12) fail('HOME_FULL', '家具仓储与摆放共计最多12件');
    charge(a, HOME_RULES.furniture_catalog[p.kind].cost, fail); home.furniture.push({ instance_id: uid('furniture'), kind: p.kind, x: null, y: null, rotation: 0 }); home.updated_at = now;
    announce(world, a, home, 'home_crafted', `${a.name}制作了${HOME_RULES.furniture_catalog[p.kind].name}`, { kind: p.kind });
  } else if (p.intent === 'place' || p.intent === 'store') {
    home = ownInside(world, a, fail); const f = home.furniture.find(f => f.instance_id === p.instance_id); if (!f) fail('HOME_OWNER_REQUIRED', '只能操作自己拥有的家具');
    if (p.intent === 'place') { const target = { ...f, x: p.x, y: p.y, rotation: p.rotation ?? 0 }; if (!placementAllowed(world, home, target)) fail('HOME_COLLISION', '家具越界、重叠、挡住门/人物或切断通道'); Object.assign(f, target); }
    else { if (!placed(f)) fail('INVALID_ACTION', '家具已在仓储中'); if (home.displays.some(d => d.instance_id === f.instance_id)) fail('DISPLAY_OCCUPIED', '先撤下纪念品再收起展架'); f.x = null; f.y = null; }
    home.updated_at = now; announce(world, a, home, 'home_furnished', `${a.name}${p.intent === 'place' ? '摆放' : '收起'}了${HOME_RULES.furniture_catalog[f.kind].name}`, { instance_id: f.instance_id, kind: f.kind });
  } else if (p.intent === 'display') {
    home = ownInside(world, a, fail); const f = home.furniture.find(f => f.instance_id === p.instance_id && f.kind === 'display_shelf' && placed(f));
    if (!f || home.displays.some(d => d.instance_id === f.instance_id) || home.displays.length >= 4) fail('DISPLAY_UNAVAILABLE', '需要一个空的已摆放展架，最多4件纪念品');
    if (!HOME_RULES.souvenir_items.includes(p.item_id)) fail('INVALID_ACTION', '此物品不可陈列');
    const title = text(p.title, 30, fail, p.item_id), caption = p.text === '' ? '' : text(p.text, 120, fail, ''); adjustInventory(a, { [p.item_id]: -1 }, fail);
    home.displays.push({ display_id: uid('display'), instance_id: f.instance_id, item_id: p.item_id, title, text: caption, placed_at: now }); home.updated_at = now;
    announce(world, a, home, 'home_displayed', `${a.name}展示了「${title}」`, { item_id: p.item_id, instance_id: f.instance_id });
  } else if (p.intent === 'withdraw') {
    home = ownInside(world, a, fail); const d = home.displays.find(d => d.display_id === p.display_id); if (!d) fail('NOT_FOUND', '纪念品不存在');
    adjustInventory(a, { [d.item_id]: 1 }, fail); home.displays = home.displays.filter(x => x !== d); home.updated_at = now;
    announce(world, a, home, 'home_withdrawn', `${a.name}收回了「${d.title}」`, { item_id: d.item_id });
  } else if (p.intent === 'invite') {
    if (!home) fail('HOME_OWNER_REQUIRED', '先建造自己的小屋'); const target = world.state.agents[p.target_agent_id];
    if (!active(world, target) || target.agent_id === a.agent_id) fail('INVALID_ACTION', '只能邀请正在活动的其他角色');
    const invites = Object.values(world.state.home_invitations).filter(i => i.from_agent_id === a.agent_id);
    if (invites.some(i => i.target_agent_id === target.agent_id && (now - i.created_at < 60000 || validInvite(world, i)))) fail('INVITE_COOLDOWN', '该对象已有有效邀请或仍在60秒冷却内');
    if (invites.filter(i => i.status === 'pending' && validInvite(world, i)).length >= 2) fail('INVITE_PENDING', '最多两份待处理邀请');
    const i = { invitation_id: uid('homeinvite'), home_id: home.home_id, from_agent_id: a.agent_id, target_agent_id: target.agent_id, status: 'pending', created_at: now, expires_at: Math.min(now + 600000, a.run.expires_at, target.run.expires_at), from_run_id: a.run.run_id, target_run_id: target.run.run_id, from_epoch: a.session_epoch, target_epoch: target.session_epoch };
    world.state.home_invitations[i.invitation_id] = i; world.event('home_invitation', { agent_id: a.agent_id, invitation_id: i.invitation_id, home_id: home.home_id, from_agent_id: a.agent_id, target_agent_id: target.agent_id, expires_at: i.expires_at, text: `${a.name}邀请你到「${home.name}」作客` }, [a.agent_id, target.agent_id]);
  } else if (p.intent === 'respond') {
    const i = world.state.home_invitations[p.invitation_id]; if (!i || i.target_agent_id !== a.agent_id || i.status !== 'pending' || !validInvite(world, i)) fail('INVITATION_EXPIRED', '这不是你有效的待处理邀请');
    i.status = p.accept ? 'accepted' : 'declined'; world.event('home_invitation_response', { agent_id: a.agent_id, invitation_id: i.invitation_id, home_id: i.home_id, from_agent_id: i.from_agent_id, target_agent_id: a.agent_id, status: i.status, text: `${a.name}${p.accept ? '接受' : '婉拒'}了串门邀请` }, [a.agent_id, i.from_agent_id]);
  } else if (p.intent === 'visit') {
    idleOutside(world, a, fail); home = world.state.homes[p.home_id]; if (!home) fail('NOT_FOUND', '小屋不存在');
    const invite = a.agent_id !== home.owner_agent_id ? acceptedInvite(world, a, home) : null;
    if (a.agent_id !== home.owner_agent_id && !invite) fail('HOME_INVITE_REQUIRED', '来访需本人接受且仍有效的定向邀请');
    if (a.agent_id !== home.owner_agent_id && guestCount(world, home, a.agent_id) >= 2) fail('HOME_FULL', '小屋最多同时接待两位客人（含正在前来的客人）');
    if (p.mode === 'run' && publicFatigue(a).energy <= 0) fail('FATIGUE_EXHAUSTED', '体力不足以奔跑，可选择步行');
    const path = findPath('plaza', a.position, HOME_RULES.entrance); if (!path) fail('NO_PATH', '当前位置无法到达家园入口');
    recordMovement(a, path, now, p.mode); a.home_travel = { home_id: home.home_id, started_at: now, expires_at: Math.min(now + 120000, a.run.expires_at, invite?.expires_at ?? Infinity), movement_id: a.movement?.movement_id ?? null, run_id: a.run.run_id, session_epoch: a.session_epoch, hp_at_start: a.adventure.hp };
    announce(world, a, home, 'home_travel_started', `${a.name}自主前往「${home.name}」`, { expires_at: a.home_travel.expires_at });
    if (!a.movement && !enterHome(world, a, home)) fail('HOME_FULL', '入口暂无可用站位');
  } else if (p.intent === 'move') {
    home = world.state.homes[a.home_presence?.home_id]; if (!home) fail('HOME_REQUIRED', '你不在小屋内');
    if (a.home_presence.movement) fail('MOVEMENT_BUSY', '请等待走完或用home cancel停下');
    const blocked = roomBlocked(home); occupiedCells(world, home, a.agent_id).forEach(cell => blocked.add(cell));
    const path = roomPath(home, a.home_presence.position, p, { maxSteps: 3, blocked }); if (!path || path.length < 2) fail('HOME_COLLISION', '目标最多3步，不可穿家具或占用他人位置');
    recordMovement(a.home_presence, path, now); announce(world, a, home, 'home_moved', `${a.name}在屋内走动`);
  } else if (p.intent === 'message') {
    home = world.state.homes[a.home_presence?.home_id]; if (!home) fail('HOME_REQUIRED', '须实际进入小屋才能留言');
    if (now - (a.home_last_message_at ?? -Infinity) < 10000) fail('RATE_LIMITED', '留言间隔至少10秒');
    const message = { message_id: uid('note'), author_agent_id: a.agent_id, author_name: a.name, text: text(p.text, 200, fail), created_at: now };
    home.messages.push(message); home.messages = home.messages.slice(-20); home.updated_at = now; a.home_last_message_at = now;
    announce(world, a, home, 'home_message', message.text, { message_id: message.message_id, owner_agent_id: home.owner_agent_id, recipient_agent_ids: [...new Set([...recipients(world, home.home_id), home.owner_agent_id])] });
  } else if (p.intent === 'remove_message') {
    home = Object.values(world.state.homes).find(h => h.messages.some(m => m.message_id === p.message_id)); const message = home?.messages.find(m => m.message_id === p.message_id);
    if (!home || !message || home.owner_agent_id !== a.agent_id && message.author_agent_id !== a.agent_id) fail('HOME_OWNER_REQUIRED', '仅房主或留言作者可移除留言');
    home.messages = home.messages.filter(m => m !== message); home.updated_at = now; announce(world, a, home, 'home_message_removed', `${a.name}移除了一条留言`, { message_id: message.message_id });
  }
  return { homes: homesObservation(world, a), home_presence: publicHomePresence(a), home_travel: publicHomeTravel(a) };
}
export function homeLightUntil(world, a) {
  const p = a.home_presence; if (!p) return -Infinity; const home = world.state.homes[p.home_id]; if (!home) return -Infinity;
  const own = a.agent_id === home.owner_agent_id, i = own ? null : Object.values(world.state.home_invitations).find(i => i.home_id === p.home_id && i.target_agent_id === a.agent_id && i.status === 'accepted');
  const host = world.state.agents[home.owner_agent_id];
  return Math.min(a.run?.expires_at ?? -Infinity, (a.last_contact_at ?? -45000) + 45000, own ? Infinity : i?.expires_at ?? -Infinity, own ? Infinity : host?.run?.expires_at ?? -Infinity, own ? Infinity : (host?.last_contact_at ?? -45000) + 45000);
}
export function tickHomes(world, survivalFrames = new Map(), { settleOnly = false } = {}) {
  let changed = false, motionChanged = false; const now = world.now();
  for (const i of Object.values(world.state.home_invitations)) if (!settleOnly && ['pending', 'accepted'].includes(i.status) && !validInvite(world, i)) {
    i.status = 'expired'; world.event('home_invitation_expired', { invitation_id: i.invitation_id, home_id: i.home_id, from_agent_id: i.from_agent_id, target_agent_id: i.target_agent_id, text: '家园邀请已失效，可由本人决定是否重新发起' }, [i.from_agent_id, i.target_agent_id]); changed = true;
  }
  for (const a of Object.values(world.state.agents)) {
    const p = a.home_presence, travel = a.home_travel, home = world.state.homes[p?.home_id || travel?.home_id];
    const authorized = home && active(world, a) && (a.agent_id === home.owner_agent_id || acceptedInvite(world, a, home));
    if (p) {
      if (p.movement) {
        const until = Math.min(now, survivalFrames.get(a.agent_id)?.home_until ?? homeLightUntil(world, a), survivalFrames.get(a.agent_id)?.until ?? now, survivalFrames.get(a.agent_id)?.stop_at ?? Infinity), old = p.movement;
        motionChanged = advanceMovement(p, now, { until, onDistance: (steps, _mode, settledAt) => spendEnergy(world, a, 'move', steps, settledAt) }) || motionChanged;
        if (!p.movement) { announce(world, a, home, 'home_movement_finished', `${a.name}在屋内停下`, { reason: distance(p.position, old.path.at(-1)) < 1e-8 ? 'arrived' : 'interrupted' }); changed = true; }
      }
      if (!settleOnly && (!authorized || p.run_id !== a.run?.run_id || p.session_epoch !== a.session_epoch)) { changed = leaveHome(world, a, 'permission_ended') || changed; continue; }
    } else if (travel && !settleOnly) {
      if (!authorized || now >= travel.expires_at || a.scene_id !== 'plaza' || travel.run_id !== a.run.run_id || travel.session_epoch !== a.session_epoch || a.adventure.hp < travel.hp_at_start || survivalFrames.get(a.agent_id)?.stop_at <= now || a.movement && a.movement.movement_id !== travel.movement_id) changed = cancelHomeTravel(world, a, 'interrupted') || changed;
      else if (!a.movement) { if (distance(a.position, HOME_RULES.entrance) < 1e-8 && enterHome(world, a, home)) changed = true; else changed = cancelHomeTravel(world, a, 'stopped') || changed; }
    }
  }
  for (const [id, i] of Object.entries(world.state.home_invitations)) if (!['pending', 'accepted'].includes(i.status) && now - i.created_at > 600000) delete world.state.home_invitations[id];
  return { changed, motionChanged };
}
export function homesObservation(world, a) {
  const own = homeFor(world, a), current = world.state.homes[a.home_presence?.home_id] || null, now = world.now();
  const projection = i => ({ invitation_id: i.invitation_id, home_id: i.home_id, from_agent_id: i.from_agent_id, target_agent_id: i.target_agent_id, status: i.status, expires_at: i.expires_at });
  const invitations = Object.values(world.state.home_invitations).filter(i => i.target_agent_id === a.agent_id && validInvite(world, i)).map(projection);
  const outgoing = Object.values(world.state.home_invitations).filter(i => i.from_agent_id === a.agent_id && validInvite(world, i)).map(projection);
  const neighbors = Object.values(world.state.agents).filter(b => b.agent_id !== a.agent_id && active(world, b)).map(b => ({ agent_id: b.agent_id, name: b.name }));
  const opportunities = [], add = payload => opportunities.push({ type: 'home', payload });
  const available = callback => { try { callback(); return true; } catch { return false; } };
  const reject = () => { throw new Error('unavailable'); };
  if (active(world, a)) {
    if (a.home_travel) add({ intent: 'cancel' });
    if (current) {
      add({ intent: 'leave' });
      if (a.home_presence.movement) add({ intent: 'cancel' });
      else {
        const blocked = roomBlocked(current); occupiedCells(world, current, a.agent_id).forEach(cell => blocked.add(cell));
        const pos = a.home_presence.position;
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) { const target = { x: Math.round(pos.x) + dx, y: Math.round(pos.y) + dy }; if (roomPath(current, pos, target, { maxSteps: 3, blocked })) add({ intent: 'move', ...target }); }
        if (own === current) {
          if (own.furniture.length < 12) for (const [kind, def] of Object.entries(HOME_RULES.furniture_catalog)) if (canAfford(a, def.cost)) add({ intent: 'craft', kind });
          for (const f of own.furniture) {
            if (placed(f) && !own.displays.some(d => d.instance_id === f.instance_id)) add({ intent: 'store', instance_id: f.instance_id });
            // A small set of real placement choices, never pre-select a decoration or move it automatically.
            let count = 0;
            for (let y = 0; y < 8 && count < 3; y++) for (let x = 0; x < 10 && count < 3; x++) if (placementAllowed(world, own, { ...f, x, y, rotation: 0 }) && (f.x !== x || f.y !== y)) { add({ intent: 'place', instance_id: f.instance_id, x, y, rotation: 0 }); count++; }
            if (placed(f) && f.kind === 'display_shelf' && !own.displays.some(d => d.instance_id === f.instance_id) && own.displays.length < 4) for (const item_id of HOME_RULES.souvenir_items) if (a.life.inventory[item_id] > 0) add({ intent: 'display', instance_id: f.instance_id, item_id });
          }
          for (const d of own.displays) if (Number.isSafeInteger((a.life.inventory[d.item_id] || 0) + 1)) add({ intent: 'withdraw', display_id: d.display_id });
        }
      }
    } else if (!a.home_travel && available(() => idleOutside(world, a, reject))) {
      if (!own && canAfford(a, HOME_RULES.build_cost) && available(() => campAvailable(world, a, reject))) add({ intent: 'build' });
      if (own) add({ intent: 'visit', home_id: own.home_id });
      for (const i of invitations.filter(i => i.status === 'accepted')) { const h = world.state.homes[i.home_id]; if (h && guestCount(world, h, a.agent_id) < 2) add({ intent: 'visit', home_id: i.home_id }); }
    }
    for (const i of invitations.filter(i => i.status === 'pending')) { add({ intent: 'respond', invitation_id: i.invitation_id, accept: true }); add({ intent: 'respond', invitation_id: i.invitation_id, accept: false }); }
    if (own && outgoing.filter(i => i.status === 'pending').length < 2) for (const n of neighbors) if (!Object.values(world.state.home_invitations).some(i => i.from_agent_id === a.agent_id && i.target_agent_id === n.agent_id && (now - i.created_at < 60000 || validInvite(world, i)))) add({ intent: 'invite', target_agent_id: n.agent_id });
  }
  return { version: 1, own_home: publicHome(own, { storage: true }), current_home: publicHome(current),
    directory: Object.values(world.state.homes).slice(0, 100).map(({ home_id, owner_agent_id, name }) => ({ home_id, owner_agent_id, name })), invitations, outgoing, neighbors, opportunities,
    ...(current ? { can_message: now - (a.home_last_message_at ?? -Infinity) >= 10000 } : {}) };
}
