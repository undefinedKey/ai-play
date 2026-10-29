import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { toolDefinitions } from '../server/mcp.js';

function fixture(t, count = 2) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const people = Array.from({ length: count }, (_, index) => {
    const agent = world.createAgent({ name: `测试参与者${index}`, owner_id: `owner${index}` });
    const controller = world.createController(agent.agent_id);
    const auth = world.authenticate(controller.token);
    world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
    world.callTool(auth, 'join_world');
    return { id: agent.agent_id, auth, owner: { id: `owner${index}` } };
  });
  const session = person => { const a = world.agent(person.id); return { run_id: a.run.run_id, session_epoch: a.session_epoch }; };
  const observe = person => world.callTool(person.auth, 'observe', session(person));
  const request = (person, type, payload = {}) => ({ ...session(person), action_id: observe(person).next_action_id, type, payload });
  const act = (person, type, payload = {}) => world.callTool(person.auth, 'act', request(person, type, payload));
  const advance = (ms, keepAlive = true) => {
    while (ms > 0) {
      if (keepAlive) for (const person of people) if (world.agent(person.id).status === 'active') observe(person);
      const step = Math.min(ms, 30000); now += step; world.tick(); ms -= step;
    }
  };
  const go = (person, target) => {
    while (true) {
      const pos = observe(person).self.position;
      if (pos.x === target.x && pos.y === target.y) break;
      const dx = Math.sign(target.x - pos.x) * Math.min(3, Math.abs(target.x - pos.x));
      const dy = Math.sign(target.y - pos.y) * Math.min(3 - Math.abs(dx), Math.abs(target.y - pos.y));
      assert.equal(act(person, 'move', { x: pos.x + dx, y: pos.y + dy }).status, 'applied');
    }
  };
  const group = () => {
    const group_id = act(people[0], 'create_group').group_id;
    for (const person of people.slice(1)) {
      const invitation = act(people[0], 'invite', { group_id, target_agent_id: person.id });
      assert.equal(act(person, 'respond_invite', { invite_id: invitation.invite_id, accept: true }).status, 'applied');
    }
    return group_id;
  };
  const start = (game_type, group_id = group()) => {
    const game_id = act(people[0], 'propose_game', { group_id, ...(game_type ? { game_type } : {}) }).game_id;
    for (const person of people.slice(1)) assert.equal(act(person, 'respond_game', { game_id, accept: true }).status, 'applied');
    advance(30000);
    assert.equal(world.state.game.status, 'active');
    return game_id;
  };
  return { world, people, session, observe, request, act, advance, go, group, start };
}

test('目录公开玩法、MCP动作和答题类型，答案不在任何角色投影中', t => {
  const f = fixture(t, 1), p = f.people[0], rules = f.world.getRules();
  assert.deepEqual(rules.games.map(game => game.id), ['word_chain', 'rock_paper_scissors', 'story_chain']);
  for (const id of ['riddle', 'sequence', 'treasure_hunt']) assert.ok(rules.activities.some(activity => activity.id === id));
  for (const type of ['submit_move', 'submit_story']) assert.equal(toolDefinitions.act.schema.type.parse(type), type);
  f.go(p, { x: 19, y: 4 });
  assert.equal(f.act(p, 'start_activity', { activity_id: 'riddle' }).activity.task.answer_type, 'string');
  const answer = f.world.agent(p.id).activity_answer[0];
  for (const snapshot of [f.observe(p), f.world.publicSnapshot(), f.world.ownerSnapshot(), f.world.snapshotFor(p.owner), spectatorSnapshot(f.world)]) {
    assert.ok(!JSON.stringify(snapshot).includes('activity_answer'));
    assert.ok(!JSON.stringify(snapshot).includes(`"answers"`));
  }
  assert.equal(f.act(p, 'finish_activity', { answer: 4 }).error.code, 'INVALID_ACTION');
  assert.equal(f.act(p, 'finish_activity', { answer }).result.score, 1);
  f.act(p, 'start_activity', { activity_id: 'riddle' });
  assert.equal(f.act(p, 'finish_activity', { answer: '错误答案' }).result.score, 0);
});

test('数列是真实题面和真实计分，移动取消，超时不补答案', t => {
  const f = fixture(t, 1), p = f.people[0]; f.go(p, { x: 19, y: 12 });
  const activity = f.act(p, 'start_activity', { activity_id: 'sequence' }).activity;
  const values = activity.task.prompt.match(/\d+/g).map(Number);
  assert.equal(values.length, 4);
  assert.equal(f.act(p, 'finish_activity', { answer: values[3] + values[1] - values[0] }).result.score, 1);
  f.act(p, 'start_activity', { activity_id: 'sequence' });
  assert.equal(f.act(p, 'finish_activity', { answer: '3' }).error.code, 'INVALID_ACTION');
  f.act(p, 'move', { x: 18, y: 12 }); assert.equal(f.observe(p).self.activity, null);
  f.act(p, 'start_activity', { activity_id: 'sequence' }); f.advance(90000);
  assert.equal(f.observe(p).self.activity, null);
  assert.equal(f.world.state.events.filter(event => event.type === 'activity_finished').at(-1).payload.result.score, 0);
});

test('地图寻宝按真实坐标依次收集三件，移动继续、重试不重复收集', t => {
  const f = fixture(t, 1), p = f.people[0];
  f.go(p, { x: 11, y: 8 });
  let activity = f.act(p, 'start_activity', { activity_id: 'treasure_hunt' }).activity;
  assert.equal(f.act(p, 'finish_activity').error.code, 'INVALID_ACTION');
  for (let index = 0; index < 3; index++) {
    f.go(p, activity.target);
    assert.equal(f.observe(p).self.activity.progress.collected, index);
    const request = f.request(p, 'finish_activity');
    const receipt = f.world.callTool(p.auth, 'act', request);
    assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt);
    if (index < 2) { activity = receipt.activity; assert.equal(activity.progress.collected, index + 1); }
    else { assert.equal(receipt.result.score, 3); assert.equal(receipt.activity, null); }
  }
  assert.equal(spectatorSnapshot(f.world).events.filter(event => event.type === 'treasure_collected').length, 3);
});

test('寻宝限时保留实际分数，暂停立即清除活动', t => {
  const f = fixture(t, 1), p = f.people[0]; f.go(p, { x: 11, y: 8 });
  const activity = f.act(p, 'start_activity', { activity_id: 'treasure_hunt' }).activity;
  f.go(p, activity.target); f.act(p, 'finish_activity'); f.advance(240000);
  const result = f.world.state.events.filter(event => event.type === 'activity_finished').at(-1).payload.result;
  assert.deepEqual({ score: result.score, max_score: result.max_score }, { score: 1, max_score: 3 });
  f.go(p, { x: 11, y: 8 }); f.act(p, 'start_activity', { activity_id: 'treasure_hunt' });
  f.world.ownerControl(p.id, 'pause'); assert.equal(f.world.agent(p.id).activity, null);
});

test('双人石头剪刀布暗选不泄露到观察、事件、其他主人、旁观和动作回执', t => {
  const f = fixture(t), [a, b] = f.people, game_id = f.start('rock_paper_scissors');
  const turn_id = f.observe(a).game.turn_id, cursor = f.world.state.sequence;
  const request = f.request(a, 'submit_move', { game_id, turn_id, choice: 'rock' });
  const first = f.world.callTool(a.auth, 'act', request);
  const projections = [first, f.observe(a), f.observe(b), f.world.publicSnapshot(), f.world.ownerSnapshot(), f.world.snapshotFor(b.owner), spectatorSnapshot(f.world), f.world.callTool(b.auth, 'get_events', { ...f.session(b), cursor }), f.world.callTool(a.auth, 'get_action_result', { action_id: request.action_id })];
  for (const view of projections) {
    const json = JSON.stringify(view);
    assert.ok(!json.includes('private_choices'), json); assert.ok(!json.includes('"choice":"rock"'), json);
  }
  assert.deepEqual(f.observe(b).game.submitted_agent_ids, [a.id]);
  const before = f.world.state.sequence;
  assert.deepEqual(f.world.callTool(a.auth, 'act', request), first); assert.equal(f.world.state.sequence, before);
  assert.throws(() => f.world.callTool(a.auth, 'act', { ...request, payload: { ...request.payload, choice: 'paper' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.act(a, 'submit_move', { game_id, turn_id, choice: 'paper' }).error.code, 'ALREADY_SUBMITTED');
  assert.equal(f.act(b, 'submit_move', { game_id, turn_id: 'stale', choice: 'paper' }).error.code, 'STALE_TURN');
  const second = f.act(b, 'submit_move', { game_id, turn_id, choice: 'scissors' });
  assert.equal(second.game.round, 2); assert.equal(second.game.scores[a.id], 1);
  assert.deepEqual(second.game.rounds[0].choices, [{ agent_id: a.id, choice: 'rock' }, { agent_id: b.id, choice: 'scissors' }]);
  assert.equal(f.act(a, 'submit_move', { game_id, turn_id, choice: 'rock' }).error.code, 'STALE_TURN');
  for (let round = 2; round <= 3; round++) {
    const turn_id = f.observe(a).game.turn_id;
    f.act(a, 'submit_move', { game_id, turn_id, choice: 'paper' }); f.act(b, 'submit_move', { game_id, turn_id, choice: 'rock' });
  }
  assert.equal(f.world.state.game.status, 'finished'); assert.equal(f.world.state.game.scores[a.id], 3); assert.equal(f.world.state.game.scores[b.id], 0);
  assert.equal(spectatorSnapshot(f.world).game.rounds.length, 3); assert.ok(!Object.hasOwn(f.world.state.game, 'private_choices'));
});

test('五人同时出拳逐对计分，全部提交之前不揭晓', t => {
  const f = fixture(t, 5), game_id = f.start('rock_paper_scissors');
  const turn_id = f.observe(f.people[0]).game.turn_id;
  const choices = ['rock', 'rock', 'scissors', 'paper', 'scissors'];
  f.people.forEach((person, index) => {
    assert.equal(f.act(person, 'submit_move', { game_id, turn_id, choice: choices[index] }).status, 'applied');
    if (index < 4) assert.equal(spectatorSnapshot(f.world).game.rounds.length, 0);
  });
  assert.deepEqual(f.people.map(person => f.world.state.game.scores[person.id]), [2, 2, 1, 2, 1]);
  assert.equal(spectatorSnapshot(f.world).game.rounds[0].choices.length, 5);
});

test('石头剪刀布超时、暂停或离线结束且销毁未揭晓选择', t => {
  const f = fixture(t), [a, b] = f.people; const group_id = f.group();
  for (const ending of ['timeout', 'pause', 'offline']) {
    if (f.world.agent(b.id).status !== 'active') { f.world.ownerControl(b.id, 'resume'); f.world.callTool(b.auth, 'join_world'); const invitation = f.act(a, 'invite', { group_id, target_agent_id: b.id }); f.act(b, 'respond_invite', { invite_id: invitation.invite_id, accept: true }); }
    const game_id = f.start('rock_paper_scissors', group_id), turn_id = f.observe(a).game.turn_id;
    f.act(a, 'submit_move', { game_id, turn_id, choice: 'paper' });
    if (ending === 'timeout') f.advance(30000);
    else if (ending === 'pause') f.world.ownerControl(b.id, 'pause');
    else { f.advance(30000, false); f.observe(a); f.advance(15000, false); }
    assert.equal(f.world.state.game.status, 'finished'); assert.ok(!Object.hasOwn(f.world.state.game, 'private_choices'));
    assert.equal(spectatorSnapshot(f.world).game.rounds.length, 0);
    assert.ok(!JSON.stringify(f.world.publicSnapshot()).includes('"choice":"paper"'));
    f.advance(60000);
  }
});

test('三人故事接力仅当前轮可续写，六段原文保留且可切换回词语接龙', t => {
  const f = fixture(t, 3), group_id = f.group(), game_id = f.start('story_chain', group_id);
  const initial = f.observe(f.people[0]).game;
  assert.equal(f.act(f.people[1], 'submit_story', { game_id, turn_id: initial.turn_id, text: '抢答' }).error.code, 'STALE_TURN');
  assert.equal(f.act(f.people[0], 'submit_word', { game_id, turn_id: initial.turn_id, word: '气球' }).error.code, 'STALE_TURN');
  assert.equal(f.act(f.people[0], 'submit_story', { game_id, turn_id: initial.turn_id, text: '长'.repeat(201) }).error.code, 'INVALID_ACTION');
  const texts = ['一颗种子被风吹到了池边。', '小雨把它带进了泥土。', '早晨，种子听见鸟鸣。', '它伸出了第一片叶子。', '旅人给它搭起一座小围栏。', '第二年，花开了。'];
  for (let index = 0; index < 6; index++) {
    const person = f.people[index % 3], game = f.observe(person).game;
    const request = f.request(person, 'submit_story', { game_id, turn_id: game.turn_id, text: texts[index] });
    const result = f.world.callTool(person.auth, 'act', request);
    assert.equal(result.status, 'applied'); assert.deepEqual(f.world.callTool(person.auth, 'act', request), result);
    assert.equal(result.game.segments.length, index + 1);
  }
  assert.equal(f.world.state.game.status, 'finished');
  assert.deepEqual(spectatorSnapshot(f.world).game.segments.map(segment => segment.text), texts);
  assert.deepEqual(f.people.map(person => f.world.state.game.scores[person.id]), [2, 2, 2]);
  const next = f.start(undefined, group_id), game = f.observe(f.people[0]).game;
  assert.equal(game.game_type, 'word_chain'); assert.equal(game.last_word, '天气');
  assert.equal(f.act(f.people[0], 'submit_story', { game_id: next, turn_id: game.turn_id, text: '错误游戏' }).error.code, 'STALE_TURN');
  assert.equal(f.act(f.people[0], 'submit_word', { game_id: next, turn_id: game.turn_id, word: '气球' }).status, 'applied');
});

test('故事超时换轮、一整轮无人续写结束，退出和房间暂停立即生效', t => {
  const f = fixture(t), group_id = f.group(); f.start('story_chain', group_id);
  const first = f.world.state.game.current_agent_id; f.advance(30000);
  assert.notEqual(f.world.state.game.current_agent_id, first); f.advance(30000);
  assert.equal(f.world.state.game.end_reason, '一整轮参与者均超时');
  const game_id = f.start('story_chain', group_id);
  f.act(f.people[1], 'leave_game', { game_id }); assert.equal(f.world.state.game.end_reason, '剩余参与者不足 2 人');
  f.start('story_chain', group_id); f.world.ownerRoom('pause');
  assert.equal(f.world.state.game.end_reason, '房间暂停'); assert.equal(f.world.state.game.segments.length, 0);
});

test('游戏报名不足、未知类型、非参与者动作和私有结束原因都不会伪造成真实游戏', t => {
  const f = fixture(t), [a, b] = f.people, group_id = f.group();
  assert.equal(f.act(a, 'propose_game', { group_id, game_type: 'unknown' }).error.code, 'INVALID_ACTION');
  const game_id = f.act(a, 'propose_game', { group_id, game_type: 'rock_paper_scissors' }).game_id;
  assert.equal(f.act(a, 'propose_game', { group_id, game_type: 'story_chain' }).error.code, 'GAME_BUSY');
  f.advance(30000); assert.equal(f.world.state.game.end_reason, '报名人数不足 2 人');
  assert.equal(f.act(b, 'submit_move', { game_id, turn_id: null, choice: 'rock' }).error.code, 'STALE_TURN');
  f.start('story_chain', group_id); f.world.finishGame('PRIVATE_OWNER_REASON');
  assert.ok(!JSON.stringify(f.world.publicSnapshot()).includes('PRIVATE_OWNER_REASON'));
  assert.ok(!JSON.stringify(spectatorSnapshot(f.world)).includes('PRIVATE_OWNER_REASON'));
});
