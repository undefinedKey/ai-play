import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { parseModelAction, enqueueEvents } from '../runner/runner.js';
import { sceneContext, inAdventureScene } from '../skills/ai-plaza/scripts/movement.mjs';

const decode = p => JSON.parse(p.split('公开数据：')[1]);
for (const former of [false, true]) for (const route of ['game', 'hunt', 'pending', 'goal_review']) test(`${route}${former ? '旧组' : ''}跨场景组信保留真实回复ID、场景和极限上下文`, t => {
  const world = new World({ actionIntervalMs: 0 }); t.after(() => world.close());
  const record = world.createAgent({ name: '原AI' }), agent = world.agent(record.agent_id);
  const controller = world.createController(record.agent_id); world.ownerControl(record.agent_id, 'start', { controller_id: controller.controller_id, max_calls: 100 });
  const o = world.observation(agent), s = o.self, rules = world.getRules();
  const friend = 'agent_' + 'f'.repeat(36), group = 'group_' + 'g'.repeat(36), sourceGroup = former ? 'group_' + 'o'.repeat(36) : group;
  s.scene_id = route === 'game' ? 'plaza' : 'adventure'; s.adventure.in_field = route !== 'game';
  s.fatigue.energy = 1; s.adventure.hp = 8; s.life.inventory.turnip = 1; s.life.inventory.wheat_bread = 1;
  o.group = { group_id: group, members: [s.agent_id, friend] }; o.nearby_agents = []; o.cooperation = null; o.cooperation_invitations = [];
  if (route === 'game') o.game = { game_id: 'game_' + 'g'.repeat(36), turn_id: 'turn_' + 't'.repeat(36), status: 'active', game_type: 'word_chain', participants: [s.agent_id], current_agent_id: s.agent_id, last_word: '气球', deadline: o.server_time + 150000 };
  else {
    o.adventure.monsters.forEach((m, i) => { m.behavior = 'attacking'; m.target_agent_id = i === 1 ? friend : s.agent_id; });
    s.adventure.decision_until = o.server_time + 30000;
    if (route === 'hunt') s.adventure.plan = { intent: 'hunt', monster_id: 'ruins_guardian', zone_id: 'ruins', phase: 'to_target', destination_scene_id: 'adventure', expires_at: o.server_time + 90000 };
    if (route !== 'hunt') s.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), status: 'needs_review', kind: 'collect_item', target_id: 'wood', progress: 1, target_count: 10, expires_at: o.server_time + 500000 };
    if (route === 'pending') s.adventure.encounter = { event_id: 'encounter_' + 'e'.repeat(36), status: 'pending', expires_at: o.server_time + 150000, choices: [
      { choice_id: 'wood', energy_cost: 4, items: { wood: 2 }, heal: 0, restore_energy: 0 }, { choice_id: 'ore', energy_cost: 4, items: { ore: 1 }, heal: 0, restore_energy: 0 }, { choice_id: 'decline', energy_cost: 0, items: {}, heal: 0, restore_energy: 0 }] };
  }
  const ownerGoal = '🌱'.repeat(300), message = '🍊'.repeat(200);
  const prepared = prepareDecisionPrompt({ observation: o, rules, ownerGoal, correction: true,
    lastActionFeedback: { status: 'applied', code: 'MOVE_ADJUSTED', requested: { x: 999, y: -999 }, applied: { x: 4, y: 11 } },
    events: [{ event_id: 'message', type: 'message', payload: { agent_id: friend, channel: 'group', scene_id: s.scene_id === 'plaza' ? 'adventure' : 'plaza', group_id: sourceGroup, text: message } }] });
  assert.ok(prepared.text.length <= 2000); assert.ok(prepared.text.includes(ownerGoal)); assert.ok(prepared.text.includes(message));
  const data = decode(prepared.text); assert.equal(data.self?.scene_id || data.场景, s.scene_id === 'plaza' ? 'plaza' : data.self?.scene_id ? 'adventure' : '冒险');
  assert.equal(data.events.at(-1).channel, 'group'); assert.equal(prepared.references.H, sourceGroup); assert.equal(prepared.references.P, friend);
  if (former) assert.match(prepared.text, /已离开.*勿转发/); else assert.match(prepared.text, /say\{channel:(?:nearby\|)?group/); assert.match(prepared.text, /MOVE_ADJUSTED/);
  const answer = { type: 'say', payload: { channel: 'group', group_id: 'H', text: '远程回复' } };
  assert.deepEqual(parseModelAction(expandDecisionReferences(JSON.stringify(answer), prepared.references)), { type: 'say', payload: { channel: 'group', group_id: sourceGroup, text: '远程回复' } });
  assert.throws(() => expandDecisionReferences(JSON.stringify({ ...answer, payload: { ...answer.payload, group_id: 'H2' } }), prepared.references), { code: 'INVALID_MODEL_OUTPUT' });
  assert.equal(o.group.group_id, group); assert.equal(o.group.members[1], friend);
});

test('当前位置取scene而非战斗暴露，规则数组和旧对象兼容，入口不伪造', t => {
  const world = new World(); t.after(() => world.close()); const rules = world.getRules();
  assert.equal(inAdventureScene({ scene_id: 'adventure', adventure: { in_field: false } }), true);
  assert.equal(inAdventureScene({ scene_id: 'plaza', adventure: { in_field: true } }), false);
  assert.equal(inAdventureScene({ adventure: { in_field: true } }), true);
  const o = { self: { scene_id: 'plaza' } }, actual = sceneContext(o, rules);
  assert.deepEqual(actual.portal.position, { x: 22, y: 8 }); assert.equal(actual.portal.to_scene_id, 'adventure');
  assert.deepEqual(sceneContext(o, { scenes: Object.fromEntries(rules.scenes.map(s => [s.id, s])) }), actual);
  assert.equal(sceneContext({ self: {} }, rules), undefined);
});

test('陌生人穿门不唤醒，本人与组友换图保留且重复ID不重复决策', () => {
  const events = ['self', 'friend', 'stranger'].map(id => ({ event_id: id, type: 'scene_changed', payload: { agent_id: id, from_scene_id: 'plaza', scene_id: 'adventure' } }));
  const checkpoint = enqueueEvents({}, events, 'self', ['self', 'friend']);
  assert.deepEqual(checkpoint.queue.map(e => e.event_id), ['self', 'friend']);
  assert.deepEqual(enqueueEvents(checkpoint, events, 'self', ['self', 'friend']).queue, checkpoint.queue);
});
