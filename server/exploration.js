import { randomInt, randomUUID } from 'node:crypto';
import { isPositionInBounds } from './spatial.js';
import { adjustInventory } from './life.js';
import { FATIGUE_RULES, publicFatigue, spendEnergy } from './fatigue.js';
import { progressPersonalGoal } from './personal-goals.js';
import { progressCooperation } from './cooperation.js';

const choice = (choice_id, name, energy_cost = 0, items = {}, heal = 0, restore_energy = 0) => ({ choice_id, name, energy_cost, items, heal, restore_energy });
export const EXPLORATION_RULES = {
  pending_seconds: 150, discovery_cooldown_seconds: 300,
  templates: [
    { template_id: 'supply_cache', name: '遗落补给箱', zone_ids: ['forest', 'ruins'], choices: [choice('wood', '取出两份木材', 4, { wood: 2 }), choice('ore', '取出一份矿石', 4, { ore: 1 }), choice('decline', '离开')] },
    { template_id: 'wild_garden', name: '野生菜圃', zone_ids: ['forest'], choices: [choice('turnip', '采摘两个萝卜', 3, { turnip: 2 }), choice('seed', '收集一份小麦种子', 2, { wheat_seed: 1 }), choice('decline', '离开')] },
    { template_id: 'spring', name: '林间泉眼', zone_ids: ['forest', 'ruins'], choices: [choice('heal', '恢复最多12生命', 0, {}, 12), choice('refresh', '恢复最多15体力', 0, {}, 0, 15), choice('decline', '离开')] },
  ],
  description: '森林/遗迹探索抵达后可能发现事件。等待选择最多150秒且有固定保护，每个角色跨区域共享300秒发现冷却，拒绝也不重抽。等待允许聊天、补给和目标管理；先选择或拒绝再移动/工作，stop或retreat可明确中断。暂停、失联与重启中断，不自动领奖或撤退。',
};
const states = ['pending', 'resolved', 'declined', 'expired', 'interrupted'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const templateFor = id => EXPLORATION_RULES.templates.find(template => template.template_id === id);
export function initializeExploration(a) {
  const f = a.adventure;
  f.discovery_ready_at = time(f.discovery_ready_at) ? f.discovery_ready_at : 0;
  f.discovery_sequence = Number.isSafeInteger(f.discovery_sequence) && f.discovery_sequence >= 0 ? f.discovery_sequence : randomInt(0, 3);
  const e = f.encounter;
  if (!e || typeof e.event_id !== 'string' || !templateFor(e.template_id)?.zone_ids.includes(e.zone_id) || !isPositionInBounds(e.position) ||
    !states.includes(e.status) || !time(e.found_at) || !time(e.expires_at)) f.encounter = null;
}
export function publicExplorationResult(result) {
  if (!result || typeof result !== 'object') return null;
  return { items: Object.fromEntries(['wood', 'ore', 'turnip', 'wheat_seed'].filter(id => Number.isSafeInteger(result.items?.[id]) && result.items[id] > 0).map(id => [id, result.items[id]])),
    hp: Number.isFinite(result.hp) ? Math.max(0, result.hp) : 0, energy: Number.isFinite(result.energy) ? result.energy : 0,
    text: typeof result.text === 'string' ? [...result.text].slice(0, 180).join('') : '' };
}
export function publicEncounter(a) {
  const e = a.adventure?.encounter, template = templateFor(e?.template_id);
  if (!e || !template || !states.includes(e.status)) return null;
  return { event_id: e.event_id, template_id: e.template_id, zone_id: e.zone_id, position: { x: e.position.x, y: e.position.y }, status: e.status,
    found_at: e.found_at, expires_at: e.expires_at, choices: structuredClone(template.choices),
    selected_choice_id: template.choices.some(c => c.choice_id === e.selected_choice_id) ? e.selected_choice_id : null,
    resolved_at: time(e.resolved_at) ? e.resolved_at : null, public_result: publicExplorationResult(e.public_result) };
}
export function encounterPending(a, now) { return a.adventure?.encounter?.status === 'pending' && a.adventure.encounter.expires_at > now; }
function announce(world, a, type, text) {
  world.event(type, { agent_id: a.agent_id, name: a.name, text, ...publicEncounter(a) }, [...new Set([a.agent_id, ...world.activeIds()])]);
}
export function endEncounter(world, a, status = 'interrupted') {
  const e = a.adventure?.encounter;
  if (!e || e.status !== 'pending') return false;
  e.status = e.expires_at <= world.now() ? 'expired' : status; e.resolved_at = world.now(); e.public_result = null;
  announce(world, a, 'exploration_ended', `${a.name}的探索发现${e.status === 'expired' ? '已过期' : '已中断'}，没有领取结果`);
  return true;
}
export function tickEncounter(world, a) {
  const e = a.adventure?.encounter;
  if (!e || e.status !== 'pending') return false;
  if (e.expires_at <= world.now()) return endEncounter(world, a, 'expired');
  if (a.status !== 'active' || a.run?.status !== 'active' || a.run.expires_at <= world.now() || a.run.run_id !== e.run_id || a.session_epoch !== e.session_epoch ||
    a.position.x !== e.position.x || a.position.y !== e.position.y) return endEncounter(world, a);
  return false;
}
export function discoverEncounter(world, a, zone_id) {
  const f = a.adventure;
  if (zone_id === 'camp' || encounterPending(a, world.now()) || f.discovery_ready_at > world.now()) return false;
  const templates = EXPLORATION_RULES.templates.filter(template => template.zone_ids.includes(zone_id));
  if (!templates.length) return false;
  const template = templates[f.discovery_sequence % templates.length];
  f.discovery_sequence = (f.discovery_sequence + 1) % 1000000;
  f.discovery_ready_at = world.now() + EXPLORATION_RULES.discovery_cooldown_seconds * 1000;
  f.encounter = { event_id: `encounter_${randomUUID()}`, template_id: template.template_id, zone_id, position: { ...a.position }, status: 'pending',
    found_at: world.now(), expires_at: world.now() + EXPLORATION_RULES.pending_seconds * 1000, selected_choice_id: null, resolved_at: null, public_result: null,
    run_id: a.run.run_id, session_epoch: a.session_epoch };
  announce(world, a, 'exploration_found', `${a.name}发现了${template.name}，等待本人选择或离开`); return true;
}
export function performAdventureEvent(world, a, p, fail) {
  if (Object.keys(p).some(key => !['event_id', 'choice_id'].includes(key)) || typeof p.event_id !== 'string' || typeof p.choice_id !== 'string') fail('INVALID_ACTION', '探索选择只接受 event_id 和 choice_id');
  const e = a.adventure?.encounter;
  if (!e || e.event_id !== p.event_id) fail('EVENT_UNAVAILABLE', '这个发现不属于当前角色或已经被替换');
  if (e.expires_at <= world.now() || e.status === 'expired') fail('EVENT_EXPIRED', '探索选择已过期，请重新观察');
  if (e.status !== 'pending' || e.run_id !== a.run.run_id || e.session_epoch !== a.session_epoch) fail('EVENT_UNAVAILABLE', '这个发现已经结束或控制会话改变');
  if (a.position.x !== e.position.x || a.position.y !== e.position.y) fail('EVENT_POSITION', '当前位置已不符合这次发现');
  const c = templateFor(e.template_id).choices.find(c => c.choice_id === p.choice_id);
  if (!c) fail('INVALID_CHOICE', '请选择这次发现给出的 choice_id');
  if (c.heal > 0 && a.adventure.hp >= a.adventure.max_hp) fail('FULL_HEALTH', '生命已满，这个选项没有效果');
  if (c.restore_energy > 0 && publicFatigue(a).energy >= FATIGUE_RULES.max_energy) fail('FULL_ENERGY', '体力已满，这个选项没有效果');
  const beforeHp = a.adventure.hp, beforeEnergy = publicFatigue(a).energy;
  if (!spendEnergy(world, a, 'exploration', c.energy_cost)) fail('FATIGUE_EXHAUSTED', '体力不足以处理这个选项，可以选择离开');
  adjustInventory(a, c.items, fail);
  if (c.heal) a.adventure.hp = Math.min(a.adventure.max_hp, a.adventure.hp + c.heal);
  if (c.restore_energy) {
    a.fatigue.energy = Math.min(FATIGUE_RULES.max_energy, a.fatigue.energy + c.restore_energy); a.fatigue.updated_at = world.now();
    if (a.fatigue.energy >= FATIGUE_RULES.rearm_at) a.fatigue.tired_notified = false;
  }
  e.status = c.choice_id === 'decline' ? 'declined' : 'resolved'; e.selected_choice_id = c.choice_id; e.resolved_at = world.now();
  e.public_result = { items: { ...c.items }, hp: a.adventure.hp - beforeHp, energy: Math.round((publicFatigue(a).energy - beforeEnergy) * 10000) / 10000,
    text: c.choice_id === 'decline' ? '选择离开，没有消耗或奖励' : `选择了「${c.name}」` };
  announce(world, a, c.choice_id === 'decline' ? 'exploration_ended' : 'exploration_resolved', `${a.name}${e.public_result.text}`);
  if (c.choice_id !== 'decline') progressPersonalGoal(world, a, { kind: 'resolve_exploration', target_id: e.zone_id, source_id: e.event_id });
  if (c.choice_id !== 'decline') progressCooperation(world, a, { kind: 'exploration', zone_id: e.zone_id, source_id: e.event_id, found_at: e.found_at });
  return { encounter: publicEncounter(a) };
}
