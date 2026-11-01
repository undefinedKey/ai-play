import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';

test('night survival candidates carry executable actions rather than null prompt options', t => {
  const now = 2000000000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const agent = world.createAgent({ name: '自主候选旅人' }), controller = world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
  const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world');
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  world.state.day_cycle.epoch_at = now - 360000;
  const before = world.agent(agent.agent_id);
  const observation = world.callTool(auth, 'observe', session);
  const options = observation.opportunities.filter(o => o.id.startsWith('camp_'));
  assert.ok(options.length);
  for (const option of observation.opportunities) {
    assert.equal(typeof option.action?.type, 'string', option.id);
    assert.ok(option.action.payload && typeof option.action.payload === 'object', option.id);
  }
  assert.equal(before.movement, null, 'observing does not select or start a candidate');
  const receipt = world.callTool(auth, 'act', { ...session, action_id: observation.next_action_id, ...options[0].action });
  assert.equal(receipt.status, 'applied', JSON.stringify(receipt.error));
  assert.equal(before.survival.travel.site_id, options[0].action.payload.site_id);
});
