// Real wall-clock HTTP load, separate application process and private temporary DB.
// Scripted legal controllers are measurement clients, never real AI or production data.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../server/index.js';
import { initializeEconomy } from '../server/economy.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const percentile = (values, fraction = .95) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0;
const lifeScenario = process.argv.includes('--life');
const explorationScenario = process.argv.includes('--exploration');
const CAPABILITIES = ['adventure','farming','inventory','equipment','farm_tools','fatigue','recovery','reliable_events','runtime_health','gathering','cooking','trading','exploration_events','strategic_equipment','personal_goals'];
// Deterministic load policy ONLY: product controllers remain the original AI.
function lifeAction(observation) {
  const a = observation.self, l = a.life, inv = l.inventory, now = observation.server_time;
  const have = id => inv[id] || 0, action = (type, payload) => ({ type, payload });
  if (l.gathering || a.adventure.plan) return null;
  if (a.fatigue.energy < 12) return action('adventure_plan', { intent: 'rest' });
  if (a.fatigue.energy <= 76 && have('wheat_bread')) return action('inventory', { intent: 'use', item_id: 'wheat_bread' });
  const gather = id => now >= (l.gather_ready_at?.[id] || 0) ? action('gather', { intent: 'start', resource_id: id }) : null;
  const trade = (intent, item_id, quantity = 1) => action('trade', { intent, item_id, quantity });
  for (const id of ['hoe', 'watering_can']) {
    if (l.tools[id].durability === 0) return have('wood') ? action('inventory', { intent: 'repair', item_id: id }) : gather('wood');
  }
  for (const [id, price] of [['turnip_seed', 1], ['wheat_seed', 2]]) {
    if (!have(id) && !l.plots.some(p => p.crop_id === id.replace('_seed', ''))) {
      if (a.adventure.gold >= price && l.market.buy_remaining) return trade('buy', id);
      if (have('wood') && l.market.sell_remaining) return trade('sell', 'wood');
      return gather('wood');
    }
  }
  for (const p of l.plots) {
    if (p.ready) return action('farm', { intent: 'harvest', plot_id: p.plot_id });
    if (p.crop_id && p.watered_at === null) return action('farm', { intent: 'water', plot_id: p.plot_id });
    if (!p.crop_id && !p.tilled) return action('farm', { intent: 'till', plot_id: p.plot_id });
    const crop = p.plot_id === 'plot_1' ? 'turnip' : 'wheat';
    if (!p.crop_id && p.tilled && have(`${crop}_seed`)) return action('farm', { intent: 'plant', plot_id: p.plot_id, crop_id: crop });
  }
  for (const [produce, food] of [['wheat', 'wheat_bread'], ['turnip', 'turnip_soup']]) {
    if (have(produce) >= 2 && !have(food)) return action('inventory', { intent: 'craft', item_id: food });
    if (have(produce) >= 2 && have(food) && l.market.sell_remaining >= 2) return trade('sell', produce, 2);
  }
  if (!have('wood') && a.adventure.gold >= 4 && l.market.buy_remaining) return trade('buy', 'wood');
  if (have('wood') < 3) return gather('wood');
  if (have('ore') >= 2 && l.market.sell_remaining) return trade('sell', 'ore');
  return gather('ore');
}
// Only used by this isolated load client. It is intentionally deterministic.
function explorationAction(observation, index, state) {
  const a = observation.self, now = observation.server_time;
  const action = (type, payload) => ({ type, payload });
  const encounter = a.adventure.encounter;
  if (encounter?.status === 'pending') {
    // One actor deliberately tests the finite timeout each discovery cycle.
    if (index === 4) return null;
    const choice = index === 3 ? encounter.choices.find(c => c.choice_id === 'decline')
      : encounter.choices.find(c => c.choice_id !== 'decline' && (c.energy_cost || 0) <= a.fatigue.energy
        && (!c.heal || a.adventure.hp < a.adventure.max_hp) && (!c.restore_energy || a.fatigue.energy < 100))
        || encounter.choices.find(c => c.choice_id === 'decline');
    return action('adventure_event', { event_id: encounter.event_id, choice_id: choice.choice_id });
  }
  if (a.personal_goal?.status === 'needs_review') return action('personal_goal', { intent: 'confirm', goal_id: a.personal_goal.goal_id });
  if (!a.personal_goal || ['completed','expired','cancelled'].includes(a.personal_goal.status)) {
    const kind = index % 2 ? 'defeat_monster' : 'resolve_exploration';
    return action('personal_goal', { intent: 'set', kind, target_id: kind === 'defeat_monster' ? 'forest_slime' : (index === 2 ? 'ruins' : 'forest'), target_count: 2, duration_seconds: 1800, title: '隔离负载目标' });
  }
  if (a.adventure.plan) return null;
  const camp = Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) <= 2;
  if (!state.equipped && camp) {
    const weapon = index % 2 ? 'heavy_hammer' : 'hunter_bow';
    const queue = [action('inventory',{intent:'craft',item_id:weapon}), action('inventory',{intent:'equip',item_id:weapon}),
      action('inventory',{intent:'craft',item_id:'heavy_armor'}), action('inventory',{intent:'equip',item_id:'heavy_armor'})];
    if (state.setup < queue.length) return queue[state.setup++];
    state.equipped = true;
  }
  if (!state.equipped || a.adventure.hp < a.adventure.max_hp * .7 || a.fatigue.energy < 35) return action('adventure_plan',{intent:'rest'});
  if (now >= (a.adventure.discovery_ready_at || 0)) return action('adventure_plan',{intent:'explore',zone_id:index===2?'ruins':'forest'});
  const monster = observation.adventure.monsters.find(m=>m.monster_id === 'forest_slime' && m.status === 'alive')
    || observation.adventure.monsters.find(m=>m.zone_id === 'forest' && m.status === 'alive');
  if (monster) return action('adventure_plan',{intent:'hunt',monster_id:monster.monster_id});
  if (!camp) return action('adventure_plan',{intent:'retreat'});
  return null;
}
if (process.argv.includes('--worker')) {
  const directory = resolve(process.env.PLAZA_SOAK_DIR || '');
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(directory.split(/[\\/]/).at(-1).startsWith('plaza-soak-'));
  const app = await createApp({ dbPath: join(directory, 'world.sqlite'), frontend: false, demo: false });
  const tick = app.world.tick.bind(app.world), times = [], delay = monitorEventLoopDelay({ resolution: 20 });
  let maxTick = 0, peakEvents = 0, peakReceipts = 0, tickCount = 0;
  app.world.tick = (...args) => {
    const before = performance.now(); const result = tick(...args); const ms = performance.now() - before;
    maxTick = Math.max(maxTick, ms); tickCount++;
    if (times.length < 50000) times.push(ms);
    peakEvents = Math.max(peakEvents, app.world.state.events.length);
    peakReceipts = Math.max(peakReceipts, Object.keys(app.world.state.receipts).length);
    return result;
  };
  delay.enable(); const cpu = process.cpuUsage();
  const people = Array.from({ length: 5 }, (_, i) => {
    const a = app.world.createAgent({ name: `隔离负载${i + 1}` });
    const c = app.world.createController(a.agent_id);
    app.world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 120, max_calls: 10000 });
    if (lifeScenario) {
      const raw = app.world.agent(a.agent_id);
      raw.position = { x: 11, y: 8 }; raw.life.inventory = {}; raw.adventure.gold = 0;
      raw.life.tools.hoe.durability = 0; raw.life.tools.watering_can.durability = 0;
      delete raw.life.ledger; initializeEconomy(raw, app.world.now());
    }
    if (explorationScenario) { const raw=app.world.agent(a.agent_id); raw.position={x:11,y:8}; raw.life.inventory.wood=60; raw.life.inventory.ore=60; delete raw.life.ledger; initializeEconomy(raw,app.world.now()); }
    return { token: c.token };
  });
  const { server, url } = await app.start(0);
  const metrics = () => {
    const used = process.cpuUsage(cpu);
    return { at: Date.now(), rss_mb: process.memoryUsage().rss / 1048576, peak_rss_mb: process.resourceUsage().maxRSS / 1024,
      cpu_ms: (used.user + used.system) / 1000, tick_p95_ms: percentile(times), tick_max_ms: maxTick, tick_count: tickCount,
      event_loop_p99_ms: delay.percentile(99) / 1e6, retained_events: app.world.state.events.length,
      retained_receipts: Object.keys(app.world.state.receipts).length, peak_events: peakEvents, peak_receipts: peakReceipts,
      active: app.world.activeIds().length,
      ...(explorationScenario ? {encounters: Object.values(app.world.state.agents).filter(a=>a.adventure.encounter).length, goals:Object.values(app.world.state.agents).filter(a=>a.personal_goal).length, exploration_events:app.world.state.events.filter(e=>e.type.startsWith('exploration_')).length, expired_encounters:app.world.state.events.filter(e=>e.type==='exploration_ended' && e.payload.status==='expired').length} : {}),
      ...((lifeScenario || explorationScenario) ? { ledger_entries: Object.values(app.world.state.agents).map(a => a.life.ledger?.entries?.length || 0),
        life_events: ['life_gather_finished','life_crafted','life_traded'].map(type => ({ type, retained: app.world.state.events.filter(e => e.type === type).length })) } : {}) };
  };
  process.send({ type: 'ready', url, people });
  const timer = setInterval(() => process.send?.({ type: 'metrics', ...metrics() }), 5000);
  process.on('message', async message => {
    if (message !== 'stop') return;
    clearInterval(timer); process.send({ type: 'final', ...metrics() }); delay.disable();
    await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); process.disconnect();
  });
} else {
  const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || 1800);
  assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600);
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-soak-'));
  const worker = fork(fileURLToPath(import.meta.url), ['--worker', ...(lifeScenario ? ['--life'] : []), ...(explorationScenario ? ['--exploration'] : [])], { env: { ...process.env, PLAZA_SOAK_DIR: directory }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const samples = [], latencies = [], viewers = [], clients = [], abort = new AbortController();
  let final, applied = 0, failures = 0, frames = 0, bytes = 0, maxBuffer = 0, viewerErrors = 0, exited = false;
  const actionCounts = {};
  const exit = new Promise(resolveExit => worker.once('exit', code => { exited = true; resolveExit(code); }));
  worker.on('message', message => { if (message.type === 'metrics') samples.push(message); if (message.type === 'final') final = message; });
  const call = async (client, name, args = {}) => {
    const before = performance.now();
    const result = await client.callTool({ name, arguments: args });
    latencies.push(performance.now() - before);
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    if (data.error) throw new Error(`${name}: ${data.error.code}`);
    return data;
  };
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 20000);
      worker.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolveReady(message); } });
      worker.once('error', reject); worker.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited before ready')); });
    });
    for (const person of ready.people) {
      const client = new Client({ name: 'isolated-soak', version: '0.14.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ready.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${person.token}` } } }));
      clients.push({ client, session: await call(client, 'join_world'), policy: { setup:0,equipped:false } });
    }
    await Promise.all(Array.from({ length: 20 }, async () => {
      const response = await fetch(`${ready.url}/api/public/events?delta=1`, { signal: abort.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      viewers.push((async () => {
        let buffer = '';
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) { if (!abort.signal.aborted) viewerErrors++; break; }
            bytes += value.byteLength; buffer += decoder.decode(value, { stream: true });
            maxBuffer = Math.max(maxBuffer, buffer.length); assert.ok(buffer.length < 512000);
            let split;
            while ((split = buffer.indexOf('\n\n')) !== -1) {
              const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
              const line = event.split('\n').find(line => line.startsWith('data: '));
              if (line) { JSON.parse(line.slice(6)); frames++; }
            }
          }
        } catch (error) { if (!abort.signal.aborted) { viewerErrors++; console.error(error.message); } }
      })());
    }));
    const start = performance.now(); let round = 0;
    do {
      await Promise.all(clients.map(async ({ client, session, policy }, i) => {
        try {
          const observation = await call(client, 'observe', { run_id: session.run_id, session_epoch: session.session_epoch });
          const a = observation.self;
          if (lifeScenario || explorationScenario) {
            const decision = lifeScenario ? lifeAction(observation) : explorationAction(observation,i,policy);
            if (decision) {
              const result = await call(client, 'act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: observation.next_action_id, ...decision });
              assert.equal(result.status, 'applied', JSON.stringify(result)); applied++;
              const key = `${decision.type}:${decision.payload.intent || decision.payload.choice_id || 'apply'}`; actionCounts[key] = (actionCounts[key] || 0) + 1;
            }
          } else if (!a.adventure.plan && a.adventure.encounter?.status !== 'pending') {
            const monsters = observation.adventure.monsters.filter(m => m.status === 'alive');
            const payload = a.adventure.hp < a.adventure.max_hp / 2 || a.fatigue.energy < 25 ? { intent: 'rest' } : monsters.length ? { intent: 'hunt', monster_id: monsters[i % monsters.length].monster_id } : { intent: 'explore', zone_id: 'forest' };
            const result = await call(client, 'act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: observation.next_action_id, type: 'adventure_plan', payload });
            assert.equal(result.status, 'applied', JSON.stringify(result)); applied++;
          }
          await call(client, 'report_connection', { run_id: session.run_id, runtime_version: '0.14.0', mode: 'demo', capabilities: explorationScenario ? CAPABILITIES : undefined, health: { world: 'connected', host: 'not_applicable', model: 'idle', waiting_reason: a.life.gathering ? 'activity_running' : a.adventure.plan ? 'plan_running' : 'idle', counters: { requests: 0, replies: 0, retries: 0, local_failures: 0 }, token_usage: null } });
        } catch (error) { failures++; console.error(error.message); }
      }));
      round++;
      if (round % 6 === 0) console.log(JSON.stringify({ type: 'progress', elapsed_seconds: Math.round((performance.now() - start) / 1000), applied, failures, frames, app: samples.at(-1) }));
      await sleep(Math.min(lifeScenario || explorationScenario ? 3000 : 10000, Math.max(0, seconds * 1000 - (performance.now() - start))));
    } while (performance.now() - start < seconds * 1000);
    const elapsed = performance.now() - start;
    abort.abort(); await Promise.all(viewers); await Promise.all(clients.map(({ client }) => client.close()));
    worker.send('stop'); assert.equal(await exit, 0); assert.ok(final);
    const window = Math.max(1, Math.min(60, Math.floor(samples.length / 3)));
    const early = percentile(samples.slice(window, window * 2).map(s => s.rss_mb), .5);
    const late = percentile(samples.slice(-window).map(s => s.rss_mb), .5);
    const result = { type: 'result', scope: 'Isolated real HTTP: 5 scripted controllers, 20 public SSE viewers; no model calls or production records. Separate child application process; client load measured separately.',
      environment: { platform: process.platform, node: process.version, cores: cpus().length, total_memory_mb: Math.round(totalmem() / 1048576) },
      scenario: lifeScenario ? 'pacifist-living-from-zero' : explorationScenario ? 'exploration-strategy-goals' : 'adventure', action_counts: actionCounts,
      requested_seconds: seconds, elapsed_seconds: +(elapsed / 1000).toFixed(2), actors: 5, viewers: 20, applied, failures, viewer_errors: viewerErrors, frames,
      mean_bytes_per_viewer_second: Math.round(bytes / 20 / (elapsed / 1000)), max_client_frame_buffer: maxBuffer,
      mcp_roundtrip_p95_ms: +percentile(latencies).toFixed(2), app: final, samples,
      steady_rss_median_change_mb: +(late - early).toFixed(2), client_peak_rss_mb: process.resourceUsage().maxRSS / 1024,
      criteria: { app_rss_below_512: final.peak_rss_mb < 512, tick_p95_below_50: final.tick_p95_ms < 50, bounded_events: final.peak_events <= 3000, bounded_receipts: final.peak_receipts <= 1000, steady_rss_change_below_64: late - early < 64, all_five_present: final.active === 5,
        ...(explorationScenario ? { bounded_ledgers: final.ledger_entries.every(n => n <= 100),bounded_encounters:final.encounters<=5,bounded_goals:final.goals<=5, ...(seconds>=600? {exploration_choices_exercised:Object.entries(actionCounts).filter(([k])=>k.startsWith('adventure_event:')).reduce((n,[,v])=>n+v,0)>=10,goals_exercised:actionCounts['personal_goal:set']>=5,strategy_equipped:actionCounts['inventory:equip']>=10,finite_expiry_exercised:final.expired_encounters>0}: {}) } : {}),
        ...(lifeScenario ? { bounded_ledgers: final.ledger_entries.every(n => n <= 100), ...(seconds >= 600 ? { life_cycle_exercised: ['gather:start','inventory:repair','farm:harvest','inventory:craft','inventory:use','trade:buy','trade:sell'].every(key => actionCounts[key] >= 5) } : {}) } : {}) } };
    console.log(JSON.stringify(result));
    assert.equal(failures + viewerErrors, 0); assert.ok(frames >= 20); assert.ok(applied >= 5);
    assert.ok(Object.values(result.criteria).every(Boolean));
  } finally {
    abort.abort(); await Promise.allSettled(clients.map(({ client }) => client.close()));
    if (!exited) { worker.kill(); await exit; }
    assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
  }
}
