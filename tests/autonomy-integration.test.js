import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { createBridge } from '../skills/ai-plaza/scripts/bridge.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message) {
  const deadline = Date.now() + 12000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await sleep(40);
  }
}

// These are transport/loop tests with a deterministic original-host substitute, not a claim
// that a real dsh-pet model or the user's paid account has been exercised.
async function fixture(t, choose) {
  const folder = mkdtempSync(join(tmpdir(), 'plaza-autonomy-'));
  const app = await createApp({ dbPath: ':memory:', demo: false, seed: false, frontend: false });
  const { server, url } = await app.start(0);
  let now = Date.now(), clock;
  app.world.now = () => now;
  const requests = [], bridges = [];
  const capability = 'p'.repeat(43);
  const petServer = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      assert.equal(request.headers.authorization, undefined, '广场令牌不能发送给宠物');
      assert.equal(request.headers['x-dsh-pet-token'], capability);
      const path = new URL(request.url, 'http://127.0.0.1');
      if (path.pathname.endsWith('/config')) {
        response.end(JSON.stringify({ original: { pets: [{ id: 'alpha', name: '原 Alpha' }, { id: 'beta', name: '原 Beta' }] } }));
        return;
      }
      assert.equal(path.pathname, '/dsh-pet-7340/chat');
      assert.equal(request.method, 'POST');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(body.text.length <= 2000);
      assert.ok(body.text.includes('PRIVATE_OWNER_GOAL'), '主人本次要求仅发给对应原 AI');
      const data = JSON.parse(body.text.slice(body.text.indexOf('公开数据：') + '公开数据：'.length));
      const record = { pet: path.searchParams.get('pet'), data, prompt: body.text };
      requests.push(record);
      const action = choose(record, requests);
      response.end(JSON.stringify({ ok: true, text: JSON.stringify(action) }));
    } catch (error) {
      requests.push({ error: error.message });
      response.statusCode = 500; response.end(JSON.stringify({ ok: false }));
    }
  });
  await new Promise(resolve => petServer.listen(0, '127.0.0.1', resolve));
  const runtimePath = join(folder, 'runtime.json');
  writeFileSync(runtimePath, JSON.stringify({ port: petServer.address().port, token: capability }));
  t.after(async () => {
    clearInterval(clock);
    await Promise.allSettled(bridges.map(bridge => bridge.stop()));
    await app.close();
    server.closeAllConnections(); petServer.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => petServer.close(resolve))]);
    rmSync(folder, { recursive: true, force: true });
  });
  async function resident(pet) {
    const agent = app.world.createAgent({ name: pet === 'alpha' ? '原 Alpha' : '原 Beta', bio: '原宿主管理身份' });
    const controller = app.world.createController(agent.agent_id);
    app.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 15, max_calls: 30, goal: 'PRIVATE_OWNER_GOAL' });
    const statePath = join(folder, pet + '.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, url, token: controller.token, agent_id: agent.agent_id, controller_id: controller.controller_id }));
    const bridge = await createBridge({ statePath, runtimePath, petId: pet, now: () => now, idleSeconds: 30, start: false,
      fetchImpl: (address, options) => {
        assert.equal(new URL(address).origin, url);
        assert.equal(options.headers['X-DSH-Pet-Token'], undefined, '本机能力令牌不能发送给广场');
        return fetch(address, options);
      } });
    bridges.push(bridge);
    bridge.runner.pollSeconds = 0;
    bridge.runner.start(); await bridge.runner.ready;
    return { bridge, agent, controller };
  }
  const startClock = () => { clock = setInterval(() => { now += 2000; app.world.tick(); }, 50); };
  return { app, requests, resident, startClock, now: () => now };
}

test('常驻桥经真实 HTTP/MCP：无观众、无人发言也主动开始活动，结束后继续行动', async t => {
  const f = await fixture(t, (_record, requests) => requests.length === 1
    ? { type: 'start_activity', payload: { activity_id: 'relax' } }
    : { type: 'move', payload: { x: 10, y: 7 } });
  const { agent, bridge } = await f.resident('alpha');
  f.startClock();
  await until(() => f.app.world.agent(agent.agent_id).activity, '原 AI 未在无人触发时开始独处活动');
  const end = f.app.world.agent(agent.agent_id).activity.ends_at;
  await until(() => f.now() >= end - 20000, '活动时钟未推进');
  assert.equal(f.requests.length, 1, '休息中空轮询不应不断调用原 AI');
  await until(() => f.app.world.state.events.some(event => event.type === 'agent_moved'), '活动完成后未再次自行行动');
  const events = f.app.world.state.events;
  assert.ok(events.some(event => event.type === 'activity_finished' && event.payload.outcome === 'completed'));
  assert.ok(!f.requests.some(request => request.error), JSON.stringify(f.requests));
  assert.ok(bridge.runner.checkpoint.calls_used >= 2);
  assert.equal(f.app.world.activeIds().length, 1);
  assert.equal(f.requests[0].pet, 'alpha');
  const { spectatorSnapshot } = await import('../server/spectator.js');
  assert.ok(!JSON.stringify(spectatorSnapshot(f.app.world)).includes('PRIVATE_OWNER_GOAL'));
  f.app.world.ownerControl(agent.agent_id, 'pause');
  await until(() => !bridge.runner.active, '主人暂停未停止接入调度');
  const spent = f.requests.length;
  await sleep(900);
  assert.equal(f.requests.length, spent, '暂停后不能因空闲时钟继续调用原 AI');
});

test('两个原宿主经本机桥互相收到公开发言，回复来自各自接口且无观众参与', async t => {
  const f = await fixture(t, (record, requests) => {
    const own = requests.filter(request => request.pet === record.pet);
    if (own.length === 1) return { type: 'say', payload: { channel: 'nearby', text: `${record.pet}：来自原宿主的问候` } };
    const heard = record.data.events?.find(event => event.type === 'message' && event.text?.includes('来自原宿主的问候'));
    if (heard && !own.slice(0, -1).some(request => request.replied)) {
      record.replied = true;
      return { type: 'say', payload: { channel: 'nearby', text: `${record.pet}：我听见了你` } };
    }
    return { type: 'wait', payload: {} };
  });
  await f.resident('alpha'); await f.resident('beta'); f.startClock();
  await until(() => ['alpha', 'beta'].every(pet => f.app.world.state.events.some(event => event.type === 'message' && event.payload.text === `${pet}：我听见了你`)), '两个原 AI 未收到并回应对方的发言');
  assert.ok(!f.requests.some(request => request.error), JSON.stringify(f.requests));
  const messages = f.app.world.state.events.filter(event => event.type === 'message');
  assert.ok(messages.some(event => event.payload.text === 'alpha：我听见了你'));
  assert.ok(messages.some(event => event.payload.text === 'beta：我听见了你'));
  assert.equal(f.app.world.activeIds().length, 2);
});
