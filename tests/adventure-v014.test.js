import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { combatStats } from '../server/combat.js';
import { initializeLife } from '../server/life.js';
import { progressPersonalGoal } from '../server/personal-goals.js';

function fixture(t) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }), people = [];
  t.after(() => world.close());
  const make = (name = '原AI', owner_id = 'owner-a') => {
    const a = world.createAgent({ name, owner_id }), controller = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, goal: 'PRIVATE_OWNER_GOAL' });
    const auth = world.authenticate(controller.token), o = world.callTool(auth, 'join_world');
    const p = { id: a.agent_id, controller, auth, session: { run_id: o.run_id, session_epoch: o.session_epoch } }; people.push(p);
    world.agent(p.id).position = { x: 11, y: 8 }; return p;
  };
  const raw = p => world.agent(p.id), observe = p => world.callTool(p.auth, 'observe', p.session);
  const req = (p, type, payload = {}) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload = {}) => world.callTool(p.auth, 'act', req(p, type, payload));
  const advance = (ms, connected = people) => {
    const end = now + ms;
    while (now < end) { now = Math.min(end, now + 1000); world.tick(); for (const p of connected) if (raw(p).status === 'active') observe(p); }
  };
  const discover = (p, sequence = 0, zone_id = 'forest') => {
    raw(p).adventure.discovery_sequence = sequence;
    raw(p).position = zone_id === 'forest' ? { x: 4, y: 11 } : { x: 19, y: 7 };
    ok(act(p, 'adventure_plan', { intent: 'explore', zone_id })); advance(1000);
    return observe(p).self.adventure.encounter;
  };
  const goal = (p, kind, target_id, target_count = 1, more = {}) => ok(act(p, 'personal_goal', { intent: 'set', kind, target_id, target_count, ...more })).personal_goal;
  return { world, make, raw, observe, req, act, advance, discover, goal, now: () => now, jump: ms => { now += ms; world.tick(); } };
}
const ok = r => { assert.equal(r.status, 'applied', JSON.stringify(r.error)); return r; };
const rejected = (r, code) => { assert.equal(r.status, 'rejected'); assert.equal(r.error.code, code); };
const resources = a => structuredClone({ life: a.life, fatigue: a.fatigue, adventure: a.adventure, personal_goal: a.personal_goal });

test('v0.14目录、固定选择、策略装备与目标边界实际公开；新角色不自动接目标', t => {
  const f = fixture(t), p = f.make(), rules = f.world.getRules(), publicState = spectatorSnapshot(f.world);
  assert.equal(rules.max_capabilities, 16); assert.equal(rules.rules_version, '0.15.0-cooperation');
  assert.ok(['adventure_event', 'personal_goal'].every(x => rules.allowed_actions.includes(x)));
  assert.equal(rules.adventure.exploration.pending_seconds, 150); assert.equal(rules.adventure.exploration.discovery_cooldown_seconds, 300);
  assert.deepEqual(publicState.adventure.exploration, rules.adventure.exploration);
  assert.equal(rules.adventure.exploration.templates.length, 3); assert.ok(rules.adventure.exploration.templates.every(t => t.choices.at(-1).choice_id === 'decline'));
  assert.deepEqual(rules.personal_goals.kinds.map(k => k.kind), ['collect_item', 'cook_item', 'resolve_exploration', 'defeat_monster']);
  assert.equal(f.observe(p).self.personal_goal, null); assert.equal(f.observe(p).self.adventure.encounter, null);
  assert.deepEqual(rules.life.strategy_equipment.item_ids, ['hunter_bow', 'heavy_hammer', 'heavy_armor']);
});

for (const [sequence, template, choice, delta] of [
  [0, 'supply_cache', 'wood', { wood: 2 }], [0, 'supply_cache', 'ore', { ore: 1 }],
  [1, 'wild_garden', 'turnip', { turnip: 2 }], [1, 'wild_garden', 'seed', { wheat_seed: 1 }],
  [2, 'spring', 'heal', {}], [2, 'spring', 'refresh', {}], [0, 'supply_cache', 'decline', {}],
]) test(`真实探索 ${template}/${choice} 有明确效果，原动作重试只结算一次`, t => {
  const f = fixture(t), p = f.make(); f.raw(p).adventure.hp = 30; f.raw(p).fatigue.energy = 70;
  const e = f.discover(p, sequence); assert.equal(e.template_id, template); assert.equal(e.status, 'pending');
  assert.equal(e.expires_at - e.found_at, 150000); assert.equal(f.raw(p).adventure.discovery_ready_at - e.found_at, 300000);
  assert.equal(f.raw(p).adventure.plan, null);
  const before = structuredClone(f.raw(p)), request = f.req(p, 'adventure_event', { event_id: e.event_id, choice_id: choice });
  const result = ok(f.world.callTool(p.auth, 'act', request)); assert.deepEqual(f.world.callTool(p.auth, 'act', request), result);
  const a = f.raw(p), cost = e.choices.find(c => c.choice_id === choice).energy_cost;
  assert.deepEqual(a.adventure.encounter.public_result.items, delta);
  for (const [id, quantity] of Object.entries(delta)) assert.equal(a.life.inventory[id], (before.life.inventory[id] || 0) + quantity);
  assert.equal(a.fatigue.energy, 70 - cost + (choice === 'refresh' ? 15 : 0));
  assert.equal(a.adventure.hp, choice === 'heal' ? 40 : 30);
  assert.equal(a.adventure.encounter.status, choice === 'decline' ? 'declined' : 'resolved');
  assert.equal(a.adventure.encounter.public_result.hp, choice === 'heal' ? 10 : 0);
  assert.equal(a.life.ledger.entries.filter(entry => entry.source_id === request.action_id).length, Object.keys(delta).length ? 1 : 0);
  assert.equal(f.world.state.events.filter(event => event.type === 'exploration_resolved').length, choice === 'decline' ? 0 : 1);
});

test('待选期间旧移动/战斗/群组/劳作均拒绝，聊天补给等待不续保护或冷却', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.inventory.wheat_bread = 1; f.raw(p).fatigue.energy = 50;
  const e = f.discover(p), ready = f.raw(p).adventure.discovery_ready_at;
  for (const [type, payload] of [['move', { x: 4, y: 12 }], ['adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }],
    ['adventure_plan', { intent: 'explore', zone_id: 'ruins' }], ['adventure_plan', { intent: 'rest' }], ['farm', { intent: 'till', plot_id: 'plot_1' }],
    ['inventory', { intent: 'equip', item_id: 'wooden_sword' }], ['gather', { intent: 'start', resource_id: 'wood' }],
    ['trade', { intent: 'buy', item_id: 'wood', quantity: 1 }], ['create_group', {}], ['leave_group', {}],
    ['respond_invite', { invite_id: 'old', accept: true }], ['propose_game', {}], ['start_activity', { activity_id: 'relax' }]]) {
    const before = resources(f.raw(p)); rejected(f.act(p, type, payload), 'ENCOUNTER_PENDING'); assert.deepEqual(resources(f.raw(p)), before, type);
  }
  ok(f.act(p, 'say', { channel: 'nearby', text: '我先看看这个发现' })); ok(f.act(p, 'wait')); ok(f.act(p, 'inventory', { intent: 'use', item_id: 'wheat_bread' }));
  f.goal(p, 'collect_item', 'wood', 2); f.world.callTool(p.auth, 'join_world'); f.advance(90000);
  assert.equal(f.raw(p).adventure.encounter.expires_at, e.expires_at); assert.equal(f.raw(p).adventure.discovery_ready_at, ready);
  assert.equal(f.raw(p).adventure.hp, 40); assert.equal(f.raw(p).adventure.encounter.status, 'pending');
  assert.ok(!f.world.state.events.some(event => event.type === 'adventure_combat' && event.payload.agent_id === p.id));
});

test('150秒等待保护准时结束，过期不领奖且旧选择不能复活发现', t => {
  const f = fixture(t), p = f.make(), e = f.discover(p), before = structuredClone(f.raw(p).life.inventory);
  f.advance(149000); assert.equal(f.raw(p).adventure.encounter.status, 'pending'); assert.equal(f.raw(p).adventure.hp, 40);
  f.advance(1000); assert.equal(f.raw(p).adventure.encounter.status, 'expired');
  f.advance(3000); assert.ok(f.raw(p).adventure.hp < 40);
  rejected(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id: 'wood' }), 'EVENT_EXPIRED');
  assert.deepEqual(f.raw(p).life.inventory, before); assert.equal(f.raw(p).adventure.discovery_ready_at, e.found_at + 300000);
  assert.equal(f.world.state.events.filter(event => event.type === 'exploration_ended' && event.payload.status === 'expired').length, 1);
});

test('满生命/满体力、费用不足、库存溢出、错误参数与他人事件ID均失败原子', t => {
  const f = fixture(t), p = f.make(), other = f.make('乙'); let e = f.discover(p, 2);
  for (const choice_id of ['heal', 'refresh']) {
    const before = resources(f.raw(p)); rejected(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id }), choice_id === 'heal' ? 'FULL_HEALTH' : 'FULL_ENERGY'); assert.deepEqual(resources(f.raw(p)), before);
  }
  rejected(f.act(other, 'adventure_event', { event_id: e.event_id, choice_id: 'heal' }), 'EVENT_UNAVAILABLE');
  for (const payload of [{ event_id: e.event_id, choice_id: 'heal', energy: 999 }, { event_id: e.event_id }, { event_id: e.event_id, choice_id: 'unknown' }]) {
    const before = resources(f.raw(p)); rejected(f.act(p, 'adventure_event', payload), payload.choice_id === 'unknown' ? 'INVALID_CHOICE' : 'INVALID_ACTION'); assert.deepEqual(resources(f.raw(p)), before);
  }
  ok(f.act(p, 'adventure_plan', { intent: 'stop' })); f.raw(p).adventure.discovery_ready_at = 0; e = f.discover(p, 0);
  f.raw(p).fatigue.energy = 3; const low = resources(f.raw(p)); rejected(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id: 'wood' }), 'FATIGUE_EXHAUSTED'); assert.deepEqual(resources(f.raw(p)), low);
  f.raw(p).fatigue.energy = 100; f.raw(p).life.inventory.wood = Number.MAX_SAFE_INTEGER;
  const full = resources(f.raw(p)); rejected(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id: 'wood' }), 'INVENTORY_FULL'); assert.deepEqual(resources(f.raw(p)), full);
});

test('stop/retreat可明确中断；重复探索或换区域不重抽、不刷新全局发现冷却', t => {
  const f = fixture(t), p = f.make(), e = f.discover(p), ready = f.raw(p).adventure.discovery_ready_at;
  rejected(f.act(p, 'adventure_plan', { intent: 'retreat', zone_id: 'forest' }), 'INVALID_ACTION'); assert.equal(f.raw(p).adventure.encounter.status, 'pending');
  ok(f.act(p, 'adventure_plan', { intent: 'stop' })); assert.equal(f.raw(p).adventure.encounter.status, 'interrupted');
  f.raw(p).position = { x: 19, y: 7 }; ok(f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'ruins' })); f.advance(1000);
  assert.equal(f.raw(p).adventure.encounter.event_id, e.event_id); assert.equal(f.raw(p).adventure.discovery_ready_at, ready);
  ok(f.act(p, 'adventure_plan', { intent: 'retreat' })); f.advance(20000); assert.deepEqual(f.raw(p).position, { x: 11, y: 8 });
  f.advance(ready - f.now()); const next = f.discover(p, 0, 'ruins'); assert.notEqual(next.event_id, e.event_id);
  const inventory = structuredClone(f.raw(p).life.inventory); ok(f.act(p, 'adventure_plan', { intent: 'retreat' }));
  assert.equal(f.raw(p).adventure.encounter.status, 'interrupted'); assert.deepEqual(f.raw(p).life.inventory, inventory);
});

for (const operation of ['pause', 'recall', 'transfer', 'expiry', 'offline', 'room']) test(`权限边界 ${operation} 同时中断发现与要求目标复核`, t => {
  const f = fixture(t), p = f.make(), goal = f.goal(p, 'collect_item', 'wood', 3), e = f.discover(p), before = structuredClone(f.raw(p).life.inventory);
  if (operation === 'room') f.world.ownerRoom('pause');
  else if (operation === 'expiry') { f.raw(p).run.expires_at = f.now(); f.world.tick(); }
  else if (operation === 'offline') f.jump(45000);
  else f.world.ownerControl(p.id, operation);
  assert.equal(f.raw(p).adventure.encounter.status, 'interrupted'); assert.equal(f.raw(p).adventure.in_field, false);
  assert.equal(f.raw(p).personal_goal.status, 'needs_review'); assert.equal(f.raw(p).personal_goal.expires_at, goal.expires_at);
  assert.equal(f.raw(p).adventure.discovery_ready_at, e.found_at + 300000); assert.deepEqual(f.raw(p).life.inventory, before);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...p.session, action_id: 'stale', type: 'adventure_event', payload: { event_id: e.event_id, choice_id: 'wood' } }));
});

test('目标只统计设定后的真实获得；失败、重试、旧回执不推进，新目标不继承仓库余额', t => {
  const f = fixture(t), p = f.make(); f.raw(p).adventure.gold = 20;
  const initial = f.goal(p, 'collect_item', 'wood', 3); assert.equal(initial.progress, 0);
  const request = f.req(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 2 }), result = ok(f.world.callTool(p.auth, 'act', request));
  assert.equal(f.raw(p).personal_goal.progress, 2); assert.deepEqual(f.world.callTool(p.auth, 'act', request), result); assert.equal(f.raw(p).personal_goal.progress, 2);
  rejected(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 10 }), 'INSUFFICIENT_GOLD'); assert.equal(f.raw(p).personal_goal.progress, 2);
  const revised = f.goal(p, 'collect_item', 'wood', 1); assert.notEqual(revised.goal_id, initial.goal_id); assert.equal(revised.progress, 0);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), result); assert.equal(f.raw(p).personal_goal.progress, 0);
  ok(f.act(p, 'gather', { intent: 'start', resource_id: 'wood' })); f.advance(12000);
  assert.equal(f.raw(p).personal_goal.status, 'completed'); assert.equal(f.raw(p).personal_goal.progress, 1);
  assert.equal(f.raw(p).adventure.plan, null); assert.equal(f.raw(p).adventure.gold, 12);
  const done = structuredClone(f.raw(p).personal_goal); f.advance(900000); assert.deepEqual(f.raw(p).personal_goal, done);
});

test('制作和非拒绝探索分别推进对应目标，没有目标奖品或自动后续行动', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.inventory.wheat = 4;
  f.goal(p, 'cook_item', 'wheat_bread', 2);
  ok(f.act(p, 'inventory', { intent: 'craft', item_id: 'wheat_bread' })); assert.equal(f.raw(p).personal_goal.progress, 1);
  ok(f.act(p, 'inventory', { intent: 'craft', item_id: 'wheat_bread' })); assert.equal(f.raw(p).personal_goal.status, 'completed');
  assert.equal(f.raw(p).life.inventory.wheat_bread, 2); assert.equal(f.raw(p).adventure.gold, 0);
  f.goal(p, 'resolve_exploration', 'forest'); let e = f.discover(p);
  ok(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id: 'decline' })); assert.equal(f.raw(p).personal_goal.progress, 0);
  f.raw(p).adventure.discovery_ready_at = 0; e = f.discover(p);
  ok(f.act(p, 'adventure_event', { event_id: e.event_id, choice_id: 'ore' })); assert.equal(f.raw(p).personal_goal.status, 'completed');
  assert.equal(f.raw(p).adventure.plan, null); assert.equal(f.raw(p).life.inventory.ore, 1);
});

test('公开目标严格校验；公开标题与主人要求分离，修改/取消要求当前ID且截止不顺延', t => {
  const f = fixture(t), p = f.make(); const base = { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 1 };
  for (const extra of [{ target_count: 0 }, { target_count: 11 }, { target_count: 1.2 }, { duration_seconds: 299 }, { duration_seconds: 1801 },
    { target_id: 'wooden_sword' }, { kind: 'auto_hunt' }, { title: '你'.repeat(61) }, { owner_id: 'other' }, { goal_id: 'fake' }, { progress: 10 }]) {
    rejected(f.act(p, 'personal_goal', { ...base, ...extra }), 'INVALID_ACTION'); assert.equal(f.raw(p).personal_goal, null);
  }
  const first = f.goal(p, 'collect_item', 'wood', 1, { duration_seconds: 300, title: '公开标题' }); assert.equal(first.expires_at, f.now() + 300000);
  rejected(f.act(p, 'personal_goal', { intent: 'confirm', goal_id: first.goal_id }), 'GOAL_REVIEW_REQUIRED');
  f.world.ownerControl(p.id, 'pause'); assert.equal(f.raw(p).personal_goal.status, 'needs_review');
  f.advance(10000, []); f.world.ownerControl(p.id, 'resume'); const joined = f.world.callTool(p.auth, 'join_world'); p.session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const held = f.raw(p).life.inventory.wood; f.raw(p).adventure.gold = 20;
  ok(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 1 })); assert.equal(f.raw(p).personal_goal.progress, 0);
  ok(f.act(p, 'personal_goal', { intent: 'confirm', goal_id: first.goal_id })); assert.equal(f.raw(p).personal_goal.expires_at, first.expires_at);
  ok(f.act(p, 'trade', { intent: 'buy', item_id: 'wood', quantity: 1 })); assert.equal(f.raw(p).personal_goal.status, 'completed'); assert.equal(f.raw(p).life.inventory.wood, held + 2);
  const next = f.goal(p, 'collect_item', 'ore'); rejected(f.act(p, 'personal_goal', { intent: 'cancel', goal_id: first.goal_id }), 'GOAL_UNAVAILABLE');
  ok(f.act(p, 'personal_goal', { intent: 'cancel', goal_id: next.goal_id })); assert.equal(f.raw(p).personal_goal.status, 'cancelled');
  f.raw(p).run.expires_at = f.now() + 20000; const clipped = f.goal(p, 'collect_item', 'ore'); assert.equal(clipped.expires_at, f.raw(p).run.expires_at);
  f.advance(20000); assert.equal(f.raw(p).personal_goal.status, 'expired');
});

test('单目标进度来源有界且去重，不读取旧账本补历史', t => {
  const f = fixture(t), p = f.make(); f.goal(p, 'collect_item', 'wood', 10);
  const a = f.raw(p);
  for (let i = 0; i < 10; i++) {
    progressPersonalGoal(f.world, a, { kind: 'collect_item', target_id: 'wood', source_id: `real_${i}` });
    progressPersonalGoal(f.world, a, { kind: 'collect_item', target_id: 'wood', source_id: `real_${i}` });
  }
  assert.equal(a.personal_goal.progress, 10); assert.equal(a.personal_goal.status, 'completed'); assert.ok(a.personal_goal.sources.length <= 16);
  assert.equal(a.personal_goal.history, undefined); assert.equal(a.life.ledger.entries.length, 1);
});

test('新装备真实配方/有效属性统一，旧装备默认不变，重型护甲两种移动都多耗体力', t => {
  const f = fixture(t), p = f.make(); f.raw(p).life.inventory = { wood: 20, ore: 20 };
  for (const item_id of ['hunter_bow', 'heavy_hammer', 'heavy_armor']) ok(f.act(p, 'inventory', { intent: 'craft', item_id }));
  assert.equal(f.raw(p).life.inventory.wood, 10); assert.equal(f.raw(p).life.inventory.ore, 6);
  ok(f.act(p, 'inventory', { intent: 'equip', item_id: 'hunter_bow' }));
  assert.equal(combatStats(f.raw(p)).range, 3); assert.equal(combatStats(f.raw(p)).attack_interval_ms, 2000); assert.equal(combatStats(f.raw(p)).attack_energy, 2);
  ok(f.act(p, 'inventory', { intent: 'equip', item_id: 'heavy_armor' })); assert.equal(combatStats(f.raw(p)).defense, 5); assert.equal(combatStats(f.raw(p)).attack_interval_ms, 3000);
  let energy = f.raw(p).fatigue.energy; ok(f.act(p, 'move', { x: 14, y: 8 })); assert.equal(f.raw(p).fatigue.energy, Math.round((energy - .9) * 10000) / 10000);
  energy = f.raw(p).fatigue.energy; ok(f.act(p, 'adventure_plan', { intent: 'retreat' })); f.advance(3000); assert.equal(f.raw(p).fatigue.energy, Math.round((energy - .9) * 10000) / 10000);
  assert.equal(f.observe(p).self.life.stats.move_energy_per_tile, .3);
});

test('策略候选可展示低攻击远程方案与重甲代价，仍保留六槽生活/探索/狩猎', t => {
  const f = fixture(t), p = f.make(); Object.assign(f.raw(p).life.inventory, { iron_sword: 1, iron_armor: 1, hunter_bow: 1, heavy_hammer: 1, heavy_armor: 1 });
  for (const item_id of ['iron_sword', 'iron_armor']) ok(f.act(p, 'inventory', { intent: 'equip', item_id }));
  let observation = f.observe(p);
  assert.ok(observation.opportunities.some(o => o.action.payload.item_id === 'hunter_bow'), '铁剑攻击高不应遮蔽已持有猎弓的射程和体力策略');
  assert.ok(observation.opportunities.some(o => o.action.type === 'farm')); assert.ok(observation.opportunities.some(o => o.action.payload.intent === 'explore'));
  assert.ok(observation.opportunities.some(o => o.action.payload.intent === 'hunt')); assert.ok(observation.opportunities.length <= 6);
  for (const plot of f.raw(p).life.plots) Object.assign(plot, { crop_id: 'turnip', tilled: true, planted_at: f.now(), watered_at: f.now(), ready_at: f.now() + 120000 });
  observation = f.observe(p); const saved = structuredClone(f.world.state);
  assert.ok(observation.opportunities.some(o => o.action.payload.item_id === 'heavy_armor' && /每格耗0.3/.test(o.reason)));
  for (const candidate of observation.opportunities) {
    f.world.state = structuredClone(saved);
    ok(f.world.callTool(p.auth, 'act', { ...p.session, action_id: observation.next_action_id, ...candidate.action }));
  }
  f.world.state = saved;
});

test('待选事件候选仅给真实可用选项、食物与撤退，费用不足仍可离开', t => {
  const f = fixture(t), p = f.make(), e = f.discover(p); f.raw(p).fatigue.energy = 0;
  let o = f.observe(p); assert.deepEqual(o.opportunities.map(option => option.action.payload.choice_id || option.action.payload.intent), ['decline', 'retreat']);
  f.raw(p).fatigue.energy = 40; f.raw(p).life.inventory.wheat_bread = 1; o = f.observe(p); const saved = structuredClone(f.world.state);
  assert.ok(o.opportunities.some(option => option.action.type === 'inventory')); assert.ok(o.opportunities.every(option => ['adventure_event', 'adventure_plan', 'inventory'].includes(option.action.type)));
  for (const candidate of o.opportunities) {
    f.world.state = structuredClone(saved); ok(f.world.callTool(p.auth, 'act', { ...p.session, action_id: o.next_action_id, ...candidate.action }));
  }
  f.world.state = saved; assert.equal(f.raw(p).adventure.encounter.event_id, e.event_id);
});

test('诊断两个入口一致接受15项新能力与16上限，拒绝17项且不续租', t => {
  const f = fixture(t), p = f.make(), capabilities = Array.from({ length: 16 }, (_, i) => `cap_${String.fromCharCode(97 + i)}`), contact = f.raw(p).last_contact_at;
  f.world.callTool(p.auth, 'report_status', { ...p.session, capabilities });
  assert.deepEqual(f.raw(p).diagnostics.capabilities, capabilities);
  const health = { world: 'connected', host: 'ready', model: 'idle', waiting_reason: 'idle' };
  f.world.callTool(p.auth, 'report_connection', { run_id: p.session.run_id, capabilities, health });
  assert.equal(f.raw(p).last_contact_at, contact);
  for (const [tool, args] of [['report_status', p.session], ['report_connection', { run_id: p.session.run_id, health }]])
    assert.throws(() => f.world.callTool(p.auth, tool, { ...args, capabilities: [...capabilities, 'overflow'] }), { code: 'INVALID_ACTION' });
});

test('三格弓手实际伤害计入奖励和击杀目标，不因旧两格分奖限制漏奖', t => {
  const f = fixture(t), p = f.make(), other = f.make('旁观同伴');
  f.raw(p).life.inventory.hunter_bow = 1; ok(f.act(p, 'inventory', { intent: 'equip', item_id: 'hunter_bow' })); f.goal(p, 'defeat_monster', 'forest_slime');
  f.goal(other, 'defeat_monster', 'forest_slime'); f.raw(p).position = { x: 6, y: 11 };
  const m = f.world.state.adventure.monsters[0]; m.hp = 7;
  ok(f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: m.monster_id })); f.advance(1000);
  assert.equal(m.status, 'respawning'); assert.equal(f.raw(p).adventure.kills, 1); assert.equal(f.raw(p).adventure.gold, 6); assert.equal(f.raw(p).adventure.xp, 12);
  assert.equal(f.raw(p).fatigue.energy, 98); assert.equal(f.raw(p).personal_goal.status, 'completed'); assert.equal(f.raw(other).personal_goal.progress, 0);
  assert.equal(f.raw(p).position.x, 6); assert.equal(f.raw(p).life.inventory.wood, 4);
});

test('重锤/护甲实际攻击间隔、耗能与伤害；重发hunt和迟到tick不能补击', t => {
  const f = fixture(t), p = f.make(); Object.assign(f.raw(p).life.inventory, { heavy_hammer: 1, heavy_armor: 1 });
  for (const item_id of ['heavy_hammer', 'heavy_armor']) ok(f.act(p, 'inventory', { intent: 'equip', item_id }));
  const a = f.raw(p); a.position = { x: 19, y: 7 };
  ok(f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: 'ruins_guardian' })); f.advance(1000);
  assert.equal(f.raw(p).fatigue.energy, 95); assert.equal(f.raw(p).adventure.hp, 37);
  const firstAt = f.now(), deadline = f.raw(p).adventure.next_attack_at; assert.equal(deadline, firstAt + 3000);
  for (let i = 0; i < 2; i++) { ok(f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: 'ruins_guardian' })); f.advance(1000); assert.equal(f.raw(p).adventure.next_attack_at, deadline); }
  const attacks = () => f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent');
  assert.equal(attacks().length, 1); assert.equal(attacks()[0].payload.damage, 14); f.advance(1000); assert.equal(attacks().length, 2);
  f.jump(10000); assert.equal(attacks().length, 3); assert.equal(f.raw(p).fatigue.energy, 85);
  assert.equal(f.raw(p).adventure.next_attack_at, f.now() + 3000);
});

test('有效每击成本决定耗尽边界；低体力伤害只折算一次；营地不能远程射击', t => {
  const f = fixture(t), p = f.make(); Object.assign(f.raw(p).life.inventory, { heavy_hammer: 1, hunter_bow: 1 });
  ok(f.act(p, 'inventory', { intent: 'equip', item_id: 'heavy_hammer' })); f.raw(p).position = { x: 19, y: 7 };
  ok(f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: 'ruins_guardian' })); f.raw(p).fatigue.energy = 30; f.advance(1000);
  assert.equal(f.raw(p).fatigue.energy, 25); assert.equal(f.world.state.adventure.monsters[2].hp, 60);
  f.raw(p).fatigue.energy = 4.99; f.advance(1000); assert.equal(f.raw(p).adventure.plan, null); assert.equal(f.raw(p).adventure.last_result.kind, 'exhausted');
  assert.equal(f.raw(p).fatigue.energy, 4.99);
  f.raw(p).position = { x: 11, y: 8 }; f.raw(p).adventure.in_field = false; ok(f.act(p, 'inventory', { intent: 'equip', item_id: 'hunter_bow' }));
  f.raw(p).fatigue.energy = 100; const m = f.world.state.adventure.monsters[0]; m.position = { x: 14, y: 8 }; m.home_position = { ...m.position };
  ok(f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: m.monster_id })); f.advance(2000); assert.equal(m.hp, 18); assert.deepEqual(f.raw(p).position, { x: 13, y: 8 });
});

test('公开投影只含显式目标和事件实际结果，不含来源会话/私有库存/主人目标', t => {
  const f = fixture(t), p = f.make(), other = f.make('乙', 'owner-b'); f.goal(p, 'collect_item', 'wood', 3, { title: '我想准备木材' });
  const e = f.discover(p); f.raw(p).personal_goal.secret = 'PRIVATE_GOAL_INTERNAL'; f.raw(p).adventure.encounter.secret = 'PRIVATE_EVENT_INTERNAL';
  f.raw(p).adventure.next_attack_at = 123456; f.raw(p).life.inventory.ore = 987654;
  const snap = spectatorSnapshot(f.world), publicA = snap.agents.find(a => a.agent_id === p.id);
  assert.equal(publicA.personal_goal.title, '我想准备木材'); assert.equal(publicA.adventure.encounter.event_id, e.event_id);
  const ownerOther = f.world.snapshotFor({ id: 'owner-b' }).agents.find(a => a.agent_id === p.id);
  for (const a of [publicA, ownerOther]) {
    for (const key of ['run_id', 'session_epoch', 'sources', 'secret']) { assert.equal(a.personal_goal[key], undefined); assert.equal(a.adventure.encounter[key], undefined); }
    assert.equal(a.adventure.next_attack_at, undefined); assert.equal(a.life.inventory, undefined); assert.equal(a.life.ledger, undefined);
  }
  assert.ok(!/PRIVATE_|987654|"sources"|"next_attack_at"/.test(JSON.stringify(snap)));
  assert.equal(snap.events.find(event => event.type === 'exploration_found').payload.expires_at, e.expires_at);
  assert.equal(snap.events.find(event => event.type === 'personal_goal_set').payload.target_count, 3);
});

test('重启保留冷却/装备/预算/目标截止；中断待选发现，旧目标需明确复核，旧存档兼容', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-v014-')), dbPath = join(directory, 'world.sqlite'); let now = 1000000, world;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); const a = world.createAgent({ name: '持久角色' }), c = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 19, duration_minutes: 60 });
    const auth = world.authenticate(c.token), joinWorld = () => world.callTool(auth, 'join_world'); let o = joinWorld();
    const act = (type, payload) => { o = world.callTool(auth, 'observe', { run_id: o.run_id, session_epoch: o.session_epoch }); return world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }); };
    const goal = ok(act('personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 3 })).personal_goal;
    const raw = world.agent(a.agent_id); raw.position = { x: 4, y: 11 }; raw.adventure.discovery_sequence = 0; raw.adventure.next_attack_at = now + 15000;
    raw.life.inventory.hunter_bow = 1; raw.life.equipment.weapon = 'hunter_bow'; raw.diagnostics.calls_used = 7;
    ok(act('adventure_plan', { intent: 'explore', zone_id: 'forest' })); now += 1000; world.tick();
    const ready = raw.adventure.discovery_ready_at, eventId = raw.adventure.encounter.event_id, runId = raw.run.run_id, appearance = structuredClone(raw.appearance);
    world.close(); world = null; now += 1000; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const restored = world.agent(a.agent_id); assert.equal(restored.adventure.encounter.status, 'interrupted'); assert.equal(restored.adventure.encounter.event_id, eventId);
    assert.equal(restored.adventure.next_attack_at, 1015000); assert.equal(restored.adventure.discovery_ready_at, ready);
    assert.equal(restored.personal_goal.status, 'needs_review'); assert.equal(restored.personal_goal.expires_at, goal.expires_at);
    assert.equal(restored.diagnostics.calls_used, 7); assert.equal(restored.run.max_calls, 19); assert.equal(restored.run.run_id, runId);
    assert.deepEqual(restored.appearance, appearance); assert.equal(restored.life.equipment.weapon, 'hunter_bow');
    o = joinWorld(); assert.equal(o.self.personal_goal.status, 'needs_review');
    ok(act('personal_goal', { intent: 'confirm', goal_id: goal.goal_id })); assert.equal(restored.personal_goal.status, 'active'); assert.equal(restored.personal_goal.expires_at, goal.expires_at);
    const before = structuredClone(restored.life); initializeLife(restored); assert.deepEqual(restored.life, before);
    delete restored.personal_goal; delete restored.adventure.encounter; delete restored.adventure.next_attack_at; delete restored.adventure.discovery_ready_at;
    world.close(); world = null; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    assert.equal(world.agent(a.agent_id).personal_goal, null); assert.equal(world.agent(a.agent_id).adventure.encounter, null); assert.equal(world.agent(a.agent_id).adventure.next_attack_at, 0);
    assert.equal(world.agent(a.agent_id).life.equipment.weapon, 'hunter_bow');
  } finally { if (world) world.close(); rmSync(directory, { recursive: true, force: true }); }
});
