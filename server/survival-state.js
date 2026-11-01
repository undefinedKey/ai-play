import { CAMP_SITES, SURVIVAL_RULES } from '../shared/survival-rules.js';
import { publicDayCycle } from './day-cycle.js';
export { CAMP_SITES, SURVIVAL_RULES };
export const survivalTime = value => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, max, fallback = 0) => Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const survivalRound = value => Math.round(value * 10000) / 10000;
export const siteDefinition = id => CAMP_SITES.find(s => s.id === id) || null;
export const fireDefinition = id => SURVIVAL_RULES.structures.find(s => s.id === id) || null;
export function survivalPhaseAt(state, at) {
  const clock = state.day_cycle;
  return publicDayCycle({ day_cycle: { ...clock, last_at: clock?.epoch_at } }, at);
}
export function initializeSurvivor(a, now, { restore = false } = {}) {
  const old = a.survival || {};
  a.survival = { satiety: bounded(old.satiety, 100, 100), last_at: Math.max(now, survivalTime(old.last_at) ? old.last_at : now),
    darkness_seconds: restore ? 0 : bounded(old.darkness_seconds, 86400), starvation_seconds: restore ? 0 : bounded(old.starvation_seconds, 86400),
    dark_hits: restore ? 0 : bounded(old.dark_hits, 86400), hunger_hits: restore ? 0 : bounded(old.hunger_hits, 86400),
    warning_day: Number.isSafeInteger(old.warning_day) ? old.warning_day : 0, hungry_notified: old.hungry_notified === true, starving_notified: old.starving_notified === true,
    dark_notified: restore ? false : old.dark_notified === true,
    protected_until: survivalTime(old.protected_until) ? old.protected_until : 0,
    torch: old.torch ? { lit: !restore && old.torch.lit === true, fuel_seconds: bounded(old.torch.fuel_seconds, SURVIVAL_RULES.torch.fuel_seconds), updated_at: now } : null,
    travel: !restore && old.travel ? old.travel : null,
  };
}
export function foodWouldRestoreSatiety(a, item) { return (item.satiety_restore || 0) > 0 && (a.survival?.satiety ?? 100) < 100; }
export function applyFoodSatiety(a, amount, now) {
  if (!a.survival) initializeSurvivor(a, now);
  a.survival.satiety = survivalRound(Math.min(100, a.survival.satiety + Math.max(0, amount || 0)));
  if (a.survival.satiety > 0) { a.survival.starvation_seconds = 0; a.survival.hunger_hits = 0; a.survival.starving_notified = false; }
  if (a.survival.satiety > 40) a.survival.hungry_notified = false;
}
export function initializeSurvivalWorld(state, now) {
  const old = state.survival || {}, fires = {};
  for (const [id, raw] of Object.entries(old.fires || {})) {
    const site = siteDefinition(raw.site_id), def = fireDefinition(raw.kind);
    if (!site || !def || typeof raw.fire_id !== 'string' || raw.fire_id !== id || typeof raw.owner_agent_id !== 'string') continue;
    // Only one bounded structure per authored site; arbitrary properties never enter the public state.
    if (Object.values(fires).some(f => f.site_id === site.id)) continue;
    fires[id] = { fire_id: id, site_id: site.id, kind: def.id, owner_agent_id: raw.owner_agent_id,
      fuel_seconds: bounded(raw.fuel_seconds, def.max_fuel_seconds), lit: raw.lit === true,
      updated_at: survivalTime(raw.updated_at) ? raw.updated_at : now, created_at: survivalTime(raw.created_at) ? raw.created_at : now };
  }
  state.survival = { version: 1, last_at: Math.max(now, survivalTime(old.last_at) ? old.last_at : now), fires };
}
export function fireFuel(fire, now) {
  return survivalRound(Math.max(0, fire.fuel_seconds - (fire.lit ? Math.max(0, now - fire.updated_at) / 1000 : 0)));
}
export function publicFire(fire, now) {
  const site = siteDefinition(fire?.site_id), def = fireDefinition(fire?.kind);
  if (!site || !def || !validId(fire.fire_id) || !validId(fire.owner_agent_id)) return null;
  const fuel = fireFuel(fire, now), lit = fire.lit && fuel > 0;
  return { fire_id: fire.fire_id, site_id: site.id, kind: def.id, owner_agent_id: fire.owner_agent_id,
    scene_id: site.scene_id, position: { ...site.position }, interaction_position: { ...site.interaction_position },
    lit, fuel_seconds: fuel, max_fuel_seconds: def.max_fuel_seconds,
    extinguishes_at: lit ? Math.round(fire.updated_at + fire.fuel_seconds * 1000) : null,
    light_radius: lit ? def.light_radius : 0 };
}
export function publicSurvival(world) {
  return { version: 1, sites: structuredClone(CAMP_SITES), fires: Object.values(world.state.survival?.fires || {}).map(f => publicFire(f, world.now())).filter(Boolean), server_time: world.now() };
}
export function litCampfireNear(world, a) {
  if (a.home_presence) return null;
  return Object.values(world.state.survival?.fires || {}).map(f => publicFire(f, world.now())).find(f => f?.lit && f.scene_id === a.scene_id && Math.abs(f.position.x - a.position.x) + Math.abs(f.position.y - a.position.y) <= 2) || null;
}
export function survivalLight(world, a, now = world.now(), position = a.position, torchFuel = a.survival?.torch?.fuel_seconds || 0) {
  if (a.home_presence && world.state.homes?.[a.home_presence.home_id]) return { lit: true, source_id: a.home_presence.home_id, kind: 'indoor', radius: null };
  if (survivalPhaseAt(world.state, now).phase !== 'night') return { lit: true, source_id: null, kind: 'daylight', radius: null };
  if (a.survival?.torch?.lit && torchFuel > 0) return { lit: true, source_id: a.agent_id, kind: 'torch', radius: SURVIVAL_RULES.torch.light_radius };
  for (const raw of Object.values(world.state.survival?.fires || {})) {
    const fire = publicFire(raw, now);
    if (fire?.lit && fire.scene_id === a.scene_id && Math.hypot(fire.position.x - position.x, fire.position.y - position.y) <= fire.light_radius + 1e-8)
      return { lit: true, source_id: fire.fire_id, kind: fire.kind, radius: fire.light_radius };
  }
  return { lit: false, source_id: null, kind: 'darkness', radius: 0 };
}
export function publicSurvivor(world, a) {
  const s = a.survival, now = world.now();
  if (!s) return null;
  const light = survivalLight(world, a), torch = s.torch, fuel = bounded(torch?.fuel_seconds, 90), darkness = bounded(s.darkness_seconds, 86400), satiety = bounded(s.satiety, 100, 100);
  const site = siteDefinition(s.travel?.site_id);
  return { satiety: survivalRound(satiety), max_satiety: 100, satiety_state: satiety <= 0 ? 'starving' : satiety <= 30 ? 'hungry' : 'fed',
    light, darkness_seconds: survivalRound(darkness),
    danger_in_seconds: light.lit ? null : Math.max(0, SURVIVAL_RULES.darkness_grace_seconds - darkness),
    protected_until: survivalTime(s.protected_until) && s.protected_until > now ? s.protected_until : null,
    torch: torch ? { lit: torch.lit === true && fuel > 0, fuel_seconds: fuel,
      expires_at: torch.lit === true && fuel > 0 ? Math.round(now + fuel * 1000) : null } : null,
    travel: site && survivalTime(s.travel.expires_at) ? { site_id: site.id, expires_at: s.travel.expires_at } : null };
}
export function survivalRecoveryAllowed(world, a) { return (a.survival?.satiety ?? 100) > 0 && survivalLight(world, a).lit; }
