import { sampleMotion } from '../shared/motion.js';
import { homeFurnitureFootprint, homeFurnitureLayout, homeRoomFoot } from './home-pixel-layout.js';

export const HOME_MAP = Object.freeze({ width: 10, height: 8 });
export const HOME_DOOR = Object.freeze({ x: 5, y: 7 });
export const furnitureNames = { chair: '木椅', table: '木桌', rug: '编织地毯', display_shelf: '纪念品展架', bed: '木床', bookshelf: '书架' };
export const homeActivityNames = { sit: '坐一会儿', eat: '吃饭', read: '阅读', rest: '休息', write: '写作' };
export const furnitureUses = { chair: ['sit', 'read', 'rest'], table: ['eat', 'read'], bed: ['rest'], bookshelf: ['read'], rug: [], display_shelf: [] };
export const souvenirNames = { wood: '木材', ore: '矿石', pine_cone: '松果' };

// Public activity is a bounded execution receipt, never a locally inferred
// intention. Finishing the progress bar cannot finish/restart the server job.
export function homeActivity(agent, now) {
  const activity = agent?.home_presence?.activity;
  if (!activity || !Object.hasOwn(homeActivityNames, activity.kind) || !['approaching', 'using'].includes(activity.phase)) return null;
  const start = activity.started_at, end = activity.ends_at;
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null;
  const progress = activity.phase === 'using' && duration ? Math.max(0, Math.min(1, (now - start) / duration)) : 0;
  return { ...activity, progress, label: activity.phase === 'approaching' ? `走过去${homeActivityNames[activity.kind]}` : homeActivityNames[activity.kind],
    remaining: activity.phase === 'using' && Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : null };
}

export function homeFurnitureOccupant(agents, instanceId, homeId) {
  return homeActors(agents, homeId).find(agent => agent.home_presence.activity?.instance_id === instanceId) || null;
}

// A visual transition from the legal adjacent standing point onto the drawn
// seat. Room-art coordinates never alter the server path or data-foot point.
export function homeConfirmedFurnitureUse(agent, furniture) {
  const p = agent?.position, use = agent?.home_presence?.activity;
  if (!furniture || use?.phase !== 'using' || use.instance_id !== furniture.instance_id || !p || ![p.x, p.y, furniture.x, furniture.y].every(Number.isFinite)) return null;
  const activities = furniture.kind === 'table' ? ['eat', 'read', 'write'] : furnitureUses[furniture.kind] || [];
  if (!activities.includes(use.kind)) return null;
  const [width, height] = furnitureSize(furniture);
  const distance = Math.max(furniture.x - p.x, 0, p.x - furniture.x - width + 1) + Math.max(furniture.y - p.y, 0, p.y - furniture.y - height + 1);
  if (distance > 1.001 || distance < .999) return null;
  return use;
}

export function homeSeatAnchor(agent, furniture, artSpec) {
  if (!['chair', 'bed'].includes(furniture?.kind) || !homeConfirmedFurnitureUse(agent, furniture)) return null;
  const layout = homeFurnitureLayout(furniture, undefined, artSpec), seat = layout.seat;
  if (!seat) return null;
  const foot = homeRoomFoot(agent.position);
  return { x: seat.x - foot.x, y: seat.y - foot.y, kind: furniture.kind, facing: layout.facing };
}

export function homeUsePresentationStyle(agent, furniture, now, enabled, hipHeight = 21.8, artSpec) {
  const anchor = homeSeatAnchor(agent, furniture, artSpec), activity = agent?.home_presence?.activity;
  if (!anchor) return undefined;
  const elapsed = Math.max(0, Math.min(now, activity.ends_at ?? now) - activity.started_at);
  const t = enabled && agent.status === 'active' ? Math.max(0, Math.min(1, elapsed / 650)) : 1;
  const progress = t * t * (3 - 2 * t), height = anchor.kind === 'bed' ? 12 : hipHeight - 7;
  return { translate: `calc(${anchor.x} * 100cqw / 640 * ${progress}) calc((${anchor.y} * 100cqw / 640 + ${height}px * var(--pixel-scale)) * ${progress})` };
}

export function selectedHome(homes = [], agents = [], selected, requested) {
  if (requested) return homes.find(home => home.home_id === requested) || null;
  const actor = agents.find(agent => agent.agent_id === selected);
  return homes.find(home => home.home_id === actor?.home_presence?.home_id)
    || homes.find(home => home.owner_agent_id === selected) || null;
}
export function homeActors(agents = [], homeId) {
  return homeId ? agents.filter(agent => agent.home_presence?.home_id === homeId && ['active', 'paused'].includes(agent.status)) : [];
}
export function furnitureSize(item, rules) {
  return homeFurnitureFootprint(item, rules);
}
// Use only the interior stream. Outdoor action/motion receipts never animate a
// house occupant and the same identity/appearance/equipment remains intact.
export function homeActorProxy(agent) {
  const presence = agent.home_presence;
  if (!presence?.position) return null;
  const scene = `home:${presence.home_id}`;
  const movement = presence.movement ? { ...presence.movement, scene_id: scene } : null;
  return { ...agent, scene_id: scene, position: presence.position,
    position_at: presence.position_at ?? agent.position_at,
    facing: presence.facing || agent.facing,
    movement, action: null, hurt: null, activity: null,
    adventure: agent.adventure ? { ...agent.adventure, plan: null } : null,
    life: agent.life ? { ...agent.life, gathering: null } : null };
}
export function homePosition(agent, now, live) {
  const actor = homeActorProxy(agent);
  return actor && live && agent.status === 'active' ? sampleMotion(actor, now).position : actor?.position;
}
export function homePoint(position) {
  const foot = homeRoomFoot(position);
  return { left: `${foot.x / 640 * 100}%`, top: `${foot.y / 540 * 100}%` };
}
export function homeLocation(agent, homes = []) {
  const home = homes.find(item => item.home_id === (agent?.home_presence?.home_id || agent?.home_travel?.home_id));
  if (agent?.home_presence) return home?.name || '小屋室内';
  if (agent?.home_travel) return `正在前往${home?.name || '小屋'}`;
  return null;
}
