// Public projections only. Neither the world catalog nor this helper reads inventory.
export const lifeItemName = (catalog, id) => catalog?.items?.find(item => item.id === id)?.name || ({wood:'木材',ore:'矿石',turnip_soup:'萝卜浓汤',wheat_bread:'麦香面包'}[id]) || id;
export function gatheringState(agent, catalog, now) {
  const job=agent?.status==='active' ? agent.life?.gathering : null;
  if(job?.phase==='approaching')return {job,name:lifeItemName(catalog,job.item_id),elapsed:0,duration:1,seconds:0,awaiting:false,approaching:true};
  if(!job || !Number.isFinite(job.started_at) || !Number.isFinite(job.ends_at) || job.ends_at<=job.started_at)return null;
  const elapsed=Math.max(0,Math.min(job.ends_at-job.started_at,now-job.started_at));
  const seconds=Math.max(0,Math.ceil((job.ends_at-now)/1000));
  return {job,name:lifeItemName(catalog,job.item_id),elapsed,duration:job.ends_at-job.started_at,seconds,awaiting:seconds===0};
}
export function publicLifeResult(agent, events) {
  if(!agent)return null;
  return [...(events||[])].reverse().find(event=>event.payload?.agent_id===agent.agent_id&&['life_gather_finished','life_gather_cancelled','life_crafted','life_consumed','life_traded'].includes(event.type))||null;
}
