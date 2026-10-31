export const DAY_RULES = Object.freeze({
  cycle_seconds: 600,
  phases: [{ id: 'day', seconds: 300 }, { id: 'dusk', seconds: 60 }, { id: 'night', seconds: 180 }, { id: 'dawn', seconds: 60 }],
  night_work_energy_multiplier: 1.2, night_work_duration_multiplier: 1.25,
  description: '持久的10分钟昼夜循环；只有夜间开始的资源工作耗时×1.25、体力×1.2，本次成本开工锁定。月光草夜间和黎明可采。昼夜不自动下达行动，离线不扣生命或体力。',
});
const timestamp = n => Number.isSafeInteger(n) && n >= 0;
export function initializeDayCycle(state, now) {
  const prior = state.day_cycle || {};
  const epoch = timestamp(prior.epoch_at) ? prior.epoch_at : now;
  state.day_cycle = { version: 1, epoch_at: epoch, last_at: Math.max(epoch, timestamp(prior.last_at) ? prior.last_at : epoch, now), last_phase: prior.last_phase || null };
  const current = publicDayCycle(state, now);
  state.day_cycle.last_phase = current.phase; state.day_cycle.last_day_index = current.day_index;
}
export function publicDayCycle(state, now) {
  const clock = state.day_cycle, epoch = timestamp(clock?.epoch_at) ? clock.epoch_at : now;
  const current = Math.max(epoch, timestamp(clock?.last_at) ? clock.last_at : epoch, now), cycle = DAY_RULES.cycle_seconds * 1000;
  const elapsed = current - epoch, day = Math.floor(elapsed / cycle), within = elapsed % cycle;
  let offset = 0;
  for (const phase of DAY_RULES.phases) {
    if (within < offset + phase.seconds * 1000) return { version: 1, phase: phase.id, day_index: day + 1, phase_started_at: epoch + day * cycle + offset, next_at: epoch + day * cycle + offset + phase.seconds * 1000, cycle_seconds: DAY_RULES.cycle_seconds, server_time: current };
    offset += phase.seconds * 1000;
  }
}
export function tickDayCycle(world) {
  if (!world.state.day_cycle) initializeDayCycle(world.state, world.now());
  const current = publicDayCycle(world.state, world.now()), before = world.state.day_cycle.last_phase, beforeDay = world.state.day_cycle.last_day_index;
  world.state.day_cycle.last_at = current.server_time; world.state.day_cycle.last_phase = current.phase; world.state.day_cycle.last_day_index = current.day_index;
  const changed = before !== current.phase || beforeDay !== current.day_index;
  if (changed) world.event('day_phase_changed', { phase: current.phase, day_index: current.day_index, next_at: current.next_at, text: `世界进入${{ day: '白昼', dusk: '黄昏', night: '夜晚', dawn: '黎明' }[current.phase]}，行动仍由每位 AI 自己决定` }, world.activeIds());
  return { changed, durable: changed };
}
