import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';

function fixture(t, { satiety = 100, night = false, scene_id = 'plaza', inventory = {} } = {}) {
  const now = 2000000000000, world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const agent = world.createAgent({ name: '休息候选测试旅人' }), controller = world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 60, max_calls: 1000 });
  const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world', {});
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch }, raw = () => world.agent(agent.agent_id);
  // Explicit starting body and supplies; actions below go through the real API.
  Object.assign(raw(), { scene_id, position: { x: 11, y: 8 }, position_at: now });
  raw().adventure.hp = 10; raw().survival.satiety = satiety;
  Object.assign(raw().life.inventory, inventory);
  if (night) Object.assign(world.state.day_cycle, { epoch_at: now - 360000, last_at: now });
  const observe = () => world.callTool(auth, 'observe', session);
  const act = (type, payload) => world.callTool(auth, 'act', { ...session, action_id: observe().next_action_id, type, payload });
  return { world, raw, observe, act, now };
}
const restOptions = f => f.observe().opportunities.filter(o => o.action?.type === 'adventure_plan' && o.action.payload.intent === 'rest');
const apply = (f, option) => {
  assert.ok(option, 'a concrete legal choice is visible');
  const result = f.act(option.action.type, option.action.payload);
  assert.equal(result.status, 'applied', JSON.stringify(result.error));
};

test('starving camp exposes food without unusable rest; explicit eating makes rest available', t => {
  const f = fixture(t, { satiety: 0, inventory: { turnip: 183 } });
  assert.equal(restOptions(f).length, 0);
  const eat = f.observe().opportunities.find(o => o.id === 'eat');
  assert.equal(f.raw().life.inventory.turnip, 183);
  assert.equal(f.raw().adventure.plan, null, 'observation never chooses an action');
  apply(f, eat);
  assert.equal(f.raw().survival.satiety, 15);
  assert.equal(f.raw().life.inventory.turnip, 182);
  apply(f, restOptions(f)[0]);
  assert.equal(f.raw().adventure.plan.intent, 'rest');
});

test('fed but dark camp exposes no rest until the AI explicitly lights a real torch', t => {
  const f = fixture(t, { night: true, inventory: { torch: 1 } });
  assert.equal(restOptions(f).length, 0);
  assert.equal(f.raw().adventure.plan, null);
  assert.equal(f.raw().survival.torch, null);
  assert.equal(f.act('survival', { intent: 'torch', lit: true }).status, 'applied');
  apply(f, restOptions(f)[0]);
  assert.equal(f.raw().adventure.plan.intent, 'rest');
});

for (const condition of [{ satiety: 0, night: false }, { satiety: 100, night: true }]) {
  test(`return from adventure stays legal with satiety ${condition.satiety} and night ${condition.night}`, t => {
    const f = fixture(t, { ...condition, scene_id: 'adventure' });
    assert.equal(restOptions(f).length, 0);
    const home = f.observe().opportunities.find(o => o.id === 'return_camp');
    assert.equal(home.action.payload.intent, 'retreat');
    apply(f, home);
    assert.equal(f.raw().adventure.plan.intent, 'retreat');
    assert.equal(f.raw().adventure.plan.destination_scene_id, 'plaza');
  });
}

test('night return checks camp light rather than a fire at the current wilderness location', t => {
  const f = fixture(t, { night: true, scene_id: 'adventure' });
  f.raw().position = { x: 16, y: 15 };
  f.world.state.survival.fires.local_fire = { fire_id: 'local_fire', site_id: 'trail_hearth', kind: 'campfire',
    owner_agent_id: f.raw().agent_id, fuel_seconds: 90, lit: true, updated_at: f.now, created_at: f.now };
  assert.equal(f.observe().self.survival.light.lit, true);
  assert.equal(restOptions(f).length, 0);
  const home = f.observe().opportunities.find(o => o.id === 'return_camp');
  assert.equal(home.action.payload.intent, 'retreat');
  apply(f, home);
});

for (const condition of [{ satiety: 0, night: false }, { satiety: 100, night: true }]) {
  test(`tired active hunt retains retreat but no unusable rest with satiety ${condition.satiety} and night ${condition.night}`, t => {
    const f = fixture(t, { ...condition, scene_id: 'adventure' });
    assert.equal(f.act('adventure_plan', { intent: 'hunt', monster_id: 'forest_slime' }).status, 'applied');
    f.raw().fatigue.energy = 20;
    assert.equal(restOptions(f).length, 0);
    assert.equal(f.raw().adventure.plan.intent, 'hunt', 'observation leaves the AI choice intact');
    apply(f, f.observe().opportunities.find(o => o.id === 'retreat'));
  });
}

test('fed daylight return retains the existing legal rest choice', t => {
  const f = fixture(t, { scene_id: 'adventure' });
  const home = f.observe().opportunities.find(o => o.id === 'return_camp');
  assert.equal(home.action.payload.intent, 'rest');
  apply(f, home);
});
