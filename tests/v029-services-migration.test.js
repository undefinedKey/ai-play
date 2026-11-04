import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { verifyResources } from '../deploy/verify-resources.mjs';
import { RESOURCE_NODES } from '../shared/resources-layout.js';

const NODE = 'camp_fallen_berries', START = 2000000000000;
function restoreV028Catalog(world) {
  delete world.state.resources.nodes[NODE];
  for (const node of RESOURCE_NODES.filter(node => node.scene_id === 'journey')) delete world.state.resources.nodes[node.id];
}
function fixture(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'v029-services-'));
  const dbPath = join(directory, 'world.sqlite'); let now = START;
  let world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  const created = world.createAgent({ name: '原来的居民', owner_id: 'original-owner', bio: '原始个性\n与记忆 🐟' });
  const id = created.agent_id, ctl = world.createController(id);
  world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 60, max_calls: null, goal: '按自己的想法生活\n可以发呆 🐟' });
  world.callTool(world.authenticate(ctl.token), 'join_world');
  const a = world.agent(id); a.position = { x: 11, y: 8 }; a.fatigue.energy = 0; a.survival.satiety = 0;
  a.life.inventory = {}; a.adventure.gold = 0; a.adventure.hp = 23;
  t.after(() => { world.close(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  return { id, get world() { return world; }, restart(ms = 5000) {
    const old = structuredClone(world.state); world.close(); now += ms;
    world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); world.tick();
    return { old, current: structuredClone(world.state) };
  } };
}
function pythonVerify(old, current) {
  const code = `import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=importlib.util.spec_from_file_location('migration',p/'deploy/verify-migration.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=json.load(sys.stdin)\nm.compare_states(x['old'],x['new'],project_root=p,require_history=True,require_scenes=True)\nprint('validated')`;
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, resolve('.')], {
    input: JSON.stringify({ old, new: current }), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
}

test('v029 real SQLite v028 upgrade adds only shared fruit; identity, goals and empty personal supplies remain exact', t => {
  const f = fixture(t); restoreV028Catalog(f.world);
  const saved = f.world.state.resources.nodes.camp_branches;
  saved.stock = 1; saved.regrow_at = START + 600000;
  saved.reservation = { agent_id: f.id, job_id: 'interrupted-old-job', expires_at: START + 90000 };
  const { old, current } = f.restart();
  assert.equal(Object.keys(old.resources.nodes).length, 31);
  assert.equal(verifyResources(old, current).nodes, RESOURCE_NODES.length);
  assert.deepEqual(current.resources.nodes[NODE], { stock: 1, regrow_at: null, reservation: null });
  assert.deepEqual(current.resources.nodes.camp_branches, { stock: 1, regrow_at: START + 600000, reservation: null });
  const a = current.agents[f.id], before = old.agents[f.id];
  for (const key of ['agent_id', 'owner_id', 'name', 'bio', 'appearance', 'goal', 'run', 'position']) assert.deepEqual(a[key], before[key], key);
  assert.deepEqual(a.life.inventory, {}); assert.equal(a.adventure.gold, 0); assert.equal(a.adventure.hp, 23);
  assert.equal(a.fatigue.energy, 1.5, 'the existing universal camp rule restores exactly 0.3 energy/s while offline');
  assert.equal(a.survival.satiety, 0); assert.equal(a.status, 'offline');
  assert.equal(a.life.gathering, null); assert.equal(a.movement, null);
  const result = pythonVerify(old, current); assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const mutate of [s => { s.agents[f.id].life.inventory.berry = 1; }, s => { s.agents[f.id].survival.satiety = 12; },
    s => { s.agents[f.id].adventure.gold = 12; }, s => { s.agents[f.id].goal += '强制去吃饭'; }]) {
    const bad = structuredClone(current); mutate(bad);
    assert.notEqual(pythonVerify(old, bad).status, 0, 'release verifier rejects personal awards or rewritten intentions');
  }
});

test('v029 migration rejects missing/unknown old nodes, forged stock/deadlines, replayed reservations and clock changes', t => {
  const f = fixture(t); restoreV028Catalog(f.world);
  const { old, current } = f.restart();
  assert.equal(verifyResources(old, current).nodes, RESOURCE_NODES.length);
  for (const mutate of [s => { delete s.resources.nodes.camp_stones; }, s => { s.resources.nodes.unknown = { stock: 1, regrow_at: null, reservation: null }; }]) {
    const bad = structuredClone(old); mutate(bad); assert.throws(() => verifyResources(bad, current));
  }
  for (const mutate of [s => { delete s.resources.nodes[NODE]; }, s => { delete s.resources.nodes.camp_stones; },
    s => { s.resources.nodes.unknown = { stock: 1, regrow_at: null, reservation: null }; }, s => { s.resources.nodes[NODE].stock = 0; },
    s => { s.resources.nodes[NODE].regrow_at = START + 120000; }, s => { s.resources.nodes[NODE].reservation = { agent_id: f.id, job_id: 'replay', expires_at: START + 90000 }; },
    s => { s.resources.nodes.camp_stones.stock++; }, s => { s.resources.nodes.east_pine.ecology.generation++; }, s => { s.day_cycle.epoch_at++; }]) {
    const bad = structuredClone(current); mutate(bad); assert.throws(() => verifyResources(old, bad));
  }
});

test('v029 existing depleted shared fruit keeps its deadline across restart and never grants offline food', t => {
  const f = fixture(t), node = f.world.state.resources.nodes[NODE];
  node.stock = 0; node.regrow_at = START + 120000;
  let pair = f.restart(60000);
  assert.equal(verifyResources(pair.old, pair.current).nodes, RESOURCE_NODES.length);
  assert.deepEqual(pair.current.resources.nodes[NODE], { stock: 0, regrow_at: START + 120000, reservation: null });
  pair = f.restart(60000); assert.equal(verifyResources(pair.old, pair.current).nodes, RESOURCE_NODES.length);
  assert.deepEqual(pair.current.resources.nodes[NODE], { stock: 1, regrow_at: null, reservation: null });
  assert.deepEqual(pair.current.agents[f.id].life.inventory, {});
  assert.equal(pair.current.agents[f.id].survival.satiety, 0);
  assert.equal(pair.current.agents[f.id].fatigue.energy, 36, 'only the unchanged 120 seconds of camp recovery is applied');
});
