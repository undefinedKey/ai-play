import { randomUUID } from 'node:crypto';
import { JOURNEY_RULES, JOURNEY_NODES, JOURNEY_MONSTERS, JOURNEY_GEOMETRY, validJourney } from '../shared/journey.js';
import { findWorldPath, findPath, recordMovement, stopMovement, publicAction, publicHurt, MOVEMENT_RULES } from './spatial.js';
import { pathLength } from '../shared/motion.js';
import { changeScene } from './adventure.js';
import { combatStats } from './combat.js';
import { attackMultiplier, publicFatigue, spendEnergy } from './fatigue.js';
import { survivalRecoveryAllowed } from './survival-state.js';
import { publicResources } from './resources.js';
import { grantMonsterLoot } from './life.js';
import { economyBalance, recordEconomyDelta } from './economy.js';
import { progressPersonalGoal } from './personal-goals.js';

export { JOURNEY_RULES };
const clone = value => structuredClone(value);
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const node = id => JOURNEY_NODES.find(n => n.id === id);
const nowTime = n => Number.isSafeInteger(n) && n >= 0;
const permitted = (world, a) => world.state.room.status === 'active' && a?.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now()
  && Number.isFinite(a.last_contact_at) && a.last_contact_at + 45000 > world.now() && !!world.state.controllers[a.run.controller_id] && !world.state.controllers[a.run.controller_id].revoked;
const bound = (world, a, j) => permitted(world, a) && j.run_id === a.run.run_id && j.session_epoch === a.session_epoch;
const alive = m => m.status === 'alive' && m.hp > 0;
const monsters = world => world.state.journey.monsters;
const localFail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const announce = (world, a, type, extra = {}) => world.event(type, { scene_id: 'journey', ...(a ? { agent_id: a.agent_id, name: a.name } : {}), ...extra }, [...new Set([...(a ? [a.agent_id] : []), ...world.activeIds()])]);
export const journeyJob = a => a.journey_job || null;
export function publicJourneyJob(a) {
  const j = a.journey_job;
  if (!j || !['enter', 'travel', 'hunt', 'rest', 'leave'].includes(j.intent) || !['approaching', 'fighting', 'resting'].includes(j.phase)
    || typeof j.job_id !== 'string' || !/^journey_[A-Za-z0-9-]{1,100}$/.test(j.job_id) || !['plaza', 'journey'].includes(j.scene_id)
    || !nowTime(j.started_at) || !nowTime(j.expires_at) || j.expires_at <= j.started_at || j.expires_at > j.started_at + 90000
    || !Number.isFinite(j.destination?.x) || !Number.isFinite(j.destination?.y) || j.destination.x < 0 || j.destination.x >= 48 || j.destination.y < 0 || j.destination.y >= 32) return null;
  return { job_id: j.job_id, intent: j.intent, scene_id: j.scene_id, node_id: node(j.node_id)?.id || null,
    monster_id: JOURNEY_MONSTERS.find(m => m.monster_id === j.monster_id)?.monster_id || null, phase: j.phase,
    route: j.route === 'bypass' ? 'bypass' : 'direct', mode: j.mode === 'run' ? 'run' : 'walk',
    started_at: j.started_at, ends_at: nowTime(j.ends_at) ? j.ends_at : null, expires_at: j.expires_at,
    destination: { x: j.destination.x, y: j.destination.y } };
}
function publicMonster(m) {
  const def = JOURNEY_MONSTERS.find(d => d.monster_id === m.monster_id);
  return { ...clone(def), scene_id: 'journey', position: clone(def.position), position_at: m.position_at,
    facing: m.facing === 'east' ? 'east' : 'west', hp: Math.max(0, Math.min(def.max_hp, m.hp)), status: m.status,
    respawn_at: nowTime(m.respawn_at) ? m.respawn_at : null, behavior: m.behavior === 'attacking' ? 'attacking' : 'idle',
    target_agent_id: typeof m.target_agent_id === 'string' ? m.target_agent_id : null, action: publicAction(m), hurt: publicHurt(m) };
}
export function publicJourney(world) {
  return { version: 1, scene_id: 'journey', nodes: clone(JOURNEY_NODES), monsters: monsters(world).map(publicMonster) };
}
function cancelAttack(actor, now) {
  const action = actor.action;
  if (action?.scene_id === 'journey' && action.outcome === null) {
    action.outcome = 'cancelled'; action.phase = 'cancelled'; action.resolved_at = now; action.ends_at = Math.min(action.ends_at, now + 150);
  }
}
export function cancelJourney(world, a, reason = 'cancelled') {
  const j = a.journey_job;
  if (!j) return false;
  if (a.movement?.movement_id === j.movement_id) stopMovement(a, world.now());
  cancelAttack(a, world.now());
  a.journey_job = null; a.journey_last_result = { kind: reason, at: world.now(), intent: j.intent };
  for (const m of monsters(world)) {
    delete m.contributions[a.agent_id];
    if (m.target_agent_id === a.agent_id) { m.target_agent_id = null; m.behavior = 'idle'; cancelAttack(m, world.now()); }
  }
  announce(world, a, 'journey_finished', { intent: j.intent, reason, text: `${a.name}本次森林行程已结束（${reason}），下一步由本人决定` });
  return true;
}
export const endJourney = cancelJourney;
export function initializeJourney(world, { restore = false } = {}) {
  const old = world.state.journey, now = world.now();
  if (old !== undefined && (!old || old.version !== 1 || !Array.isArray(old.monsters) || Object.keys(old).some(k => !['version', 'monsters'].includes(k))
    || old.monsters.length !== JOURNEY_MONSTERS.length || new Set(old.monsters.map(m => m?.monster_id)).size !== JOURNEY_MONSTERS.length
    || old.monsters.some(m => !JOURNEY_MONSTERS.some(d => d.monster_id === m?.monster_id)))) throw new Error('Invalid journey state; preserve database for recovery');
  world.state.journey = { version: 1, monsters: JOURNEY_MONSTERS.map(def => {
    const m = old?.monsters.find(m => m.monster_id === def.monster_id);
    if (m && (Object.keys(m).some(k => !['monster_id', 'name', 'position', 'max_hp', 'attack', 'xp', 'gold', 'scene_id', 'position_at', 'facing', 'hp', 'status', 'respawn_at', 'contributions', 'next_attack_at', 'action', 'hurt', 'target_agent_id', 'behavior'].includes(k))
      || !Number.isInteger(m.hp) || m.hp < 0 || m.hp > def.max_hp || !['alive', 'respawning'].includes(m.status)
      || m.max_hp !== def.max_hp || m.attack !== def.attack || m.xp !== def.xp || m.gold !== def.gold || m.scene_id !== 'journey'
      || distance(m.position || {}, def.position) !== 0 || !nowTime(m.position_at) || !nowTime(m.next_attack_at)
      || m.status === 'respawning' && (m.hp !== 0 || !nowTime(m.respawn_at)) || m.status === 'alive' && m.hp <= 0)) throw new Error('Invalid journey monster; preserve database for recovery');
    return { ...clone(def), scene_id: 'journey', position_at: now, facing: 'west', hp: m?.hp ?? def.max_hp,
      status: m?.status || 'alive', respawn_at: m?.status === 'respawning' ? m.respawn_at : null,
      contributions: {}, next_attack_at: Math.max(now, nowTime(m?.next_attack_at) ? m.next_attack_at : 0), action: null, hurt: null, target_agent_id: null, behavior: 'idle' };
  }) };
  for (const a of Object.values(world.state.agents)) {
    a.journey_job ??= null; a.journey_last_result ??= null;
    if (restore) cancelJourney(world, a, 'restarted');
  }
}

// A direct route ends at the visible edge of the first living encounter. This
// is an environmental obstruction, not an AI-selected fight or retreat.
export function journeyEncounterOnPath(world, a, path, ignoreMonsterId = null) {
  if (a.scene_id !== 'journey') return null;
  for (let index = 0; index < path.length; index++) {
    const p = path[index];
    for (const m of monsters(world)) {
      if (!alive(m) || m.monster_id === ignoreMonsterId || p.y !== 16) continue;
      const toward = Math.sign(m.position.x - a.position.x);
      if (toward && (p.x - a.position.x) * toward < 0) continue;
      // If already beside this monster, walking away remains a legal choice.
      if (distance(a.position, m.position) <= 3 && distance(p, m.position) >= distance(a.position, m.position)) continue;
      if (distance(p, m.position) <= 3) return { monster: m, index: distance(a.position, m.position) <= 3 ? Math.max(0, index - 1) : index };
    }
  }
  return null;
}
function bypassPath(world, a, destination) {
  const detours = JOURNEY_GEOMETRY.detours;
  // The selected path avoids every authored encounter stretch, including a
  // currently defeated monster; choosing a bypass never changes mid-journey.
  const allowed = p => p.y !== 16 || !detours.some(d => p.x > d.from_x && p.x < d.to_x);
  // A stopped combatant may leave an interior encounter cell to join a detour.
  const start = a.position;
  const own = detours.find(d => start.y === 16 && start.x > d.from_x && start.x < d.to_x);
  let prefix = [clone(start)], from = start;
  if (own) {
    const middle = (own.from_x + own.to_x) / 2;
    const edge = { x: start.x < middle ? own.from_x : start.x > middle ? own.to_x : destination.x >= start.x ? own.to_x : own.from_x, y: 16 };
    prefix = findWorldPath(world, 'journey', start, edge); from = edge;
  }
  const rest = findPath('journey', from, destination, { allowed });
  return prefix && rest ? [...prefix, ...rest.slice(1)] : null;
}
function queuePath(world, a, j, destination, fail = localFail) {
  let path = a.scene_id === 'journey' && j.route === 'bypass' ? bypassPath(world, a, destination) : findWorldPath(world, a.scene_id, a.position, destination);
  if (!path) fail('UNREACHABLE', '这条实际路线暂不可达');
  j.encounter_monster_id = null;
  if (a.scene_id === 'journey' && j.route !== 'bypass') {
    const encounter = journeyEncounterOnPath(world, a, path, j.intent === 'hunt' ? j.monster_id : null);
    if (encounter) { path = path.slice(0, encounter.index + 1); j.encounter_monster_id = encounter.monster.monster_id; }
  }
  const duration = Math.ceil(pathLength(path) / MOVEMENT_RULES.modes[j.mode].speed * 1000);
  if (world.now() + duration >= j.expires_at) fail('INSUFFICIENT_TIME', '现有许可不足以走完本次路线');
  j.destination = clone(path.at(-1)); recordMovement(a, path, world.now(), j.mode); j.movement_id = a.movement?.movement_id || null;
}
function idle(world, a, fail) {
  if (!permitted(world, a)) fail('STALE_SESSION', '当前活动授权不可用');
  if (a.home_presence || a.home_travel || a.journey_job || a.movement || a.activity || a.fishing || a.ruins_job || a.life?.gathering || a.adventure?.plan || a.survival?.travel || a.adventure?.encounter?.status === 'pending'
    || world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id)) fail('ACTIVITY_BUSY', '请先自行结束当前活动，再选择森林行程');
}
function newJob(world, a, p, destination) {
  const now = world.now();
  return { job_id: `journey_${randomUUID()}`, intent: p.intent, phase: p.intent === 'rest' ? 'resting' : 'approaching', scene_id: a.scene_id,
    node_id: p.node_id || (p.intent === 'leave' || p.intent === 'enter' ? 'entry' : p.intent === 'rest' ? 'camp' : null), monster_id: p.monster_id || null,
    route: p.route || 'direct', mode: p.mode || 'walk', destination: clone(destination), started_at: now, ends_at: p.intent === 'rest' ? now + p.duration_seconds * 1000 : null,
    expires_at: Math.min(now + 90000, a.run.expires_at), last_rest_at: now, movement_id: null, run_id: a.run.run_id, session_epoch: a.session_epoch };
}
export function performJourney(world, a, p, fail) {
  if (!validJourney(p)) fail('INVALID_ACTION', '请按 journey 规则选择明确的节点、路线和动作字段');
  if (!permitted(world, a)) fail('STALE_SESSION', '当前活动授权不可用');
  if (p.intent === 'browse') return { journey: journeyObservation(world, a) };
  if (p.intent === 'stop') {
    if (!a.journey_job) fail('NO_JOURNEY', '当前没有森林行程');
    cancelJourney(world, a); return { journey: journeyObservation(world, a) };
  }
  idle(world, a, fail);
  if (p.intent === 'enter' ? a.scene_id !== 'plaza' : a.scene_id !== 'journey') fail('SCENE_REQUIRED', 'enter须从广场出发；其他森林行程须已在journey场景');
  if (p.mode === 'run' && publicFatigue(a).energy <= 0) fail('FATIGUE_EXHAUSTED', '体力不足以奔跑，仍可自行选择步行');
  let destination;
  if (p.intent === 'enter') destination = JOURNEY_GEOMETRY.entrance.position;
  else if (p.intent === 'travel') destination = node(p.node_id).position;
  else if (p.intent === 'leave') destination = node('entry').position;
  else if (p.intent === 'rest') {
    destination = node('camp').position;
    if (distance(a.position, destination) > 1e-8) fail('NOT_AT_CAMP', '休息须本人已抵达林间营地(43,16)');
    if (!survivalRecoveryAllowed(world, a)) fail('REST_NEEDS_SUPPLIES', '休息需要饱食和实际光照；夜晚须自行准备火光');
    if (world.now() + p.duration_seconds * 1000 >= a.run.expires_at) fail('INSUFFICIENT_TIME', '现有许可不足以完成这次休息');
  } else {
    const m = monsters(world).find(m => m.monster_id === p.monster_id);
    if (!alive(m)) fail('TARGET_UNAVAILABLE', '这只怪物已被击败，请重新观察');
    const stats = combatStats(a);
    if (publicFatigue(a).energy < Math.max(12, stats.attack_energy)) fail('FATIGUE_EXHAUSTED', '重新挑战至少需要12点体力及一次攻击的体力');
    destination = { x: m.position.x + (a.position.x > m.position.x ? 1 : -1) * stats.range, y: 16 };
  }
  const j = newJob(world, a, p, destination);
  if (p.intent !== 'rest') queuePath(world, a, j, destination, fail);
  a.journey_job = j; a.journey_last_result = null;
  announce(world, a, 'journey_started', { ...publicJourneyJob(a), text: `${a.name}选择了${p.intent === 'enter' ? '前往森林入口' : p.intent === 'rest' ? '在营地休息' : p.intent === 'hunt' ? '挑战指定怪物' : p.intent === 'leave' ? '返回村口' : `前往${node(p.node_id).name}`}` });
  if (p.intent !== 'rest' && !a.movement) arrive(world, a);
  return { journey: journeyObservation(world, a) };
}
function arrive(world, a) {
  const j = a.journey_job;
  if (!j || j.phase !== 'approaching' || a.movement) return false;
  if (distance(a.position, j.destination) > 1e-8) return cancelJourney(world, a, 'movement_interrupted');
  if (j.encounter_monster_id) {
    const m = monsters(world).find(m => m.monster_id === j.encounter_monster_id);
    // The physical stop remains even if another actor defeated this encounter;
    // there is no implicit onward leg, fight, or changed route.
    announce(world, a, 'journey_encounter', { monster_id: m.monster_id, alive: alive(m), position: clone(a.position), text: `${a.name}到达${m.name}所在路段，是否挑战、绕行或返回由本人决定` });
    return cancelJourney(world, a, alive(m) ? 'encounter' : 'encounter_cleared');
  }
  if (j.intent === 'enter') {
    cancelJourney(world, a, 'arrived'); changeScene(world, a, 'journey', node('entry').position, 'journey_portal');
  } else if (j.intent === 'leave') {
    cancelJourney(world, a, 'departed'); changeScene(world, a, 'plaza', JOURNEY_GEOMETRY.return_position, 'journey_portal');
  } else if (j.intent === 'hunt') {
    const m = monsters(world).find(m => m.monster_id === j.monster_id);
    if (!alive(m)) return cancelJourney(world, a, 'target_unavailable');
    j.phase = 'fighting'; j.movement_id = null; a.facing = a.position.x <= m.position.x ? 'east' : 'west';
    announce(world, a, 'journey_arrived', { monster_id: m.monster_id, text: `${a.name}已到达交战位置，执行本人选择的有限挑战` });
  } else {
    announce(world, a, 'journey_arrived', { node_id: j.node_id, text: `${a.name}抵达${node(j.node_id).name}，下一步由本人决定` });
    cancelJourney(world, a, 'arrived');
  }
  return true;
}
const combatant = (world, a, m) => a?.scene_id === 'journey' && bound(world, a, a.journey_job || {}) && a.adventure.hp > 0
  && a.journey_job?.intent === 'hunt' && a.journey_job.phase === 'fighting' && a.journey_job.monster_id === m.monster_id && a.journey_job.expires_at > world.now();
function startAttack(actor, target, now, monster = false) {
  const interval = monster ? 1500 : combatStats(actor).attack_interval_ms, windup = monster ? 450 : Math.min(650, Math.round(interval * .35));
  actor.facing = actor.position.x <= target.position.x ? 'east' : 'west';
  actor.action = { action_id: `journey_attack_${randomUUID()}`, type: 'attack', scene_id: 'journey', target_id: monster ? target.agent_id : target.monster_id,
    target_kind: monster ? 'agent' : 'monster', facing: actor.facing, started_at: now, impact_at: now + windup, ends_at: now + Math.max(windup + 300, interval), phase: 'prepare', outcome: null, damage: 0, resolved_at: null };
  if (monster) actor.next_attack_at = now + interval; else actor.adventure.next_attack_at = now + interval;
}
function resolve(world, actor, target, valid, apply) {
  const now = world.now(), action = actor.action;
  if (!action || action.scene_id !== 'journey' || action.outcome !== null || now < action.impact_at) return false;
  action.phase = 'recovery'; action.resolved_at = now; action.outcome = 'miss';
  if (now - action.impact_at <= 1000 && target && valid()) apply(action);
  return true;
}
function reward(world, m) {
  const eligible = Object.entries(m.contributions).map(([id, damage]) => ({ a: world.state.agents[id], damage }))
    .filter(({ a, damage }) => damage > 0 && combatant(world, a, m) && distance(a.position, m.position) <= JOURNEY_RULES.monster_attack_range);
  const sum = eligible.reduce((n, e) => n + e.damage, 0); let xpLeft = m.xp, goldLeft = m.gold;
  for (const [i, { a, damage }] of eligible.entries()) {
    const before = economyBalance(a), f = a.adventure;
    const xp = i === eligible.length - 1 ? xpLeft : Math.floor(m.xp * damage / sum), allocated = i === eligible.length - 1 ? goldLeft : Math.floor(m.gold * damage / sum);
    const gold = Math.min(allocated, Number.MAX_SAFE_INTEGER - f.gold); xpLeft -= xp; goldLeft -= allocated;
    const previousLevel = f.level; f.xp += xp; f.gold += gold; f.kills++; f.level = Math.min(20, 1 + Math.floor(f.xp / 30)); f.max_hp = 40 + (f.level - 1) * 5;
    if (f.level > previousLevel) f.hp = Math.min(f.max_hp, f.hp + (f.level - previousLevel) * 5);
    const materials = grantMonsterLoot(a, m.monster_id === 'journey_slime' ? 'forest_slime' : 'forest_boar');
    const event = announce(world, a, 'journey_loot', { monster_id: m.monster_id, xp, gold, materials, text: `${a.name}参与击败${m.name}，获得${xp}经验与${gold}金币` });
    recordEconomyDelta(a, before, { source_id: event.event_id, reason: 'journey_loot', at: world.now(), world });
    progressPersonalGoal(world, a, { kind: 'defeat_monster', target_id: m.monster_id, source_id: event.event_id });
  }
  for (const a of Object.values(world.state.agents)) if (a.journey_job?.monster_id === m.monster_id) cancelJourney(world, a, 'victory');
  m.hp = 0; m.status = 'respawning'; m.respawn_at = world.now() + JOURNEY_RULES.monster_respawn_seconds * 1000; m.contributions = {}; m.target_agent_id = null; m.behavior = 'idle'; cancelAttack(m, world.now());
}
function hurtAgent(world, m, a, action) {
  const damage = Math.min(a.adventure.hp, Math.max(1, m.attack - combatStats(a).defense)), before = a.adventure.hp;
  a.adventure.hp -= damage; action.outcome = 'hit'; action.damage = damage; a.hurt = { action_id: action.action_id, started_at: world.now(), ends_at: world.now() + 360, damage };
  announce(world, a, 'journey_combat', { monster_id: m.monster_id, attacker: 'monster', damage, hp: a.adventure.hp, action_id: action.action_id, text: `${m.name}击中${a.name}，造成${damage}伤害` });
  if (a.adventure.hp <= 0) {
    cancelJourney(world, a, 'defeated'); changeScene(world, a, 'journey', node('entry').position, 'journey_rescue'); a.adventure.hp = 10;
    announce(world, a, 'journey_rescued', { text: `${a.name}倒地后被送回森林入口，恢复10点生命，下一步由本人决定` });
  } else if (before > a.adventure.max_hp * .25 && a.adventure.hp <= a.adventure.max_hp * .25) cancelJourney(world, a, 'needs_decision');
}
export function captureJourneyRest(world) {
  return new Map(Object.values(world.state.agents).flatMap(a => {
    const j = a.journey_job;
    if (a.scene_id !== 'journey' || j?.phase !== 'resting' || a.movement || world.state.room.status !== 'active' || a.status !== 'active' || a.run?.status !== 'active') return [];
    return [[a.agent_id, { from: j.last_rest_at, until: Math.min(world.now(), j.ends_at, j.expires_at, a.run.expires_at, (a.last_contact_at ?? -45000) + 45000), job_id: j.job_id }]];
  }));
}
export function settleJourneyRest(world, captured, survivalFrames) {
  let changed = false;
  for (const [id, interval] of captured) {
    const a = world.state.agents[id]; if (!a || interval.until <= interval.from) continue;
    const frame = survivalFrames?.get(id);
    const elapsed = frame ? frame.recovery_windows.filter(w => w.allowed).reduce((sum, w) => sum + Math.max(0, Math.min(interval.until, w.until, frame.stop_at ?? Infinity) - Math.max(interval.from, w.from)), 0)
      : survivalRecoveryAllowed(world, a) ? interval.until - interval.from : 0;
    const before = a.adventure.hp; a.adventure.hp = Math.min(a.adventure.max_hp, before + elapsed / 1000 * JOURNEY_RULES.rest_hp_per_second);
    if (a.journey_job?.job_id === interval.job_id) a.journey_job.last_rest_at = interval.until;
    changed = before !== a.adventure.hp || changed;
  }
  return changed;
}
export function tickJourney(world, survivalFrames = null) {
  const now = world.now(); let changed = false;
  for (const a of Object.values(world.state.agents)) {
    const j = a.journey_job;
    if (!j) continue;
    if (!bound(world, a, j) || j.expires_at <= now) { changed = cancelJourney(world, a, 'authorization_ended') || changed; continue; }
    if ((survivalFrames?.get(a.agent_id)?.stop_at ?? Infinity) <= now) { changed = cancelJourney(world, a, 'hurt') || changed; continue; }
    if (j.scene_id !== a.scene_id) { changed = cancelJourney(world, a, 'scene_changed') || changed; continue; }
    if (j.phase === 'approaching') changed = arrive(world, a) || changed;
    else if (j.phase === 'resting') {
      if (!survivalRecoveryAllowed(world, a)) changed = cancelJourney(world, a, 'needs_supplies') || changed;
      else if (j.ends_at <= now) changed = cancelJourney(world, a, 'rested') || changed;
    }
  }
  for (const m of monsters(world)) {
    if (m.hurt && m.hurt.ends_at <= now) { m.hurt = null; changed = true; }
    if (m.action && m.action.ends_at + 1000 <= now) { m.action = null; changed = true; }
    if (m.status === 'respawning' && m.respawn_at <= now) {
      m.status = 'alive'; m.hp = m.max_hp; m.respawn_at = null; m.action = null; m.hurt = null; m.contributions = {}; m.next_attack_at = now;
      announce(world, null, 'journey_respawn', { monster_id: m.monster_id, text: `${m.name}重新出现在林间路段` }); changed = true;
    }
  }
  for (const a of Object.values(world.state.agents)) {
    if (a.action?.scene_id !== 'journey') continue;
    const m = monsters(world).find(m => m.monster_id === a.action.target_id);
    if (!m || !combatant(world, a, m) || !alive(m)) { if (a.action.outcome === null) { cancelAttack(a, now); changed = true; } continue; }
    changed = resolve(world, a, m, () => combatant(world, a, m) && alive(m) && distance(a.position, m.position) <= combatStats(a).range, action => {
      if (!spendEnergy(world, a, 'attack')) return;
      const damage = Math.min(m.hp, Math.max(1, Math.floor(combatStats(a).attack * attackMultiplier(a))));
      m.hp -= damage; m.contributions[a.agent_id] = (m.contributions[a.agent_id] || 0) + damage; action.outcome = 'hit'; action.damage = damage;
      m.hurt = { action_id: action.action_id, started_at: now, ends_at: now + 360, damage };
      announce(world, a, 'journey_combat', { monster_id: m.monster_id, attacker: 'agent', damage, hp: m.hp, action_id: action.action_id, text: `${a.name}攻击${m.name}，造成${damage}伤害` });
      if (m.hp <= 0) reward(world, m);
    }) || changed;
  }
  for (const m of monsters(world)) {
    const target = world.state.agents[m.action?.target_id];
    if (!alive(m) || !combatant(world, target, m)) { if (m.action?.outcome === null) { cancelAttack(m, now); changed = true; } }
    else changed = resolve(world, m, target, () => combatant(world, target, m) && distance(m.position, target.position) <= JOURNEY_RULES.monster_attack_range,
      action => hurtAgent(world, m, target, action)) || changed;
  }
  for (const a of Object.values(world.state.agents)) {
    const j = a.journey_job;
    if (j?.phase !== 'fighting') continue;
    const m = monsters(world).find(m => m.monster_id === j.monster_id);
    if (!alive(m)) { changed = cancelJourney(world, a, 'target_unavailable') || changed; continue; }
    if (publicFatigue(a).energy < combatStats(a).attack_energy) { changed = cancelJourney(world, a, 'exhausted') || changed; continue; }
    if (distance(a.position, m.position) > combatStats(a).range) { changed = cancelJourney(world, a, 'out_of_range') || changed; continue; }
    if (now >= a.adventure.next_attack_at && (!a.action || a.action.ends_at <= now)) { startAttack(a, m, now); changed = true; }
  }
  for (const m of monsters(world)) {
    if (!alive(m)) continue;
    const fighters = Object.values(world.state.agents).filter(a => combatant(world, a, m) && distance(a.position, m.position) <= JOURNEY_RULES.monster_attack_range).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    const target = fighters.find(a => a.agent_id === m.target_agent_id) || fighters[0];
    const id = target?.agent_id || null;
    if (m.target_agent_id !== id) { m.target_agent_id = id; changed = true; }
    m.behavior = target ? 'attacking' : 'idle';
    if (target && now >= m.next_attack_at && (!m.action || m.action.ends_at <= now)) { startAttack(m, target, now, true); changed = true; }
  }
  return changed;
}
export function journeyObservation(world, a) {
  const job = publicJourneyJob(a), resources = publicResources(world.state, world.now()).nodes.filter(n => n.scene_id === 'journey');
  const opportunities = [];
  const add = (label, payload) => opportunities.push({ id: `journey_${payload.intent}_${payload.node_id || payload.monster_id || payload.route || ''}`, label, action: { type: 'journey', payload } });
  if (job) add('结束本次森林行程', { intent: 'stop' });
  else if (a.scene_id === 'plaza' && !a.home_presence && !a.home_travel) add('从入口前往横版森林', { intent: 'enter' });
  else if (a.scene_id === 'journey') {
    for (const n of JOURNEY_NODES) if (distance(a.position, n.position) > 1e-8) {
      add(`沿主路前往${n.name}`, { intent: 'travel', node_id: n.id });
      add(`沿支路绕行前往${n.name}`, { intent: 'travel', node_id: n.id, route: 'bypass' });
    }
    for (const m of monsters(world)) if (alive(m)) add(`挑战${m.name}`, { intent: 'hunt', monster_id: m.monster_id });
    if (distance(a.position, node('camp').position) < 1e-8 && survivalRecoveryAllowed(world, a)) add('在营地休息30秒', { intent: 'rest', duration_seconds: 30 });
    add('沿支路返回村口并离开森林', { intent: 'leave', route: 'bypass' });
  }
  const last = a.journey_last_result;
  return { ...publicJourney(world), job, last_result: last && typeof last.kind === 'string' && nowTime(last.at) ? { kind: last.kind.slice(0, 60), at: last.at, intent: last.intent } : null, resources, opportunities };
}
