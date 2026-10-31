import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';

function fixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-coop-migration-')), dbPath = join(dir, 'world.sqlite');
  let world, now = 1000000;
  try {
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const make = name => {
      const a = world.createAgent({ name }), c = world.createController(a.agent_id);
      world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60, max_calls: 100 });
      const auth = world.authenticate(c.token), observation = world.callTool(auth, 'join_world');
      const raw = world.agent(a.agent_id); raw.position = { x: 11, y: 8 };
      return { a: raw, c, auth, session: { run_id: observation.run_id, session_epoch: observation.session_epoch } };
    };
    const a = make('supplier'), b = make('cook');
    const act = (p, type, payload) => {
      const o = world.callTool(p.auth, 'observe', p.session);
      const result = world.callTool(p.auth, 'act', { ...p.session, action_id: o.next_action_id, type, payload });
      assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result;
    };
    // This longer-lived target detects an illicit refund counted as a new acquisition.
    act(a, 'personal_goal', { intent: 'set', kind: 'collect_item', target_id: 'turnip', target_count: 4, duration_seconds: 1800 });
    const offered = act(a, 'cooperation', { intent: 'propose', template_id: 'camp_meal', target_agent_id: b.a.agent_id, role_id: 'supplier' }).cooperation;
    const id = offered.cooperation_id;
    const params = () => ({ cooperation_id: id, revision: world.state.cooperations[id].revision });
    if (mode !== 'proposed') {
      act(b, 'cooperation', { intent: 'respond', ...params(), accept: true, role_id: 'cook' });
      if (mode !== 'active_empty') {
        a.a.life.inventory.turnip = 4;
        act(a, 'cooperation', { intent: 'contribute', ...params() });
      }
      if (mode === 'completed') act(b, 'cooperation', { intent: 'cook', ...params() });
      if (mode === 'overflow_expiry' || mode === 'pending_return') a.a.life.inventory.turnip = Number.MAX_SAFE_INTEGER;
      if (mode === 'pending_return' || mode === 'ended') act(b, 'cooperation', { intent: 'leave', cooperation_id: id });
      if (mode === 'review' || mode === 'partial_review') {
        world.ownerControl(a.a.agent_id, 'pause');
        if (mode === 'partial_review') {
          world.ownerControl(a.a.agent_id, 'resume', { controller_id: a.c.controller_id, duration_minutes: 60, max_calls: 100 });
          const o = world.callTool(a.auth, 'join_world'); a.session = { run_id: o.run_id, session_epoch: o.session_epoch };
          act(a, 'cooperation', { intent: 'confirm', ...params() });
        }
      }
    }
    const before = structuredClone(world.state);
    world.close(); world = null;
    now += ['expiry', 'overflow_expiry'].includes(mode) ? 901000 : 1000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    if (mode === 'post_restart_expiry') { now += 901000; world.tick(); }
    return { before, after: structuredClone(world.state), id, owner: a.a.agent_id };
  } finally {
    world?.close(); rmSync(dir, { recursive: true, force: true });
  }
}

test('迁移验收覆盖真实合作重启：同意失效、托管保留、精确到期退款与容量待退', () => {
  const cases = [], samples = {};
  for (const name of ['proposed', 'active_empty', 'escrow', 'review', 'partial_review', 'completed', 'ended', 'pending_return', 'expiry', 'overflow_expiry', 'post_restart_expiry']) {
    samples[name] = fixture(name); cases.push({ name, ...samples[name], accepted: true });
  }
  assert.equal(samples.expiry.after.agents[samples.expiry.owner].life.inventory.turnip, 4);
  assert.equal(samples.expiry.after.agents[samples.expiry.owner].personal_goal.progress, 0);
  assert.equal(samples.overflow_expiry.after.agents[samples.overflow_expiry.owner].cooperation_return.quantity, 4);
  assert.equal(samples.escrow.after.cooperations[samples.escrow.id].status, 'needs_review');
  const bad = (name, sample, mutate) => { const value = structuredClone(sample); mutate(value.after, value); cases.push({ name, ...value, accepted: false }); };
  for (const key of ['sources', 'target_binding', 'target_agent_id', 'progress', 'escrow', 'expires_at', 'started_at', 'revision'])
    bad(`escrow ${key} changed`, samples.escrow, (after, sample) => { after.cooperations[sample.id][key] = null; });
  bad('silent consent restored', samples.escrow, (after, sample) => { after.cooperations[sample.id].members[0].confirmed = true; });
  bad('member binding replaced', samples.escrow, (after, sample) => { after.cooperations[sample.id].members[0].run_id = 'wrong'; });
  bad('existing completion erased', samples.completed, (after, sample) => { delete after.cooperations[sample.id]; });
  bad('pending return erased', samples.pending_return, (after, sample) => { after.agents[sample.owner].cooperation_return = null; });
  bad('extra refund quantity', samples.expiry, (after, sample) => { after.agents[sample.owner].life.inventory.turnip++; });
  bad('refund missing ledger', samples.expiry, (after, sample) => { after.agents[sample.owner].life.ledger.entries.pop(); });
  bad('refund double ledger', samples.expiry, (after, sample) => { const ledger = after.agents[sample.owner].life.ledger; ledger.entries.push(ledger.entries.at(-1)); });
  bad('refund fake goal progress', samples.expiry, (after, sample) => { after.agents[sample.owner].personal_goal.progress = 4; });
  bad('pending return amount changed', samples.overflow_expiry, (after, sample) => { after.agents[sample.owner].cooperation_return.quantity++; });
  bad('proposal cooldown reset', samples.ended, (after, sample) => { after.agents[sample.owner].cooperation_proposed_at = 0; });
  bad('review proof removed', samples.escrow, after => { after.events = after.events.filter(e => e.type !== 'cooperation_review'); });
  const source = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('migration','deploy/verify-migration.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for case in json.load(sys.stdin):
    try:
        module.compare_states(case['before'],case['after']);accepted=True
    except (AssertionError,TypeError,KeyError):
        accepted=False
    assert accepted==case['accepted'],case['name']
print('Validated',${cases.length},'persistent cooperation migration cases')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', source], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
