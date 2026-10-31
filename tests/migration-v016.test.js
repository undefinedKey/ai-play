import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { verifyHistory } from '../deploy/verify-history.mjs';

function fixture(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-history-migration-')), dbPath = join(directory, 'world.sqlite');
  let now = 2000000000000, world;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const people = ['供菜', '烹饪'].map(name => {
      const a = world.createAgent({ name }), c = world.createController(a.agent_id), auth = world.authenticate(c.token);
      world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, goal: 'PRIVATE_MIGRATION_GOAL' });
      const o = world.callTool(auth, 'join_world'); world.agent(a.agent_id).position = { x: 11, y: 8 };
      return { id: a.agent_id, auth, session: { run_id: o.run_id, session_epoch: o.session_epoch } };
    });
    const [a, b] = people;
    const act = (p, type, payload) => { const o = world.callTool(p.auth, 'observe', p.session), result = world.callTool(p.auth, 'act', { ...p.session, action_id: o.next_action_id, type, payload }); assert.equal(result.status, 'applied', JSON.stringify(result)); return result; };
    const advance = ms => { while (ms > 0) { for (const p of people) world.callTool(p.auth, 'observe', p.session); const step = Math.min(ms, 30000); now += step; ms -= step; world.tick(); } };
    act(a, 'say', { channel: 'nearby', text: '原来的公开经历，不应重写。' });
    if (mode.includes('activity')) act(a, 'start_activity', { activity_id: 'relax' });
    if (mode.includes('cooperation')) {
      world.agent(a.id).life.inventory.turnip = 4;
      const offered = act(a, 'cooperation', { intent: 'propose', template_id: 'camp_meal', role_id: 'supplier', target_agent_id: b.id }).cooperation;
      const p = () => ({ cooperation_id: offered.cooperation_id, revision: world.state.cooperations[offered.cooperation_id].revision });
      act(b, 'cooperation', { intent: 'respond', ...p(), accept: true, role_id: 'cook' });
      act(a, 'cooperation', { intent: 'contribute', ...p() }); act(b, 'cooperation', { intent: 'cook', ...p() });
      if (mode.endsWith('fallback')) world.state.events = world.state.events.filter(e => !e.type.startsWith('cooperation_'));
    }
    if (mode.includes('game')) {
      const group_id = act(a, 'create_group').group_id, invite = act(a, 'invite', { group_id, target_agent_id: b.id });
      act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
      const game_id = act(a, 'propose_game', { group_id, game_type: mode.includes('story') ? 'story_chain' : 'rock_paper_scissors' }).game_id;
      act(b, 'respond_game', { game_id, accept: true }); advance(150000);
      if (mode.includes('story')) {
        for (let i = 0; i < 6; i++) act(people[i % 2], 'submit_story', { game_id, turn_id: world.state.game.turn_id, text: `原故事第${i}段。` });
      } else act(a, 'submit_move', { game_id, turn_id: world.state.game.turn_id, choice: 'paper' });
    }
    if (mode.includes('legacy')) delete world.state.history;
    const old = structuredClone(world.state); world.close(); world = null;
    now += mode === 'retention' ? 31 * 86400000 : 1000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    return { old, new: structuredClone(world.state) };
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('v0.16 migration independently proves real SQLite import, durable history, game interruption, accepted cooperation and retention', () => {
  const cases = ['existing', 'legacy', 'legacy_activity', 'legacy_cooperation_fallback', 'existing_cooperation', 'existing_game', 'legacy_story_game', 'retention'].map(name => ({ name, ...fixture(name), accepted: true }));
  const activeGame = cases.find(c => c.name === 'existing_game');
  assert.equal(activeGame.new.history.entries.at(-1).outcome, 'interrupted');
  assert.ok(!JSON.stringify(activeGame.new.history).includes('"choice":"paper"'));
  const legacy = cases.find(c => c.name === 'legacy_cooperation_fallback');
  assert.equal(legacy.new.history.entries.find(e => e.category === 'cooperation').source.kind, 'legacy_cooperation');
  assert.equal(cases.find(c => c.name === 'legacy_activity').new.history.entries.at(-1).outcome, 'interrupted');
  assert.equal(cases.find(c => c.name === 'legacy_story_game').new.history.entries.at(-1).details.game.segments.length, 6);
  assert.equal(cases.find(c => c.name === 'retention').new.history.entries.length, 0);
  const base = cases.find(c => c.name === 'existing');
  const bad = (name, mutate, sample = base) => { const c = structuredClone(sample); c.name = name; c.accepted = false; mutate(c.new, c); cases.push(c); };
  bad('erase archive', state => { delete state.history; });
  bad('drop retained entry', state => { state.history.entries = []; });
  bad('rewrite valid public content', state => { const e = state.history.entries[0]; e.details.text = '偷偷替换的公开话语'; e.summary = e.details.text; });
  bad('rewrite original timestamp', state => { state.history.entries[0].occurred_at++; });
  bad('rewrite actor name', state => { state.history.entries[0].actors[0].name = '换了身份'; });
  bad('nested private field', state => { state.history.entries[0].details.private_owner_goal = 'PRIVATE_SENTINEL'; });
  bad('reset archive identity', state => { state.history.archive_id = 'archive_00000000-0000-0000-0000-000000000000'; });
  bad('change origin', state => { state.history.entries[0].source = { kind: 'event', id: 'evt_99999', event_id: 'evt_99999' }; });
  bad('lose original sequence', state => { state.history.next_sequence++; });
  bad('change imported count', state => { state.history.imported_count++; }, legacy);
  bad('omit verifiable legacy speech', state => { state.history.entries = state.history.entries.filter(e => e.category !== 'speech'); }, legacy);
  bad('forge cooperation result', state => { const p = state.history.entries.find(e => e.category === 'cooperation').details.cooperation; p.public_result.text = '伪造合作结果'; }, legacy);
  bad('save hidden RPS hand', state => { state.history.entries.at(-1).details.game.private_choices = { a: 'paper' }; }, activeGame);
  bad('invent restored game content', state => { state.game.scores = { nope: 999 }; }, activeGame);
  for (const c of cases) {
    if (c.accepted) assert.equal(verifyHistory(c.old, c.new).public_history_preserved, true, c.name);
    else assert.throws(() => verifyHistory(c.old, c.new), undefined, c.name);
  }
  const source = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('migration','deploy/verify-migration.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for c in json.load(sys.stdin):
    try: m.compare_states(c['old'],c['new']);accepted=True
    except (AssertionError,TypeError,KeyError,ValueError): accepted=False
    assert accepted==c['accepted'],c['name']
print('Verified',${cases.length},'v0.16 real-state migration cases')`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', source], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
