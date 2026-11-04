import { sampleMotion } from '../shared/motion.js';

const windowAt = (value, now, start = 'started_at') => value && Number.isFinite(value[start]) && Number.isFinite(value.ends_at) && now >= value[start] && now < value.ends_at;
const eastOrWest = (value, fallback) => ['east', 'west'].includes(value) ? value : fallback;
const recentMeal = (actor, events, now) => [...events].reverse().find(e => e.type === 'life_consumed' && e.payload?.agent_id === actor.agent_id && e.payload?.scene_id === 'journey'
  && Number.isFinite(e.occurred_at) && now >= e.occurred_at && now < e.occurred_at + 1200);
export function journeySpriteState(actor, now, { live = true, reducedMotion = false, events = [], monster = false } = {}) {
  const present = actor?.scene_id === 'journey', active = present && (monster ? actor.status === 'alive' : actor.status === 'active');
  const fallback = monster ? 'west' : 'east', base = { action: 'idle', frame: 0, phase: 'idle', facing: eastOrWest(actor?.facing, fallback), x: 0, y: 0, flash: false, damage: null, damageY: 0, spark: false, playing: false, key: 'idle' };
  if (!live || !active) return base;
  const playing = !reducedMotion, state = { ...base, playing };
  const hurt = actor.hurt;
  if (windowAt(hurt, now) && Number.isFinite(hurt.damage) && hurt.damage > 0) {
    const elapsed = now - hurt.started_at, duration = hurt.ends_at - hurt.started_at, facing = state.facing, sign = facing === 'east' ? 1 : -1;
    return { ...state, action: 'hurt', frame: playing ? Math.min(2, Math.floor(elapsed / Math.max(1, duration / 3))) : 0, phase: 'hurt', key: hurt.action_id,
      x: playing ? -sign * Math.round(3 * (1 - elapsed / duration)) : 0, flash: playing && Math.floor(elapsed / 70) % 2 === 0,
      damage: hurt.damage, damageY: playing ? -Math.min(7, Math.floor(elapsed / 45)) : 0, spark: playing && elapsed < 110 };
  }
  const a = actor.action;
  if (a?.scene_id === 'journey' && a.type === 'attack' && a.outcome !== 'cancelled' && windowAt(a, now)) {
    state.action = 'attack'; state.facing = eastOrWest(a.facing, state.facing); state.key = a.action_id;
    const sign = state.facing === 'east' ? 1 : -1;
    if (a.outcome === null || !Number.isFinite(a.resolved_at) || now < a.resolved_at) {
      state.phase = 'anticipation'; state.frame = playing && now >= a.started_at + (a.impact_at - a.started_at) * .5 ? 1 : 0;
      state.x = playing ? -sign * state.frame : 0;
    } else {
      const elapsed = now - a.resolved_at;
      state.phase = elapsed < 140 ? 'swing' : 'recovery'; state.frame = playing ? elapsed < 140 ? 2 : 3 : 0;
      state.x = playing ? sign * (elapsed < 140 ? 5 : Math.max(0, Math.round(3 * (1 - (elapsed - 140) / Math.max(1, a.ends_at - a.resolved_at - 140))))) : 0;
    }
    return state;
  }
  const motion = sampleMotion(actor, now);
  if (motion.moving) {
    const m = actor.movement, elapsed = Math.max(0, now - m.started_at), step = m.mode === 'run' ? 90 : 140;
    return { ...state, action: m.mode === 'run' ? 'run' : 'walk', phase: 'moving', facing: eastOrWest(motion.facing, state.facing), frame: playing ? Math.floor(elapsed / step) % 4 : 0, key: m.movement_id };
  }
  const meal = recentMeal(actor, events, now);
  if (meal) return { ...state, action: 'eat', phase: 'eating', frame: playing ? Math.floor((now - meal.occurred_at) / 200) % 2 : 0, key: meal.event_id, itemId: typeof meal.payload.item_id === 'string' ? meal.payload.item_id : null };
  const gathering = actor.life?.gathering;
  if (gathering?.scene_id === 'journey' && gathering.phase === 'working' && windowAt(gathering, now, 'work_started_at'))
    return { ...state, action: 'gather', phase: 'working', frame: playing ? Math.floor((now - gathering.work_started_at) / 180) % 4 : 0, key: gathering.job_id };
  const rest = actor.journey_job;
  if (rest?.phase === 'resting' && windowAt(rest, now) && now < rest.expires_at)
    return { ...state, action: 'rest', phase: 'resting', frame: 0, playing: false, key: rest.job_id };
  return state;
}
