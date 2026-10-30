import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createApp } from '../server/index.js';
import { World } from '../server/world.js';
import { attachSpectator, spectatorSnapshot } from '../server/spectator.js';

async function fixture(t, accounts = false) {
  const application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', frontend: false, seed: false, demo: false,
    ...(accounts ? { authMode: 'accounts', publicUrl: 'http://plaza.example:3000', allowHttp: true } : {}) });
  if (accounts) await application.accounts.createAdmin({ username: 'spectator_admin', password: 'Only-for-spectator-tests-2026!', name: '管理员' });
  const { server, url } = await application.start(0);
  t.after(async () => { await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { application, world: application.world, url };
}
function character(world, name = '公开小芽') {
  const agent = world.createAgent({ name, bio: '公开介绍', owner_id: 'PRIVATE_OWNER' });
  const controller = world.createController(agent.agent_id, { name: 'PRIVATE_CONTROLLER' });
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 15, max_calls: 100, goal: 'PRIVATE_GOAL' });
  const auth = world.authenticate(controller.token);
  const observation = world.callTool(auth, 'join_world');
  return { agent, controller, auth, observation };
}
async function stream(t, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      let buffer = '';
      const frames = [], waiters = [];
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const waiter = waiters.shift();
          if (waiter) waiter(frame); else frames.push(frame);
        }
      });
      t.after(() => { response.destroy(); request.destroy(); });
      resolve({ response, request, next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((r, j) => {
        const timer = setTimeout(() => j(new Error('SSE frame timed out')), 3000);
        waiters.push(frame => { clearTimeout(timer); r(frame); });
      }) });
    });
    request.on('error', reject);
  });
}
const snapshotFrame = frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));

test('匿名旁观：快照无cookie，主人接口和写操作仍要求认证', async t => {
  const f = await fixture(t, true);
  const c = character(f.world);
  const response = await fetch(`${f.url}/api/public/world`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  const result = await response.json();
  assert.equal(result.agents[0].name, '公开小芽'); assert.equal(result.agents[0].status, 'active');
  assert.equal((await fetch(`${f.url}/api/world`)).status, 401);
  const options = { method: 'POST', headers: { Origin: f.application.config.publicUrl.origin, 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${f.url}/api/agents/${c.agent.agent_id}/control`, options)).status, 401);
  assert.equal((await fetch(`${f.url}/api/room/control`, options)).status, 401);
  assert.equal((await fetch(`${f.url}/api/public/world`, options)).status, 401);
  assert.equal((await fetch(`${f.url}/mcp`, { ...options, headers: { 'Content-Type': 'application/json' } })).status, 401);
  const health = await (await fetch(`${f.url}/api/health`)).json();
  assert.equal(health.capabilities.public_spectator, true); assert.equal(health.capabilities.skill_pairing, true);
});

test('公开投影：仅保留公开字段与事件，身份、预算、诊断、邀请和私人暂停原因不会泄露', t => {
  const world = new World(); t.after(() => world.close());
  const c = character(world);
  const a = world.agent(c.agent.agent_id);
  a.diagnostics.last_error = 'PRIVATE_ERROR'; a.position.hidden = 'PRIVATE_POSITION';
  a.run.extra = 'PRIVATE_RUN'; a.pause_reason = 'PRIVATE_PAUSE';
  world.state.room.extra = 'PRIVATE_ROOM';
  world.state.groups.publicGroup = { group_id: 'publicGroup', name: '公开小组', members: [a.agent_id], owner_id: 'PRIVATE_GROUP_OWNER', created_at: 123 };
  world.state.game = { game_id: 'publicGame', group_id: 'publicGroup', status: 'active', participants: [a.agent_id], current_agent_id: a.agent_id, last_word: '天气', words: ['天气'], valid_count: 0, deadline: 500,
    turn_id: 'PRIVATE_TURN', responses: { secret: 'PRIVATE_RESPONSE' }, timeouts: { private: 'PRIVATE_TIMEOUT' }, scores: { [a.agent_id]: 1, PRIVATE_SCORE_KEY: 99 }, end_reason: 'PRIVATE_GAME_REASON' };
  world.event('message', { agent_id: a.agent_id, name: a.name, text: '这是公开发言', channel: 'group', group_id: 'publicGroup', owner_id: 'PRIVATE_EVENT_OWNER', token: c.controller.token }, [a.agent_id]);
  world.event('invitation', { text: 'PRIVATE_INVITE_TEXT', invite_id: 'PRIVATE_INVITE_ID' }, [a.agent_id]);
  world.event('invitation_declined', { text: 'PRIVATE_DECLINE' }, [a.agent_id]);
  world.event('agent_paused', { agent_id: a.agent_id, text: 'PRIVATE_REASON_IN_TEXT', reason: 'PRIVATE_REASON' }, [a.agent_id]);
  world.event('agent_left', { agent_id: a.agent_id, text: '公开小芽离开了广场', reason: 'PRIVATE_LEFT_REASON' }, []);
  world.event('game_turn', { agent_id: a.agent_id, game_id: 'publicGame', text: '轮到公开小芽接词', turn_id: 'PRIVATE_TURN_EVENT', deadline: 500, last_word: '天气' }, []);
  world.event('game_finished', { game_id: 'publicGame', group_id: 'publicGroup', text: 'PRIVATE_GAME_REASON_TEXT', reason: 'PRIVATE_GAME_REASON_EVENT', valid_count: 2, scores: { [a.agent_id]: 2 } }, []);
  world.event('constructor', { text: 'PRIVATE_UNKNOWN_EVENT' }, []);
  const snapshot = spectatorSnapshot(world);
  const json = JSON.stringify(snapshot);
  assert.doesNotMatch(json, /PRIVATE_|owner_id|controller_id|token|run_id|session_epoch|diagnostics|recipients|invite_id|turn_id/);
  assert.ok(!json.includes(c.controller.token)); assert.ok(!json.includes(c.controller.controller_id));
  assert.deepEqual(snapshot.agents[0].position, { x: a.position.x, y: a.position.y });
  assert.ok(snapshot.events.some(event => event.type === 'message' && event.payload.text === '这是公开发言'));
  assert.ok(snapshot.events.some(event => event.type === 'game_turn'));
  assert.equal(snapshot.events.at(-1).payload.text, '词语接龙已结束');
  assert.equal(snapshot.game.end_reason, null);
  for (let i = 0; i < 170; i++) world.event('message', { text: `公开 ${i}`, channel: 'nearby' }, []);
  assert.equal(spectatorSnapshot(world).events.length, 150);
});

test('匿名 SSE：初始快照与真实交流实时送达，重连无cookie且数据同样经过公开投影', async t => {
  const f = await fixture(t);
  const c = character(f.world);
  const watch = await stream(t, `${f.url}/api/public/events`);
  assert.equal(watch.response.statusCode, 200); assert.equal(watch.response.headers['set-cookie'], undefined);
  assert.equal(snapshotFrame(await watch.next()).agents[0].agent_id, c.agent.agent_id);
  f.world.callTool(c.auth, 'act', { run_id: c.observation.run_id, session_epoch: c.observation.session_epoch, action_id: c.observation.next_action_id, type: 'say', payload: { channel: 'nearby', text: '旁观者应该看到这句话' } });
  const updated = snapshotFrame(await watch.next());
  assert.ok(updated.events.some(event => event.payload.text === '旁观者应该看到这句话'));
  assert.doesNotMatch(JSON.stringify(updated), /PRIVATE_|run_id|session_epoch|controller_id|token/);
  const second = await stream(t, `${f.url}/api/public/events`);
  assert.ok(snapshotFrame(await second.next()).events.some(event => event.payload.text === '旁观者应该看到这句话'));
});

test('旁观增量SSE仅发送变化和新事件，重连恢复完整快照', async t => {
  const f = await fixture(t), c = character(f.world);
  for (let i = 0; i < 150; i++) f.world.event('message', { agent_id: c.agent.agent_id, name: '公开小芽', channel: 'nearby', text: `历史${i}` });
  const watch = await stream(t, `${f.url}/api/public/events?delta=1`);
  const initial = snapshotFrame(await watch.next());
  const o = f.world.callTool(c.auth, 'observe', c.observation);
  f.world.callTool(c.auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'say', payload: { channel: 'nearby', text: '增量消息' } });
  const frame = await watch.next();
  assert.match(frame, /^event: delta/);
  const delta = JSON.parse(frame.split('\ndata: ')[1]);
  assert.equal(delta.events.length, 1); assert.equal(delta.events[0].payload.text, '增量消息');
  assert.equal(delta.activities, undefined);
  assert.doesNotMatch(JSON.stringify(delta), /PRIVATE_|run_id|session_epoch|controller_id|token/);
  const { events, event_reset, ...rest } = delta;
  const merged = { ...initial, ...rest, events: event_reset ? events : [...initial.events, ...events].slice(-150) };
  const reopened = await stream(t, `${f.url}/api/public/events?delta=1`);
  const recovered = snapshotFrame(await reopened.next());
  assert.deepEqual(merged.events, recovered.events);
  assert.deepEqual(merged.agents, recovered.agents);
});

test('旁观读取和重连不改变世界、不续AI租约，离线仍按世界时钟执行', async t => {
  const f = await fixture(t);
  let now = Date.now(); f.world.now = () => now;
  const c = character(f.world);
  const contact = f.world.agent(c.agent.agent_id).last_contact_at;
  const before = JSON.stringify(f.world.state);
  await (await fetch(`${f.url}/api/public/world`)).json();
  const one = await stream(t, `${f.url}/api/public/events`); await one.next();
  const two = await stream(t, `${f.url}/api/public/events`); await two.next();
  assert.equal(JSON.stringify(f.world.state), before);
  assert.equal(f.world.agent(c.agent.agent_id).last_contact_at, contact);
  now += 45001; f.world.tick();
  const after = await (await fetch(`${f.url}/api/public/world`)).json();
  assert.equal(after.agents[0].status, 'offline');
  assert.equal(f.world.agent(c.agent.agent_id).last_contact_at, contact);
});

test('公开 SSE 有独立连接限制、心跳和断开清理，不信任伪造代理IP', async t => {
  const world = new World();
  const app = express();
  const spectator = attachSpectator(app, world, { maxStreams: 2, maxPerIp: 1, heartbeatMs: 15 });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { spectator.close(); world.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const first = await stream(t, `${url}/api/public/events`); await first.next();
  assert.equal(spectator.count, 1);
  assert.equal(await first.next(), ': heartbeat');
  const denied = await fetch(`${url}/api/public/events`, { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '15'); await denied.json();
  first.response.destroy(); first.request.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(spectator.count, 0);
  const replacement = await stream(t, `${url}/api/public/events`); await replacement.next();
  assert.equal(spectator.count, 1);
  spectator.close(); assert.equal(spectator.count, 0); assert.equal(world.listenerCount('change'), 0);
});

test('匿名接口继续校验 Host 与 Origin，不允许跨站来源或DNS重绑定', async t => {
  const f = await fixture(t, true);
  assert.equal((await fetch(`${f.url}/api/public/world`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const status = await new Promise((resolve, reject) => http.get(`${f.url}/api/public/world`, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(status, 403);
});

test('30个匿名旁观连接到达单IP上限后，主人实时连接仍可使用', async t => {
  const f = await fixture(t);
  const watchers = await Promise.all(Array.from({ length: 30 }, () => stream(t, `${f.url}/api/public/events`)));
  await Promise.all(watchers.map(watch => watch.next()));
  const rejected = await fetch(`${f.url}/api/public/events`);
  assert.equal(rejected.status, 429); await rejected.json();
  const session = await fetch(`${f.url}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0]; await session.json();
  const owner = await stream(t, `${f.url}/api/events`, { Cookie: cookie });
  assert.equal(owner.response.statusCode, 200);
  assert.equal(snapshotFrame(await owner.next()).viewer.id, 'local-owner');
  assert.equal((await fetch(`${f.url}/api/public/world`)).status, 200);
});
