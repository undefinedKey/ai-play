// Offline release verification. Read two states from stdin; never write a DB,
// contact the service, or print either state's private fields.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { initializeHistory, recordHistoryEvent } from '../server/history.js';
import { gameName } from '../server/games.js';

export function verifyHistory(old, current) {
  assert.ok(current.history, 'public history must exist after upgrade');
  const validation = { state: structuredClone(current), now: () => 0 };
  initializeHistory(validation);
  assert.deepEqual(validation.state.history, current.history, 'persisted history must already be canonical');
  const events = current.events.filter(e => Number(e.cursor) > old.sequence).sort((a, b) => Number(a.cursor) - Number(b.cursor));
  const restarts = events.filter(e => e.type === 'server_restarted');
  assert.equal(restarts.length, 1, 'one real restart is required');
  const restart = restarts[0];
  assert.ok(Number.isSafeInteger(restart.occurred_at));
  const initialTime = old.history ? Math.min(...events.map(e => e.occurred_at)) : current.history.started_at;
  assert.ok(Number.isSafeInteger(initialTime) && initialTime >= 0 && initialTime <= restart.occurred_at);
  if (!old.history) assert.ok(initialTime >= Math.max(0, ...old.events.map(e => e.occurred_at)), 'archive creation cannot predate the saved world');
  let now = initialTime;
  const world = { state: structuredClone(old), now: () => now };
  initializeHistory(world);
  if (!old.history) world.state.history.archive_id = current.history.archive_id;

  // The only game state transition at load is the original game's interruption.
  const expectedGame = structuredClone(old.game);
  if (expectedGame && expectedGame.status !== 'finished') {
    expectedGame.status = 'finished'; expectedGame.end_reason = '服务重启，活动已中断'; expectedGame.current_agent_id = null; expectedGame.deadline = null;
    delete expectedGame.private_choices; if (expectedGame.submitted_agent_ids) expectedGame.submitted_agent_ids = [];
  }
  assert.deepEqual(current.game, expectedGame, 'game contents cannot change during restart');
  world.state.game = expectedGame;
  const seenActivities = new Set();
  for (const event of events) {
    now = event.occurred_at;
    assert.ok(Number.isSafeInteger(now) && now >= initialTime, 'valid lifecycle time required');
    const p = event.payload || {}, agent = old.agents[p.agent_id];
    if (event.type === 'activity_finished') {
      assert.ok(agent?.activity && !seenActivities.has(p.agent_id)); seenActivities.add(p.agent_id);
      const a = agent.activity;
      assert.deepEqual(p, { agent_id: p.agent_id, name: agent.name, activity_id: a.activity_id, activity_name: a.name,
        place_id: a.place_id, started_at: a.started_at, ends_at: a.ends_at, outcome: 'cancelled', interrupted: true,
        text: `${agent.name}结束了「${a.name}」` }, 'only the original activity may be interrupted');
      assert.equal(current.agents[p.agent_id].activity, null);
      assert.ok(Number(event.cursor) < Number(restart.cursor));
    } else if (event.type === 'game_finished') {
      assert.ok(old.game && old.game.status !== 'finished' && p.game_id === old.game.game_id);
      assert.deepEqual(p, { game_id: expectedGame.game_id, game_type: expectedGame.game_type || 'word_chain', group_id: expectedGame.group_id,
        valid_count: expectedGame.valid_count, scores: expectedGame.scores, text: `${gameName(expectedGame.game_type)}结束：服务重启，活动已中断`, reason: '服务重启，活动已中断' });
      assert.ok(Number(event.cursor) < Number(restart.cursor));
    } else if (event.type === 'exploration_ended') {
      assert.ok(agent?.adventure?.encounter?.status === 'pending');
      assert.equal(p.text, `${agent.name}的探索发现${p.status === 'expired' ? '已过期' : '已中断'}，没有领取结果`);
      assert.ok(['expired', 'interrupted'].includes(p.status));
    } else if (event.type === 'personal_goal_ended') {
      assert.ok(['active', 'needs_review'].includes(agent?.personal_goal?.status));
      assert.equal(p.status, 'expired'); assert.equal(p.text, `${agent.name}的公开短期目标已到期`);
    } else if (event.type === 'cooperation_ended') {
      assert.ok(['proposed', 'active', 'needs_review'].includes(old.cooperations?.[p.cooperation_id]?.status));
      // compare_cooperations in the Python verifier proves every scalar,
      // accepted member, refund and exact lifecycle transition independently.
    } else {
      assert.ok(!['message', 'cooperation_completed', 'exploration_resolved'].includes(event.type) &&
        !/^life_(gather_finished|traded|harvested|crafted|equipped|tool_upgraded|tool_repaired|consumed)$/.test(event.type), 'no new work or speech during release');
    }
    recordHistoryEvent(world, event);
  }
  assert.deepEqual(current.history, world.state.history, 'history must equal exact import, preservation and real restart results');
  return { public_history_preserved: true, entries: current.history.entries.length, imported_count: current.history.imported_count };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const value = JSON.parse(input);
    process.stdout.write(JSON.stringify(verifyHistory(value.old, value.new)) + '\n');
  } catch (error) {
    // Do not echo state diffs, owner goals or input content in a deployment log.
    process.stderr.write(`Public history migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1;
  }
}
