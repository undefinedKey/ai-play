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
import { cooperationLoadAction } from './cooperation-soak-policy.mjs';
import { seedExperienceCapacity, experienceLoadAction } from './experience-soak-policy.mjs';
import { publicCooperations } from '../server/cooperation.js';
import { isWalkable } from '../shared/world-layout.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import jsonPatch from 'fast-json-patch';

const percentile = (values, fraction = .95) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0;
const viewerCount = Number(process.argv.find(arg => arg.startsWith('--viewers='))?.split('=')[1] || 20);
assert.ok(Number.isInteger(viewerCount) && viewerCount >= 1 && viewerCount <= 150);
const scopedViewers = process.argv.includes('--scoped-viewers');
const patchV2 = process.argv.includes('--patch-v2');
function reconstructPublicFrame(previous, message, snapshot) {
  if (snapshot) return message;
  if (message.protocol === 2) {
    assert.equal(message.base_frame_id, previous.stream_frame_id, 'delta must match this connection baseline');
    assert.equal(typeof message.frame_id, 'string'); assert.ok(Array.isArray(message.patch));
    assert.ok(message.patch.every(operation => !/^\/events(?:\/|$)/.test(operation.path)), 'event ring uses append/reset separately');
    const { events, stream_frame_id, ...body } = previous;
    const patched = jsonPatch.applyPatch(body, message.patch, true, false, true).newDocument;
    return { ...patched, events: message.event_reset ? (message.events || []) : [...events, ...(message.events || [])].slice(-150), stream_frame_id: message.frame_id };
  }
  const { event_reset, ...delta } = message;
  return { ...previous, ...delta, events: event_reset ? (delta.events || []) : [...previous.events, ...(delta.events || [])].slice(-150) };
}
function validatePublicFrame(frame, scene) {
  assert.equal(frame.scope.scene_id, scene); assert.equal(frame.scope.roster, 'world');
  assert.ok(frame.room && Array.isArray(frame.scenes) && frame.scenes.length === 2 && frame.life && frame.history && frame.fatigue);
  assert.ok(Array.isArray(frame.agents) && frame.agents.length === 5); assert.ok(Array.isArray(frame.events) && frame.events.length <= 150);
  assert.equal(new Set(frame.agents.map(a=>a.agent_id)).size,5); assert.ok(Number.isFinite(frame.server_time));
  for (const a of frame.agents) {
    assert.ok(isWalkable(a.scene_id,a.position)); assert.ok(Number.isFinite(a.adventure.hp));
    assert.ok(!Object.hasOwn(a,'owner_id') && !Object.hasOwn(a,'run') && !Object.hasOwn(a,'diagnostics'));
    assert.ok(!Object.hasOwn(a.life,'inventory') && !Object.hasOwn(a.life,'ledger'));
  }
  if (scene==='plaza') assert.equal(frame.adventure.monsters.length,0);
  if (scene) assert.ok(frame.events.every(e=>e.payload.scene_id===scene || (e.type==='scene_changed'&&e.payload.from_scene_id===scene)
    || (scene==='plaza'&&e.type.startsWith('cooperation_')&&e.payload.template_id==='camp_meal')));
}
const lifeScenario = process.argv.includes('--life');
const explorationScenario = process.argv.includes('--exploration');
const experienceScenario = process.argv.includes('--experience');
const cooperationScenario = process.argv.includes('--cooperation');
const sceneScenario = process.argv.includes('--scenes');
const CAPABILITIES = ['adventure','farming','inventory','equipment','farm_tools','fatigue','recovery','reliable_events','runtime_health','gathering','cooking','trading','exploration_events','strategic_equipment','personal_goals','cooperation'];
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
// Deliberately scripted, isolated round trips. This is not a product AI policy.
function sceneAction(observation, index, policy) {
  const a = observation.self;
  if (a.adventure.encounter?.status === 'pending') return { type: 'adventure_event', payload: { event_id: a.adventure.encounter.event_id, choice_id: 'decline' } };
  if (a.adventure.plan) return null;
  if (a.scene_id === 'adventure') return { type: 'adventure_plan', payload: { intent: 'retreat' } };
  if (Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) > 2 || a.fatigue.energy < 75 || a.adventure.hp < a.adventure.max_hp) return { type: 'adventure_plan', payload: { intent: 'rest' } };
  if (!policy.tilled) { policy.tilled = true; return { type: 'farm', payload: { intent: 'till', plot_id: 'plot_1' } }; }
  const target = observation.adventure.monsters.find(m => m.zone_id === 'forest' && m.status === 'alive');
  return { type: 'adventure_plan', payload: index % 2 && target ? { intent: 'hunt', monster_id: target.monster_id } : { intent: 'explore', zone_id: index === 4 ? 'ruins' : 'forest' } };
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
  // The private measurement app explicitly permits its local load generator. This
  // is not a deployment default and never uses a forged forwarded IP header.
  const app = await createApp({ dbPath: join(directory, 'world.sqlite'), frontend: false, demo: false,
    spectatorOptions: { maxStreams: 150, maxPerIp: Math.max(30, viewerCount) } });
  const tick = app.world.tick.bind(app.world), times = [], delay = monitorEventLoopDelay({ resolution: 20 });
  let maxTick = 0, peakEvents = 0, peakReceipts = 0, tickCount = 0, unobservedPhysicalSteps = 0;
  const physicalState = () => JSON.stringify({ agents:Object.values(app.world.state.agents).map(a=>[a.scene_id,a.position,a.adventure.hp]),
    monsters:app.world.state.adventure.monsters.map(m=>[m.position,m.hp,m.status]) });
  const sceneCrossings = { plaza: 0, adventure: 0 }, priorScenes = new Map();
  app.world.tick = (...args) => {
    const unobserved = app.spectator.count === 0 && app.spectator.stats.peak_streams > 0;
    const priorPhysical = unobserved ? physicalState() : null;
    const before = performance.now(); const result = tick(...args); const ms = performance.now() - before;
    if (unobserved && priorPhysical !== physicalState()) unobservedPhysicalSteps++;
    maxTick = Math.max(maxTick, ms); tickCount++;
    if (times.length < 50000) times.push(ms);
    peakEvents = Math.max(peakEvents, app.world.state.events.length);
    peakReceipts = Math.max(peakReceipts, Object.keys(app.world.state.receipts).length);
    if (sceneScenario) for (const a of Object.values(app.world.state.agents)) {
      assert.ok(['plaza', 'adventure'].includes(a.scene_id));
      assert.ok(isWalkable(a.scene_id, a.position), 'actor stays on a traversable cell');
      if (priorScenes.has(a.agent_id) && priorScenes.get(a.agent_id) !== a.scene_id) sceneCrossings[a.scene_id]++;
      priorScenes.set(a.agent_id, a.scene_id);
    }
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
  if (cooperationScenario) for (const [index, raw] of Object.values(app.world.state.agents).entries()) { raw.position = {x:11,y:8}; raw.life.inventory.turnip = index === 0 ? 100 : 0; if ([2,3].includes(index)) { raw.adventure.level=20; raw.adventure.xp=570; raw.adventure.hp=raw.adventure.max_hp=135; } delete raw.life.ledger; initializeEconomy(raw,app.world.now()); }
  if (experienceScenario) {
    for (const [i,a] of Object.values(app.world.state.agents).entries()) { a.position={x:11,y:8}; if(i===3) a.life.inventory.turnip=8; delete a.life.ledger; initializeEconomy(a,app.world.now()); }
    seedExperienceCapacity(app.world);
  }
  const { server, url } = await app.start(0);
  const metrics = () => {
    const used = process.cpuUsage(cpu);
    return { at: Date.now(), rss_mb: process.memoryUsage().rss / 1048576, peak_rss_mb: process.resourceUsage().maxRSS / 1024,
      cpu_ms: (used.user + used.system) / 1000, tick_p95_ms: percentile(times), tick_max_ms: maxTick, tick_count: tickCount,
      event_loop_p99_ms: delay.percentile(99) / 1e6, retained_events: app.world.state.events.length,
      retained_receipts: Object.keys(app.world.state.receipts).length, peak_events: peakEvents, peak_receipts: peakReceipts,
      active: app.world.activeIds().length, living: Object.values(app.world.state.agents).filter(a=>a.adventure.hp>0).length,
      spectator: app.spectator.stats, unobserved_physical_steps:unobservedPhysicalSteps,
      ...(sceneScenario ? { scene_crossings: sceneCrossings, scenes: Object.values(app.world.state.agents).map(a => a.scene_id) } : {}),
      ...(experienceScenario ? { history_entries:app.world.state.history.entries.length, history_cooperations:app.world.state.history.entries.filter(e=>e.category==='cooperation').length, completed_games:app.world.state.history.entries.filter(e=>e.type==='game_finished'&&e.outcome==='completed').length, live_meal_completed:publicCooperations(app.world).some(p=>p.status==='completed'&&p.template_id==='camp_meal') } : {}),
      ...(cooperationScenario ? { cooperations:publicCooperations(app.world).map(p=>({template_id:p.template_id,status:p.status,end_reason:p.end_reason})), pending_returns:Object.values(app.world.state.agents).filter(a=>a.cooperation_return).length } : {}),
      ...(explorationScenario ? {encounters: Object.values(app.world.state.agents).filter(a=>a.adventure.encounter).length, goals:Object.values(app.world.state.agents).filter(a=>a.personal_goal).length, exploration_events:app.world.state.events.filter(e=>e.type.startsWith('exploration_')).length, expired_encounters:app.world.state.events.filter(e=>e.type==='exploration_ended' && e.payload.status==='expired').length} : {}),
      ...((lifeScenario || explorationScenario || cooperationScenario) ? { ledger_entries: Object.values(app.world.state.agents).map(a => a.life.ledger?.entries?.length || 0),
        life_events: ['life_gather_finished','life_crafted','life_traded'].map(type => ({ type, retained: app.world.state.events.filter(e => e.type === type).length })) } : {}) };
  };
  process.send({ type: 'ready', url, people });
  const timer = setInterval(() => process.send?.({ type: 'metrics', ...metrics() }), 5000);
  process.on('message', async message => {
    if (message === 'probe') { process.send({ type: 'probe', ...metrics() }); return; }
    if (message !== 'stop') return;
    clearInterval(timer); process.send({ type: 'final', ...metrics() }); delay.disable();
    await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); process.disconnect();
  });
} else {
  const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || 1800);
  assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600);
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'plaza-soak-'));
  const worker = fork(fileURLToPath(import.meta.url), ['--worker', `--viewers=${viewerCount}`, ...(patchV2 ? ['--patch-v2'] : []), ...(scopedViewers ? ['--scoped-viewers'] : []), ...(sceneScenario ? ['--scenes'] : []), ...(experienceScenario ? ['--experience'] : []), ...(lifeScenario ? ['--life'] : []), ...(explorationScenario ? ['--exploration'] : []), ...(cooperationScenario ? ['--cooperation'] : [])], { env: { ...process.env, PLAZA_SOAK_DIR: directory }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const samples = [], latencies = [], viewers = [], clients = [], abort = new AbortController();
  const updateAges = [], clientCpu = process.cpuUsage();
  let final, applied = 0, failures = 0, frames = 0, validatedFrames = 0, bytes = 0, maxBuffer = 0, viewerErrors = 0, exited = false;
  const actionCounts = {}, cooperationShared = {agentIds:[], modes:new Map(),words:['气球','球场','场地','地球','球迷','迷人','人民','民族','族群','群山']};
  let historyReads=0, historyFailures=0; const historyLatencies=[];
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
      const client = new Client({ name: 'isolated-soak', version: '0.17.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ready.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${person.token}` } } }));
      clients.push({ client, session: await call(client, 'join_world'), policy: { setup:0,equipped:false,cycle:0 } });
    }
    cooperationShared.agentIds = clients.map(p=>p.session.self.agent_id);
    await Promise.all(Array.from({ length: viewerCount }, async (_,index) => {
      const scene = scopedViewers ? [null,'plaza','adventure'][index % 3] : null;
      const response = await fetch(`${ready.url}/api/public/events?delta=${patchV2?2:1}${scene ? `&scene=${scene}` : ''}`, { signal: abort.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      viewers.push((async () => {
        let buffer = '', currentFrame = null;
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
              if (line) {
                const data=JSON.parse(line.slice(6)); frames++;
                const snapshot=event.startsWith('event: snapshot');
                if (!snapshot && patchV2) assert.equal(data.protocol,2);
                currentFrame=reconstructPublicFrame(currentFrame,data,snapshot);validatePublicFrame(currentFrame,scene);validatedFrames++;
                if (!snapshot) updateAges.push(Math.max(0,Date.now()-currentFrame.server_time));
              }
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
          if (experienceScenario) {
            if(policy.pending && Date.now()>=policy.pendingAt) {
              const decision=policy.pending;
              const result=await call(client,'act',{run_id:session.run_id,session_epoch:session.session_epoch,action_id:observation.next_action_id,...decision});
              assert.equal(result.status,'applied',JSON.stringify(result)); applied++; actionCounts[decision.type]=(actionCounts[decision.type]||0)+1; policy.pending=null;
            } else if(!policy.pending) {
              policy.pending=experienceLoadAction(observation,i,policy,cooperationShared);
              policy.pendingAt=Date.now()+45000;
            }
          } else if (sceneScenario || lifeScenario || explorationScenario || cooperationScenario) {
            const decision = sceneScenario ? sceneAction(observation, i, policy) : cooperationScenario ? cooperationLoadAction(observation,i,policy,cooperationShared) : lifeScenario ? lifeAction(observation) : explorationAction(observation,i,policy);
            if (decision) {
              const result = await call(client, 'act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: observation.next_action_id, ...decision });
              assert.equal(result.status, 'applied', JSON.stringify(result)); applied++;
              const key = `${decision.type}:${decision.payload.intent === 'respond' ? 'respond_'+decision.payload.accept : decision.payload.intent || decision.payload.choice_id || 'apply'}`; actionCounts[key] = (actionCounts[key] || 0) + 1;
            }
          } else if (!a.adventure.plan && a.adventure.encounter?.status !== 'pending') {
            const monsters = observation.adventure.monsters.filter(m => m.status === 'alive');
            const payload = a.adventure.hp < a.adventure.max_hp / 2 || a.fatigue.energy < 25 ? { intent: 'rest' } : monsters.length ? { intent: 'hunt', monster_id: monsters[i % monsters.length].monster_id } : { intent: 'explore', zone_id: 'forest' };
            const result = await call(client, 'act', { run_id: session.run_id, session_epoch: session.session_epoch, action_id: observation.next_action_id, type: 'adventure_plan', payload });
            assert.equal(result.status, 'applied', JSON.stringify(result)); applied++;
          }
          await call(client, 'report_connection', { run_id: session.run_id, runtime_version: '0.17.0', mode: 'demo', capabilities: sceneScenario || explorationScenario || cooperationScenario ? CAPABILITIES : undefined, health: { world: 'connected', host: 'not_applicable', model: 'idle', waiting_reason: a.life.gathering ? 'activity_running' : a.adventure.plan ? 'plan_running' : 'idle', counters: { requests: 0, replies: 0, retries: 0, local_failures: 0 }, token_usage: null } });
        } catch (error) { failures++; console.error(error.message); }
      }));
      if(experienceScenario) await Promise.all(Array.from({length:4},async(_,i)=>{
        const before=performance.now();
        try { const suffix=i%2?'&category=cooperation':`&agent_id=${cooperationShared.agentIds[i]}`;
          const response=await fetch(`${ready.url}/api/public/history?limit=50${suffix}`); assert.equal(response.status,200);
          const body=await response.json();assert.ok(body.items.length<=50);assert.equal(body.retention.max_entries,4096);
          if(body.next_cursor) {const next=await fetch(`${ready.url}/api/public/history?limit=50${suffix}&before=${encodeURIComponent(body.next_cursor)}`);assert.equal(next.status,200);const page=await next.json();assert.ok(page.items.every(e=>e.sequence<body.items.at(-1).sequence));}
          historyReads++;historyLatencies.push(performance.now()-before);
        } catch(error) {historyFailures++;console.error(error.message);}
      }));
      round++;
      if (round % 6 === 0) console.log(JSON.stringify({ type: 'progress', elapsed_seconds: Math.round((performance.now() - start) / 1000), applied, failures, frames, app: samples.at(-1) }));
      await sleep(Math.min(sceneScenario || experienceScenario || lifeScenario || explorationScenario || cooperationScenario ? 3000 : 10000, Math.max(0, seconds * 1000 - (performance.now() - start))));
    } while (performance.now() - start < seconds * 1000);
    const elapsed = performance.now() - start;
    abort.abort(); await Promise.all(viewers);
    const probe = () => new Promise((resolveProbe,reject) => {
      const listener=message=>{if(message.type==='probe'){clearTimeout(timer);worker.off('message',listener);resolveProbe(message);}};
      const timer=setTimeout(()=>{worker.off('message',listener);reject(new Error('Metrics probe timeout'));},5000);
      worker.on('message',listener);worker.send('probe');
    });
    await sleep(100); const noViewersBefore=await probe();
    // Keep the five authorized controllers alive, with zero public streams. The
    // actual application timer must continue simulating independently of viewers.
    for(let i=0;i<3;i++) {
      await sleep(2000);
      await Promise.all(clients.map(({client,session})=>call(client,'observe',{run_id:session.run_id,session_epoch:session.session_epoch})));
    }
    const noViewersAfter=await probe();
    const unobserved={seconds:(noViewersAfter.at-noViewersBefore.at)/1000,
      streams_before:noViewersBefore.spectator.active_streams,streams_after:noViewersAfter.spectator.active_streams,
      simulation_ticks:noViewersAfter.tick_count-noViewersBefore.tick_count,
      physical_steps:noViewersAfter.unobserved_physical_steps-noViewersBefore.unobserved_physical_steps,active:noViewersAfter.active};
    await Promise.all(clients.map(({ client }) => client.close()));
    worker.send('stop'); assert.equal(await exit, 0); assert.ok(final);
    const window = Math.max(1, Math.min(60, Math.floor(samples.length / 3)));
    const early = percentile(samples.slice(window, window * 2).map(s => s.rss_mb), .5);
    const late = percentile(samples.slice(-window).map(s => s.rss_mb), .5);
    const clientUsed=process.cpuUsage(clientCpu);
    const result = { type: 'result', scope: `Isolated real HTTP: 5 scripted controllers, ${viewerCount} public SSE viewers; no model calls or production records. Separate child application process; client load measured separately.`,
      environment: { platform: process.platform, node: process.version, cores: cpus().length, total_memory_mb: Math.round(totalmem() / 1048576) },
      scenario: sceneScenario ? 'independent-scene-round-trips' : experienceScenario ? 'slow-decisions-at-history-capacity' : cooperationScenario ? 'voluntary-cooperation' : lifeScenario ? 'pacifist-living-from-zero' : explorationScenario ? 'exploration-strategy-goals' : 'adventure', action_counts: actionCounts,
      history_reads:historyReads,history_failures:historyFailures,history_query_p95_ms:+percentile(historyLatencies).toFixed(2),
      requested_seconds: seconds, elapsed_seconds: +(elapsed / 1000).toFixed(2), actors: 5, viewers: viewerCount, scoped_viewers:scopedViewers, delta_protocol:patchV2?2:1, applied, failures, viewer_errors: viewerErrors, frames, validated_frames:validatedFrames,
      received_bytes:bytes, mean_bytes_per_viewer_second: Math.round(bytes / viewerCount / (elapsed / 1000)), max_client_frame_buffer: maxBuffer,
      update_age_p95_ms:+percentile(updateAges).toFixed(2), update_age_samples:updateAges.length,
      encoding_reuse_ratio:+(final.spectator.delta_frames_written/Math.max(1,final.spectator.delta_encodes)).toFixed(2), unobserved,
      mcp_roundtrip_p95_ms: +percentile(latencies).toFixed(2), app: final, samples,
      steady_rss_median_change_mb: +(late - early).toFixed(2), client_peak_rss_mb: process.resourceUsage().maxRSS / 1024, client_cpu_ms:(clientUsed.user+clientUsed.system)/1000,
      criteria: { app_rss_below_512: final.peak_rss_mb < 512, tick_p95_below_50: final.tick_p95_ms < 50, bounded_events: final.peak_events <= 3000, bounded_receipts: final.peak_receipts <= 1000, steady_rss_change_below_64: late - early < 64, all_five_present: final.active === 5,
        all_five_living:final.living===5, full_viewer_capacity:final.spectator.peak_streams===viewerCount, no_stream_failures:final.spectator.slow_disconnects+final.spectator.write_errors===0,
        shared_delta_encoding:viewerCount<10||final.spectator.delta_frames_written>final.spectator.delta_encodes*5,
        every_frame_reconstructed:validatedFrames===frames,
        world_continues_without_viewers:unobserved.streams_before===0&&unobserved.streams_after===0&&unobserved.simulation_ticks>=5&&unobserved.physical_steps>0&&unobserved.active===5,
        ...(sceneScenario && seconds >= 180 ? { entered_adventure: final.scene_crossings.adventure >= 5, returned_to_plaza: final.scene_crossings.plaza >= 5, farm_only_in_plaza: actionCounts['farm:till'] === 5 } : {}),
        ...(experienceScenario ? { bounded_history:final.history_entries===4096,cooperation_quota_preserved:final.history_cooperations===512,history_queries_passed:historyReads>0&&historyFailures===0,...(seconds>=900?{slow_game_completed:final.completed_games>0,slow_cooperation_completed:final.live_meal_completed}: {})} : {}),
        ...(cooperationScenario ? { bounded_cooperations: final.cooperations.length <= 25, bounded_returns: final.pending_returns <= 5, bounded_ledgers: final.ledger_entries.every(n=>n<=100), ...(seconds>=900 ? {meal_completed:final.cooperations.some(p=>p.template_id==='camp_meal'&&p.status==='completed'),patrol_completed:final.cooperations.some(p=>p.template_id==='scout_and_guard'&&p.status==='completed'),refusal_exercised:actionCounts['cooperation:respond_false']>=1,leave_exercised:actionCounts['cooperation:leave']>=1,expiry_exercised:final.cooperations.some(p=>p.status==='ended'&&p.end_reason==='expired')} : {}) } : {}),
        ...(explorationScenario ? { bounded_ledgers: final.ledger_entries.every(n => n <= 100),bounded_encounters:final.encounters<=5,bounded_goals:final.goals<=5, ...(seconds>=600? {exploration_choices_exercised:Object.entries(actionCounts).filter(([k])=>k.startsWith('adventure_event:')).reduce((n,[,v])=>n+v,0)>=10,goals_exercised:actionCounts['personal_goal:set']>=5,strategy_equipped:actionCounts['inventory:equip']>=10,finite_expiry_exercised:final.expired_encounters>0}: {}) } : {}),
        ...(lifeScenario ? { bounded_ledgers: final.ledger_entries.every(n => n <= 100), ...(seconds >= 600 ? { life_cycle_exercised: ['gather:start','inventory:repair','farm:harvest','inventory:craft','inventory:use','trade:buy','trade:sell'].every(key => actionCounts[key] >= 5) } : {}) } : {}) } };
    console.log(JSON.stringify(result));
    assert.equal(failures + viewerErrors, 0); assert.ok(frames >= viewerCount); assert.ok(applied >= (experienceScenario && seconds < 120 ? 0 : 5));
    assert.ok(Object.values(result.criteria).every(Boolean));
  } finally {
    abort.abort(); await Promise.allSettled(clients.map(({ client }) => client.close()));
    if (!exited) { worker.kill(); await exit; }
    assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
  }
}
