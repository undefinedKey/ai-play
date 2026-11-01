import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { prepareDecisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { cooperationContext, cooperationPrompt } from '../skills/ai-plaza/scripts/cooperation.mjs';

function fixture(t) {
  const now = 1_000_000, world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const a = world.createAgent({ name: '自主行动回归' }), c = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id });
  world.callTool(world.authenticate(c.token), 'join_world');
  const own = world.agent(a.agent_id);
  own.position = { x: 11, y: 8 }; own.adventure.hp = 10; own.survival.satiety = 0;
  Object.assign(own.life.inventory, { turnip: 167, berry: 14, wood: 302, ore: 334 });
  const observation = world.observation(own), rules = world.getRules();
  observation.self.personal_goal = { goal_id: 'goal_finished', status: 'expired', kind: 'collect_item', target_id: 'wood', target_count: 5, progress: 3, expires_at: now - 1 };
  observation.cooperation = { cooperation_id: 'coop_finished', status: 'ended', end_reason: 'expired', members: [], progress: [], expires_at: now - 1 };
  return { observation, rules, ownerGoal: '自主探索、采集、进食和休息，由你决定。', events: [] };
}
const decode = p => JSON.parse(p.split('公开数据：')[1]);

test('已结束约定不永久抢占日常决策；新的结束事件和待退款仍可见', t => {
  const c = fixture(t);
  assert.equal(cooperationContext(c.observation, c.rules, []), undefined);
  const events = [{ type: 'cooperation_ended', payload: { cooperation_id: c.observation.cooperation.cooperation_id, status: 'ended' } }];
  assert.equal(cooperationContext(c.observation, c.rules, events).current.status, 'ended');
  c.observation.cooperation_return = { cooperation_id: 'coop_finished', item_id: 'turnip', quantity: 4 };
  assert.equal(cooperationContext(c.observation, c.rules, []).returns.quantity, 4);
});

test('饥饿且旧目标/约定已过期时仍提供有效JSON、真实食物及自主探索入口', t => {
  const c = fixture(t), p = prepareDecisionPrompt(c), data = decode(p.text);
  assert.ok(p.text.length <= 2000);
  assert.ok(p.text.includes('{"type":"wait","payload":{}}'), '每条压缩路径都有可解析的JSON示例');
  assert.ok(p.text.includes(c.ownerGoal));
  assert.ok(data.food.some(row => row[0] === 'turnip'), '食物使用真实物品ID，不把回血量误认为ID');
  assert.match(p.text, /explore/); assert.match(p.text, /forest/);
  assert.match(p.text, /gather/); assert.match(p.text, /rest/);
  assert.ok((data.options || data.opportunities || []).every(Boolean));
});

test('合作压缩兼容旧生存机会形态，不把无action的行输出为null', t => {
  const c = fixture(t);
  c.events = [{ type: 'cooperation_ended', payload: { cooperation_id: 'coop_finished', status: 'ended' } }];
  c.observation.opportunities.unshift({ type: 'survival', intent: 'approach', site_id: 'plaza_hearth', name: '前往火塘' }, { id: 'nonaction' });
  const coop = cooperationContext(c.observation, c.rules, c.events);
  const p = cooperationPrompt(c, { energy: [100, 1, 12], food: [['turnip', 12, 167, 0, 15]] }, coop, {});
  const data = decode(p);
  assert.ok(data.options.length > 0 && data.options.every(row => row?.type && row.payload));
  assert.deepEqual(data.options[0], { type: 'survival', payload: { intent: 'approach', site_id: 'plaza_hearth' } });
});
