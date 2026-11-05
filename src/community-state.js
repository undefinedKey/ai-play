import { COMMUNITY_VENUES, COMMUNITY_STATUSES } from '../shared/community.js';
import { qPlazaArtwork } from './q-plaza-art.js';
import { qServiceArtwork } from './q-service-art.js';

const names = { open: '等待开始', active: '活动进行中', ended: '已结束', cancelled: '已取消', expired: '已到期', interrupted: '已中止' };
export const communityActivityNames = Object.freeze({ sit: '坐一会儿', eat: '用餐', listen: '在台下聆听', perform: '公开表演' });
export function communityEventState(event, now, live = true) {
  if (!COMMUNITY_STATUSES.includes(event?.status)) return { key: 'unknown', label: '状态未收到', deadline: '' };
  const ongoing = ['open', 'active'].includes(event.status), seconds = Number.isFinite(event.expires_at) ? Math.max(0, Math.ceil((event.expires_at - now) / 1000)) : null;
  return { key: event.status, ongoing, label: `${live ? '' : '最近记录 · '}${names[event.status]}`, deadline: !ongoing ? '' : !live ? '连接恢复后更新期限' : seconds === null ? '期限未收到' : seconds === 0 ? '期限已到，等待服务器确认' : seconds < 60 ? `剩余 ${seconds} 秒` : `剩余 ${Math.ceil(seconds / 60)} 分钟` };
}
export function communityEvents(community, filter = 'current', venueId = null) {
  return (community?.events || []).filter(event => COMMUNITY_STATUSES.includes(event.status) && (!venueId || event.venue_id === venueId))
    .filter(event => filter === 'history' ? !['open', 'active'].includes(event.status) : ['open', 'active'].includes(event.status))
    .slice().sort((a, b) => filter === 'history' ? (b.ended_at || b.created_at) - (a.ended_at || a.created_at) : Number(b.status === 'active') - Number(a.status === 'active') || a.expires_at - b.expires_at);
}

/** A seat pose requires actual arrival and a server-confirmed use. Neither a
 * local clock nor an event signup can place a character in a seat. */
export function communityUseState(agent, now) {
  const job = agent?.community_job;
  if (!job || job.kind !== 'use' || agent.home_presence || agent.scene_id !== 'plaza' || !['active', 'paused'].includes(agent.status)) return null;
  const venue = COMMUNITY_VENUES.find(value => value.id === job.venue_id), seat = venue?.seats.find(value => value.id === job.seat_id);
  if (!seat || !seat.activities.includes(job.activity) || !['approaching', 'using'].includes(job.phase)) return null;
  const arrived = Math.hypot((agent.position?.x ?? Infinity) - seat.position.x, (agent.position?.y ?? Infinity) - seat.position.y) < .01;
  const using = job.phase === 'using' && arrived && !agent.movement && Number.isFinite(job.use_started_at) && Number.isFinite(job.ends_at);
  const start = job.use_started_at, elapsed = using ? Math.max(0, Math.min(now, job.ends_at) - start) : 0;
  const facing = job.activity === 'perform' ? 'south' : venue.id === 'stage' ? 'north' : seat.position.x < venue.position.x ? 'east' : seat.position.x > venue.position.x ? 'west' : seat.position.y < venue.position.y ? 'south' : 'north';
  return { ...job, using, elapsed, facing, label: communityActivityNames[job.activity], remaining: using ? Math.max(0, Math.ceil((job.ends_at - now) / 1000)) : null };
}

export function communityPerformances(world, now) {
  return (world.agents || []).flatMap(agent => {
    const job = communityUseState(agent, now);
    return job?.using && job.activity === 'perform' && typeof job.title === 'string' && typeof job.text === 'string' ? [{ agent_id: agent.agent_id, name: agent.name, ...job }] : [];
  });
}
export function communityPerformanceHistory(world) {
  const seen = new Set();
  return [...(world.events || [])].reverse().filter(event => {
    const p = event.payload;
    if (event.type !== 'community_use_finished' || p?.activity !== 'perform' || p.phase !== 'using' || p.venue_id !== 'stage' || typeof p.title !== 'string' || typeof p.text !== 'string' || seen.has(p.job_id)) return false;
    seen.add(p.job_id); return true;
  }).slice(0, 3).map(event => ({ ...event.payload, completed: true, completed_at: event.occurred_at }));
}

export const communityArtwork = Object.freeze(Object.fromEntries(['picnic','table','stage','board','seat','mat'].map(kind=>[kind,qPlazaArtwork[`community_${kind}`]||qServiceArtwork[`community_${kind}`]])));
