import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { DshPetClient, prepareDecisionPrompt } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { resourcePromptNotice, resourceJobContext } from '../skills/ai-plaza/scripts/resources-context.mjs';

const NODE = 'camp_fallen_berries';
const decode = prepared => JSON.parse(prepared.text.split('公开数据：')[1]);
function fixture(t) {
  const world = new World({ actionIntervalMs: 0 }); t.after(() => world.close());
  const id = world.createAgent({ name: '原来的桌宠', bio: '自己的性格与记忆' }).agent_id, ctl = world.createController(id);
  const goal = '今天由我自己决定\n可以发呆，也可以探索。🐟';
  world.ownerControl(id, 'start', { controller_id: ctl.controller_id, max_calls: 100, goal });
  world.callTool(world.authenticate(ctl.token), 'join_world');
  const a = world.agent(id); a.position = { x: 11, y: 8 }; a.fatigue.energy = 0; a.survival.satiety = 0;
  a.life.inventory = {}; a.adventure.gold = 17;
  const context = () => ({ rules: world.getRules(), observation: world.observation(a), events: [], ownerGoal: goal });
  return { world, a, goal, context };
}

test('v029 unchanged adapter reads food prices dynamically in a bounded market observation; no hardcoded v029 choices required', t => {
  const f = fixture(t), all = f.context();
  // This is a focused service observation to test the adapter's dynamic
  // catalogue contract. A crowded full-world prompt can omit these optional
  // prices at the existing 2000-character budget; that is not hidden here.
  const ctx = { rules: { allowed_actions: all.rules.allowed_actions, adventure: {}, life: all.rules.life }, ownerGoal: f.goal,
    observation: { server_time: all.observation.server_time,
      self: { agent_id: f.a.agent_id, scene_id: 'plaza', position: all.observation.self.position,
        life: { inventory: {}, market: all.observation.self.life.market }, adventure: all.observation.self.adventure },
      life: { items: all.observation.life.items, market: all.observation.life.market } }, events: [] };
  const prepared = prepareDecisionPrompt(ctx), prices = decode(prepared).supply.prices;
  assert.ok(prepared.text.length <= 2000);
  assert.deepEqual(prices.find(row => row[0] === 'wheat_bread'), ['wheat_bread', 12, null]);
  assert.deepEqual(prices.find(row => row[0] === 'turnip'), ['turnip', 5, 2]);
  const changed = structuredClone(ctx); changed.observation.life.market.items.find(row => row.item_id === 'wheat_bread').buy_price = 13;
  assert.deepEqual(decode(prepareDecisionPrompt(changed)).supply.prices.find(row => row[0] === 'wheat_bread'), ['wheat_bread', 13, null]);
  assert.equal(f.world.getRules().life.market.items.find(row => row.item_id === 'wheat_bread').buy_price, 12, 'rendering a supplied observation cannot mutate server policy');
});

test('v029 full zero-state observation exposes the 0-energy node; held food exposes actual restoration without consuming it', t => {
  const f = fixture(t), ctx = f.context(), before = structuredClone(ctx);
  const notice = resourcePromptNotice(ctx.observation, ctx.rules), prepared = prepareDecisionPrompt(ctx);
  assert.match(notice, /camp_fallen_berries/); assert.match(notice, /null,6,0,/);
  assert.match(prepared.text, /camp_fallen_berries/); assert.match(prepared.text, /6秒\/0体/);
  assert.deepEqual(ctx, before); assert.equal(f.a.life.gathering, null); assert.deepEqual(f.a.life.inventory, {});
  f.a.life.inventory = { wheat_bread: 1, berry: 1 }; f.a.fatigue.energy = 35; f.a.survival.satiety = 40;
  const food = decode(prepareDecisionPrompt(f.context())).food;
  assert.deepEqual(food.find(row => row[0] === 'wheat_bread'), ['wheat_bread', 0, 1, 24, 35]);
  assert.deepEqual(food.find(row => row[0] === 'berry'), ['berry', 4, 1, 2, 12]);
  assert.deepEqual(f.a.life.inventory, { wheat_bread: 1, berry: 1 });
  const working = structuredClone(ctx.observation);
  working.self.life.gathering = { node_id: NODE, phase: 'working', ends_at: working.server_time + 6000,
    expires_at: working.server_time + 120000, mode: 'walk', energy_cost: 0, yield_count: 1 };
  assert.deepEqual(resourceJobContext(working), [NODE, 'working', 6, 120, 'walk', 0, 1]);
});

test('v029 original dsh-pet may choose wait despite available food; adapter preserves owner goal/persona and only relays its chosen action', async t => {
  const f = fixture(t), ctx = f.context(), contextBefore = JSON.stringify(ctx), identity = JSON.stringify([f.a.goal, f.a.bio, f.a.appearance, f.a.run]);
  const persona = { main: { whisperPrompt: '原来的私有设定\n不替换 🐟', pets: [{ id: 'original-pet', name: '原来的桌宠', display: 'both', whisperPrompt: '自己的记忆\n保留空格  和符号。' }] } };
  const personaBefore = JSON.stringify(persona), calls = [];
  const chosen = { type: 'wait', payload: {} };
  const pet = new DshPetClient({ petId: 'original-pet', url: 'http://127.0.0.1:32991', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith('/config')) return { ok: true, json: async () => persona };
    assert.match(url, /\/chat\?pet=original-pet&surface=any$/);
    const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['text']);
    assert.ok(body.text.includes(JSON.stringify(f.goal)), 'the original owner goal retains line breaks and Unicode semantics');
    assert.ok(body.text.includes(NODE)); assert.ok(!body.text.includes(persona.main.whisperPrompt));
    return { ok: true, json: async () => ({ ok: true, text: JSON.stringify(chosen) }) };
  } });
  assert.deepEqual(JSON.parse(await pet.decide(ctx)), chosen, 'available services never replace the model choice with food or rest');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(calls.filter(c => c.method === 'POST').every(c => c.url.includes('/chat?')));
  assert.equal(JSON.stringify(persona), personaBefore); assert.equal(JSON.stringify(ctx), contextBefore);
  assert.equal(JSON.stringify([f.a.goal, f.a.bio, f.a.appearance, f.a.run]), identity);
  assert.deepEqual(f.a.life.inventory, {}); assert.equal(f.a.life.gathering, null);
});
