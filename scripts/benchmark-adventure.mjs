// Isolated engine load probe. Never opens the production database or creates live users.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { World } from '../server/world.js';
import { spectatorSnapshot } from '../server/spectator.js';
import { snapshotDelta } from '../server/snapshot-delta.js';

const realTime = process.argv.includes('--realtime');
const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || (realTime ? 30 : 1800));
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 7200);
const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-load-'));
const dbPath = join(directory, 'world.sqlite');
let now = Date.now();
const world = new World({ dbPath, now: () => now, actionIntervalMs: 2000 });
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
const start = performance.now(), cpu = process.cpuUsage();
let previous, snapshotBytes = 0, deltaBytes = 0, decisions = 0;
let peakEvents = 0, maxTickMs = 0, writes = 0;
const save = world.save.bind(world);
world.save = options => { if (!options?.deferred) writes++; return save(options); };
const people = Array.from({ length: 5 }, (_, index) => {
  const a = world.createAgent({ name: `隔离负载角色${index + 1}` });
  const c = world.createController(a.agent_id), auth = world.authenticate(c.token);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 180 });
  const joined = world.callTool(auth, 'join_world');
  return { id: a.agent_id, auth, session: { run_id: joined.run_id, session_epoch: joined.session_epoch } };
});
try {
  for (let second = 0; second < seconds; second++) {
    if (realTime) { await sleep(1000); now = Date.now(); } else now += 1000;
    const tickStart = performance.now(); world.tick(); maxTickMs = Math.max(maxTickMs, performance.now() - tickStart);
    for (const [index, person] of people.entries()) {
      const a = world.agent(person.id);
      if (second % 10 === 0) world.callTool(person.auth, 'observe', person.session);
      if (a.adventure.plan || now - (a.last_action_at || 0) < 2000) continue;
      const observation = world.callTool(person.auth, 'observe', person.session);
      const monsters = observation.adventure.monsters.filter(m => m.status === 'alive');
      // This probe's scripted controller observes the same limits as a real AI.
      const payload = a.adventure.hp < a.adventure.max_hp / 2 || observation.self.fatigue.energy < 25 ? { intent: 'rest' } : monsters.length ? { intent: 'hunt', monster_id: monsters[index % monsters.length].monster_id } : { intent: 'explore', zone_id: index % 2 ? 'forest' : 'ruins' };
      const result = world.callTool(person.auth, 'act', { ...person.session, action_id: observation.next_action_id, type: 'adventure_plan', payload });
      assert.equal(result.status, 'applied', JSON.stringify(result)); decisions++;
    }
    const snapshot = spectatorSnapshot(world);
    const full = JSON.stringify(snapshot), delta = JSON.stringify(previous ? snapshotDelta(previous, snapshot) : snapshot);
    snapshotBytes += Buffer.byteLength(full); deltaBytes += Buffer.byteLength(delta); previous = snapshot;
    peakEvents = Math.max(peakEvents, world.state.events.length);
    if (second % 5 === 0) world.save();
    if (second % 100 === 0) await sleep(0);
  }
  world.save();
  const elapsed = performance.now() - start, used = process.cpuUsage(cpu);
  const result = {
    scope: 'Isolated 5-agent engine simulation with scripted test decisions; no real model or production data. Per-viewer byte estimates exclude HTTP/TCP overhead.',
    mode: realTime ? 'realtime' : 'accelerated', simulated_seconds: seconds, elapsed_ms: Math.round(elapsed), decisions,
    cpu_ms: Math.round((used.user + used.system) / 1000), peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    max_tick_ms: +maxTickMs.toFixed(2), event_loop_p99_ms: realTime ? +(delay.percentile(99) / 1e6).toFixed(2) : null,
    retained_events: world.state.events.length, peak_events: peakEvents, retained_action_receipts: Object.keys(world.state.receipts).length,
    database_mb: +([dbPath, `${dbPath}-wal`].filter(existsSync).reduce((n, path) => n + statSync(path).size, 0) / 1048576).toFixed(2), writes,
    full_bytes_per_viewer_second: Math.round(snapshotBytes / seconds), delta_bytes_per_viewer_second: Math.round(deltaBytes / seconds),
    delta_reduction_percent: Math.round((1 - deltaBytes / snapshotBytes) * 100),
    earned_gold: people.reduce((n, p) => n + world.agent(p.id).adventure.gold, 0),
  };
  assert.ok(result.retained_events <= 3000); assert.ok(result.earned_gold > 0);
  console.log(JSON.stringify(result, null, 2));
} finally {
  delay.disable(); world.close();
  assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
}
