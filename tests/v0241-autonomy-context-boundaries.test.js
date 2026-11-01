import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { prepareDecisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

function fixture(t) {
  const now = 1_000_000, world = new World({ now: () => now, actionIntervalMs: 0 });
  t.after(() => world.close());
  const agent = world.createAgent({ name: '上下文边界旅人' }), controller = world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
  world.callTool(world.authenticate(controller.token), 'join_world');
  const own = world.agent(agent.agent_id);
  own.position = { x: 11, y: 8 }; own.adventure.hp = 10; own.survival.satiety = 0;
  Object.assign(own.life.inventory, { turnip: 167, berry: 14, wood: 302, ore: 334 });
  const observation = world.observation(own);
  observation.self.personal_goal = { goal_id: 'goal_' + 'g'.repeat(36), kind: 'collect_item', status: 'expired', target_id: 'wood', progress: 3, target_count: 5, expires_at: 0 };
  observation.cooperation = { cooperation_id: 'coop_' + 'c'.repeat(36), template_id: 'camp_meal', status: 'ended', end_reason: 'expired', members: [], progress: [], expires_at: 0 };
  return { observation, rules: world.getRules(), ownerGoal: '🐾'.repeat(300), events: [] };
}

for (const kind of ['plain', 'end-event', 'return', 'return-message', 'message', 'invitation', 'active', 'review']) {
  test(`长主人要求与消息下 ${kind} 保留真实义务、食物和有效动作格式`, t => {
    const context = fixture(t), o = context.observation;
    const peer = 'agent_' + 'p'.repeat(36), message = '🌱'.repeat(200);
    if (kind === 'plain') context.ownerGoal = '自主选择探索、采集、休息或进食。';
    if (kind.includes('return')) o.cooperation_return = { cooperation_id: o.cooperation.cooperation_id, item_id: 'turnip', quantity: 4 };
    if (kind === 'end-event') context.events.push({ type: 'cooperation_ended', payload: { cooperation_id: o.cooperation.cooperation_id, status: 'ended' } });
    if (kind.includes('message') || ['invitation', 'active', 'review'].includes(kind)) context.events.push({ type: 'message', payload: { agent_id: peer, text: message } });
    if (kind === 'invitation') o.cooperation_invitations = [{ cooperation_id: 'coop_' + 'i'.repeat(36), revision: 1, template_id: 'camp_meal', from_agent_id: peer, role_id: 'cook', invite_expires_at: o.server_time + 100000, expires_at: o.server_time + 400000 }];
    if (['active', 'review'].includes(kind)) Object.assign(o.cooperation, {
      status: kind === 'review' ? 'needs_review' : 'active', revision: 1, self_role_id: 'supplier', expires_at: o.server_time + 400000,
      members: [{ agent_id: o.self.agent_id, role_id: 'supplier', confirmed: true }, { agent_id: peer, role_id: 'cook', confirmed: true }],
      progress: [{ step_id: 'supply', progress: 4, target_count: 4 }, { step_id: 'cook', progress: 0, target_count: 1 }], escrow: { turnip: 4 },
    });
    const prepared = prepareDecisionPrompt(context), prompt = prepared.text;
    const data = JSON.parse(prompt.split('公开数据：')[1]), resolve = id => prepared.references?.[id] || id;
    assert.ok(prompt.length <= 2000, `${kind}: ${prompt.length} UTF16 code units`);
    assert.ok(prompt.includes(context.ownerGoal), '主人要求不可截断');
    if (context.events.some(event => event.type === 'message')) assert.ok(prompt.includes(message), '新消息不可被历史状态挤走');
    assert.match(prompt, /(?:如|例)\{"type":"wait","payload":\{\}\}/, 'JSON必须明确是格式示例，不把wait强制为唯一动作');
    assert.ok(data.food.some(row => resolve(row[0]) === 'turnip' && row[2] === 167), '保留可食食物的ID和真实持有量');
    assert.ok((data.options || data.opportunities || []).every(row => row && typeof (row.action || row).type === 'string'), '不出现null伪机会');
    if (kind.includes('return')) {
      const returned = data.returns || data.coop?.returns;
      assert.ok(returned, '返还不会因合作已结束而丢失');
      assert.equal(resolve(Array.isArray(returned) ? returned[0] : returned.id), o.cooperation_return.cooperation_id);
      assert.equal(Array.isArray(returned) ? returned[2] : returned.quantity, 4);
      assert.match(prompt, /claim_return/);
    }
    if (kind === 'end-event') assert.ok(JSON.stringify(data).includes('cooperation_ended'), '新结束通知仍可见');
    if (['active', 'review'].includes(kind)) {
      assert.ok(prompt.includes('4萝卜') && prompt.includes('各得1'), '真实合作成本和分配不得截断');
      if (kind === 'review') assert.match(prompt, /confirm/);
    }
    if (['plain', 'message'].includes(kind)) {
      assert.match(prompt, /explore/); assert.match(prompt, /forest/);
      assert.match(prompt, /gather/); assert.match(prompt, /rest/); assert.match(prompt, /inventory\{intent:use,item_id\}/);
      assert.match(prompt, /无需confirm|已结束/, '历史目标不再要求无效复核');
    }
  });
}
