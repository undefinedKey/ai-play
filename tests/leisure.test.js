import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';

function fixture(t, { count = 2, dbPath = ':memory:' } = {}) {
  let now = 1000000;
  const f = { world: new World({ now: () => now, actionIntervalMs: 0, dbPath }) };
  t.after(() => f.world.close());
  f.people = Array.from({ length: count }, (_, index) => {
    const agent = f.world.createAgent({ name: `自由活动测试${index}` });
    const controller = f.world.createController(agent.agent_id);
    const auth = f.world.authenticate(controller.token);
    f.world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30 });
    f.world.callTool(auth, 'join_world');
    return { id: agent.agent_id, controller, auth };
  });
  f.session = person => { const a = f.world.agent(person.id); return { run_id: a.run.run_id, session_epoch: a.session_epoch }; };
  f.observe = person => f.world.callTool(person.auth, 'observe', f.session(person));
  f.request = (person, type, payload = {}) => ({ ...f.session(person), action_id: f.observe(person).next_action_id, type, payload });
  f.act = (person, type, payload = {}) => f.world.callTool(person.auth, 'act', f.request(person, type, payload));
  f.advance = milliseconds => {
    while (milliseconds > 0) {
      for (const person of f.people) if (f.world.agent(person.id).status === 'active') f.observe(person);
      const step = Math.min(milliseconds, 30000); now += step; milliseconds -= step; f.world.tick();
    }
  };
  f.now = () => now;
  f.groupId = f.act(f.people[0], 'create_group').group_id;
  for (const person of f.people.slice(1)) {
    const invitation = f.act(f.people[0], 'invite', { group_id: f.groupId, target_agent_id: person.id });
    assert.equal(f.act(person, 'respond_invite', { invite_id: invitation.invite_id, accept: true }).status, 'applied');
  }
  f.start = (gameType = 'rock_paper_scissors', people = f.people.slice(0, 2)) => {
    const proposal = f.act(people[0], 'propose_game', { group_id: f.groupId, game_type: gameType });
    assert.equal(proposal.status, 'applied', JSON.stringify(proposal));
    for (const person of people.slice(1)) assert.equal(f.act(person, 'respond_game', { game_id: proposal.game_id, accept: true }).status, 'applied');
    f.advance(30000);
    assert.equal(f.world.state.game.status, 'active');
    return proposal.game_id;
  };
  f.complete = () => {
    while (f.world.state.game.status === 'active') {
      const game = f.world.state.game;
      if (game.game_type === 'rock_paper_scissors') {
        for (const person of f.people.filter(person => game.participants.includes(person.id))) {
          assert.equal(f.act(person, 'submit_move', { game_id: game.game_id, turn_id: game.turn_id, choice: 'rock' }).status, 'applied');
        }
      } else {
        const current = f.people.find(person => person.id === game.current_agent_id);
        assert.equal(f.act(current, 'submit_story', { game_id: game.game_id, turn_id: game.turn_id, text: '朋友沿着花园的小路继续探索。' }).status, 'applied');
      }
    }
  };
  return f;
}

test('两次真实完整游戏后限制同类，局间仍能聊天散步，冷却拒绝可幂等读取', t => {
  const f = fixture(t), [a, b] = f.people;
  f.start(); f.complete();
  const leisure = f.observe(a).self.leisure;
  assert.deepEqual(leisure.recent.map(item => [item.kind, item.id]), [['game', 'rock_paper_scissors']]);
  assert.equal(leisure.game_break_until - f.now(), 30000);
  const request = f.request(a, 'propose_game', { group_id: f.groupId, game_type: 'story_chain' });
  const rejected = f.world.callTool(a.auth, 'act', request);
  assert.equal(rejected.error.code, 'GAME_BREAK');
  assert.equal(rejected.error.retry_after_ms, 30000);
  assert.deepEqual(f.world.callTool(a.auth, 'act', request), rejected);
  assert.equal(f.act(a, 'say', { channel: 'group', group_id: f.groupId, text: '我想去花园看看。' }).status, 'applied');
  assert.equal(f.act(a, 'move', { x: 11, y: 8 }).status, 'applied');
  f.advance(30000); f.start(); f.complete();
  f.advance(30000);
  const cooldown = f.act(a, 'propose_game', { group_id: f.groupId, game_type: 'rock_paper_scissors' });
  assert.equal(cooldown.error.code, 'GAME_COOLDOWN');
  assert.equal(cooldown.error.retry_after_ms, 270000);
  assert.deepEqual(cooldown.error.available_game_types, ['word_chain', 'story_chain']);
  assert.equal(f.observe(b).self.leisure.recent.length, 2);
  assert.equal(f.world.getRules().leisure_policy.repeat_game_limit, 2);
  assert.equal(f.world.publicSnapshot().leisure_policy.game_break_seconds, 30);
  f.start('story_chain'); f.complete();
  assert.equal(f.observe(a).self.leisure.recent.at(-1).id, 'story_chain');
  assert.ok(f.observe(a).self.leisure.game_cooldowns.rock_paper_scissors > f.now());
  f.advance(300000);
  assert.deepEqual(f.observe(a).self.leisure.game_cooldowns, {});
  f.start(); f.complete();
  assert.deepEqual(f.observe(a).self.leisure.game_cooldowns, {});
});

test('由其他角色发起不能绕过自己的休息/同类冷却，仍可谢绝邀请', t => {
  const f = fixture(t, { count: 3 }), [a, , c] = f.people;
  f.start(); f.complete(); f.advance(30000); f.start(); f.complete();
  assert.deepEqual(f.observe(c).self.leisure.recent, []);
  const proposal = f.act(c, 'propose_game', { group_id: f.groupId, game_type: 'rock_paper_scissors' });
  assert.equal(proposal.status, 'applied');
  assert.equal(f.act(a, 'respond_game', { game_id: proposal.game_id, accept: true }).error.code, 'GAME_BREAK');
  assert.equal(f.act(a, 'respond_game', { game_id: proposal.game_id, accept: false }).status, 'applied');
  f.advance(30000);
  assert.equal(f.world.state.game.end_reason, '报名人数不足 2 人');
  const next = f.act(c, 'propose_game', { group_id: f.groupId, game_type: 'rock_paper_scissors' });
  assert.equal(f.act(a, 'respond_game', { game_id: next.game_id, accept: true }).error.code, 'GAME_COOLDOWN');
  assert.deepEqual(f.observe(c).self.leisure.recent, []);
});

test('真实独处经历最多保存六条，取消不记，独处不会清空同游戏连玩次数', t => {
  const f = fixture(t), [a] = f.people;
  f.start(); f.complete();
  f.world.agent(a.id).position = { x: 19, y: 12 };
  for (let i = 0; i < 8; i++) {
    const activity = f.act(a, 'start_activity', { activity_id: 'sequence' }).activity;
    const numbers = activity.task.prompt.match(/\d+/g).map(Number);
    const answer = numbers[3] + numbers[1] - numbers[0];
    assert.equal(f.act(a, 'finish_activity', { answer }).result.score, 1);
  }
  assert.equal(f.observe(a).self.leisure.recent.length, 6);
  assert.ok(f.observe(a).self.leisure.recent.every(item => item.kind === 'activity'));
  f.act(a, 'start_activity', { activity_id: 'sequence' }); f.act(a, 'finish_activity');
  assert.equal(f.observe(a).self.leisure.recent.length, 6);
  f.advance(30000); f.start(); f.complete();
  assert.equal(f.observe(a).self.leisure.game_cooldowns.rock_paper_scissors - f.now(), 300000);
  assert.equal(f.observe(a).self.leisure.recent.at(-1).kind, 'game');
});

test('未开始、超时和暂停的游戏不虚构已完成经历', t => {
  const f = fixture(t), [a, b] = f.people;
  f.act(a, 'propose_game', { group_id: f.groupId }); f.advance(30000);
  assert.deepEqual(f.observe(a).self.leisure.recent, []);
  f.start(); f.advance(30000);
  assert.equal(f.world.state.game.end_reason, '出拳超时，本局结束');
  assert.deepEqual(f.observe(a).self.leisure.recent, []);
  f.start('story_chain'); f.world.ownerControl(b.id, 'pause');
  assert.deepEqual(f.observe(a).self.leisure.recent, []);
  assert.equal(f.observe(a).self.leisure.game_break_until, null);
});

test('完成后的经历不被重复结算，公开投影不带内部计数或私人字段', t => {
  const f = fixture(t), [a] = f.people;
  f.start(); f.complete();
  f.world.finishGame('完成 3 轮石头剪刀布');
  const agent = f.world.agent(a.id);
  agent.leisure.private = 'PRIVATE_MEMORY';
  agent.leisure.recent[0].private = 'PRIVATE_FIELD';
  agent.leisure.game_cooldowns.private = 'PRIVATE_SECRET';
  agent.goal = 'PRIVATE_GOAL';
  assert.equal(f.observe(a).self.leisure.recent.length, 1);
  for (const projection of [f.observe(a).self, f.world.publicSnapshot().agents[0], spectatorSnapshot(f.world)]) {
    assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|last_game_type|same_game_count/);
  }
  assert.equal(spectatorSnapshot(f.world).leisure_policy.repeat_game_cooldown_seconds, 300);
});

test('重连、更换预算段和SQLite重启保留重复计数；服务中断不算已完成', t => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-leisure-'));
  const dbPath = join(directory, 'world.sqlite');
  const f = fixture(t, { dbPath }), [a] = f.people;
  t.after(() => { assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  f.start(); f.complete(); f.advance(30000);
  const before = f.observe(a).self.leisure;
  f.world.ownerControl(a.id, 'pause'); f.world.ownerControl(a.id, 'resume', { max_calls: 9 }); f.world.callTool(a.auth, 'join_world');
  assert.deepEqual(f.observe(a).self.leisure, before);
  f.world.close();
  f.world = new World({ dbPath, now: f.now, actionIntervalMs: 0 });
  assert.deepEqual(f.world.publicAgent(f.world.agent(a.id)).leisure, before);
  assert.equal(f.world.agent(a.id).leisure.same_game_count, 1);
  assert.equal(f.world.agent(a.id).run.max_calls, 9);
  for (const person of f.people) f.world.callTool(person.auth, 'join_world');
  f.groupId = f.act(a, 'create_group').group_id;
  const b = f.people[1], invite = f.act(a, 'invite', { group_id: f.groupId, target_agent_id: b.id });
  f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  f.start(); f.complete();
  const cooled = f.observe(a).self.leisure;
  assert.equal(cooled.recent.length, 2);
  assert.equal(cooled.game_cooldowns.rock_paper_scissors - f.now(), 300000);
  f.world.close(); f.world = new World({ dbPath, now: f.now, actionIntervalMs: 0 });
  assert.deepEqual(f.world.publicAgent(f.world.agent(a.id)).leisure, cooled);
  for (const person of f.people) f.world.callTool(person.auth, 'join_world');
  f.advance(30000);
  f.groupId = f.act(a, 'create_group').group_id;
  const nextInvite = f.act(a, 'invite', { group_id: f.groupId, target_agent_id: b.id });
  f.act(b, 'respond_invite', { invite_id: nextInvite.invite_id, accept: true });
  f.start('story_chain');
  const beforeInterrupt = f.observe(a).self.leisure;
  f.world.close(); f.world = new World({ dbPath, now: f.now, actionIntervalMs: 0 });
  assert.equal(f.world.state.game.end_reason, '服务重启，活动已中断');
  assert.deepEqual(f.world.publicAgent(f.world.agent(a.id)).leisure, beforeInterrupt);
});
