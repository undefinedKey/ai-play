import test from 'node:test';
import assert from 'node:assert/strict';
import { publicActionStatus } from '../server/public-action-status.js';
import { createHomesFixture } from './helpers/homes-fixture.js';

test('public receipt projection rejects malformed state and never publishes private actions or arbitrary error text', () => {
  const d = { last_action_type: 'gather', last_action_status: 'rejected', last_action_at: 100,
    last_action_error: 'RESOURCE_DEPLETED', last_error: 'PRIVATE_RAW_ERROR', payload: { secret: 'PRIVATE_PAYLOAD' } };
  const project = patch => publicActionStatus({ diagnostics: { ...d, ...patch } }, 200);
  assert.deepEqual(project({}), { type: 'gather', status: 'rejected', at: 100, error_code: 'RESOURCE_DEPLETED' });
  for (const type of ['say', 'invite', 'respond_invite', 'submit_move', 'constructor', 'PRIVATE_TYPE']) assert.equal(project({ last_action_type: type }), null);
  for (const at of [undefined, null, '100', -1, 0.5, NaN, Infinity, 201]) assert.equal(project({ last_action_at: at }), null);
  assert.equal(project({ last_action_status: 'thinking' }), null);
  assert.deepEqual(project({ last_action_error: 'PRIVATE_TOKEN' }), { type: 'gather', status: 'rejected', at: 100 });
  assert.deepEqual(project({ last_action_status: 'applied' }), { type: 'gather', status: 'applied', at: 100 });
  assert.equal(publicActionStatus({}, 200), null);
});

test('real public HTTP receipts reflect server validation; retries and runtime reports cannot invent newer actions', async t => {
  const f = await createHomesFixture({ frontend: false }); t.after(f.close);
  const p = await f.actor('公开测试者');
  const row = async () => (await f.api('/api/public/world')).body.agents.find(a => a.agent_id === p.id);
  assert.equal((await row()).action_status, null);
  p.raw.position = { ...(await p.call('get_rules')).life.market.place.service_center }; p.raw.adventure.gold = 0; p.raw.life.inventory = {};
  const req = await p.request('trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 });
  const receipt = await p.send(req); assert.equal(receipt.error.code, 'INSUFFICIENT_GOLD');
  const rejected = { type: 'trade', status: 'rejected', at: f.now(), error_code: 'INSUFFICIENT_GOLD' };
  assert.deepEqual((await row()).action_status, rejected);
  await f.advance(1000);
  assert.deepEqual(await p.send(req), receipt);
  assert.deepEqual((await row()).action_status, rejected, 'idempotent replay is not a new attempted action');
  await p.call('report_status', { ...p.session, state: 'thinking', last_error: 'PRIVATE_MODEL_ERROR',
    last_decision_type: 'inventory', last_action_type: 'inventory', last_action_status: 'applied', last_action_at: f.now() });
  assert.deepEqual((await row()).action_status, rejected, 'runtime metadata cannot override server-written receipts');
  p.raw.adventure.gold = 12;
  await p.act('trade', { intent: 'buy', item_id: 'wheat_bread', quantity: 1 });
  assert.deepEqual((await row()).action_status, { type: 'trade', status: 'applied', at: f.now() });
  assert.equal(p.raw.life.inventory.wheat_bread, 1);
  const publicText = JSON.stringify((await f.api('/api/public/world')).body);
  for (const secret of [p.token, p.goal, 'PRIVATE_MODEL_ERROR', 'last_action_type', 'diagnostics']) assert.ok(!publicText.includes(secret));
  assert.equal((await row()).life.inventory, undefined);
});

test('accepted gathering is shown alongside a running task, not as completion; subsequent private communication is hidden', async t => {
  const f = await createHomesFixture({ frontend: false }); t.after(f.close);
  const p = await f.actor('原来的采集者');
  p.raw.position = { ...(await p.call('get_rules')).life.camp_place.service_center }; p.raw.life.inventory = {};
  await p.act('gather', { intent: 'start', node_id: 'camp_fallen_berries', mode: 'walk' });
  const snapshot = (await f.api('/api/public/world')).body, a = snapshot.agents.find(a => a.agent_id === p.id);
  assert.equal(a.action_status.status, 'applied'); assert.equal(a.life.gathering.phase, 'approaching');
  assert.equal(p.raw.life.inventory.berry, undefined);
  const privateAttempt = await p.send(await p.request('say', { channel: 'self', text: 'PRIVATE_SELF_MESSAGE' }));
  assert.equal(privateAttempt.status, 'rejected');
  const after = (await f.api('/api/public/world')).body;
  assert.equal(after.agents.find(a => a.agent_id === p.id).action_status, null);
  assert.ok(!JSON.stringify(after).includes('PRIVATE_SELF_MESSAGE'));
});
