import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { FATIGUE_RULES, initializeFatigue, publicFatigue } from '../server/fatigue.js';
import { createApp } from '../server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function fixture(t, options = {}) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options });
  t.after(() => world.close());
  const people = [];
  const make = (name = '原来的 AI') => {
    const agent = world.createAgent({ name }), controller = world.createController(agent.agent_id);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30 });
    const auth = world.authenticate(controller.token), o = world.callTool(auth, 'join_world');
    const p = { id: agent.agent_id, auth, controller, session: { run_id: o.run_id, session_epoch: o.session_epoch } };
    world.agent(p.id).position = { x: 11, y: 8 }; people.push(p); return p;
  };
  const raw = p => world.agent(p.id);
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload = {}) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const advance = (ms, connected = people) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100); world.tick();
      for (const p of connected) if (raw(p).status === 'active') observe(p);
    }
  };
  const battle = (p, value = 100) => {
    const a = raw(p), m = world.state.adventure.monsters[2];
    a.scene_id = 'adventure'; a.scene_id = 'adventure'; a.position = { x: 19, y: 7 }; a.adventure.hp = a.adventure.max_hp = 1000; a.fatigue.energy = value;
    m.position = { x: 20, y: 7 }; m.hp = m.max_hp = 1000; m.attack = 0;
    assert.equal(act(p, 'adventure_plan', { intent: 'hunt', monster_id: m.monster_id }).status, 'applied');
    return m;
  };
  return { world, make, raw, observe, request, act, advance, battle, now: () => now, jump: ms => { now += ms; world.tick(); } };
}

test('体力目录与事实公开，新旧角色初始化不重设已消耗体力或塑造人格', t => {
  const f = fixture(t), p = f.make(), rules = f.world.getRules();
  assert.deepEqual(rules.fatigue.costs, FATIGUE_RULES.costs);
  assert.equal(f.observe(p).self.fatigue.energy, 100);
  assert.deepEqual(f.observe(p).self.fatigue.recent_exertion, { last_kind: null, last_at: null, actions_count: 0 });
  f.raw(p).fatigue.energy = 11; f.raw(p).fatigue.secret = 'PRIVATE'; initializeFatigue(f.raw(p), f.now());
  assert.equal(f.observe(p).self.fatigue.energy, 11);
  assert.equal(f.observe(p).self.fatigue.state, 'tired');
  assert.equal(publicFatigue(f.raw(p)).secret, undefined);
  assert.equal(f.raw(p).adventure.plan, null);
  rules.fatigue.costs.attack = 99; assert.equal(f.world.getRules().fatigue.costs.attack, 3);
});

test('攻击按真实次数扣3，跨疲劳线攻击折减且提醒只发一次', t => {
  const f = fixture(t), p = f.make(), m = f.battle(p, 28);
  f.advance(1000);
  assert.equal(f.raw(p).fatigue.energy, 25); assert.equal(m.hp, 996);
  assert.equal(f.observe(p).self.life.stats.attack, 6); assert.equal(f.observe(p).self.life.stats.effective_attack, 4);
  assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_tired').length, 1);
  f.advance(3000); assert.equal(f.raw(p).fatigue.energy, 16);
  assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_tired').length, 1);
  assert.equal(f.raw(p).adventure.plan.intent, 'hunt');
  assert.equal(f.observe(p).self.fatigue.recent_exertion.actions_count, 4);
  assert.ok(f.observe(p).opportunities.some(o => o.action.payload.intent === 'retreat'));
});

test('不足一次攻击时终止狩猎且不会自动重启；重新狩猎门槛12与走路撤退独立', t => {
  const f = fixture(t), p = f.make(), m = f.battle(p, 12);
  f.advance(5000);
  assert.equal(f.raw(p).fatigue.energy, 0); assert.equal(m.hp, 984);
  assert.equal(f.raw(p).adventure.plan, null); assert.equal(f.raw(p).adventure.last_result.kind, 'exhausted');
  assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_exhausted').length, 1);
  f.advance(5000); assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_exhausted').length, 1);
  const rejected = f.act(p, 'adventure_plan', { intent: 'hunt', monster_id: m.monster_id });
  assert.equal(rejected.error.code, 'FATIGUE_EXHAUSTED');
  assert.equal(f.observe(p).opportunities.some(o => o.action.payload.intent === 'hunt'), false);
  assert.equal(f.act(p, 'move', { x: 18, y: 7 }).status, 'applied'); assert.equal(f.raw(p).fatigue.energy, 0);
  assert.equal(f.act(p, 'adventure_plan', { intent: 'retreat' }).status, 'applied');
  for(let i=0;i<90 && f.raw(p).adventure.plan;i++) f.advance(1000); assert.deepEqual(f.raw(p).position, { x: 11, y: 8 }); assert.equal(f.raw(p).adventure.plan, null);
  assert.ok(f.raw(p).fatigue.energy < 3, '撤退不会自动开始快速休息');
});

test('满生命但体力未满的主动休息持续恢复至双满，再交回原AI决定', t => {
  const f = fixture(t), p = f.make(); f.raw(p).fatigue.energy = 10;
  assert.ok(f.observe(p).opportunities.some(o => o.id === 'rest'));
  assert.equal(f.act(p, 'adventure_plan', { intent: 'rest' }).status, 'applied');
  f.advance(1000); assert.equal(f.raw(p).fatigue.energy, 12); assert.equal(f.raw(p).adventure.plan.intent, 'rest');
  f.advance(45000); assert.equal(f.raw(p).fatigue.energy, 100); assert.equal(f.raw(p).adventure.plan, null);
  assert.equal(f.raw(p).adventure.hp, f.raw(p).adventure.max_hp);
  f.advance(10000); assert.equal(f.raw(p).adventure.plan, null);
});

test('营地静止和聊天慢恢复，relax快恢复，野外与同一行动秒不恢复', t => {
  const f = fixture(t), p = f.make(); f.raw(p).fatigue.energy = 40;
  f.advance(10000); assert.equal(f.raw(p).fatigue.energy, 43);
  f.act(p, 'say', { text: '在营地聊会儿', channel: 'nearby' }); f.advance(1000); assert.equal(f.raw(p).fatigue.energy, 43.3);
  f.act(p, 'start_activity', { activity_id: 'relax' }); f.advance(1000); assert.equal(f.raw(p).fatigue.energy, 45.3);
  f.act(p, 'move', { x: 12, y: 8 }); const afterMove = f.raw(p).fatigue.energy;
  f.advance(1000); assert.equal(f.raw(p).fatigue.energy, afterMove-.15);
  f.advance(1000); assert.ok(Math.abs(f.raw(p).fatigue.energy - afterMove) < 1e-8, 'movement ends at 500ms, recovery resumes at 1500ms');
  f.act(p, 'move', { x: 15, y: 8 }); const field = f.raw(p).fatigue.energy;
  f.advance(20000); assert.equal(f.raw(p).fatigue.energy, Math.round((field-.45)*10000)/10000);
});

test('休息开始不追溯加速，活动和计划到期的最后一秒仍按实际时段恢复', t => {
  const f = fixture(t), p = f.make(); f.raw(p).fatigue.energy = 0;
  f.advance(10000); assert.equal(f.raw(p).fatigue.energy, 3);
  f.act(p, 'start_activity', { activity_id: 'relax' });
  assert.equal(f.raw(p).fatigue.energy, 3, '新活动不把过去静止时间变成快速恢复');
  f.raw(p).activity.ends_at = f.now() + 3000;
  f.advance(3000); assert.equal(f.raw(p).fatigue.energy, 9); assert.equal(f.raw(p).activity, null);
  f.act(p, 'adventure_plan', { intent: 'rest' }); f.raw(p).adventure.plan.expires_at = f.now() + 3000;
  f.advance(3000); assert.equal(f.raw(p).fatigue.energy, 15); assert.equal(f.raw(p).adventure.plan, null);
  f.advance(1000); assert.equal(f.raw(p).fatigue.energy, 15.3);
});

test('延迟tick按休息到期、授权到期和失联边界分段结算，重连不重复恢复', t => {
  for (const boundary of ['activity', 'plan', 'run', 'heartbeat']) {
    const f = fixture(t), p = f.make(); f.raw(p).fatigue.energy = 0;
    if (boundary === 'activity') {
      f.act(p, 'start_activity', { activity_id: 'relax' }); f.raw(p).activity.ends_at = f.now() + 10000;
    } else {
      f.act(p, 'adventure_plan', { intent: 'rest' });
      if (boundary === 'plan') f.raw(p).adventure.plan.expires_at = f.now() + 10000;
      if (boundary === 'run') f.raw(p).run.expires_at = f.now() + 10000;
    }
    f.jump(boundary === 'heartbeat' ? 65000 : 20000);
    const expected = boundary === 'heartbeat' ? 96 : 23;
    assert.equal(f.raw(p).fatigue.energy, expected, boundary);
    f.world.tick(); assert.equal(f.raw(p).fatigue.energy, expected, `${boundary}不能重复结算`);
    if (boundary === 'heartbeat') {
      assert.equal(f.raw(p).status, 'offline');
      const joined = f.world.callTool(p.auth, 'join_world', { run_id: p.session.run_id });
      assert.equal(joined.self.fatigue.energy, expected); assert.equal(joined.self.adventure.plan, null);
    }
  }
});

test('疲劳公开投影只保留合法事实值，异常嵌套字段不能泄漏', () => {
  const a = { fatigue: { energy: 12, last_kind: { secret: 'PRIVATE' }, last_at: { secret: 'PRIVATE' }, actions_count: { secret: 'PRIVATE' }, secret: 'PRIVATE' } };
  const result = publicFatigue(a);
  assert.equal(result.energy, 12); assert.deepEqual(result.recent_exertion, { last_kind: null, last_at: null, actions_count: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('农事和制作按成功动作扣体力，幂等重放与拒绝请求不重复扣除', t => {
  const f = fixture(t), p = f.make();
  assert.equal(f.act(p, 'farm', { intent: 'till', plot_id: 'plot_1' }).status, 'applied');
  const req = f.request(p, 'farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' });
  const result = f.world.callTool(p.auth, 'act', req); assert.equal(result.status, 'applied');
  assert.equal(f.raw(p).fatigue.energy, 95); assert.deepEqual(f.world.callTool(p.auth, 'act', req), result);
  assert.equal(f.raw(p).fatigue.energy, 95);
  assert.equal(f.act(p, 'farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }).error.code, 'PLOT_OCCUPIED');
  assert.equal(f.raw(p).fatigue.energy, 95);
  assert.equal(f.act(p, 'farm', { intent: 'water', plot_id: 'plot_1' }).status, 'applied'); assert.equal(f.raw(p).fatigue.energy, 94);
  assert.equal(f.act(p, 'inventory', { intent: 'craft', item_id: 'wooden_sword' }).status, 'applied'); assert.equal(f.raw(p).fatigue.energy, 92);
  f.raw(p).life.plots[0].ready_at = f.now();
  assert.equal(f.act(p, 'farm', { intent: 'harvest', plot_id: 'plot_1' }).status, 'applied'); assert.equal(f.raw(p).fatigue.energy, 90);
  f.raw(p).fatigue.energy = 1;
  const seeds = f.raw(p).life.inventory.turnip_seed;
  assert.equal(f.act(p, 'farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }).error.code, 'FATIGUE_EXHAUSTED');
  assert.equal(f.raw(p).fatigue.energy, 1); assert.equal(f.raw(p).life.inventory.turnip_seed, seeds);
  assert.equal(f.observe(p).opportunities.some(o => o.action.payload.intent === 'plant'), false);
});

test('真实步行按格扣体力，原地或非法移动不扣除，角色之间完全独立', t => {
  const f = fixture(t), p = f.make(), other = f.make('同伴');
  f.act(p, 'move', { x: 13, y: 8 }); f.advance(1000); assert.equal(f.raw(p).fatigue.energy, 99.7);
  f.act(p, 'move', { x: 13, y: 8 }); assert.equal(f.raw(p).fatigue.energy, 99.7);
  assert.equal(f.act(p, 'move', { x: 100, y: 8 }).status, 'rejected'); assert.equal(f.raw(p).fatigue.energy, 99.7);
  assert.equal(f.raw(other).fatigue.energy, 100);
  f.act(p, 'adventure_plan', { intent: 'explore', zone_id: 'forest' }); f.advance(1000);
  assert.ok(Math.abs(f.raw(p).fatigue.energy-99.43)<1e-8, 'one second plan: 100ms setup then 1.8 actual tiles');
});

test('疲劳提醒只有恢复40后才重新触发，不会在阈值附近反复唤醒', t => {
  const f = fixture(t), p = f.make(); f.battle(p, 28); f.advance(1000);
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.raw(p).scene_id = 'plaza'; f.raw(p).position = { x: 11, y: 8 }; f.raw(p).adventure.in_field = false;
  f.act(p, 'adventure_plan', { intent: 'rest' }); f.advance(3000);
  assert.ok(f.raw(p).fatigue.energy > 25 && f.raw(p).fatigue.energy < 40);
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.battle(p, 28); f.advance(1000);
  assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_tired').length, 1);
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.raw(p).scene_id = 'plaza'; f.raw(p).position = { x: 11, y: 8 }; f.raw(p).adventure.in_field = false;
  f.act(p, 'adventure_plan', { intent: 'rest' }); f.advance(10000); assert.ok(f.raw(p).fatigue.energy >= 40);
  f.act(p, 'adventure_plan', { intent: 'stop' }); f.battle(p, 28); f.advance(1000);
  assert.equal(f.world.state.events.filter(e => e.type === 'fatigue_tired').length, 2);
});

test('离线暂停营地仅慢恢复，野外不恢复，暂停旧会话不准行动', t => {
  const f = fixture(t), p = f.make(), q = f.make('野外同伴');
  f.raw(p).fatigue.energy = 10; f.raw(q).fatigue.energy = 10; f.raw(q).scene_id = 'adventure'; f.raw(q).position = { x: 1, y: 1 };
  f.act(p, 'adventure_plan', { intent: 'rest' });
  f.world.ownerControl(p.id, 'pause'); f.world.ownerControl(q.id, 'pause'); f.advance(10000, []);
  assert.equal(f.raw(p).fatigue.energy, 13); assert.equal(f.raw(q).fatigue.energy, 10);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...p.session, action_id: 'stale', type: 'move', payload: { x: 10, y: 8 } }), { code: 'STALE_SESSION' });
});

test('持久化重启按已存时间只结算营地慢恢复，不重置体力、不重复结算或复活旧计划', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fatigue-')), dbPath = join(dir, 'world.sqlite'); let now = 1000000, w;
  try {
    w = new World({ dbPath, now: () => now }); const a = w.createAgent({ name: '营地角色' }), b = w.createAgent({ name: '野外角色' });
    const camp = w.agent(a.agent_id), field = w.agent(b.agent_id);
    camp.position = { x: 11, y: 8 }; camp.fatigue.energy = 10; camp.adventure.plan = { intent: 'rest', zone_id: 'camp', expires_at: now + 90000 };
    field.position = { x: 1, y: 1 }; field.fatigue.energy = 10;
    w.close(); w = null; now += 10000;
    w = new World({ dbPath, now: () => now }); assert.equal(w.agent(a.agent_id).fatigue.energy, 13); assert.equal(w.agent(b.agent_id).fatigue.energy, 10);
    assert.equal(w.agent(a.agent_id).adventure.plan, null); w.close(); w = null;
    w = new World({ dbPath, now: () => now }); assert.equal(w.agent(a.agent_id).fatigue.energy, 13);
    now -= 5000; w.close(); w = null;
    w = new World({ dbPath, now: () => now }); assert.equal(w.agent(a.agent_id).fatigue.energy, 13);
    now += 5000; w.tick(); assert.equal(w.agent(a.agent_id).fatigue.energy, 13);
  } finally { w?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('耗尽也能吃食物和换装，但食物不恢复体力或解除野外危险', t => {
  const f = fixture(t), p = f.make(), a = f.raw(p); a.fatigue.energy = 0; a.life.inventory.turnip = 1;
  a.scene_id = 'adventure'; a.position = { x: 1, y: 1 }; a.adventure.hp = 20; a.adventure.in_field = true; a.adventure.decision_until = f.now() + 30000;
  assert.equal(f.act(p, 'inventory', { intent: 'use', item_id: 'turnip' }).status, 'applied');
  assert.equal(a.fatigue.energy, 0); assert.equal(a.adventure.hp, 32); assert.equal(a.adventure.in_field, true); assert.equal(a.adventure.decision_until, f.now() + 30000);
  a.scene_id = 'plaza'; a.position = { x: 11, y: 8 }; a.adventure.in_field = false; a.life.inventory.wooden_sword = 1;
  assert.equal(f.act(p, 'inventory', { intent: 'equip', item_id: 'wooden_sword' }).status, 'applied'); assert.equal(a.fatigue.energy, 0);
});

test('疲劳候选保留多种自主选择，各体力边界给出的动作均可真实执行', t => {
  const f = fixture(t), p = f.make();
  for (const value of [0, .99, 1, 1.99, 2, 2.99, 3, 11.99, 12, 25, 100]) {
    f.raw(p).fatigue.energy = value;
    const o = f.observe(p), saved = structuredClone(f.world.state);
    assert.ok(o.opportunities.some(option => option.action.type === 'start_activity' && option.action.payload.activity_id === 'relax' || option.action.type === 'adventure_plan' && option.action.payload.intent === 'rest'), '每个体力边界保留免费恢复选项，避免重复休息建议挤占其他玩法');
    assert.ok(o.opportunities.some(option => option.action.payload.intent === 'explore'));
    assert.ok(o.opportunities.length <= 6);
    for (const candidate of o.opportunities) {
      f.world.state = structuredClone(saved);
      const result = f.world.callTool(p.auth, 'act', { ...p.session, action_id: o.next_action_id, ...candidate.action });
      assert.equal(result.status, 'applied', `${value}/${candidate.id}: ${JSON.stringify(result.error)}`);
    }
    f.world.state = saved;
  }
});

test('攻击耗尽与体力同步持久化，重新连接不补满或重复扣除旧动作', t => {
  const f = fixture(t), p = f.make(); f.battle(p, 12); f.advance(5000);
  const stored = JSON.parse(f.world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload).agents[p.id];
  assert.equal(stored.fatigue.energy, 0); assert.equal(stored.adventure.plan, null);
  const joined = f.world.callTool(p.auth, 'join_world', { run_id: p.session.run_id });
  assert.equal(joined.self.fatigue.energy, 0); assert.equal(joined.self.adventure.plan, null);
});

test('静止在野外失去心跳不会产生离线体力或生命恢复', t => {
  const f = fixture(t), p = f.make(); const a = f.raw(p);
  a.scene_id = 'adventure'; a.position = { x: 1, y: 1 }; a.fatigue.energy = 20; a.adventure.hp = 20;
  f.advance(65000, []);
  assert.equal(a.status, 'offline'); assert.equal(a.fatigue.energy, 20); assert.equal(a.adventure.hp, 20);
  assert.equal(a.adventure.plan, null);
});

test('真实HTTP MCP统一执行疲劳门槛，旁观公开体力与形象但不公开恢复内部状态', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false, demo: false });
  const clock = Date.now(); app.world.now = () => clock; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), created = app.world.createAgent({ name: '原生 AI' }), controller = app.world.createController(created.agent_id);
  app.world.ownerControl(created.agent_id, 'start'); const client = new Client({ name: 'fatigue-test', version: '0.10.0' });
  t.after(async () => { await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); };
  const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const a = app.world.agent(created.agent_id); a.scene_id = 'plaza'; a.position = { x: 11, y: 8 }; a.fatigue.energy = 0;
  assert.equal((await call('get_rules')).fatigue.hunt_min_energy, 12);
  let next = joined.next_action_id;
  for (const [type, payload] of [['adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }], ['farm', { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }]]) {
    const result = await call('act', { ...session, action_id: next, type, payload });
    assert.equal(result.error.code, 'FATIGUE_EXHAUSTED'); next = result.next_action_id;
  }
  const request = { ...session, action_id: next, type: 'adventure_plan', payload: { intent: 'rest' } };
  const resting = await call('act', request); assert.equal(resting.status, 'applied'); assert.deepEqual(await call('act', request), resting);
  const observed = await call('observe', session); assert.equal(observed.self.fatigue.energy, 0); assert.equal(observed.self.adventure.plan.intent, 'rest');
  const response = await fetch(`${url}/api/public/world`); assert.equal(response.status, 200); const snapshot = await response.json();
  assert.equal(snapshot.fatigue.costs.attack, 3); assert.equal(snapshot.agents[0].fatigue.energy, 0);
  assert.deepEqual(snapshot.agents[0].appearance, observed.self.appearance);
  assert.doesNotMatch(JSON.stringify(snapshot), /recover_after|updated_at|tired_notified|token_hash|private_note/);
});
