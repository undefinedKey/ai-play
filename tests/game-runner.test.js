import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { World } from '../server/world.js';
import { RIDDLES } from '../server/games.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner, parseModelAction, enqueueEvents } from '../runner/runner.js';
import { DshPetClient, decisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
const json = value => ({ ok: true, json: async () => value });

async function fixture(t, choose = () => ({ type: 'wait', payload: {} })) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-games-runner-'));
  let now = Date.now();
  const world = new World({ dbPath: join(directory, 'world.sqlite'), now: () => now, actionIntervalMs: 0 });
  const prompts = [], acts = [];
  const a = world.createAgent({ name: '原来的桌宠' }), controller = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100, minutes: 30 });
  const auth = world.authenticate(controller.token);
  const client = {
    listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      if (name === 'act') acts.push(args);
      return { structuredContent: world.callTool(auth, name, args) };
    }, close: async () => {},
  };
  const pet = new DshPetClient({ petId: 'original', url: 'http://127.0.0.1:32991', home: directory, fetchImpl: async (url, options) => {
    if (url.endsWith('/config')) return json({ main: { pets: [{ id: 'original', name: '原来的桌宠', display: 'both' }] } });
    const prompt = JSON.parse(options.body).text;
    assert.ok(prompt.length <= 2000); prompts.push(prompt);
    return json({ ok: true, text: JSON.stringify(choose(decode(prompt))) });
  } });
  const runner = new PlazaRunner({ mode: 'dsh-pet', petClient: pet, toolClient: client, now: () => now, idleMs: 60000 });
  runner.running = true; runner.abort = new AbortController();
  t.after(async () => { await runner.stop(); world.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  return { world, runner, a: world.agent(a.agent_id), prompts, acts, advance: ms => { now += ms; }, refresh: () => { runner.observation = world.observation(world.agent(a.agent_id)); },
    async decision() { now += 6000; await runner.decide(); },
  };
}

function companion(f) {
  const record = f.world.createAgent({ name: '另一只原AI' }), c = f.world.createController(record.agent_id);
  f.world.ownerControl(record.agent_id, 'start', { controller_id: c.controller_id, minutes: 30 });
  f.world.callTool(f.world.authenticate(c.token), 'join_world');
  const b = f.world.agent(record.agent_id); b.position = { ...f.a.position };
  f.world.perform(f.a, 'create_group', {});
  const invitation = f.world.perform(f.a, 'invite', { group_id: f.a.group_id, target_agent_id: b.agent_id });
  f.world.perform(b, 'respond_invite', { invite_id: invitation.invite_id, accept: true });
  return b;
}

test('新动作严格校验谜语答案、暗选和故事，不接受代码或额外字段', () => {
  for (const action of [
    { type: 'finish_activity', payload: { answer: '毛巾' } },
    { type: 'finish_activity', payload: { answer: 31 } },
    { type: 'submit_move', payload: { game_id: 'g', turn_id: 't', choice: 'paper' } },
    { type: 'submit_story', payload: { game_id: 'g', turn_id: 't', text: '它推开了花园的门。' } },
    { type: 'propose_game', payload: { group_id: 'g', game_type: 'story_chain' } },
  ]) assert.deepEqual(parseModelAction(JSON.stringify(action)), action);
  for (const action of [
    { type: 'finish_activity', payload: { answer: '字'.repeat(101) } },
    { type: 'finish_activity', payload: { answer: false } },
    { type: 'submit_move', payload: { game_id: 'g', turn_id: 't', choice: 'fire' } },
    { type: 'submit_story', payload: { game_id: 'g', turn_id: 't', text: '字'.repeat(201) } },
    { type: 'submit_story', payload: { game_id: 'g', turn_id: 't', text: '故事', shell: 'echo x' } },
    { type: 'shell', payload: {} },
  ]) assert.throws(() => parseModelAction(JSON.stringify(action)), { code: 'INVALID_MODEL_OUTPUT' });
});

test('真实World活动/游戏目录完整进入原桌宠，字符串与整数题由原决策回执结算', async t => {
  const f = await fixture(t, data => {
    if (data.task.kind === 'riddle') return { type: 'finish_activity', payload: { answer: RIDDLES.find(r => r.prompt === data.task.prompt).answers[0] } };
    const n = data.task.prompt.match(/\d+/g).map(Number);
    return { type: 'finish_activity', payload: { answer: n[3] + n[1] - n[0] } };
  });
  for (const id of ['riddle', 'sequence']) {
    const entry = f.world.getRules().activities.find(a => a.id === id);
    const place = f.world.getRules().places.find(p => p.id === entry.place_id);
    f.a.position = { x: place.x, y: place.y }; f.world.perform(f.a, 'start_activity', { activity_id: id }); f.refresh();
    const originalQuestion = f.a.activity.task.prompt;
    await f.decision();
    const data = decode(f.prompts.at(-1));
    assert.equal(data.task.prompt, originalQuestion);
    for (const activity of f.world.getRules().activities) assert.ok(data.activities.some(row => row[0] === activity.id && row[1] === activity.name));
    for (const game of f.world.getRules().games) assert.ok(data.games.some(row => row[0] === game.id && row[1] === game.name));
    assert.equal(f.runner.observation.self.activity, null);
    assert.equal(f.world.state.events.at(-1).payload.result.score, 1);
    assert.equal(f.runner.checkpoint.pending_action, null);
  }
});

test('寻宝沿真实目标多步走动/采集，不睡过空闲60秒且不能伪造完成', async t => {
  const f = await fixture(t, data => {
    const { x, y } = data.self.position, target = data.task.target;
    if (x === target.x && y === target.y) return { type: 'finish_activity', payload: {} };
    const dx = Math.sign(target.x - x) * Math.min(3, Math.abs(target.x - x));
    const dy = Math.sign(target.y - y) * Math.min(3 - Math.abs(dx), Math.abs(target.y - y));
    return { type: 'move', payload: { x: x + dx, y: y + dy } };
  });
  f.a.position = { x: 11, y: 8 }; f.world.perform(f.a, 'start_activity', { activity_id: 'treasure_hunt' }); f.refresh();
  let steps = 0;
  while (f.a.activity && steps++ < 46) {
    f.advance(5000); assert.equal(f.runner.decisionDue(), true);
    await f.runner.decide();
  }
  assert.ok(steps < 46); assert.equal(f.a.activity, null);
  assert.equal(f.acts.filter(a => a.type === 'finish_activity').length, 3);
  assert.ok(f.acts.some(a => a.type === 'move'));
  assert.equal(f.world.state.events.at(-1).payload.result.score, 3);
});

test('谜题等待后10秒重看；原普通休息仍不会不断叫醒', async t => {
  const f = await fixture(t);
  f.a.position = { x: 19, y: 4 }; f.world.perform(f.a, 'start_activity', { activity_id: 'riddle' }); f.refresh();
  await f.decision(); f.advance(5000); assert.equal(f.runner.decisionDue(), false);
  f.advance(5000); assert.equal(f.runner.decisionDue(), true);
  f.world.perform(f.a, 'finish_activity', {}); f.a.position = { x: 11, y: 8 };
  f.world.perform(f.a, 'start_activity', { activity_id: 'relax' }); f.refresh();
  assert.equal(f.runner.decisionDue(), false);
});

test('活动中的长主人要求和最后一条200字消息不会挤掉题面、身份或目录', async t => {
  const f = await fixture(t); companion(f);
  const lastMessage = '友'.repeat(200), ownerGoal = '主'.repeat(300);
  for (const id of ['read', 'riddle', 'sequence', 'treasure_hunt']) {
    const entry = f.world.getRules().activities.find(a => a.id === id), place = f.world.getRules().places.find(p => p.id === entry.place_id);
    f.a.position = { x: place.x, y: place.y }; f.world.perform(f.a, 'start_activity', { activity_id: id });
    const observation = f.world.observation(f.a);
    const data = decode(decisionPrompt({ observation, rules: f.world.getRules(), ownerGoal, events: [{ type: 'message', payload: { agent_id: 'friend', text: lastMessage } }] }));
    assert.equal(data.self.agent_id, f.a.agent_id); assert.equal(data.self.name, f.a.name);
    assert.equal(data.events.at(-1).text, lastMessage);
    if (observation.self.activity.task) assert.equal(data.task.prompt, observation.self.activity.task.prompt);
    else assert.equal(data.content.text, entry.content.text);
    if (id === 'treasure_hunt') f.world.finishActivity(f.a, { cancelled: true });
    else f.world.perform(f.a, 'finish_activity', {});
  }
});

test('猜拳三回合由模型替身真实提交：对方看不到暗选，提交后不反复醒来', async t => {
  const f = await fixture(t, data => ({ type: 'submit_move', payload: { game_id: data.game.game_id, turn_id: data.game.turn_id, choice: 'rock' } }));
  const b = companion(f);
  f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'rock_paper_scissors' });
  f.world.perform(b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  for (let round = 1; round <= 3; round++) {
    f.advance(10000); assert.equal(f.runner.decisionDue(), true); await f.runner.decide();
    const observedByB = f.world.observation(b), data = decode(decisionPrompt({ observation: observedByB, rules: f.world.getRules() }));
    assert.equal(data.game.round, round); assert.ok(!JSON.stringify(data).includes('private_choices'));
    assert.equal(data.game.choices, undefined); assert.deepEqual(data.game.submitted_agent_ids, [f.a.agent_id]);
    f.advance(5000); assert.equal(f.runner.decisionDue(), false, '自己的暗选回执之后等待对手');
    f.world.perform(b, 'submit_move', { game_id: observedByB.game.game_id, turn_id: observedByB.game.turn_id, choice: 'scissors' });
    f.refresh();
  }
  assert.equal(f.world.state.game.status, 'finished'); assert.equal(f.world.state.game.rounds.length, 3);
  assert.equal(f.acts.filter(a => a.type === 'submit_move').length, 3);
});

test('故事轮次与200字末段完整进入受限提示，六段真实续写后结束', async t => {
  const f = await fixture(t, data => ({ type: 'submit_story', payload: { game_id: data.game.game_id, turn_id: data.game.turn_id, text: `第${(data.game.segments?.length || 0) + 1}段：` + '叶'.repeat(180) } }));
  const b = companion(f);
  f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'story_chain' });
  f.world.perform(b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  for (let turn = 0; turn < 3; turn++) {
    const preceding = f.world.state.game.segments.at(-1)?.text;
    f.runner.goal = '主人只希望你延续自己的风格。'.repeat(15);
    await f.decision();
    const data = decode(f.prompts.at(-1));
    if (preceding) { assert.equal(data.game.segments.at(-1).text, preceding); assert.equal(data.events.at(-1).text, preceding); }
    const g = f.world.state.game, lastMessage = '最后的朋友消息：' + '花'.repeat(185);
    f.world.perform(b, 'submit_story', { game_id: g.game_id, turn_id: g.turn_id, text: lastMessage });
    f.runner.checkpoint.queue.push({ type: 'story_submitted', payload: { agent_id: b.agent_id, game_id: g.game_id, text: lastMessage } });
    f.runner.checkpoint.queue.push({ type: 'game_turn', payload: { agent_id: f.a.agent_id, game_id: g.game_id, text: '轮到你续写' } });
    f.refresh();
  }
  assert.equal(f.world.state.game.status, 'finished'); assert.equal(f.world.state.game.segments.length, 6);
  f.a.position = { x: 19, y: 4 }; f.world.perform(f.a, 'start_activity', { activity_id: 'riddle' });
  const next = decode(decisionPrompt({ observation: f.world.observation(f.a), rules: f.world.getRules(), ownerGoal: '主'.repeat(300), events: f.runner.checkpoint.queue }));
  assert.equal(next.task.prompt, f.a.activity.task.prompt); assert.equal(next.game.status, 'finished');
});

test('本人游戏提交回声被过滤，下一轮与他人故事仍唤醒原AI', () => {
  const events = ['word_submitted', 'story_submitted', 'treasure_collected', 'move_submitted', 'game_turn'].map(type => ({ event_id: type, type, payload: { agent_id: 'self' } }));
  events.push({ event_id: 'other', type: 'story_submitted', payload: { agent_id: 'other', text: '朋友的故事' } });
  const result = enqueueEvents({ queue: [], seen: [] }, events, 'self');
  assert.deepEqual(result.queue.map(e => e.event_id), ['game_turn', 'other']);
});

test('旧活动目录不宣称新游戏存在，旧word_chain类型可省略', () => {
  const data = decode(decisionPrompt({ observation: { self: { agent_id: 'old', position: { x: 1, y: 1 } }, activities: [{ id: 'read', name: '阅读', place_id: 'reading', duration_seconds: 45 }], game: { game_id: 'g', status: 'active', current_agent_id: 'old', turn_id: 't', last_word: '天气' } }, rules: { words: ['气球'] } }));
  assert.deepEqual(data.games, [['word_chain', '词语接龙']]); assert.equal(data.game.game_type, 'word_chain'); assert.deepEqual(data.words, ['气球']);
});

for (const gameType of ['word_chain', 'rock_paper_scissors', 'story_chain']) test(`${gameType}原桌宠40–60秒思考节奏可完成真实报名与整局`, async t => {
  let turns = 0;
  const slow = () => {
    // Logical time advances in lease-sized chunks, independently of generation.
    for (let i = 0; i < (turns++ % 2 ? 4 : 6); i++) {
      f.advance(10000);
      for (const agent of Object.values(f.world.state.agents)) if (agent.status === 'active') agent.last_contact_at = f.world.now();
      f.world.tick();
    }
  };
  const f = await fixture(t, data => {
    assert.ok(data.game.remaining_seconds > 0); slow();
    if (data.game.status === 'recruiting') return { type: 'respond_game', payload: { game_id: data.game.game_id, accept: true } };
    if (gameType === 'word_chain') return { type: 'submit_word', payload: { game_id: data.game.game_id, turn_id: data.game.turn_id, word: data.words[0] } };
    if (gameType === 'story_chain') return { type: 'submit_story', payload: { game_id: data.game.game_id, turn_id: data.game.turn_id, text: '原AI选择续写的片段' } };
    return { type: 'submit_move', payload: { game_id: data.game.game_id, turn_id: data.game.turn_id, choice: 'rock' } };
  });
  const b = companion(f);
  f.world.perform(b, 'propose_game', { group_id: b.group_id, game_type: gameType }); f.refresh();
  const deadline = f.world.state.game.deadline; await f.runner.decide();
  assert.equal(f.world.state.game.responses[f.a.agent_id], true); assert.equal(f.world.state.game.deadline, deadline);
  f.world.startGame(); f.refresh();
  for (let i = 0; f.world.state.game.status === 'active' && i < 14; i++) {
    const g = f.world.state.game;
    if (gameType === 'rock_paper_scissors' || g.current_agent_id === f.a.agent_id) { await f.runner.decide(); }
    if (f.world.state.game.status !== 'active') break;
    const next = f.world.state.game;
    if (gameType === 'rock_paper_scissors' || next.current_agent_id === b.agent_id) {
      slow();
      const payload = { game_id: next.game_id, turn_id: next.turn_id };
      const data = decode(decisionPrompt({ observation: f.world.observation(b), rules: f.world.getRules() }));
      if (gameType === 'word_chain') f.world.perform(b, 'submit_word', { ...payload, word: data.words[0] });
      else if (gameType === 'story_chain') f.world.perform(b, 'submit_story', { ...payload, text: '另一原AI选择的片段' });
      else f.world.perform(b, 'submit_move', { ...payload, choice: 'scissors' });
    }
    f.refresh();
  }
  assert.equal(f.world.state.game.status, 'finished');
  assert.ok(!f.world.state.events.some(event => event.type === 'game_timeout'));
  assert.equal(f.runner.checkpoint.calls_used, f.prompts.length);
});

test('150秒新规则与30秒旧规则按实际截止显示；等待和已报名/非本人回合不空转', async t => {
  const f = await fixture(t), b = companion(f);
  const rules = f.world.getRules(); assert.equal(rules.game.turn_seconds, 150);
  f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'story_chain' }); f.refresh();
  f.runner.lastDecisionAt = f.world.now() - 90000; assert.equal(f.runner.decisionDue(), false);
  f.world.perform(b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  await f.runner.decide(); f.advance(10000); assert.equal(f.runner.decisionDue(), false, 'wait完成起30秒内不空转');
  f.advance(20000); assert.equal(f.runner.decisionDue(), true);
  f.world.nextTurn(b.agent_id); f.refresh(); f.advance(90000); assert.equal(f.runner.decisionDue(), false);
  const observation = f.world.observation(f.a); observation.server_time = 100000;
  observation.game.deadline = 130000;
  observation.invitations = [{ invite_id: 'legacy', from_agent_id: b.agent_id, group_id: 'g', expires_at: 125000 }];
  const data = decode(decisionPrompt({ observation, rules: { ...rules, cooperation: undefined, games: undefined, game: { registration_seconds: 30 } } }));
  assert.equal(data.game.remaining_seconds, 30); assert.equal(data.invitations[0].remaining_seconds, 25);
});

test('慢回复越过真实回合期限仍提交原ID并记录STALE_TURN，不替AI改成下一回合', async t => {
  let chosenTurn;
  const f = await fixture(t, data => {
    chosenTurn = data.game.turn_id;
    for (let i = 0; i < 16; i++) {
      f.advance(10000); for (const agent of Object.values(f.world.state.agents)) if (agent.status === 'active') agent.last_contact_at = f.world.now(); f.world.tick();
    }
    return { type: 'submit_story', payload: { game_id: data.game.game_id, turn_id: chosenTurn, text: '这段迟到了' } };
  });
  const b = companion(f); f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'story_chain' });
  f.world.perform(b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  await f.runner.decide();
  assert.notEqual(f.world.state.game.turn_id, chosenTurn); assert.equal(f.acts.at(-1).payload.turn_id, chosenTurn);
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'STALE_TURN'); assert.equal(f.world.state.game.segments.length, 0);
  assert.equal(f.runner.checkpoint.calls_used, 1);
});
