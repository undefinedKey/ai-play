// The original AI chooses a finite plan; this module only executes public game rules.
export const ADVENTURE_ZONES = [
  { id: 'camp', name: '星火营地', x: 11, y: 8, radius: 2, danger: 'safe', description: '安全营地。休息恢复生命，可以聊天并邀请同伴。' },
  { id: 'forest', name: '苔光森林', x: 4, y: 11, radius: 3, danger: 'low', description: '林间有史莱姆和野猪，可以独自探索或结伴狩猎。' },
  { id: 'ruins', name: '风蚀遗迹', x: 19, y: 7, radius: 3, danger: 'high', description: '守卫攻击较强，是否挑战、组队或撤退由你决定。' },
];
const MONSTERS = [
  { monster_id: 'forest_slime', name: '苔藓史莱姆', zone_id: 'forest', position: { x: 3, y: 11 }, max_hp: 18, attack: 2, xp: 12, gold: 6 },
  { monster_id: 'forest_boar', name: '荆棘野猪', zone_id: 'forest', position: { x: 6, y: 12 }, max_hp: 32, attack: 4, xp: 20, gold: 10 },
  { monster_id: 'ruins_guardian', name: '遗迹守卫', zone_id: 'ruins', position: { x: 20, y: 7 }, max_hp: 70, attack: 8, xp: 48, gold: 24 },
];
export const ADVENTURE_RULES = {
  zones: ADVENTURE_ZONES, tick_ms: 1000, plan_seconds: 90, respawn_seconds: 60,
  description: 'AI 自己选择冒险计划；服务器每秒最多执行一步，不代替 AI 选择下一个计划。探索抵达即结束；狩猎只挑战一个目标，获得经验与金币后结束；休息回营地恢复满生命；撤退回营地后结束；stop 可随时停止。怪物只反击主动狩猎者。',
  actions: { adventure_plan: { intent: ['explore', 'hunt', 'rest', 'retreat', 'stop'], zone_id: ['camp', 'forest', 'ruins'], monster_id: MONSTERS.map(m => m.monster_id) } },
  party: '使用 create_group / invite / respond_invite 自主组队；每位成员需自己选择 hunt 同一个 monster_id。同组或临时协力者只有实际参与战斗、结算时仍在目标附近且继续该计划，才按实际伤害分享总经验和金币。加入小组本身不授权战斗或跟随。',
  combat: '普通攻击为 4 + 等级×2；怪物每秒反击一名附近的参与者。生命不足四分之一时停止当前计划并通知原 AI，留在原地等待重新决定继续、撤退或求助；不暂停角色权限。低血主动再次狩猎仍可能战败。生命归零后返回营地、恢复 10 点生命并停止计划。成长保留，计划不会自动重开。离线、暂停、召回、授权到期时停止执行。',
};
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const camp = ADVENTURE_ZONES[0];
const clone = value => structuredClone(value);
const freshFighter = () => ({ hp: 40, max_hp: 40, level: 1, xp: 0, gold: 0, kills: 0, plan: null, last_result: null });
export function initializeAdventure(state, now) {
  const previous = state.adventure?.monsters || [];
  state.adventure = { last_tick_at: now, monsters: MONSTERS.map(template => {
    const old = previous.find(m => m.monster_id === template.monster_id);
    return { ...clone(template), hp: old ? Math.max(0, Math.min(template.max_hp, old.hp)) : template.max_hp,
      status: old?.status === 'respawning' ? 'respawning' : 'alive', respawn_at: old?.status === 'respawning' ? old.respawn_at : null, contributions: {}, strikes: 0 };
  }) };
  for (const a of Object.values(state.agents)) {
    a.adventure ??= freshFighter();
    if (a.adventure.plan) a.adventure.last_result = { kind: 'interrupted', text: '服务重启，冒险计划已停止；请原 AI 重新决定。', at: now };
    a.adventure.plan = null;
  }
}
export function initializeFighter(a) { a.adventure = freshFighter(); }
export function publicFighter(a) {
  const f = a.adventure || freshFighter();
  return { hp: f.hp, max_hp: f.max_hp, level: f.level, xp: f.xp, gold: f.gold, kills: f.kills,
    plan: f.plan ? { intent: f.plan.intent, zone_id: f.plan.zone_id, monster_id: f.plan.monster_id, started_at: f.plan.started_at, expires_at: f.plan.expires_at } : null,
    last_result: f.last_result ? { kind: f.last_result.kind, text: f.last_result.text, at: f.last_result.at } : null };
}
export function publicAdventure(state) {
  return { zones: clone(ADVENTURE_ZONES), tick_ms: 1000, plan_seconds: 90,
    monsters: (state.adventure?.monsters || []).map(m => ({ monster_id: m.monster_id, name: m.name, zone_id: m.zone_id, position: clone(m.position), hp: m.hp, max_hp: m.max_hp, attack: m.attack, status: m.status, respawn_at: m.respawn_at })) };
}
function announce(world, type, a, text, extra = {}) {
  world.event(type, { ...(a ? { agent_id: a.agent_id, name: a.name } : {}), text, ...extra }, world.activeIds());
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
export function startAdventure(world, a, payload, fail) {
  if (Object.keys(payload).some(k => !['intent', 'zone_id', 'monster_id'].includes(k)) || !['explore', 'hunt', 'rest', 'retreat', 'stop'].includes(payload.intent)) fail('INVALID_ACTION', '冒险计划只接受 intent、zone_id 和 monster_id');
  const { intent, zone_id, monster_id } = payload;
  if (zone_id !== undefined && !ADVENTURE_ZONES.some(z => z.id === zone_id)) fail('INVALID_ACTION', '冒险区域不存在');
  if (monster_id !== undefined && (intent !== 'hunt' || typeof monster_id !== 'string')) fail('INVALID_ACTION', '只有 hunt 可以指定 monster_id');
  if (intent === 'stop') {
    if (zone_id !== undefined) fail('INVALID_ACTION', 'stop 不接受 zone_id');
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
    if (!zone && !monster_id) fail('INVALID_ACTION', 'hunt 需要 zone_id 或 monster_id');
    target = monster_id ? world.state.adventure.monsters.find(m => m.monster_id === monster_id) : world.state.adventure.monsters.filter(m => m.zone_id === zone && m.status === 'alive').sort((x, y) => distance(a.position, x.position) - distance(a.position, y.position))[0];
    if (!target || target.status !== 'alive' || target.hp <= 0) fail('TARGET_UNAVAILABLE', '目标已被击败或该区域暂无可挑战的怪物，请重新观察');
    if (zone && target.zone_id !== zone) fail('INVALID_ACTION', 'monster_id 与 zone_id 不匹配');
    zone = target.zone_id;
  }
  stopAdventure(world, a, 'replanned', '原 AI 改变了冒险计划');
  a.adventure.plan = { intent, zone_id: zone, monster_id: target?.monster_id || null, started_at: world.now(), expires_at: world.now() + 90000, danger_reported: false };
  a.adventure.last_result = null;
  const destination = target?.name || ADVENTURE_ZONES.find(z => z.id === zone).name;
  announce(world, 'adventure_started', a, `${a.name}决定${({ explore: '探索', hunt: '挑战', rest: '休息于', retreat: '撤回' })[intent]}${destination}`, { intent, zone_id: zone, monster_id: target?.monster_id });
  return { adventure: publicFighter(a) };
}
function moveToward(a, target) {
  if (a.position.x !== target.x) a.position.x += Math.sign(target.x - a.position.x);
  else if (a.position.y !== target.y) a.position.y += Math.sign(target.y - a.position.y);
}
function reward(world, monster) {
  const eligible = Object.entries(monster.contributions).map(([id, damage]) => ({ a: world.state.agents[id], damage })).filter(({ a, damage }) => a?.status === 'active' && damage > 0 && a.adventure?.plan?.monster_id === monster.monster_id && distance(a.position, monster.position) <= 2);
  const total = eligible.reduce((n, entry) => n + entry.damage, 0);
  let xpLeft = monster.xp, goldLeft = monster.gold;
  for (const [index, { a, damage }] of eligible.entries()) {
    const xp = index === eligible.length - 1 ? xpLeft : Math.floor(monster.xp * damage / total);
    const gold = index === eligible.length - 1 ? goldLeft : Math.floor(monster.gold * damage / total);
    xpLeft -= xp; goldLeft -= gold;
    const f = a.adventure; f.xp += xp; f.gold += gold; f.kills++;
    const oldLevel = f.level;
    f.level = Math.min(20, 1 + Math.floor(f.xp / 30)); f.max_hp = 40 + (f.level - 1) * 5;
    if (f.level > oldLevel) f.hp = Math.min(f.max_hp, f.hp + (f.level - oldLevel) * 5);
    announce(world, 'adventure_loot', a, `${a.name}参与击败${monster.name}，获得 ${xp} 经验、${gold} 金币${f.level > oldLevel ? `，升到 ${f.level} 级` : ''}`, { monster_id: monster.monster_id, xp, gold });
    stopAdventure(world, a, 'victory', `击败${monster.name}，获得 ${xp} 经验、${gold} 金币`);
  }
  monster.hp = 0; monster.status = 'respawning'; monster.respawn_at = world.now() + 60000; monster.contributions = {};
}
/** One fixed step at most: a delayed process never catches up minutes of combat. */
export function tickAdventure(world) {
  const state = world.state.adventure, now = world.now();
  if (world.state.room.status !== 'active' || now - state.last_tick_at < 1000) return { changed: false, durable: false };
  state.last_tick_at = now;
  let changed = false, durable = false;
  for (const m of state.monsters) if (m.status === 'respawning' && m.respawn_at <= now) {
    m.status = 'alive'; m.hp = m.max_hp; m.respawn_at = null; m.contributions = {}; m.strikes = 0; changed = true;
    announce(world, 'adventure_respawn', null, `${m.name}重新出现在${ADVENTURE_ZONES.find(z => z.id === m.zone_id).name}`, { monster_id: m.monster_id });
  }
  const attackers = new Map();
  for (const a of Object.values(world.state.agents)) {
    const f = a.adventure, p = f?.plan;
    if (!p || a.status !== 'active') continue;
    changed = true;
    if (p.expires_at <= now) { stopAdventure(world, a, 'expired', '本次冒险计划已到时，请重新决定下一步'); durable = true; continue; }
    if (p.intent === 'hunt') {
      const m = state.monsters.find(m => m.monster_id === p.monster_id);
      if (!m || m.status !== 'alive') { stopAdventure(world, a, 'target_unavailable', '目标已被击败，请重新决定下一步'); durable = true; continue; }
      if (distance(a.position, m.position) > 1) moveToward(a, m.position);
      else { if (!attackers.has(m.monster_id)) attackers.set(m.monster_id, []); attackers.get(m.monster_id).push(a); }
      continue;
    }
    const target = ADVENTURE_ZONES.find(z => z.id === p.zone_id);
    if (distance(a.position, target) > 0) { moveToward(a, target); continue; }
    if (p.intent === 'rest' && f.hp < f.max_hp) {
      f.hp = Math.min(f.max_hp, f.hp + 5);
      if (f.hp < f.max_hp) continue;
    }
    announce(world, 'adventure_arrived', a, `${a.name}${p.intent === 'rest' ? '在营地恢复了生命' : `抵达${target.name}`}`, { zone_id: target.id });
    stopAdventure(world, a, 'completed', p.intent === 'rest' ? '休息完毕，生命已恢复' : `已抵达${target.name}，请自主决定下一步`);
    durable = true;
  }
  for (const [id, party] of attackers) {
    const m = state.monsters.find(m => m.monster_id === id);
    for (const a of party) {
      if (m.hp <= 0) break;
      const damage = Math.min(m.hp, 4 + a.adventure.level * 2); m.hp -= damage;
      m.contributions[a.agent_id] = (m.contributions[a.agent_id] || 0) + damage;
      announce(world, 'adventure_combat', a, `${a.name}攻击${m.name}，造成 ${damage} 点伤害`, { monster_id: id, damage, hp: m.hp });
    }
    if (m.hp <= 0) { reward(world, m); durable = true; continue; }
    const a = party[m.strikes++ % party.length], f = a.adventure;
    f.hp = Math.max(0, f.hp - m.attack);
    announce(world, 'adventure_combat', a, `${m.name}反击${a.name}，造成 ${m.attack} 点伤害`, { monster_id: id, damage: m.attack, hp: f.hp });
    if (f.hp === 0) {
      a.position = { x: camp.x, y: camp.y }; f.hp = 10;
      announce(world, 'adventure_defeated', a, `${a.name}被${m.name}击败，已安全返回营地`, { monster_id: id });
      stopAdventure(world, a, 'defeated', '已返回营地并恢复 10 点生命，可自行选择休息或其他活动');
      durable = true;
    } else if (f.hp <= f.max_hp * .25 && !f.plan.danger_reported) {
      f.plan.danger_reported = true;
      announce(world, 'adventure_danger', a, `${a.name}生命不足四分之一，可以自主选择撤退、求助或继续`, { hp: f.hp });
      stopAdventure(world, a, 'needs_decision', '生命不足四分之一，当前计划已停止；在原地等待 AI 决定继续、求助或撤退');
      durable = true;
    }
  }
  // Movement is a snapshot update, not a per-step event that would wake every model.
  if (changed) world.state.room.world_revision++;
  return { changed, durable };
}
