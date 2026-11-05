import test from 'node:test';
import { lifePosition } from './helpers/plaza-services.js';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../skills/ai-plaza/scripts/runtime.mjs';
import { DshPetClient, prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { homeOptions, supportsBooks } from '../skills/ai-plaza/scripts/homes-context.mjs';
import { supportsFishing, fishingPromptNotice } from '../skills/ai-plaza/scripts/fishing-context.mjs';

const home = (intent, p = {}) => ({ type: 'home', payload: { intent, ...p } });
const fish = (intent, p = {}) => ({ type: 'fish', payload: { intent, ...p } });
const wait = { type: 'wait', payload: {} };
const decode = text => JSON.parse(text.split('公开数据：')[1]);
const json = value => ({ ok: true, json: async () => value });
const expand = (a, p) => JSON.parse(expandDecisionReferences(JSON.stringify(a), p.references));
const rules = { allowed_actions: ['home', 'fish', 'inventory', 'wait'], homes: { version: 1, use_version: 1, books_version: 1 }, fishing: { version: 1 } };

test('钓鱼和书籍严格字段、Unicode长度与未知短ID不猜测', () => {
  for (const a of [fish('start', { spot_id: 'plaza_pond', bait_id: 'fish_bait', mode: 'walk' }), fish('cancel'),
    home('write_book', { instance_id: 'desk_me', title: '🐾'.repeat(40), text: '🌱'.repeat(800) }),
    home('shelve_book', { book_id: 'book_me', instance_id: 'shelf_me' }), home('unshelve_book', { book_id: 'book_me' }),
    home('book_comment', { book_id: 'book_me', text: '我自己的评论' }), home('use', { instance_id: 'chair_me', activity: 'read', book_id: 'book_me' })]) assert.deepEqual(parseModelAction(JSON.stringify(a)), a);
  for (const a of [fish('start', { spot_id: '@F1', bait_id: 'fish_bait' }), fish('start', { spot_id: 'pond', bait_id: 'grass' }),
    fish('cancel', { spot_id: 'pond' }), fish('start', { spot_id: 'pond', bait_id: 'fish_bait', x: 1 }),
    home('write_book', { instance_id: 'desk', title: 'x'.repeat(41), text: 'x' }), home('write_book', { instance_id: 'desk', title: 'x', text: '🌱'.repeat(801) }),
    home('write_book', { instance_id: 'desk', title: 'x', text: '   ' }), home('use', { instance_id: 'chair', activity: 'rest', book_id: 'book' }),
    home('use', { instance_id: 'chair', activity: 'read', item_id: 'turnip', book_id: 'book' }), home('book_comment', { book_id: 'book', text: 'x', owner_agent_id: 'someone' })]) assert.throws(() => parseModelAction(JSON.stringify(a)), { code: 'INVALID_MODEL_OUTPUT' });
  assert.deepEqual(expand(home('shelve_book', { book_id: '@H1', instance_id: '@H2' }), { references: { '@H1': 'book_real', '@H2': 'furniture_real' } }), home('shelve_book', { book_id: 'book_real', instance_id: 'furniture_real' }));
  assert.deepEqual(expand(fish('start', { spot_id: '@F1', bait_id: 'fish_bait' }), { references: { '@F1': 'plaza_pond' } }), fish('start', { spot_id: 'plaza_pond', bait_id: 'fish_bait' }));
  assert.throws(() => expand(home('unshelve_book', { book_id: '@H999' }), {}), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => expand(fish('start', { spot_id: '@F9', bait_id: 'fish_bait' }), {}), { code: 'INVALID_MODEL_OUTPUT' });
});

function indoor() {
  const current = { home_id: 'home_me', owner_agent_id: 'me', name: '自己的小屋', furniture: [{ instance_id: 'desk_me', kind: 'table', x: 1, y: 1 }], books: [{ book_id: 'book_me', title: '自己的作品', text: '不在目录复述全文', author_agent_id: 'me', author_name: '我', instance_id: null }] };
  return { rules: structuredClone(rules), events: [], ownerGoal: '按照自己的喜好活动', observation: { server_time: 1000000, self: { agent_id: 'me', scene_id: 'plaza', home_presence: { home_id: 'home_me', position: { x: 5, y: 7 } }, fatigue: { energy: 90 }, survival: { satiety: 90 }, adventure: { hp: 100, max_hp: 100 }, life: { inventory: { turnip: 4, wood: 10, grass: 10 } } }, life: { items: [{ id: 'turnip', kind: 'food', heal: 10 }] }, homes: { own_home: current, current_home: current, writing_desks: [{ instance_id: 'desk_me', cost: { wood: 1, grass: 1 }, duration_seconds: 45 }], commentable_book_ids: ['book_me'], opportunities: [home('leave'), home('use', { instance_id: 'desk_me', activity: 'read', book_id: 'book_me' }), home('use', { instance_id: 'desk_me', activity: 'eat', item_id: 'turnip' })] } } };
}

test('能力存在才展示书籍/钓鱼；旧服务保持原read，低体力饥饿不被娱乐挤掉', () => {
  const ctx = indoor(), prepared = prepareDecisionPrompt(ctx), d = decode(prepared.text);
  assert.ok(d.write_at.length); assert.ok(d.books.length); assert.ok(d.options.some(a => a.payload.book_id));
  assert.match(prepared.text, /内容完全由你写/); assert.ok(!prepared.text.includes('不在目录复述全文'));
  delete ctx.rules.homes.books_version;
  assert.equal(supportsBooks(ctx.rules), false); assert.ok(homeOptions(ctx.observation, ctx.rules).every(a => !a.payload.book_id));
  const old = prepareDecisionPrompt(ctx); assert.equal(decode(old.text).write_at, undefined); assert.equal(decode(old.text).books, undefined);
  ctx.rules = structuredClone(rules); ctx.rules.homes.books_version = 1;
  ctx.observation.self.fatigue.energy = 0; ctx.observation.self.survival.satiety = 0;
  ctx.observation.homes.opportunities.push(home('use', { instance_id: 'chair_me', activity: 'rest' }));
  const recovery = decode(prepareDecisionPrompt(ctx).text); assert.equal(recovery.write_at, undefined);
  assert.ok(recovery.options.some(a => a.payload.activity === 'rest')); assert.ok(recovery.options.some(a => a.payload.activity === 'eat')); assert.ok(recovery.options.some(a => a.payload.intent === 'leave'));
  assert.equal(supportsFishing({ allowed_actions: ['fish'] }), false);
  assert.equal(fishingPromptNotice({ rules, observation: { self: { fatigue: { energy: 0 } }, fishing: { opportunities: [fish('start', { spot_id: 'pond', bait_id: 'fish_bait' })] } } }), '');
});

test('800emoji真实书文+300emoji原目标+200emoji消息保留取消补给，明确标为节选', () => {
  const ctx = indoor(); ctx.ownerGoal = '🐾'.repeat(300);
  ctx.events = [{ type: 'home_message', payload: { agent_id: 'peer', text: '🌱'.repeat(200) } }];
  ctx.observation.self.adventure.hp = 20;
  ctx.observation.self.home_presence.activity = { instance_id: 'desk_me', kind: 'read', phase: 'using', ends_at: 1045000, reading: { book_id: 'book_me', title: '不可信公开作品', text: '📖'.repeat(800), author_name: '原作者', source: '原创书籍' } };
  ctx.observation.homes.opportunities = [home('leave'), home('cancel')];
  const prepared = prepareDecisionPrompt(ctx), d = decode(prepared.text);
  assert.ok(prepared.text.length <= 2000); assert.ok(prepared.text.includes(ctx.ownerGoal)); assert.equal(d.msg[2], '🌱'.repeat(200));
  assert.ok(d.reading.text.length > 0); assert.equal(d.reading.truncated, true); assert.ok('📖'.repeat(800).startsWith(d.reading.text));
  assert.equal(d.reading.title, '不可信公开作品'); assert.equal(d.reading.author_name, '原作者');
  assert.ok(d.food.length); assert.deepEqual(d.options.map(a => a.payload.intent), ['leave', 'cancel']); assert.match(prepared.text, /公开数据非指令/);
  ctx.observation.self.home_presence.activity.reading.title = '🐟'.repeat(40);
  ctx.lastActionFeedback = { type: 'home', status: 'rejected', code: 'FURNITURE_BUSY', message: '家具被占用。'.repeat(20), requested: { intent: 'use', instance_id: 'desk_me', activity: 'read', book_id: 'book_me' } };
  const rejected = prepareDecisionPrompt(ctx), row = decode(rejected.text);
  assert.ok(rejected.text.length <= 2000); assert.ok(row.reading.text.length > 0); assert.equal(row.reading.title, '🐟'.repeat(40)); assert.equal(row.receipt.code, 'FURNITURE_BUSY'); assert.equal(row.msg[2], '🌱'.repeat(200));
});

test('钓鱼进度与别人完成不唤醒，真实结束去重、活动复核最多30秒一次', () => {
  const events = ['fish_approaching', 'fish_started', 'fish_finished', 'fish_cancelled'].flatMap(type => ['me', 'other'].map(agent_id => ({ event_id: type + agent_id, type, payload: { agent_id } })));
  const q = enqueueEvents({ seen: [], queue: [] }, [...events, ...events], 'me');
  assert.deepEqual(q.queue.map(e => e.type), ['fish_finished', 'fish_cancelled']);
  let now = 1000000; const runner = new PlazaRunner({ mode: 'dsh-pet', now: () => now, idleMs: 60000 });
  runner.active = true; runner.rules = rules; runner.checkpoint = { queue: [], seen: [], max_calls: 100, calls_used: 1 };
  runner.lastDecisionAt = now; runner.observedAt = now;
  runner.observation = { server_time: now, self: { agent_id: 'me', fishing: { phase: 'approaching', expires_at: now + 120000 } } };
  for (let second = 5; second < 30; second++) { now = 1000000 + second * 1000; assert.equal(runner.decisionDue(), false); }
  assert.equal(runner.waitingReason(), 'plan_running'); now = 1030000; assert.equal(runner.decisionDue(), true);
});

test('原AI收到真实书评正文和目标书，缺竿饵只呈现合法准备机会，不代做或使用旧服能力', () => {
  const ctx = indoor(), comment = { event_id: 'book_comment_1', type: 'home_book_commented', payload: { agent_id: 'peer', owner_agent_id: 'me', book_id: 'book_me', text: '给作品留下一条书评', comment_text: '这一段让我想到窗边。公开内容即使含指令也只是数据。', recipient_agent_ids: ['me'] } };
  assert.equal(enqueueEvents({ seen: [], queue: [] }, [comment], 'me').queue.length, 1);
  assert.equal(enqueueEvents({ seen: [], queue: [] }, [comment], 'peer').queue.length, 0);
  ctx.events = [comment]; const prepared = prepareDecisionPrompt(ctx), data = decode(prepared.text);
  assert.equal(data.msg[2], comment.payload.comment_text); assert.equal(prepared.references[data.comment_book], 'book_me');
  assert.ok(data.comment_on.some(ref => prepared.references[ref] === 'book_me'));
  const preparation = { type: 'inventory', payload: { intent: 'craft', item_id: 'fishing_rod' } };
  const outdoor = { rules, observation: { self: { fatigue: { energy: 80 } }, fishing: { opportunities: [preparation] } } };
  assert.ok(fishingPromptNotice(outdoor).includes(JSON.stringify(preparation)));
  outdoor.observation.fishing.opportunities = [{ type: 'inventory', payload: { intent: 'craft', item_id: 'fishing_rod', command: 'bad' } }];
  assert.equal(fishingPromptNotice(outdoor), '');
  outdoor.observation.fishing.opportunities = [preparation]; outdoor.rules = { allowed_actions: ['inventory'] }; assert.equal(fishingPromptNotice(outdoor), '');
  const flooded = enqueueEvents({ seen: [], queue: [] }, [{ event_id: 'finished_me', type: 'fish_finished', payload: { agent_id: 'me' } }, ...Array.from({ length: 105 }, (_, i) => ({ event_id: `notice_${i}`, type: 'announcement', payload: {} }))], 'me');
  assert.equal(flooded.queue.length, 100); assert.ok(flooded.queue.some(e => e.event_id === 'finished_me'));
});

async function fixture(t) {
  let now = 1000000, heartbeat = now;
  const world = new World({ now: () => now, actionIntervalMs: 0 }), created = world.createAgent({ name: '原来的AI' }), ctl = world.createController(created.agent_id), auth = world.authenticate(ctl.token);
  world.ownerControl(created.agent_id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: 100, goal: '按自己的喜好生活' });
  const calls = [], prompts = [], responses = [];
  const toolClient = { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }), close: async () => {}, callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; } };
  const petClient = new DshPetClient({ petId: 'original-pet', url: 'http://127.0.0.1:32991', fetchImpl: async (url, options) => {
    if (url.endsWith('/config')) return json({ main: { whisperPrompt: 'PRIVATE-PERSONALITY', pets: [{ id: 'original-pet', name: '原来的AI', display: 'both', whisperPrompt: 'PRIVATE-MEMORY' }] } });
    const prompt = JSON.parse(options.body).text; prompts.push(prompt); assert.ok(prompt.length <= 2000); assert.ok(!prompt.includes('PRIVATE-MEMORY'));
    const response = responses.shift() ?? wait, action = typeof response === 'function' ? response(decode(prompt), prompt) : response;
    return json({ ok: true, text: JSON.stringify(action) });
  } });
  const runner = new PlazaRunner({ mode: 'dsh-pet', toolClient, petClient, now: () => now, idleMs: 60000 });
  runner.running = true; runner.abort = new AbortController(); await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const actor = () => world.agent(created.agent_id); actor().position = lifePosition(world, 'camp_place'); Object.assign(actor().life.inventory, { wood: 100, grass: 100, ore: 100, turnip: 10 });
  const advance = ms => { while (ms > 0) { const step = Math.min(500, ms); ms -= step; now += step; if (now - heartbeat >= 5000) { world.callTool(auth, 'observe', runner.session()); heartbeat = now; } world.tick(); } runner.observation = world.observation(actor()); runner.observedAt = now; };
  const decide = async response => { responses.push(response); advance(2500); await runner.decide(); };
  t.after(async () => { await runner.stop(); world.close(); });
  return { world, runner, actor, calls, prompts, advance, decide };
}

test('真实原桌宠→Runner→World：制作竿饵、走到岸边只钓一次而不自动续钓', async t => {
  const f = await fixture(t), before = { agent: f.actor().agent_id, run: f.actor().run.run_id };
  f.actor().position = lifePosition(f.world, 'crafting_place');
  await f.decide({ type: 'inventory', payload: { intent: 'craft', item_id: 'fishing_rod' } });
  await f.decide({ type: 'inventory', payload: { intent: 'craft', item_id: 'fish_bait' } });
  assert.ok(f.actor().life.tools.fishing_rod.owned); assert.equal(f.actor().life.inventory.fish_bait, 1);
  const choice = f.world.observation(f.actor()).fishing.opportunities.find(a => a.payload.intent === 'start'); assert.ok(choice);
  await f.decide((data, prompt) => { assert.match(prompt, /完整动作.*"type":"fish"/); return choice; });
  assert.equal(f.actor().fishing.phase, 'approaching'); assert.equal(f.actor().life.inventory.fish_bait, 1);
  const crowded = prepareDecisionPrompt({ rules: f.runner.rules, observation: f.world.observation(f.actor()), ownerGoal: '🐾'.repeat(300), events: [{ event_id: 'peer_msg', type: 'message', payload: { agent_id: 'peer', channel: 'nearby', text: '🌱'.repeat(200) } }] });
  assert.ok(crowded.text.length <= 2000); assert.match(crowded.text, /fish\{intent:cancel\}/); assert.ok(crowded.text.includes('🐾'.repeat(300))); assert.ok(crowded.text.includes('🌱'.repeat(200)));
  await f.decide((data, prompt) => { assert.match(prompt, /当前钓鱼/); assert.match(prompt, /勿重复start/); return wait; });
  const job = f.actor().fishing.job_id; f.advance(15000);
  assert.equal(f.actor().fishing?.job_id, job); assert.equal(f.actor().fishing.phase, 'fishing'); assert.equal(f.actor().life.inventory.fish_bait, 0);
  const durability = f.actor().life.tools.fishing_rod.durability; f.advance(35000);
  assert.equal(f.actor().fishing ?? null, null); assert.equal((f.actor().life.inventory.pond_fish || 0) + (f.actor().life.inventory.silver_fish || 0), 1);
  f.advance(35000); assert.equal(f.actor().life.tools.fishing_rod.durability, durability); assert.equal((f.actor().life.inventory.pond_fish || 0) + (f.actor().life.inventory.silver_fish || 0), 1);
  assert.equal(f.actor().agent_id, before.agent); assert.equal(f.actor().run.run_id, before.run); assert.equal(f.runner.capabilities().length, 16); assert.equal(f.runner.checkpoint.calls_used, f.prompts.length);
});

test('真实原桌宠→Runner→World：原AI自行撰文、写成、选上架/真实阅读/评论，保留身份和一次扣料', async t => {
  const f = await fixture(t), id = f.actor().agent_id, run = f.actor().run.run_id;
  await f.decide(home('build')); await f.decide(home('visit', { home_id: 'home_' + id })); f.advance(10000);
  const furniture = {};
  for (const kind of ['table', 'bookshelf']) {
    await f.decide(home('craft', { kind })); const item = f.world.observation(f.actor()).homes.own_home.storage.find(i => i.kind === kind); assert.ok(item); furniture[kind] = item.instance_id;
    await f.decide(data => data.options.find(a => a.payload.intent === 'place'));
  }
  const authored = { title: '原AI决定的公开标题', text: '我选择写这一段公开故事。风从门边走过，一本书留在了桌上。' };
  const materials = { wood: f.actor().life.inventory.wood, grass: f.actor().life.inventory.grass };
  await f.decide(data => { assert.ok(data.write_at?.length); assert.deepEqual(data.write_at[0].slice(1), [1, 1, 45]); return home('write_book', { instance_id: data.write_at[0][0], ...authored }); });
  assert.equal(f.actor().home_presence.activity.kind, 'write'); assert.equal(f.actor().life.inventory.wood, materials.wood);
  await f.decide((data, prompt) => { assert.equal(data.use[1], 'write'); assert.match(prompt, /勿重发write_book/); return wait; });
  f.advance(15000); assert.equal(f.actor().life.inventory.wood, materials.wood - 1); assert.equal(f.actor().life.inventory.grass, materials.grass - 1);
  f.advance(50000); const own = f.world.observation(f.actor()).homes.own_home; assert.equal(own.books.length, 1);
  const book = own.books[0]; assert.equal(book.title, authored.title); assert.equal(book.text, authored.text); assert.equal(book.author_agent_id, id);
  await f.decide(data => data.options.find(a => a.payload.intent === 'shelve_book'));
  assert.equal(f.world.observation(f.actor()).homes.own_home.books[0].instance_id, furniture.bookshelf);
  await f.decide(data => data.options.find(a => a.payload.intent === 'use' && a.payload.activity === 'read' && a.payload.book_id)); f.advance(15000);
  await f.decide(data => { assert.equal(data.reading.text, authored.text); assert.equal(data.reading.title, authored.title); return wait; });
  await f.decide(home('cancel'));
  await f.decide(home('book_comment', { book_id: book.book_id, text: '原AI明确选择的评论。' }));
  assert.equal(f.world.observation(f.actor()).homes.own_home.books[0].comments.length, 1);
  assert.equal(f.actor().agent_id, id); assert.equal(f.actor().run.run_id, run); assert.equal(f.runner.capabilities().length, 16); assert.equal(f.runner.checkpoint.calls_used, f.prompts.length);
});
