import test from 'node:test';
import assert from 'node:assert/strict';
import { DshPetClient, decisionPrompt, prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { cooperationContext, cooperationPrompt, cooperationStamp, supportsCooperation } from '../skills/ai-plaza/scripts/cooperation.mjs';
import { COOPERATION_RULES, reviewCooperations } from '../server/cooperation.js';
import { parseModelAction, enqueueEvents, PlazaRunner } from '../skills/ai-plaza/scripts/runtime.mjs';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';

const action = payload => ({ type: 'cooperation', payload });
const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
export function cooperationFixture() {
  const me = 'agent_' + 'a'.repeat(36), friend = 'agent_' + 'f'.repeat(36), now = 1000000;
  const templates = [{ template_id: 'camp_meal', terms: '供菜者supplier明确交4萝卜，厨师cook明确耗4体力做2汤，双方各1汤；退出退未用菜。', roles: [{ role_id: 'supplier' }, { role_id: 'cook' }], steps: [{}, {}] },
    { template_id: 'scout_and_guard', terms: 'scout先解决成立后森林发现（非拒绝），guard之后获森林怪有效击杀战利品，无额外奖励。', roles: [{ role_id: 'scout' }, { role_id: 'guard' }], steps: [{}, {}] }];
  const rules = { room: { width: 24, height: 16 }, max_move: 3, max_capabilities: 16, allowed_actions: ['cooperation', 'wait', 'adventure_event', 'adventure_plan', 'personal_goal', 'inventory'], cooperation: COOPERATION_RULES };
  const observation = { server_time: now, self: { agent_id: me, position: { x: 12, y: 8 }, status: 'active', fatigue: { energy: 1, attack_multiplier: .75, hunt_min_energy: 12 },
    adventure: { hp: 8, max_hp: 100, in_field: true, encounter: { event_id: 'encounter_' + 'e'.repeat(36), status: 'pending', expires_at: now + 150000,
      choices: [{ choice_id: 'wood', energy_cost: 4, items: { wood: 2 }, heal: 0, restore_energy: 0 }, { choice_id: 'ore', energy_cost: 4, items: { ore: 1 }, heal: 0, restore_energy: 0 }, { choice_id: 'decline', energy_cost: 0, items: {}, heal: 0, restore_energy: 0 }] } },
    life: { inventory: { turnip: 1, wheat_bread: 1 }, equipment: {} }, personal_goal: { goal_id: 'goal_' + 'g'.repeat(36), kind: 'collect_item', target_id: 'wood', target_count: 10, progress: 1, status: 'needs_review', expires_at: now + 500000 } },
    life: { items: [{ id: 'turnip', kind: 'food', heal: 12 }, { id: 'wheat_bread', kind: 'food', energy_restore: 24 }] },
    adventure: { monsters: ['forest_slime', 'wild_boar', 'ruin_sentinel'].map((monster_id, i) => ({ monster_id, position: { x: 13 + i, y: 8 }, hp: 50, attack: 8, behavior: 'attacking', target_agent_id: i === 2 ? friend : me })) },
    group: { members: [me, friend] }, nearby_agents: [{ agent_id: friend, status: 'active', position: { x: 11, y: 8 } }],
    cooperation: { cooperation_id: 'coop_' + 'c'.repeat(36), revision: 2, template_id: 'camp_meal', status: 'needs_review', expires_at: now + 600000, self_role_id: 'supplier',
      members: [{ agent_id: me, role_id: 'supplier', confirmed: false }, { agent_id: friend, role_id: 'cook', confirmed: false }],
      progress: [{ step_id: 'supply', progress: 4, target_count: 4 }, { step_id: 'cook', progress: 0, target_count: 1 }], escrow: { turnip: 4 } },
  };
  return { observation, rules, ownerGoal: '🐾'.repeat(300), correction: true,
    events: [{ type: 'message', payload: { agent_id: friend, text: '🌱'.repeat(200) } }],
    lastActionFeedback: { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } } };
}
test('cooperation严格按intent验证，不自填分工、不接受额外资源数量或旧版本字段', () => {
  const valid = [{ intent: 'propose', template_id: 'camp_meal', target_agent_id: 'peer', role_id: 'supplier' },
    { intent: 'propose', template_id: 'scout_and_guard', target_agent_id: 'peer', role_id: 'guard', duration_seconds: 300 },
    { intent: 'respond', cooperation_id: 'c', revision: 1, accept: true, role_id: 'cook' }, { intent: 'respond', cooperation_id: 'c', revision: 1, accept: false },
    ...['confirm', 'contribute', 'cook'].map(intent => ({ intent, cooperation_id: 'c', revision: 2 })), ...['leave', 'claim_return'].map(intent => ({ intent, cooperation_id: 'c' }))];
  for (const payload of valid) assert.deepEqual(parseModelAction(JSON.stringify(action(payload))), action(payload));
  for (const payload of [{ ...valid[0], role_id: 'guard' }, { ...valid[0], duration_seconds: 1801 }, { ...valid[0], cooperation_id: 'old' },
    { ...valid[2], role_id: undefined }, { ...valid[3], role_id: 'cook' }, { ...valid[3], revision: 0 }, { ...valid[3], accept: 'false' },
    { ...valid[5], quantity: 4 }, { ...valid[7], revision: 2 }, { intent: 'confirm', cooperation_id: 'c' }]) assert.throws(() => parseModelAction(JSON.stringify(action(payload))), { code: 'INVALID_MODEL_OUTPUT' });
});
test('最坏上下文同时保留合作复核、探索、个人目标、三危险、原消息和主人要求', () => {
  const context = cooperationFixture();
  const raw = cooperationPrompt(context, { energy: [1, .75, 12], food: [['turnip', 12, 1], ['wheat_bread', 0, 1, 24]] }, cooperationContext(context.observation, context.rules), {});
  assert.ok(raw.length <= 2000, `context length ${raw.length}`);
  const prepared = prepareDecisionPrompt(context), prompt = prepared.text, data = decode(prompt);
  const actual = v => prepared.references?.[v] || v;
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(context.ownerGoal)); assert.equal(data.msg[1], context.events[0].payload.text);
  assert.equal(data.foes.length, 3); assert.equal(actual(data.goal[0]), context.observation.self.personal_goal.goal_id); assert.equal(actual(data.event[0]), context.observation.self.adventure.encounter.event_id);
  assert.equal(actual(data.coop[0]), context.observation.cooperation.cooperation_id); assert.equal(data.coop[1], 2); assert.equal(data.coop[8], 4);
  assert.ok(prompt.includes('confirm')); assert.ok(prompt.includes('leave')); assert.ok(prompt.includes('4萝卜')); assert.ok(prompt.includes('各得1'));
});

for (const phase of ['invited', 'two_invites', 'proposed_and_invited', 'active', 'return', 'discovery', 'game', 'solo', 'gather']) test(`2000字符合作 ${phase} 路径与纠正提示`, () => {
  const c = cooperationFixture(), o = c.observation, self = o.self;
  const invite = { cooperation_id: 'cooperation_' + 'i'.repeat(36), revision: 1, template_id: 'camp_meal', from_agent_id: o.nearby_agents[0].agent_id,
    role_id: 'cook', invite_expires_at: o.server_time + 150000, expires_at: o.server_time + 900000 };
  if (['invited', 'two_invites', 'discovery'].includes(phase)) o.cooperation = null;
  if (['invited', 'two_invites', 'proposed_and_invited'].includes(phase)) o.cooperation_invitations = [invite];
  if (phase === 'two_invites') o.cooperation_invitations.push({ ...invite, cooperation_id: 'cooperation_' + 'j'.repeat(36), template_id: 'scout_and_guard', role_id: 'scout' });
  if (phase === 'proposed_and_invited') { o.cooperation.status = 'proposed'; o.cooperation.invite_expires_at = o.server_time + 150000; o.cooperation.members = o.cooperation.members.slice(0, 1); }
  if (phase === 'active') o.cooperation.status = 'active';
  if (phase === 'return') o.cooperation_return = { cooperation_id: 'cooperation_' + 'r'.repeat(36), item_id: 'turnip', quantity: 4 };
  if (['game', 'solo', 'gather'].includes(phase)) {
    self.adventure.encounter = null; self.adventure.in_field = false; o.adventure.monsters = []; self.position = { x: 11, y: 8 };
    if (phase === 'game') o.game = { game_id: 'game_' + 'z'.repeat(36), turn_id: 'turn_' + 't'.repeat(36), status: 'active', game_type: 'word_chain', participants: [self.agent_id], current_agent_id: self.agent_id, last_word: '天气' };
    if (phase === 'solo') self.activity = { activity_id: 'puzzle', ends_at: o.server_time + 90000, task: { kind: 'puzzle', prompt: '2+3=?', answer_type: 'integer' } };
    if (phase === 'gather') self.life.gathering = { resource_id: 'wood', ends_at: o.server_time + 12000 };
  }
  const prepared = prepareDecisionPrompt(c), p = prepared.text;
  assert.ok(p.length <= 2000, `${phase}=${p.length}`); assert.ok(p.includes(c.ownerGoal)); assert.ok(p.includes(c.events[0].payload.text));
  assert.ok(p.includes('cooperation')); assert.ok(p.includes('纠正') || p.includes('纠正上次格式') || p.includes('上次'));
  const plain = decisionPrompt({ ...c, correction: false }); assert.notEqual(p, plain); assert.ok(plain.length <= 2000);
  if (phase === 'two_invites') { const d = decode(p); assert.equal(d.余邀 ?? d.coop.other_invitations, 1); }
  if (['invited', 'two_invites'].includes(phase)) assert.ok(p.includes('respond') && p.includes('拒绝') && p.includes('4萝卜') && p.includes('各得1'));
});

test('短引用只在本次dsh响应已知ID字段展开，不修改intent/角色/数值或另一轮ID', () => {
  const c = cooperationFixture(), a = prepareDecisionPrompt(c), d = decode(a.text);
  const chosen = action({ intent: 'confirm', cooperation_id: d.coop[0], revision: 2 });
  assert.deepEqual(parseModelAction(expandDecisionReferences(JSON.stringify(chosen), a.references)), action({ intent: 'confirm', cooperation_id: c.observation.cooperation.cooperation_id, revision: 2 }));
  const invalid = action({ intent: 'respond', cooperation_id: d.coop[0], revision: 999, accept: true, role_id: '@E1', extra: '@G2' });
  const expanded = JSON.parse(expandDecisionReferences(JSON.stringify(invalid), a.references));
  assert.equal(expanded.payload.role_id, '@E1'); assert.equal(expanded.payload.revision, 999); assert.equal(expanded.payload.extra, '@G2');
  assert.throws(() => parseModelAction(JSON.stringify(expanded)), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => expandDecisionReferences(JSON.stringify(chosen), {}), { code: 'INVALID_MODEL_OUTPUT' });
  const next = cooperationFixture(); next.observation.cooperation.cooperation_id = 'new-contract';
  const b = prepareDecisionPrompt(next); assert.equal(a.references[d.coop[0]], c.observation.cooperation.cooperation_id); assert.equal(b.references[d.coop[0]], 'new-contract');
});

test('实际DshPetClient各自prepared绑定ID，回复乱序不串约定，主机请求不携带引用映射', async () => {
  const requests = [];
  const pet = new DshPetClient({ petId: 'main', url: 'http://127.0.0.1:39991', home: '/nonexistent-cooperation-fixture', fetchImpl: async (url, options) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ main: { pets: [{ id: 'main', name: '原AI', display: 'both' }] } }) };
    const body = JSON.parse(options.body); requests.push(body); assert.deepEqual(Object.keys(body), ['text']);
    await new Promise(resolve => setTimeout(resolve, requests.length === 1 ? 10 : 0));
    const data = decode(body.text); return { ok: true, json: async () => ({ ok: true, text: JSON.stringify(action({ intent: 'confirm', cooperation_id: data.coop[0], revision: data.coop[1] })) }) };
  } });
  const a = cooperationFixture(), b = cooperationFixture(); b.observation.cooperation.cooperation_id = 'another-true-ID'; b.observation.cooperation.revision = 3;
  const pa = pet.prepareDecision(a), pb = pet.prepareDecision(b);
  const [ra, rb] = await Promise.all([pet.decide(a, { prepared: pa }), pet.decide(b, { prepared: pb })]);
  assert.equal(parseModelAction(ra).payload.cooperation_id, a.observation.cooperation.cooperation_id);
  assert.equal(parseModelAction(rb).payload.cooperation_id, b.observation.cooperation.cooperation_id); assert.equal(parseModelAction(rb).payload.revision, 3);
  assert.equal(requests.length, 2);
});

test('已过期的私人邀请有真实不可响应提示；不合目录不宣称新能力', () => {
  const c = cooperationFixture(); c.observation.cooperation = null; c.observation.nearby_agents = [];
  c.events = [{ type: 'cooperation_invitation', payload: { cooperation_id: 'old-offer', target_agent_id: c.observation.self.agent_id } }];
  const ctx = cooperationContext(c.observation, c.rules, c.events); assert.equal(ctx.notice[2], '已不可响应'); assert.equal(ctx.invitations, undefined);
  const broken = structuredClone(c.rules); broken.cooperation.templates[0].roles[0].role_id = 'invented'; assert.equal(supportsCooperation(broken), false);
});

for (const activity of ['story', 'story_emoji', 'read', 'treasure', 'scout']) test(`${activity}合作期间保留真实内容、行动入口和长消息`, () => {
  const c = cooperationFixture(), o = c.observation, self = o.self;
  self.adventure.encounter = null; self.adventure.in_field = false; o.adventure.monsters = [];
  if (activity.startsWith('story')) o.game = { game_id: 'game-' + 'g'.repeat(36), turn_id: 'turn-' + 't'.repeat(36), status: 'active', game_type: 'story_chain', current_agent_id: self.agent_id,
    participants: [self.agent_id], segments: [{ agent_id: o.nearby_agents[0].agent_id, text: (activity === 'story_emoji' ? '🐈' : '故').repeat(200) }] };
  if (activity === 'read') { self.activity = { activity_id: 'read', ends_at: o.server_time + 60000 }; o.activities = [{ id: 'read', content: { title: '纸页', text: '书'.repeat(200) } }]; }
  if (activity === 'treasure') self.activity = { activity_id: 'treasure_hunt', ends_at: o.server_time + 60000, task: { kind: 'treasure_hunt', prompt: '走到target再采集', answer_type: 'none' }, target: { x: 13, y: 8 }, progress: { collected: 1, total: 3 } };
  if (activity === 'scout') { o.cooperation.template_id = 'scout_and_guard'; o.cooperation.self_role_id = 'scout'; o.cooperation.status = 'active'; o.cooperation.members[0].role_id = 'scout'; o.cooperation.members[1].role_id = 'guard'; }
  const prepared = prepareDecisionPrompt(c), p = prepared.text; assert.ok(p.length <= 2000); assert.ok(p.includes(c.ownerGoal)); assert.ok(p.includes(c.events[0].payload.text));
  if (activity === 'story') { assert.ok(p.includes('故'.repeat(200))); assert.ok(p.includes('submit_story')); }
  if (activity === 'story_emoji') {
    assert.ok(prepared.cooperationReviewDeferred); assert.ok(p.includes('🐈'.repeat(200))); assert.ok(p.includes('leave_game') && p.includes('intent:leave,cooperation_id'));
    assert.ok(!p.includes('intent:confirm|leave')); assert.ok(p.includes('结束或退出活动后重看完整复核条款'));
    const deadline = o.cooperation.expires_at; o.game.status = 'finished';
    const restored = prepareDecisionPrompt(c); assert.ok(!restored.cooperationReviewDeferred); assert.ok(restored.text.includes('4萝卜')); assert.ok(restored.text.includes('confirm')); assert.equal(o.cooperation.expires_at, deadline);
  }
  if (activity === 'read') assert.ok(p.includes('书'.repeat(200)));
  if (activity === 'treasure') assert.ok(p.includes('move{x,y}') && p.includes('finish_activity'));
  if (activity === 'scout') assert.ok(p.includes('explore') && p.includes('forest'));
});

test('合作事件只唤醒本人参与/被邀：非小组伙伴有效，旁人邀请不进原AI队列', () => {
  const self = 'self', peer = 'peer';
  const events = [{ event_id: 'a', type: 'cooperation_invitation', payload: { from_agent_id: peer, target_agent_id: self, cooperation_id: 'offer' } },
    { event_id: 'b', type: 'cooperation_review', payload: { members: [{ agent_id: peer }, { agent_id: self }] } },
    { event_id: 'c', type: 'cooperation_invitation', payload: { from_agent_id: 'stranger', target_agent_id: peer } },
    { event_id: 'd', type: 'cooperation_completed', payload: { members: [{ agent_id: peer }] } }];
  assert.deepEqual(enqueueEvents({}, events, self, []).queue.map(e => e.event_id), ['a', 'b']);
});

test('新服务报告第16能力，目录或上限缺失与demo不能虚报，复核只唤醒不确认', () => {
  const c = cooperationFixture(), runner = new PlazaRunner({ mode: 'dsh-pet', now: () => c.observation.server_time });
  runner.rules = c.rules; runner.observation = c.observation; runner.checkpoint = { queue: [], cooperation_seen: cooperationStamp(c.observation), encounter_seen: c.observation.self.adventure.encounter.event_id, goal_seen: c.observation.self.personal_goal.goal_id + ':needs_review' }; runner.lastDecisionAt = c.observation.server_time - 10000;
  assert.ok(runner.capabilities().includes('cooperation')); assert.equal(runner.decisionDue(), false);
  c.observation.cooperation.revision++; assert.equal(runner.decisionDue(), true); assert.equal(c.observation.cooperation.status, 'needs_review');
  runner.rules = { ...c.rules, max_capabilities: 15 }; assert.ok(!runner.capabilities().includes('cooperation'));
  runner.rules = { ...c.rules, cooperation: { templates: [] } }; assert.equal(supportsCooperation(runner.rules), false);
  runner.rules = c.rules; runner.mode = 'demo'; assert.deepEqual(runner.capabilities(), []);
});

async function realRunners(t, mode = 'dsh-pet', count = 2) {
  let now = Date.now(); const world = new World({ now: () => now, actionIntervalMs: 0 }), peers = [];
  for (let i = 0; i < count; i++) {
    const record = world.createAgent({ name: `原合作者${i}` }), controller = world.createController(record.agent_id);
    world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100, duration_minutes: 30 });
    const auth = world.authenticate(controller.token), peer = { id: record.agent_id, auth, contexts: [], answer: { type: 'wait', payload: {} } };
    const runner = new PlazaRunner({ mode, now: () => now, idleMs: 60000,
      toolClient: { listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
        callTool: async ({ name, arguments: args }) => ({ structuredContent: world.callTool(auth, name, args) }), close: async () => {} },
      petClient: { prepareDecision: prepareDecisionPrompt, decide: async (context, { prepared, onRequest } = {}) => { await onRequest?.(); const p = prepared || prepareDecisionPrompt(context); assert.ok(p.text.length <= 2000); peer.contexts.push({ context, data: decode(p.text), text: p.text, references: p.references, deferred: p.cooperationReviewDeferred }); return JSON.stringify(peer.answer); } },
      model: { baseUrl: 'https://original.invalid/v1', model: 'original-test-double', apiKey: 'PRIVATE' },
      fetchImpl: async (_, options) => { const messages = JSON.parse(options.body).messages; peer.contexts.push({ text: messages[0].content, data: JSON.parse(messages[1].content) });
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(peer.answer) } }] }) }; } });
    runner.running = true; runner.abort = new AbortController(); await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
    peer.runner = runner; peer.agent = () => world.agent(peer.id); peer.agent().position = { x: 11, y: 8 }; peers.push(peer);
  }
  const advance = ms => { while (ms > 0) { const step = Math.min(ms, 1000); now += step; ms -= step; for (const p of peers) world.callTool(p.auth, 'observe', p.runner.session()); world.tick(); } };
  const decide = async (peer, answer, elapsed = 6000) => { peer.answer = answer; advance(elapsed); await peer.runner.decide(); assert.ok(!peer.runner.lastError, peer.runner.lastError); };
  t.after(async () => { for (const p of peers) await p.runner.stop(); world.close(); });
  return { world, peers, advance, decide };
}

for (const mode of ['dsh-pet', 'model']) test(`${mode}两位原AI分别同意、明确交菜和cook才真实完成；wait不代做`, async t => {
  const f = await realRunners(t, mode), [supplier, cook] = f.peers; supplier.agent().life.inventory.turnip = 4;
  await f.decide(supplier, action({ intent: 'propose', template_id: 'camp_meal', target_agent_id: cook.id, role_id: 'supplier' }));
  let project = f.world.observation(supplier.agent()).cooperation;
  assert.equal(project.status, 'proposed'); assert.equal(supplier.agent().life.inventory.turnip, 4);
  await f.decide(cook, { type: 'wait', payload: {} }); assert.equal(f.world.observation(supplier.agent()).cooperation.status, 'proposed');
  const invite = f.world.observation(cook.agent()).cooperation_invitations[0];
  assert.match(cook.contexts.at(-1).text, /4萝卜|COOPERATION|cooperation/);
  await f.decide(cook, action({ intent: 'respond', cooperation_id: invite.cooperation_id, revision: invite.revision, accept: true, role_id: 'cook' }));
  project = f.world.observation(supplier.agent()).cooperation; assert.equal(project.status, 'active'); assert.equal(project.escrow.turnip, 0);
  await f.decide(supplier, action({ intent: 'contribute', cooperation_id: project.cooperation_id, revision: project.revision }));
  assert.equal(supplier.agent().life.inventory.turnip || 0, 0); assert.equal(f.world.observation(supplier.agent()).cooperation.escrow.turnip, 4);
  await f.decide(cook, { type: 'wait', payload: {} }); assert.equal(cook.agent().life.inventory.turnip_soup || 0, 0);
  await f.decide(cook, action({ intent: 'cook', cooperation_id: project.cooperation_id, revision: project.revision }));
  assert.equal(f.world.observation(supplier.agent()).cooperation.status, 'completed');
  assert.equal(cook.agent().life.inventory.turnip_soup, 1); assert.equal(supplier.agent().life.inventory.turnip_soup, 1);
  assert.equal(supplier.runner.capabilities().length, 16); assert.equal(cook.runner.capabilities().length, 16);
  if (mode === 'model') assert.equal(cook.contexts.at(-1).data.observation.self.life.ledger, undefined);
});

test('双邀约单事件ACK、40秒决策间隔与无事件快照轮换：第二份不会被第一份wait饿死', async t => {
  const f = await realRunners(t, 'dsh-pet', 3), [a, b, target] = f.peers;
  for (const proposer of [a, b]) await f.decide(proposer, action({ intent: 'propose', template_id: 'camp_meal', target_agent_id: target.id, role_id: 'supplier' }));
  const offers = f.world.observation(target.agent()).cooperation_invitations;
  assert.equal(offers.length, 2);
  const incoming = offers.map((i, n) => ({ event_id: `private-${n}`, type: 'cooperation_invitation', payload: { ...i, target_agent_id: target.id } }));
  target.runner.checkpoint = enqueueEvents(target.runner.checkpoint, incoming, target.id);
  await f.decide(target, { type: 'wait', payload: {} }, 40000);
  assert.equal(target.runner.checkpoint.queue.length, 1); assert.deepEqual(target.runner.checkpoint.last_acked_batch.event_ids, ['private-0']);
  await f.decide(target, { type: 'wait', payload: {} }, 40000);
  assert.equal(target.runner.checkpoint.queue.length, 0); assert.deepEqual(target.runner.checkpoint.last_acked_batch.event_ids, ['private-1']);
  const shown = target.contexts.slice(-2).map(x => { const id = x.data.coop?.invitations?.[0]?.id || x.data.invites?.[0]?.[0]; return x.references?.[id] || id; });
  assert.notEqual(shown[0], shown[1]); assert.equal(f.world.observation(target.agent()).cooperation_invitations.length, 2);
  const first = target.runner.checkpoint.cooperation_focus;
  await f.decide(target, { type: 'wait', payload: {} }, 30000);
  assert.notEqual(target.runner.checkpoint.cooperation_focus, first);
});

test('极端故事帧不标记合作复核已见；本人退出游戏后完整条款恢复并可真实确认', async t => {
  const f = await realRunners(t, 'dsh-pet', 3), [a, b, storyteller] = f.peers;
  await f.decide(a, action({ intent: 'propose', template_id: 'camp_meal', target_agent_id: b.id, role_id: 'supplier' }));
  const offer = f.world.observation(b.agent()).cooperation_invitations[0];
  await f.decide(b, action({ intent: 'respond', cooperation_id: offer.cooperation_id, revision: offer.revision, accept: true, role_id: 'cook' }));
  reviewCooperations(f.world, a.agent()); const project = f.world.observation(a.agent()).cooperation, deadline = project.expires_at;
  f.world.perform(a.agent(), 'personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'wood', target_count: 10, duration_seconds: 500 }); a.agent().personal_goal.status = 'needs_review';
  f.world.perform(a.agent(), 'create_group', {});
  const invitation = f.world.perform(a.agent(), 'invite', { group_id: a.agent().group_id, target_agent_id: storyteller.id });
  f.world.perform(storyteller.agent(), 'respond_invite', { invite_id: invitation.invite_id, accept: true });
  f.world.perform(a.agent(), 'propose_game', { group_id: a.agent().group_id, game_type: 'story_chain' });
  f.world.perform(storyteller.agent(), 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame();
  f.world.state.game.segments = [{ agent_id: storyteller.id, text: '🐈'.repeat(200) }];
  Object.assign(a.agent().life.inventory, { turnip: 1, wheat_bread: 1 }); a.agent().adventure.hp = 8; a.agent().fatigue.energy = 1;
  a.runner.goal = '🐾'.repeat(300); delete a.runner.checkpoint.cooperation_seen;
  const queueChat = id => { a.runner.checkpoint.queue.push({ event_id: id, type: 'message', payload: { agent_id: storyteller.id, text: '🌱'.repeat(200) } }); };
  queueChat('long-chat-1'); await f.decide(a, { type: 'wait', payload: {} });
  assert.equal(a.contexts.at(-1).deferred, true); assert.equal(a.runner.checkpoint.cooperation_seen, undefined); assert.ok(a.runner.checkpoint.cooperation_review_deferred);
  f.advance(6000); a.runner.observation = f.world.observation(a.agent()); a.runner.observedAt = a.runner.now();
  assert.equal(a.runner.decisionDue(), false, '复核本身不会每5秒重复请求');
  queueChat('long-chat-2'); assert.equal(a.runner.decisionDue(), true, '其他真实消息仍唤醒');
  await f.decide(a, { type: 'leave_game', payload: { game_id: f.world.state.game.game_id } }, 0);
  assert.equal(a.runner.checkpoint.cooperation_seen, undefined);
  f.advance(6000); a.runner.observation = f.world.observation(a.agent()); a.runner.observedAt = a.runner.now(); assert.equal(a.runner.decisionDue(), true);
  await f.decide(a, action({ intent: 'confirm', cooperation_id: project.cooperation_id, revision: project.revision }));
  assert.ok(!a.contexts.at(-1).deferred); assert.ok(a.contexts.at(-1).text.includes('4萝卜'));
  const current = f.world.observation(a.agent()).cooperation; assert.equal(current.self_confirmed, true); assert.equal(current.expires_at, deadline);
});

test('未展开的review批次不ACK，暂存期间其他事件可醒，结束/到期释放复核', () => {
  const c = cooperationFixture(), o = c.observation; o.self.adventure.encounter = null;
  o.game = { game_id: 'g', status: 'active', game_type: 'story_chain', participants: [o.self.agent_id], current_agent_id: 'other' };
  const r = new PlazaRunner({ mode: 'dsh-pet', now: () => o.server_time, idleMs: 60000 }); r.rules = c.rules; r.observation = o; r.observedAt = o.server_time; r.lastDecisionAt = o.server_time - 6000;
  const review = { event_id: 'review', type: 'cooperation_review', payload: o.cooperation }, msg = { event_id: 'msg', type: 'message', payload: { text: '消息' } };
  r.checkpoint = { queue: [], cooperation_review_deferred: { cooperation_id: o.cooperation.cooperation_id, revision: 2, activity: 'game:g' },
    goal_seen: o.self.personal_goal.goal_id + ':needs_review', event_batch: { id: 'batch', events: [review, msg], cooperation_review_deferred: true } };
  r.ackBatch('batch'); assert.deepEqual(r.checkpoint.last_acked_batch.event_ids, ['msg']); assert.deepEqual(r.checkpoint.deferred_cooperation_events, [review]);
  assert.equal(r.healthReport().pending_events, 1);
  assert.equal(r.decisionDue(), false); r.lastDecisionAt -= 10000; assert.equal(r.decisionDue(), false);
  r.checkpoint.queue.push({ event_id: 'danger', type: 'adventure_danger' }); assert.equal(r.decisionDue(), true); r.checkpoint.queue = [];
  o.cooperation.status = 'ended'; assert.equal(r.decisionDue(), true); assert.equal(r.checkpoint.cooperation_review_deferred, undefined); assert.equal(r.checkpoint.queue[0].event_id, 'review');
  r.checkpoint.deferred_cooperation_events = [review]; r.checkpoint.cooperation_review_deferred = {};
  r.deactivate(); assert.equal(r.healthReport().pending_events, 0); assert.equal(r.checkpoint.cooperation_review_deferred, undefined);
});
