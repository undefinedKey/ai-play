// Independent, read-only release verification. Shared site definitions are
// authored data; no runtime initialization, fuel or survival functions are used.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CAMP_SITES, SURVIVAL_RULES } from '../shared/survival-rules.js';

const time = value => Number.isSafeInteger(value) && value >= 0;
const round = value => Math.round(value * 10000) / 10000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SURVIVOR_KEYS = ['satiety','last_at','darkness_seconds','starvation_seconds','dark_hits','hunger_hits','warning_day','hungry_notified','starving_notified','dark_notified','protected_until','torch','travel'].sort();
const FIRE_KEYS = ['fire_id','site_id','kind','owner_agent_id','fuel_seconds','lit','updated_at','created_at'].sort();

export function verifySurvival(old, current) {
  const events = current.events.filter(e => Number(e.cursor) > old.sequence);
  const restarts = events.filter(e => e.type === 'server_restarted');
  assert.equal(restarts.length, 1, 'exactly one new restart record required');
  const restartedAt = restarts[0].occurred_at; assert.ok(time(restartedAt));
  assert.deepEqual(Object.keys(current.agents).sort(), Object.keys(old.agents).sort(), 'existing roles retained');
  assert.deepEqual(current.controllers, old.controllers, 'controller credentials retained');
  const previous = old.survival, state = current.survival;
  assert.ok(plain(state)); assert.deepEqual(Object.keys(state).sort(), ['fires','last_at','version']); assert.equal(state.version, 1);
  if (previous) assert.equal(previous.version, 1);
  assert.ok(time(state.last_at) && state.last_at >= (previous?.last_at || 0) && state.last_at <= Math.max(restartedAt, previous?.last_at || 0), 'survival clock initialized monotonically during this restart');
  const restoredFrom = Math.min(state.last_at, restartedAt);
  const observedAt = Math.max(restartedAt, current.day_cycle?.last_at || 0, current.resources?.last_at || 0);
  assert.ok(time(observedAt));
  const fires = previous?.fires || {};
  assert.ok(plain(state.fires)); assert.deepEqual(Object.keys(state.fires).sort(), Object.keys(fires).sort(), 'no new or lost structures during migration');
  const sites = new Set(); let litFires = 0;
  for (const [id, before] of Object.entries(fires)) {
    const after = state.fires[id], site = CAMP_SITES.find(s => s.id === before.site_id), definition = SURVIVAL_RULES.structures.find(s => s.id === before.kind);
    assert.ok(site && definition && !sites.has(site.id), 'one original authored fire per site'); sites.add(site.id);
    assert.deepEqual(Object.keys(after).filter(k => k !== 'low_notified').sort(), FIRE_KEYS);
    for (const key of ['fire_id','site_id','kind','owner_agent_id','created_at']) assert.deepEqual(after[key], before[key], 'fire identity, ownership, type and construction date preserved');
    assert.equal(after.fire_id, id); assert.ok(typeof after.owner_agent_id === 'string'); assert.ok(time(after.created_at));
    assert.ok(Number.isFinite(before.fuel_seconds) && before.fuel_seconds >= 0 && before.fuel_seconds <= definition.max_fuel_seconds);
    assert.ok(time(before.updated_at) && time(after.updated_at) && after.updated_at >= before.updated_at && after.updated_at <= Math.max(before.updated_at, observedAt), 'fuel settlement must use an actual non-rewinding timestamp');
    const fuel = round(Math.max(0, before.fuel_seconds - (before.lit ? (after.updated_at - before.updated_at) / 1000 : 0)));
    assert.equal(after.fuel_seconds, fuel, 'only real elapsed burning may change remaining fuel');
    assert.equal(after.lit, before.lit === true && fuel > 0, 'restart cannot relight or preserve fuel by silently extinguishing');
    if (Object.hasOwn(after, 'low_notified')) assert.ok(after.low_notified === true && fuel <= 30, 'a low-fuel marker may remain after actual burnout');
    if (before.lit && !after.lit) {
      const ended = events.filter(e => e.type === 'fire_extinguished' && e.payload.fire_id === id);
      assert.equal(ended.length, 1, 'exactly one real burnout event required');
      assert.equal(ended[0].payload.site_id, before.site_id); assert.equal(ended[0].payload.fuel_seconds, 0);
      assert.ok(time(ended[0].occurred_at) && ended[0].occurred_at >= restartedAt && ended[0].occurred_at <= observedAt);
    }
    if (after.lit) litFires++;
  }
  for (const [id, before] of Object.entries(old.agents)) {
    const after = current.agents[id], original = before.survival, s = after.survival;
    assert.ok(plain(s)); assert.deepEqual(Object.keys(s).sort(), SURVIVOR_KEYS);
    for (const field of ['agent_id','owner_id','name','bio','avatar','color','is_platform','run','goal','appearance']) assert.deepEqual(after[field], before[field], 'identity and authorization are not survival migration data');
    assert.deepEqual(after.life.inventory, before.life.inventory, 'survival migration cannot grant or consume inventory');
    assert.deepEqual(after.life.ledger, before.life.ledger, 'survival migration cannot forge economic work');
    assert.equal(after.adventure.hp, before.adventure.hp, 'no offline damage, healing or rescue');
    assert.equal(after.adventure.max_hp, before.adventure.max_hp, 'body limits preserved');
    assert.equal(s.satiety, original?.satiety ?? 100, 'old roles start at 100; existing satiety is preserved exactly');
    assert.ok(Number.isFinite(s.satiety) && s.satiety >= 0 && s.satiety <= 100);
    assert.ok(time(s.last_at) && s.last_at >= Math.max(original?.last_at || 0, restoredFrom) && s.last_at <= Math.max(original?.last_at || 0, observedAt));
    for (const field of ['darkness_seconds','starvation_seconds','dark_hits','hunger_hits']) assert.equal(s[field], 0, 'offline hazard timers cannot resume or catch up');
    assert.equal(s.travel, null, 'restart cannot resume a site journey'); assert.equal(s.dark_notified, false);
    assert.equal(s.warning_day, original?.warning_day ?? 0);
    assert.equal(s.hungry_notified, original?.hungry_notified === true); assert.equal(s.starving_notified, original?.starving_notified === true);
    assert.equal(s.protected_until, original?.protected_until ?? 0, 'restart cannot add or remove rescue protection');
    if (!original?.torch) assert.equal(s.torch, null, 'old role receives no free torch');
    else {
      assert.deepEqual(Object.keys(s.torch).sort(), ['fuel_seconds','lit','updated_at']);
      assert.equal(s.torch.lit, false, 'a personal torch stays off after restart'); assert.equal(s.torch.fuel_seconds, original.torch.fuel_seconds, 'offline personal fuel is neither consumed nor replenished');
      assert.ok(time(s.torch.updated_at) && s.torch.updated_at >= restoredFrom && s.torch.updated_at <= restartedAt, 'torch reset occurred at restart');
    }
  }
  assert.ok(!events.some(e => ['fire_built','fire_fueled','torch_changed','survival_damage','survival_rescued','life_consumed','life_crafted'].includes(e.type)), 'restart must not invent survival decisions, rewards or harm');
  return { survival_state_preserved: true, agents: Object.keys(old.agents).length, fires: Object.keys(fires).length, stored_lit_fires: litFires };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifySurvival(old, current))); }
  catch (error) { process.stderr.write(`Survival migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
