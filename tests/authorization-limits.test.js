import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { AccountStore } from '../server/auth.js';
import { approvalOptions } from '../server/skill-pairing.js';

test('保留肥鱼长期授权上限，各入口一致且默认预算不增加', async t => {
  const world = new World(), accounts = new AccountStore();
  t.after(() => { world.close(); accounts.close(); });
  const admin = await accounts.createAdmin({ username: 'limits_admin', passwordless: true });
  const long = { duration_minutes: 525600, max_calls: 1000000000 };
  const invitation = accounts.createAgentInvite(admin.id, long);
  assert.ok(invitation.invite_code);
  const a = world.createAgent({ name: '长期授权' }), controller = world.createController(a.agent_id);
  const approved = approvalOptions({ agent_id: a.agent_id, ...long });
  world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, ...approved });
  assert.equal(world.agent(a.agent_id).run.max_calls, long.max_calls);
  for (const invalid of [{ duration_minutes: 525601 }, { max_calls: 1000000001 }, { max_calls: -1 }, { duration_minutes: Infinity }]) {
    assert.throws(() => accounts.createAgentInvite(admin.id, { ...long, ...invalid }));
    assert.throws(() => approvalOptions({ agent_id: a.agent_id, ...long, ...invalid }));
  }
  world.ownerControl(a.agent_id, 'pause');
  world.ownerControl(a.agent_id, 'resume');
  assert.equal(world.agent(a.agent_id).run.max_calls, 100);
  assert.ok(world.agent(a.agent_id).run.expires_at - Date.now() <= 15 * 60000);
});
