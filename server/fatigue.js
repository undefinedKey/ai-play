import { isPositionInBounds } from './spatial.js';

export const FATIGUE_RULES = {
  max_energy: 100, tired_at: 25, rearm_at: 40, hunt_min_energy: 12, tired_attack_multiplier: 0.75,
  costs: { attack: 3, move_per_tile: 0.15, till: 3, plant: 2, water: 1, harvest: 2, craft: 2, repair: 2, upgrade: 2 },
  tool_energy: 'till和water实际体力消耗按life.tools对应工具当前等级的energy_cost；costs中的3和1为基础一级值。维修与升级各消耗2。',
  recovery: { idle_per_second: 0.3, rest_per_second: 2, camp_center: { x: 11, y: 8 }, camp_radius: 2 },
  description: '体力记录实际行动消耗，不代表性格或厌倦。体力不超过25时攻击变为75%；不足3时停止当前狩猎，重新狩猎至少需要12。走路和撤退始终允许。营地静止、聊天或低强度阅读每秒恢复0.3，主动休息或花园休息每秒恢复2；移动和劳作后1秒不恢复，野外不被动恢复。离线、暂停或服务重启期间仅在营地慢恢复；不会自动开始其他活动。',
};
const round = value => Math.round(value * 10000) / 10000;
const energy = a => Number.isFinite(a.fatigue?.energy) ? Math.max(0, Math.min(100, a.fatigue.energy)) : 100;
const inCamp = a => isPositionInBounds(a.position) && Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) <= 2;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const exertionKinds = ['attack', 'move', 'till', 'plant', 'water', 'harvest', 'craft', 'repair', 'upgrade'];

/** Persisted energy and settlement time survive reconnects and process restarts. */
export function initializeFatigue(a, now, { restore = false } = {}) {
  const old = a.fatigue || {};
  a.fatigue = {
    energy: energy(a), updated_at: timestamp(old.updated_at) ? old.updated_at : now,
    recover_after: timestamp(old.recover_after) ? old.recover_after : now,
    tired_notified: old.tired_notified === true,
    last_kind: exertionKinds.includes(old.last_kind) ? old.last_kind : null,
    last_at: timestamp(old.last_at) ? old.last_at : null,
    actions_count: Number.isSafeInteger(old.actions_count) && old.actions_count >= 0 ? old.actions_count : 0,
  };
  if (restore) settle(a, now, inCamp(a) ? FATIGUE_RULES.recovery.idle_per_second : 0);
}

export function attackMultiplier(a) { return energy(a) <= FATIGUE_RULES.tired_at ? FATIGUE_RULES.tired_attack_multiplier : 1; }
export function publicFatigue(a) {
  const value = round(energy(a)), f = a.fatigue || {};
  return { energy: value, max_energy: 100, fatigue: round(100 - value), state: value < 3 ? 'exhausted' : value <= 25 ? 'tired' : 'fresh',
    attack_multiplier: attackMultiplier(a), tired_at: 25, hunt_min_energy: 12,
    recent_exertion: { last_kind: exertionKinds.includes(f.last_kind) ? f.last_kind : null, last_at: timestamp(f.last_at) ? f.last_at : null,
      actions_count: Number.isSafeInteger(f.actions_count) && f.actions_count >= 0 ? f.actions_count : 0 } };
}
function announce(world, a, type, text) {
  world.event(type, { agent_id: a.agent_id, name: a.name, text, energy: round(energy(a)), fatigue: round(100 - energy(a)) }, [...new Set([a.agent_id, ...world.activeIds()])]);
}
export function announceExhausted(world, a) {
  announce(world, a, 'fatigue_exhausted', `${a.name}体力不足，当前狩猎已停止；仍可自行撤退、走路或回营地休息`);
}

/** False means insufficient energy; walking may always drain down to zero. */
export function spendEnergy(world, a, kind, units = 1) {
  if (!a.fatigue) initializeFatigue(a, world.now());
  const cost = (kind === 'move' ? FATIGUE_RULES.costs.move_per_tile : FATIGUE_RULES.costs[kind]) * units;
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid exertion cost');
  if (!cost) return true;
  const f = a.fatigue, before = energy(a);
  if (kind !== 'move' && before < cost) return false;
  f.energy = round(Math.max(0, before - cost));
  f.updated_at = Math.max(f.updated_at, world.now()); f.recover_after = Math.max(f.recover_after, world.now() + 1000);
  f.last_kind = kind; f.last_at = world.now(); f.actions_count = Math.min(Number.MAX_SAFE_INTEGER, f.actions_count + 1);
  if (before > 25 && f.energy <= 25 && !f.tired_notified) {
    f.tired_notified = true;
    announce(world, a, 'fatigue_tired', `${a.name}的体力降至${f.energy}，攻击效率降为75%；是否继续、休息或换活动由本人决定`);
  }
  return true;
}
function settle(a, now, rate) {
  const f = a.fatigue;
  if (now <= f.updated_at) return false;
  const before = f.energy;
  const seconds = Math.max(0, now - Math.max(f.updated_at, f.recover_after)) / 1000;
  f.energy = round(Math.min(100, f.energy + seconds * rate)); f.updated_at = now;
  if (f.energy >= FATIGUE_RULES.rearm_at) f.tired_notified = false;
  return f.energy !== before;
}
/** Capture the elapsed interval before tick clears expired plans and activities.
 * Actual movement/combat still settles later: spendEnergy advances updated_at,
 * so an arrival or attack cannot retroactively earn resting energy. */
export function captureFatigueRecovery(world) {
  const now = world.now(), { idle_per_second: idle, rest_per_second: rest } = FATIGUE_RULES.recovery;
  return new Map(Object.values(world.state.agents).map(a => {
    if (!inCamp(a)) return [a.agent_id, { rate: 0, until: now, after: 0 }];
    const active = world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active';
    if (!active) return [a.agent_id, { rate: idle, until: now, after: idle }];
    let until = Math.min(now, timestamp(a.run.expires_at) ? a.run.expires_at : now, timestamp(a.last_contact_at) ? a.last_contact_at + 45000 : now), rate = idle;
    const plan = a.adventure?.plan, activity = a.activity, game = world.state.game;
    if (plan) {
      until = Math.min(until, timestamp(plan.expires_at) ? plan.expires_at : now);
      rate = plan.intent === 'rest' && a.position.x === 11 && a.position.y === 8 ? rest : 0;
    } else if (activity) {
      until = Math.min(until, timestamp(activity.ends_at) ? activity.ends_at : now);
      rate = activity.activity_id === 'relax' ? rest : activity.activity_id === 'read' ? idle : 0;
    } else if (game && game.status !== 'finished' && game.participants.includes(a.agent_id)) rate = 0;
    // After a known expiry/disconnection the role is idle in camp, never still
    // fast-resting. This also makes delayed ticks equivalent to short ticks.
    return [a.agent_id, { rate, until, after: idle }];
  }));
}
export function tickFatigue(world, recovery = captureFatigueRecovery(world)) {
  let changed = false;
  for (const a of Object.values(world.state.agents)) {
    if (!a.fatigue) initializeFatigue(a, world.now());
    const interval = recovery.get(a.agent_id);
    if (!interval) continue;
    const before = a.fatigue.energy;
    settle(a, interval.until, interval.rate);
    settle(a, world.now(), interval.after);
    if (a.fatigue.energy !== before) changed = true;
  }
  if (changed) world.state.room.world_revision++;
  return { changed };
}
