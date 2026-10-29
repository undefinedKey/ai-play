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

test('原AI看到实际完成历史和可选替代，长主人要求与最后200字消息仍保留', async t => {
  const f = await fixture(t); f.play(); f.advance(31000); f.play(); f.advance(31000); f.refresh();
  const leisure = leisureContext(f.runner.observation, f.world.getRules());
  assert.deepEqual(leisure.recent, [['game', 'rock_paper_scissors'], ['game', 'rock_paper_scissors']]);
  assert.deepEqual(leisure.available_games, ['word_chain', 'story_chain']);
  assert.ok(leisure.blocked_games.rock_paper_scissors > 0);
  const lastMessage = '友'.repeat(200), ownerGoal = '主'.repeat(300);
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules(), ownerGoal, events: [{ type: 'message', payload: { agent_id: f.b.agent_id, text: lastMessage } }] });
  const data = decode(prompt);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(ownerGoal));
  assert.equal(data.events.at(-1).text, lastMessage);
  assert.deepEqual(data.leisure.recent, leisure.recent);
  assert.ok(data.leisure.blocked_games.rock_paper_scissors > 0);
  assert.equal(data.self.name, '原来的我');
  assert.ok(prompt.includes('保持自己的偏好'));
});

test('重复提议冷却游戏得到真实拒绝，下一次原AI自主换成聊天，无替代台词', async t => {
  const actualWords = '刚才这一局很有意思，我想聊聊花园。';
  const f = await fixture(t, data => data.last_action
    ? { type: 'say', payload: { channel: 'group', group_id: data.group.group_id, text: actualWords } }
    : { type: 'propose_game', payload: { group_id: data.group.group_id, game_type: 'rock_paper_scissors' } });
  f.play(); f.advance(31000); f.play(); f.advance(31000); f.refresh();
  const oldGame = f.world.state.game.game_id;
  await f.decision();
  const persisted = JSON.parse(readFileSync(f.checkpointPath, 'utf8'));
  assert.equal(persisted.last_action_feedback.code, 'GAME_COOLDOWN');
  assert.equal(persisted.pending_action, null);
  assert.equal(f.world.state.game.game_id, oldGame);
  await f.decision();
  assert.equal(decode(f.prompts.at(-1)).last_action.code, 'GAME_COOLDOWN');
  assert.equal(f.world.state.events.at(-1).payload.text, actualWords);
  assert.equal(f.runner.checkpoint.last_action_feedback, undefined);
  assert.equal(f.runner.checkpoint.calls_used, 2);
});

test('重复冷却拒绝不会每10秒唤醒，消息和实际游戏回合仍及时处理', async t => {
  const f = await fixture(t, data => ({ type: 'propose_game', payload: { group_id: data.group.group_id, game_type: 'rock_paper_scissors' } }));
  f.play(); f.advance(31000); f.play(); f.advance(31000); f.refresh();
  await f.decision(); await f.decision();
  assert.equal(f.runner.checkpoint.last_action_feedback.repeat_count, 2);
  f.advance(30000); assert.equal(f.runner.decisionDue(), false);
  assert.equal(f.runner.checkpoint.calls_used, 2);
  f.runner.checkpoint.queue.push({ type: 'message', payload: { text: '一起散步吗？', agent_id: f.b.agent_id } });
  assert.equal(f.runner.decisionDue(), true);
  f.runner.checkpoint.queue = [];
  f.world.perform(f.a, 'propose_game', { group_id: f.a.group_id, game_type: 'story_chain' });
  f.world.perform(f.b, 'respond_game', { game_id: f.world.state.game.game_id, accept: true }); f.world.startGame(); f.refresh();
  assert.equal(f.runner.decisionDue(), true, '旧的非局内冷却反馈不延误当前实际回合');
  const prompt = decisionPrompt({ observation: f.runner.observation, rules: f.world.getRules(), lastActionFeedback: f.runner.checkpoint.last_action_feedback });
  const data = decode(prompt);
  assert.equal(data.leisure, undefined);
  assert.equal(data.game.turn_id, f.world.state.game.turn_id);
  assert.equal(data.game.current_agent_id, f.a.agent_id);
});

test('显式模拟模式尊重局间休息并换可用玩法，旧目录仍兼容', async t => {
  const f = await fixture(t); f.runner.checkpoint.demo.greeted = true;
  f.play();
  const between = f.runner.demoDecision(f.runner.observation);
  assert.equal(between.type, 'start_activity'); assert.equal(between.payload.activity_id, 'relax');
  f.advance(31000); f.refresh();
  const next = f.runner.demoDecision(f.runner.observation);
  assert.equal(next.type, 'propose_game'); assert.equal(next.payload.game_type, 'word_chain');
  const legacy = leisureContext({ self: {}, game: null }, {});
  assert.deepEqual(legacy.available_games, ['word_chain']);
});

test('冷却剩余时间递减，结束后不把旧拒绝继续当成当前限制', async t => {
  const f = await fixture(t, data => ({ type: 'propose_game', payload: { group_id: data.group.group_id, game_type: 'rock_paper_scissors' } }));
  f.play(); f.advance(31000); f.play(); f.advance(31000); f.refresh();
  await f.decision();
  const remaining = f.runner.actionFeedback().retry_after_ms;
  f.advance(20000);
  assert.equal(f.runner.actionFeedback().retry_after_ms, remaining - 20000);
  f.advance(300000); f.refresh();
  assert.equal(f.runner.decisionDue(), true);
  assert.equal(f.runner.actionFeedback(), undefined);
  assert.equal(f.runner.checkpoint.last_action_feedback, undefined);
  await f.decision();
  assert.equal(f.world.state.game.status, 'recruiting');
  assert.equal(f.world.state.game.game_type, 'rock_paper_scissors');
  assert.equal(decode(f.prompts.at(-1)).last_action, undefined);
});

test('省略类型的接龙提议被拒时不误记成上局猜拳', async t => {
  const f = await fixture(t, data => ({ type: 'propose_game', payload: { group_id: data.group.group_id } }));
  f.play(); await f.decision();
  assert.equal(f.runner.checkpoint.last_action_feedback.code, 'GAME_BREAK');
  assert.equal(f.runner.checkpoint.last_action_feedback.game_type, 'word_chain');
});
