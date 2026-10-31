import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { createApp } from '../server/index.js';

function fixture(t) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const make = (name = '原来的 AI', minutes = 15) => {
    const agent = world.createAgent({ name, bio: '保留我的性格', owner_id: 'PRIVATE_OWNER' });
    const controller = world.createController(agent.agent_id);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: minutes, max_calls: 100, goal: 'PRIVATE_GOAL' });
    const auth = world.authenticate(controller.token);
    const observation = world.callTool(auth, 'join_world');
    return { agent, controller, auth, session: { run_id: observation.run_id, session_epoch: observation.session_epoch } };
  };
  const observe = person => world.callTool(person.auth, 'observe', person.session);
  const request = (person, type, payload = {}) => ({ ...person.session, action_id: observe(person).next_action_id, type, payload });
  const act = (person, type, payload = {}) => world.callTool(person.auth, 'act', request(person, type, payload));
  const walk = (person, x, y) => {
    let position = observe(person).self.position;
    while (position.x !== x || position.y !== y) {
      const target = position.x !== x ? { x: position.x + Math.sign(x - position.x) * Math.min(3, Math.abs(x - position.x)), y: position.y } : { x, y: position.y + Math.sign(y - position.y) * Math.min(3, Math.abs(y - position.y)) };
      assert.equal(act(person, 'move', target).status, 'applied'); position = target;
    }
  };
  const advance = (ms, connected = []) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 20000); world.tick();
      for (const person of connected) observe(person);
    }
  };
  return { world, make, observe, request, act, walk, advance, now: () => now };
}
const finished = world => world.state.events.filter(event => event.type === 'activity_finished');
const solve = activity => activity.task.prompt.match(/\d+/g).map(Number).reduce((sum, value) => sum + value, 0);

test('地点、阅读原文和活动目录可供 AI 观察，返回数据不能修改世界目录', t => {
  const f = fixture(t), p = f.make();
  const rules = f.world.callTool(p.auth, 'get_rules');
  assert.deepEqual(rules.places.map(({ id, x, y, radius }) => ({ id, x, y, radius })), [
    { id: 'pond', x: 4, y: 4, radius: 3 }, { id: 'garden', x: 11, y: 8, radius: 3 },
    { id: 'reading', x: 19, y: 4, radius: 3 }, { id: 'play', x: 19, y: 12, radius: 3 },
  ]);
  assert.equal(rules.activities.find(a => a.id === 'read').content.source, '广场原创');
  assert.ok(rules.activities.find(a => a.id === 'read').content.text.length > 60);
  const observation = f.observe(p);
  assert.deepEqual(observation.places, rules.places); assert.deepEqual(observation.activities, rules.activities);
  assert.equal(observation.server_time, f.now());
  assert.ok(observation.allowed_actions.includes('start_activity'));
  assert.ok(observation.allowed_actions.includes('finish_activity'));
  rules.places[0].x = 999; observation.activities[0].duration_seconds = 1;
  assert.equal(f.world.getRules().places[0].x, 4); assert.equal(f.world.getRules().activities[0].duration_seconds, 45);
});

test('没有旁观者和其他角色，活动仍随世界时钟完成，读取不代替 AI 续租', t => {
  const f = fixture(t), p = f.make();
  f.walk(p, 4, 4);
  const started = f.act(p, 'start_activity', { activity_id: 'watch_pond' });
  assert.equal(started.status, 'applied'); assert.equal(started.activity.ends_at - started.activity.started_at, 45000);
  f.advance(45000, [p]);
  assert.equal(f.world.agent(p.agent.agent_id).activity, null);
  assert.equal(finished(f.world).length, 1); assert.equal(finished(f.world)[0].payload.outcome, 'completed');
  assert.equal(f.world.agent(p.agent.agent_id).status, 'active');
  f.world.tick(); assert.equal(finished(f.world).length, 1);
  const contact = f.world.agent(p.agent.agent_id).last_contact_at;
  spectatorSnapshot(f.world); assert.equal(f.world.agent(p.agent.agent_id).last_contact_at, contact);
});

test('开始活动校验地点、活动 ID 和参数，失败不会替换现有活动', t => {
  const f = fixture(t), p = f.make();
  for (const payload of [{ activity_id: 'watch_pond' }, { activity_id: 'douyin' }, { activity_id: 'relax', duration_seconds: 0 }, { activity_id: 3 }]) {
    const result = f.act(p, 'start_activity', payload);
    assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'INVALID_ACTION');
  }
  f.walk(p, 7, 4); // Manhattan radius boundary is inclusive.
  assert.equal(f.act(p, 'start_activity', { activity_id: 'watch_pond' }).status, 'applied');
  const activity = f.observe(p).self.activity;
  assert.equal(f.act(p, 'start_activity', { activity_id: 'relax' }).error.code, 'ACTIVITY_BUSY');
  assert.deepEqual(f.observe(p).self.activity, activity);
  assert.equal(f.act(p, 'finish_activity', { answer: 12 }).status, 'rejected');
  assert.deepEqual(f.observe(p).self.activity, activity);
});

test('活动动作原 ID 重试不会重复开始、完成或发放分数', t => {
  const f = fixture(t), p = f.make(); f.walk(p, 19, 12);
  const args = f.request(p, 'start_activity', { activity_id: 'solo_game' });
  const started = f.world.callTool(p.auth, 'act', args);
  assert.deepEqual(f.world.callTool(p.auth, 'act', args), started);
  assert.equal(f.world.state.events.filter(event => event.type === 'activity_started').length, 1);
  assert.throws(() => f.world.callTool(p.auth, 'act', { ...args, payload: { activity_id: 'relax' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const finish = f.request(p, 'finish_activity', { answer: solve(started.activity) });
  const result = f.world.callTool(p.auth, 'act', finish);
  assert.equal(result.result.score, 1); assert.equal(result.result.max_score, 1);
  assert.deepEqual(f.world.callTool(p.auth, 'act', finish), result);
  assert.equal(finished(f.world).length, 1);
  assert.equal(f.world.agent(p.agent.agent_id).activity_answer, undefined);
  assert.equal(f.act(p, 'finish_activity').status, 'rejected');
});

test('心算题真实校验答案：格式无效不结束，错误与超时均不得分', t => {
  const f = fixture(t), p = f.make(); f.walk(p, 19, 12);
  const started = f.act(p, 'start_activity', { activity_id: 'solo_game' });
  for (const answer of ['12', 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(f.act(p, 'finish_activity', { answer }).status, 'rejected');
    assert.ok(f.observe(p).self.activity);
  }
  const result = f.act(p, 'finish_activity', { answer: solve(started.activity) + 1 });
  assert.equal(result.outcome, 'completed'); assert.equal(result.result.score, 0);
  assert.equal(f.act(p, 'start_activity', { activity_id: 'solo_game' }).status, 'applied');
  f.advance(150000, [p]);
  assert.equal(finished(f.world).at(-1).payload.result.score, 0);
  assert.match(finished(f.world).at(-1).payload.result.summary, /未提交答案/);
});

test('移动、主动结束、暂停、召回、离线和到期都会取消活动且不会伪造完成', async t => {
  for (const stop of ['move', 'finish_activity', 'pause', 'recall', 'offline', 'expired']) await t.test(stop, t => {
    const f = fixture(t), p = f.make('原来的 AI', stop === 'expired' ? 0.5 : 15);
    assert.equal(f.act(p, 'start_activity', { activity_id: 'relax' }).status, 'applied');
    if (stop === 'move') f.act(p, 'move', { x: 10, y: 7 });
    else if (stop === 'finish_activity') f.act(p, 'finish_activity');
    else if (stop === 'offline') f.advance(45000);
    else if (stop === 'expired') f.advance(30000);
    else f.world.ownerControl(p.agent.agent_id, stop);
    assert.equal(f.world.agent(p.agent.agent_id).activity, null);
    assert.equal(finished(f.world).length, 1);
    assert.equal(finished(f.world)[0].payload.outcome, 'cancelled');
    assert.equal(finished(f.world)[0].payload.result, undefined);
    f.advance(90000); assert.equal(finished(f.world).length, 1);
  });
});

test('报名接龙后不能再开始独处活动；已开始的活动在接龙开局时取消', t => {
  const f = fixture(t), a = f.make('朋友甲'), b = f.make('朋友乙');
  assert.equal(f.act(a, 'start_activity', { activity_id: 'treasure_hunt' }).status, 'applied');
  const group = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id: group, target_agent_id: b.agent.agent_id });
  f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  const game = f.act(a, 'propose_game', { group_id: group });
  f.act(b, 'respond_game', { game_id: game.game_id, accept: true });
  assert.equal(f.act(b, 'start_activity', { activity_id: 'relax' }).error.code, 'GAME_BUSY');
  f.advance(150000, [a, b]);
  assert.equal(f.world.state.game.status, 'active'); assert.equal(f.observe(a).self.activity, null);
  assert.equal(finished(f.world).at(-1).payload.outcome, 'cancelled');
});

test('活动公开投影只暴露题面和公开结果，不泄露答案、私有字段或取消原因', t => {
  const f = fixture(t), p = f.make(); f.walk(p, 19, 12);
  f.act(p, 'start_activity', { activity_id: 'solo_game' });
  const a = f.world.agent(p.agent.agent_id);
  a.activity.private = 'PRIVATE_ACTIVITY'; a.activity.task.answer = 'PRIVATE_TASK_ANSWER';
  a.diagnostics.last_error = 'PRIVATE_ERROR';
  const active = spectatorSnapshot(f.world);
  assert.match(active.agents[0].activity.task.prompt, /^\d+ \+ \d+ = \?$/);
  assert.doesNotMatch(JSON.stringify(active), /PRIVATE_|activity_answer|"answer"|run_id|controller_id|session_epoch/);
  assert.doesNotMatch(JSON.stringify(f.world.publicAgent(a)), /PRIVATE_|activity_answer|"answer"/);
  f.world.callTool(p.auth, 'pause_self', { ...p.session, reason: 'PRIVATE_STOP_REASON' });
  const event = finished(f.world).at(-1);
  event.payload.private = 'PRIVATE_EVENT';
  event.payload.result = { summary: '公开结果', secret: 'PRIVATE_RESULT' };
  assert.doesNotMatch(JSON.stringify(spectatorSnapshot(f.world)), /PRIVATE_|activity_answer|"answer"|run_id|controller_id|session_epoch/);
});

test('长时许可最多365天，重连保持同一预算、截止时间与控制权', t => {
  const f = fixture(t), p = f.make('常驻访客', 525600);
  const before = f.world.callTool(p.auth, 'get_control_state');
  assert.equal(before.run.expires_at - f.now(), 525600 * 60000);
  f.advance(45000);
  const joined = f.world.callTool(p.auth, 'join_world');
  assert.equal(joined.run_id, before.run.run_id); assert.equal(joined.expires_at, before.run.expires_at);
  assert.equal(f.world.callTool(p.auth, 'get_control_state').run.max_calls, 100);
  f.world.ownerControl(p.agent.agent_id, 'pause');
  assert.throws(() => f.world.ownerControl(p.agent.agent_id, 'resume', { duration_minutes: 525601 }), { code: 'INVALID_ACTION' });
  assert.throws(() => f.world.ownerControl(p.agent.agent_id, 'resume', { duration_minutes: 525600, max_calls: 1000000001 }), { code: 'INVALID_ACTION' });
});

test('HTTP MCP 活动能力与 dsh-pet 状态可用；匿名旁观只看到公开活动', async t => {
  const application = await createApp({ dbPath: ':memory:', frontend: false, seed: false, demo: false });
  application.world.actionIntervalMs = 0;
  const { server, url } = await application.start(0);
  const agent = application.world.createAgent({ name: '我的宠物' });
  const controller = application.world.createController(agent.agent_id);
  application.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 10080 });
  const client = new Client({ name: 'activity-test', version: '0.5.0' });
  t.after(async () => { await client.close(); await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return result.structuredContent || JSON.parse(result.content[0].text); };
  const definitions = (await client.listTools()).tools;
  assert.ok(definitions.find(tool => tool.name === 'act').inputSchema.properties.type.enum.includes('start_activity'));
  assert.ok(definitions.find(tool => tool.name === 'report_status').inputSchema.properties.mode.enum.includes('dsh-pet'));
  const joined = await call('join_world'); const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  assert.equal((await call('report_status', { ...session, mode: 'dsh-pet', state: 'idle', calls_used: 0 })).ok, true);
  const started = await call('act', { ...session, action_id: joined.next_action_id, type: 'start_activity', payload: { activity_id: 'relax' } });
  assert.equal(started.status, 'applied');
  const response = await fetch(`${url}/api/public/world`); assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.agents[0].activity.activity_id, 'relax'); assert.equal(snapshot.places.length, 4);
  assert.ok(snapshot.events.some(event => event.type === 'activity_started'));
  assert.doesNotMatch(JSON.stringify(snapshot), /run_id|controller_id|session_epoch|token|activity_answer/);
  assert.equal((await call('act', { ...session, action_id: started.next_action_id, type: 'finish_activity', payload: {} })).outcome, 'cancelled');
});
