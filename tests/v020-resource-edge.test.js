import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';

for (const initialEnergy of [0.01, 0.3]) test(`资源奔跑体力${initialEnergy}在延迟tick耗尽后立即终止，营地恢复不能自动重开路程`, t => {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const record = world.createAgent({ name: '原资源行动者' }), controller = world.createController(record.agent_id);
  world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 10 });
  const auth = world.authenticate(controller.token);
  world.callTool(auth, 'join_world', {});
  const a = world.agent(record.agent_id), session = { run_id: a.run.run_id, session_epoch: a.session_epoch };
  a.position = { x: 11, y: 8 }; a.fatigue.energy = initialEnergy; a.fatigue.updated_at = now; a.fatigue.recover_after = now;
  const stock = world.state.resources.nodes.orchard_berries.stock;
  const result = world.callTool(auth, 'act', { ...session, action_id: a.next_action_id, type: 'gather', payload: { intent: 'start', node_id: 'orchard_berries', mode: 'run' } });
  assert.equal(result.status, 'applied'); assert.equal(a.life.gathering.phase, 'approaching'); assert.equal(a.movement.mode, 'run');
  assert.ok(world.state.resources.nodes.orchard_berries.reservation);

  // Exhaustion may happen inside the first leg or exactly at its endpoint.
  // This delayed simulation also contains legitimate passive recovery in camp.
  now += 2000; world.tick();
  assert.ok(a.fatigue.energy > 0, '本测试实际包含耗尽后营地被动回体，不能靠禁止恢复绕过边界');
  assert.equal(a.life.gathering, null); assert.equal(a.movement, null); assert.equal(a.adventure.plan, null);
  assert.equal(world.state.resources.nodes.orchard_berries.reservation, null);
  const distance = Math.abs(a.position.x - 11) + Math.abs(a.position.y - 8);
  assert.ok(distance > 0 && Math.abs(distance - initialEnergy / 0.3) < 1e-7, '只结算原体力预算内的真实路程，不能借恢复再续下一段');
  const stopped = { ...a.position };
  assert.equal(world.state.events.filter(e => e.type === 'life_gather_cancelled' && e.payload.agent_id === a.agent_id && e.payload.reason === 'exhausted').length, 1);
  assert.equal(world.state.events.filter(e => e.type === 'fatigue_exhausted' && e.payload.agent_id === a.agent_id).length, 1);

  for (let i = 0; i < 6; i++) { now += 5000; world.callTool(auth, 'observe', session); }
  assert.equal(a.status, 'active'); assert.ok(a.fatigue.energy > 0);
  assert.deepEqual(a.position, stopped); assert.equal(a.life.gathering, null); assert.equal(a.movement, null);
  assert.equal(world.state.resources.nodes.orchard_berries.reservation, null);
  assert.equal(world.state.resources.nodes.orchard_berries.stock, stock);
  assert.equal(a.life.inventory.berry || 0, 0);
  assert.equal(world.state.events.filter(e => e.type === 'life_gather_started' && e.payload.agent_id === a.agent_id).length, 1);
  assert.equal(world.state.events.filter(e => e.type === 'life_gather_finished' && e.payload.agent_id === a.agent_id).length, 0);
});
