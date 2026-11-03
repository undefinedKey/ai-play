import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { RUINS_RULES } from '../shared/ruins-layout.js';
import { findWorldPath, publicMovement, recordMovement } from '../server/spatial.js';
import { spectatorSnapshot, scopeSpectatorSnapshot } from '../server/spectator.js';

function fixture(t) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const id = world.createAgent({ name: '保留原想法的来客', bio: '不会替我选择的世界' }).agent_id, ctl = world.createController(id);
  world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 30, max_calls: 10000, goal: '主人原来的要求' });
  const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
  const p = { get a() { return world.agent(id); }, observe: () => world.callTool(auth, 'observe', { run_id: p.a.run.run_id, session_epoch: p.a.session_epoch }),
    act(type, payload) { const o = p.observe(); return world.callTool(auth, 'act', { type, payload, action_id: o.next_action_id, run_id: o.run_id, session_epoch: o.session_epoch }); } };
  const tick = ms => { now += ms; p.a.last_contact_at = now; world.tick(); };
  return { world, p, id, auth, tick, now: () => now };
}

test('v030 a real monster impact immediately stops an entrance trip in the same frame, before a later move or scene switch', t => {
  const f = fixture(t), { world, p } = f;
  p.a.scene_id = 'adventure'; p.a.position = { x: 38, y: 8 }; p.a.adventure.in_field = true;
  const m = world.state.adventure.monsters[0];
  Object.assign(m, { position: { ...p.a.position }, home_position: { ...p.a.position }, movement: null, target_agent_id: f.id, behavior: 'attacking', next_attack_at: f.now() + 100000, next_patrol_at: f.now() + 100000 });
  m.action = { action_id: 'monster_fixture_impact', type: 'attack', scene_id: 'adventure', target_id: f.id, target_kind: 'agent', facing: 'east', started_at: f.now(), impact_at: f.now() + 100, ends_at: f.now() + 1000, phase: 'prepare', outcome: null, damage: 0, resolved_at: null };
  assert.equal(p.act('ruins', { intent: 'enter' }).status, 'applied'); const hp = p.a.adventure.hp;
  f.tick(100); assert.ok(p.a.adventure.hp < hp); assert.equal(p.a.ruins_job, null); assert.equal(p.a.movement, null); assert.equal(p.a.scene_id, 'adventure');
  const stopped = { ...p.a.position }; f.tick(100); assert.deepEqual(p.a.position, stopped); assert.equal(p.a.ruins_job, null);
  assert.equal(world.state.events.filter(e => e.type === 'ruins_cancelled' && e.payload.reason === 'hurt').length, 1);
  assert.equal(world.state.events.some(e => e.type === 'ruins_entered'), false);
});

test('v030 every rune direction has a distinct opportunity identity and is executable; observing never chooses an answer', t => {
  const f = fixture(t), { world, p } = f;
  world.state.ruins.gate_open = true; p.a.scene_id = 'ruins'; p.a.position = { ...RUINS_RULES.dials[0].interaction_position };
  const before = structuredClone(world.state), choices = p.observe().opportunities.filter(o => o.action.type === 'ruins' && o.action.payload.intent === 'turn');
  assert.equal(choices.length, 2); assert.equal(new Set(choices.map(o => o.id)).size, 2); assert.deepEqual(world.state.ruins.dials, [0, 0, 0]);
  for (const choice of choices) {
    world.state = structuredClone(before);
    assert.equal(p.act(choice.action.type, choice.action.payload).status, 'applied');
    assert.equal(world.state.ruins.dials[0], choice.action.payload.direction === 'next' ? 1 : 2);
    assert.equal(world.state.ruins.archive_open, false);
  }
});

test('v030 manual movement, hints and fractional path endpoints cannot bypass dynamic gates', t => {
  const f = fixture(t), { world, p } = f; p.a.scene_id = 'ruins'; p.a.position = { ...RUINS_RULES.gate.interaction_position };
  const start = { ...p.a.position }, target = { x: 18, y: 24 };
  assert.equal(p.act('move', { ...target, path: [start, { x: 17, y: 24 }, target] }).status, 'rejected'); assert.deepEqual(p.a.position, start); assert.equal(p.a.movement, null);
  assert.equal(findWorldPath(world, 'ruins', { x: 16.5, y: 24 }, { x: 17.5, y: 24 }), null);
  assert.equal(p.observe().movement.candidates.some(c => c.path.some(q => q.x === 17 && q.y === 24)), false);
  recordMovement(p.a, [start, { x: 17, y: 24 }, target], f.now()); assert.equal(publicMovement(p.a, world), null, 'even a corrupt server timeline is not advertised as legal to viewers'); p.a.movement = null;
  world.state.ruins.gate_open = true;
  assert.equal(p.act('move', target).status, 'applied'); f.tick(1000); assert.deepEqual(p.a.position, target);
});

test('v030 matching coordinates in ruins cannot operate remote plaza facilities or substitute an old adventure plan for the exit', t => {
  const { world, p } = fixture(t); p.a.scene_id = 'ruins'; p.a.position = { x: 11, y: 8 };
  Object.assign(p.a.life.inventory, { wood: 100, ore: 100, grass: 100, turnip_seed: 10 }); p.a.adventure.gold = 100;
  const initial = structuredClone({ inventory: p.a.life.inventory, gold: p.a.adventure.gold, goal: p.a.goal, position: p.a.position });
  for (const [type, payload] of [
    ['adventure_plan', { intent: 'retreat' }], ['adventure_plan', { intent: 'explore', zone_id: 'forest' }],
    ['home', { intent: 'build' }], ['inventory', { intent: 'craft', item_id: 'wooden_sword' }],
    ['trade', { intent: 'buy', item_id: 'turnip', quantity: 1 }], ['farm', { intent: 'till', plot_id: p.a.life.plots[0].plot_id }],
    ['fish', { intent: 'start', spot_id: 'plaza_pond_south', bait_id: 'fish_bait' }], ['start_activity', { activity_id: 'relax' }],
  ]) {
    const result = p.act(type, payload); assert.equal(result.status, 'rejected', JSON.stringify({ type, payload, result }));
    assert.deepEqual({ inventory: p.a.life.inventory, gold: p.a.adventure.gold, goal: p.a.goal, position: p.a.position }, initial); assert.equal(p.a.scene_id, 'ruins');
  }
  assert.equal(world.state.ruins.gate_open, false); assert.equal(world.state.ruins.archive_open, false);
});

test('v030 observer scene switching changes neither actor state nor shared mechanisms, and ruins contain no adventure monsters', t => {
  const { world, p } = fixture(t); p.a.scene_id = 'ruins'; p.a.position = { ...RUINS_RULES.exit.position };
  const before = structuredClone(world.state), snapshot = spectatorSnapshot(world);
  for (const scene of ['plaza', 'adventure', 'ruins']) {
    const view = scopeSpectatorSnapshot(snapshot, scene), actor = view.agents.find(a => a.agent_id === p.a.agent_id);
    assert.equal(actor.scene_id, 'ruins'); assert.deepEqual(actor.position, RUINS_RULES.exit.position);
    if (scene !== 'adventure') assert.equal(view.adventure.monsters.length, 0);
    assert.equal(JSON.stringify(view).includes('主人原来的要求'), false);
  }
  assert.deepEqual(world.state, before);
});

test('v030 shared mechanism changes reach other ruins visitors through get_events but personal trips and outside scenes remain separate', t => {
  const f = fixture(t), { world, p } = f;
  const visitor = (name, scene) => {
    const id = world.createAgent({ name }).agent_id, ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, duration_minutes: 30, max_calls: 10000 });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world'); world.agent(id).scene_id = scene;
    return { id, auth };
  };
  const q = visitor('同遗迹的来客', 'ruins'), outside = visitor('广场上的来客', 'plaza');
  const events = (visitor, cursor) => { const a = world.agent(visitor.id); return world.callTool(visitor.auth, 'get_events', { run_id: a.run.run_id, session_epoch: a.session_epoch, cursor: String(cursor) }).events; };
  p.a.scene_id = 'ruins'; p.a.position = { ...RUINS_RULES.key.interaction_position }; let cursor = world.state.sequence;
  assert.equal(p.act('ruins', { intent: 'claim', object_id: 'key_cache' }).status, 'applied');
  assert.ok(events(q, cursor).some(e => e.type === 'ruins_claimed')); assert.equal(events(outside, cursor).some(e => e.type === 'ruins_claimed'), false);
  cursor = world.state.sequence; assert.equal(p.act('ruins', { intent: 'approach', object_id: 'main_gate' }).status, 'applied');
  assert.equal(events(q, cursor).some(e => e.type === 'ruins_approaching'), false);
  f.tick(p.a.movement.ends_at - f.now()); assert.equal(p.a.ruins_job, null); cursor = world.state.sequence;
  assert.equal(p.act('ruins', { intent: 'unlock', object_id: 'main_gate' }).status, 'applied');
  assert.ok(events(q, cursor).some(e => e.type === 'ruins_gate_opened')); assert.equal(events(outside, cursor).some(e => e.type === 'ruins_gate_opened'), false);
  const publicChanges = events(q, cursor); assert.ok(!JSON.stringify(publicChanges).includes('主人原来的要求'));
});
