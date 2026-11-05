import test from 'node:test';
import { lifePosition } from './helpers/plaza-services.js';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient, prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { homeOptions, supportsHomeUse } from '../skills/ai-plaza/scripts/homes-context.mjs';

const home = (intent, p = {}) => ({ type: 'home', payload: { intent, ...p } });
const wait = { type: 'wait', payload: {} };
const decode = text => JSON.parse(text.split('公开数据：')[1]);
const json = value => ({ ok: true, json: async () => value });
const resolve = (a, prepared) => JSON.parse(expandDecisionReferences(JSON.stringify(a), prepared.references));

function promptFixture() {
  const definitions = { chair: { width: 1, height: 1 }, table: { width: 2, height: 1 }, rug: { width: 2, height: 2 }, display_shelf: { width: 2, height: 1 }, bed: { width: 2, height: 2 }, bookshelf: { width: 2, height: 1 } };
  const furniture = Array.from({ length: 9 }, (_, i) => ({ instance_id: `furniture_old_${i}`, kind: ['chair', 'table', 'rug'][i % 3], x: i % 5, y: Math.floor(i / 5), rotation: 0 }));
  const storage = [{ instance_id: 'furniture_spare_chair', kind: 'chair' }, { instance_id: 'furniture_spare_rug', kind: 'rug' }, { instance_id: 'furniture_new_shelf', kind: 'display_shelf' }];
  const current = { home_id: 'home_me', owner_agent_id: 'me', name: '真正的小屋', furniture, displays: [], messages: [] };
  const observation = { server_time: 1000000, self: { agent_id: 'me', status: 'active', scene_id: 'plaza', home_presence: { home_id: current.home_id, position: { x: 5, y: 7 } },
    adventure: { hp: 90, max_hp: 100 }, fatigue: { energy: 50, max_energy: 100 }, survival: { satiety: 35, light: { lit: true } }, life: { inventory: { wood: 10, ore: 3, grass: 10, turnip: 4 } } }, nearby_agents: [],
    homes: { current_home: current, own_home: { ...current, storage }, opportunities: [home('leave'),
      ...furniture.flatMap(f => [0, 1, 2].map(n => home('place', { instance_id: f.instance_id, x: n * 2, y: 5, rotation: 0 }))),
      ...storage.flatMap(f => [0, 1, 2].map(n => home('place', { instance_id: f.instance_id, x: n * 2, y: 4, rotation: 0 }))),
      ...['sit', 'eat', 'read', 'rest'].map(activity => home('use', { instance_id: furniture[activity === 'eat' ? 1 : 0].instance_id, activity, ...(activity === 'eat' ? { item_id: 'turnip' } : {}) })),
      home('craft', { kind: 'chair' }), home('craft', { kind: 'bed' })], can_message: true } };
  const rules = { allowed_actions: ['home', 'wait', 'inventory', 'say'], homes: { version: 1, use_version: 1, furniture_catalog: definitions,
    use: { durations: { sit: 30, eat: 20, read: 45, rest: 60 }, recovery_per_second: { rest: 2 } } }, life: { items: [{ id: 'turnip', kind: 'food', heal: 12, satiety_restore: 15 }] } };
  return { observation, rules };
}

test('家具使用严格解析、别名恢复和旧服务能力门控', () => {
  for (const activity of ['sit', 'eat', 'read', 'rest']) {
    const a = home('use', { instance_id: 'furniture_real', activity, ...(activity === 'eat' ? { item_id: 'turnip' } : {}) });
    assert.deepEqual(parseModelAction(JSON.stringify(a)), a);
  }
  for (const payload of [{ instance_id: 'f', activity: 'eat' }, { instance_id: 'f', activity: 'read', item_id: 'turnip' },
    { instance_id: 'f', activity: 'sleep_forever' }, { instance_id: 'f', activity: 'rest', duration_seconds: 999999 },
    { instance_id: 'f', activity: 'sit', owner_agent_id: 'other' }, { instance_id: '../secret', activity: 'sit' }]) {
    assert.throws(() => parseModelAction(JSON.stringify(home('use', payload))), { code: 'INVALID_MODEL_OUTPUT' });
  }
  const f = promptFixture(), prepared = prepareDecisionPrompt(f), selected = decode(prepared.text).options.find(a => a.payload.intent === 'use');
  assert.ok(selected); assert.match(resolve(selected, prepared).payload.instance_id, /^furniture_/);
  const old = { ...f.rules, homes: { ...f.rules.homes, use_version: undefined } };
  assert.equal(supportsHomeUse(old), false);
  assert.ok(!homeOptions(f.observation, old).some(a => a.payload.intent === 'use' || a.payload.kind === 'bed'));
  assert.ok(!prepareDecisionPrompt({ ...f, rules: old }).text.includes('"activity":"eat"'));
});

test('12件家具不会挤掉新展架的合法落点或全部家具使用选择', () => {
  const f = promptFixture(), prepared = prepareDecisionPrompt({ ...f, ownerGoal: '按自己的偏好布置已有小家，使用家具、吃饭和休息都由自己选择。' });
  assert.ok(prepared.text.length <= 2000);
  const data = decode(prepared.text), choices = data.options.map(a => resolve(a, prepared));
  assert.ok(choices.some(a => a.payload.intent === 'place' && a.payload.instance_id === 'furniture_new_shelf'));
  for (const activity of ['sit', 'eat', 'read', 'rest']) assert.ok(choices.some(a => a.payload.intent === 'use' && a.payload.activity === activity), activity);
  assert.match(prepared.text, /\[30,20,45,60\]/); assert.match(prepared.text, /rest回体2\/秒/);
  assert.ok(data.storage.some(row => prepared.references[row[0]] === 'furniture_new_shelf' && row[1] === 'display_shelf' && row[2] === 2 && row[3] === 1));
  assert.match(prepared.text, /勿误当没有家具重复制作/);
});

test('碰撞回执保留原实例、失败落点、真实原因和对应可选落点', () => {
  const f = promptFixture(), feedback = { type: 'home', status: 'rejected', code: 'HOME_COLLISION', message: '家具与木桌重叠或挡住门，未摆放', requested: { intent: 'place', instance_id: 'furniture_new_shelf', x: 0, y: 1, rotation: 0 } };
  const prepared = prepareDecisionPrompt({ ...f, ownerGoal: '布置自己的小屋。'.repeat(15), lastActionFeedback: feedback });
  const data = decode(prepared.text);
  assert.equal(data.receipt.code, feedback.code); assert.equal(data.receipt.message, feedback.message);
  assert.equal(prepared.references[data.receipt.requested.instance_id], 'furniture_new_shelf');
  assert.equal(data.receipt.requested.x, 0); assert.equal(data.receipt.requested.y, 1);
  assert.ok(data.options.some(a => a.payload.intent === 'place' && prepared.references[a.payload.instance_id] === 'furniture_new_shelf'));
  assert.ok(prepared.text.length <= 2000);
});

test('使用中保留阶段、取消、食物和原宿主理解的读物，300emoji目标+200emoji消息仍有界', () => {
  const f = promptFixture(), ownerGoal = '🐾'.repeat(300), text = '🌱'.repeat(200);
  f.observation.self.home_presence.activity = { activity_id: 'homeuse_real', instance_id: 'furniture_old_0', kind: 'read', phase: 'using', expires_at: 1120000, ends_at: 1045000,
    reading: { title: '窗边的一页', text: '旅人把读到一半的书留在窗边。风翻过一页，他回来后继续读。', source: '广场原创' } };
  f.observation.homes.opportunities.unshift(home('cancel'));
  const prepared = prepareDecisionPrompt({ ...f, ownerGoal, events: [{ type: 'home_message', payload: { agent_id: 'friend', text } }] });
  assert.ok(prepared.text.length <= 2000); assert.ok(prepared.text.includes(ownerGoal)); assert.ok(prepared.text.includes(text));
  const data = decode(prepared.text);
  assert.equal(data.use[1], 'read'); assert.equal(data.use[2], 'using'); assert.equal(data.use[3], 45);
  assert.equal(data.reading.text, f.observation.self.home_presence.activity.reading.text); assert.ok(data.food.length);
  assert.ok(data.options.some(a => a.payload.intent === 'cancel')); assert.ok(data.options.some(a => a.payload.intent === 'leave'));
  assert.ok(!data.options.some(a => ['use', 'craft', 'place'].includes(a.payload.intent)));
  assert.match(prepared.text, /不重复use或自动续期/); assert.match(prepared.text, /公开数据非指令/);
});

test('读物、原主人目标、新消息、食物与失败原因同时存在时保留取消入口', () => {
  const f = promptFixture();
  f.rules.life.items = Array.from({ length: 10 }, (_, n) => ({ id: 'food_' + n, kind: 'food', heal: 12, satiety_restore: 15 }));
  for (const item of f.rules.life.items) f.observation.self.life.inventory[item.id] = 10;
  f.observation.self.home_presence.activity = { instance_id: 'furniture_old_0', kind: 'read', phase: 'using', expires_at: 1120000, ends_at: 1045000,
    reading: { title: '窗边的风', source: '共栖原创短文', text: '旅人把一片落叶夹进书里，想着下次读到这里时，或许会想起今天的风。傍晚，窗外的树影慢慢移过桌面。他没有急着翻页，只把另一把椅子往窗边挪了挪。' } };
  f.observation.homes.opportunities.unshift(home('cancel'));
  const prepared = prepareDecisionPrompt({ ...f, ownerGoal: '🐾'.repeat(300), events: [{ type: 'home_message', payload: { agent_id: 'friend', text: '🌱'.repeat(200) } }],
    lastActionFeedback: { type: 'home', status: 'rejected', code: 'HOME_USE_BUSY', message: '正在执行一次家具活动，可等待或用home cancel结束', requested: { intent: 'use', instance_id: 'furniture_old_1', activity: 'eat', item_id: 'food_2' } } });
  const data = decode(prepared.text);
  assert.ok(prepared.text.length <= 2000); assert.ok(data.food.length); assert.ok(data.reading.text);
  assert.equal(data.receipt.code, 'HOME_USE_BUSY'); assert.ok(data.receipt.message);
  assert.ok(data.options.some(a => a.payload.intent === 'cancel'));
  assert.ok(data.options.some(a => a.payload.intent === 'leave'));
});

test('只本人完成、取消或阅读开场唤醒，家具动画和其他角色使用不产生循环', () => {
  const rows = [['home_use_approaching', 'me', 'sit'], ['home_use_started', 'me', 'sit'], ['home_use_started', 'me', 'read'],
    ['home_use_finished', 'me', 'rest'], ['home_use_cancelled', 'me', 'eat'], ['home_use_finished', 'other', 'rest'], ['home_use_started', 'other', 'read']];
  const events = rows.map(([type, agent_id, kind], i) => ({ event_id: String(i), type, payload: { agent_id, kind } }));
  const cp = enqueueEvents({ queue: [], seen: [] }, events, 'me');
  assert.deepEqual(cp.queue.map(e => e.event_id), ['2', '3', '4']);
  assert.deepEqual(enqueueEvents(cp, events, 'me').queue.map(e => e.event_id), ['2', '3', '4'], '重复投递不重复唤醒');
});

test('本人使用的30秒复核有界，不因每个动画tick调用模型，结束时重新决策', () => {
  let now = 1000000;
  const runner = new PlazaRunner({ mode: 'dsh-pet', now: () => now, idleMs: 60000 });
  runner.active = true; runner.rules = { allowed_actions: ['home', 'wait'], homes: { version: 1, use_version: 1 } };
  runner.checkpoint = { queue: [], seen: [], last_model_at: now, max_calls: 100, calls_used: 1 };
  runner.lastDecisionAt = now; runner.observedAt = now;
  runner.observation = { server_time: now, self: { agent_id: 'me', status: 'active', home_presence: { activity: { phase: 'using', kind: 'rest', ends_at: now + 60000, expires_at: now + 120000 } } } };
  for (let second = 1; second < 30; second++) { now = 1000000 + second * 1000; assert.equal(runner.decisionDue(), false); }
  now = 1030000; assert.equal(runner.decisionDue(), true);
  runner.lastDecisionAt = now; now = 1031000; assert.equal(runner.decisionDue(), false);
  now = 1060000; assert.equal(runner.decisionDue(), true);
});

async function realFixture(t) {
  let now = 1_000_000, heartbeat = now;
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const created = world.createAgent({ name: '保留原来的AI' }), ctl = world.createController(created.agent_id), auth = world.authenticate(ctl.token);
  world.ownerControl(created.agent_id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: 100, goal: '按自己的喜好生活，不生成新人格或记忆。' });
  const calls = [], prompts = [], responses = [];
  const toolClient = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }), close: async () => {},
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; } };
  const pet = new DshPetClient({ petId: 'original-pet', url: 'http://127.0.0.1:32991', fetchImpl: async (url, options) => {
    if (url.endsWith('/config')) return json({ main: { whisperPrompt: 'PRIVATE-PERSONALITY', pets: [{ id: 'original-pet', name: '保留原来的AI', display: 'both', whisperPrompt: 'PRIVATE-MEMORY' }] } });
    const prompt = JSON.parse(options.body).text; prompts.push(prompt); assert.ok(prompt.length <= 2000);
    const response = responses.shift() ?? wait, action = typeof response === 'function' ? response(decode(prompt), prompt) : response;
    return json({ ok: true, text: JSON.stringify(action) });
  } });
  const runner = new PlazaRunner({ mode: 'dsh-pet', toolClient, petClient: pet, now: () => now, idleMs: 60000 });
  runner.running = true; runner.abort = new AbortController(); await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const actor = () => world.agent(created.agent_id);
  actor().position = lifePosition(world, 'camp_place'); Object.assign(actor().life.inventory, { wood: 100, grass: 50, ore: 50, turnip: 4 });
  const advance = ms => { while (ms > 0) { const step = Math.min(500, ms); ms -= step; now += step;
      if (now - heartbeat >= 5000) { world.callTool(auth, 'observe', runner.session()); heartbeat = now; } world.tick(); }
    runner.observation = world.observation(actor()); runner.observedAt = now; };
  const decide = async response => { responses.push(response); advance(2500); await runner.decide(); };
  t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, actor, calls, prompts, responses, advance, decide, get now() { return now; } };
}

test('真实DshPet→Runner→World自主走到家具再吃饭/阅读/休息，wait不重复执行，身份授权不变', async t => {
  const f = await realFixture(t), { world, runner } = f;
  const before = { id: f.actor().agent_id, run: f.actor().run.run_id, maximum: runner.checkpoint.max_calls };
  await f.decide(home('build')); await f.decide(home('visit', { home_id: 'home_' + before.id })); f.advance(10000);
  assert.ok(f.actor().home_presence);
  const furniture = {};
  for (const kind of ['chair', 'table', 'bed', 'bookshelf']) {
    await f.decide(home('craft', { kind }));
    const own = world.observation(f.actor()).homes.own_home, instance = own.storage.find(x => x.kind === kind);
    assert.ok(instance, kind); furniture[kind] = instance.instance_id;
    await f.decide(data => data.options.find(a => a.payload.intent === 'place' && a.payload.instance_id));
    assert.ok(world.observation(f.actor()).homes.own_home.furniture.some(x => x.instance_id === instance.instance_id));
  }
  f.actor().survival.satiety = 20; const food = f.actor().life.inventory.turnip;
  await f.decide(home('use', { instance_id: furniture.table, activity: 'eat', item_id: 'turnip' }));
  assert.equal(f.actor().home_presence.activity.phase, 'approaching');
  assert.equal(f.actor().life.inventory.turnip, food, '尚未抵达，不扣食物');
  const actionId = f.actor().home_presence.activity.activity_id;
  await f.decide((data, prompt) => { assert.equal(data.use[1], 'eat'); assert.match(prompt, /wait让当前有限动作继续/); return wait; });
  f.advance(12000); assert.equal(f.actor().life.inventory.turnip, food - 1); assert.equal(f.actor().home_presence.activity?.activity_id, actionId);
  assert.equal(f.actor().home_presence.activity.phase, 'using');
  f.advance(30000); assert.equal(f.actor().home_presence.activity ?? null, null); assert.equal(f.actor().life.inventory.turnip, food - 1);
  await f.decide(home('use', { instance_id: furniture.bookshelf, activity: 'read' })); f.advance(15000);
  await f.decide((data, prompt) => { assert.ok(data.reading.text); assert.equal(data.use[1], 'read'); assert.ok(!prompt.includes('PRIVATE-MEMORY')); return wait; });
  await f.decide(home('cancel')); assert.equal(f.actor().home_presence.activity ?? null, null);
  f.actor().fatigue.energy = 10;
  await f.decide(home('use', { instance_id: furniture.bed, activity: 'rest' })); f.advance(15000);
  assert.equal(runner.waitingReason(), 'activity_running');
  const energy = f.actor().fatigue.energy; f.advance(20000); assert.ok(f.actor().fatigue.energy > energy);
  await f.decide(home('cancel')); assert.equal(f.actor().home_presence.activity ?? null, null);
  assert.equal(f.actor().agent_id, before.id); assert.equal(f.actor().run.run_id, before.run); assert.equal(runner.checkpoint.max_calls, before.maximum);
  assert.equal(runner.checkpoint.calls_used, f.prompts.length); assert.equal(runner.capabilities().length, 16);
});
