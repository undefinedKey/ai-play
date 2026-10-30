import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { initializePresence } from '../server/presence.js';

const health = { world: 'connected', host: 'unavailable', model: 'unknown', waiting_reason: 'host_unavailable', error_code: 'PET_UNAVAILABLE', counters: { requests: 2, replies: 1, retries: 0, local_failures: 3 }, last_model_success_at: 999, token_usage: null };
function fixture(t) {
  let now = 100000;
  const world = new World({ now: () => now }); t.after(() => world.close());
  const a = world.createAgent({ name: '原 AI', owner_id: 'owner-a' });
  const c = world.createController(a.agent_id), auth = world.authenticate(c.token);
  return { world, a, c, auth, advance: value => { now += value; }, call: (name, args) => world.callTool(auth, name, args) };
}

test('connection health works before join and during pause without renewing authority or lease', t => {
  const f = fixture(t), a = f.world.agent(f.a.agent_id);
  assert.equal(f.call('report_connection', { health }).ok, true);
  assert.equal(a.run, null); assert.equal(a.last_contact_at, null);
  f.world.ownerControl(a.agent_id, 'start'); const joined = f.call('join_world');
  f.call('report_status', { ...joined, calls_used: 4, health });
  const contact = a.last_contact_at;
  f.advance(44000); f.call('report_connection', { run_id: a.run.run_id, health });
  assert.equal(a.last_contact_at, contact); assert.equal(a.diagnostics.calls_used, 4);
  f.advance(1001); f.world.tick(); assert.equal(a.status, 'offline');
  f.world.ownerControl(a.agent_id, 'pause'); const run = structuredClone(a.run);
  f.call('report_connection', { run_id: run.run_id, health: { ...health, waiting_reason: 'owner_paused' } });
  assert.deepEqual(a.run, run); assert.equal(a.status, 'paused');
  assert.equal(a.diagnostics.health.source, 'bridge'); assert.equal(a.diagnostics.health.stale_after_ms, 30000);
  assert.equal(a.diagnostics.health.received_at, 145001);
});

test('connection health rejects other controllers, old runs, malformed or unbounded private payloads', t => {
  const f = fixture(t), a = f.world.agent(f.a.agent_id);
  f.world.ownerControl(a.agent_id, 'start'); const old = a.run.run_id;
  const next = f.world.createController(a.agent_id);
  f.world.ownerControl(a.agent_id, 'transfer', { controller_id: next.controller_id });
  assert.throws(() => f.call('report_connection', { health }), { code: 'CONTROLLER_BUSY' });
  const auth = f.world.authenticate(next.token), call = args => f.world.callTool(auth, 'report_connection', args);
  assert.throws(() => call({ run_id: old, health }), { code: 'STALE_SESSION' });
  for (const invalid of [{ ...health, extra: 'private secret' }, { ...health, error_code: 'Bearer secret' }, { ...health, last_request_at: -1 }, { ...health, counters: { ...health.counters, requests: Infinity } }, { ...health, source: 'server' }]) {
    assert.throws(() => call({ health: invalid }), { code: 'INVALID_ACTION' });
  }
  call({ health, runtime_version: '0.12.0', capabilities: ['recovery', 'recovery'] });
  assert.deepEqual(a.diagnostics.capabilities, ['recovery']);
  f.world.state.controllers[next.controller_id].revoked = true;
  assert.throws(() => call({ health }), { code: 'NOT_AUTHORIZED' });
});

test('detailed health is private to the owner and never appears in spectator or another role observation', t => {
  const f = fixture(t); f.world.ownerControl(f.a.agent_id, 'start'); const session = f.call('join_world');
  f.call('report_status', { ...session, health, calls_used: 1 });
  const own = f.world.snapshotFor({ id: 'owner-a' });
  assert.equal(own.agents[0].diagnostics.health.error_code, 'PET_UNAVAILABLE');
  for (const projection of [spectatorSnapshot(f.world), f.world.publicAgent(f.world.agent(f.a.agent_id)), f.world.snapshotFor({ id: 'owner-b' })]) {
    const text = JSON.stringify(projection);
    assert.ok(!text.includes('PET_UNAVAILABLE')); assert.ok(!text.includes('last_model_success_at')); assert.ok(!text.includes(f.c.token));
  }
});

test('presence records real join/contact/departure and preserves paused and history across restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-presence-')), path = join(directory, 'world.sqlite');
  let now = 100000, world = new World({ dbPath: path, now: () => now });
  t.after(() => { world.close(); rmSync(directory, { recursive: true, force: true }); });
  const a = world.createAgent({ name: '居民' }), c = world.createController(a.agent_id), auth = world.authenticate(c.token);
  assert.equal(a.presence.state, 'never_joined'); assert.equal(a.presence.has_joined, false);
  world.ownerControl(a.agent_id, 'start'); const joined = world.callTool(auth, 'join_world');
  now += 1000; world.callTool(auth, 'observe', joined); now += 500; world.ownerControl(a.agent_id, 'pause');
  const before = spectatorSnapshot(world).agents[0].presence;
  assert.deepEqual(before, { state: 'paused', has_joined: true, first_joined_at: 100000, last_seen_at: 101000, last_departed_at: 101500 });
  world.close(); now += 60000; world = new World({ dbPath: path, now: () => now });
  assert.deepEqual(spectatorSnapshot(world).agents[0].presence, before);
  assert.equal(world.agent(a.agent_id).run.status, 'paused');
});

test('legacy presence never invents a first visit or declares missing history never joined', () => {
  const unknown = { agent_id: 'old', status: 'offline', run: null, last_contact_at: null };
  initializePresence(unknown, { legacy: true }); assert.equal(unknown.presence_record.has_joined, null);
  const known = { agent_id: 'seen', status: 'offline', run: { has_joined: true }, last_contact_at: null };
  initializePresence(known, { legacy: true }); assert.equal(known.presence_record.has_joined, true); assert.equal(known.presence_record.first_joined_at, null);
  const fresh = {}; initializePresence(fresh); assert.equal(fresh.presence_record.has_joined, false);
});
