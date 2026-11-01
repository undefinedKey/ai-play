import { sampleMotion } from '../shared/motion.js';

export const HOME_MAP = Object.freeze({ width: 10, height: 8 });
export const HOME_DOOR = Object.freeze({ x: 5, y: 7 });
export const furnitureNames = { chair: '木椅', table: '木桌', rug: '编织地毯', display_shelf: '纪念品展架' };
export const souvenirNames = { wood: '木材', ore: '矿石', pine_cone: '松果' };
const dimensions = { chair: [1, 1], table: [2, 1], rug: [2, 2], display_shelf: [2, 1] };

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
  const definition = rules?.furniture_catalog?.[item.kind];
  const fallback = dimensions[item.kind] || [1, 1];
  const size = [definition?.width || fallback[0], definition?.height || fallback[1]];
  return [90, 270].includes(item.rotation) ? size.reverse() : size;
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
  return { left: `${(70 + (position.x + .5) * 50) / 640 * 100}%`, top: `${(135 + (position.y + .7) * 42) / 540 * 100}%` };
}
export function homeLocation(agent, homes = []) {
  const home = homes.find(item => item.home_id === (agent?.home_presence?.home_id || agent?.home_travel?.home_id));
  if (agent?.home_presence) return home?.name || '小屋室内';
  if (agent?.home_travel) return `正在前往${home?.name || '小屋'}`;
  return null;
}
