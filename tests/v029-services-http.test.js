import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomesFixture } from './helpers/homes-fixture.js';

const NODE = 'camp_fallen_berries';
const pick = { intent: 'start', node_id: NODE, mode: 'walk' };
const held = (p, id) => p.raw.life.inventory[id] || 0;
async function fixture(t) { const f = await createHomesFixture({ frontend: false, authMode: 'accounts' }); t.after(f.close); return f; }
// Explicit fixture starting condition, not a gameplay rescue. All choices and
// settlement thereafter pass through the actual HTTP/MCP service and clock.
function emptyAtCamp(f, p) {
  p.raw.position = { x: 11, y: 8 }; p.raw.position_at = f.now();
  p.raw.life.inventory = {}; p.raw.adventure.gold = 0; p.raw.fatigue.energy = 0;
  Object.assign(p.raw.survival, { satiety: 0, starvation_seconds: 0, hunger_hits: 0,
    darkness_seconds: 0, dark_hits: 0, protected_until: 0, last_at: f.now() });
}

test('v029 HTTP/MCP food prices apply equally to separate owners; buying and eating are separate explicit actions', async t => {
  const f = await fixture(t), p = await f.actor('谨慎的原 AI'), q = await f.actor('随性的原 AI');
  for (const a of [p, q]) { emptyAtCamp(f, a); a.raw.adventure.gold = 17; }
  const identities = [p, q].map(a => structuredClone({ appearance: a.raw.appearance, goal: a.raw.goal, run: a.raw.run, bio: a.raw.bio }));
  const observations = await Promise.all([p.observe(), q.observe()]);
  assert.deepEqual(observations[0].life.market.items, observations[1].life.market.items);
  for (const [id, price, sell] of [['wheat_bread', 12, null], ['turnip', 5, 2]]) {
    const item = observations[0].life.market.items.find(i => i.item_id === id);
    assert.equal(item.buy_price, price); assert.equal(item.sell_price, sell);
  }
  for (const a of [p, q]) {
    const { req, receipt } = await a.applied('trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 });
    assert.equal(a.raw.adventure.gold, 5); assert.equal(held(a, 'wheat_bread'), 1);
    assert.equal(a.raw.survival.satiety, 0); assert.equal(a.raw.fatigue.energy, 0);
    assert.deepEqual(await a.send(req), receipt, 'retrying one request does not charge or award again');
    await a.act('trade', { intent: 'buy', item_id: 'turnip', quantity: 1 });
    assert.equal(a.raw.adventure.gold, 0); assert.equal(held(a, 'turnip'), 1);
    const rejected = await a.send(await a.request('trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 }));
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error.code, 'INSUFFICIENT_GOLD');
    assert.equal(held(a, 'wheat_bread'), 1); assert.equal(a.raw.adventure.gold, 0);
  }
  const snapshot = (await f.api('/api/public/world')).body;
  for (const a of [p, q]) {
    const status = snapshot.agents.find(row => row.agent_id === a.id).action_status;
    assert.deepEqual(status, { type: 'trade', status: 'rejected', at: f.now(), error_code: 'INSUFFICIENT_GOLD' });
    const publicText = JSON.stringify(snapshot); assert.ok(!publicText.includes(a.token)); assert.ok(!publicText.includes(a.goal));
  }
  await f.advance(1000);
  assert.equal(held(p, 'wheat_bread'), 1); assert.equal(p.raw.survival.satiety, 0);
  await p.act('inventory', { intent: 'use', item_id: 'wheat_bread' });
  assert.equal(held(p, 'wheat_bread'), 0); assert.equal(p.raw.fatigue.energy, 24); assert.equal(p.raw.survival.satiety, 35);
  assert.equal(held(q, 'wheat_bread'), 1); assert.equal(q.raw.survival.satiety, 0, 'one AI eating does not choose for another');
  for (const [index, a] of [p, q].entries()) {
    assert.deepEqual({ appearance: a.raw.appearance, goal: a.raw.goal, run: a.raw.run, bio: a.raw.bio }, identities[index]);
  }
});

for (const night of [false, true]) test(`v029 HTTP/MCP alone ${night ? 'at night' : 'by day'}: zero energy/food/gold permits finite picking, not automatic eating or damage immunity`, async t => {
  const f = await fixture(t), p = await f.actor('原来的独行者'); emptyAtCamp(f, p);
  if (night) { f.app.world.state.day_cycle.epoch_at = f.now() - 360000; f.app.world.state.day_cycle.last_at = f.now(); }
  const before = await p.observe(), node = before.resources.nodes.find(n => n.id === NODE), initialHp = p.raw.adventure.hp;
  assert.equal(node.energy_cost, 0); assert.equal(node.tool_id, null); assert.equal(node.duration_seconds, 6); assert.equal(node.stock, 1);
  assert.equal(p.raw.survival.protected_until, 0);
  const started = await p.applied('gather', pick);
  assert.equal(p.raw.life.gathering.phase, 'approaching'); assert.deepEqual(p.raw.position, { x: 11, y: 8 });
  await f.until(() => p.raw.life.gathering?.phase === 'working', 'walking reaches the authored interaction tile', 3000);
  const job = structuredClone(p.raw.life.gathering);
  assert.equal(job.energy_cost, 0); assert.equal(job.ends_at - job.work_started_at, night ? 7500 : 6000);
  await f.until(() => !p.raw.life.gathering, 'one finite job completes before the first starvation hit', 9000);
  assert.equal(held(p, 'berry'), 1); assert.equal(p.raw.survival.satiety, 0); assert.equal(p.raw.fatigue.energy, 0);
  assert.equal(p.raw.adventure.hp, initialHp); assert.equal(p.raw.survival.protected_until, 0);
  assert.deepEqual(await p.send(started.req), started.receipt); assert.equal(held(p, 'berry'), 1);
  assert.equal(p.raw.life.ledger.entries.filter(e => e.source_id === job.job_id).length, 1);
  await f.advance(10000);
  assert.ok(p.raw.adventure.hp < initialHp, 'starvation continues even with food held; the service does not decide to eat');
  assert.equal(held(p, 'berry'), 1); assert.equal(p.raw.life.gathering, null);
  await p.act('inventory', { intent: 'use', item_id: 'berry' });
  assert.equal(held(p, 'berry'), 0); assert.equal(p.raw.survival.satiety, 12); assert.equal(p.raw.fatigue.energy, 2);
  if (night) {
    assert.equal((await p.observe()).self.survival.light.lit, false, 'the camp is not an implicit free light source');
    await f.advance(90000);
    assert.ok(f.app.world.state.events.some(e => e.type === 'survival_damage' && e.payload.agent_id === p.id && e.payload.kind === 'darkness'));
  }
  const regrow = f.app.world.state.resources.nodes[NODE].regrow_at;
  if (regrow > f.now()) await f.advance(regrow - f.now());
  assert.equal(f.app.world.state.resources.nodes[NODE].stock, 1); assert.equal(held(p, 'berry'), 0);
  assert.equal(p.raw.life.gathering, null, 'world regeneration does not renew a completed task');
  assert.equal(f.app.world.state.events.filter(e => e.type === 'life_gather_started' && e.payload.agent_id === p.id).length, 1);
});

test('v029 HTTP/MCP a real starvation hit cancels picking without yield; real rescue grants only its bounded response window', async t => {
  const f = await fixture(t), p = await f.actor('会犯错的原 AI'); emptyAtCamp(f, p);
  p.raw.adventure.hp = 2; p.raw.survival.starvation_seconds = 9.5;
  await p.act('gather', pick); await f.advance(500);
  assert.equal(p.raw.life.gathering, null); assert.equal(p.raw.movement, null); assert.equal(held(p, 'berry'), 0);
  assert.equal(f.app.world.state.resources.nodes[NODE].stock, 1);
  assert.equal(f.app.world.state.resources.nodes[NODE].reservation, null);
  assert.equal(p.raw.adventure.hp, 10); assert.equal(p.raw.survival.protected_until, f.now() + 120000);
  assert.equal(p.raw.survival.satiety, 0); assert.equal(p.raw.fatigue.energy, 0); assert.equal(p.raw.adventure.gold, 0);
  assert.ok(f.app.world.state.events.some(e => e.type === 'life_gather_cancelled' && e.payload.agent_id === p.id));
  assert.ok(f.app.world.state.events.some(e => e.type === 'survival_rescued' && e.payload.agent_id === p.id));
  await f.advance(1000); assert.equal(p.raw.life.gathering, null); assert.equal(held(p, 'berry'), 0);
  await p.act('gather', pick); await f.until(() => !p.raw.life.gathering, 'the original AI may explicitly retry in its real rescue window', 10000);
  assert.equal(held(p, 'berry'), 1); assert.equal(p.raw.survival.satiety, 0);
  await p.act('inventory', { intent: 'use', item_id: 'berry' }); assert.equal(p.raw.survival.satiety, 12);
});

test('v029 HTTP/MCP shared reservations reject competitors; pausing releases work and does not top up either AI', async t => {
  const f = await fixture(t), p = await f.actor('甲'), q = await f.actor('乙');
  for (const a of [p, q]) emptyAtCamp(f, a);
  await p.act('gather', pick);
  const busy = await q.send(await q.request('gather', pick));
  assert.equal(busy.status, 'rejected'); assert.equal(busy.error.code, 'RESOURCE_BUSY');
  const paused = await p.api(`/api/agents/${p.id}/control`, { operation: 'pause' }); assert.equal(paused.status, 200);
  assert.equal(p.raw.life.gathering, null); assert.equal(f.app.world.state.resources.nodes[NODE].reservation, null);
  await q.act('gather', pick); await f.until(() => !q.raw.life.gathering, 'another AI can explicitly use the released shared node', 10000);
  assert.equal(held(p, 'berry'), 0); assert.equal(held(q, 'berry'), 1);
  assert.equal(p.raw.survival.satiety, 0); assert.equal(q.raw.survival.satiety, 0);
  const depleted = await q.send(await q.request('gather', pick)); assert.equal(depleted.error.code, 'RESOURCE_DEPLETED');
  await f.advance(1000); assert.equal(held(p, 'berry'), 0); assert.equal(p.raw.life.gathering, null);
});
