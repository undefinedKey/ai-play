import { sceneDefinition, isWalkable } from '../shared/world-layout.js';

export const actorScene = agent => ['plaza','adventure'].includes(agent?.scene_id) ? agent.scene_id : null;
export const sceneName = id => sceneDefinition(id)?.name || '所在地未知';
export function sceneActors(agents, sceneId) { return agents.filter(agent => actorScene(agent) === sceneId && ['active','paused'].includes(agent.status)); }
export function confirmedPosition(agent, now, live=true) {
  const movement=agent?.movement, fallback=agent?.position;
  if(!live||agent.status!=='active'||!movement||movement.scene_id!==agent.scene_id||!Array.isArray(movement.path)||movement.path.length<2||!Number.isFinite(movement.started_at)||!Number.isFinite(movement.duration_ms)||movement.duration_ms<=0)return fallback;
  const path=movement.path,last=path.at(-1);
  if(last?.x!==fallback?.x||last?.y!==fallback?.y||path.some((p,i)=>!isWalkable(agent.scene_id,p)||(i&&Math.abs(p.x-path[i-1].x)+Math.abs(p.y-path[i-1].y)!==1)))return fallback;
  const elapsed=now-movement.started_at;
  if(elapsed<0||elapsed>=movement.duration_ms)return fallback;
  const offset=elapsed/movement.duration_ms*(path.length-1),index=Math.min(path.length-2,Math.floor(offset)),fraction=offset-index;
  return {x:path[index].x+(path[index+1].x-path[index].x)*fraction,y:path[index].y+(path[index+1].y-path[index].y)*fraction};
}
