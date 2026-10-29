import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DshPetClient, decisionPrompt, localPetUrl, resolvePetConnection } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';

function temporary(t) {
  const root = resolve(tmpdir()); const directory = mkdtempSync(join(root, 'plaza-pet-test-'));
  t.after(() => { assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const json = value => ({ ok: true, json: async () => value });
const config = (...ids) => ({ main: { whisperPrompt: 'private-persona-not-exported', pets: ids.map(id => ({ id, name: id + '原名', display: 'both', whisperPrompt: 'private-persona' })) } });

async function fixture(t, { replies = ['{"type":"wait","payload":{}}'], checkpointPath, petId = 'main', oldServer = false, response } = {}) {
  let now = Date.now(); const requests = []; const toolCalls = [];
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const agent = world.createAgent({ name: '原角色' });
  const controller = world.createController(agent.agent_id, { kind: 'external' });
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 20 });
  const auth = world.authenticate(controller.token);
  const client = {
    listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      toolCalls.push({ name, args });
      return { structuredContent: oldServer && name === 'get_rules' ? { skill_version: '0.1.0' } : world.callTool(auth, name, args) };
    }, close: async () => {},
  };
  const home = temporary(t);
  const pet = new DshPetClient({ petId, url: 'http://127.0.0.1:32991', home, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/config')) return json(config(petId));
    if (response) return response(url, options);
    return json({ ok: true, text: replies.shift() ?? '{"type":"wait","payload":{}}' });
  } });
  const runner = new PlazaRunner({ mode: 'dsh-pet', petClient: pet, toolClient: client, checkpointPath, now: () => now, idleMs: 30000 });
  runner.running = true; runner.abort = new AbortController();
  t.after(async () => { await runner.stop(); world.close(); });
  return { runner, pet, world, agent, auth, requests, toolCalls, initialize: async () => {
    await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  }, advance: ms => { now += ms; } };
}

test('dsh-pet 本机发现读取实际端口，不猜端口、不允许公网或含凭据URL', t => {
  const home = temporary(t); mkdirSync(join(home, 'dsh-pet'));
  assert.throws(() => resolvePetConnection({ home }), e => e.code === 'PET_NOT_FOUND');
  for (const url of ['http://118.25.51.74:3000', 'http://127.0.0.1.example', 'http://user:secret@localhost:1', 'file:///tmp/pet', 'http://127.0.0.1:4/?token=x', 'http://localhost:5/other']) {
    assert.throws(() => localPetUrl(url), e => e.code === 'PET_URL');
  }
  const token = 'x'.repeat(43);
  writeFileSync(join(home, 'dsh-pet', 'standalone-runtime.json'), JSON.stringify({ port: 32992, token }));
  assert.deepEqual(resolvePetConnection({ home }), { baseUrl: 'http://127.0.0.1:32992/dsh-pet-7340', token });
  assert.equal(resolvePetConnection({ home, url: 'http://127.0.0.1:32993' }).token, undefined, '另一个本机服务也不获得该能力令牌');
});

test('dsh-pet 只列出实例公开标识，单只自动选，多只要求明确选择', async t => {
  const home = temporary(t); let calls = 0;
  const pet = new DshPetClient({ home, url: 'http://localhost:32991', fetchImpl: async () => { calls++; return json(config('a', 'b')); } });
  const pets = await pet.listPets();
  assert.deepEqual(pets.map(p => p.id), ['a', 'b']); assert.ok(!JSON.stringify(pets).includes('private-persona'));
  await assert.rejects(pet.initialize(), e => e.code === 'PET_SELECTION_REQUIRED');
  pet.petId = 'b'; await pet.initialize(); assert.equal(pet.name, 'b原名');
  assert.equal(calls, 3);
});

test('真实World目录ID、阅读原文和小游戏题目进入≤2000字符公开观察', t => {
  const world = new World({ actionIntervalMs: 0 }); t.after(() => world.close());
  const a = world.createAgent({ name: '读者' }); const c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id }); const auth = world.authenticate(c.token);
  world.callTool(auth, 'join_world');
  const mutable = world.agent(a.agent_id); mutable.position = { x: 19, y: 4 };
  world.perform(mutable, 'start_activity', { activity_id: 'read' });
  const observation = world.observation(mutable);
  const prompt = decisionPrompt({ observation: { ...observation, private_memory: 'PRIVATE_HISTORY' }, rules: world.getRules(), owner_goal: 'PRIVATE_GOAL', events: [{ type: 'message', payload: { text: '想聊聊这本书吗？', agent_id: 'friend' } }] });
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes('一张空椅子')); assert.ok(prompt.includes('雨停后'));
  assert.ok(prompt.includes('watch_pond')); assert.ok(prompt.includes('["reading",19,4,3]')); assert.ok(prompt.includes('想聊聊'));
  assert.ok(!prompt.includes('PRIVATE_HISTORY')); assert.ok(!prompt.includes('PRIVATE_GOAL'));
  JSON.parse(prompt.split('公开数据：')[1]);
  world.perform(mutable, 'finish_activity', {}); mutable.position = { x: 19, y: 12 };
  world.perform(mutable, 'start_activity', { activity_id: 'solo_game' });
  const question = world.observation(mutable);
  const soloPrompt = decisionPrompt({ observation: question, rules: world.getRules() });
  assert.ok(soloPrompt.includes(question.self.activity.task.prompt)); assert.ok(soloPrompt.length <= 2000);
});

test('严格动作JSON校验不把自然语言当发言，不允许任意字段/代码动作', () => {
  for (const bad of ['我想散步', '{"type":"shell","payload":{}}', '{"type":"say","payload":{"text":"x"}}', '{"type":"move","payload":{"x":1.5,"y":2}}', '{"type":"start_activity","payload":{"activity_id":"relax","url":"evil"}}', '{"type":"finish_activity","payload":{"answer":[]}}']) {
    assert.throws(() => parseModelAction(bad), e => e.code === 'INVALID_MODEL_OUTPUT');
  }
  assert.deepEqual(parseModelAction('{"type":"finish_activity","payload":{"answer":12}}'), { type: 'finish_activity', payload: { answer: 12 } });
});

test('旧服务器在任何原AI调用前明确要求升级', async t => {
  const f = await fixture(t, { oldServer: true });
  await assert.rejects(f.runner.initialize(), e => e.code === 'UPGRADE_REQUIRED');
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 0);
});

test('同一公开世界由两只原桌宠各自决策，保留不同回复与行动', async t => {
  const a = await fixture(t, { petId: 'quiet', replies: ['{"type":"say","payload":{"channel":"nearby","text":"我想安静看水"}}'] });
  const b = await fixture(t, { petId: 'lively', replies: ['{"type":"move","payload":{"x":10,"y":7}}'] });
  await a.initialize(); await b.initialize(); await a.runner.decide(); await b.runner.decide();
  assert.equal(a.toolCalls.find(c => c.name === 'act').args.payload.text, '我想安静看水');
  assert.equal(b.toolCalls.find(c => c.name === 'act').args.type, 'move');
  assert.ok(a.requests.find(r => r.options.method === 'POST').url.includes('pet=quiet'));
  assert.ok(b.requests.find(r => r.options.method === 'POST').url.includes('pet=lively'));
});

test('无人无事件也按时钟决策；普通活动中安静等待，社交事件唤醒', async t => {
  const f = await fixture(t); await f.initialize();
  f.runner.decisionJob = f.runner.decisionLoop();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(f.runner.checkpoint.calls_used, 1);
  f.advance(31000); await new Promise(r => setTimeout(r, 250));
  assert.equal(f.runner.checkpoint.calls_used, 2, '空事件也有周期决策');
  f.runner.observation.self.activity = { activity_id: 'relax', started_at: Date.now(), ends_at: Date.now() + 120000 };
  f.advance(31000); assert.equal(f.runner.decisionDue(), false);
  f.runner.checkpoint.queue.push({ type: 'message', payload: { agent_id: 'other', text: '你好' } });
  assert.equal(f.runner.decisionDue(), true);
});

test('read消费正文一次再等待；solo_game获取题面并完成，业务result不破坏回执', async t => {
  const f = await fixture(t); await f.initialize();
  const a = f.world.agent(f.agent.agent_id); a.position = { x: 19, y: 4 };
  f.world.perform(a, 'start_activity', { activity_id: 'read' });
  f.runner.observation = f.world.observation(a); f.advance(6000);
  assert.equal(f.runner.decisionDue(), true); await f.runner.decide();
  f.advance(6000); assert.equal(f.runner.decisionDue(), false);
  assert.ok(f.requests.at(-1).options.body.includes('雨停后'));
  f.world.perform(a, 'finish_activity', {}); a.position = { x: 19, y: 12 };
  f.world.perform(a, 'start_activity', { activity_id: 'solo_game' }); f.runner.observation = f.world.observation(a);
  f.advance(6000); assert.equal(f.runner.decisionDue(), true);
  const action = { type: 'finish_activity', payload: { answer: a.activity_answer } };
  f.pet.fetch = async (url, options) => { assert.ok(options.body.includes(a.activity.task.prompt)); return json({ ok: true, text: JSON.stringify(action) }); };
  await f.runner.decide();
  assert.equal(f.runner.observation.self.activity, null);
  assert.equal(f.runner.checkpoint.next_action_id, a.next_action_id);
  assert.equal(f.runner.checkpoint.pending_action, null);
  assert.equal(f.world.state.events.at(-1).payload.result.score, 1);
});

test('暂停或退出后丢弃迟到原桌宠回复，预算先落盘', async t => {
  const directory = temporary(t); const checkpointPath = join(directory, 'checkpoint.json');
  let complete; let started;
  const begun = new Promise(resolvePromise => { started = resolvePromise; });
  const f = await fixture(t, { checkpointPath, response: async () => {
    assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).calls_used, 1);
    started(); return new Promise(resolvePromise => { complete = () => resolvePromise(json({ ok: true, text: '{"type":"say","payload":{"channel":"nearby","text":"迟到"}}' })); });
  } });
  await f.initialize(); const decision = f.runner.decide(); await begun;
  f.runner.deactivate(); complete(); await decision;
  assert.equal(f.toolCalls.filter(c => c.name === 'act').length, 0); assert.equal(f.runner.checkpoint.calls_used, 1);
});

test('原桌宠坏JSON只纠正一次且记录真实错误，不产生伪造say', async t => {
  const f = await fixture(t, { response: async () => { f.advance(6000); return json({ ok: true, text: '好呀，我出去玩了' }); } });
  await f.initialize(); await f.runner.decide();
  assert.equal(f.runner.checkpoint.calls_used, 2); assert.equal(f.toolCalls.filter(c => c.name === 'act').length, 0);
  assert.ok(f.toolCalls.some(c => c.name === 'report_status' && c.args.last_error?.includes('JSON')));
});

test('活动回声过滤保留本人完成事件一次，防自发言循环', () => {
  const events = [
    { event_id: 'a', type: 'activity_started', payload: { agent_id: 'self' } },
    { event_id: 'b', type: 'activity_finished', payload: { agent_id: 'self' } },
    { event_id: 'c', type: 'activity_finished', payload: { agent_id: 'other' } },
  ];
  const cp = enqueueEvents({ queue: [], seen: [] }, events, 'self');
  assert.deepEqual(enqueueEvents(cp, events, 'self').queue.map(e => e.event_id), ['b']);
});

test('最后一次预算的未确认动作先结算回执，再暂停，不重复生成', async t => {
  const f = await fixture(t); await f.initialize();
  const cp = f.runner.checkpoint; cp.calls_used = cp.max_calls;
  cp.pending_action = { ...f.runner.session(), action_id: cp.next_action_id, type: 'say', payload: { channel: 'nearby', text: '最后一条' } };
  const receipt = f.world.callTool(f.auth, 'act', cp.pending_action); // Simulate a lost HTTP response.
  f.runner.decisionJob = f.runner.decisionLoop();
  await new Promise(r => setTimeout(r, 450));
  assert.equal(cp.pending_action, null); assert.equal(cp.next_action_id, receipt.next_action_id);
  assert.equal(f.toolCalls.filter(c => c.name === 'act').length, 0);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.equal(f.runner.active, false);
  assert.ok(f.toolCalls.findIndex(c => c.name === 'get_action_result') < f.toolCalls.findIndex(c => c.name === 'pause_self'));
});

test('主人活动要求只进入选中本机原AI的私有请求，不写公开动作或事件', async t => {
  const f = await fixture(t); await f.initialize();
  f.runner.goal = 'PRIVATE_OWNER_GOAL 只观察，不发言';
  await f.runner.decide();
  const request = f.requests.find(r => r.options.method === 'POST');
  assert.ok(request.options.body.includes('PRIVATE_OWNER_GOAL'));
  assert.ok(request.options.body.includes('不向广场复述'));
  assert.ok(!JSON.stringify(f.world.publicSnapshot()).includes('PRIVATE_OWNER_GOAL'));
});

test('桌宠能力令牌只发本机，所有请求拒绝重定向且不携带广场凭据', async t => {
  const home = temporary(t); mkdirSync(join(home, 'dsh-pet'));
  const token = 'y'.repeat(43); writeFileSync(join(home, 'dsh-pet', 'standalone-runtime.json'), JSON.stringify({ port: 32994, token }));
  const requests = [];
  const pet = new DshPetClient({ home, fetchImpl: async (url, options) => { requests.push({ url, options }); return json(url.endsWith('/config') ? config('one') : { ok: true, text: '{"type":"wait","payload":{}}' }); } });
  await pet.initialize(); await pet.decide({ observation: {}, rules: {}, events: [] });
  assert.equal(requests.length, 2);
  for (const r of requests) { assert.ok(r.url.startsWith('http://127.0.0.1:32994/')); assert.equal(r.options.redirect, 'error'); assert.equal(r.options.headers['X-DSH-Pet-Token'], token); assert.equal(r.options.headers.Authorization, undefined); assert.ok(!r.options.body?.includes(token)); }
  assert.equal(existsSync(join(home, 'dsh-pet', 'memory.json')), false);
});
