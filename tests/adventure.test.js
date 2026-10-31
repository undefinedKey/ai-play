import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { createApp } from '../server/index.js';
import { WORLD_MAP, isPositionInBounds } from '../server/spatial.js';

function fixture(t, options = {}) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options });
  t.after(() => world.close());
  const people = [];
  // Combat-focused fixtures start in adventure; v017-scenes tests traverse the real gateways.
  const make = (name = '原来的 AI', minutes = 15, scene_id = 'adventure') => {
    const agent = world.createAgent({ name, bio: '保留原来的身份', owner_id: 'PRIVATE_OWNER' });
    const controller = world.createController(agent.agent_id);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: minutes, goal: 'PRIVATE_GOAL' });
    const auth = world.authenticate(controller.token), o = world.callTool(auth, 'join_world');
    world.agent(agent.agent_id).scene_id = scene_id;
    const p = { agent, controller, auth, session: { run_id: o.run_id, session_epoch: o.session_epoch } }; people.push(p); return p;
  };
  const observe = p => world.callTool(p.auth, 'observe', p.session);
  const request = (p, type, payload = {}) => ({ ...p.session, action_id: observe(p).next_action_id, type, payload });
  const act = (p, type, payload) => world.callTool(p.auth, 'act', request(p, type, payload));
  const plan = (p, intent, extra = {}) => act(p, 'adventure_plan', { intent, ...extra });
  const advance = (ms, connected = people) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100); world.tick();
      for (const p of connected) if (world.agent(p.agent.agent_id).status === 'active') observe(p);
    }
  };
  const fighter = p => world.agent(p.agent.agent_id);
  return { world, make, observe, request, act, plan, advance, fighter, now: () => now, jump: ms => { now += ms; world.tick(); } };
}

test('冒险目录和公开成长可发现；新角色没有自动计划或默认人格', t => {
  const f = fixture(t), p = f.make();
  const rules = f.world.getRules(), o = f.observe(p);
  assert.ok(rules.allowed_actions.includes('adventure_plan'));
  assert.deepEqual(rules.adventure.zones.map(z => z.id), ['camp', 'forest', 'ruins']);
  assert.equal(o.adventure.monsters.length, 3); assert.equal(o.self.adventure.plan, null);
  assert.equal(o.self.adventure.hp, 40); assert.equal(o.self.bio, '保留原来的身份');
  f.advance(20000); assert.equal(f.fighter(p).adventure.plan, null);
  o.adventure.monsters[0].hp = 999; rules.adventure.zones[0].x = 999;
  assert.equal(f.observe(p).adventure.monsters[0].hp, 18); assert.equal(f.world.getRules().adventure.zones[0].x, 11);
});

test('无旁观者仍按有限探索计划移动，抵达后不会自动挑选下一项', t => {
  const f = fixture(t), p = f.make(); const initial = { ...f.fighter(p).position };
  assert.equal(f.plan(p, 'explore', { zone_id: 'camp' }).status, 'applied');
  assert.deepEqual(f.fighter(p).position, initial);
  f.advance(2000); assert.notDeepEqual(f.fighter(p).position, initial);
  f.advance(18000); assert.deepEqual(f.fighter(p).position, { x: 11, y: 8 });
  assert.equal(f.fighter(p).adventure.plan, null); assert.equal(f.fighter(p).adventure.last_result.kind, 'completed');
  const completed = f.world.state.events.filter(e => e.type === 'adventure_finished').length;
  f.advance(20000); assert.deepEqual(f.fighter(p).position, { x: 11, y: 8 });
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_finished').length, completed);
});

test('狩猎结算与金币经验只发一次，幂等重试不会重开计划', t => {
  const f = fixture(t), p = f.make();
  const req = f.request(p, 'adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' });
  const started = f.world.callTool(p.auth, 'act', req);
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), started);
  f.advance(25000);
  const a = f.fighter(p); assert.equal(a.adventure.kills, 1); assert.equal(a.adventure.xp, 12); assert.equal(a.adventure.gold, 6); assert.equal(a.adventure.plan, null);
  const monster = f.observe(p).adventure.monsters.find(m => m.monster_id === 'forest_slime');
  assert.equal(monster.status, 'respawning'); assert.equal(monster.hp, 0);
  assert.deepEqual(f.world.callTool(p.auth, 'act', req), started);
  f.advance(65000); assert.equal(a.adventure.kills, 1); assert.equal(a.adventure.gold, 6);
  assert.equal(f.observe(p).adventure.monsters[0].status, 'alive'); assert.equal(a.adventure.plan, null);
});

test('组队需要双方同意，各自选择同一目标后协同作战并分享总奖励', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙');
  const group = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id: group, target_agent_id: b.agent.agent_id });
  assert.equal(f.fighter(b).group_id, null);
  assert.equal(f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true }).status, 'applied');
  f.plan(a, 'hunt', { monster_id: 'forest_boar' });
  assert.equal(f.fighter(b).adventure.plan, null);
  f.plan(b, 'hunt', { monster_id: 'forest_boar' }); f.advance(20000);
  const aa = f.fighter(a).adventure, bb = f.fighter(b).adventure;
  assert.equal(aa.last_result.kind, 'victory'); assert.equal(bb.last_result.kind, 'victory');
  assert.equal(aa.xp + bb.xp, 20); assert.equal(aa.gold + bb.gold, 10);
  assert.ok(aa.hp > 0 && bb.hp > 0); assert.ok(aa.xp > 0 && bb.xp > 0);
});

test('未同意战斗的同组成员不跟随、不受伤、不领取奖励', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙');
  const group = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id: group, target_agent_id: b.agent.agent_id });
  f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  const position = { ...f.fighter(b).position };
  f.plan(a, 'hunt', { zone_id: 'forest' }); f.advance(30000);
  assert.deepEqual(f.fighter(b).position, position); assert.equal(f.fighter(b).adventure.hp, 40); assert.equal(f.fighter(b).adventure.gold, 0);
});

test('低血量先停在原地等待新决策，主动继续挑战仍可战败返回营地', t => {
  const f = fixture(t), p = f.make();
  f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }); f.advance(30000);
  const a = f.fighter(p); assert.equal(a.adventure.last_result.kind, 'needs_decision'); assert.equal(a.adventure.hp, 8);
  assert.equal(a.adventure.plan, null); assert.notDeepEqual(a.position, { x: 11, y: 8 });
  const position = { ...a.position }; f.advance(10000); assert.equal(a.adventure.hp, 8); assert.deepEqual(a.position, position);
  assert.equal(f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }).status, 'applied'); f.advance(3000);
  assert.equal(a.adventure.last_result.kind, 'defeated'); assert.equal(a.adventure.hp, 10);
  assert.deepEqual(a.position, { x: 11, y: 8 }); assert.equal(a.adventure.plan, null);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_danger').length, 1);
  f.plan(p, 'rest'); f.advance(10000); assert.equal(a.adventure.hp, 40); assert.equal(a.adventure.plan, null);
});

test('撤退和手动停止立即终止攻击，战斗不会因旧贡献继续发奖', t => {
  const f = fixture(t), p = f.make(); f.fighter(p).adventure.hp = f.fighter(p).adventure.max_hp = 100; f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }); f.advance(12000);
  const a = f.fighter(p), hp = a.adventure.hp;
  const attacks = f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent').length;
  f.plan(p, 'retreat'); f.advance(30000);
  assert.ok(a.adventure.hp <= hp); assert.equal(f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent').length, attacks); assert.deepEqual(a.position, { x: 11, y: 8 }); assert.equal(a.adventure.plan, null);
  f.plan(p, 'explore', { zone_id: 'forest' }); f.advance(1000);
  f.plan(p, 'stop'); const pos = { ...a.position }; f.advance(10000); assert.deepEqual(a.position, pos);
});

test('错误冒险参数不替换既有计划，也不能由别人的控制端发起', t => {
  const f = fixture(t), p = f.make(), other = f.make('另一位');
  f.plan(p, 'explore', { zone_id: 'forest' });
  const before = f.observe(p).self.adventure.plan;
  for (const payload of [{ intent: 'unknown' }, { intent: 'explore' }, { intent: 'hunt' }, { intent: 'hunt', monster_id: 'unknown' }, { intent: 'hunt', monster_id: 'forest_slime', zone_id: 'ruins' }, { intent: 'rest', zone_id: 'ruins' }, { intent: 'stop', zone_id: 'camp' }, { intent: 'explore', zone_id: 'forest', hp: 999 }]) {
    assert.equal(f.act(p, 'adventure_plan', payload).status, 'rejected'); assert.deepEqual(f.observe(p).self.adventure.plan, before);
  }
  const req = f.request(p, 'adventure_plan', { intent: 'stop' });
  assert.throws(() => f.world.callTool(other.auth, 'act', req), { code: 'STALE_SESSION' });
  assert.deepEqual(f.observe(p).self.adventure.plan, before);
});

test('暂停、召回、房间暂停、授权到期、离线都会在模拟前停止计划', t => {
  for (const operation of ['pause', 'recall', 'room', 'expiry', 'offline']) {
    const f = fixture(t), p = f.make(operation, operation === 'expiry' ? .05 : 15);
    f.plan(p, 'hunt', { monster_id: 'ruins_guardian' });
    if (operation === 'room') f.world.ownerRoom('pause');
    else if (['pause', 'recall'].includes(operation)) f.world.ownerControl(p.agent.agent_id, operation);
    else f.advance(operation === 'expiry' ? 3000 : 45000, []);
    const a = f.fighter(p), pos = { ...a.position }, hp = a.adventure.hp;
    assert.equal(a.adventure.plan, null, operation); f.advance(5000, []);
    assert.deepEqual(a.position, pos, operation); assert.equal(a.adventure.hp, hp, operation);
  }
});

test('模拟不补算长时间卡顿，计划最迟90秒结束', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'explore', { zone_id: 'ruins' });
  const a = f.fighter(p), pos = { ...a.position };
  f.jump(10000);
  assert.deepEqual(a.position,pos); assert.ok(a.movement, 'late first tick starts a path rather than teleporting');
  // A finite plan deadline is independent from the renewable control lease.
  a.adventure.plan.expires_at = f.now() + 2000; f.advance(2000);
  assert.equal(a.adventure.plan, null); assert.equal(a.adventure.last_result.kind, 'expired');
});

test('冒险与独处活动/多人游戏互斥，聊天和邀请仍可进行', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'explore', { zone_id: 'forest' });
  assert.equal(f.act(p, 'start_activity', { activity_id: 'relax' }).error.code, 'SCENE_REQUIRED');
  assert.equal(f.act(p, 'say', { channel: 'nearby', text: '我要去森林，有同伴吗？' }).status, 'applied');
  const group = f.act(p, 'create_group').group_id;
  assert.equal(f.act(p, 'propose_game', { group_id: group }).error.code, 'SCENE_REQUIRED');
  f.plan(p, 'retreat'); f.advance(20000);
  f.act(p, 'propose_game', { group_id: group }); assert.equal(f.fighter(p).adventure.plan, null);
  assert.equal(f.plan(p, 'hunt', { monster_id: 'forest_slime' }).error.code, 'GAME_BUSY');
});

test('重启保留成长与角色，清除旧执行计划，不生成默认角色', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-adventure-')); let restored;
  t.after(() => { restored?.close(); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, 'world.sqlite'); let now = 1000000;
  const first = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  const a = first.createAgent({ name: '真实 AI' }), c = first.createController(a.agent_id);
  first.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id }); const auth = first.authenticate(c.token), o = first.callTool(auth, 'join_world');
  first.agent(a.agent_id).adventure.gold = 17; first.agent(a.agent_id).adventure.xp = 36; first.agent(a.agent_id).adventure.level = 2;
  first.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest' } }); first.close();
  now += 5000; restored = new World({ dbPath, now: () => now });
  const saved = restored.agent(a.agent_id); assert.equal(Object.keys(restored.state.agents).length, 1);
  assert.equal(saved.adventure.gold, 17); assert.equal(saved.adventure.xp, 36); assert.equal(saved.adventure.level, 2); assert.equal(saved.adventure.plan, null); assert.equal(saved.status, 'offline');
});

test('旁观白名单不泄露控制凭据、内部伤害贡献或恶意附加字段', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'hunt', { monster_id: 'forest_slime' });
  const a = f.fighter(p); a.adventure.token = 'SECRET'; a.adventure.plan.owner_id = 'SECRET';
  f.world.state.adventure.monsters[0].contributions.PRIVATE_OWNER = 999;
  f.world.event('adventure_combat', { agent_id: a.agent_id, text: '公开战斗', hp: 10, token: 'SECRET', private_plan: 'PRIVATE_GOAL' }, [a.agent_id]);
  const snapshot = spectatorSnapshot(f.world), encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /SECRET|PRIVATE_|run_id|controller_id|session_epoch|contributions|danger_reported/);
  assert.equal(snapshot.agents[0].adventure.plan.intent, 'hunt'); assert.ok(snapshot.events.some(e => e.payload.hp === 10));
});

test('事件与回执有界；淘汰的旧动作不会重新执行', t => {
  const f = fixture(t), p = f.make(); const req = f.request(p, 'wait'); f.world.callTool(p.auth, 'act', req);
  for (let i = 0; i < 201; i++) f.act(p, 'wait');
  assert.equal(Object.keys(f.world.state.receipts).length, 200);
  assert.throws(() => f.world.callTool(p.auth, 'act', req), { code: 'STALE_SESSION' });
  for (let i = 0; i < 3010; i++) f.world.event('adventure_combat', { text: '测试战斗' }, [p.agent.agent_id]);
  assert.equal(f.world.state.events.length, 3000);
  assert.equal(f.world.callTool(p.auth, 'get_events', { ...p.session, cursor: '0' }).cursor_expired, true);
});

test('切计划或离组会清除贡献；临时协力者只领取一次剩余结算', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙'), c = f.make('临时协力者');
  const group = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id: group, target_agent_id: b.agent.agent_id });
  f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  for (const p of [a, b, c]) { f.fighter(p).position = { x: 5, y: 12 }; f.plan(p, 'hunt', { monster_id: 'forest_boar' }); }
  f.advance(1000);
  const monster = f.world.state.adventure.monsters.find(m => m.monster_id === 'forest_boar');
  assert.equal(monster.hp, 14); assert.equal(Object.keys(monster.contributions).length, 3);
  f.plan(a, 'explore', { zone_id: 'camp' }); f.act(b, 'leave_group', { group_id: group });
  assert.deepEqual(Object.keys(monster.contributions), [c.agent.agent_id]);
  f.advance(5000);
  assert.equal(f.fighter(a).adventure.gold, 0); assert.equal(f.fighter(b).adventure.gold, 0);
  assert.equal(f.fighter(c).adventure.gold, 10); assert.equal(f.fighter(c).adventure.xp, 20); assert.equal(f.fighter(c).adventure.kills, 1);
  f.advance(10000); assert.equal(f.fighter(c).adventure.gold, 10);
});

test('奖励与计划结束立即持久化，移动可批量保存且不会使死亡目标重复结算', t => {
  const f = fixture(t), p = f.make();
  f.fighter(p).position = {x:11,y:8};
  const persisted = () => JSON.parse(f.world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload);
  f.plan(p, 'hunt', { monster_id: 'forest_slime' });
  const before = persisted().agents[p.agent.agent_id].position;
  f.advance(1000); assert.deepEqual(persisted().agents[p.agent.agent_id].position, before);
  assert.notDeepEqual(f.fighter(p).position, before);
  f.advance(20000);
  const saved = persisted(); assert.equal(saved.agents[p.agent.agent_id].adventure.gold, 6); assert.equal(saved.agents[p.agent.agent_id].adventure.plan, null);
  assert.equal(saved.adventure.monsters[0].status, 'respawning'); assert.equal(saved.adventure.monsters[0].hp, 0);
  assert.equal(saved.events.filter(e => e.type === 'adventure_loot').length, 1);
  f.plan(p, 'explore', { zone_id: 'camp' }); f.advance(30000);
  assert.equal(persisted().agents[p.agent.agent_id].adventure.last_result.kind, 'completed');
});

test('危险决策节点及战败即时落盘，低血量不会在等待模型时继续受伤', t => {
  const f = fixture(t), p = f.make();
  f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }); f.advance(25000);
  let saved = JSON.parse(f.world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload).agents[p.agent.agent_id];
  assert.equal(saved.adventure.hp, 8); assert.equal(saved.adventure.last_result.kind, 'needs_decision'); assert.equal(saved.adventure.plan, null);
  f.advance(5000); assert.equal(f.fighter(p).adventure.hp, 8);
  f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }); f.advance(10000);
  saved = JSON.parse(f.world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload).agents[p.agent.agent_id];
  assert.equal(saved.adventure.last_result.kind, 'defeated'); assert.equal(saved.adventure.hp, 10); assert.deepEqual(saved.position, { x: 11, y: 8 });
});

test('空场怪物仍按世界时钟复活，房间暂停期间不推进且恢复不补算多轮', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'hunt', { monster_id: 'forest_slime' }); f.advance(20000);
  f.world.ownerControl(p.agent.agent_id, 'recall');
  f.advance(60000, []); assert.equal(f.world.state.adventure.monsters[0].status, 'alive');
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_respawn').length, 1);
  const m = f.world.state.adventure.monsters[0]; m.hp = 0; m.status = 'respawning'; m.respawn_at = f.now() + 1000;
  f.world.ownerRoom('pause'); f.jump(180000); assert.equal(m.status, 'respawning');
  f.world.ownerRoom('resume'); f.world.tick(); assert.equal(m.status, 'alive');
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_respawn').length, 2);
  f.world.tick(); assert.equal(f.world.state.events.filter(e => e.type === 'adventure_respawn').length, 2);
});

test('失去原AI心跳后先停止计划，不补算离线期间的移动和攻击', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'hunt', { monster_id: 'ruins_guardian' });
  const position = { ...f.fighter(p).position }, contact = f.fighter(p).last_contact_at;
  spectatorSnapshot(f.world); assert.equal(f.fighter(p).last_contact_at, contact);
  f.jump(45000);
  assert.equal(f.fighter(p).status, 'offline'); assert.equal(f.fighter(p).adventure.plan, null); assert.deepEqual(f.fighter(p).position, position);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_combat').length, 0);
});

test('发现冷却期间只探索也会被追击攻击；不替原AI反击，锁定事件不按秒重复', t => {
  const f = fixture(t), p = f.make(); f.fighter(p).position = { x: 17, y: 7 };
  f.fighter(p).adventure.discovery_ready_at = f.now() + 300000;
  f.plan(p, 'explore', { zone_id: 'ruins' }); f.advance(1000);
  const m = f.world.state.adventure.monsters[2], a = f.fighter(p);
  assert.equal(m.target_agent_id, a.agent_id); assert.equal(m.behavior, 'attacking'); assert.ok(Math.abs(m.position.x-a.position.x)+Math.abs(m.position.y-a.position.y)<=1); assert.equal(a.adventure.hp, 40);
  f.advance(2000); assert.equal(a.adventure.hp, 24); assert.equal(m.behavior, 'attacking');
  assert.equal(a.adventure.plan, null); assert.equal(a.adventure.in_field, true); assert.equal(a.adventure.last_result.kind, 'completed');
  assert.equal(m.hp, 70); assert.equal(f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'agent').length, 0);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_aggro' && e.payload.monster_id === m.monster_id).length, 1);
  const publicState = spectatorSnapshot(f.world); assert.equal(publicState.adventure.monsters[2].target_agent_id, a.agent_id);
  assert.equal(publicState.events.find(e => e.type === 'adventure_aggro').payload.target_agent_id, a.agent_id);
  assert.equal(publicState.events.find(e => e.type === 'adventure_combat').payload.attacker, 'monster');
});

test('未选择过冒险的旧广场角色即使在怪物身边也不会被攻击', t => {
  const f = fixture(t), p = f.make(); const a = f.fighter(p); a.position = { x: 20, y: 7 };
  f.advance(20000); assert.equal(a.adventure.in_field, false); assert.equal(a.adventure.hp, 40);
  assert.equal(f.world.state.adventure.monsters[2].target_agent_id, null);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_aggro').length, 0);
});

test('发现冷却期间stop和探索结束不授予免疫；无计划低血仍触发有限保护', t => {
  const f = fixture(t), p = f.make(); f.fighter(p).position = { x: 17, y: 7 };
  f.fighter(p).adventure.discovery_ready_at = f.now() + 300000;
  f.plan(p, 'explore', { zone_id: 'ruins' }); f.advance(2000); f.plan(p, 'stop');
  const a = f.fighter(p); assert.equal(a.adventure.plan, null); assert.equal(a.adventure.hp, 32);
  f.advance(1000); assert.equal(a.adventure.hp, 24); assert.equal(a.adventure.in_field, true);
  f.advance(2000); assert.equal(a.adventure.hp, 8); assert.equal(a.adventure.last_result.kind, 'needs_decision');
  assert.equal(a.adventure.decision_until, f.world.state.events.findLast(e=>e.type==='adventure_danger').occurred_at+30000);
  const until = a.adventure.decision_until, hp = a.adventure.hp;
  f.plan(p, 'stop'); f.advance(1000); assert.equal(a.adventure.decision_until, until); assert.equal(a.adventure.hp, hp);
  f.plan(p, 'explore', { zone_id: 'ruins' }); f.advance(1000); assert.equal(a.adventure.decision_until, until);
  f.advance(25000); assert.equal(a.adventure.hp, hp); assert.equal(f.world.state.events.filter(e => e.type === 'adventure_danger').length, 1);
  f.advance(10000); assert.equal(a.adventure.last_result.kind, 'defeated'); assert.equal(a.adventure.in_field, false); assert.equal(a.adventure.decision_until, null);
});

test('同tick多怪只有第一只跨低血线时受击，后续怪物立即尊重保护', t => {
  const f = fixture(t), p = f.make(); const a = f.fighter(p); a.position = { x: 4, y: 11 };
  f.plan(p, 'explore', { zone_id: 'forest' }); f.plan(p, 'stop'); a.adventure.hp = 12;
  const [slime, boar] = f.world.state.adventure.monsters; boar.position = { x: 5, y: 11 };
  f.advance(1000);
  assert.equal(a.adventure.hp, 10); assert.equal(a.adventure.decision_until, f.world.state.events.findLast(e=>e.type==='adventure_danger').occurred_at+30000);
  const hits = f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'monster');
  assert.equal(hits.length, 1); assert.equal(hits[0].payload.monster_id, slime.monster_id);
  assert.equal(boar.target_agent_id, null);
});

test('低血保护到期不会因仍低血反复续期；主动hunt立刻取消剩余保护', t => {
  const f = fixture(t), p = f.make(); const a = f.fighter(p); a.position = { x: 3, y: 10 };
  f.plan(p, 'explore', { zone_id: 'forest' }); f.plan(p, 'stop'); a.adventure.hp = 12;
  f.advance(1000); assert.equal(a.adventure.hp, 10); assert.ok(a.adventure.decision_until > f.now());
  const until = a.adventure.decision_until;
  f.advance(32000); assert.equal(a.adventure.decision_until, null); assert.ok(a.adventure.hp < 10);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_danger').length, 1);
  a.adventure.hp = 12; f.advance(1000); assert.ok(a.adventure.decision_until > until);
  f.plan(p, 'hunt', { monster_id: 'forest_slime' }); assert.equal(a.adventure.decision_until, null);
  f.advance(1000); assert.equal(a.adventure.hp, 8); assert.equal(a.adventure.decision_until, null);
});

test('同一怪物每秒只攻击一次，不叠加反击与主动攻击', t => {
  const f = fixture(t), p = f.make(); const a = f.fighter(p); a.position = { x: 19, y: 7 };
  f.plan(p, 'hunt', { monster_id: 'ruins_guardian' }); f.advance(1000);
  const m = f.world.state.adventure.monsters[2]; assert.equal(a.adventure.hp, 32); assert.equal(m.hp, 64);
  const attacks = f.world.state.events.filter(e => e.type === 'adventure_combat' && e.payload.attacker === 'monster');
  assert.equal(attacks.length, 1); assert.equal(attacks[0].payload.damage, 8);
});

test('怪物超出追击范围放弃目标并逐步归位，回家恢复生命而不无限追赶', t => {
  const f=fixture(t),p=f.make(),a=f.fighter(p),m=f.world.state.adventure.monsters[2];
  a.position={x:17,y:7};m.position={x:18,y:7};m.hp=60;
  f.plan(p,'explore',{zone_id:'ruins'});f.plan(p,'stop');f.advance(100);
  assert.equal(m.target_agent_id,a.agent_id);
  assert.equal(f.act(p,'move',{x:15,y:7,mode:'run'}).status,'applied');f.advance(1000);
  assert.equal(f.act(p,'move',{x:15,y:4,mode:'run'}).status,'applied');f.advance(1000);
  assert.equal(m.target_agent_id,null);assert.equal(m.behavior,'returning');
  for(let i=0;i<60 && (m.behavior!=='idle'||m.position.x!==m.home_position.x||m.position.y!==m.home_position.y);i++)f.advance(100);
  assert.deepEqual(m.position,m.home_position);assert.equal(m.hp,70);
  f.advance(3000);assert.equal(m.behavior,'patrolling');assert.ok(Math.abs(m.position.x-m.home_position.x)+Math.abs(m.position.y-m.home_position.y)<=2);assert.equal(a.adventure.in_field,true);
});

test('归位中的怪物遭到攻击仍会应战，不能利用returning无伤刷怪', t => {
  const f = fixture(t), p = f.make(); const a = f.fighter(p), m = f.world.state.adventure.monsters[2];
  a.position = { x: 17, y: 6 }; m.position = { x: 17, y: 7 }; m.behavior = 'returning';
  f.plan(p, 'hunt', { monster_id: m.monster_id }); f.advance(1000);
  assert.equal(m.hp, 64); assert.equal(a.adventure.hp, 32); assert.equal(m.target_agent_id, a.agent_id); assert.equal(m.behavior, 'attacking');
});

test('营地边界安全，实际走出后才能攻击，实际返回后立即退出野外', t => {
  const f=fixture(t),p=f.make(),a=f.fighter(p),m=f.world.state.adventure.monsters[2];
  a.position={x:13,y:8};a.adventure.in_field=true;m.position={x:14,y:8};m.home_position={x:14,y:8};
  f.advance(1000);assert.equal(a.adventure.hp,40);assert.equal(a.adventure.in_field,false);assert.equal(m.target_agent_id,null);
  f.plan(p,'hunt',{monster_id:m.monster_id});f.advance(100);assert.deepEqual(a.position,{x:13,y:8});assert.equal(m.hp,70);
  f.advance(100);assert.ok(a.position.x>13);assert.equal(a.adventure.in_field,true);assert.equal(m.hp,70,'preparation is not an instant hit');
  f.advance(500);assert.equal(m.hp,64);assert.equal(a.adventure.hp,32);
  assert.equal(f.act(p,'move',{x:13,y:8}).status,'applied');assert.equal(a.adventure.in_field,true,'accepting move does not teleport into safety');
  f.advance(100);assert.equal(a.adventure.in_field,false);assert.equal(m.target_agent_id,null);
  f.advance(5000);assert.equal(a.adventure.hp,32);assert.equal(m.target_agent_id,null);
});

test('野外停止计划后也不能用旧小游戏或独处活动规避风险，聊天邀请仍可用', t => {
  const f = fixture(t), a = f.make('甲'), b = f.make('乙'); const group = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id: group, target_agent_id: b.agent.agent_id }); f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  f.fighter(b).scene_id = 'plaza';
  const game = f.act(b, 'propose_game', { group_id: group }).game_id;
  f.plan(a, 'explore', { zone_id: 'forest' }); f.plan(a, 'stop');
  assert.equal(f.fighter(a).adventure.in_field, true);
  assert.equal(f.act(a, 'start_activity', { activity_id: 'relax' }).error.code, 'SCENE_REQUIRED');
  assert.equal(f.act(a, 'respond_game', { game_id: game, accept: true }).error.code, 'SCENE_REQUIRED');
  assert.equal(f.act(a, 'say', { channel: 'group', group_id: group, text: '我在野外，需要同伴' }).status, 'applied');
  f.act(a, 'leave_group', { group_id: group }); assert.equal(f.fighter(a).adventure.in_field, true);
});

test('权限暂停、过期、失联及房间暂停清除仇恨，已完成计划角色也不再受伤', t => {
  for (const operation of ['pause', 'recall', 'expiry', 'offline', 'room']) {
    const f = fixture(t), p = f.make(operation), a = f.fighter(p); a.position = { x: 17, y: 7 };
    a.adventure.discovery_ready_at = f.now() + 300000;
    f.plan(p, 'explore', { zone_id: 'ruins' }); f.advance(3000); assert.equal(a.adventure.plan, null); assert.equal(a.adventure.hp, 24);
    if (operation === 'room') f.world.ownerRoom('pause');
    else if (operation === 'expiry') { a.run.expires_at = f.now(); f.world.tick(); }
    else if (operation === 'offline') f.jump(45000);
    else f.world.ownerControl(a.agent_id, operation);
    assert.equal(a.adventure.in_field, false, operation); assert.equal(f.world.state.adventure.monsters[2].target_agent_id, null, operation);
    f.advance(10000, []); assert.equal(a.adventure.hp, 24, operation);
  }
});

test('怪物死亡复活均清目标并回出生点，复活后的新接触才重新锁定', t => {
  const f = fixture(t), p = f.make(); f.plan(p, 'hunt', { monster_id: 'forest_slime' });
  f.advance(20000); const m = f.world.state.adventure.monsters[0];
  assert.equal(m.status, 'respawning'); assert.equal(m.target_agent_id, null); assert.equal(m.behavior, 'idle'); assert.equal(m.movement,null); assert.ok(m.hp===0);
  f.world.ownerControl(p.agent.agent_id, 'recall'); f.advance(m.respawn_at - f.now(), []);
  assert.equal(m.status, 'alive'); assert.equal(m.target_agent_id, null); assert.equal(m.behavior, 'idle'); assert.deepEqual(m.position, m.home_position);
  f.advance(2000, []); assert.equal(m.behavior, 'patrolling'); assert.equal(m.target_agent_id, null);
});

test('冒险地图与巡逻参数可发现，返回地图副本不能修改服务端边界', t => {
  const f = fixture(t), p = f.make();
  const rules = f.world.getRules(), observed = f.observe(p), publicState = spectatorSnapshot(f.world);
  assert.deepEqual(rules.adventure.map, WORLD_MAP); assert.deepEqual(observed.adventure.map, WORLD_MAP); assert.deepEqual(publicState.adventure.map, WORLD_MAP);
  assert.equal(rules.adventure.monster_ai.patrol_radius, 2); assert.equal(rules.adventure.monster_ai.patrol_interval_ms, 2000);
  for (const m of publicState.adventure.monsters) { assert.equal(m.patrol_radius, 2); assert.equal(m.patrol_interval_ms, 2000); }
  rules.adventure.map.width = 1; observed.adventure.map.height = 1; publicState.adventure.map.width = 999;
  assert.deepEqual(f.world.getRules().adventure.map, WORLD_MAP); assert.deepEqual(f.observe(p).adventure.map, WORLD_MAP);
});

test('无人且无旁观者时怪物按2秒一步巡逻，路线连续不抖动且不刷事件', t => {
  const f = fixture(t), m = f.world.state.adventure.monsters[0], home = { ...m.home_position };
  assert.equal(f.world.listenerCount('change'), 0); assert.equal(Object.keys(f.world.state.agents).length, 0);
  f.advance(1000, []); assert.deepEqual(m.position, home);
  const visited = new Set(); let previous = { ...m.position };
  for (let i = 0; i < 120; i++) {
    f.advance(1000, []);
    const moved = Math.abs(m.position.x - previous.x) + Math.abs(m.position.y - previous.y);
    assert.equal(moved, i % 2 === 0 ? 0 : 1, 'patrol starts at two seconds and takes 500ms to reach its waypoint');
    assert.equal(m.behavior, 'patrolling'); assert.equal(m.target_agent_id, null);
    visited.add(`${m.position.x},${m.position.y}`); previous = { ...m.position };
  }
  assert.ok(visited.size >= 6, '巡逻需要覆盖一圈多个格子，而不是来回抖动');
  assert.equal(f.world.state.events.length, 0); assert.equal(f.world.state.sequence, 0);
  assert.equal(Object.keys(f.world.state.agents).length, 0);
});

test('持续30分钟模拟巡逻始终在地图/领地内且不进入安全营地', t => {
  const f = fixture(t); const camp = f.world.getRules().adventure.zones.find(z => z.id === 'camp');
  const previous = new Map(f.world.state.adventure.monsters.map(m => [m.monster_id, { ...m.position }]));
  for (let second = 0; second < 1800; second++) {
    f.advance(1000, []);
    for (const m of f.world.state.adventure.monsters) {
      assert.ok(isPositionInBounds(m.position)); assert.ok(Math.abs(m.position.x - m.home_position.x) + Math.abs(m.position.y - m.home_position.y) <= 2);
      assert.ok(Math.abs(m.position.x - camp.x) + Math.abs(m.position.y - camp.y) > camp.radius);
      const before = previous.get(m.monster_id); assert.ok(Math.abs(before.x - m.position.x) + Math.abs(before.y - m.position.y) <= 1);
      previous.set(m.monster_id, { ...m.position });
    }
  }
  assert.equal(f.world.state.events.length, 0); assert.equal(f.world.state.sequence, 0);
});

test('地图四角及营地边缘的巡逻路线会过滤越界/安全区但保持实际移动', t => {
  const f = fixture(t), m = f.world.state.adventure.monsters[0], camp = f.world.getRules().adventure.zones.find(z => z.id === 'camp');
  for (const home of [{ x: 0, y: 0 }, { x: WORLD_MAP.width - 1, y: 0 }, { x: 0, y: WORLD_MAP.height - 1 }, { x: WORLD_MAP.width - 1, y: WORLD_MAP.height - 1 }, { x: 14, y: 8 }, { x: 11, y: 5 }]) {
    Object.assign(m, { position: { ...home }, home_position: { ...home }, behavior: 'idle', movement:null, target_agent_id: null, patrol_index: 0, next_patrol_at: f.now() + 2000 });
    const visited = new Set();
    for (let second = 0; second < 120; second++) {
      const before = { ...m.position }; f.advance(1000, []);
      assert.ok(isPositionInBounds(m.position)); assert.ok(Math.abs(m.position.x - home.x) + Math.abs(m.position.y - home.y) <= 2);
      assert.ok(Math.abs(m.position.x - camp.x) + Math.abs(m.position.y - camp.y) > camp.radius);
      assert.ok(Math.abs(before.x - m.position.x) + Math.abs(before.y - m.position.y) <= 1);
      visited.add(`${m.position.x},${m.position.y}`);
    }
    assert.ok(visited.size >= 2, `边缘巡逻不应卡住：${JSON.stringify(home)}`);
  }
});

test('房间暂停冻结巡逻，恢复或长时间卡顿后不补算多步', t => {
  const f = fixture(t), m = f.world.state.adventure.monsters[0]; f.advance(2000, []);
  f.world.ownerRoom('pause'); const position = { ...m.position }, events = f.world.state.events.length;
  f.jump(180000); assert.deepEqual(m.position, position); assert.equal(f.world.state.events.length, events);
  f.world.ownerRoom('resume'); f.world.tick();
  assert.deepEqual(m.position,position); assert.ok(m.movement);
  f.advance(500, []); const resumed={...m.position}; assert.equal(Math.abs(m.position.x-position.x)+Math.abs(m.position.y-position.y),1);
  f.jump(180000); assert.deepEqual(m.position,resumed); assert.ok(m.movement); f.advance(500,[]); assert.equal(Math.abs(m.position.x-resumed.x)+Math.abs(m.position.y-resumed.y),1);
});

test('巡逻中的怪物每秒先感知新目标，无需等下一次巡逻步且不替AI反击', t => {
  const f = fixture(t), m = f.world.state.adventure.monsters[2]; f.advance(2000, []);
  assert.equal(m.behavior, 'patrolling'); const before = { ...m.position };
  const p = f.make(); f.fighter(p).position = { x: before.x, y: before.y + 1 }; f.plan(p, 'explore', { zone_id: 'ruins' }); f.plan(p, 'stop');
  f.advance(1000);
  assert.equal(m.target_agent_id, p.agent.agent_id); assert.equal(m.behavior, 'attacking'); assert.ok(Math.abs(m.position.x-before.x)+Math.abs(m.position.y-before.y)<=.2+1e-8);
  assert.equal(f.fighter(p).adventure.hp, 32); assert.equal(m.hp, m.max_hp);
  assert.equal(f.world.state.events.filter(e => e.type === 'adventure_aggro' && e.payload.monster_id === m.monster_id).length, 1);
});

test('受伤或脱战的巡逻怪物先归位回血，再等巡逻间隔恢复路线', t => {
  const f = fixture(t), m = f.world.state.adventure.monsters[2];
  m.position = { x: m.home_position.x - 2, y: m.home_position.y }; m.behavior = 'patrolling'; m.hp = 50;
  f.advance(1000, []); assert.equal(m.behavior, 'returning'); assert.equal(m.hp, 50); assert.equal(m.position.x, m.home_position.x - .2);
  f.advance(1000, []); assert.equal(m.behavior, 'idle'); assert.equal(m.hp, m.max_hp); assert.deepEqual(m.position, m.home_position);
  f.advance(1000, []); assert.deepEqual(m.position, m.home_position);
  f.advance(1000, []); assert.equal(m.behavior, 'patrolling'); assert.notDeepEqual(m.position, m.home_position);
});

test('真实 HTTP MCP 接受冒险动作，匿名旁观能看到计划和怪物但不能控制', async t => {
  const application = await createApp({ dbPath: ':memory:', frontend: false, seed: false, demo: false }); application.world.actionIntervalMs = 0;
  const { server, url } = await application.start(0), a = application.world.createAgent({ name: '冒险 AI' }), c = application.world.createController(a.agent_id);
  application.world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id });
  const client = new Client({ name: 'adventure-test', version: '0.8.0' });
  t.after(async () => { await client.close(); await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); };
  assert.ok((await client.listTools()).tools.find(tool => tool.name === 'act').inputSchema.properties.type.enum.includes('adventure_plan'));
  const o = await call('join_world');
  assert.equal((await call('act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest' } })).status, 'applied');
  const response = await fetch(`${url}/api/public/world`); assert.equal(response.status, 200);
  const snapshot = await response.json(); assert.equal(snapshot.adventure.monsters.length, 3); assert.equal(snapshot.agents[0].adventure.plan.zone_id, 'forest');
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});
