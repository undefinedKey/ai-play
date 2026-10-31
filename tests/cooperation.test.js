import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { publicCooperation, publicCooperations } from '../server/cooperation.js';

function fixture(t, persisted = false) {
  let now = 1000000;
  const dir = persisted ? mkdtempSync(join(tmpdir(), 'plaza-coop-')) : null;
  let world = new World({ dbPath: dir ? join(dir, 'world.sqlite') : ':memory:', now: () => now, actionIntervalMs: 0 });
  const people = [];
  t.after(() => { world.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const raw = p => world.agent(p.id);
  const make = (name = `AI ${people.length}`, owner_id = `owner_${people.length}`) => {
    const a = world.createAgent({ name, owner_id }), c = world.createController(a.agent_id);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, max_calls: 100, duration_minutes: 60, goal: 'PRIVATE_OWNER_GOAL' });
    const p = { id: a.agent_id, c, auth: world.authenticate(c.token) };
    const o = world.callTool(p.auth, 'join_world'); p.session = { run_id: o.run_id, session_epoch: o.session_epoch };
    raw(p).scene_id = 'plaza'; raw(p).position = { x: 11, y: 8 }; people.push(p); return p;
  };
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const coop = (p, intent, payload = {}) => act(p, 'cooperation', { intent, ...payload });
  const advance = (ms, heartbeat = true) => {
    const end = now + ms;
    while (now < end) {
      const step = Object.values(world.state.agents).some(a => a.adventure?.plan || a.movement || a.action?.outcome === null) ? 100 : 1000;
      now = Math.min(end, now + step); world.tick();
      if (heartbeat) for (const p of people) if (raw(p).status === 'active') observe(p);
    }
  };
  const form = (a, b, template_id = 'camp_meal', role_id = template_id === 'camp_meal' ? 'supplier' : 'scout') => {
    const p = ok(coop(a, 'propose', { template_id, target_agent_id: b.id, role_id })).cooperation;
    const role = template_id === 'camp_meal' ? role_id === 'supplier' ? 'cook' : 'supplier' : role_id === 'scout' ? 'guard' : 'scout';
    return ok(coop(b, 'respond', { cooperation_id: p.cooperation_id, revision: p.revision, accept: true, role_id: role })).cooperation;
  };
  const project = p => world.state.cooperations[p.cooperation_id];
  const params = p => ({ cooperation_id: p.cooperation_id, revision: project(p).revision });
  const resume = p => { world.ownerControl(p.id, 'resume', { controller_id: p.c.controller_id, max_calls: 100, duration_minutes: 60 }); const o = world.callTool(p.auth, 'join_world'); p.session = { run_id: o.run_id, session_epoch: o.session_epoch }; };
  const reconnect = p => { const o = world.callTool(p.auth, 'join_world'); p.session = { run_id: o.run_id, session_epoch: o.session_epoch }; };
  const restart = () => { world.close(); now += 1000; world = new World({ dbPath: join(dir, 'world.sqlite'), now: () => now, actionIntervalMs: 0 }); };
  return { get world() { return world; }, make, raw, observe, request, act, coop, advance, form, project, params, resume, reconnect, restart, now: () => now };
}
const ok = r => { assert.equal(r.status, 'applied', JSON.stringify(r.error)); return r; };
const reject = (r, code) => { assert.equal(r.status, 'rejected', JSON.stringify(r)); if (code) assert.equal(r.error.code, code); };
const balances = (f, ...ps) => ps.map(p => structuredClone({ life: f.raw(p).life, energy: f.raw(p).fatigue.energy, goal: f.raw(p).personal_goal, run: f.raw(p).run }));

test('共同备餐完整物资依赖：双私账、实际厨师目标、精确体力与未知结果重试', t => {
  const f = fixture(t), a = f.make(), b = f.make();
  f.raw(a).life.inventory.turnip = 4; f.raw(b).fatigue.energy = 50;
  ok(f.act(b, 'personal_goal', { intent: 'set', kind: 'cook_item', target_id: 'turnip_soup', target_count: 2 }));
  const before = balances(f, a, b), p = f.form(a, b);
  assert.deepEqual(balances(f, a, b), before, 'acceptance spends nothing and starts nothing');
  reject(f.coop(b, 'cook', f.params(p)), 'COOPERATION_MATERIALS');
  const contribution = f.request(a, 'cooperation', { intent: 'contribute', ...f.params(p) });
  const contributed = ok(f.world.callTool(a.auth, 'act', contribution));
  assert.deepEqual(f.world.callTool(a.auth, 'act', contribution), contributed);
  assert.deepEqual(f.world.callTool(a.auth, 'get_action_result', { action_id: contribution.action_id }), contributed);
  assert.equal(f.raw(a).life.inventory.turnip, 0); assert.equal(f.project(p).escrow.turnip, 4);
  reject(f.coop(a, 'contribute', f.params(p)), 'COOPERATION_CONTRIBUTED');
  const request = f.request(b, 'cooperation', { intent: 'cook', ...f.params(p) }), result = ok(f.world.callTool(b.auth, 'act', request));
  assert.deepEqual(f.world.callTool(b.auth, 'act', request), result);
  assert.equal(f.raw(a).life.inventory.turnip_soup, 1); assert.equal(f.raw(b).life.inventory.turnip_soup, 1);
  assert.equal(f.raw(b).fatigue.energy, 46); assert.equal(f.raw(b).personal_goal.progress, 2);
  assert.equal(f.project(p).status, 'completed'); assert.equal(f.project(p).escrow.turnip, 0);
  for (const member of [a, b]) {
    const rows = f.raw(member).life.ledger.entries.filter(e => e.source_id === request.action_id);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].items, { turnip_soup: 1 });
    assert.equal(f.raw(member).run.max_calls, before[member === a ? 0 : 1].run.max_calls);
  }
  assert.deepEqual(f.project(p).public_result.items_by_agent, { [a.id]: { turnip_soup: 1 }, [b.id]: { turnip_soup: 1 } });
});

test('交菜与料理失败原子：非法角色/私有注入/缺菜/低体力/任一仓库满/同伴不在营地', t => {
  const f = fixture(t), a = f.make(), b = f.make(), outsider = f.make(), p = f.form(a, b);
  reject(f.coop(outsider, 'contribute', f.params(p)), 'NOT_AUTHORIZED');
  reject(f.coop(a, 'contribute', { ...f.params(p), quantity: 0 }), 'INVALID_ACTION');
  const original = balances(f, a, b); reject(f.coop(a, 'contribute', f.params(p)), 'INSUFFICIENT_ITEMS'); assert.deepEqual(balances(f, a, b), original);
  f.raw(a).life.inventory.turnip = 4; ok(f.coop(a, 'contribute', f.params(p)));
  for (const [setup, code] of [[() => { f.raw(b).fatigue.energy = 3; }, 'FATIGUE_EXHAUSTED'],
    [() => { f.raw(b).fatigue.energy = 50; f.raw(a).life.inventory.turnip_soup = Number.MAX_SAFE_INTEGER; }, 'INVENTORY_FULL'],
    [() => { f.raw(a).life.inventory.turnip_soup = 0; f.raw(a).scene_id = 'adventure'; f.raw(a).position = { x: 0, y: 0 }; }, 'NOT_AT_CAMP']]) {
    setup(); const before = balances(f, a, b), project = structuredClone(f.project(p));
    reject(f.coop(b, 'cook', f.params(p)), code); assert.deepEqual(balances(f, a, b), before); assert.deepEqual(f.project(p), project);
  }
});

test('拒绝、沉默、撤回不同结果；定向/距离/次数/频率守卫；接受不强制入群', t => {
  const f = fixture(t), a = f.make(), b = f.make(), c = f.make(), d = f.make();
  const p = ok(f.coop(a, 'propose', { template_id: 'camp_meal', target_agent_id: b.id, role_id: 'supplier' })).cooperation;
  assert.equal(f.observe(b).cooperation, null); assert.equal(f.observe(b).cooperation_invitations.length, 1);
  reject(f.coop(c, 'respond', { ...f.params(p), accept: true, role_id: 'cook' }), 'NOT_AUTHORIZED');
  reject(f.coop(b, 'respond', { ...f.params(p), accept: false, role_id: 'cook' }), 'INVALID_ACTION');
  ok(f.coop(b, 'respond', { ...f.params(p), accept: false })); assert.equal(f.project(p).end_reason, 'not_formed');
  reject(f.coop(a, 'propose', { template_id: 'camp_meal', target_agent_id: b.id, role_id: 'supplier' }), 'COOPERATION_COOLDOWN');
  const second = ok(f.coop(c, 'propose', { template_id: 'camp_meal', target_agent_id: b.id, role_id: 'cook' })).cooperation;
  const third = ok(f.coop(d, 'propose', { template_id: 'scout_and_guard', target_agent_id: b.id, role_id: 'guard' })).cooperation;
  assert.equal(f.observe(b).cooperation_invitations.length, 2);
  ok(f.coop(b, 'respond', { ...f.params(second), accept: true, role_id: 'supplier' }));
  assert.equal(f.project(third).status, 'ended'); assert.equal(f.project(third).end_reason, 'not_formed'); assert.equal(f.raw(b).group_id, null);
  ok(f.coop(b, 'leave', { cooperation_id: second.cooperation_id })); f.advance(60001);
  const silent = ok(f.coop(a, 'propose', { template_id: 'camp_meal', target_agent_id: b.id, role_id: 'supplier' })).cooperation;
  f.advance(150001); assert.equal(f.project(silent).status, 'ended');
  assert.equal(f.world.state.events.filter(e => e.type === 'cooperation_response' && e.payload.cooperation_id === silent.cooperation_id).length, 0);
});

test('合作结束退款不刷采集目标；容量极限不阻止退出，待退保留并幂等领取', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).life.inventory.turnip = 4;
  ok(f.act(a, 'personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'turnip', target_count: 4 }));
  const p = f.form(a, b); ok(f.coop(a, 'contribute', f.params(p)));
  ok(f.coop(b, 'leave', { cooperation_id: p.cooperation_id }));
  assert.equal(f.raw(a).life.inventory.turnip, 4); assert.equal(f.raw(a).personal_goal.progress, 0);
  assert.equal(f.raw(a).life.ledger.entries.filter(e => e.reason === 'cooperation_return').length, 1);
  f.advance(60001); const q = f.form(a, b); ok(f.coop(a, 'contribute', f.params(q))); f.raw(a).life.inventory.turnip = Number.MAX_SAFE_INTEGER;
  ok(f.coop(a, 'leave', { cooperation_id: q.cooperation_id }));
  assert.deepEqual(f.observe(a).cooperation_return, { cooperation_id: q.cooperation_id, item_id: 'turnip', quantity: 4 });
  assert.equal(f.observe(b).cooperation_return, null); reject(f.coop(b, 'claim_return', { cooperation_id: q.cooperation_id }), 'COOPERATION_RETURN');
  reject(f.coop(a, 'claim_return', { cooperation_id: q.cooperation_id }), 'INVENTORY_FULL');
  f.raw(a).life.inventory.turnip -= 4;
  const request = f.request(a, 'cooperation', { intent: 'claim_return', cooperation_id: q.cooperation_id });
  const result = ok(f.world.callTool(a.auth, 'act', request)); assert.deepEqual(f.world.callTool(a.auth, 'act', request), result);
  assert.equal(f.raw(a).life.inventory.turnip, Number.MAX_SAFE_INTEGER); assert.equal(f.raw(a).personal_goal.progress, 0); assert.equal(f.observe(a).cooperation_return, null);
});

for (const interruption of ['pause', 'lease', 'restart']) test(`合作${interruption}保留托管/进度/期限，各自复核同一revision才继续`, t => {
  const f = fixture(t, true), a = f.make(), b = f.make(); f.raw(a).life.inventory.turnip = 4;
  const p = f.form(a, b); ok(f.coop(a, 'contribute', f.params(p))); const before = structuredClone(f.project(p));
  if (interruption === 'pause') { f.world.ownerControl(a.id, 'pause'); f.resume(a); }
  else if (interruption === 'lease') { f.advance(46000, false); f.reconnect(a); f.reconnect(b); }
  else { f.restart(); f.reconnect(a); f.reconnect(b); }
  assert.equal(f.project(p).status, 'needs_review'); assert.equal(f.project(p).revision, before.revision + 1);
  assert.equal(f.project(p).expires_at, before.expires_at); assert.deepEqual(f.project(p).progress, before.progress); assert.equal(f.project(p).escrow.turnip, 4);
  reject(f.coop(b, 'cook', { cooperation_id: p.cooperation_id, revision: before.revision }), 'COOPERATION_STALE');
  const params = f.params(p); ok(f.coop(a, 'confirm', params));
  f.world.tick(); assert.equal(f.project(p).revision, params.revision); assert.equal(f.project(p).status, 'needs_review');
  reject(f.coop(b, 'cook', params), 'COOPERATION_REVIEW'); ok(f.coop(b, 'confirm', params));
  assert.equal(f.project(p).status, 'active'); ok(f.coop(b, 'cook', params)); assert.equal(f.project(p).status, 'completed');
});

test('明确召回/撤销/固定期限结束，未用托管返回且已完成真实结果不回收', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).life.inventory.turnip = 4;
  const p = f.form(a, b); ok(f.coop(a, 'contribute', f.params(p))); f.world.ownerControl(b.id, 'recall');
  assert.equal(f.project(p).end_reason, 'authorization_ended'); assert.equal(f.raw(a).life.inventory.turnip, 4);
  f.world.ownerControl(b.id, 'start', { controller_id: b.c.controller_id, duration_minutes: 60 }); f.reconnect(b); f.advance(60001);
  const q = f.form(a, b); ok(f.coop(a, 'contribute', f.params(q))); f.world.state.controllers[b.c.controller_id].revoked = true; f.world.tick();
  assert.equal(f.project(q).status, 'ended'); assert.equal(f.raw(a).life.inventory.turnip, 4);
});

test('关系管理允许探索待选且不取消计划；交菜烹饪仍被待选约束拒绝', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).scene_id = 'adventure'; f.raw(a).position = { x: 4, y: 11 }; f.raw(b).scene_id = 'adventure'; f.raw(b).position = { x: 4, y: 11 };
  ok(f.act(a, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(1000);
  const encounter = structuredClone(f.raw(a).adventure.encounter), p = f.form(a, b);
  assert.deepEqual(f.raw(a).adventure.encounter, encounter); reject(f.coop(a, 'contribute', f.params(p)), 'ENCOUNTER_PENDING');
  ok(f.coop(a, 'leave', { cooperation_id: p.cooperation_id })); assert.deepEqual(f.raw(a).adventure.encounter, encounter);
});

test('公开快照、跨owner和非收件事件不泄漏待接收对象/回应/私账或授权', t => {
  const f = fixture(t), a = f.make(), b = f.make(), c = f.make();
  const cursor = f.world.state.sequence;
  const p = ok(f.coop(a, 'propose', { template_id: 'camp_meal', target_agent_id: b.id, role_id: 'supplier' })).cooperation;
  const projected = publicCooperations(f.world)[0]; assert.deepEqual(projected.members.map(m => m.agent_id), [a.id]);
  for (const key of ['target_agent_id', 'target_binding', 'sources', 'run_id', 'session_epoch']) assert.equal(projected[key], undefined);
  for (const snapshot of [f.world.publicSnapshot(), f.world.snapshotFor({ id: f.world.ownerOf(c.id) })]) {
    assert.ok(!snapshot.events.some(e => ['cooperation_invitation', 'cooperation_response'].includes(e.type)));
    assert.equal(snapshot.cooperations[0].target_agent_id, undefined);
  }
  const events = f.world.callTool(c.auth, 'get_events', { ...c.session, cursor: String(cursor) }).events;
  assert.ok(!events.some(e => e.type === 'cooperation_invitation'));
  ok(f.coop(b, 'respond', { ...f.params(p), accept: false }));
  assert.equal(publicCooperations(f.world)[0].end_reason, 'not_formed'); assert.equal(f.observe(c).cooperation_invitations.length, 0);
});

test('Lv20与40秒决策间隔：先探索再单独一击森林怪完成巡查，无侦察员虚构战利品', t => {
  const f = fixture(t), scout = f.make(), guard = f.make(); const p = f.form(scout, guard, 'scout_and_guard');
  f.raw(guard).adventure.level = 20; f.raw(guard).adventure.max_hp = 135; f.raw(guard).adventure.hp = 135;
  f.raw(guard).scene_id = 'adventure'; f.raw(guard).position = { x: 6, y: 12 }; ok(f.act(guard, 'adventure_plan', { intent: 'hunt', monster_id: 'forest_boar' })); f.advance(6000);
  assert.equal(f.project(p).progress[1].progress, 0, 'earlier kill cannot be backfilled');
  f.raw(guard).scene_id = 'plaza'; f.raw(guard).position = { x: 11, y: 8 }; f.raw(guard).adventure.in_field = false;
  f.advance(40000); f.raw(scout).scene_id = 'adventure'; f.raw(scout).position = { x: 4, y: 11 }; f.raw(scout).adventure.discovery_sequence = 0;
  ok(f.act(scout, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(1000);
  const event = f.raw(scout).adventure.encounter; f.advance(40000);
  ok(f.act(scout, 'adventure_event', { event_id: event.event_id, choice_id: 'wood' }));
  assert.equal(f.project(p).progress[0].progress, 1); const scoutGold = f.raw(scout).adventure.gold;
  f.raw(scout).scene_id = 'plaza'; f.raw(scout).position = { x: 11, y: 8 }; f.raw(scout).adventure.in_field = false; f.advance(40000);
  f.raw(guard).scene_id = 'adventure'; f.raw(guard).position = { x: 6, y: 12 }; ok(f.act(guard, 'adventure_plan', { intent: 'hunt', monster_id: 'forest_boar' })); f.advance(6000);
  assert.equal(f.project(p).status, 'completed'); assert.equal(f.raw(scout).adventure.gold, scoutGold); assert.equal(f.raw(scout).adventure.kills, 0);
  assert.equal(f.raw(guard).adventure.kills, 2); assert.equal(f.project(p).public_result.items_by_agent, undefined);
});

test('期限到达退还托管；已同意的一人再次中断会使旧确认失效，leave不被revision阻挡', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).life.inventory.turnip = 4;
  const p = f.form(a, b); ok(f.coop(a, 'contribute', f.params(p)));
  f.world.ownerControl(a.id, 'pause'); f.resume(a); const epoch = f.params(p);
  ok(f.coop(a, 'confirm', epoch)); f.world.ownerControl(a.id, 'pause'); f.resume(a);
  assert.equal(f.project(p).revision, epoch.revision + 1); reject(f.coop(b, 'confirm', epoch), 'COOPERATION_STALE');
  f.advance(f.project(p).expires_at - f.now() + 1);
  assert.equal(f.project(p).end_reason, 'expired'); assert.equal(f.raw(a).life.inventory.turnip, 4);
  assert.equal(f.raw(a).life.ledger.entries.filter(e => e.reason === 'cooperation_return').length, 1);
});

test('终态最多20条，历史裁剪不丢独立待退款；有退款仍可单玩但不能新托管', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).life.inventory.turnip = 4;
  const p = f.form(a, b); ok(f.coop(a, 'contribute', f.params(p))); f.raw(a).life.inventory.turnip = Number.MAX_SAFE_INTEGER;
  ok(f.coop(a, 'leave', { cooperation_id: p.cooperation_id }));
  f.advance(60001); const q = f.form(a, b); reject(f.coop(a, 'contribute', f.params(q)), 'COOPERATION_RETURN_PENDING');
  ok(f.act(a, 'gather', { intent: 'start', resource_id: 'wood' })); ok(f.act(a, 'gather', { intent: 'cancel' }));
  ok(f.coop(b, 'leave', { cooperation_id: q.cooperation_id }));
  for (let i = 0; i < 21; i++) {
    f.advance(60001);
    const offer = ok(f.coop(a, 'propose', { template_id: 'camp_meal', role_id: 'supplier', target_agent_id: b.id })).cooperation;
    ok(f.coop(b, 'respond', { ...f.params(offer), accept: false }));
  }
  assert.equal(Object.keys(f.world.state.cooperations).length, 20); assert.equal(f.project(p), undefined);
  assert.equal(f.observe(a).cooperation_return.quantity, 4);
  f.raw(a).life.inventory.turnip -= 4; ok(f.coop(a, 'claim_return', { cooperation_id: p.cooperation_id }));
  assert.equal(f.raw(a).life.inventory.turnip, Number.MAX_SAFE_INTEGER); assert.equal(f.observe(a).cooperation_return, null);
});

test('过去发现和拒绝不能计巡查；300秒发现冷却保留，重新发现才有真实进度', t => {
  const f = fixture(t), a = f.make(), b = f.make(); f.raw(a).scene_id = 'adventure'; f.raw(a).position = { x: 4, y: 11 }; f.raw(b).scene_id = 'adventure'; f.raw(b).position = { x: 4, y: 11 };
  f.raw(a).adventure.discovery_sequence = 0;
  ok(f.act(a, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(1000);
  const old = f.raw(a).adventure.encounter, p = f.form(a, b, 'scout_and_guard');
  ok(f.act(a, 'adventure_event', { event_id: old.event_id, choice_id: 'wood' })); assert.equal(f.project(p).progress[0].progress, 0);
  const deadline = f.raw(a).adventure.discovery_ready_at;
  ok(f.act(a, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(1000);
  assert.equal(f.raw(a).adventure.encounter.event_id, old.event_id); assert.equal(f.raw(a).adventure.discovery_ready_at, deadline);
  for (const p of [a, b]) { f.raw(p).scene_id = 'plaza'; f.raw(p).position = { x: 11, y: 8 }; f.raw(p).adventure.in_field = false; }
  f.advance(deadline - f.now() + 1); f.raw(a).scene_id = 'adventure'; f.raw(a).position = { x: 4, y: 11 };
  ok(f.act(a, 'adventure_plan', { intent: 'explore', zone_id: 'forest' })); f.advance(1000);
  const fresh = f.raw(a).adventure.encounter;
  ok(f.act(a, 'adventure_event', { event_id: fresh.event_id, choice_id: 'decline' })); assert.equal(f.project(p).progress[0].progress, 0);
  assert.equal(f.project(p).sources.length, 0);
});

test('合作候选最多6项、可执行且保留普通探索/狩猎；接受有明确拒绝选项', t => {
  const f = fixture(t), a = f.make(), b = f.make();
  const baseline = f.observe(a).opportunities;
  assert.ok(baseline.some(o => o.id === 'hunt')); assert.ok(baseline.some(o => o.id === 'explore_forest')); assert.ok(baseline.length <= 6);
  const p = ok(f.coop(a, 'propose', { template_id: 'camp_meal', role_id: 'supplier', target_agent_id: b.id })).cooperation;
  const options = f.observe(b).opportunities;
  assert.ok(options.some(o => o.id === 'cooperation_accept')); assert.ok(options.some(o => o.id === 'cooperation_decline'));
  const choose = options.find(o => o.id === 'cooperation_accept').action; ok(f.act(b, choose.type, choose.payload));
  assert.equal(f.project(p).status, 'active');
});

test('公开合作的嵌套scalar注入不会泄漏对象或破坏旁观渲染', t => {
  const f = fixture(t), a = f.make(), b = f.make(), p = f.form(a, b), marker = { private_owner_goal: 'PRIVATE_SYNTHETIC_MARKER' };
  const raw = structuredClone(f.project(p)); raw.public_result = { text: 'test', completed_at: f.now(), items_by_agent: { [a.id]: { turnip_soup: 1 } } };
  for (const mutate of [p => { p.cooperation_id = marker; }, p => { p.members[0].agent_id = marker; }, p => { p.progress[0].progress = marker; },
    p => { p.public_result.text = marker; }, p => { p.public_result.items_by_agent[a.id].turnip_soup = marker; }]) {
    const input = structuredClone(raw); mutate(input);
    assert.ok(!JSON.stringify(publicCooperation(input)).includes('PRIVATE_SYNTHETIC_MARKER'));
  }
});
