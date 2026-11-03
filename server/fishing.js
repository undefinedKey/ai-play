import { randomUUID, randomInt } from 'node:crypto';
import { FISHING_SPOTS } from '../shared/fishing-layout.js';
import { adjustInventory, campAvailable, LIFE_RULES } from './life.js';
import { findPath, recordMovement, stopMovement } from './spatial.js';
import { spendEnergy, FATIGUE_RULES } from './fatigue.js';
import { economyBalance, recordEconomyDelta } from './economy.js';

export const FISHING_RULES = Object.freeze({ version: 1, spots: FISHING_SPOTS, max_job_seconds: 120, tool_id: 'fishing_rod', bait_id: 'fish_bait', bait_quantity: 1, tool_durability_cost: 1, catches: [{ item_id: 'pond_fish', weight: 3 }, { item_id: 'silver_fish', weight: 1 }], notice: '本人选择同图岸位并真实步行或奔跑过去；到岸才花1鱼饵、1竿耐久及等级对应体力，30秒完成才得1鱼。没有自动续钓，任何取消已花消耗不退。' });
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const failLocal = (code, message) => { throw Object.assign(new Error(message), { code }); };
const permitted = (world, a) => world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > world.now() && (a.last_contact_at ?? -45000) + 45000 > world.now();
const spotFor = id => FISHING_SPOTS.find(s => s.id === id);
const rodLevel = a => LIFE_RULES.tools.find(t => t.id === 'fishing_rod').levels.find(l => l.level === a.life?.tools?.fishing_rod?.level);
const emit = (world, a, type, extra = {}) => world.event(type, { agent_id: a.agent_id, name: a.name, scene_id: a.scene_id, ...extra }, [a.agent_id]);
export function publicFishing(a) {
  const j = a.fishing; return j ? { job_id: j.job_id, spot_id: j.spot_id, scene_id: j.scene_id, phase: j.phase, interaction_position: { ...j.interaction_position }, started_at: j.started_at, ends_at: j.ends_at, expires_at: j.expires_at } : null;
}
export function publicFishingWorld(world) {
  return { version: 1, spots: FISHING_SPOTS.map(s => ({ ...structuredClone(s), occupied_by: Object.values(world.state.agents).find(a => a.fishing?.spot_id === s.id)?.agent_id || null })) };
}
function supplies(a, fail) {
  const rod = a.life?.tools?.fishing_rod;
  if (!rod?.owned || !rod.durability || !(a.life.inventory.fishing_rod > 0)) fail('TOOL_REQUIRED', '需要自己制作且有耐久的鱼竿');
  if (!(a.life.inventory.fish_bait > 0)) fail('INSUFFICIENT_ITEMS', '需要1份鱼饵，可用干草制作');
  if (a.fatigue.energy < rodLevel(a).energy_cost) fail('FATIGUE_EXHAUSTED', '体力不足以开始本次垂钓');
  if (FISHING_RULES.catches.some(c => (a.life.inventory[c.item_id] || 0) >= Number.MAX_SAFE_INTEGER)) fail('INVENTORY_FULL', '鱼获仓库已达上限');
}
function available(world, a, spot, mode, fail) {
  if (!spot) fail('INVALID_ACTION', '请选择实际钓点spot_id');
  if (!permitted(world, a)) fail('STALE_SESSION', '当前没有活动许可');
  if (a.scene_id !== spot.scene_id || a.home_presence || a.home_travel) fail('SCENE_REQUIRED', '须在钓点所在室外场景');
  if (a.fishing || a.movement || a.activity || a.adventure?.plan || a.life?.gathering || a.survival?.travel || a.adventure?.encounter?.status === 'pending' || a.group_id || world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id)) fail('ACTIVITY_BUSY', '先自行结束当前活动、小组、游戏或行程');
  if (Object.values(world.state.agents).some(b => b.agent_id !== a.agent_id && (b.fishing?.spot_id === spot.id || b.scene_id === spot.scene_id && !b.home_presence && b.status === 'active' && distance(b.position, spot.interaction_position) < .1))) fail('FISHING_OCCUPIED', '岸位已有角色，请选另一个钓点或稍后再来');
  supplies(a, fail);
  if (mode === 'run' && a.fatigue.energy <= 0) fail('FATIGUE_EXHAUSTED', '体力不足以奔跑');
  const path = findPath(a.scene_id, a.position, spot.interaction_position);
  if (!path) fail('UNREACHABLE', '这个岸位暂不可达');
  return path;
}
export function cancelFishing(world, a, reason = 'cancelled') {
  const job = a.fishing; if (!job) return false;
  if (a.movement?.movement_id === job.movement_id) stopMovement(a, world.now());
  a.fishing = null;
  emit(world, a, 'fish_cancelled', { job_id: job.job_id, spot_id: job.spot_id, reason, text: `${a.name}结束了本次垂钓，接下来由本人决定` }); return true;
}
function begin(world, a, { audit = true } = {}) {
  const j = a.fishing, spot = spotFor(j.spot_id);
  if (!spot || distance(a.position, spot.interaction_position) > 1e-8 || a.movement) return cancelFishing(world, a, 'stopped');
  if (world.now() + spot.duration_seconds * 1000 > j.expires_at) return cancelFishing(world, a, 'insufficient_time');
  try { supplies(a, failLocal); } catch (e) { return cancelFishing(world, a, e.code); }
  const before = economyBalance(a), level = rodLevel(a);
  if (!spendEnergy(world, a, 'gather', level.energy_cost / FATIGUE_RULES.costs.gather)) return cancelFishing(world, a, 'exhausted');
  adjustInventory(a, { fish_bait: -1 }, failLocal); a.life.tools.fishing_rod.durability--;
  j.phase = 'fishing'; j.started_at = world.now(); j.ends_at = world.now() + spot.duration_seconds * 1000;
  j.movement_id = null; a.facing = spot.position.x < a.position.x ? 'west' : spot.position.x > a.position.x ? 'east' : spot.position.y < a.position.y ? 'north' : 'south';
  if (audit) recordEconomyDelta(a, before, { source_id: `${j.job_id}:bait`, reason: 'fish_bait', at: world.now(), world, countProgress: false });
  emit(world, a, 'fish_started', { ...publicFishing(a), text: `${a.name}在${spot.name}抛下鱼线，开始一次垂钓` }); return true;
}
export function performFishing(world, a, p, fail) {
  if (!p || !['start', 'cancel'].includes(p.intent) || Object.keys(p).some(k => !(p.intent === 'cancel' ? ['intent'] : ['intent', 'spot_id', 'bait_id', 'mode']).includes(k))) fail('INVALID_ACTION', '钓鱼参数无效');
  if (p.intent === 'cancel') { if (!a.fishing) fail('NO_FISHING', '当前没有垂钓'); cancelFishing(world, a); }
  else {
    if (p.bait_id !== 'fish_bait' || p.mode !== undefined && !['walk', 'run'].includes(p.mode)) fail('INVALID_ACTION', '须选择fish_bait，mode为walk/run');
    const spot = spotFor(p.spot_id), path = available(world, a, spot, p.mode, fail), now = world.now();
    recordMovement(a, path, now, p.mode);
    a.fishing = { job_id: `fish_${randomUUID()}`, spot_id: spot.id, scene_id: spot.scene_id, interaction_position: { ...spot.interaction_position }, phase: 'approaching', started_at: now, ends_at: null, expires_at: Math.min(now + 120000, a.run.expires_at), movement_id: a.movement?.movement_id || null, run_id: a.run.run_id, session_epoch: a.session_epoch, hp_at_start: a.adventure.hp, hurt_id_at_start: a.hurt?.action_id || null };
    emit(world, a, 'fish_approaching', { ...publicFishing(a), text: `${a.name}选择前往${spot.name}钓鱼` });
    if (!a.movement) begin(world, a, { audit: false });
  }
  return { fishing: publicFishing(a) };
}
export function tickFishing(world, survivalFrames = new Map()) {
  let changed = false;
  for (const a of Object.values(world.state.agents)) {
    const j = a.fishing; if (!j) continue; const now = world.now();
    const reason = !permitted(world, a) || j.run_id !== a.run?.run_id || j.session_epoch !== a.session_epoch ? 'permission_ended' : a.scene_id !== j.scene_id || a.home_presence ? 'moved' : a.adventure.hp < j.hp_at_start || a.hurt && a.hurt.action_id !== j.hurt_id_at_start || (survivalFrames.get(a.agent_id)?.stop_at ?? Infinity) <= now ? 'hurt' : a.movement && a.movement.movement_id !== j.movement_id ? 'replaced' : null;
    if (reason) { changed = cancelFishing(world, a, reason) || changed; continue; }
    if (j.phase === 'fishing' && now >= j.ends_at && j.ends_at <= j.expires_at) {
      if (distance(a.position, j.interaction_position) > 1e-8 || a.movement) { changed = cancelFishing(world, a, 'moved') || changed; continue; }
      const item_id = randomInt(4) === 0 ? 'silver_fish' : 'pond_fish', before = economyBalance(a);
      try { adjustInventory(a, { [item_id]: 1 }, failLocal); } catch { changed = cancelFishing(world, a, 'inventory_full') || changed; continue; }
      a.fishing = null; recordEconomyDelta(a, before, { source_id: `${j.job_id}:catch`, reason: 'fish_caught', at: now, world });
      emit(world, a, 'fish_finished', { job_id: j.job_id, spot_id: j.spot_id, item_id, quantity: 1, text: `${a.name}钓到了1条${item_id === 'silver_fish' ? '银鳞鱼' : '池塘鱼'}，下一步由本人决定` }); changed = true;
    } else if (now >= j.expires_at) changed = cancelFishing(world, a, 'expired') || changed;
    else if (j.phase === 'approaching' && !a.movement) changed = begin(world, a) || changed;
  }
  return changed;
}
export function fishingObservation(world, a) {
  const opportunities = [];
  if (permitted(world, a)) {
    if (a.fishing) opportunities.push({ type: 'fish', payload: { intent: 'cancel' } });
    else {
      for (const spot of FISHING_SPOTS) { try { available(world, a, spot, 'walk', failLocal); opportunities.push({ type: 'fish', payload: { intent: 'start', spot_id: spot.id, bait_id: 'fish_bait' } }); } catch { /* Only executable choices. */ } }
      const idle = !a.home_presence && !a.home_travel && !a.movement && !a.activity && !a.adventure?.plan && !a.life?.gathering && !a.survival?.travel && a.adventure?.encounter?.status !== 'pending' && !(world.state.game?.status !== 'finished' && world.state.game?.participants?.includes(a.agent_id));
      const pay = cost => Object.entries(cost).every(([id, n]) => (a.life.inventory[id] || 0) >= n);
      const add = (intent, item_id) => opportunities.push({ type: 'inventory', payload: { intent, item_id } });
      if (idle && a.fatigue.energy >= 2) {
        if (!(a.life.inventory.fish_bait > 0) && pay({ grass: 1 })) add('craft', 'fish_bait');
        try {
          campAvailable(world, a, failLocal);
          const rod = a.life.tools.fishing_rod, levels = LIFE_RULES.tools.find(t => t.id === 'fishing_rod').levels, level = rodLevel(a), next = levels.find(l => l.level === rod.level + 1);
          if (!rod.owned && pay(LIFE_RULES.recipes.find(r => r.item_id === 'fishing_rod').ingredients)) add('craft', 'fishing_rod');
          if (rod.owned && rod.durability < rod.max_durability && pay(level.repair_cost)) add('repair', 'fishing_rod');
          if (rod.owned && next && pay(next.upgrade_cost)) add('upgrade', 'fishing_rod');
        } catch { /* Camp preparation is offered only at the actual camp. */ }
      }
    }
  }
  return { ...publicFishingWorld(world), opportunities };
}
