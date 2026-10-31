import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.js';
import { toolDefinitions } from '../server/mcp.js';
import { PlazaRunner } from '../runner/runner.js';
import { decisionPrompt, leisureContext } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const decode = prompt => JSON.parse(prompt.split('公开数据：')[1]);
async function fixture(t, choose = () => ({ type: 'wait', payload: {} })) {
  let now = Date.now();
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-leisure-runner-'));
  const checkpointPath = join(directory, 'bridge.json');
  const prompts = [], calls = [];
  const first = world.createAgent({ name: '原来的我' }), controller = world.createController(first.agent_id);
  world.ownerControl(first.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100, duration_minutes: 30 });
  const auth = world.authenticate(controller.token);
  const client = {
    listTools: async () => ({ tools: Object.keys(toolDefinitions).map(name => ({ name })) }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { structuredContent: world.callTool(auth, name, args) }; },
    close: async () => {},
  };
  const pet = { initialize: async () => {}, decide: async context => { const prompt = decisionPrompt(context); prompts.push(prompt); return JSON.stringify(choose(decode(prompt))); } };
  const runner = new PlazaRunner({ mode: 'dsh-pet', petClient: pet, toolClient: client, checkpointPath, now: () => now, idleMs: 30000 });
  runner.running = true; runner.abort = new AbortController();
  await runner.initialize(); await runner.activate(world.callTool(auth, 'get_control_state'));
  const second = world.createAgent({ name: '同伴' }), secondController = world.createController(second.agent_id);
  world.ownerControl(second.agent_id, 'start', { controller_id: secondController.controller_id, duration_minutes: 30 });
  const otherAuth = world.authenticate(secondController.token); world.callTool(otherAuth, 'join_world');
  const a = world.agent(first.agent_id), b = world.agent(second.agent_id);
  b.position = { ...a.position };
  world.perform(a, 'create_group', {});
  const invitation = world.perform(a, 'invite', { group_id: a.group_id, target_agent_id: b.agent_id });
  world.perform(b, 'respond_invite', { invite_id: invitation.invite_id, accept: true });
  const refresh = () => { runner.observation = world.observation(a); runner.observedAt = now; };
  const advance = ms => {
    while (ms > 0) {
      const step = Math.min(20000, ms); now += step; ms -= step;
      for (const [person, credentials] of [[a, auth], [b, otherAuth]]) world.callTool(credentials, 'observe', { run_id: person.run.run_id, session_epoch: person.session_epoch });
    }
  };
  const play = () => {
    world.perform(a, 'propose_game', { group_id: a.group_id, game_type: 'rock_paper_scissors' });
    world.perform(b, 'respond_game', { game_id: world.state.game.game_id, accept: true }); world.startGame();
    for (let round = 0; round < 3; round++) {
      const { game_id, turn_id } = world.state.game;
      world.perform(a, 'submit_move', { game_id, turn_id, choice: 'rock' });
      world.perform(b, 'submit_move', { game_id, turn_id, choice: 'scissors' });
    }
    refresh();
  };
  t.after(async () => { await runner.stop(); world.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  refresh();
  return { world, runner, a, b, prompts, calls, checkpointPath, advance, refresh, play, decision: async () => { advance(6000); await runner.decide(); } };
}

test('近期完成历史进入原AI观察，所有游戏仍可选，不用冷却强迫轮换', async t => {
  const f = await fixture(t); f.play(); f.play(); f.refresh();
  const leisure = leisureContext(f.runner.observation, f.world.getRules());
  assert.deepEqual(leisure.recent, [['game', 'rock_paper_scissors'], ['game', 'rock_paper_scissors']]);
  assert.deepEqual(new Set(leisure.available_games), new Set(['word_chain', 'story_chain', 'rock_paper_scissors']));
  assert.deepEqual(leisure.blocked_games, {}); assert.equal(leisure.break_seconds, 0);
  const lastMessage = '友'.repeat(200), ownerGoal = '主'.repeat(300);
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules(), ownerGoal, events: [{ type: 'message', payload: { agent_id: f.b.agent_id, text: lastMessage } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal));
  assert.equal(data.events.at(-1).text, lastMessage); assert.deepEqual(data.leisure.recent, leisure.recent);
  assert.equal(data.self.name, '原来的我'); assert.match(prompt, /保持(?:自己的)?偏好/); assert.ok(prompt.includes('不强制'));
});

test('原AI能自主继续喜欢的游戏，连玩两局不被拒绝且预算真实计数', async t => {
  const f = await fixture(t, data => ({ type: 'propose_game', payload: { group_id: data.group.group_id, game_type: 'rock_paper_scissors' } }));
  f.play(); f.play(); f.refresh(); const oldGame = f.world.state.game.game_id;
  await f.decision();
  const persisted = JSON.parse(readFileSync(f.checkpointPath, 'utf8'));
  assert.equal(persisted.last_action_feedback, undefined); assert.equal(persisted.pending_action, null);
  assert.notEqual(f.world.state.game.game_id, oldGame);
  assert.equal(f.world.state.game.status, 'recruiting'); assert.equal(f.world.state.game.game_type, 'rock_paper_scissors');
  assert.equal(f.runner.checkpoint.calls_used, 1);
});

test('原AI也能根据真实近期经历改为聊天，平台不生成替代台词', async t => {
  const words = '我想聊聊刚才这场猜拳。';
  const f = await fixture(t, data => data.leisure?.recent.some(row => row[1] === 'rock_paper_scissors')
    ? { type: 'say', payload: { channel: 'group', group_id: data.group.group_id, text: words } }
    : { type: 'wait', payload: {} });
  f.play(); await f.decision();
  assert.equal(f.world.state.events.at(-1).payload.text, words);
  assert.equal(f.world.state.game.status, 'finished'); assert.equal(f.runner.checkpoint.calls_used, 1);
});

test('连接旧服务仍理解实际冷却，拒绝反馈到期后清除', async t => {
  const f = await fixture(t); const until = Date.now() + 300000;
  f.runner.observation.self.leisure = { recent: [], game_break_until: null, game_cooldowns: { rock_paper_scissors: until } };
  let legacy = leisureContext(f.runner.observation, f.world.getRules());
  assert.deepEqual(legacy.available_games, ['word_chain', 'story_chain']);
  assert.ok(legacy.blocked_games.rock_paper_scissors > 0);
  f.runner.checkpoint.last_action_feedback = { type: 'propose_game', game_type: 'rock_paper_scissors', code: 'GAME_COOLDOWN', retry_at: until, repeat_count: 2 };
  const remaining = f.runner.actionFeedback().retry_after_ms;
  f.advance(20000); assert.equal(f.runner.actionFeedback().retry_after_ms, remaining - 20000);
  f.runner.observation.self.leisure = { recent: [], game_break_until: null, game_cooldowns: {} };
  assert.equal(f.runner.actionFeedback(), undefined);
  legacy = leisureContext({ self: {} }, {}); assert.deepEqual(legacy.available_games, ['word_chain']);
});

test('旧服务重复拒绝降低空闲调用，消息和实际轮次仍唤醒', async t => {
  const f = await fixture(t);
  f.runner.lastDecisionAt = f.runner.now();
  f.runner.observation.self.leisure = { recent: [], game_break_until: null, game_cooldowns: { rock_paper_scissors: f.runner.now() + 300000 } };
  f.runner.checkpoint.last_action_feedback = { type: 'propose_game', game_type: 'rock_paper_scissors', code: 'GAME_COOLDOWN', retry_at: f.runner.now() + 300000, repeat_count: 2 };
  f.advance(30000); assert.equal(f.runner.decisionDue(), false);
  f.runner.checkpoint.queue.push({ type: 'message', payload: { text: '一起探索吗？', agent_id: f.b.agent_id } });
  assert.equal(f.runner.decisionDue(), true); f.runner.checkpoint.queue = [];
  f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'story_chain' });
  f.world.perform(f.b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  assert.equal(f.runner.decisionDue(), true);
  const data = decode(decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules(), lastActionFeedback: f.runner.checkpoint.last_action_feedback }));
  assert.equal(data.game.turn_id, f.world.state.game.turn_id); assert.equal(data.game.current_agent_id, f.a.agent_id);
});

test('显式模拟仍标明测试身份，不替原AI自动开始冒险', async t => {
  const f = await fixture(t); f.runner.checkpoint.demo.greeted = true; f.play();
  const next = f.runner.demoDecision(f.runner.observation);
  assert.equal(next.type, 'propose_game'); assert.equal(next.payload.game_type, 'word_chain');
  assert.equal(f.a.adventure.plan, null);
});
