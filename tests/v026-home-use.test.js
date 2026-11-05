import {PLAZA_SERVICES} from '../shared/plaza-layout.js';
const CAMP=PLAZA_SERVICES.camp.interaction_position,HOME_ENTRY=PLAZA_SERVICES.home.interaction_position;
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { HOME_RULES, publicHomes } from '../server/homes.js';
import { spectatorSnapshot, scopeSpectatorSnapshot } from '../server/spectator.js';
import { actInputSchema } from '../server/mcp.js';
import { cooperationOpportunities } from '../server/cooperation.js';
import { campAvailable } from '../server/life.js';
import { createHomesFixture } from './helpers/homes-fixture.js';

function fixture(t, count = 3, options = {}) {
  let now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0, ...options }); t.after(() => world.close());
  const players = Array.from({ length: count }, (_, n) => {
    const created = world.createAgent({ name: `家园旅人${n}`, owner_id: `owner${n}` }), id = created.agent_id, c = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: c.controller_id, duration_minutes: 30, max_calls: 100 });
    const auth = world.authenticate(c.token); world.callTool(auth, 'join_world');
    Object.assign(world.agent(id).life.inventory, { wood: 100, ore: 100, grass: 100, pine_cone: 4 }); world.agent(id).position = { ...CAMP };
    return { id, auth, c, get a() { return world.agent(id); }, get home() { return world.state.homes[`home_${id}`]; },
      observe() { const a = world.agent(id); return world.callTool(auth, 'observe', { run_id: a.run.run_id, session_epoch: a.session_epoch }); },
      action(payload, type = 'home') { const o = this.observe(); return world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload }); },
      ok(payload, type = 'home') { const r = this.action(payload, type); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; },
    };
  });
  const tick = (ms, heartbeat = true) => { now += ms; if (heartbeat) for (const p of players) if (p.a.status === 'active') p.a.last_contact_at = now; world.tick(); };
  const build = p => p.ok({ intent: 'build', name: `${p.a.name}的小家` });
  const enter = (p, h = p.home) => { p.ok({ intent: 'visit', home_id: h.home_id }); tick((p.a.movement?.ends_at||now)-now+100); assert.equal(p.a.home_presence?.home_id, h.home_id); };
  const invite = (host, guest, accept = true) => { host.ok({ intent: 'invite', target_agent_id: guest.id }); const i = guest.observe().homes.invitations.at(-1); guest.ok({ intent: 'respond', invitation_id: i.invitation_id, accept }); return i; };
  const craft = (p, kind) => { p.ok({ intent: 'craft', kind }); return p.home.furniture.at(-1).instance_id; };
  return { world, players, tick, build, enter, invite, craft, now: () => now };
}

function furnish(f, p, kind, x = 1, y = 1) {
  const id = f.craft(p, kind); p.ok({ intent: 'place', instance_id: id, x, y }); return id;
}
function prepare(t, count = 1) { const f = fixture(t, count); for (const p of f.players) { f.build(p); f.enter(p); } return f; }

test('v026 use requires supported real furniture, walks physically and exposes only the chosen finite activity', t => {
  const f = prepare(t), [p] = f.players, chair = furnish(f, p, 'chair');
  assert.equal(p.action({ intent: 'use', instance_id: chair, activity: 'eat', item_id: 'turnip' }).error.code, 'HOME_USE_UNAVAILABLE');
  const before = { ...p.a.home_presence.position };
  p.ok({ intent: 'use', instance_id: chair, activity: 'sit' });
  const job = structuredClone(p.a.home_presence.activity), end = p.a.home_presence.movement.ends_at;
  assert.equal(job.phase, 'approaching'); assert.equal(job.ends_at, null); assert.deepEqual(p.a.home_presence.position, before);
  assert.ok(job.expires_at <= f.now() + 120000); assert.equal(p.action({ intent: 'move', x: 5, y: 6 }).error.code, 'HOME_USE_BUSY');
  f.tick(100); assert.notDeepEqual(p.a.home_presence.position, before); assert.equal(p.a.home_presence.activity.phase, 'approaching');
  f.tick(end - f.now()); assert.equal(p.a.home_presence.activity.phase, 'using'); assert.deepEqual(p.a.home_presence.position, job.interaction_position);
  assert.equal(p.a.home_presence.activity.ends_at - p.a.home_presence.activity.started_at, 30000);
  const visible = spectatorSnapshot(f.world).agents.find(a => a.agent_id === p.id).home_presence.activity;
  assert.equal(visible.kind, 'sit'); assert.equal(visible.hp_at_start, undefined); assert.equal(visible.movement_id, undefined);
  f.tick(31000); assert.equal(p.a.home_presence.activity, null); assert.equal(f.world.state.events.filter(e => e.type === 'home_use_finished').length, 1);
  f.tick(90000); assert.equal(p.a.home_presence.activity, null); assert.equal(f.world.state.events.filter(e => e.type === 'home_use_started').length, 1);
});

test('v026 dining consumes exactly one own food at arrival, repeats neither on retries nor tick; early cancel preserves it', t => {
  const f = prepare(t), [p] = f.players, table = furnish(f, p, 'table'); p.a.life.inventory.turnip = 3; p.a.survival.satiety = 30;
  p.ok({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' }); f.tick(200);
  assert.equal(p.a.life.inventory.turnip, 3); p.ok({ intent: 'cancel' }); f.tick(10000); assert.equal(p.a.life.inventory.turnip, 3);
  const o = p.observe(), request = { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'home', payload: { intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' } };
  const receipt = f.world.callTool(p.auth, 'act', request); assert.equal(receipt.status, 'applied'); assert.equal(p.a.life.inventory.turnip, 3);
  const arrival = p.a.home_presence.movement.ends_at; f.tick(arrival - f.now()); assert.equal(p.a.life.inventory.turnip, 2); assert.ok(p.a.survival.satiety > 40);
  assert.deepEqual(f.world.callTool(p.auth, 'act', request), receipt); assert.equal(p.a.life.inventory.turnip, 2);
  f.tick(60000); assert.equal(p.a.life.inventory.turnip, 2); assert.equal(f.world.state.events.filter(e => e.type === 'life_consumed').length, 1);
  assert.equal(p.a.life.ledger.entries.filter(e => e.reason === 'home_eat').length, 1);
  assert.equal(p.action({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'wood' }).error.code, 'INVALID_ACTION');
});

test('v026 dining while already adjacent is audited once and malformed use is rejected atomically', t => {
  const f = prepare(t), [p] = f.players, table = furnish(f, p, 'table', 4, 6); p.a.life.inventory.turnip = 2; p.a.survival.satiety = 20;
  const before = structuredClone(p.a.life.inventory);
  for (const payload of [{ intent: 'use', instance_id: table, activity: 'eat' }, { intent: 'use', instance_id: table, activity: 'rest', item_id: 'turnip' }, { intent: 'use', instance_id: table, activity: 'sleep' }, { intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip', quantity: 4 }]) {
    assert.equal(p.action(payload).status, 'rejected'); assert.deepEqual(p.a.life.inventory, before);
    assert.equal(actInputSchema.safeParse({ run_id: p.a.run.run_id, session_epoch: p.a.session_epoch, action_id: 'test', type: 'home', payload }).success, false);
  }
  p.ok({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' });
  assert.equal(p.a.home_presence.activity.phase, 'using'); assert.equal(p.a.life.inventory.turnip, 1);
  assert.equal(p.a.life.ledger.entries.filter(e => /^home_(eat|use)$/.test(e.reason)).length, 1);
  p.ok({ intent: 'cancel' }); assert.equal(p.a.life.inventory.turnip, 1, 'already eaten food is never refunded');
});

test('v026 reading exposes actual public prose; books and rest neither grant items nor invent AI memory', t => {
  const f = prepare(t), [p] = f.players, shelf = furnish(f, p, 'bookshelf');
  const inventory = structuredClone(p.a.life.inventory), hp = p.a.adventure.hp, xp = p.a.adventure.xp;
  p.ok({ intent: 'use', instance_id: shelf, activity: 'read' }); assert.equal(p.observe().self.home_presence.activity.reading, undefined);
  f.tick(10000); const reading = p.observe().self.home_presence.activity.reading;
  assert.ok(reading.title && reading.text.length > 40); assert.equal(reading.source, '共栖原创短文');
  f.tick(50000); assert.equal(p.a.home_presence.activity, null); assert.deepEqual(p.a.life.inventory, inventory); assert.equal(p.a.adventure.xp, xp); assert.equal(p.a.adventure.hp, hp);
});

test('v026 furniture and approach slots are exclusive; other guests cannot move or use the same target', t => {
  const f = fixture(t, 2), [host, guest] = f.players; f.build(host); f.enter(host); const chair = furnish(f, host, 'chair', 2, 2), extra = f.craft(host, 'chair');
  f.invite(host, guest); f.enter(guest, host.home);
  guest.ok({ intent: 'use', instance_id: chair, activity: 'sit' });
  const slot = guest.a.home_presence.activity.interaction_position;
  assert.equal(host.action({ intent: 'use', instance_id: chair, activity: 'sit' }).error.code, 'HOME_USE_OCCUPIED');
  for (const intent of ['place', 'store']) assert.equal(host.action({ intent, instance_id: chair, ...(intent === 'place' ? { x: 0, y: 0 } : {}) }).error.code, 'HOME_USE_OCCUPIED');
  assert.equal(host.action({ intent: 'place', instance_id: extra, ...slot }).error.code, 'HOME_COLLISION');
  assert.ok(!host.observe().homes.opportunities.some(o => o.payload.instance_id === chair));
  guest.ok({ intent: 'cancel' }); host.ok({ intent: 'use', instance_id: chair, activity: 'read' }); f.tick(10000); assert.equal(host.a.home_presence.activity.phase, 'using');
});

test('v026 stored furniture receives separated legal placement choices before already placed furniture', t => {
  const f = prepare(t), [p] = f.players; furnish(f, p, 'chair', 3, 1); furnish(f, p, 'table', 1, 3); const stored = f.craft(p, 'bed');
  const before = JSON.stringify(f.world.state), choices = p.observe().homes.opportunities.filter(o => o.payload.intent === 'place');
  assert.equal(choices[0].payload.instance_id, stored); assert.equal(new Set(choices.slice(0, 3).map(o => `${o.payload.x},${o.payload.y}`)).size, 3);
  assert.ok(Math.max(...choices.slice(0, 3).map(o => o.payload.x)) - Math.min(...choices.slice(0, 3).map(o => o.payload.x)) >= 3);
  // Observe updates the existing lease, but never creates furniture or changes layout.
  assert.deepEqual(JSON.parse(before).homes, f.world.state.homes);
});

test('v026 delayed multi-house arrival/rest/meal settlement matches small ticks without duplicate inventory changes', t => {
  function scenario(step) {
    const f = prepare(t, 2), [resting, dining] = f.players;
    const bed = furnish(f, resting, 'bed', 1, 1), table = furnish(f, dining, 'table', 6, 2);
    resting.a.fatigue.energy = 2; resting.a.fatigue.updated_at = f.now(); resting.a.fatigue.recover_after = f.now();
    dining.a.survival.satiety = .01; dining.a.life.inventory.turnip = 2;
    resting.ok({ intent: 'use', instance_id: bed, activity: 'rest' }); dining.ok({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' });
    let left = 75000; while (left > 0) { const n = Math.min(step, left); f.tick(n); left -= n; }
    return [resting, dining].map(p => ({ energy: p.a.fatigue.energy, satiety: p.a.survival.satiety, hp: p.a.adventure.hp, food: p.a.life.inventory.turnip, activity: p.a.home_presence.activity, position: p.a.home_presence.position,
      started: f.world.state.events.filter(e => e.type === 'home_use_started' && e.payload.agent_id === p.id).length, finished: f.world.state.events.filter(e => e.type === 'home_use_finished' && e.payload.agent_id === p.id).length }));
  }
  const coarse = scenario(75000), fine = scenario(100);
  for (let i = 0; i < coarse.length; i++) {
    assert.ok(Math.abs(coarse[i].energy - fine[i].energy) < .05, JSON.stringify({ coarse, fine }));
    assert.ok(Math.abs(coarse[i].satiety - fine[i].satiety) < .01); assert.equal(coarse[i].hp, fine[i].hp); assert.equal(coarse[i].food, fine[i].food);
    assert.deepEqual(coarse[i].position, fine[i].position); assert.equal(coarse[i].activity, null); assert.equal(coarse[i].started, 1); assert.equal(coarse[i].finished, 1);
  }
});

for (const reason of ['pause', 'lease', 'grant', 'invite']) test(`v026 ${reason} boundary stops furniture use without extending grant or retaining reservation`, t => {
  const f = fixture(t, 2), [host, p] = f.players; f.build(host); f.enter(host); const bed = furnish(f, host, 'bed', 1, 1); const inv = f.invite(host, p); f.enter(p, host.home);
  p.a.fatigue.energy = 2; p.a.fatigue.updated_at = f.now(); p.a.fatigue.recover_after = f.now();
  p.ok({ intent: 'use', instance_id: bed, activity: 'rest' }); f.tick(10000); assert.equal(p.a.home_presence.activity.phase, 'using');
  const saved = structuredClone(host.home), expiry = p.a.run.expires_at, energy = p.a.fatigue.energy;
  if (reason === 'pause') { f.world.ownerControl(p.id, 'pause'); f.tick(10000); }
  if (reason === 'lease') { p.a.last_contact_at = f.now() - 44000; f.tick(10000, false); }
  if (reason === 'grant') { p.a.run.expires_at = f.now() + 1000; f.tick(10000); }
  if (reason === 'invite') { f.world.state.home_invitations[inv.invitation_id].expires_at = f.now() + 1000; f.tick(10000); }
  assert.equal(p.a.home_presence, null); assert.deepEqual(host.home, saved); assert.ok(p.a.fatigue.energy - energy < 7, 'not full-duration fast rest after loss of permission');
  if (reason !== 'grant') assert.equal(p.a.run.expires_at, expiry);
});

test('v026 lost authorization before meal arrival never consumes food and leaves no old job', t => {
  const f = prepare(t), [p] = f.players, table = furnish(f, p, 'table', 0, 0); p.a.life.inventory.turnip = 2; p.a.survival.satiety = 20;
  p.ok({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' }); p.a.run.expires_at = f.now() + 100;
  f.tick(30000); assert.equal(p.a.home_presence, null); assert.equal(p.a.life.inventory.turnip, 2); assert.equal(f.world.state.events.filter(e => e.type === 'home_use_started').length, 0);
});

test('v026 hunger interrupts a resting actor; no healing, fast recovery or automatic eating happens', t => {
  const f = prepare(t), [p] = f.players, bed = furnish(f, p, 'bed', 4, 5);
  p.a.survival.satiety = 0; p.a.survival.starvation_seconds = 0; p.a.survival.hunger_hits = 0; p.a.survival.protected_until = 0;
  p.a.fatigue.energy = 5; p.a.fatigue.updated_at = f.now(); p.a.life.inventory.turnip = 2; const hp = p.a.adventure.hp;
  p.ok({ intent: 'use', instance_id: bed, activity: 'rest' }); assert.equal(p.a.home_presence.activity.phase, 'using');
  f.tick(31000); assert.equal(p.a.home_presence.activity, null); assert.equal(p.a.fatigue.energy, 5); assert.ok(p.a.adventure.hp < hp); assert.equal(p.a.life.inventory.turnip, 2);
  assert.equal(f.world.state.events.filter(e => e.type === 'home_use_finished').length, 0);
  assert.ok(f.world.state.events.some(e => e.type === 'home_use_cancelled' && e.payload.reason === 'hurt'));
});

test('v026 restart preserves original house and inventory but cannot resume or repeat an old meal', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ai-play-home-use-')), dbPath = join(folder, 'world.db');
  const f = fixture(t, 1, { dbPath }), [p] = f.players; f.build(p); f.enter(p); const table = furnish(f, p, 'table', 1, 1);
  p.a.life.inventory.turnip = 2; p.a.survival.satiety = 20; p.ok({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' });
  const original = structuredClone({ house: p.home, appearance: p.a.appearance, run: p.a.run, items: p.a.life.inventory });
  f.world.save(); const restored = new World({ dbPath, now: () => f.now() + 10000 });
  assert.deepEqual(restored.state.homes[p.home.home_id], original.house); assert.deepEqual(restored.agent(p.id).appearance, original.appearance);
  assert.deepEqual(restored.agent(p.id).run, original.run); assert.deepEqual(restored.agent(p.id).life.inventory, original.items);
  assert.equal(restored.agent(p.id).home_presence, null); assert.equal(restored.state.events.filter(e => e.type === 'home_use_started').length, 0); restored.close();
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix); rmdirSync(folder); });
});

test('v026 tick restores injected clock even when a transition throws', t => {
  const f = prepare(t), [p] = f.players, chair = furnish(f, p, 'chair'); p.ok({ intent: 'use', instance_id: chair, activity: 'sit' });
  const clock = f.world.now, save = f.world.save;
  f.world.save = () => { throw new Error('test storage failure'); };
  assert.throws(() => f.tick(10000), /test storage failure/); assert.equal(f.world.now, clock); f.world.save = save;
});

test('v026 real HTTP/MCP capability, walk/use, schema and public read-only activity', async t => {
  const f = await createHomesFixture({ frontend: false, starterItems: { wood: 30, grass: 20, ore: 5, turnip: 2 } }); t.after(f.close);
  const p = await f.actor('家具测试'); await p.act('move', { x: 23, y: 16 }); await f.until(() => !p.raw.movement);
  await p.act('home', { intent: 'build' }); await p.act('home', { intent: 'visit', home_id: `home_${p.id}` }); await f.until(() => !!p.raw.home_presence);
  await p.act('home', { intent: 'craft', kind: 'chair' }); const chair = (await p.observe()).homes.own_home.storage[0].instance_id;
  await p.act('home', { intent: 'place', instance_id: chair, x: 2, y: 1 }); const original = { ...p.raw.home_presence.position };
  const chosen = await p.applied('home', { intent: 'use', instance_id: chair, activity: 'read' }); assert.equal(chosen.receipt.home_presence.activity.phase, 'approaching');
  assert.deepEqual(p.raw.home_presence.position, original); await f.until(() => p.raw.home_presence.activity?.phase === 'using');
  const publicResult = await f.api('/api/public/world'); assert.equal(publicResult.body.home_rules.use_version, 1);
  const visible = publicResult.body.agents.find(a => a.agent_id === p.id).home_presence.activity;
  assert.equal(visible.kind, 'read'); assert.ok(visible.reading.text); assert.equal(JSON.stringify(publicResult.body).includes(p.goal), false);
  assert.deepEqual(await p.send(chosen.req), chosen.receipt); await f.advance(46000); assert.equal(p.raw.home_presence.activity, null);
});
