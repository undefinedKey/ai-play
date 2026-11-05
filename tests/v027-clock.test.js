import {PLAZA_SERVICES} from '../shared/plaza-layout.js';
const CAMP=PLAZA_SERVICES.camp.interaction_position,HOME_ENTRY=PLAZA_SERVICES.home.interaction_position;
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';

function setup(t) {
  let time = 2000000000000;
  const world = new World({ now: () => time, actionIntervalMs: 0 }); t.after(() => world.close());
  const id = world.createAgent({ name: '真实时钟旅人', owner_id: 'clock-owner' }).agent_id;
  const controller = world.createController(id);
  world.ownerControl(id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 100 });
  const auth = world.authenticate(controller.token); world.callTool(auth, 'join_world');
  const a = world.agent(id); a.position = { ...CAMP }; Object.assign(a.life.inventory, { wood: 30, grass: 20, turnip: 2 });
  const act = payload => { const o = world.callTool(auth, 'observe', { run_id: a.run.run_id, session_epoch: a.session_epoch }); const r = world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type: 'home', payload }); assert.equal(r.status, 'applied', JSON.stringify(r)); return r; };
  act({ intent: 'build' }); act({ intent: 'visit', home_id: `home_${id}` }); time = a.movement.ends_at + 100; world.tick();
  act({ intent: 'craft', kind: 'table' }); const table = world.state.homes[`home_${id}`].furniture[0].instance_id;
  act({ intent: 'place', instance_id: table, x: 3, y: 0 }); a.survival.satiety = 30;
  act({ intent: 'use', instance_id: table, activity: 'eat', item_id: 'turnip' });
  return { world, a, tick(ms, drifting = false) { time += ms; world.now = drifting ? () => ++time : () => time; a.last_contact_at = time; world.tick(); }, get time() { return time; } };
}

test('v027 wall clock moving between subsystem calls cannot cancel furniture approach', t => {
  const f = setup(t), original = { ...f.a.home_presence.position };
  f.tick(37, true);
  assert.equal(f.a.home_presence.activity?.phase, 'approaching', 'same-tick clock drift must not cancel the chosen meal');
  assert.ok(f.a.home_presence.movement); assert.notDeepEqual(f.a.home_presence.position, original); assert.equal(f.a.life.inventory.turnip, 2);
  f.tick(15000, true); assert.equal(f.a.home_presence.activity?.phase, 'using'); assert.equal(f.a.life.inventory.turnip, 1);
  f.tick(30000, true); assert.equal(f.a.home_presence.activity, null);
  assert.equal(f.world.state.events.filter(e => e.type === 'home_use_finished').length, 1);
  assert.equal(f.world.state.events.filter(e => e.type === 'home_use_cancelled').length, 0);
});

test('v027 tick restores the original changing clock even when ordinary settlement throws', t => {
  const f = setup(t); let time = f.time + 37; const clock = () => ++time, save = f.world.save;
  f.world.now = clock; f.world.save = () => { throw new Error('clock regression storage failure'); };
  assert.throws(() => f.world.tick(), /clock regression storage failure/); assert.equal(f.world.now, clock); f.world.save = save;
});
