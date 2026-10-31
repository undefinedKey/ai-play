import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';

function fixture(t, options = {}) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options });
  t.after(() => world.close());
  const advance = (ms) => { now += ms; world.tick(); };
  function make(name = '小林', authorize = true) {
    const agent = world.createAgent({ name, bio: '热爱散步' });
    const controller = world.createController(agent.agent_id, { name: 'test', kind: 'external' });
    const auth = world.authenticate(controller.token);
    if (authorize) world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
    return { agent, controller, auth };
  }
  const enter = (person) => world.callTool(person.auth, 'join_world');
  const session = (person) => { const s = world.callTool(person.auth, 'get_control_state'); return { run_id: s.run.run_id, session_epoch: s.session_epoch }; };
  const observe = (person) => world.callTool(person.auth, 'observe', session(person));
  const act = (person, type, payload = {}) => { const o = observe(person); return world.callTool(person.auth, 'act', { ...session(person), action_id: o.next_action_id, type, payload }); };
  const events = (person, cursor) => world.callTool(person.auth, 'get_events', { ...session(person), cursor });
  return { world, advance, make, enter, session, observe, act, events, now: () => now };
}

test('凭证只持久化摘要，隔离测试不入场或开启预算', t => {
  const f = fixture(t); const p = f.make('小林', false);
  assert.throws(() => f.world.authenticate('invalid-token'), { code: 'NOT_AUTHORIZED' });
  assert.equal(f.world.callTool(p.auth, 'test_connection').isolated, true);
  const snap = f.world.ownerSnapshot();
  assert.equal(snap.agents[0].status, 'offline'); assert.equal(snap.agents[0].run, null);
  assert.ok(!JSON.stringify(f.world.state).includes(p.controller.token));
  assert.ok(!JSON.stringify(snap).includes('token_hash'));
});

test('房间容量 5，重复入场保留原预算和动作 ID', t => {
  const f = fixture(t); const people = Array.from({ length: 6 }, (_, i) => f.make(`访客${i}`));
  const first = f.enter(people[0]); for (const p of people.slice(1, 5)) f.enter(p);
  assert.throws(() => f.enter(people[5]), { code: 'ROOM_FULL' });
  const again = f.enter(people[0]);
  assert.equal(again.run_id, first.run_id); assert.equal(again.expires_at, first.expires_at); assert.equal(again.next_action_id, first.next_action_id);
});

test('控制端不能抢占；转交使旧动作、暂停和退出全部失效', t => {
  const f = fixture(t); const p = f.make(); const old = f.enter(p);
  const next = f.world.createController(p.agent.agent_id, { name: '新端', kind: 'external' }); const auth2 = f.world.authenticate(next.token);
  assert.throws(() => f.world.callTool(auth2, 'join_world'), { code: 'CONTROLLER_BUSY' });
  f.world.ownerControl(p.agent.agent_id, 'transfer', { controller_id: next.controller_id });
  f.world.callTool(auth2, 'join_world');
  for (const name of ['pause_self', 'leave_world']) assert.throws(() => f.world.callTool(p.auth, name, { run_id: old.run_id, session_epoch: old.session_epoch }), { code: 'CONTROLLER_BUSY' });
  assert.throws(() => f.world.callTool(p.auth, 'act', { run_id: old.run_id, session_epoch: old.session_epoch, action_id: old.next_action_id, type: 'say', payload: { channel: 'nearby', text: '迟到消息' } }), { code: 'CONTROLLER_BUSY' });
  assert.equal(f.world.ownerSnapshot().agents[0].status, 'active');
});

test('动作幂等重取不重复事件；改变同 ID 内容拒绝；暂停后可重取', t => {
  const f = fixture(t); const p = f.make(); const o = f.enter(p);
  const request = { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'say', payload: { channel: 'nearby', text: '你好' } };
  const first = f.world.callTool(p.auth, 'act', request); const revision = f.world.state.room.world_revision;
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), first); assert.equal(f.world.state.room.world_revision, revision);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...request, payload: { channel: 'nearby', text: '变更' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.world.ownerControl(p.agent.agent_id, 'pause');
  assert.deepEqual(f.world.callTool(p.auth, 'get_action_result', { action_id: request.action_id }), first);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), first);
});

test('业务拒绝消耗动作 ID，限流不消耗且可原样重试', t => {
  const f = fixture(t, { actionIntervalMs: 2000 }); const p = f.make(); f.enter(p);
  const before = f.observe(p); const bad = f.act(p, 'move', { x: 23, y: 15 });
  assert.equal(bad.status, 'rejected'); assert.equal(bad.error.code, 'INVALID_ACTION'); assert.notEqual(bad.next_action_id, before.next_action_id);
  const request = { ...f.session(p), action_id: bad.next_action_id, type: 'wait', payload: {} };
  assert.throws(() => f.world.callTool(p.auth, 'act', request), { code: 'RATE_LIMITED' });
  assert.equal(f.observe(p).next_action_id, bad.next_action_id); f.advance(2000);
  assert.equal(f.world.callTool(p.auth, 'act', request).status, 'applied');
});

test('附近消息在提交时固定收件人，后来走近不补收', t => {
  const f = fixture(t); const a = f.make('甲'); const b = f.make('乙'); f.enter(a); const cursor = f.enter(b).cursor;
  for (let i = 0; i < 3; i++) { assert.equal(f.act(b, 'move', { x: 13 + i * 3, y: 8 }).status,'applied'); f.advance(1500); }
  assert.equal(f.act(a, 'say', { channel: 'nearby', text: '远处听不到' }).status, 'applied');
  for (let i = 0; i < 3; i++) { assert.equal(f.act(b, 'move', { x: 16 - i * 3, y: 8 }).status,'applied'); f.advance(1500); }
  assert.equal(f.events(b, cursor).events.filter(e => e.type === 'message').length, 0);
  f.act(a, 'say', { channel: 'nearby', text: '现在听得到' });
  assert.deepEqual(f.events(b, cursor).events.filter(e => e.type === 'message').map(e => e.payload.text), ['现在听得到']);
  assert.equal(f.world.publicSnapshot().events.filter(e => e.type === 'message').length, 2);
});

test('观察限制曼哈顿半径，移动边界与 200 Unicode 字符校验', t => {
  const f = fixture(t); const a = f.make('甲'); const b = f.make('乙'); f.enter(a); f.enter(b);
  assert.equal(f.observe(a).nearby_agents.length, 1);
  f.act(b, 'move', { x: 13, y: 8 }); f.advance(1500); f.act(b, 'move', { x: 16, y: 8 }); f.advance(1500);
  assert.equal(f.observe(a).nearby_agents.length, 0);
  assert.equal(f.act(a, 'move', { x: -1, y: 7 }).error.code, 'INVALID_ACTION');
  assert.equal(f.act(a, 'say', { channel: 'nearby', text: '🌱'.repeat(200) }).status, 'applied');
  assert.equal(f.act(a, 'say', { channel: 'nearby', text: '🌱'.repeat(201) }).error.code, 'INVALID_ACTION');
});

test('邀请接受后跨距离组内发言，离组后停止接收', t => {
  const f = fixture(t); const a = f.make('甲'); const b = f.make('乙'); f.enter(a); f.enter(b);
  const group_id = f.act(a, 'create_group').group_id; const invite_id = f.act(a, 'invite', { group_id, target_agent_id: b.agent.agent_id }).invite_id;
  assert.equal(f.observe(b).invitations[0].invite_id, invite_id); f.act(b, 'respond_invite', { invite_id, accept: true });
  f.act(b, 'move', { x: 13, y: 8 }); f.advance(1500); f.act(b, 'move', { x: 16, y: 8 }); f.advance(1500);
  const cursor = f.observe(b).cursor; f.act(a, 'say', { channel: 'group', group_id, text: '远处的小组消息' });
  assert.equal(f.events(b, cursor).events.filter(e => e.type === 'message').length, 1);
  f.act(b, 'leave_group', { group_id }); const leftCursor = f.observe(b).cursor;
  f.act(a, 'say', { channel: 'group', group_id, text: '离组后消息' });
  assert.equal(f.events(b, leftCursor).events.filter(e => e.type === 'message').length, 0);
});

test('邀请过期与重复邀请冷却由服务端执行', t => {
  const f = fixture(t); const a = f.make('甲'); const b = f.make('乙'); f.enter(a); f.enter(b);
  const group_id = f.act(a, 'create_group').group_id; const payload = { group_id, target_agent_id: b.agent.agent_id };
  const invite_id = f.act(a, 'invite', payload).invite_id;
  assert.equal(f.act(a, 'invite', payload).error.code, 'INVITE_PENDING');
  for (let i = 0; i < 5; i++) { f.observe(a); f.observe(b); f.advance(30000); }
  assert.equal(f.act(b, 'respond_invite', { invite_id, accept: true }).error.code, 'INVITE_EXPIRED');
  f.observe(a); f.observe(b); f.advance(30000);
  assert.equal(f.act(a, 'invite', payload).status, 'applied');
});

function gameFixture(t) {
  const f = fixture(t); const a = f.make('甲'); const b = f.make('乙'); f.enter(a); f.enter(b);
  const group_id = f.act(a, 'create_group').group_id;
  const invite_id = f.act(a, 'invite', { group_id, target_agent_id: b.agent.agent_id }).invite_id; f.act(b, 'respond_invite', { invite_id, accept: true });
  const game_id = f.act(a, 'propose_game', { group_id, game_type: 'word_chain' }).game_id;
  f.act(b, 'respond_game', { game_id, accept: true });
  for (let i = 0; i < 5; i++) { f.observe(a); f.observe(b); f.advance(30000); }
  f.observe(a); f.observe(b); return { ...f, a, b, group_id, game_id };
}

test('两角色接龙完成 10 次答案并结算，错词不换回合，旧轮次拒绝', t => {
  const f = gameFixture(t); const initial = f.observe(f.a).game; assert.equal(initial.status, 'active');
  assert.equal(f.act(f.a, 'submit_word', { game_id: f.game_id, turn_id: initial.turn_id, word: '苹果' }).error.code, 'INVALID_WORD');
  assert.equal(f.observe(f.a).game.turn_id, initial.turn_id);
  const chain = ['气球', '球场', '场地', '地球', '球迷', '迷人', '人民', '民族', '族群', '群山'];
  for (const [i, word] of chain.entries()) {
    const p = i % 2 ? f.b : f.a; const game = f.observe(p).game;
    assert.equal(f.act(p, 'submit_word', { game_id: f.game_id, turn_id: game.turn_id, word }).status, 'applied');
    if (i === 0) assert.equal(f.act(f.b, 'submit_word', { game_id: f.game_id, turn_id: initial.turn_id, word: '球场' }).error.code, 'STALE_TURN');
  }
  const game = f.observe(f.a).game; assert.equal(game.status, 'finished'); assert.equal(game.valid_count, 10);
  assert.deepEqual(Object.values(game.scores), [5, 5]);
});

test('游戏超时会换回合，整轮超时结束，不无限卡住', t => {
  const f = gameFixture(t); const first = f.observe(f.a).game.current_agent_id;
  for (let i = 0; i < 5; i++) { f.observe(f.a); f.observe(f.b); f.advance(30000); }
  assert.notEqual(f.observe(f.a).game.current_agent_id, first);
  for (let i = 0; i < 5; i++) { f.observe(f.a); f.observe(f.b); f.advance(30000); }
  assert.equal(f.world.publicSnapshot().game.status, 'finished');
  assert.match(f.world.publicSnapshot().game.end_reason, /均超时/);
});

test('暂停退出小组和游戏；恢复创建新预算；旧模型结果不生效', t => {
  const f = gameFixture(t); const old = f.observe(f.a);
  f.world.ownerControl(f.a.agent.agent_id, 'pause');
  assert.equal(f.world.publicSnapshot().game.status, 'finished'); assert.equal(f.world.agent(f.a.agent.agent_id).group_id, null);
  f.world.ownerControl(f.a.agent.agent_id, 'resume', { max_calls: 5 }); const current = f.enter(f.a);
  assert.notEqual(current.run_id, old.run_id); assert.ok(current.session_epoch > old.session_epoch);
  assert.throws(() => f.world.callTool(f.a.auth, 'act', { run_id: old.run_id, session_epoch: old.session_epoch, action_id: old.next_action_id, type: 'wait' }), { code: 'STALE_SESSION' });
});

test('诊断报告和查询不续租；45 秒离线后重连不延长期限', t => {
  const f = fixture(t); const a = f.make(); const initial = f.enter(a); f.advance(30000);
  f.world.callTool(a.auth, 'report_status', { ...f.session(a), state: 'thinking', calls_used: 1 });
  f.world.callTool(a.auth, 'get_control_state'); f.advance(15000);
  assert.equal(f.world.agent(a.agent.agent_id).status, 'offline');
  const again = f.enter(a); assert.equal(again.expires_at, initial.expires_at); assert.equal(again.run_id, initial.run_id); assert.ok(again.session_epoch > initial.session_epoch);
});

test('长轮询响应不续租，暂停后等待返回控制状态', t => {
  const f = fixture(t); const a = f.make(); f.enter(a); const args = { ...f.session(a), cursor: f.observe(a).cursor };
  f.world.callTool(a.auth, 'get_events', args); f.advance(20000); f.world.peekEvents(a.auth, args); f.advance(25000);
  assert.equal(f.world.agent(a.agent.agent_id).status, 'offline');
  f.enter(a); const newArgs = f.session(a); f.world.ownerControl(a.agent.agent_id, 'pause');
  assert.equal(f.world.peekEvents(a.auth, newArgs).control_state.status, 'paused');
});

test('诊断可清空错误，计数不回退；转交暂时保留原有占位', t => {
  const f = fixture(t); const people = Array.from({ length: 6 }, (_, i) => f.make(`访客${i}`));
  for (const p of people.slice(0, 5)) f.enter(p);
  const a = people[0];
  f.world.callTool(a.auth, 'report_status', { ...f.session(a), state: 'error', calls_used: 2, last_error: '临时失败' });
  f.world.callTool(a.auth, 'report_status', { ...f.session(a), state: 'waiting', calls_used: 2, last_error: null });
  assert.equal(f.world.callTool(a.auth, 'get_control_state').diagnostics.last_error, null);
  assert.throws(() => f.world.callTool(a.auth, 'report_status', { ...f.session(a), state: 'waiting', calls_used: 1 }), { code: 'INVALID_ACTION' });
  const next = f.world.createController(a.agent.agent_id, {});
  f.world.ownerControl(a.agent.agent_id, 'transfer', { controller_id: next.controller_id });
  assert.throws(() => f.enter(people[5]), { code: 'ROOM_FULL' });
  assert.equal(f.world.callTool(f.world.authenticate(next.token), 'join_world').self.status, 'active');
});

test('授权截止自动暂停，召回后不能自动入场，房间暂停禁止入场', t => {
  const f = fixture(t); const a = f.make('甲', false);
  f.world.ownerControl(a.agent.agent_id, 'start', { duration_minutes: 0.01 }); f.enter(a); f.advance(601);
  assert.equal(f.world.agent(a.agent.agent_id).run.status, 'paused'); assert.throws(() => f.enter(a), { code: 'RUN_EXPIRED' });
  f.world.ownerControl(a.agent.agent_id, 'resume'); f.enter(a); f.world.ownerControl(a.agent.agent_id, 'recall');
  assert.throws(() => f.enter(a), { code: 'NOT_AUTHORIZED' });
  f.world.ownerRoom('pause'); assert.throws(() => f.world.ownerControl(a.agent.agent_id, 'resume'), { code: 'ROOM_PAUSED' });
});

test('旧 pause_self 回执可重取但不能暂停新预算段', t => {
  const f = fixture(t); const a = f.make(); f.enter(a); const args = { ...f.session(a), reason: '结束预算' };
  const old = f.world.callTool(a.auth, 'pause_self', args);
  f.world.ownerControl(a.agent.agent_id, 'resume'); f.enter(a);
  assert.deepEqual(f.world.callTool(a.auth, 'pause_self', args), old);
  assert.equal(f.world.agent(a.agent.agent_id).status, 'active');
});

test('游标超过十分钟补取窗口时返回一致快照', t => {
  const f = fixture(t); const a = f.make(); const first = f.enter(a); f.act(a, 'say', { channel: 'nearby', text: '很久以前' });
  for (let i = 0; i < 21; i++) { f.advance(30000); f.observe(a); }
  const result = f.events(a, first.cursor);
  assert.equal(result.cursor_expired, true); assert.equal(result.snapshot.cursor, result.next_cursor); assert.deepEqual(result.events, []);
});

test('SQLite 重启保留预算、动作回执与凭证，清理 presence 并递增 epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-world-')); const dbPath = join(dir, 'state.db'); let world;
  try {
    world = new World({ dbPath }); const a = world.createAgent({ name: '持久角色' }); const c = world.createController(a.agent_id, {}); const auth = world.authenticate(c.token);
    world.ownerControl(a.agent_id, 'start'); const joined = world.callTool(auth, 'join_world');
    const receipt = world.callTool(auth, 'act', { run_id: joined.run_id, session_epoch: joined.session_epoch, action_id: joined.next_action_id, type: 'wait' });
    world.close(); world = new World({ dbPath });
    const restored = world.callTool(world.authenticate(c.token), 'get_control_state');
    assert.equal(restored.status, 'offline'); assert.equal(restored.run.expires_at, joined.expires_at); assert.ok(restored.session_epoch > joined.session_epoch); assert.equal(restored.run.has_joined, true);
    assert.deepEqual(world.callTool(auth, 'get_action_result', { action_id: joined.next_action_id }), receipt);
  } finally { world?.close(); rmSync(dir, { recursive: true, force: true }); }
});
