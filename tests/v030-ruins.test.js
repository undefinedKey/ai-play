import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from '../server/world.js';
import { RUINS_RULES, publicRuins } from '../server/ruins.js';
import { findWorldPath, isWorldWalkable } from '../server/spatial.js';
import { actInputSchema } from '../server/mcp.js';
import { createHomesFixture } from './helpers/homes-fixture.js';

const object = id => RUINS_RULES.objects.find(o => o.id === id);
function pythonVerify(old, current) {
  const code = `import importlib.util,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=importlib.util.spec_from_file_location('migration',p/'deploy/verify-migration.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=json.load(sys.stdin)\nm.compare_states(x['old'],x['new'],project_root=p,require_history=True,require_scenes=True)\nprint('validated')`;
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, resolve('.')], {
    input: JSON.stringify({ old, new: current }), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
}
function fixture(t, count = 1, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }); t.after(() => { if (!options.manualClose) world.close(); });
  const players = Array.from({ length: count }, (_, n) => {
    const id = world.createAgent({ name: `遗迹来客${n}`, bio: `原来的想法${n}`, owner_id: `owner${n}` }).agent_id, ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 30, max_calls: 10000, goal: `原来的主人要求${n}` });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
    return { id, auth, get a() { return world.agent(id); },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      request(payload, type = 'ruins') { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      act(payload, type) { return world.callTool(auth, 'act', this.request(payload, type)); },
      ok(payload, type) { const r = this.act(payload, type); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; } };
  });
  const tick = (ms, heartbeat = true) => { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const finish = p => { assert.ok(p.a.ruins_job); tick((p.a.movement?.ends_at || p.a.ruins_job.ends_at) - now); assert.equal(p.a.ruins_job, null); };
  const approach = (p, id) => { p.ok({ intent: 'approach', object_id: id }); if (p.a.ruins_job) finish(p); assert.deepEqual(p.a.position, object(id).interaction_position); };
  const enter = p => { p.a.scene_id = 'adventure'; p.a.position = { ...RUINS_RULES.entrance.position }; p.ok({ intent: 'enter' }); assert.equal(p.a.scene_id, 'ruins'); };
  const unlock = p => { approach(p, 'key_cache'); p.ok({ intent: 'claim', object_id: 'key_cache' }); approach(p, 'main_gate'); p.ok({ intent: 'unlock', object_id: 'main_gate' }); };
  const solve = p => { approach(p, 'dial_west'); p.ok({ intent: 'turn', object_id: 'dial_west', direction: 'previous' }); approach(p, 'dial_east'); p.ok({ intent: 'turn', object_id: 'dial_east', direction: 'next' }); approach(p, 'rune_console'); p.ok({ intent: 'submit', object_id: 'rune_console' }); };
  return { world, players, tick, finish, approach, enter, unlock, solve, now: () => now };
}

test('v030 entrance and approach settle real paths; arrival neither chooses an interaction nor retains old scene requests', t => {
  const f = fixture(t), [p] = f.players;
  assert.equal(p.act({ intent: 'enter' }).error.code, 'SCENE_REQUIRED');
  p.a.scene_id = 'adventure'; p.a.position = { x: 38, y: 8 }; const start = { ...p.a.position };
  p.ok({ intent: 'enter' }); assert.deepEqual(p.a.position, start); assert.equal(p.a.scene_id, 'adventure'); assert.ok(p.a.movement);
  const stale = p.request({ intent: 'enter' }); f.tick(100); assert.notDeepEqual(p.a.position, start); f.finish(p);
  assert.equal(p.a.scene_id, 'ruins'); assert.deepEqual(p.a.position, RUINS_RULES.exit.position); assert.notEqual(p.a.next_action_id, stale.action_id);
  assert.throws(() => f.world.callTool(p.auth, 'act', stale), { code: 'STALE_ACTION' });
  assert.equal(p.act({ intent: 'claim', object_id: 'key_cache' }).error.code, 'OUT_OF_RANGE');
  const inventory = structuredClone(p.a.life.inventory); f.approach(p, 'key_cache');
  assert.deepEqual(p.a.life.inventory, inventory); assert.equal(f.world.state.ruins.claims.key_cache, undefined);
  f.tick(1000); assert.equal(p.a.ruins_job, null); assert.equal(p.a.life.inventory.ruins_bronze_key || 0, 0);
});

test('v030 a key opens the actual main passage only once and leaves the alternative bridge closed', t => {
  const f = fixture(t), [p] = f.players; f.enter(p);
  assert.equal(findWorldPath(f.world, 'ruins', p.a.position, object('dial_west').interaction_position), null);
  assert.equal(p.act({ intent: 'approach', object_id: 'dial_west' }).error.code, 'UNREACHABLE');
  f.approach(p, 'main_gate'); assert.equal(p.act({ intent: 'unlock', object_id: 'main_gate' }).error.code, 'INSUFFICIENT_ITEMS');
  f.unlock(p); assert.equal(p.a.life.inventory.ruins_bronze_key, 0); assert.equal(f.world.state.ruins.gate_open, true); assert.equal(f.world.state.ruins.bridge_repaired, false);
  assert.ok(findWorldPath(f.world, 'ruins', p.a.position, object('dial_west').interaction_position));
  assert.equal(isWorldWalkable(f.world, 'ruins', object('main_gate').position), true); assert.equal(isWorldWalkable(f.world, 'ruins', object('broken_bridge').position), false);
  assert.equal(p.act({ intent: 'unlock', object_id: 'main_gate' }).error.code, 'RUINS_ALREADY_OPEN');
});

test('v030 bridge route consumes exact real supplies, finishes once, and does not require or claim the key', t => {
  const f = fixture(t), [p] = f.players; f.enter(p); f.approach(p, 'broken_bridge');
  Object.assign(p.a.life.inventory, { wood: 4, ore: 0 });
  const energy = p.a.fatigue.energy; assert.equal(p.act({ intent: 'repair', object_id: 'broken_bridge' }).error.code, 'INSUFFICIENT_ITEMS'); assert.equal(p.a.fatigue.energy, energy);
  p.a.life.inventory.ore = 1; const request = p.request({ intent: 'repair', object_id: 'broken_bridge' }), result = f.world.callTool(p.auth, 'act', request);
  assert.equal(result.status, 'applied'); assert.equal(p.a.life.inventory.wood, 0); assert.equal(p.a.life.inventory.ore, 0); assert.equal(p.a.fatigue.energy, energy - 2);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), result); assert.equal(p.a.ruins_job.phase, 'repairing');
  f.tick(11999); assert.equal(f.world.state.ruins.bridge_repaired, false); f.tick(1); assert.equal(f.world.state.ruins.bridge_repaired, true); assert.equal(p.a.ruins_job, null);
  assert.equal(f.world.state.ruins.gate_open, false); assert.equal(f.world.state.ruins.claims.key_cache, undefined);
  assert.ok(findWorldPath(f.world, 'ruins', p.a.position, object('rune_console').interaction_position));
  f.tick(20000); assert.equal(f.world.state.events.filter(e => e.type === 'ruins_bridge_repaired').length, 1);
});

test('v030 shared objects have one winner, and a cancelled bridge work does not refund or unlock', t => {
  const f = fixture(t, 2), [p, q] = f.players; f.enter(p); f.enter(q); f.approach(p, 'key_cache'); f.approach(q, 'key_cache');
  const req = p.request({ intent: 'claim', object_id: 'key_cache' }), result = f.world.callTool(p.auth, 'act', req);
  assert.equal(result.status, 'applied'); assert.deepEqual(f.world.callTool(p.auth, 'act', req), result); assert.equal(q.act({ intent: 'claim', object_id: 'key_cache' }).error.code, 'RUINS_ALREADY_CLAIMED');
  assert.equal(p.a.life.inventory.ruins_bronze_key, 1); assert.equal(q.a.life.inventory.ruins_bronze_key || 0, 0);
  for (const player of [p, q]) { f.approach(player, 'broken_bridge'); Object.assign(player.a.life.inventory, { wood: 4, ore: 1 }); }
  p.ok({ intent: 'repair', object_id: 'broken_bridge' }); assert.equal(q.act({ intent: 'repair', object_id: 'broken_bridge' }).error.code, 'RUINS_OCCUPIED'); assert.equal(q.a.life.inventory.wood, 4);
  p.ok({ intent: 'cancel' }); f.tick(13000); assert.equal(f.world.state.ruins.bridge_repaired, false); assert.equal(p.a.life.inventory.wood, 0); assert.equal(publicRuins(f.world).bridge.job, null);
  q.ok({ intent: 'repair', object_id: 'broken_bridge' }); f.finish(q); assert.equal(f.world.state.ruins.bridge_repaired, true);
});

test('v030 clue and all rune choices remain facts: failed submission stays failed, explicit correct submission opens the inner path', t => {
  const f = fixture(t), [p] = f.players; f.enter(p); f.unlock(p); f.approach(p, 'rune_console');
  assert.equal(findWorldPath(f.world, 'ruins', p.a.position, object('relic_leaf').interaction_position), null);
  const before = structuredClone(p.a.life.inventory); p.ok({ intent: 'submit', object_id: 'rune_console' });
  assert.equal(f.world.state.ruins.last_attempt.success, false); assert.deepEqual(f.world.state.ruins.dials, [0, 0, 0]); assert.equal(f.world.state.ruins.archive_open, false); assert.deepEqual(p.a.life.inventory, before);
  f.tick(1000); assert.equal(f.world.state.ruins.archive_open, false);
  f.approach(p, 'dial_west'); const choices = p.observe().ruins.opportunities.filter(o => o.payload.intent === 'turn' && o.payload.object_id === 'dial_west');
  assert.deepEqual(choices.map(o => o.payload.direction).sort(), ['next', 'previous']);
  f.solve(p); assert.equal(f.world.state.ruins.archive_open, true); assert.ok(findWorldPath(f.world, 'ruins', p.a.position, object('relic_leaf').interaction_position));
  assert.ok(publicRuins(f.world).runes.clue.includes('月亮')); assert.equal(p.a.life.inventory.ruins_leaf_medallion || 0, 0);
});

test('v030 all three relics require actual approach and explicit claim; independent actor cannot duplicate any of them', t => {
  const f = fixture(t, 2), [p, q] = f.players; f.enter(p); f.unlock(p); f.solve(p); f.enter(q);
  const identity = structuredClone({ goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance, run: p.a.run });
  for (const relic of RUINS_RULES.relics) {
    assert.equal(p.act({ intent: 'claim', object_id: relic.id }).error.code, 'OUT_OF_RANGE');
    f.approach(p, relic.id); assert.equal(p.a.life.inventory[relic.item_id] || 0, 0); p.ok({ intent: 'claim', object_id: relic.id });
    f.approach(q, relic.id); assert.equal(q.act({ intent: 'claim', object_id: relic.id }).error.code, 'RUINS_ALREADY_CLAIMED');
    assert.equal(p.a.life.inventory[relic.item_id], 1); assert.equal(q.a.life.inventory[relic.item_id] || 0, 0);
  }
  f.tick(10000); assert.equal(publicRuins(f.world).relics.every(r => r.claimed_by === p.id), true);
  assert.deepEqual({ goal: p.a.goal, bio: p.a.bio, appearance: p.a.appearance, run: p.a.run }, identity);
});

for (const cause of ['cancel', 'pause', 'lease', 'run', 'hurt', 'room', 'starvation']) test(`v030 ${cause} stops bridge work without opening a passage or restoring consumed supplies`, t => {
  const f = fixture(t), [p] = f.players; f.enter(p); f.approach(p, 'broken_bridge'); Object.assign(p.a.life.inventory, { wood: 4, ore: 1 });
  if (cause === 'starvation') { p.a.survival.satiety = 0; p.a.survival.starvation_seconds = 9.5; }
  p.ok({ intent: 'repair', object_id: 'broken_bridge' });
  if (cause === 'cancel') p.ok({ intent: 'cancel' });
  else if (cause === 'pause') f.world.ownerControl(p.id, 'pause');
  else if (cause === 'room') f.world.ownerRoom('pause');
  else if (cause === 'lease') { p.a.last_contact_at = f.now() - 44900; f.tick(100, false); }
  else if (cause === 'run') { p.a.run.expires_at = f.now() + 100; f.tick(100); }
  else if (cause === 'hurt') { p.a.adventure.hp--; f.tick(1); }
  else f.tick(500);
  assert.equal(p.a.ruins_job, null); f.tick(20000); assert.equal(f.world.state.ruins.bridge_repaired, false); assert.equal(p.a.life.inventory.wood, 0); assert.equal(p.a.life.inventory.ore, 0);
});

test('v030 late ticks respect injury before, exactly at, and after the bridge completion boundary', t => {
  for (const hitAfterMs of [11900, 12000, 12100]) {
    const f = fixture(t), [p] = f.players; f.enter(p); f.approach(p, 'broken_bridge'); Object.assign(p.a.life.inventory, { wood: 4, ore: 1 });
    Object.assign(p.a.survival, { satiety: (hitAfterMs / 1000 - 10) * .04, starvation_seconds: 0, hunger_hits: 0, last_at: f.now() });
    const hp = p.a.adventure.hp; p.ok({ intent: 'repair', object_id: 'broken_bridge' }); f.tick(13000);
    assert.equal(f.world.state.ruins.bridge_repaired, hitAfterMs > 12000, `injury at ${hitAfterMs} ms`);
    assert.ok(p.a.adventure.hp < hp); assert.equal(p.a.ruins_job, null); assert.equal(p.a.life.inventory.wood, 0);
  }
});

test('v030 running exhaustion stops approach at the actual position and strict inputs cannot turn into implicit interactions', t => {
  const f = fixture(t), [p] = f.players; f.enter(p); p.a.fatigue.energy = .1;
  const origin = { ...p.a.position }; p.ok({ intent: 'approach', object_id: 'key_cache', mode: 'run' }); f.tick(10000);
  assert.equal(p.a.ruins_job, null); assert.equal(p.a.movement, null); assert.notDeepEqual(p.a.position, origin); assert.notDeepEqual(p.a.position, object('key_cache').interaction_position); assert.equal(p.a.life.inventory.ruins_bronze_key || 0, 0);
  for (const payload of [{ intent: 'turn', object_id: 'dial_west', direction: 'solve' }, { intent: 'claim', object_id: 'key_cache', mode: 'walk' }, { intent: 'enter', x: 0 }, { intent: 'cancel', object_id: 'key_cache' }, { intent: 'approach', object_id: 'missing' }]) {
    assert.equal(p.act(payload).status, 'rejected'); assert.equal(actInputSchema.safeParse({ run_id: 'r', session_epoch: 1, action_id: 'a', type: 'ruins', payload }).success, false);
  }
});

test('v030 restart retains the original identity, all permanent gates and claimed relic facts, while unfinished repairs stay cancelled', t => {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, 'ruins-v030-')), dbPath = join(dir, 'world.sqlite'); let restored;
  t.after(() => { restored?.close(); assert.equal(dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const f = fixture(t, 1, { dbPath, manualClose: true }), [p] = f.players; f.enter(p); f.unlock(p); f.solve(p); f.approach(p, 'relic_leaf'); p.ok({ intent: 'claim', object_id: 'relic_leaf' });
  f.approach(p, 'broken_bridge'); Object.assign(p.a.life.inventory, { wood: 4, ore: 1 }); p.ok({ intent: 'repair', object_id: 'broken_bridge' });
  const identity = structuredClone({ id: p.id, goal: p.a.goal, appearance: p.a.appearance, inventory: p.a.life.inventory }), old = structuredClone(f.world.state), facts = structuredClone(f.world.state.ruins); f.world.commit(); f.world.close();
  restored = new World({ dbPath, now: () => f.now() + 30000 }); const a = restored.agent(p.id);
  assert.equal(a.ruins_job, null); assert.equal(a.movement, null); assert.equal(a.scene_id, 'ruins'); assert.deepEqual(restored.state.ruins, facts); assert.equal(restored.state.ruins.bridge_repaired, false);
  assert.deepEqual({ id: a.agent_id, goal: a.goal, appearance: a.appearance, inventory: a.life.inventory }, identity);
  const verified = pythonVerify(old, restored.state); assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  for (const mutate of [s => { s.ruins.bridge_repaired = true; }, s => { s.ruins.gate_open = false; }, s => { s.ruins.claims.relic_bird = { agent_id: p.id, at: f.now() }; },
    s => { s.agents[p.id].ruins_job = old.agents[p.id].ruins_job; }, s => { s.agents[p.id].life.inventory.ruins_stone_bird = 1; }]) {
    const bad = structuredClone(restored.state); mutate(bad); assert.notEqual(pythonVerify(old, bad).status, 0);
  }
});

test('v030 HTTP/MCP unique relic makes the real return trip and can be displayed and withdrawn without copying or changing its owner AI', async t => {
  const f = await createHomesFixture({ frontend: false, authMode: 'accounts', starterItems: { wood: 50, ore: 20, grass: 20 } }); t.after(f.close);
  const p = await f.actor('原来的旅人'), q = await f.actor('另一位旅人'), world = f.app.world;
  const identity = structuredClone({ goal: p.raw.goal, appearance: p.raw.appearance, name: p.raw.name, bio: p.raw.bio });
  p.raw.position = { x: 24, y: 16 }; await p.act('home', { intent: 'build' }); let home = world.state.homes[`home_${p.id}`];
  await p.act('home', { intent: 'visit', home_id: home.home_id }); await f.until(() => !!p.raw.home_presence);
  await p.act('home', { intent: 'craft', kind: 'display_shelf' }); const shelf = home.furniture.at(-1).instance_id;
  await p.act('home', { intent: 'place', instance_id: shelf, x: 1, y: 4 }); await p.act('home', { intent: 'leave' }); await f.until(() => !p.raw.home_presence && !p.raw.home_travel);
  // Fixture places both original AIs at the outside entrance. All progression below uses actual MCP actions and simulation.
  for (const a of [p, q]) { a.raw.scene_id = 'adventure'; a.raw.position = { ...RUINS_RULES.entrance.position }; await a.act('ruins', { intent: 'enter' }); }
  const approach = async (actor, id) => { await actor.act('ruins', { intent: 'approach', object_id: id }); await f.until(() => !actor.raw.ruins_job); assert.deepEqual(actor.raw.position, object(id).interaction_position); };
  for (const a of [p, q]) await approach(a, 'key_cache');
  const requests = await Promise.all([p.request('ruins', { intent: 'claim', object_id: 'key_cache' }), q.request('ruins', { intent: 'claim', object_id: 'key_cache' })]);
  const receipts = await Promise.all([p.send(requests[0]), q.send(requests[1])]); assert.equal(receipts.filter(r => r.status === 'applied').length, 1);
  const keyHolder = receipts[0].status === 'applied' ? p : q; await approach(keyHolder, 'main_gate'); await keyHolder.act('ruins', { intent: 'unlock', object_id: 'main_gate' });
  await approach(p, 'dial_west'); await p.act('ruins', { intent: 'turn', object_id: 'dial_west', direction: 'previous' }); await approach(p, 'dial_east'); await p.act('ruins', { intent: 'turn', object_id: 'dial_east', direction: 'next' }); await approach(p, 'rune_console'); await p.act('ruins', { intent: 'submit', object_id: 'rune_console' });
  await approach(p, 'relic_leaf'); const picked = await p.applied('ruins', { intent: 'claim', object_id: 'relic_leaf' }); assert.deepEqual(await p.send(picked.req), picked.receipt);
  await approach(q, 'relic_leaf'); assert.equal((await q.send(await q.request('ruins', { intent: 'claim', object_id: 'relic_leaf' }))).error.code, 'RUINS_ALREADY_CLAIMED');
  await p.act('ruins', { intent: 'leave' }); assert.equal(p.raw.scene_id, 'ruins'); await f.until(() => !p.raw.ruins_job); assert.equal(p.raw.scene_id, 'adventure'); assert.equal(p.raw.adventure.in_field, true); assert.equal(p.raw.adventure.decision_until, null);
  await p.act('adventure_plan', { intent: 'retreat' }); await f.until(() => p.raw.scene_id === 'plaza' && !p.raw.adventure.plan);
  home = world.state.homes[`home_${p.id}`];
  await p.act('home', { intent: 'visit', home_id: home.home_id }); await f.until(() => !!p.raw.home_presence);
  const display = await p.applied('home', { intent: 'display', instance_id: shelf, item_id: 'ruins_leaf_medallion', title: '我带回的叶纹章', text: '我自己选的纪念品' });
  assert.equal(p.raw.life.inventory.ruins_leaf_medallion, 0); assert.equal(home.displays.length, 1); assert.deepEqual(await p.send(display.req), display.receipt); assert.equal(home.displays.length, 1);
  await p.act('home', { intent: 'withdraw', display_id: home.displays[0].display_id }); assert.equal(home.displays.length, 0); assert.equal(p.raw.life.inventory.ruins_leaf_medallion, 1);
  const snapshot = (await f.api('/api/public/world')).body, text = JSON.stringify(snapshot); assert.equal(snapshot.ruins.relics.find(r => r.id === 'relic_leaf').claimed_by, p.id); assert.ok(!text.includes(p.token)); assert.ok(!text.includes(p.goal));
  assert.deepEqual({ goal: p.raw.goal, appearance: p.raw.appearance, name: p.raw.name, bio: p.raw.bio }, identity);
});
