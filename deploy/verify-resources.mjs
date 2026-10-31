// Read-only release verifier; compare authored definitions and persisted facts,
// not resource-runtime initialization or settlement functions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RESOURCE_NODES } from '../shared/resources-layout.js';

const time = n => Number.isSafeInteger(n) && n >= 0;
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
  assert.equal(state?.version, 1);
  assert.ok(time(state.last_at));
  if (previous) assert.ok(state.last_at >= previous.last_at, 'resource clock cannot rewind');
  assert.deepEqual(Object.keys(state.nodes).sort(), RESOURCE_NODES.map(n => n.id).sort());
  for (const def of RESOURCE_NODES) {
    const before = previous?.nodes?.[def.id], after = state.nodes[def.id];
    assert.equal(after.reservation, null, 'restart never resumes an old resource reservation');
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
  return { resource_state_preserved: true, day_cycle_preserved: true, nodes: RESOURCE_NODES.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let input = ''; for await (const part of process.stdin) input += part;
  try { const { old, new: current } = JSON.parse(input); console.log(JSON.stringify(verifyResources(old, current))); }
  catch (error) { process.stderr.write(`Resource migration rejected (${error.code || error.name || 'invalid'}).\n`); process.exitCode = 1; }
}
