import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { World } from '../server/world.js';
import { createApp } from '../server/index.js';
import { spectatorSnapshot } from '../server/spectator.js';

function role(world, name = '生活测试', owner_id = 'alice') {
  const agent = world.createAgent({ name, owner_id });
  const controller = world.createController(agent.agent_id);
  world.ownerControl(agent.agent_id, 'start', { controller_id: controller.controller_id });
  const auth = world.authenticate(controller.token);
  const joined = world.callTool(auth, 'join_world');
  return { auth, controller, a: world.agent(agent.agent_id), session: { run_id: joined.run_id, session_epoch: joined.session_epoch } };
}
function fixture(t) {
  let now = 1000000;
  const w = new World({ actionIntervalMs: 0, now: () => now }); t.after(() => w.close());
  const r = role(w); r.a.position = { x: 11, y: 8 };
  return { w, r, advance: ms => { now += ms; } };
}
const observe = (w, r) => w.callTool(r.auth, 'observe', r.session);

test('空闲观察同时提供生活与冒险选择，不自动代替角色开始计划', t => {
  const { w, r } = fixture(t), o = observe(w, r);
  assert.ok(o.opportunities.some(x => x.action.type === 'farm'));
  assert.ok(o.opportunities.some(x => x.action.type === 'inventory'));
  assert.ok(o.opportunities.some(x => x.action.payload.intent === 'explore'));
  assert.ok(o.opportunities.some(x => x.action.payload.intent === 'hunt'));
  assert.ok(o.opportunities.length <= 6);
  assert.equal(r.a.adventure.plan, null);
  assert.equal(r.a.life.plots.every(p => p.crop_id === null), true);
});

test('同组游戏不遮住未参与者的冒险与农田；参与者的忙碌边界仍生效', t => {
  const { w, r } = fixture(t), peer = role(w, '同伴');
  const gid = 'test_group'; r.a.group_id = gid; peer.a.group_id = gid;
  w.state.groups[gid] = { group_id: gid, members: [r.a.agent_id, peer.a.agent_id] };
  w.state.game = { game_id: 'test_game', group_id: gid, status: 'active', participants: [peer.a.agent_id], game_type: 'word_chain' };
  assert.ok(observe(w, r).opportunities.some(x => x.action.type === 'adventure_plan'));
  w.state.game.participants.push(r.a.agent_id);
  assert.equal(observe(w, r).opportunities.some(x => ['farm', 'adventure_plan'].includes(x.action.type)), false);
});

test('当前推荐动作在营地、野外、成熟农田与寻宝场景都能通过服务校验', t => {
  const { w, r, advance } = fixture(t);
  const check = () => {
    const o = observe(w, r), original = structuredClone(w.state);
    for (const candidate of o.opportunities) {
      w.state = structuredClone(original);
      const result = w.callTool(r.auth, 'act', { ...r.session, action_id: o.next_action_id, ...candidate.action });
      assert.equal(result.status, 'applied', `${candidate.id}: ${JSON.stringify(result.error)}`);
    }
    w.state = original; r.a = w.agent(r.a.agent_id);
  };
  check();
  r.a.adventure.hp = 20; r.a.life.inventory.turnip = 2; check();
  r.a.position = { x: 4, y: 11 }; r.a.adventure.in_field = true; check();
  r.a.position = { x: 11, y: 8 }; r.a.adventure.in_field = false;
  for (const payload of [{ intent: 'till', plot_id: 'plot_1' }, { intent: 'plant', plot_id: 'plot_1', crop_id: 'turnip' }, { intent: 'water', plot_id: 'plot_1' }]) {
    const o = observe(w, r);
    assert.equal(w.callTool(r.auth, 'act', { ...r.session, action_id: o.next_action_id, type: 'farm', payload }).status, 'applied');
  }
  advance(121000); r.a.last_contact_at = w.now(); check();
  r.a.life.inventory.turnip = Number.MAX_SAFE_INTEGER;
  assert.equal(observe(w, r).opportunities.some(x => x.action.payload.intent === 'harvest'), false);
  check();
  const o = observe(w, r);
  assert.equal(w.callTool(r.auth, 'act', { ...r.session, action_id: o.next_action_id, type: 'start_activity', payload: { activity_id: 'treasure_hunt' } }).status, 'applied');
  check();
});

test('仓库仅本人MCP与主人可读，旁观及别人的账号只能看田地和装备', t => {
  const { w, r } = fixture(t); const other = role(w, '其他主人角色', 'bob');
  r.a.life.inventory.ore = 719;
  r.a.diagnostics.runtime_version = '0.9.0'; r.a.diagnostics.last_decision_type = 'wait';
  assert.equal(observe(w, r).self.life.inventory.ore, 719);
  assert.equal(w.snapshotFor({ id: 'alice' }).agents.find(a => a.agent_id === r.a.agent_id).life.inventory.ore, 719);
  for (const a of [spectatorSnapshot(w).agents.find(a => a.agent_id === r.a.agent_id), w.snapshotFor({ id: 'bob' }).agents.find(a => a.agent_id === r.a.agent_id), observe(w, other).nearby_agents.find(a => a.agent_id === r.a.agent_id)]) {
    assert.equal(a.life.inventory, undefined); assert.equal(a.diagnostics, undefined);
    assert.equal(a.life.plots.length, 2); assert.ok(a.life.stats.attack > 0);
  }
});

test('接入端诊断保留版本、能力和真实动作回执，不把状态上报当行动或续租', t => {
  const { w, r, advance } = fixture(t), contacted = r.a.last_contact_at;
  advance(1000);
  const data = { ...r.session, mode: 'dsh-pet', runtime_version: '0.9.0', capabilities: ['adventure', 'farming', 'inventory', 'equipment'], last_decision_type: 'wait', state: 'idle', calls_used: 1 };
  w.callTool(r.auth, 'report_status', data);
  assert.equal(r.a.last_contact_at, contacted);
  assert.equal(r.a.diagnostics.last_decision_type, 'wait');
  const o = observe(w, r);
  w.callTool(r.auth, 'act', { ...r.session, action_id: o.next_action_id, type: 'farm', payload: { intent: 'harvest', plot_id: 'plot_1' } });
  w.callTool(r.auth, 'report_status', { ...r.session, state: 'waiting', calls_used: 1 });
  r.a = w.agent(r.a.agent_id); // Rejected actions restore the transaction snapshot.
  assert.equal(r.a.diagnostics.last_action_status, 'rejected');
  assert.equal(r.a.diagnostics.last_action_type, 'farm');
  assert.equal(r.a.diagnostics.runtime_version, '0.9.0');
  assert.throws(() => w.callTool(r.auth, 'report_status', { ...data, capabilities: ['private content'] }), { code: 'INVALID_ACTION' });
  assert.throws(() => w.callTool(r.auth, 'report_status', { ...data, last_decision_type: 'not-an-action' }), { code: 'INVALID_ACTION' });
});

test('真实MCP传输可发现农具并执行开垦/种植/制作/穿戴', async t => {
  const app = await createApp({ dbPath: ':memory:', frontend: false });
  const { server, url } = await app.start(0);
  const r = role(app.world); r.a.position = { x: 11, y: 8 }; app.world.actionIntervalMs = 0;
  const client = new Client({ name: 'life-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${r.controller.token}` } } }));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
  const rules = await call('get_rules'); assert.equal(rules.life.plots_per_agent, 2); assert.ok(rules.allowed_actions.includes('farm'));
  assert.deepEqual(rules.life.tools.map(tool => tool.id), ['hoe', 'watering_can']);
  assert.ok((await call('observe', r.session)).opportunities.some(candidate => candidate.action.type === 'farm' && candidate.action.payload.intent === 'till'));
  const commands = [
    ['farm', { intent: 'till', plot_id: 'plot_1' }],
    ['farm', { intent: 'plant', crop_id: 'turnip', plot_id: 'plot_1' }], ['farm', { intent: 'water', plot_id: 'plot_1' }],
    ['inventory', { intent: 'craft', item_id: 'wooden_sword' }], ['inventory', { intent: 'equip', item_id: 'wooden_sword' }],
  ];
  for (const [type, payload] of commands) {
    const o = await call('observe', r.session);
    assert.equal((await call('act', { ...r.session, action_id: o.next_action_id, type, payload })).status, 'applied');
  }
  const self = (await call('observe', r.session)).self;
  assert.equal(self.life.stats.attack, 8); assert.equal(self.life.plots[0].tilled, true);
  assert.equal(self.life.tools.hoe.durability, 19); assert.equal(self.life.tools.watering_can.durability, 19);
  assert.equal((await call('report_status', { ...r.session, runtime_version: '0.9.0', mode: 'dsh-pet', capabilities: ['farming'], last_decision_type: 'farm' })).ok, true);
  assert.equal((await call('report_status', { ...r.session, state: 'waiting' })).ok, true);
  const pub = await (await fetch(`${url}/api/public/world`)).json(); assert.equal(pub.agents[0].life.inventory, undefined);
});

test('桌宠65秒模型窗口内不会被10秒通用阈值错误标记卡住', t => {
  const { w, r, advance } = fixture(t);
  w.callTool(r.auth, 'report_status', { ...r.session, state: 'thinking', mode: 'dsh-pet' });
  advance(20000); observe(w, r); w.tick();
  assert.equal(w.agent(r.a.agent_id).diagnostics.state, 'thinking');
  advance(20000); observe(w, r); w.tick();
  advance(20000); observe(w, r); w.tick();
  advance(16000); observe(w, r); w.tick();
  assert.equal(w.agent(r.a.agent_id).diagnostics.state, 'stale');
});
