import { homeLightUntil, cancelHomeTravel, cancelHomeUse, detachHomes } from './homes.js';
import { randomUUID } from 'node:crypto';
import { SURVIVAL_RULES, siteDefinition, fireDefinition, fireFuel, publicFire, publicSurvival, publicSurvivor, initializeSurvivor, survivalLight, survivalPhaseAt, survivalRound } from './survival-state.js';
import { adjustInventory, cancelGather } from './life.js';
import { spendEnergy } from './fatigue.js';
import { findPath, recordMovement, stopMovement } from './spatial.js';
import { stopAdventure, leaveAdventureField, changeScene } from './adventure.js';
import { samplePath, pathLength } from '../shared/motion.js';
import { combatStats } from './combat.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const quantity = (a, id) => a.life?.inventory?.[id] || 0;
function notify(world, a, kind, text, severity = 'notice', deadline = null) {
  world.event('survival_warning', { agent_id: a.agent_id, kind, severity, deadline, text }, [a.agent_id]);
}
function announce(world, a, type, fields, text) {
  world.event(type, { agent_id: a.agent_id, name: a.name, ...fields, text }, world.activeIds());
}
function idleForWork(world, a, fail) {
  if (a.movement || a.survival?.travel) fail('MOVEMENT_BUSY', '先等待到达，或明确取消当前移动');
  if (a.life?.gathering) fail('GATHER_BUSY', '请先结束或取消本次采集');
  if (a.adventure?.plan) fail('ADVENTURE_BUSY', '请先停止当前冒险计划，再选择生存动作');
  if (a.activity || world.state.game?.status !== 'finished' && world.state.game?.participants.includes(a.agent_id)) fail('ACTIVITY_BUSY', '请先结束当前活动');
}
function exactKeys(p, allowed, fail) {
  if (Object.keys(p).some(k => !allowed.includes(k))) fail('INVALID_ACTION', '此生存动作包含不支持的参数');
}
function needNear(a, site, fail, radius = 1) {
  if (a.scene_id !== site.scene_id) fail('SCENE_REQUIRED', '宿营地在另一个场景，需先通过入口旅行');
  if (distance(a.position, site.position) > radius + 1e-8) fail('TOO_FAR', '请先到达宿营地的真实交互位置', { site_id: site.id, interaction_position: site.interaction_position });
}
function cost(world, a, ingredients, reason, sourceId, fail) {
  for (const [id, n] of Object.entries(ingredients)) if (quantity(a, id) < n) fail('INSUFFICIENT_ITEMS', '材料不足，请观察自己的仓库和实际资源点', { item_id: id, required: n });
  if (!spendEnergy(world, a, 'craft')) fail('FATIGUE_EXHAUSTED', '体力不足以完成本次工作');
  adjustInventory(a, Object.fromEntries(Object.entries(ingredients).map(([id, n]) => [id, -n])), fail);
}
export function cancelSurvivalTravel(world, a, reason = 'cancelled') {
  if (!a.survival?.travel) return false;
  const job = a.survival.travel; a.survival.travel = null;
  if (a.movement?.movement_id === job.movement_id) stopMovement(a, world.now());
  world.event('survival_travel_cancelled', { agent_id: a.agent_id, site_id: job.site_id, reason, text: `${a.name}的宿营地行程已结束（${reason}），下一步由本人决定` }, [a.agent_id]);
  return true;
}
export function haltSurvival(world, a, reason = 'interrupted') {
  cancelSurvivalTravel(world, a, reason);
  if (!a.survival) return;
  a.survival.last_at = Math.max(world.now(), a.survival.last_at);
  if (a.survival.torch) a.survival.torch.lit = false;
  a.survival.darkness_seconds = 0; a.survival.dark_hits = 0; a.survival.dark_notified = false;
}
export function performSurvival(world, a, p, fail, actionId) {
  if (!a.survival) initializeSurvivor(a, world.now());
  const now = world.now(), s = a.survival;
  if (p.intent === 'cancel') { exactKeys(p, ['intent'], fail); cancelSurvivalTravel(world, a); return { survival: publicSurvivor(world, a) }; }
  if (p.intent === 'approach') {
    exactKeys(p, ['intent', 'site_id', 'mode'], fail); idleForWork(world, a, fail);
    if (p.mode !== undefined && !['walk', 'run'].includes(p.mode)) fail('INVALID_ACTION', '移动模式只支持walk或run');
    const site = siteDefinition(p.site_id); if (!site) fail('INVALID_ACTION', '未知宿营地');
    if (site.scene_id !== a.scene_id) fail('SCENE_REQUIRED', '先通过入口进入对应场景');
    const path = findPath(a.scene_id, a.position, site.interaction_position);
    if (!path) fail('NO_PATH', '无法从当前位置到达宿营地');
    if (distance(a.position, site.interaction_position) < 1e-8) return { arrived: true, site_id: site.id };
    recordMovement(a, path, now, p.mode || 'walk');
    if (!a.movement) fail('NO_PATH', '没有有效行程');
    s.travel = { site_id: site.id, started_at: now, expires_at: now + SURVIVAL_RULES.max_travel_seconds * 1000,
      run_id: a.run.run_id, session_epoch: a.session_epoch, movement_id: a.movement.movement_id, hp_at_start: a.adventure.hp };
    announce(world, a, 'survival_travel_started', { site_id: site.id, expires_at: s.travel.expires_at }, `${a.name}选择前往${site.name}；到达后再决定是否建火`);
  } else if (p.intent === 'build') {
    exactKeys(p, ['intent', 'site_id', 'kind'], fail); idleForWork(world, a, fail);
    const site = siteDefinition(p.site_id), def = fireDefinition(p.kind);
    if (!site || !def) fail('INVALID_ACTION', '请选择真实宿营地与campfire/firepit');
    needNear(a, site, fail);
    if (Object.values(world.state.survival.fires).some(f => f.site_id === site.id)) fail('SITE_OCCUPIED', '此处已有火塘，可共同添柴而不必重复建造');
    const id = `fire_${randomUUID()}`;
    cost(world, a, def.ingredients, 'survival_build', actionId, fail);
    const fire = { fire_id: id, site_id: site.id, kind: def.id, owner_agent_id: a.agent_id, fuel_seconds: def.initial_fuel_seconds, lit: true, updated_at: now, created_at: now };
    world.state.survival.fires[id] = fire;
    announce(world, a, 'fire_built', { site_id: site.id, fire_id: id, kind: def.id, fuel_seconds: fire.fuel_seconds }, `${a.name}在${site.name}建起${def.name}，燃料可供${fire.fuel_seconds}秒`);
  } else if (p.intent === 'fuel' || p.intent === 'extinguish') {
    exactKeys(p, p.intent === 'fuel' ? ['intent', 'fire_id', 'item_id', 'quantity'] : ['intent', 'fire_id'], fail); idleForWork(world, a, fail);
    const fire = world.state.survival.fires[p.fire_id]; if (!fire) fail('FIRE_NOT_FOUND', '这座火塘不存在');
    const site = siteDefinition(fire.site_id), def = fireDefinition(fire.kind); needNear(a, site, fail);
    fire.fuel_seconds = fireFuel(fire, now); fire.updated_at = now;
    if (p.intent === 'extinguish') {
      if (fire.owner_agent_id !== a.agent_id) fail('NOT_FIRE_OWNER', '只有建造者可以熄灭这座共享火塘');
      if (!fire.lit) fail('FIRE_UNLIT', '这座火塘已经熄灭');
      fire.lit = false;
      announce(world, a, 'fire_extinguished', { fire_id: fire.fire_id, site_id: site.id, fuel_seconds: fire.fuel_seconds }, `${a.name}熄灭了自己的火塘，保留剩余燃料`);
    } else {
      const seconds = SURVIVAL_RULES.fuels[p.item_id];
      if (!seconds || !Number.isSafeInteger(p.quantity) || p.quantity < 1 || p.quantity > 5) fail('INVALID_ACTION', '添柴需真实燃料与1至5的整数数量');
      if (fire.fuel_seconds + seconds * p.quantity > def.max_fuel_seconds + 1e-8) fail('FIRE_FUEL_FULL', '加入后超过火塘燃料容量，未消耗材料');
      cost(world, a, { [p.item_id]: p.quantity }, 'survival_fuel', actionId, fail);
      fire.fuel_seconds = survivalRound(fire.fuel_seconds + seconds * p.quantity); fire.lit = true;
      if (fire.fuel_seconds > 60) fire.low_notified = false;
      announce(world, a, 'fire_fueled', { fire_id: fire.fire_id, site_id: site.id, fuel_seconds: fire.fuel_seconds }, `${a.name}给共享火塘添了燃料，可继续燃烧约${Math.ceil(fire.fuel_seconds)}秒`);
    }
  } else if (p.intent === 'torch') {
    exactKeys(p, ['intent', 'lit'], fail);
    if (typeof p.lit !== 'boolean') fail('INVALID_ACTION', '火把lit必须为布尔值');
    if (p.lit && (!s.torch || s.torch.fuel_seconds <= 0)) {
      adjustInventory(a, { torch: -1 }, fail);
      s.torch = { fuel_seconds: SURVIVAL_RULES.torch.fuel_seconds, lit: false, updated_at: now };
    }
    if (!s.torch || s.torch.lit === p.lit) fail('INVALID_ACTION', '火把状态没有变化');
    s.torch.lit = p.lit; s.torch.updated_at = now;
    announce(world, a, 'torch_changed', { lit: s.torch.lit, fuel_seconds: s.torch.fuel_seconds }, `${a.name}${p.lit ? '点亮' : '熄灭'}了自己的火把`);
  } else fail('INVALID_ACTION', '未知生存动作');
  return { survival: publicSurvivor(world, a), world_survival: publicSurvival(world) };
}

/** Capture active authorization and physical path before other tick handlers mutate them. */
export function captureSurvival(world) {
  const now = world.now();
  return new Map(Object.values(world.state.agents).map(a => {
    if (!a.survival) initializeSurvivor(a, now);
    const active = world.state.room.status === 'active' && a.status === 'active' && a.run?.status === 'active';
    const until = active ? Math.min(now, a.run.expires_at, (a.last_contact_at ?? -45000) + 45000) : a.survival.last_at;
    const m = a.movement;
    const maxDistance = m ? Math.min(pathLength(m.path), (m.settled_distance || 0) + (m.mode === 'run' ? a.fatigue.energy / (combatStats(a).move_energy_per_tile * 2) : Infinity)) : 0;
    const moveUntil = m ? Math.min(until, m.ends_at, a.adventure?.plan?.expires_at ?? Infinity, a.life?.gathering?.expires_at ?? Infinity, a.survival?.travel?.expires_at ?? Infinity, a.home_travel?.expires_at ?? Infinity) : until;
    const frame = { from: a.survival.last_at, until: Math.max(a.survival.last_at, until), scene_id: a.scene_id, position: { ...a.position }, maxDistance, moveUntil,
      satiety: a.survival.satiety, movement: a.movement ? { ...a.movement, path: a.movement.path.map(p => ({ ...p })) } : null, torch: a.survival.torch ? { ...a.survival.torch } : null,
      home_presence: a.home_presence ? { home_id: a.home_presence.home_id, entered_at: a.home_presence.entered_at } : null,
      home_until: homeLightUntil(world, a), stop_at: Infinity, recovery_windows: [] };
    let darkness = a.survival.darkness_seconds, starvation = a.survival.starvation_seconds, satiety = frame.satiety;
    for (let t = frame.from; t < frame.until;) {
      const slice = survivalSlice(world, a, frame, t); if (!(slice.dt > 0)) break;
      const allowed = slice.lit && satiety > 0, last = frame.recovery_windows.at(-1);
      if (last?.allowed === allowed) last.until = slice.end; else frame.recovery_windows.push({ from: t, until: slice.end, allowed });
      const before = satiety; satiety = survivalRound(Math.max(0, satiety - SURVIVAL_RULES.satiety_per_second * slice.dt));
      darkness = slice.lit ? 0 : survivalRound(darkness + slice.dt);
      starvation = satiety > 0 ? 0 : survivalRound(starvation + (before > 0 ? Math.max(0, slice.dt - before / SURVIVAL_RULES.satiety_per_second) : slice.dt));
      const darkHit = !slice.lit && Math.floor((darkness - SURVIVAL_RULES.darkness_grace_seconds) / SURVIVAL_RULES.darkness_interval_seconds) > a.survival.dark_hits;
      const hungerHit = Math.floor(starvation / SURVIVAL_RULES.starvation_interval_seconds) > a.survival.hunger_hits;
      if ((darkHit || hungerHit) && slice.end >= a.survival.protected_until && frame.stop_at === Infinity) {
        frame.stop_at = slice.end; frame.moveUntil = Math.min(frame.moveUntil, slice.end);
      }
      t = slice.end;
    }
    return [a.agent_id, frame];
  }));
}
function survivalSlice(world, a, interval, t) {
  const phase = survivalPhaseAt(world.state, t), boundaries = [interval.until, t + 100, phase.next_at];
  const zeroAt = interval.from + interval.satiety / SURVIVAL_RULES.satiety_per_second * 1000;
  if (interval.home_until > t) boundaries.push(interval.home_until);
  if (interval.home_presence?.entered_at > t) boundaries.push(interval.home_presence.entered_at);
  if (zeroAt > t) boundaries.push(zeroAt);
  if (interval.torch?.lit) { const until = interval.from + interval.torch.fuel_seconds * 1000; if (until > t) boundaries.push(until); }
  for (const fire of Object.values(world.state.survival?.fires || {})) {
    const until = fire.updated_at + fire.fuel_seconds * 1000;
    if (fire.lit && until > t) boundaries.push(until);
  }
  const end = Math.min(...boundaries), dt = (end - t) / 1000;
  let position = interval.position;
  if (interval.movement) {
    const m = interval.movement, travelled = Math.max(m.settled_distance || 0, Math.min(interval.maxDistance, (Math.min(t, interval.moveUntil) - m.started_at) * m.speed / 1000));
    position = samplePath(m.path, travelled).position;
  }
  const torchFuel = interval.torch?.lit ? Math.max(0, interval.torch.fuel_seconds - (t - interval.from) / 1000) : 0;
  const home_presence = interval.home_presence && t >= interval.home_presence.entered_at && t < interval.home_until ? interval.home_presence : null;
  const lit = survivalLight(world, { ...a, home_presence, scene_id: interval.scene_id, survival: { ...a.survival, torch: interval.torch } }, t, position, torchFuel).lit;
  return { end, dt, lit };
}
function environmentHit(world, a, kind, damage) {
  if (a.survival.protected_until > world.now() || a.adventure.hp <= 0) return false;
  a.adventure.hp = Math.max(0, a.adventure.hp - damage);
  a.hurt = { action_id: `environment_${randomUUID()}`, started_at: world.now(), ends_at: world.now() + 360, damage };
  cancelGather(world, a, 'hurt'); cancelSurvivalTravel(world, a, 'hurt');
  cancelHomeTravel(world, a, 'hurt'); cancelHomeUse(world, a, 'hurt'); if (a.home_presence) stopMovement(a.home_presence, world.now());
  stopAdventure(world, a, 'needs_decision', '环境风险中断了当前计划，请自主选择应对方式');
  stopMovement(a, world.now()); world.finishActivity(a, { cancelled: true, interrupted: true });
  announce(world, a, 'survival_damage', { kind, damage, hp: a.adventure.hp }, `${a.name}受到${kind === 'darkness' ? '黑暗' : '饥饿'}影响，损失${damage}点生命`);
  if (a.adventure.hp === 0) {
    detachHomes(world, a, 'rescued');
    changeScene(world, a, 'plaza', { x: 11, y: 8 }, 'rescue'); a.adventure.hp = 10; leaveAdventureField(world, a);
    a.survival.protected_until = world.now() + SURVIVAL_RULES.rescue_protection_seconds * 1000;
    a.survival.darkness_seconds = 0; a.survival.dark_hits = 0; a.survival.starvation_seconds = 0; a.survival.hunger_hits = 0;
    announce(world, a, 'survival_rescued', { kind, protected_until: a.survival.protected_until }, `${a.name}倒地后被救回营地，恢复10点生命并获得120秒反应保护，仍需自己选择补给和光源`);
  }
  return true;
}
export function tickSurvival(world, captured = captureSurvival(world)) {
  let changed = false, durable = false;
  const now = world.now();
  // Personal simulation is bounded by the original online lease; no offline catch-up damage.
  for (const a of Object.values(world.state.agents)) {
    const s = a.survival, interval = captured.get(a.agent_id);
    if (!interval) continue;
    const was = JSON.stringify([s.satiety, s.darkness_seconds, s.torch?.fuel_seconds, s.travel]);
    const travel = s.travel;
    if (travel) {
      const permitted = a.status === 'active' && a.run?.status === 'active' && travel.run_id === a.run.run_id && travel.session_epoch === a.session_epoch;
      const site = siteDefinition(travel.site_id);
      if (!permitted || now >= travel.expires_at || a.scene_id !== site?.scene_id || a.adventure.hp < travel.hp_at_start || a.movement && a.movement.movement_id !== travel.movement_id) durable = cancelSurvivalTravel(world, a, 'interrupted') || durable;
      else if (!a.movement) {
        if (distance(a.position, site.interaction_position) < 1e-8) {
          s.travel = null; world.event('survival_arrived', { agent_id: a.agent_id, site_id: site.id, text: `${a.name}到达${site.name}，尚未建火，下一步由本人决定` }, [a.agent_id]); durable = true;
        } else durable = cancelSurvivalTravel(world, a, 'stopped') || durable;
      }
    }
    // Integrate at the physical tick resolution and cut at every light/phase expiry.
    for (let t = interval.from; t < interval.until;) {
      const { end, dt, lit } = survivalSlice(world, a, interval, t);
      if (!(dt > 0)) break;
      const before = s.satiety; s.satiety = survivalRound(Math.max(0, before - SURVIVAL_RULES.satiety_per_second * dt));
      if (!lit) {
        s.darkness_seconds = survivalRound(s.darkness_seconds + dt);
        if (!s.dark_notified) { s.dark_notified = true; notify(world, a, 'darkness', '你处于夜晚无光处，90秒警示后会受伤；可自主点火、举火把或走向同场景现有火光', 'danger', end + Math.max(0, 90 - s.darkness_seconds) * 1000); durable = true; }
        const hits = Math.max(0, Math.floor((s.darkness_seconds - SURVIVAL_RULES.darkness_grace_seconds) / SURVIVAL_RULES.darkness_interval_seconds));
        if (hits > s.dark_hits) { const count = hits - s.dark_hits; s.dark_hits = hits; durable = environmentHit(world, a, 'darkness', count * SURVIVAL_RULES.darkness_damage) || durable; }
      } else { s.darkness_seconds = 0; s.dark_hits = 0; s.dark_notified = false; }
      if (s.satiety === 0) {
        const zeroSeconds = before > 0 ? Math.max(0, dt - before / SURVIVAL_RULES.satiety_per_second) : dt;
        s.starvation_seconds = survivalRound(s.starvation_seconds + zeroSeconds);
        const hits = Math.floor(s.starvation_seconds / SURVIVAL_RULES.starvation_interval_seconds);
        if (hits > s.hunger_hits) { const count = hits - s.hunger_hits; s.hunger_hits = hits; durable = environmentHit(world, a, 'starving', count * SURVIVAL_RULES.starvation_damage) || durable; }
      } else { s.starvation_seconds = 0; s.hunger_hits = 0; }
      t = end;
    }
    if (interval.torch?.lit && s.torch) {
      s.torch.fuel_seconds = survivalRound(Math.max(0, interval.torch.fuel_seconds - (interval.until - interval.from) / 1000));
      if (!s.torch.fuel_seconds) { s.torch.lit = false; if (interval.torch.fuel_seconds > 0) { notify(world, a, 'low_fuel', '你的火把已经烧尽，是否制作新火把或寻找火塘由你决定', 'danger'); durable = true; } }
      s.torch.updated_at = now;
    }
    s.last_at = Math.max(s.last_at, now);
    const active = a.status === 'active' && a.run?.status === 'active' && a.run.expires_at > now && now - a.last_contact_at < 45000;
    if (active) {
      if (s.satiety <= 30 && !s.hungry_notified) { s.hungry_notified = true; notify(world, a, s.satiety <= 0 ? 'starving' : 'hungry', `当前饱食${Math.ceil(s.satiety)}/100，归零会持续损失生命；可自行进食、采集或烹饪`, 'danger'); durable = true; }
      if (s.satiety <= 0 && !s.starving_notified) { s.starving_notified = true; notify(world, a, 'starving', '饱食度已经归零，正在挨饿；请根据实际食物和周围资源决定进食或求助', 'danger'); durable = true; }
      const phase = survivalPhaseAt(world.state, now), nightAt = world.state.day_cycle.epoch_at + (phase.day_index - 1) * 600000 + 360000;
      if (['day', 'dusk'].includes(phase.phase) && nightAt - now <= 180000 && s.warning_day !== phase.day_index) {
        s.warning_day = phase.day_index; notify(world, a, 'prepare_night', `距离夜晚约${Math.ceil((nightAt - now) / 1000)}秒；请观察光源、燃料与食物，自主选择准备或继续活动`, 'notice', nightAt); durable = true;
      }
    }
    if (was !== JSON.stringify([s.satiety, s.darkness_seconds, s.torch?.fuel_seconds, s.travel])) changed = true;
  }
  for (const fire of Object.values(world.state.survival?.fires || {})) {
    const fuel = fireFuel(fire, now), lit = fire.lit;
    if (fuel !== fire.fuel_seconds) { fire.fuel_seconds = fuel; changed = true; }
    fire.updated_at = Math.max(fire.updated_at, now);
    if (lit && fuel > 0 && fuel <= 30 && !fire.low_notified) {
      fire.low_notified = true; const site = siteDefinition(fire.site_id), def = fireDefinition(fire.kind);
      for (const a of Object.values(world.state.agents)) if (a.status === 'active' && a.scene_id === site.scene_id && Math.hypot(a.position.x - site.position.x, a.position.y - site.position.y) <= def.light_radius)
        notify(world, a, 'low_fuel', `${site.name}的火还可燃烧约${Math.ceil(fuel)}秒，是否添柴或离开由你决定`, 'notice', now + fuel * 1000);
      durable = true;
    }
    if (lit && fuel <= 0) {
      fire.lit = false; const site = siteDefinition(fire.site_id);
      world.event('fire_extinguished', { fire_id: fire.fire_id, site_id: site.id, scene_id: site.scene_id, fuel_seconds: 0, text: `${site.name}的火塘燃料耗尽，未自动添柴` }, world.activeIds()); durable = true;
    }
  }
  if (changed) world.state.room.world_revision++;
  return { changed, durable };
}
export function survivalOpportunities(world, a) {
  const current = publicSurvivor(world, a), sceneSites = SURVIVAL_RULES.sites.filter(s => s.scene_id === a.scene_id);
  if (!current) return [];
  const opportunities = [];
  // Keep the legacy flat fields for older hosts, and publish the same executable
  // envelope as every other opportunity. Reading this catalog never acts.
  const add = (id, name, description, payload) => opportunities.push({ id, type: 'survival', ...payload,
    name, description, label: name, reason: description, action: { type: 'survival', payload } });
  const fire = publicSurvival(world).fires.find(f => f.scene_id === a.scene_id && f.fuel_seconds < f.max_fuel_seconds - 60);
  if (fire && quantity(a, 'wood') > 0) add(`fuel_${fire.fire_id}`, '为共享火塘添柴', '需要真实到达火塘附近，由本人决定', { intent: 'fuel', fire_id: fire.fire_id, item_id: 'wood', quantity: 1 });
  if (!current.light.lit || ['dusk', 'night'].includes(survivalPhaseAt(world.state, world.now()).phase)) {
    for (const site of sceneSites.slice(0, 2)) add(`camp_${site.id}`, `前往${site.name}`, '只到达，不自动建造、添柴或休息', { intent: 'approach', site_id: site.id });
  }
  return opportunities;
}
