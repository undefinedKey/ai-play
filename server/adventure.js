// The original AI chooses a finite plan; this module only executes public game rules.
import { WORLD_MAP, isPositionInBounds, boundedPosition, stepToward } from './spatial.js';
import { equipmentStats, grantMonsterLoot } from './life.js';
import { combatStats } from './combat.js';
import { FATIGUE_RULES, publicFatigue, spendEnergy, attackMultiplier, announceExhausted } from './fatigue.js';
import { economyBalance, recordEconomyDelta } from './economy.js';
import { EXPLORATION_RULES, initializeExploration, publicEncounter, encounterPending, discoverEncounter, endEncounter } from './exploration.js';
import { progressPersonalGoal } from './personal-goals.js';
export const ADVENTURE_ZONES = [
  { id: 'camp', name: '星火营地', x: 11, y: 8, radius: 2, danger: 'safe', description: '安全营地。主动休息恢复生命与体力，可以聊天并邀请同伴。' },
  { id: 'forest', name: '苔光森林', x: 4, y: 11, radius: 3, danger: 'low', description: '林间有史莱姆和野猪，可以独自探索或结伴狩猎。' },
  { id: 'ruins', name: '风蚀遗迹', x: 19, y: 7, radius: 3, danger: 'high', description: '守卫攻击较强，是否挑战、组队或撤退由你决定。' },
];
const MONSTERS = [
  { monster_id: 'forest_slime', name: '苔藓史莱姆', zone_id: 'forest', position: { x: 3, y: 11 }, max_hp: 18, attack: 2, xp: 12, gold: 6 },
  { monster_id: 'forest_boar', name: '荆棘野猪', zone_id: 'forest', position: { x: 6, y: 12 }, max_hp: 32, attack: 4, xp: 20, gold: 10 },
  { monster_id: 'ruins_guardian', name: '遗迹守卫', zone_id: 'ruins', position: { x: 20, y: 7 }, max_hp: 70, attack: 8, xp: 48, gold: 24 },
];
export const ADVENTURE_RULES = {
  map: { ...WORLD_MAP }, zones: ADVENTURE_ZONES, tick_ms: 1000, plan_seconds: 90, respawn_seconds: 60,
  exploration: EXPLORATION_RULES,
  monster_ai: { aggro_radius: 3, leash_radius: 6, decision_seconds: 30, camp_safe_radius: 2, patrol_radius: 2, patrol_interval_ms: 2000 },
  description: 'AI 自己选择冒险计划；服务器每秒最多执行一步，不代替 AI 选择下一个计划。探索抵达结束移动，并在300秒全局冷却允许时产生150秒限时保护的待选发现；狩猎只挑战一个目标，获得经验与金币后结束；休息回营地恢复满生命和体力；撤退回营地后结束，不自动开始休息；stop 只停止计划，留在野外仍可能遭遇怪物。怪物平时沿固定路线在出生点2格内巡逻，每2秒一步；每秒发现3格内已参加冒险且没有反应保护的角色便中断巡逻主动追击。最多离出生点6格，丢失目标先返回出生点恢复生命，再恢复巡逻。地图边界与营地半径2格安全区不会被巡逻或追击越过。',
  actions: { adventure_plan: { intent: ['explore', 'hunt', 'rest', 'retreat', 'stop'], zone_id: ['camp', 'forest', 'ruins'], monster_id: MONSTERS.map(m => m.monster_id) } },
  party: '使用 create_group / invite / respond_invite 自主组队；每位成员需自己选择 hunt 同一个 monster_id。同组或临时协力者只有实际参与战斗、结算时仍在目标附近且继续该计划，才按实际伤害分享总经验和金币。加入小组本身不授权战斗或跟随。',
  combat: '普通攻击为 4 + 等级×2 + 武器加成；射程、攻击间隔、每击体力和移动体力按life.stats的装备有效属性，旧武器默认射程1格、间隔1秒、每击3体力；护甲降低怪物伤害但每次至少受到1点。怪物每秒最多移动一步或攻击一次，不叠加反击。被攻击不会替AI自动反击，只有hunt计划会攻击。生命从四分之一以上降到四分之一或更低时结束当前计划，提供30秒反应保护并通知原AI选择继续、撤退或求助；不暂停角色权限。保护到期后野外仍可能遭攻击，低血受击不会重复刷新保护。主动hunt取消保护，其他行动保留剩余时间。生命归零后返回营地、恢复10点生命并结束计划。回到营地或离线/暂停/召回/授权到期会退出野外状态。',
};
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const camp = ADVENTURE_ZONES[0];
const clone = value => structuredClone(value);
const safeCamp = position => distance(position, camp) <= camp.radius;
// An eight-step diamond, not a fresh random choice at every frame.
const PATROL_OFFSETS = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }];
const freshFighter = () => ({ hp: 40, max_hp: 40, level: 1, xp: 0, gold: 0, kills: 0, plan: null, last_result: null, in_field: false, decision_until: null,
  next_attack_at: 0, encounter: null, discovery_ready_at: 0 });
export function initializeAdventure(state, now) {
  const previous = state.adventure?.monsters || [];
  state.adventure = { last_tick_at: now, monsters: MONSTERS.map(template => {
    const old = previous.find(m => m.monster_id === template.monster_id);
    return { ...clone(template), position: boundedPosition(template.position), hp: old ? Math.max(0, Math.min(template.max_hp, old.hp)) : template.max_hp,
      status: old?.status === 'respawning' ? 'respawning' : 'alive', respawn_at: old?.status === 'respawning' ? old.respawn_at : null, contributions: {}, strikes: 0,
      home_position: boundedPosition(template.position), target_agent_id: null, behavior: 'idle', aggro_radius: 3, leash_radius: 6,
      patrol_radius: 2, patrol_interval_ms: 2000, patrol_index: 0, next_patrol_at: now + 2000 };
  }) };
  for (const a of Object.values(state.agents)) {
    a.adventure ??= freshFighter();
    a.adventure.next_attack_at = Number.isSafeInteger(a.adventure.next_attack_at) && a.adventure.next_attack_at >= 0 ? a.adventure.next_attack_at : 0;
    initializeExploration(a);
    if (a.adventure.plan) a.adventure.last_result = { kind: 'interrupted', text: '服务重启，冒险计划已停止；请原 AI 重新决定。', at: now };
    a.adventure.plan = null;
    a.adventure.in_field = false; a.adventure.decision_until = null;
  }
}
export function initializeFighter(a) { a.adventure = freshFighter(); initializeExploration(a); }
export function publicFighter(a) {
  const f = a.adventure || freshFighter();
  return { hp: f.hp, max_hp: f.max_hp, level: f.level, xp: f.xp, gold: f.gold, kills: f.kills, in_field: f.in_field === true, decision_until: f.decision_until ?? null,
    encounter: publicEncounter(a), discovery_ready_at: f.discovery_ready_at || 0,
    plan: f.plan ? { intent: f.plan.intent, zone_id: f.plan.zone_id, monster_id: f.plan.monster_id, started_at: f.plan.started_at, expires_at: f.plan.expires_at } : null,
    last_result: f.last_result ? { kind: f.last_result.kind, text: f.last_result.text, at: f.last_result.at } : null };
}
export function publicAdventure(state) {
  return { map: { ...WORLD_MAP }, zones: clone(ADVENTURE_ZONES), tick_ms: 1000, plan_seconds: 90, exploration: clone(EXPLORATION_RULES),
    monsters: (state.adventure?.monsters || []).map(m => ({ monster_id: m.monster_id, name: m.name, zone_id: m.zone_id, position: clone(m.position), hp: m.hp, max_hp: m.max_hp, attack: m.attack, status: m.status, respawn_at: m.respawn_at,
      home_position: clone(m.home_position), target_agent_id: m.target_agent_id, behavior: m.behavior, aggro_radius: m.aggro_radius, leash_radius: m.leash_radius,
      patrol_radius: m.patrol_radius, patrol_interval_ms: m.patrol_interval_ms })) };
}
function announce(world, type, a, text, extra = {}) {
  return world.event(type, { ...(a ? { agent_id: a.agent_id, name: a.name } : {}), text, ...extra }, world.activeIds());
}
export function stopAdventure(world, a, kind = 'stopped', text = '冒险计划已停止') {
  if (!a.adventure?.plan) return false;
  a.adventure.plan = null;
  a.adventure.last_result = { kind, text, at: world.now() };
  // A stopped plan cannot keep a claim on a future kill, even if it later reconnects.
  for (const monster of world.state.adventure.monsters) delete monster.contributions[a.agent_id];
  announce(world, 'adventure_finished', a, `${a.name}：${text}`, { kind });
  return true;
}
/** Permission changes and returning to camp end exposure, not merely ending a plan. */
export function leaveAdventureField(world, a) {
  if (!a.adventure) return;
  a.adventure.in_field = false; a.adventure.decision_until = null;
  for (const m of world.state.adventure.monsters) {
    delete m.contributions[a.agent_id];
    if (m.target_agent_id === a.agent_id) {
      m.target_agent_id = null; m.behavior = distance(m.position, m.home_position) ? 'returning' : 'idle';
      m.next_patrol_at = world.now() + m.patrol_interval_ms;
    }
  }
}
export function startAdventure(world, a, payload, fail) {
  if (a.life?.gathering) fail('GATHER_BUSY', '请先取消采集或等待完成');
  if (Object.keys(payload).some(k => !['intent', 'zone_id', 'monster_id'].includes(k)) || !['explore', 'hunt', 'rest', 'retreat', 'stop'].includes(payload.intent)) fail('INVALID_ACTION', '冒险计划只接受 intent、zone_id 和 monster_id');
  const { intent, zone_id, monster_id } = payload;
  if (encounterPending(a, world.now()) && !['stop', 'retreat'].includes(intent)) fail('ENCOUNTER_PENDING', '请先处理探索发现，或明确 stop/retreat 中断');
  if (zone_id !== undefined && !ADVENTURE_ZONES.some(z => z.id === zone_id)) fail('INVALID_ACTION', '冒险区域不存在');
  if (monster_id !== undefined && (intent !== 'hunt' || typeof monster_id !== 'string')) fail('INVALID_ACTION', '只有 hunt 可以指定 monster_id');
  if (intent === 'stop') {
    if (zone_id !== undefined) fail('INVALID_ACTION', 'stop 不接受 zone_id');
    endEncounter(world, a);
    stopAdventure(world, a); return { adventure: publicFighter(a) };
  }
  if (a.activity) fail('ACTIVITY_BUSY', '请先结束独处活动，再开始冒险');
  if (world.state.game && world.state.game.status !== 'finished' && world.state.game.participants.includes(a.agent_id)) fail('GAME_BUSY', '请先退出当前多人游戏，再开始冒险');
  let target;
  let zone = zone_id;
  if (intent === 'explore' && !zone) fail('INVALID_ACTION', 'explore 需要 zone_id');
  if (['rest', 'retreat'].includes(intent)) {
    if (zone && zone !== 'camp') fail('INVALID_ACTION', '休息和撤退的目的地为 camp');
    zone = 'camp';
  }
  if (intent === 'hunt') {
    if (publicFatigue(a).energy < Math.max(FATIGUE_RULES.hunt_min_energy, combatStats(a).attack_energy)) fail('FATIGUE_EXHAUSTED', '重新狩猎至少需要12点体力及一次有效攻击的体力；可先返回营地休息，也始终可以走路或撤退');
    if (!zone && !monster_id) fail('INVALID_ACTION', 'hunt 需要 zone_id 或 monster_id');
    target = monster_id ? world.state.adventure.monsters.find(m => m.monster_id === monster_id) : world.state.adventure.monsters.filter(m => m.zone_id === zone && m.status === 'alive').sort((x, y) => distance(a.position, x.position) - distance(a.position, y.position))[0];
    if (!target || target.status !== 'alive' || target.hp <= 0) fail('TARGET_UNAVAILABLE', '目标已被击败或该区域暂无可挑战的怪物，请重新观察');
    if (zone && target.zone_id !== zone) fail('INVALID_ACTION', 'monster_id 与 zone_id 不匹配');
    zone = target.zone_id;
  }
  if (intent === 'retreat') endEncounter(world, a);
  stopAdventure(world, a, 'replanned', '原 AI 改变了冒险计划');
  a.adventure.plan = { intent, zone_id: zone, monster_id: target?.monster_id || null, started_at: world.now(), expires_at: world.now() + 90000 };
  if (['hunt', 'explore'].includes(intent) && zone !== 'camp') a.adventure.in_field = !safeCamp(a.position);
  if (intent === 'hunt') a.adventure.decision_until = null;
  a.adventure.last_result = null;
  const destination = target?.name || ADVENTURE_ZONES.find(z => z.id === zone).name;
  announce(world, 'adventure_started', a, `${a.name}决定${({ explore: '探索', hunt: '挑战', rest: '休息于', retreat: '撤回' })[intent]}${destination}`, { intent, zone_id: zone, monster_id: target?.monster_id });
  return { adventure: publicFighter(a) };
}
function moveToward(a, target, world) {
  const next = stepToward(a.position, target);
  if (world) spendEnergy(world, a, 'move', distance(a.position, next));
  a.position = next;
}
function allowedMonsterStep(m, position, radius) {
  return isPositionInBounds(position) && !safeCamp(position) && distance(position, m.home_position) <= radius;
}
function patrol(m, now) {
  if (now < m.next_patrol_at) return false;
  // A delayed process makes one step, never a burst of missed patrol steps.
  m.next_patrol_at = now + m.patrol_interval_ms;
  const route = PATROL_OFFSETS.map(offset => ({ x: m.home_position.x + offset.x, y: m.home_position.y + offset.y })).filter(position => allowedMonsterStep(m, position, m.patrol_radius));
  if (!route.length) return false;
  for (let attempts = 0; attempts < route.length; attempts++) {
    m.patrol_index %= route.length;
    const target = route[m.patrol_index];
    if (!distance(m.position, target)) { m.patrol_index = (m.patrol_index + 1) % route.length; continue; }
    const primary = stepToward(m.position, target);
    const vertical = target.y !== m.position.y ? { x: m.position.x, y: m.position.y + Math.sign(target.y - m.position.y) } : m.position;
    // At map/camp edges a skipped waypoint can need the other axis first.
    const next = [primary, vertical].find(position => distance(m.position, position) === 1 && allowedMonsterStep(m, position, m.patrol_radius));
    if (next) {
      m.position = next; m.behavior = 'patrolling';
      if (!distance(m.position, target)) m.patrol_index = (m.patrol_index + 1) % route.length;
      return true;
    }
    m.patrol_index = (m.patrol_index + 1) % route.length;
  }
  return false;
}
function reward(world, monster) {
  const eligible = Object.entries(monster.contributions).map(([id, damage]) => ({ a: world.state.agents[id], damage })).filter(({ a, damage }) => a?.status === 'active' && damage > 0 && a.adventure?.plan?.monster_id === monster.monster_id && distance(a.position, monster.position) <= Math.max(2, combatStats(a).range));
  const total = eligible.reduce((n, entry) => n + entry.damage, 0);
  let xpLeft = monster.xp, goldLeft = monster.gold;
  for (const [index, { a, damage }] of eligible.entries()) {
    const balanceBefore = economyBalance(a);
    const xp = index === eligible.length - 1 ? xpLeft : Math.floor(monster.xp * damage / total);
    const allocatedGold = index === eligible.length - 1 ? goldLeft : Math.floor(monster.gold * damage / total);
    const gold = Math.min(allocatedGold, Number.MAX_SAFE_INTEGER - a.adventure.gold);
    xpLeft -= xp; goldLeft -= allocatedGold;
    const f = a.adventure; f.xp += xp; f.gold += gold; f.kills++;
    const oldLevel = f.level;
    f.level = Math.min(20, 1 + Math.floor(f.xp / 30)); f.max_hp = 40 + (f.level - 1) * 5;
    if (f.level > oldLevel) f.hp = Math.min(f.max_hp, f.hp + (f.level - oldLevel) * 5);
    const materials = grantMonsterLoot(a, monster.monster_id);
    const materialText = materials.map(item => `${item.quantity}份${item.item_id === 'wood' ? '木材' : '矿石'}`).join('、');
    const event = announce(world, 'adventure_loot', a, `${a.name}参与击败${monster.name}，获得 ${xp} 经验、${gold} 金币${materialText ? `、${materialText}` : ''}${f.level > oldLevel ? `，升到 ${f.level} 级` : ''}`, { monster_id: monster.monster_id, xp, gold, materials });
    recordEconomyDelta(a, balanceBefore, { source_id: event.event_id, reason: 'monster_loot', at: world.now(), world });
    progressPersonalGoal(world, a, { kind: 'defeat_monster', target_id: monster.monster_id, source_id: event.event_id });
    stopAdventure(world, a, 'victory', `击败${monster.name}，获得 ${xp} 经验、${gold} 金币${materialText ? `、${materialText}` : ''}`);
  }
  monster.hp = 0; monster.status = 'respawning'; monster.respawn_at = world.now() + 60000; monster.contributions = {};
  monster.target_agent_id = null; monster.behavior = 'idle'; monster.position = boundedPosition(monster.home_position);
  monster.patrol_index = 0; monster.next_patrol_at = monster.respawn_at + monster.patrol_interval_ms;
}
function vulnerable(world, a) {
  return a?.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now()
    && a.last_contact_at !== null && world.now() - a.last_contact_at < 45000
    && a.adventure?.in_field === true && a.adventure.hp > 0 && isPositionInBounds(a.position) && !safeCamp(a.position)
    && !(a.adventure.decision_until > world.now()) && !encounterPending(a, world.now());
}
function finishAtDecision(world, a, kind, text) {
  if (!stopAdventure(world, a, kind, text)) {
    // Exploration and stop leave a role exposed even though no plan is running.
    a.adventure.last_result = { kind, text, at: world.now() };
    for (const m of world.state.adventure.monsters) delete m.contributions[a.agent_id];
    announce(world, 'adventure_finished', a, `${a.name}：${text}`, { kind });
  }
}
function monsterAttack(world, m, a) {
  // Recheck after every monster: another monster can grant protection this tick.
  if (!vulnerable(world, a) || distance(a.position, m.position) > 1) return false;
  const f = a.adventure, before = f.hp;
  const damage = Math.max(1, m.attack - equipmentStats(a).defense);
  f.hp = Math.max(0, f.hp - damage);
  announce(world, 'adventure_combat', a, `${m.name}攻击${a.name}，造成 ${damage} 点伤害`, { monster_id: m.monster_id, attacker: 'monster', damage, hp: f.hp });
  if (f.hp === 0) {
    a.position = { x: camp.x, y: camp.y }; f.hp = 10;
    announce(world, 'adventure_defeated', a, `${a.name}被${m.name}击败，已安全返回营地`, { monster_id: m.monster_id });
    finishAtDecision(world, a, 'defeated', '已返回营地并恢复 10 点生命，可自行选择休息或其他活动');
    leaveAdventureField(world, a); return true;
  }
  if (before > f.max_hp * .25 && f.hp <= f.max_hp * .25) {
    f.decision_until = world.now() + 30000;
    announce(world, 'adventure_danger', a, `${a.name}生命不足四分之一，获得30秒反应保护；可自主撤退、求助或继续`, { hp: f.hp, decision_until: f.decision_until });
    finishAtDecision(world, a, 'needs_decision', '当前计划已停止，获得30秒反应保护；请AI决定撤退、求助或继续，主动狩猎会取消保护');
    // Keep only public returning/idle state while this role is protected.
    for (const other of world.state.adventure.monsters) if (other.target_agent_id === a.agent_id) {
      other.target_agent_id = null; other.behavior = distance(other.position, other.home_position) ? 'returning' : 'idle';
      other.next_patrol_at = world.now() + other.patrol_interval_ms;
    }
    return true;
  }
  return false;
}
function targetMonster(world, m, target) {
  if (m.target_agent_id !== target.agent_id) {
    m.target_agent_id = target.agent_id;
    announce(world, 'adventure_aggro', target, `${m.name}盯上了${target.name}`, { monster_id: m.monster_id, target_agent_id: target.agent_id });
  }
}
/** One fixed step at most: a delayed process never catches up minutes of combat. */
export function tickAdventure(world) {
  const state = world.state.adventure, now = world.now();
  if (world.state.room.status !== 'active' || now - state.last_tick_at < 1000) return { changed: false, durable: false };
  state.last_tick_at = now;
  let changed = false, durable = false;
  for (const m of state.monsters) if (m.status === 'respawning' && m.respawn_at <= now) {
    m.status = 'alive'; m.hp = m.max_hp; m.respawn_at = null; m.contributions = {}; m.strikes = 0; changed = true;
    m.position = boundedPosition(m.home_position); m.target_agent_id = null; m.behavior = 'idle';
    m.patrol_index = 0; m.next_patrol_at = now + m.patrol_interval_ms;
    announce(world, 'adventure_respawn', null, `${m.name}重新出现在${ADVENTURE_ZONES.find(z => z.id === m.zone_id).name}`, { monster_id: m.monster_id });
  }
  const attackers = new Map();
  for (const a of Object.values(world.state.agents)) {
    const f = a.adventure, p = f?.plan;
    if (a.status !== 'active' || !f) continue;
    if (f.decision_until !== null && f.decision_until <= now) { f.decision_until = null; changed = true; }
    if (p) {
      changed = true;
      if (p.expires_at <= now) { stopAdventure(world, a, 'expired', '本次冒险计划已到时，请重新决定下一步'); durable = true; }
      else if (p.intent === 'hunt') {
        const m = state.monsters.find(m => m.monster_id === p.monster_id);
        const stats = combatStats(a);
        if (publicFatigue(a).energy < stats.attack_energy) {
          stopAdventure(world, a, 'exhausted', '体力不足以继续攻击，请自主决定撤退、休息或其他活动'); announceExhausted(world, a); durable = true;
        } else if (!m || m.status !== 'alive') { stopAdventure(world, a, 'target_unavailable', '目标已被击败，请重新决定下一步'); durable = true; }
        else if (distance(a.position, m.position) > stats.range || safeCamp(a.position)) moveToward(a, m.position, world);
        else if (now >= (f.next_attack_at || 0)) { if (!attackers.has(m.monster_id)) attackers.set(m.monster_id, []); attackers.get(m.monster_id).push(a); }
      } else {
        const target = ADVENTURE_ZONES.find(z => z.id === p.zone_id);
        if (distance(a.position, target) > 0) moveToward(a, target, world);
        else {
          if (p.intent === 'rest') f.hp = Math.min(f.max_hp, f.hp + 5);
          if (p.intent !== 'rest' || f.hp === f.max_hp && publicFatigue(a).energy === 100) {
            announce(world, 'adventure_arrived', a, `${a.name}${p.intent === 'rest' ? '在营地恢复了生命与体力' : `抵达${target.name}`}`, { zone_id: target.id });
            stopAdventure(world, a, 'completed', p.intent === 'rest' ? '休息完毕，生命与体力已恢复' : `已抵达${target.name}，请自主决定下一步`); durable = true;
            if (p.intent === 'explore') discoverEncounter(world, a, target.id);
          }
        }
      }
    }
    if (safeCamp(a.position)) {
      if (f.in_field || f.decision_until !== null) { leaveAdventureField(world, a); changed = true; durable = true; }
    } else if (p && ['hunt', 'explore'].includes(p.intent) && p.zone_id !== 'camp') f.in_field = true;
  }
  // AI-authored hunt plans attack first. Merely being chased never invents a hunt.
  for (const [id, party] of attackers) {
    const m = state.monsters.find(m => m.monster_id === id);
    for (const a of party) {
      if (m.hp <= 0) break;
      if (!spendEnergy(world, a, 'attack')) continue;
      const stats = combatStats(a);
      a.adventure.next_attack_at = now + stats.attack_interval_ms; durable = true;
      const damage = Math.min(m.hp, Math.max(1, Math.floor(stats.attack * attackMultiplier(a)))); m.hp -= damage;
      m.contributions[a.agent_id] = (m.contributions[a.agent_id] || 0) + damage;
      announce(world, 'adventure_combat', a, `${a.name}攻击${m.name}，造成 ${damage} 点伤害`, { monster_id: id, attacker: 'agent', damage, hp: m.hp });
    }
    if (m.hp <= 0) { reward(world, m); durable = true; }
  }
  // All monster damage lives in this one phase: never retaliation plus aggro damage.
  for (const m of state.monsters) {
    if (m.status !== 'alive') continue;
    const retaliation = (attackers.get(m.monster_id) || []).filter(a => vulnerable(world, a) && distance(a.position, m.position) <= 1);
    const previous = m.target_agent_id;
    let target = world.state.agents[previous];
    if (!vulnerable(world, target) || distance(target.position, m.home_position) > m.leash_radius && !retaliation.includes(target)) target = null;
    if (!target) target = retaliation[0] || Object.values(world.state.agents).filter(a => vulnerable(world, a) && distance(a.position, m.position) <= m.aggro_radius && distance(a.position, m.home_position) <= m.leash_radius).sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0];
    if (target) {
      targetMonster(world, m, target); changed = true;
      if (distance(m.position, target.position) <= 1) {
        m.behavior = 'attacking'; if (monsterAttack(world, m, target)) durable = true;
      } else {
        const step = { position: clone(m.position) }; moveToward(step, target.position);
        if (allowedMonsterStep(m, step.position, m.leash_radius)) { m.position = step.position; m.behavior = 'chasing'; }
        else { m.target_agent_id = null; m.behavior = 'returning'; }
      }
    } else {
      m.target_agent_id = null;
      const returning = previous || ['chasing', 'attacking', 'returning'].includes(m.behavior) || m.hp !== m.max_hp || m.behavior === 'idle' && distance(m.position, m.home_position);
      if (returning) {
        if (distance(m.position, m.home_position)) {
          m.behavior = 'returning';
          const step = stepToward(m.position, m.home_position);
          if (allowedMonsterStep(m, step, m.leash_radius)) m.position = step;
          changed = true;
        }
        if (!distance(m.position, m.home_position)) {
          m.behavior = 'idle'; m.hp = m.max_hp; m.contributions = {}; m.patrol_index = 0; m.next_patrol_at = now + m.patrol_interval_ms; changed = true;
        }
      } else if (patrol(m, now)) {
        changed = true;
      }
    }
  }
  // Movement is a snapshot update, not a per-step event that would wake every model.
  if (changed) world.state.room.world_revision++;
  return { changed, durable };
}
