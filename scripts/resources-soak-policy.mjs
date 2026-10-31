// A deterministic measurement client, never imported by the product AI runner.
// A receipt accepts work; only a later personal observation proves its yield.
import assert from 'node:assert/strict';

const action = (type, payload) => ({ type, payload });
const held = (a, id) => a.life.inventory?.[id] || 0;
const inCamp = a => a.scene_id === 'plaza' && Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8) <= 2;
function stateFor(policy) {
  return policy.resources ||= { stage: 'gather', completed: false, node_id: 'orchard_berries', accepted: 0, gathered: 0,
    crafted: 0, consumed: 0, approaching_observations: 0, working_observations: 0, day_phases: [] };
}

export function resourcesLoadAction(observation, policy) {
  const state = stateFor(policy), a = observation.self;
  if (!state.day_phases.includes(observation.day_cycle.phase)) state.day_phases.push(observation.day_cycle.phase);
  if (state.completed) return null;
  const job = a.life.gathering;
  if (job) {
    assert.equal(job.node_id, state.node_id); assert.equal(job.job_id, state.job_id);
    if (job.phase === 'approaching') state.approaching_observations++;
    else { assert.equal(job.phase, 'working'); state.working_observations++; }
    return null;
  }
  if (state.stage === 'gather') {
    if (!state.accepted) {
      const node = observation.resources.nodes.find(n => n.id === state.node_id);
      assert.ok(node && node.scene_id === a.scene_id && node.tool_id === null);
      assert.ok(!a.movement && !a.adventure.plan);
      if (!node.available) return null;
      state.berry_before = held(a, 'berry'); state.expected_yield = node.yield_count;
      return action('gather', { intent: 'start', node_id: node.id, mode: 'walk' });
    }
    assert.equal(held(a, 'berry'), state.berry_before + state.expected_yield, 'finished job must produce its actual personal yield');
    state.gathered++; state.stage = 'return';
  }
  if (state.stage === 'return') {
    if (a.adventure.plan) {
      assert.equal(a.adventure.plan.intent, 'rest');
      // Explicitly stop once physically back inside the camp service area. The
      // load client chooses this; arrival never starts crafting automatically.
      return inCamp(a) ? action('adventure_plan', { intent: 'stop' }) : null;
    }
    if (!inCamp(a)) return action('adventure_plan', { intent: 'rest', mode: 'walk' });
    assert.equal(a.movement, null); state.returned_to_camp = true; state.stage = 'craft';
  }
  if (state.stage === 'craft') {
    assert.ok(held(a, 'berry') >= 2 && held(a, 'wood') >= 1, 'craft only from the actual starter wood and harvested berries');
    return action('inventory', { intent: 'craft', item_id: 'trail_ration' });
  }
  assert.equal(state.stage, 'consume');
  assert.ok(held(a, 'trail_ration') >= 1);
  assert.ok(a.fatigue.energy < 100 || a.adventure.hp < a.adventure.max_hp, 'food must have a real restorative effect');
  return action('inventory', { intent: 'use', item_id: 'trail_ration' });
}

export function recordResourcesReceipt(policy, decision, before, receipt, after) {
  const state = stateFor(policy), a = before.self, b = after.self;
  assert.equal(receipt.status, 'applied'); assert.equal(a.agent_id, b.agent_id);
  if (decision.type === 'gather') {
    assert.equal(state.accepted, 0);
    assert.equal(receipt.life.gathering.node_id, state.node_id);
    assert.equal(held(b, 'berry'), state.berry_before, 'accepting a gather does not award its future yield');
    state.job_id = receipt.life.gathering.job_id; state.accepted++;
    return;
  }
  if (decision.type !== 'inventory') return;
  const inv = receipt.life.inventory;
  if (decision.payload.intent === 'craft') {
    assert.equal(held(b, 'berry'), held(a, 'berry') - 2); assert.equal(inv.berry || 0, held(b, 'berry'));
    assert.equal(held(b, 'wood'), held(a, 'wood') - 1); assert.equal(inv.wood || 0, held(b, 'wood'));
    assert.equal(held(b, 'trail_ration'), held(a, 'trail_ration') + 1);
    assert.equal(inv.trail_ration, held(b, 'trail_ration'));
    assert.ok(b.fatigue.energy < a.fatigue.energy, 'craft consumes real energy before food is used');
    state.crafted++; state.stage = 'consume';
  } else {
    assert.equal(decision.payload.intent, 'use');
    assert.equal(held(b, 'trail_ration'), held(a, 'trail_ration') - 1);
    assert.equal(inv.trail_ration || 0, held(b, 'trail_ration'));
    assert.equal(b.adventure.hp, Math.min(b.adventure.max_hp, a.adventure.hp + 12));
    assert.ok(Math.abs(b.fatigue.energy - Math.min(100, a.fatigue.energy + 18)) < .1);
    state.restored_energy = +(b.fatigue.energy - a.fatigue.energy).toFixed(4);
    state.restored_hp = b.adventure.hp - a.adventure.hp;
    assert.ok(state.restored_energy > 0 || state.restored_hp > 0);
    state.consumed++; state.completed = true; state.stage = 'complete';
  }
}

export function resourcesLoadSummary(policy) {
  const { job_id, berry_before, expected_yield, ...summary } = stateFor(policy);
  return { ...summary, direct_inventory_or_position_writes: 0 };
}
