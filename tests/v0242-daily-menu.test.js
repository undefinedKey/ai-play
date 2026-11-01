import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { prepareDecisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';

function crowdedResident(t, energy = 98) {
  const now = 1_000_000, world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const a = world.createAgent({ name: '肥鱼' }), c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id });
  world.callTool(world.authenticate(c.token), 'join_world');
  const own = world.agent(a.agent_id);
  own.position = { x: 11, y: 8 }; own.adventure.level = 20; own.adventure.max_hp = own.adventure.hp = 135;
  own.adventure.gold = 5988; own.survival.satiety = 67.38; own.fatigue.energy = energy;
  Object.assign(own.life.inventory, { turnip: 160, berry: 14, wood: 300, ore: 334, wheat: 2, grass: 10, torch: 1 });
  const observation = world.observation(own), rules = world.getRules();
  observation.self.personal_goal = { goal_id: 'goal_' + 'a'.repeat(36), kind: 'collect_item', target_id: 'wood', target_count: 5, progress: 3, status: 'expired', expires_at: now - 500000 };
  observation.self.adventure.encounter = { event_id: 'encounter_' + 'b'.repeat(36), status: 'resolved', selected_choice_id: 'wood', public_result: { items: { wood: 2 }, hp: 0, energy: -4 }, expires_at: now - 400000 };
  observation.self.leisure.recent = [{ kind: 'activity', id: 'sequence' }, { kind: 'activity', id: 'relax' }];
  observation.cooperation = { cooperation_id: 'coop_' + 'c'.repeat(36), status: 'ended', end_reason: 'expired', members: [], progress: [], expires_at: now - 500000 };
  const ownerGoal = '你可以自主探索采集进食休息，在广场自由生活，不用等待我指挥。'.repeat(12).slice(0, 300);
  const events = [{ type: 'survival_rescued', payload: { agent_id: own.agent_id, text: '肥鱼倒地后被救回营地，恢复10点生命并获得120秒反应保护，仍需自己选择补给和光源' } }];
  return { observation, rules, ownerGoal, events };
}
for (const energy of [98, 100]) for (const correction of [false, true]) test(`高等级居民长目标与旧救援历史仍提供完整日常动作 ${energy}/${correction}`, t => {
  const context = { ...crowdedResident(t, energy), correction };
  const expected = context.observation.opportunities.map(o => o.action).filter(a => a &&
    a.type === 'gather' && a.payload.intent === 'start' || a?.type === 'inventory' && a.payload.intent === 'use' ||
    a?.type === 'adventure_plan' && ['explore', 'rest'].includes(a.payload.intent));
  const prepared = prepareDecisionPrompt(context), prompt = prepared.text, data = JSON.parse(prompt.split('公开数据：')[1]);
  const actual = (data.opportunities || data.options || []).map(o => o.action || o);
  assert.ok(prompt.length <= 2000); assert.ok(prompt.includes(context.ownerGoal));
  for (const action of expected) {
    assert.ok(actual.some(a => JSON.stringify(a) === JSON.stringify(action)), `missing executable choice ${JSON.stringify(action)}`);
    assert.deepEqual(parseModelAction(JSON.stringify(action)), action, '候选具备完整合法payload，不要求AI猜测参数');
  }
  assert.ok(actual.some(a => a.type === 'gather'));
  assert.ok(data.food.some(row => row[0] === 'turnip' && row[4] === 15), '饱食未满时解释可食物的真实恢复效果');
  assert.ok(!prompt.includes('hunter_bow远慢省体'), '可选装备介绍不能挤掉日常行动');
});
