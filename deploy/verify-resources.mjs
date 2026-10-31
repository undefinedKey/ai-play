// Read-only release verifier; compare authored definitions and persisted facts,
// not resource-runtime initialization or settlement functions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RESOURCE_NODES } from '../shared/resources-layout.js';

const time = n => Number.isSafeInteger(n) && n >= 0;
const LEGACY_IDS = ['camp_branches', 'camp_stones', 'orchard_berries', 'east_pine', 'south_pine', 'wild_pine', 'ridge_ore', 'deep_berries', 'moon_herb'];
const catalogue = version => version === 1 ? RESOURCE_NODES.filter(n => LEGACY_IDS.includes(n.id)).map(n => n.id === 'camp_branches' ? { ...n, regrow_seconds: 45 } : n) : RESOURCE_NODES;
// This verifier deliberately does not call ecology initialization/settlement.
// These approved release-contract durations are independent of server code.
const phaseDelay = (stage, natural) => ({ stump: 60000, empty: natural ? 300000 : null, sapling: 180000, young: 420000, mature: null })[stage];
function nextMaturity(ecology, def) {
  if (ecology.next_at === null) return null;
  const remaining = { stump: def.natural_regrowth ? 900000 : null, empty: 600000, sapling: 420000, young: 0, mature: null }[ecology.stage];
  return remaining === null ? null : ecology.next_at + remaining;
}
function expectedTree(before, def, initializedAt, currentAt) {
  let stock = before?.stock ?? (def.initial_stage === 'empty' ? 0 : def.max_stock);
  let ecology;
  if (before?.ecology) ecology = { ...before.ecology };
  else {
    const stage = before ? stock > 0 ? 'mature' : 'stump' : def.initial_stage;
    const delay = phaseDelay(stage, def.natural_regrowth);
    ecology = { stage, stage_started_at: initializedAt, next_at: delay === null ? null : initializedAt + delay, generation: 0, origin: def.natural_regrowth ? 'wild' : 'planted' };
  }
  assert.ok(['empty', 'sapling', 'young', 'mature', 'stump'].includes(ecology.stage));
  assert.ok(time(ecology.stage_started_at) && (ecology.next_at === null || time(ecology.next_at)));
  for (let step = 0; step < 4 && ecology.next_at !== null && ecology.next_at <= currentAt; step++) {
    const previous = ecology.stage, stage = { stump: 'empty', empty: 'sapling', sapling: 'young', young: 'mature' }[previous];
    assert.ok(stage, 'only bounded growth transitions may occur while offline');
    const at = ecology.next_at, delay = phaseDelay(stage, def.natural_regrowth);
    ecology = { stage, stage_started_at: at, next_at: delay === null ? null : at + delay,
      generation: ecology.generation + (stage === 'sapling' ? 1 : 0), origin: previous === 'empty' ? 'wild' : ecology.origin };
    stock = stage === 'mature' ? def.max_stock : 0;
  }
  return { stock, regrow_at: nextMaturity(ecology, def), ecology, reservation: null };
}
export function verifyResources(old, current) {
  const restarted = current.events.find(e => e.type === 'server_restarted' && Number(e.cursor) > old.sequence);
  assert.ok(restarted && time(restarted.occurred_at), 'restart evidence required');
  const clock = current.day_cycle, priorClock = old.day_cycle;
  assert.equal(clock?.version, 1);
  assert.ok(time(clock.epoch_at) && time(clock.last_at) && clock.last_at >= clock.epoch_at);
  assert.ok(clock.epoch_at <= restarted.occurred_at);
  if (priorClock) {
    assert.equal(clock.epoch_at, priorClock.epoch_at, 'day epoch preserved');
    assert.ok(clock.last_at >= priorClock.last_at, 'world clock cannot rewind');
  }
  const state = current.resources, previous = old.resources;
  assert.ok([1, 2].includes(state?.version), 'supported resource schema required');
  assert.ok(!previous || [1, 2].includes(previous.version));
  assert.ok(!previous || state.version >= previous.version, 'resource schema cannot downgrade');
  assert.ok(time(state.last_at));
  if (previous) assert.ok(state.last_at >= previous.last_at, 'resource clock cannot rewind');
  const definitions = catalogue(state.version);
  assert.deepEqual(Object.keys(state.nodes).sort(), definitions.map(n => n.id).sort());
  if (previous) assert.deepEqual(Object.keys(previous.nodes).sort(), catalogue(previous.version).map(n => n.id).sort(), 'all old node identities must be known and retained');
  let initializedAt = null;
  if (state.version === 2 && previous?.version !== 2) {
    // An untouched newly authored mature tree supplies the common initialization
    // timestamp. Bound it independently by the saved clock and restart evidence;
    // never accept different migration clocks for different tree nodes.
    const anchor = definitions.find(def => def.kind === 'tree' && def.initial_stage === 'mature' && !previous?.nodes?.[def.id]);
    assert.ok(anchor); initializedAt = state.nodes[anchor.id].ecology?.stage_started_at;
    const lower = previous?.last_at ?? clock.epoch_at, upper = Math.max(restarted.occurred_at, previous?.last_at || 0);
    assert.ok(time(initializedAt) && initializedAt >= lower && initializedAt <= upper, 'new trees must initialize during this restart on the monotonic clock');
  }
  for (const def of definitions) {
    const before = previous?.nodes?.[def.id], after = state.nodes[def.id];
    assert.equal(after.reservation, null, 'restart never resumes an old resource reservation');
    if (state.version === 2 && def.kind === 'tree') {
      assert.deepEqual(after, expectedTree(before, def, initializedAt, state.last_at), `${def.id}: only exact ecological migration/growth may change a tree`);
      continue;
    }
    let expected = before?.stock ?? def.max_stock;
    let regrow = before?.regrow_at ?? null;
    if (regrow !== null && expected < def.max_stock && regrow <= state.last_at) {
      const added = Math.min(def.max_stock - expected, 1 + Math.floor((state.last_at - regrow) / (def.regrow_seconds * 1000)));
      expected += added;
      regrow = expected < def.max_stock ? regrow + added * def.regrow_seconds * 1000 : null;
    }
    assert.equal(after.stock, expected, `${def.id}: only elapsed regeneration may alter stock`);
    assert.equal(after.regrow_at, regrow, `${def.id}: regeneration deadline preserved`);
  }
  return { resource_state_preserved: true, day_cycle_preserved: true, resource_version: state.version, nodes: definitions.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifyResources(old, current))); }
  catch (error) { process.stderr.write(`Resource migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
