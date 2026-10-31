import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';

// These inputs come from the real persistent World constructor, not an imitation
// of the migration verifier's expected transformations.
function restartFixture({ encounter = 'pending', goal = 'active', delay = 1000, afterRestartDelay = 0, legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-migration-world-'));
  const dbPath = join(directory, 'world.sqlite');
  let now = 1000000, world;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const created = world.createAgent({ name: 'Migration fixture' }), controller = world.createController(created.agent_id);
    world.ownerControl(created.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 19 });
    const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world');
    const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const act = (type, payload) => {
      const observe = world.callTool(auth, 'observe', session);
      const result = world.callTool(auth, 'act', { ...session, action_id: observe.next_action_id, type, payload });
      assert.equal(result.status, 'applied', JSON.stringify(result.error));
      return result;
    };
    const a = world.agent(created.agent_id);
    a.diagnostics.calls_used = 7;
    if (goal) act('personal_goal', { intent: 'set', kind: 'collect_item', target_id: goal === 'completed' ? 'wood' : 'ore', target_count: goal === 'completed' ? 1 : 3 });
    a.position = { x: 4, y: 11 }; a.adventure.discovery_sequence = 0;
    act('adventure_plan', { intent: 'explore', zone_id: 'forest' }); now += 1000; world.tick();
    assert.equal(a.adventure.encounter.status, 'pending');
    if (encounter === 'resolved' || encounter === 'declined') act('adventure_event', { event_id: a.adventure.encounter.event_id, choice_id: encounter === 'resolved' ? 'wood' : 'decline' });
    if (goal === 'cancelled') act('personal_goal', { intent: 'cancel', goal_id: a.personal_goal.goal_id });
    if (goal === 'needs_review') world.ownerControl(a.agent_id, 'pause');
    if (goal === 'expired') { now += 901000; world.tick(); }
    a.adventure.next_attack_at = now + 15000;
    if (legacy) {
      delete a.personal_goal;
      for (const key of ['encounter', 'discovery_ready_at', 'discovery_sequence', 'next_attack_at']) delete a.adventure[key];
    }
    const before = structuredClone(world.state);
    world.close(); world = null;
    now += delay;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    if (afterRestartDelay) { now += afterRestartDelay; world.tick(); }
    const after = structuredClone(world.state);
    return { before, after, id: created.agent_id };
  } finally {
    world?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('发布迁移验收接受真实 World 重启，严格保留探索历史、目标内容、来源与冷却', () => {
  const cases = [];
  const add = (name, fixture) => { cases.push({ name, ...fixture, accepted: true }); return fixture; };
  const resolved = add('resolved history and goal review', restartFixture({ encounter: 'resolved' }));
  const pending = add('pending interruption and goal review', restartFixture());
  const expired = add('pending and active goal expire at startup', restartFixture({ delay: 901000 }));
  const reviewed = add('existing review remains unchanged', restartFixture({ goal: 'needs_review' }));
  add('existing review legitimately expires', restartFixture({ goal: 'needs_review', delay: 901000 }));
  add('review expires while stopped bridge waits for health', restartFixture({ afterRestartDelay: 901000 }));
  add('completed goal retains exact sources', restartFixture({ encounter: 'resolved', goal: 'completed' }));
  add('declined encounter and cancelled goal retained', restartFixture({ encounter: 'declined', goal: 'cancelled' }));
  add('previously expired histories retained', restartFixture({ goal: 'expired' }));
  add('v0.13 absent fields initialize once', restartFixture({ goal: null, legacy: true }));
  assert.equal(pending.after.agents[pending.id].adventure.encounter.status, 'interrupted');
  assert.equal(pending.after.agents[pending.id].personal_goal.status, 'needs_review');
  assert.equal(expired.after.agents[expired.id].personal_goal.status, 'expired');

  const reject = (name, fixture, mutate) => {
    const copy = structuredClone(fixture); mutate(copy.after.agents[copy.id], copy.after);
    cases.push({ name, ...copy, accepted: false });
  };
  for (const field of ['event_id', 'selected_choice_id', 'resolved_at', 'public_result', 'run_id', 'session_epoch'])
    reject(`resolved field changed: ${field}`, resolved, a => { a.adventure.encounter[field] = null; });
  reject('resolved history erased', resolved, a => { a.adventure.encounter = null; });
  for (const field of ['discovery_ready_at', 'discovery_sequence', 'next_attack_at'])
    reject(`persistent cooldown reset: ${field}`, resolved, a => { a.adventure[field] = 0; });
  for (const field of ['goal_id', 'title', 'target_id', 'target_count', 'progress', 'expires_at', 'sources', 'run_id', 'session_epoch'])
    reject(`goal content changed: ${field}`, pending, a => { a.personal_goal[field] = null; });
  reject('goal erased', pending, a => { a.personal_goal = null; });
  reject('goal silently resumed', pending, a => { a.personal_goal.status = 'active'; });
  reject('goal review attributed to wrong cause', pending, a => { a.personal_goal.review_reason = 'authorization_changed'; });
  reject('existing review timestamp refreshed', reviewed, a => { a.personal_goal.updated_at++; });
  reject('pending event selected without AI', pending, a => { a.adventure.encounter.selected_choice_id = 'wood'; });
  reject('interruption timestamp predates discovery', pending, a => { a.adventure.encounter.resolved_at = 0; });
  reject('restart audit missing', pending, (_, state) => { state.events = state.events.filter(e => e.type !== 'server_restarted'); });
  reject('transition audit missing', pending, (_, state) => { state.events = state.events.filter(e => e.type !== 'exploration_ended'); });
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const source = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('migration','deploy/verify-migration.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for case in json.load(sys.stdin):
    try:
        module.compare_states(case['before'],case['after']);accepted=True
    except AssertionError:
        accepted=False
    assert accepted==case['accepted'],case['name']
print('Validated',${cases.length},'real-World migration and tamper cases')
`;
  const result = spawnSync(python, ['-c', source], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
