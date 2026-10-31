import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { verifySurvival } from '../deploy/verify-survival.mjs';

const START = 2000000000000;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'v021-survival-migrate-')), dbPath = join(directory, 'world.sqlite');
  let now = START, world = new World({ dbPath, now: () => now, actionIntervalMs: 0 });
  const created = world.createAgent({ name: '原来的生存旅人', bio: '原始个性与记忆', owner_id: 'original-owner' }), controller = world.createController(created.agent_id);
  world.ownerControl(created.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 100 });
  world.callTool(world.authenticate(controller.token), 'join_world', {});
  t.after(() => { world.close(); rmSync(directory, { recursive: true, force: true }); });
  return { id: created.agent_id, get world() { return world; }, get a() { return world.agent(created.agent_id); },
    tick(delta) { now += delta; world.tick(); return structuredClone(world.state); },
    restart(delta, tick = true) { const old = structuredClone(world.state); world.close(); now += delta; world = new World({ dbPath, now: () => now, actionIntervalMs: 0 }); if (tick) world.tick(); return { old, current: structuredClone(world.state) }; } };
}
function pythonVerify(old, current) {
  const code = `import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=importlib.util.spec_from_file_location('migration',p/'deploy/verify-migration.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=json.load(sys.stdin)\nm.compare_states(x['old'],x['new'],project_root=p,require_history=True,require_scenes=True)\nprint(json.dumps({'all_migration_checks_passed':True}))`;
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, resolve('.')], { input: JSON.stringify({ old, new: current }), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
}
function verifyPythonSuccess(old, current) {
  const result = pythonVerify(old, current); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); assert.equal(JSON.parse(result.stdout).all_migration_checks_passed, true);
}
const fire = (id, site, kind, owner, fuel, lit = true) => ({ fire_id: id, site_id: site, kind, owner_agent_id: owner,
  fuel_seconds: fuel, lit, updated_at: START, created_at: START - 10000 });

test('v021 real SQLite legacy upgrade grants only default hunger state, with no free fire, torch or material', t => {
  const f = fixture(t), legacyIds = ['camp_branches','camp_stones','orchard_berries','east_pine','south_pine','wild_pine','ridge_ore','deep_berries','moon_herb'];
  // Stored legacy schema: no survival fields, nine v1 nodes and absent unowned
  // resource-tool defaults. This also exercises Python's v2 default-tool gate.
  delete f.world.state.survival; delete f.a.survival; delete f.a.life.tools.axe; delete f.a.life.tools.pickaxe;
  f.world.state.resources.version = 1;
  f.world.state.resources.nodes = Object.fromEntries(Object.entries(f.world.state.resources.nodes).filter(([id]) => legacyIds.includes(id)).map(([id, node]) => { const { ecology, ...old } = node; return [id, old]; }));
  const { old, current } = f.restart(60000), a = current.agents[f.id];
  assert.deepEqual(verifySurvival(old, current), { survival_state_preserved: true, agents: 1, fires: 0, stored_lit_fires: 0 });
  assert.equal(a.survival.satiety, 100); assert.equal(a.survival.torch, null); assert.equal(a.survival.travel, null); assert.deepEqual(current.survival.fires, {});
  assert.deepEqual(a.life.inventory, old.agents[f.id].life.inventory); assert.equal(a.adventure.hp, old.agents[f.id].adventure.hp);
  for (const id of ['axe','pickaxe']) assert.deepEqual(a.life.tools[id], { level: 1, durability: 0, max_durability: 12, owned: false });
  verifyPythonSuccess(old, current);
  const mutations = [
    s => { s.agents[f.id].survival.satiety = 99; },
    s => { s.agents[f.id].survival.torch = { lit: false, fuel_seconds: 90, updated_at: START + 60000 }; },
    s => { s.agents[f.id].life.inventory.pine_cone = 1; },
    s => { s.survival.fires.fake_fire = fire('fake_fire', 'plaza_hearth', 'campfire', f.id, 90); },
    s => { s.agents[f.id].owner_id = 'changed-owner'; },
    s => { delete s.survival; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(current); mutate(bad); assert.throws(() => verifySurvival(old, bad)); }
  const deleted = structuredClone(current); delete deleted.survival;
  assert.notEqual(pythonVerify(old, deleted).status, 0, 'personal survival fields still force the helper if world state is removed');
  const rewardedTool = structuredClone(current); rewardedTool.agents[f.id].life.tools.axe.owned = true; rewardedTool.agents[f.id].life.tools.axe.durability = 12;
  assert.notEqual(pythonVerify(old, rewardedTool).status, 0, 'new tool defaults must remain unowned even in resource v2');
});

function savedSurvival(f) {
  // These are declared persisted fixtures, not earned gameplay claims. Restart
  // must preserve these exact existing facts without invoking survival actions.
  Object.assign(f.a.life.inventory, { wood: 7, grass: 4, pine_cone: 2, torch: 2, roasted_berry: 3 });
  f.a.adventure.hp = 23; f.a.position = { x: 11.25, y: 8 }; f.a.position_at = START;
  Object.assign(f.a.survival, { satiety: 42.125, darkness_seconds: 99.9, dark_hits: 0, starvation_seconds: 3.5, hunger_hits: 0,
    warning_day: 3, dark_notified: true, hungry_notified: true, starving_notified: true, protected_until: START + 90000,
    torch: { lit: true, fuel_seconds: 12.5, updated_at: START }, travel: { site_id: 'plaza_hearth', expires_at: START + 120000,
      started_at: START, run_id: f.a.run.run_id, session_epoch: f.a.session_epoch, movement_id: 'saved_movement', hp_at_start: 23 } });
  f.world.state.survival.fires = {
    steady: { ...fire('steady', 'plaza_hearth', 'campfire', f.id, 80.75), updated_at: START - 250 },
    unlit: fire('unlit', 'orchard_hearth', 'firepit', f.id, 23.125, false),
    expires: fire('expires', 'trail_hearth', 'campfire', f.id, 5.25),
  };
}

test('v021 real SQLite restart preserves personal assets and exact fuel, extinguishes torch and clears hazards/travel', t => {
  const f = fixture(t); savedSurvival(f); const { old, current } = f.restart(10000), a = current.agents[f.id];
  assert.deepEqual(verifySurvival(old, current), { survival_state_preserved: true, agents: 1, fires: 3, stored_lit_fires: 1 });
  assert.equal(a.survival.satiety, 42.125); assert.equal(a.adventure.hp, 23); assert.deepEqual(a.position, { x: 11.25, y: 8 }); assert.deepEqual(a.run, old.agents[f.id].run);
  assert.deepEqual(a.survival.torch, { lit: false, fuel_seconds: 12.5, updated_at: START + 10000 }); assert.equal(a.survival.travel, null);
  for (const key of ['darkness_seconds','dark_hits','starvation_seconds','hunger_hits']) assert.equal(a.survival[key], 0);
  assert.equal(current.survival.fires.steady.fuel_seconds, 70.5); assert.equal(current.survival.fires.steady.lit, true);
  assert.equal(current.survival.fires.unlit.fuel_seconds, 23.125); assert.equal(current.survival.fires.unlit.lit, false);
  assert.equal(current.survival.fires.expires.fuel_seconds, 0); assert.equal(current.survival.fires.expires.lit, false);
  verifyPythonSuccess(old, current);
  const mutations = [
    s => { s.survival.fires.steady.fuel_seconds++; }, s => { s.survival.fires.steady.fuel_seconds--; },
    s => { s.survival.fires.unlit.lit = true; }, s => { s.survival.fires.steady.lit = false; },
    s => { s.survival.fires.steady.owner_agent_id = 'changed-owner'; }, s => { s.survival.fires.steady.created_at++; },
    s => { s.survival.fires.steady.site_id = 'herb_hearth'; }, s => { s.survival.fires.steady.updated_at--; },
    s => { delete s.survival.fires.expires; }, s => { s.survival.fires.added = fire('added', 'ridge_hearth', 'campfire', f.id, 90); },
    s => { s.agents[f.id].survival.satiety++; }, s => { s.agents[f.id].survival.satiety--; },
    s => { s.agents[f.id].survival.torch.lit = true; }, s => { s.agents[f.id].survival.torch.fuel_seconds++; },
    s => { s.agents[f.id].survival.travel = structuredClone(old.agents[f.id].survival.travel); },
    s => { s.agents[f.id].survival.darkness_seconds = 1; }, s => { s.agents[f.id].survival.protected_until++; },
    s => { s.agents[f.id].survival.last_at = START - 1; }, s => { s.agents[f.id].life.inventory.wood++; },
    s => { s.agents[f.id].adventure.hp--; }, s => { s.agents[f.id].run.expires_at++; },
    s => { s.events = s.events.filter(e => !(e.type === 'fire_extinguished' && e.payload.fire_id === 'expires')); },
    s => { s.events.push({ cursor: String(s.sequence + 1), occurred_at: START + 10000, type: 'fire_fueled', payload: { fire_id: 'steady' } }); },
  ];
  for (const [i, mutate] of mutations.entries()) { const bad = structuredClone(current); mutate(bad); assert.throws(() => verifySurvival(old, bad), `tamper case ${i}`); }
  const extraSatiety = structuredClone(current); extraSatiety.agents[f.id].survival.satiety++;
  assert.notEqual(pythonVerify(old, extraSatiety).status, 0, 'full Python gate executes survival validation');
  const cli = spawnSync(process.execPath, ['deploy/verify-survival.mjs'], { input: JSON.stringify({ old, new: extraSatiety }), encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.match(cli.stderr, /^Survival migration rejected \(ERR_ASSERTION\)\.\r?\n$/);
  assert.ok(!cli.stderr.includes(f.id) && !cli.stderr.includes('original-owner'), 'CLI failure logs never disclose saved private state');
});

test('v021 unsampled constructor retains a valid fuel timestamp instead of fabricating a fuel settlement', t => {
  const f = fixture(t); savedSurvival(f); const { old, current } = f.restart(10000, false);
  assert.equal(verifySurvival(old, current).survival_state_preserved, true);
  assert.equal(current.survival.fires.steady.fuel_seconds, old.survival.fires.steady.fuel_seconds);
  assert.equal(current.survival.fires.steady.updated_at, old.survival.fires.steady.updated_at, 'stored fuel plus its original timestamp still denotes the exact elapsed burn');
  assert.equal(current.agents[f.id].survival.torch.lit, false);
});

test('v021 a backward system clock cannot grant fire fuel or rewind the persisted personal clock', t => {
  const f = fixture(t); savedSurvival(f); const { old, current } = f.restart(-5000);
  assert.equal(verifySurvival(old, current).survival_state_preserved, true);
  assert.equal(current.agents[f.id].survival.last_at, old.agents[f.id].survival.last_at);
  assert.equal(current.survival.last_at, old.survival.last_at);
  for (const id of Object.keys(old.survival.fires)) assert.equal(current.survival.fires[id].fuel_seconds, old.survival.fires[id].fuel_seconds);
});

test('v021 migration verification accepts a legitimate low-fuel marker retained through later burnout', t => {
  const f = fixture(t); savedSurvival(f); const { old } = f.restart(0);
  const low = f.tick(1000); assert.equal(low.survival.fires.expires.low_notified, true); assert.equal(low.survival.fires.expires.fuel_seconds, 4.25);
  assert.equal(verifySurvival(old, low).survival_state_preserved, true);
  const burned = f.tick(5000); assert.equal(burned.survival.fires.expires.low_notified, true); assert.equal(burned.survival.fires.expires.lit, false);
  assert.equal(verifySurvival(old, burned).survival_state_preserved, true);
});
