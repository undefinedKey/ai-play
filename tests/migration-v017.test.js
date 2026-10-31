import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { SCENES } from '../shared/world-layout.js';
import { verifyScenes } from '../deploy/verify-scenes.mjs';

function migrate(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-scenes-migration-'));
  let now = 2000000000000, world;
  try {
    const dbPath = join(directory, 'world.sqlite');
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const created = world.createAgent({ name: '原来的居民', bio: '原来的性格', owner_id: 'same-owner' });
    const a = world.agent(created.agent_id), controller = world.createController(a.agent_id), auth = world.authenticate(controller.token);
    world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 500, goal: 'PRIVATE_OWNER_REQUIREMENT' });
    const session = world.callTool(auth, 'join_world');
    world.callTool(auth, 'act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: session.next_action_id, type: 'say', payload: { channel: 'nearby', text: '这是升级前的公开记录。' } });
    a.position = { x: 11, y: 8 }; a.fatigue.energy = 50;
    if (mode !== 'existing' && mode !== 'terrain') { delete a.scene_id; delete a.movement; delete a.scene_migration; }
    if (mode === 'legacy_field') { a.adventure.in_field = true; a.position = { x: 4, y: 11 }; }
    if (mode === 'legacy_plan') a.adventure.plan = { intent: 'explore', zone_id: 'forest', monster_id: null, started_at: now, expires_at: now + 90000 };
    if (mode === 'legacy_ambiguous') { a.position = { x: 4, y: 11 }; a.adventure.last_result = { kind: 'stopped', text: '中文旧记录提到森林不能作为位置证据', at: now }; }
    if (mode === 'existing') { a.scene_id = 'adventure'; a.position = { x: 11, y: 8 }; }
    if (mode === 'terrain') { a.scene_id = 'plaza'; a.position = { ...SCENES.find(s => s.id === 'plaza').blocked[0] }; }
    if (mode === 'out_of_bounds') a.position = { x: -50, y: 200 };
    const old = structuredClone(world.state); world.close(); world = null;
    now += 10000;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
    const current = structuredClone(world.state);
    if (['legacy_plan', 'existing'].includes(mode)) assert.equal(current.agents[a.agent_id].fatigue.energy, 50, 'adventure camp coordinates do not receive plaza offline recovery');
    if (mode === 'legacy_default') assert.equal(current.agents[a.agent_id].fatigue.energy, 53);
    return { old, new: current };
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('v0.17 real SQLite migration preserves location evidence, coordinates, identity and old history; rejects forged relocation', () => {
  const cases = ['legacy_default', 'legacy_field', 'legacy_plan', 'legacy_ambiguous', 'existing', 'terrain', 'out_of_bounds'].map(name => ({ name, ...migrate(name), accepted: true }));
  for (const c of cases) assert.equal(verifyScenes(c.old, c.new).scene_locations_preserved, true, c.name);
  const single = c => Object.values(c.new.agents)[0];
  assert.equal(single(cases.find(c => c.name === 'legacy_ambiguous')).scene_id, 'plaza');
  assert.equal(single(cases.find(c => c.name === 'legacy_field')).scene_id, 'adventure');
  const base = cases[0];
  const reject = (name, change) => { const c = structuredClone(base); c.name = name; c.accepted = false; change(c.new, single(c)); cases.push(c); };
  reject('erase scene', (_, a) => { delete a.scene_id; });
  reject('move to other scene', (_, a) => { a.scene_id = 'adventure'; });
  reject('teleport without terrain conflict', (_, a) => { a.position = { x: 14, y: 8 }; });
  reject('alter identity', (_, a) => { a.bio = '被平台指定的新性格'; });
  reject('lose original coordinate evidence', (_, a) => { delete a.scene_migration.from_position; });
  reject('forge migration reason', (_, a) => { a.scene_migration.reason = 'legacy_adventure'; });
  reject('replay stale movement', (_, a) => { a.movement = { scene_id: 'plaza', path: [{ x: 0, y: 0 }, { x: 11, y: 8 }], started_at: 2000000000000, duration_ms: 600 }; });
  reject('invent scene crossing', state => { state.events.push({ type: 'scene_changed', cursor: String(state.sequence + 1), occurred_at: 2000000010000, payload: {} }); });
  for (const c of cases.filter(c => !c.accepted)) assert.throws(() => verifyScenes(c.old, c.new), undefined, c.name);
  const source = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('migration','deploy/verify-migration.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for c in json.load(sys.stdin):
    try: m.compare_states(c['old'],c['new'],require_history=True,require_scenes=True);accepted=True
    except (AssertionError,TypeError,KeyError,ValueError): accepted=False
    assert accepted==c['accepted'],c['name']
print('Verified',${cases.length},'scene migration acceptance/rejection cases')`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', source], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
