import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { initializeJourney, publicJourney, publicJourneyJob } from '../server/journey.js';
import { JOURNEY_RULES, validJourney } from '../shared/journey.js';
import { isWalkable } from '../shared/world-layout.js';
import { findWorldPath, publicMovement } from '../server/spatial.js';
import { captureSurvival } from '../server/survival.js';

function fixture(t, count = 1) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const players = Array.from({ length: count }, (_, i) => {
    const id = world.createAgent({ name: `林间访客${i}`, bio: `原性格${i}`, owner_id: `journey-owner-${i}` }).agent_id, controller = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 10000, goal: `原主人目标${i}` });
    const auth = world.authenticate(controller.token); world.callTool(auth, 'join_world');
    return { id, auth, get a() { return world.agent(id); },
      observe() { return world.callTool(auth, 'observe', { run_id: this.a.run.run_id, session_epoch: this.a.session_epoch }); },
      request(payload, type = 'journey') { const o = this.observe(); return { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }; },
      send(req) { return world.callTool(auth, 'act', req); },
      act(payload, type) { return this.send(this.request(payload, type)); },
      ok(payload, type) { const r = this.act(payload, type); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; },
      at(x, y = 16) { this.a.scene_id = 'journey'; this.a.position = { x, y }; this.a.position_at = now; this.a.movement = null; },
    };
  });
  return { world, players, now: () => now,
    tick(ms, heartbeat = true) { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); },
    step(ms) { for (let elapsed = 0; elapsed < ms; elapsed += 100) this.tick(Math.min(100, ms - elapsed)); },
    arrive(p) { assert.ok(p.a.movement); this.tick(p.a.movement.ends_at - now); },
    day() { world.state.day_cycle.epoch_at = now; world.state.day_cycle.last_at = now; },
  };
}

test('v033 strict portable contract and actual authored road expose finite choices', () => {
  for (const p of [{ intent: 'browse' }, { intent: 'enter', mode: 'run' }, { intent: 'travel', node_id: 'camp', route: 'bypass' }, { intent: 'hunt', monster_id: 'journey_slime' }, { intent: 'rest', duration_seconds: 30 }, { intent: 'leave' }, { intent: 'stop' }]) assert.equal(validJourney(p), true);
  for (const p of [{ intent: 'enter', goal: 'auto' }, { intent: 'travel', node_id: 'unknown' }, { intent: 'travel', node_id: 'camp', route: 'fly' }, { intent: 'hunt', monster_id: 'forest_slime' }, { intent: 'rest', duration_seconds: 61 }, { intent: 'rest', duration_seconds: 14 }, { intent: 'stop', mode: 'run' }]) assert.equal(validJourney(p), false);
  assert.ok(isWalkable('journey', { x: 15, y: 18 })); assert.ok(!isWalkable('journey', { x: 18, y: 17 }));
  assert.ok(findWorldPath(null, 'journey', { x: 2, y: 16 }, { x: 43, y: 16 }));
});

test('v033 explicit entry walks to a real portal and never moves another actor or rewrites identity', t => {
  const f = fixture(t, 2), [p, q] = f.players, before = structuredClone({ goal: p.a.goal, bio: p.a.bio, inventory: p.a.life.inventory, appearance: p.a.appearance, q: q.a.position });
  const start = { ...p.a.position }; p.ok({ intent: 'enter' }); assert.deepEqual(p.a.position, start); assert.equal(p.a.scene_id, 'plaza'); assert.ok(publicMovement(p.a, f.world));
  f.arrive(p); assert.equal(p.a.scene_id, 'journey'); assert.deepEqual(p.a.position, { x: 2, y: 16 }); assert.equal(p.a.journey_job, null);
  assert.deepEqual({ goal: p.a.goal, bio: p.a.bio, inventory: p.a.life.inventory, appearance: p.a.appearance, q: q.a.position }, before);
});

test('v033 direct travel stops at an encounter without attacking; repeated travel cannot creep through it', t => {
  const f = fixture(t), [p] = f.players; p.at(2); p.ok({ intent: 'travel', node_id: 'camp' }); f.arrive(p);
  assert.deepEqual(p.a.position, { x: 15, y: 16 }); assert.equal(p.a.journey_job, null); assert.equal(p.a.journey_last_result.kind, 'encounter');
  const before = { hp: p.a.adventure.hp, energy: p.a.fatigue.energy, monsterHp: f.world.state.journey.monsters[0].hp };
  for (let i = 0; i < 3; i++) p.ok({ intent: 'travel', node_id: 'camp' });
  f.step(4000); assert.deepEqual(p.a.position, { x: 15, y: 16 }); assert.deepEqual({ hp: p.a.adventure.hp, energy: p.a.fatigue.energy, monsterHp: f.world.state.journey.monsters[0].hp }, before);
  assert.equal(f.world.state.events.filter(e => e.type === 'journey_combat').length, 0);
});

test('v033 bypass uses a longer actual branch, preserves monsters, and ends without collecting or resting', t => {
  const f = fixture(t), [p] = f.players; p.at(15); const inventory = structuredClone(p.a.life.inventory), hp = f.world.state.journey.monsters.map(m => m.hp);
  p.ok({ intent: 'travel', node_id: 'camp', route: 'bypass' }); const path = p.a.movement.path;
  assert.ok(path.some(p => p.x === 18 && p.y === 18)); assert.ok(path.some(p => p.x === 35 && p.y === 18)); assert.ok(!path.some(p => p.x === 18 && p.y === 16)); assert.ok(publicMovement(p.a, f.world));
  f.arrive(p); assert.deepEqual(p.a.position, { x: 43, y: 16 }); assert.equal(p.a.journey_job, null); assert.deepEqual(p.a.life.inventory, inventory); assert.deepEqual(f.world.state.journey.monsters.map(m => m.hp), hp);
  p.ok({ intent: 'leave', route: 'bypass' }); f.arrive(p); assert.equal(p.a.scene_id, 'plaza'); assert.deepEqual(p.a.position, { x: 22, y: 8 });
});

test('v033 bypass after stopping combat withdraws to its near branch instead of walking through the enemy', t => {
  const f = fixture(t), [p] = f.players; p.at(17); p.ok({ intent: 'travel', node_id: 'clearing', route: 'bypass' });
  const path = p.a.movement.path; assert.ok(path.some(p => p.x === 15 && p.y === 16)); assert.ok(path.some(p => p.x === 18 && p.y === 18)); assert.ok(!path.some(p => p.x === 18 && p.y === 16));
  f.arrive(p); assert.equal(p.a.position.x, 26);
  p.at(15, 17); p.ok({ intent: 'travel', node_id: 'clearing' }); f.arrive(p); assert.deepEqual(p.a.position, { x: 15, y: 16 });
});

test('v033 a bounded traversal accepted while monsters are defeated is not retroactively cancelled on respawn', t => {
  const f = fixture(t), [p] = f.players; p.at(2);
  for (const m of f.world.state.journey.monsters) { m.hp = 0; m.status = 'respawning'; m.respawn_at = f.now() + 1000; }
  p.ok({ intent: 'travel', node_id: 'camp' }); f.tick(1100); assert.ok(f.world.state.journey.monsters.every(m => m.status === 'alive')); assert.ok(p.a.journey_job);
  f.arrive(p); assert.equal(p.a.position.x, 43); assert.equal(p.a.adventure.hp, 40); assert.ok(JOURNEY_RULES.traversal_policy.includes('接受'));
  p.ok({ intent: 'travel', node_id: 'entry' }); f.arrive(p); assert.equal(p.a.position.x, 38, 'the next route observes respawned monster');
});

test('v033 physical combat has windup and equipment costs; bystanders are never enrolled', t => {
  const f = fixture(t, 2), [p, q] = f.players; p.at(17); q.at(18); const qHp = q.a.adventure.hp, energy = p.a.fatigue.energy;
  p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); f.tick(100); assert.equal(p.a.journey_job.phase, 'fighting'); assert.equal(p.a.action.phase, 'prepare');
  assert.equal(f.world.state.journey.monsters[0].hp, 24); f.tick(350); assert.equal(p.a.action.outcome, 'hit'); assert.equal(f.world.state.journey.monsters[0].hp, 18); assert.equal(p.a.fatigue.energy, energy - 3);
  f.step(4000); assert.equal(q.a.adventure.hp, qHp); assert.equal(q.a.journey_job ?? null, null); assert.equal(p.a.journey_job, null); assert.equal(f.world.state.journey.monsters[0].status, 'respawning');
  assert.equal(p.a.adventure.gold, 6); assert.equal(p.a.adventure.xp, 12); assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'journey_loot').length, 1);
  f.step(2000); assert.equal(p.a.adventure.gold, 6); assert.equal(p.a.goal, '原主人目标0');
});

test('v033 stopped preparation and stale ticks never replay damage; no cooldown reset on replanning', t => {
  const f = fixture(t), [p] = f.players; p.at(17); p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); f.tick(100);
  const next = p.a.adventure.next_attack_at; p.ok({ intent: 'stop' }); f.tick(500); assert.equal(f.world.state.journey.monsters[0].hp, 24); assert.equal(p.a.adventure.hp, 40);
  p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); assert.equal(p.a.adventure.next_attack_at, next); f.tick(500); f.tick(10000);
  assert.equal(f.world.state.journey.monsters[0].hp, 24); assert.equal(p.a.adventure.hp, 40); assert.equal(p.a.adventure.gold, 0);
});

test('v033 shared damage divides a single kill reward', t => {
  const f = fixture(t, 2), [p, q] = f.players; p.at(17); q.at(17); p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); q.ok({ intent: 'hunt', monster_id: 'journey_slime' });
  f.step(2500); assert.equal(p.a.adventure.gold + q.a.adventure.gold, 6); assert.equal(p.a.adventure.xp + q.a.adventure.xp, 12); assert.ok(p.a.adventure.gold > 0 && q.a.adventure.gold > 0);
  assert.equal(f.world.state.events.filter(e => e.type === 'journey_loot').length, 2);
});

test('v033 stopped contributors do not receive the later kill or rejoin combat implicitly', t => {
  const f = fixture(t, 2), [p, q] = f.players; p.at(17); q.at(17); p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); f.step(500);
  assert.equal(f.world.state.journey.monsters[0].hp, 18); p.ok({ intent: 'stop' }); q.ok({ intent: 'hunt', monster_id: 'journey_slime' }); f.step(4000);
  assert.equal(p.a.adventure.gold, 0); assert.equal(q.a.adventure.gold, 6); assert.equal(p.a.journey_job, null); assert.equal(q.a.journey_job, null);
});

test('v033 low health ends chosen fight without fleeing, healing, or deciding a new task', t => {
  const f = fixture(t), [p] = f.players; p.at(34); p.a.adventure.hp = 11; p.ok({ intent: 'hunt', monster_id: 'journey_boar' }); f.step(1000);
  assert.equal(p.a.journey_job, null); assert.equal(p.a.journey_last_result.kind, 'needs_decision'); assert.equal(p.a.adventure.hp, 6); assert.deepEqual(p.a.position, { x: 34, y: 16 });
  f.step(10000); assert.equal(p.a.adventure.hp, 6); assert.equal(p.a.journey_job, null);
});

test('v033 pause cancels actual travel and combat without granting loot or changing scene', t => {
  const f = fixture(t), [p] = f.players; p.at(2); p.ok({ intent: 'travel', node_id: 'camp', route: 'bypass', mode: 'run' }); f.tick(1000); const position = { ...p.a.position };
  f.world.ownerControl(p.id, 'pause'); assert.equal(p.a.journey_job, null); assert.equal(p.a.movement, null); f.tick(50000, false); assert.deepEqual(p.a.position, position); assert.equal(p.a.scene_id, 'journey'); assert.equal(p.a.adventure.gold, 0);
});

test('v033 hazard position sampling uses the same finite feature deadline as actual travel', t => {
  const f = fixture(t), [p] = f.players; p.at(2); p.ok({ intent: 'travel', node_id: 'camp', route: 'bypass' });
  const deadline = f.now() + 1000; p.a.journey_job.expires_at = deadline;
  // Capture at the job boundary without advancing the public simulation first.
  const originalNow = f.world.now; f.world.now = () => deadline + 5000;
  assert.equal(captureSurvival(f.world).get(p.id).moveUntil, deadline); f.world.now = originalNow;
  f.tick(6000); assert.deepEqual(p.a.position, { x: 4, y: 16 }); assert.equal(p.a.journey_job, null);
});

test('v033 camp rest is finite with actual hunger/light and preserves the original inventory', t => {
  const f = fixture(t), [p] = f.players; f.day(); p.at(43); p.a.fatigue.energy = 20; p.a.adventure.hp = 20; const inventory = structuredClone(p.a.life.inventory);
  p.ok({ intent: 'rest', duration_seconds: 15 }); assert.equal(publicJourneyJob(p.a).ends_at, f.now() + 15000); f.tick(15000);
  assert.equal(p.a.journey_job, null); assert.equal(p.a.fatigue.energy, 50); assert.equal(p.a.adventure.hp, 40); f.tick(15000); assert.equal(p.a.fatigue.energy, 50); assert.deepEqual(p.a.life.inventory, inventory);
  p.a.survival.satiety = 0; assert.equal(p.act({ intent: 'rest', duration_seconds: 15 }).error.code, 'REST_NEEDS_SUPPLIES');
});

test('v033 delayed disconnect settles only the authorized rest interval and never renews it', t => {
  const f = fixture(t), [p] = f.players; f.day(); p.at(43); p.a.fatigue.energy = 0; p.a.adventure.hp = 1;
  p.ok({ intent: 'rest', duration_seconds: 60 }); p.a.last_contact_at = f.now() - 40000; f.tick(30000, false);
  assert.equal(p.a.status, 'offline'); assert.equal(p.a.journey_job, null); assert.equal(p.a.fatigue.energy, 10); assert.equal(p.a.adventure.hp, 11);
});

test('v033 night camp has no invented light; finite torch fuel bounds rest recovery', t => {
  const f = fixture(t), [p] = f.players; p.at(43); f.world.state.day_cycle.epoch_at = f.now() - 360000; f.world.state.day_cycle.last_at = f.now();
  assert.equal(p.act({ intent: 'rest', duration_seconds: 15 }).error.code, 'REST_NEEDS_SUPPLIES');
  p.a.survival.torch = { lit: true, fuel_seconds: 5, updated_at: f.now() }; p.a.fatigue.energy = 10; p.a.adventure.hp = 10;
  p.ok({ intent: 'rest', duration_seconds: 15 }); f.tick(15000); assert.equal(p.a.journey_job, null); assert.equal(p.a.journey_last_result.kind, 'needs_supplies');
  assert.equal(p.a.fatigue.energy, 20); assert.equal(p.a.adventure.hp, 20); assert.equal(p.a.survival.torch.fuel_seconds, 0);
});

test('v033 environmental damage cancels a chosen hunt without retaliation or delayed hits', t => {
  const f = fixture(t), [p] = f.players; f.day(); p.at(17); p.a.survival.satiety = 0; p.a.survival.starvation_seconds = 9.8;
  p.ok({ intent: 'hunt', monster_id: 'journey_slime' }); f.tick(100); f.tick(100); assert.equal(p.a.journey_job, null); assert.equal(p.a.journey_last_result.kind, 'hurt');
  const monsterHp = f.world.state.journey.monsters[0].hp; f.tick(1000); assert.equal(f.world.state.journey.monsters[0].hp, monsterHp); assert.equal(p.a.adventure.gold, 0);
});

test('v033 restart preserves scene, personal state and defeated encounter deadlines while stopping temporary work', t => {
  const f = fixture(t), [p] = f.players; p.at(26); p.ok({ intent: 'travel', node_id: 'camp', route: 'bypass' });
  const m = f.world.state.journey.monsters[0]; m.hp = 0; m.status = 'respawning'; m.respawn_at = f.now() + 20000;
  const before = structuredClone({ position: p.a.position, scene: p.a.scene_id, goal: p.a.goal, inventory: p.a.life.inventory, appearance: p.a.appearance });
  initializeJourney(f.world, { restore: true }); assert.equal(p.a.journey_job, null); assert.equal(p.a.movement, null); assert.equal(f.world.state.journey.monsters[0].respawn_at, f.now() + 20000);
  assert.deepEqual({ position: p.a.position, scene: p.a.scene_id, goal: p.a.goal, inventory: p.a.life.inventory, appearance: p.a.appearance }, before);
  const publicState = publicJourney(f.world); assert.ok(!JSON.stringify(publicState).includes('contributions')); assert.ok(!JSON.stringify(publicState).includes('run_id'));
});

test('v033 invalid same-version stored monster sets fail closed instead of granting fresh stock', t => {
  const f = fixture(t), original = structuredClone(f.world.state.journey);
  for (const mutation of [s => s.monsters.pop(), s => s.monsters.push(s.monsters[0]), s => s.monsters[0].monster_id = 'invented', s => s.monsters[0].hp = 999, s => s.secret = 'unexpected']) {
    f.world.state.journey = structuredClone(original); mutation(f.world.state.journey); assert.throws(() => initializeJourney(f.world, { restore: true }), /Invalid journey/);
  }
});

test('v033 generic actions cannot bypass encounter roads; real nearby berries require collection before separate eating', t => {
  const f = fixture(t), [p] = f.players; f.day(); p.at(2);
  assert.equal(p.act({ x: 4, y: 16 }, 'move').error.code, 'JOURNEY_ROUTE_REQUIRED');
  assert.equal(p.act({ intent: 'start', node_id: 'journey_berries' }, 'gather').error.code, 'JOURNEY_ROUTE_REQUIRED');
  p.at(43); p.a.survival.satiety = 30; const before = p.a.life.inventory.berry || 0;
  p.ok({ intent: 'start', node_id: 'journey_berries' }, 'gather'); f.step(15000); assert.equal(p.a.life.gathering, null); assert.equal(p.a.life.inventory.berry, before + 2); assert.ok(p.a.survival.satiety < 30);
  p.ok({ intent: 'use', item_id: 'berry' }, 'inventory'); assert.equal(p.a.life.inventory.berry, before + 1); assert.ok(p.a.survival.satiety > 30);
});
