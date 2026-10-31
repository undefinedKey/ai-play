import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, WorldError } from '../server/world.js';
import { HISTORY_RETENTION, initializeHistory, recordHistoryEvent, publicHistoryEntry, pruneHistory } from '../server/history.js';

function fixture(t, persistent = false) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'plaza-history-')) : null;
  let now = 2000000000000;
  const f = { world: new World({ dbPath: directory ? join(directory, 'world.sqlite') : ':memory:', now: () => now, actionIntervalMs: 0 }) };
  t.after(() => { f.world?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  f.people = ['甲', '乙', '丙'].map(name => {
    const a = f.world.createAgent({ name, owner_id: name }), c = f.world.createController(a.agent_id), auth = f.world.authenticate(c.token);
    f.world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60 });
    f.world.callTool(auth, 'join_world'); f.world.agent(a.agent_id).position = { x: 11, y: 8 };
    return { id: a.agent_id, auth };
  });
  f.session = p => { const a = f.world.agent(p.id); return { run_id: a.run.run_id, session_epoch: a.session_epoch }; };
  f.observe = p => f.world.callTool(p.auth, 'observe', f.session(p));
  f.request = (p, type, payload = {}) => ({ ...f.session(p), action_id: f.observe(p).next_action_id, type, payload });
  f.act = (p, type, payload = {}) => { const result = f.world.callTool(p.auth, 'act', f.request(p, type, payload)); assert.equal(result.status, 'applied', JSON.stringify(result)); return result; };
  f.advance = ms => { while (ms > 0) { for (const p of f.people) if (f.world.agent(p.id).status === 'active') f.observe(p); const step = Math.min(ms, 30000); now += step; ms -= step; f.world.tick(); } };
  f.setTime = value => { now = value; };
  f.now = () => now;
  f.restart = () => { f.world.close(); f.world = new World({ dbPath: join(directory, 'world.sqlite'), now: () => now, actionIntervalMs: 0 }); };
  f.meal = () => {
    const [a, b] = f.people;
    f.world.agent(a.id).life.inventory.turnip = 4;
    const p = f.act(a, 'cooperation', { intent: 'propose', template_id: 'camp_meal', role_id: 'supplier', target_agent_id: b.id }).cooperation;
    f.act(b, 'cooperation', { intent: 'respond', cooperation_id: p.cooperation_id, revision: p.revision, accept: true, role_id: 'cook' });
    const args = () => ({ cooperation_id: p.cooperation_id, revision: f.world.state.cooperations[p.cooperation_id].revision });
    f.act(a, 'cooperation', { intent: 'contribute', ...args() }); f.act(b, 'cooperation', { intent: 'cook', ...args() });
    return f.world.state.cooperations[p.cooperation_id];
  };
  return f;
}

test('history is atomic with actual speech, duplicate receipts and failed actions; reads neither save nor renew', t => {
  const f = fixture(t), [a] = f.people;
  const request = f.request(a, 'say', { channel: 'nearby', text: '真实公开发言 <script>原文</script>' });
  const result = f.world.callTool(a.auth, 'act', request);
  assert.equal(f.world.historyPage().items.length, 1);
  assert.deepEqual(f.world.callTool(a.auth, 'act', request), result);
  assert.equal(f.world.historyPage().items.length, 1);
  const actual = f.world.perform;
  f.world.perform = function (...args) { actual.apply(this, args); throw new WorldError('TEST_ROLLBACK', '故意触发原子回滚'); };
  assert.equal(f.world.callTool(a.auth, 'act', f.request(a, 'say', { channel: 'nearby', text: '不应记录的失败动作' })).status, 'rejected');
  f.world.perform = actual;
  assert.equal(f.world.historyPage().items.length, 1);
  const before = JSON.stringify(f.world.state), saved = f.world.save; f.world.save = () => { throw new Error('read must not save'); };
  for (let i = 0; i < 5; i++) f.world.historyPage({ agent_id: a.id, category: 'speech', limit: '50' });
  assert.equal(JSON.stringify(f.world.state), before); f.world.save = saved;
  const snapshot = f.world.publicSnapshot(); assert.ok(snapshot.history.archive_id); assert.ok(!('entries' in snapshot.history));
  assert.ok(!('history' in f.observe(a)), 'full archive is not copied into model observations');
  assert.ok(!JSON.stringify(result).includes('archive_id'), 'receipts never copy history');
});

test('history cursor/filter traversal survives concurrent append and rejects malformed or foreign queries', t => {
  const f = fixture(t), [a, b] = f.people;
  for (let i = 0; i < 7; i++) { f.setTime(f.now() + 1); f.act(i % 2 ? b : a, 'say', { channel: 'nearby', text: `消息${i}` }); }
  const initial = f.world.historyPage({ limit: '3' }); assert.equal(initial.has_more, true);
  f.act(a, 'say', { channel: 'nearby', text: '第一页之后的新消息' });
  const second = f.world.historyPage({ limit: '3', before: initial.next_cursor });
  const third = f.world.historyPage({ limit: '3', before: second.next_cursor });
  assert.deepEqual([...initial.items, ...second.items, ...third.items].map(e => e.sequence), [7, 6, 5, 4, 3, 2, 1]);
  assert.equal(third.next_cursor, null); assert.equal(third.has_more, false);
  const subset = f.world.historyPage({ agent_id: b.id, category: 'speech', from: String(initial.items.at(-1).occurred_at), to: String(f.now()) });
  assert.equal(subset.items.length, 1); assert.equal(subset.items[0].details.text, '消息5');
  for (const query of [{ foo: 'bar' }, { limit: '0' }, { limit: '51' }, { limit: 20 }, { from: '1.5' }, { from: '5', to: '4' }, { to: '-1' }, { agent_id: 'missing' }, { category: 'private' }, { before: 'not-cursor' }, { before: Buffer.from(JSON.stringify(['archive_other', 2])).toString('base64url') }])
    assert.throws(() => f.world.historyPage(query), { code: 'INVALID_ACTION' });
});

test('accepted cooperation is one durable shared result after live project/event pruning and restart', t => {
  const f = fixture(t, true), project = f.meal(), [a, b, outsider] = f.people;
  const first = f.world.historyPage({ category: 'cooperation' }).items[0];
  assert.equal(first.outcome, 'completed'); assert.equal(first.details.cooperation.public_result.items_by_agent[a.id].turnip_soup, 1);
  assert.deepEqual(f.world.historyPage({ agent_id: a.id, category: 'cooperation' }).items, f.world.historyPage({ agent_id: b.id, category: 'cooperation' }).items);
  assert.equal(f.world.historyPage({ agent_id: outsider.id, category: 'cooperation' }).items.length, 0);
  delete f.world.state.cooperations[project.cooperation_id]; f.world.state.events = [];
  const old = structuredClone(f.world.state.history); f.restart(); assert.deepEqual(f.world.state.history, old);
  assert.deepEqual(f.world.historyPage({ category: 'cooperation' }).items[0], first);
});

test('completed games retain full story and participants who contributed before leaving', t => {
  const f = fixture(t), [a, b, c] = f.people, group_id = f.act(a, 'create_group').group_id;
  for (const p of [b, c]) { const invite = f.act(a, 'invite', { group_id, target_agent_id: p.id }); f.act(p, 'respond_invite', { invite_id: invite.invite_id, accept: true }); }
  const { game_id } = f.act(a, 'propose_game', { group_id, game_type: 'story_chain' });
  for (const p of [b, c]) f.act(p, 'respond_game', { game_id, accept: true });
  f.advance(150000);
  f.act(a, 'submit_story', { game_id, turn_id: f.world.state.game.turn_id, text: '甲先写的真实开头。' });
  f.act(a, 'leave_game', { game_id });
  while (f.world.state.game.status === 'active') {
    const g = f.world.state.game, p = f.people.find(p => p.id === g.current_agent_id);
    f.act(p, 'submit_story', { game_id, turn_id: g.turn_id, text: `后续第${g.segments.length + 1}段。` });
  }
  const entry = f.world.historyPage({ agent_id: a.id, category: 'game' }).items[0];
  assert.equal(entry.outcome, 'completed'); assert.equal(entry.details.game.segments.length, 6);
  assert.equal(entry.details.game.segments[0].text, '甲先写的真实开头。'); assert.equal(entry.actors.length, 3);
  f.world.state.game = null; assert.equal(f.world.historyPage({ category: 'game' }).items[0].details.game.segments.length, 6);
});

test('legacy import preserves original times, imports existing accepted results once, never invents missing story', t => {
  const f = fixture(t, true), [a] = f.people;
  f.act(a, 'say', { channel: 'nearby', text: '升级前已经发生的公开话语' });
  const time = f.now(), project = f.meal();
  f.world.state.events = f.world.state.events.filter(e => !e.type.startsWith('cooperation_'));
  f.world.event('game_finished', { game_id: 'game_old', game_type: 'story_chain', scores: { [a.id]: 2 }, reason: '完成 6 段故事', text: '旧的稀疏结束事件' });
  delete f.world.state.history; f.setTime(time + 1000); f.restart();
  const page = f.world.historyPage(); assert.equal(page.imported_count, 3); assert.equal(page.earliest_record_at, time); assert.equal(page.archive_started_at, time + 1000);
  const coop = page.items.find(e => e.category === 'cooperation'); assert.equal(coop.source.kind, 'legacy_cooperation'); assert.equal(coop.source.id, project.cooperation_id);
  assert.equal(page.items.find(e => e.category === 'game').details.game, undefined);
  const old = structuredClone(f.world.state.history); f.restart(); assert.deepEqual(f.world.state.history, old);
});

test('legacy activity restart records a real interruption with original start and actual restart time, never a private reason', t => {
  const f = fixture(t, true), [a] = f.people, started = f.now();
  f.act(a, 'say', { channel: 'nearby', text: '旧公开记录' });
  f.act(a, 'start_activity', { activity_id: 'relax' });
  f.world.agent(a.id).goal = 'PRIVATE_RESTART_REASON';
  delete f.world.state.history; f.setTime(started + 1000); f.restart();
  const page = f.world.historyPage();
  assert.equal(page.items.find(e => e.category === 'speech').occurred_at, started);
  const activity = page.items.find(e => e.category === 'activity');
  assert.equal(activity.occurred_at, started + 1000); assert.equal(activity.details.started_at, started);
  assert.equal(activity.outcome, 'interrupted'); assert.equal(activity.details.result, undefined);
  assert.ok(!JSON.stringify(page).includes('PRIVATE_RESTART_REASON'));
  const saved = structuredClone(f.world.state.history); f.restart(); assert.deepEqual(f.world.state.history, saved);
});

test('history excludes private events and deeply filters malformed fields on every read; invalid persisted archive fails closed', t => {
  const f = fixture(t), [a, b] = f.people;
  for (const type of ['invitation', 'invitation_declined', 'cooperation_invitation', 'cooperation_response', 'agent_paused', 'agent_moved']) f.world.event(type, { agent_id: a.id, text: 'PRIVATE_SENTINEL', target_agent_id: b.id }, [a.id]);
  assert.equal(f.world.historyPage().items.length, 0);
  const project = f.meal(), entry = f.world.state.history.entries.at(-1);
  assert.equal(entry.category, 'cooperation');
  const marker = { private_owner_goal: 'PRIVATE_SENTINEL' };
  entry.details.cooperation.public_result.text = marker;
  entry.details.cooperation.public_result.items_by_agent[a.id].turnip_soup = marker;
  entry.details.cooperation.target_binding = marker; entry.details.inventory = marker; entry.summary = marker; entry.actors[0].name = marker;
  const page = f.world.historyPage(); assert.ok(!JSON.stringify(page).includes('PRIVATE_SENTINEL'));
  assert.throws(() => initializeHistory(f.world), /Invalid persisted history/);
  assert.equal(f.world.state.cooperations[project.cooperation_id].status, 'completed');
});

test('history retention partitions general and cooperation quotas, monotonic IDs and read-only expiry', t => {
  const f = fixture(t), [a, b] = f.people, base = structuredClone(f.meal());
  f.world.state.history.entries = []; f.world.state.history.imported_count = 0;
  for (let i = 0; i < 520; i++) {
    const p = structuredClone(base); p.cooperation_id = `cooperation_fixture_${i}`;
    f.world.event('cooperation_completed', p, [a.id, b.id]);
  }
  for (let i = 0; i < 3600; i++) f.world.event('message', { agent_id: a.id, name: '甲', channel: 'nearby', text: `公开记录${i}` }, []);
  const h = f.world.state.history;
  assert.equal(h.entries.filter(e => e.category === 'cooperation').length, 512);
  assert.equal(h.entries.length, HISTORY_RETENTION.max_entries);
  const seq = h.next_sequence, rev = h.revision, before = JSON.stringify(h);
  f.setTime(f.now() + 31 * 86400000); f.world.historyPage(); assert.equal(JSON.stringify(h), before);
  assert.equal(pruneHistory(f.world), true); assert.equal(h.entries.length, 0); assert.equal(h.next_sequence, seq); assert.ok(h.revision > rev);
});

test('a cancellation is not a completed activity, and direct re-record of one event is idempotent', t => {
  const f = fixture(t), [a] = f.people;
  f.act(a, 'start_activity', { activity_id: 'relax' }); f.act(a, 'finish_activity');
  const entry = f.world.historyPage().items[0]; assert.equal(entry.outcome, 'cancelled'); assert.equal(entry.details.result, undefined);
  const event = f.world.state.events.findLast(e => e.type === 'activity_finished'); recordHistoryEvent(f.world, event);
  assert.equal(f.world.historyPage().items.length, 1);
  assert.equal(publicHistoryEntry({ ...entry, source: { kind: 'private', id: 'x' } }), null);
  f.act(a, 'start_activity', { activity_id: 'relax' }); f.world.ownerControl(a.id, 'pause');
  assert.equal(f.world.historyPage().items[0].outcome, 'interrupted');
  assert.equal(f.world.historyPage().items[0].details.interrupted, true);
});
