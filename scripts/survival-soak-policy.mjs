// Deterministic measurement choices only. Production AI runners never import this
// module. Every material, journey, light source and fuel change comes from MCP.
import assert from 'node:assert/strict';

const action = (type, payload) => ({ type, payload });
const held = (a, id) => a.life.inventory?.[id] || 0;
const nearSite = (a, s) => a.scene_id === s.scene_id && Math.abs(a.position.x - s.position.x) + Math.abs(a.position.y - s.position.y) <= 1 + 1e-8;
const stateFor = policy => policy.survival ||= { build: 0, fuel: 0, relight: 0, gathered_grass: 0, approaching: 0, working: 0, night_lit: 0, night_dark: 0, phases: [] };

function approach(observation, site) {
  const a = observation.self;
  if (a.survival.travel || a.life.gathering) return null;
  if (a.adventure.encounter?.status === 'pending') return action('adventure_event', { event_id: a.adventure.encounter.event_id, choice_id: 'decline' });
  if (a.adventure.plan) return a.adventure.plan.intent === 'retreat' ? null : action('adventure_plan', { intent: 'stop' });
  if (a.movement) return null;
  if (a.scene_id !== site.scene_id) return action('adventure_plan', { intent: 'retreat', mode: 'walk' });
  if (!nearSite(a, site)) return action('survival', { intent: 'approach', site_id: site.id, mode: 'walk' });
  return undefined;
}

// undefined delegates to the unchanged daytime scene policy; null deliberately
// waits for the selected finite job or stays beside the real shared fire.
export function survivalLoadAction(observation, index, policy, shared) {
  const state = stateFor(policy), a = observation.self, phase = observation.day_cycle;
  state.initial_satiety ??= a.survival.satiety; state.current_satiety = a.survival.satiety;
  state.minimum_satiety = Math.min(state.minimum_satiety ?? a.survival.satiety, a.survival.satiety);
  if (!state.phases.includes(phase.phase)) state.phases.push(phase.phase);
  if (phase.phase === 'night') {
    if (a.survival.light.lit && ['campfire', 'firepit'].includes(a.survival.light.kind)) state.night_lit++;
    else state.night_dark++;
  }
  const site = observation.survival.sites.find(s => s.id === 'plaza_hearth'); assert.ok(site);
  const fire = observation.survival.fires.find(f => f.site_id === site.id);
  if (fire) { shared.fire_seen = true; if (!fire.lit && fire.fuel_seconds === 0) shared.saw_burnout = true; }
  if (index === 0 && !fire) {
    if (a.life.gathering) {
      assert.equal(a.life.gathering.node_id, 'meadow_grass');
      if (a.life.gathering.phase === 'working') state.working++; else state.approaching++;
      return null;
    }
    if (state.grass_job && !state.gathered_grass) { assert.equal(held(a, 'grass'), state.grass_before + 2); state.gathered_grass++; }
    if (held(a, 'grass') < 2) {
      const grass = observation.resources.nodes.find(n => n.id === 'meadow_grass');
      if (!grass?.available) return null;
      state.grass_before = held(a, 'grass'); return action('gather', { intent: 'start', node_id: grass.id, mode: 'walk' });
    }
    const travelling = approach(observation, site); if (travelling !== undefined) return travelling;
    assert.ok(held(a, 'wood') >= 3); return action('survival', { intent: 'build', site_id: site.id, kind: 'campfire' });
  }
  // Begin returning two minutes before night. This is an explicit scripted
  // preparation choice, leaving finite walking time from the farthest scene.
  const preparing = phase.phase === 'dusk' || phase.phase === 'night' || phase.phase === 'day' && phase.next_at - observation.server_time <= 60000;
  const firstRelight = index === 1 && fire && !fire.lit && shared.saw_burnout && !shared.first_relight;
  if (!preparing && !firstRelight) return undefined;
  const travelling = approach(observation, site); if (travelling !== undefined) return travelling;
  if (fire && held(a, 'wood') > 0 && (!fire.lit || fire.fuel_seconds <= 60) && shared.fuel_claim === undefined) {
    shared.fuel_claim = index; return action('survival', { intent: 'fuel', fire_id: fire.fire_id, item_id: 'wood', quantity: 1 });
  }
  return null;
}

export function recordSurvivalReceipt(index, policy, shared, decision, before, receipt, after) {
  const state = stateFor(policy), a = before.self, b = after.self;
  assert.equal(receipt.status, 'applied'); assert.equal(a.agent_id, b.agent_id);
  if (decision.type === 'gather' && decision.payload.node_id === 'meadow_grass') {
    assert.equal(held(b, 'grass'), state.grass_before, 'accepted work does not grant future grass');
    state.grass_job = receipt.life.gathering.job_id;
  }
  if (decision.type !== 'survival') return;
  if (decision.payload.intent === 'build') {
    assert.equal(index, 0); assert.equal(held(b, 'wood'), held(a, 'wood') - 3); assert.equal(held(b, 'grass'), held(a, 'grass') - 2);
    const fire = after.survival.fires.find(f => f.site_id === 'plaza_hearth'); assert.ok(fire?.lit); assert.equal(fire.owner_agent_id, a.agent_id);
    state.build++; shared.fire_seen = true;
  }
  if (decision.payload.intent === 'fuel') {
    assert.equal(shared.fuel_claim, index); delete shared.fuel_claim;
    const old = before.survival.fires.find(f => f.fire_id === decision.payload.fire_id), current = after.survival.fires.find(f => f.fire_id === old.fire_id);
    assert.equal(held(b, 'wood'), held(a, 'wood') - 1); assert.ok(current.lit && current.fuel_seconds > old.fuel_seconds);
    state.fuel++; if (!old.lit) { state.relight++; shared.first_relight = true; }
  }
}

export function releaseSurvivalClaim(shared, index) { if (shared.fuel_claim === index) delete shared.fuel_claim; }
export function survivalLoadSummary(policies, shared) {
  return { direct_gameplay_state_writes: 0, saw_natural_burnout: !!shared.saw_burnout, explicit_relight: !!shared.first_relight,
    actors: policies.map(policy => { const { grass_job, grass_before, ...state } = stateFor(policy); return state; }) };
}
