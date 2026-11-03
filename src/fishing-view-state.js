/** A fishing visual requires the authoritative job and its actual shore point.
 * Timers never create a catch, restart a job, or turn an approach into work. */
export function fishingState(agent, now) {
  const job = agent?.fishing;
  if (!job || agent.home_presence || agent.scene_id !== job.scene_id || !['active', 'paused'].includes(agent.status)) return null;
  if (!['approaching', 'fishing'].includes(job.phase)) return null;
  const shore = job.interaction_position, atShore = shore && Math.hypot((agent.position?.x ?? Infinity) - shore.x, (agent.position?.y ?? Infinity) - shore.y) < .01;
  const working = job.phase === 'fishing' && atShore;
  const start = job.work_started_at ?? job.started_at, end = job.ends_at;
  const elapsed = Math.max(0, Math.min(now, end ?? now) - start);
  const progress = working && Number.isFinite(end) && end > start ? Math.max(0, Math.min(1, elapsed / (end - start))) : 0;
  return { ...job, working, elapsed, progress, remaining: working && Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : null };
}

export function fishingReceipts(world, spotId) {
  return (world.events || []).filter(event => event.type === 'fish_finished' && event.payload?.spot_id === spotId).slice(-4).reverse();
}

export function fishingReel(agent, spot, events, now) {
  if (!agent || agent.status !== 'active' || agent.fishing || agent.movement || agent.home_presence || agent.scene_id !== spot.scene_id) return null;
  if (Math.hypot(agent.position.x - spot.interaction_position.x, agent.position.y - spot.interaction_position.y) > .01) return null;
  const receipt = [...events].reverse().find(event => event.type === 'fish_finished' && event.payload?.agent_id === agent.agent_id && event.payload?.spot_id === spot.id && event.payload.item_id && event.payload.quantity > 0);
  const at = typeof receipt?.occurred_at === 'number' ? receipt.occurred_at : Date.parse(receipt?.occurred_at || '');
  const elapsed = now - at;
  return elapsed >= 0 && elapsed < 900 ? { receipt, progress: elapsed / 900 } : null;
}
