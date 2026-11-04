import test from 'node:test';
import assert from 'node:assert/strict';
import { COOPERATION_RULES } from '../server/cooperation.js';
import { PEER_MARKET_RULES } from '../shared/peer-market.js';
import { prepareDecisionPrompt, expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';
import { peerMarketPromptPart } from '../skills/ai-plaza/scripts/peer-market-context.mjs';
import { World } from '../server/world.js';

const expand = (action, prepared) => JSON.parse(expandDecisionReferences(JSON.stringify(action), prepared.references));
function combatContext() {
  const selfId = 'agent_original', friend = 'agent_friend', now = 1000000;
  return {
    ownerGoal: '沿用我自己的判断，不必回应集市。',
    rules: { room: { width: 48, height: 32 }, max_move: 3, max_capabilities: 16,
      allowed_actions: ['cooperation', 'wait', 'adventure_plan', 'inventory', 'say'], cooperation: COOPERATION_RULES },
    observation: {
      server_time: now,
      self: { agent_id: selfId, scene_id: 'adventure', position: { x: 12, y: 8 }, status: 'active',
        fatigue: { energy: 80, attack_multiplier: 1, hunt_min_energy: 12 },
        adventure: { hp: 32, max_hp: 40, in_field: true, encounter: null }, life: { inventory: {}, equipment: {} } },
      adventure: { monsters: ['forest_slime', 'forest_boar', 'ruins_guardian'].map((monster_id, i) => ({ monster_id,
        position: { x: 13 + i, y: 8 }, hp: 50, attack: 8, behavior: 'attacking', target_agent_id: selfId })) },
      life: { items: [] },
      group: { group_id: 'group_current', members: [selfId, friend] },
      nearby_agents: [{ agent_id: friend, status: 'active', position: { x: 11, y: 8 } }],
      cooperation: { cooperation_id: 'cooperation_original', revision: 2, template_id: 'camp_meal', status: 'needs_review',
        expires_at: now + 600000, self_role_id: 'supplier', members: [{ agent_id: selfId, role_id: 'supplier', confirmed: false }, { agent_id: friend, role_id: 'cook', confirmed: false }],
        progress: [{ step_id: 'supply', progress: 4, target_count: 4 }, { step_id: 'cook', progress: 0, target_count: 1 }], escrow: { turnip: 4 } },
    },
    // A former-group message uses the established compact cooperation path,
    // which creates the real M/M2/M3 monster aliases, rather than invented refs.
    events: [{ type: 'message', payload: { agent_id: friend, channel: 'group', group_id: 'group_previous', text: '我先回去了，你自己决定。' } }],
  };
}

test('v031 market reminders cannot overwrite original M2 monster, group, or cooperation aliases', () => {
  const context = combatContext(), baseline = prepareDecisionPrompt(context);
  assert.equal(baseline.references.M2, 'forest_boar', 'exercise the actual compact combat alias');
  context.rules.allowed_actions.push('peer_market'); context.rules.peer_market = PEER_MARKET_RULES;
  context.observation.peer_market = { version: 1, place: PEER_MARKET_RULES.place, page: 0, total_pages: 1, total_open: 2, offers: [], at_market: false,
    own_offer: { offer_id: 'offer_own', revision: 1, status: 'open' }, incoming_gifts: [{ offer_id: 'offer_gift', revision: 1, page: 0 }], opportunities: [] };
  const before = structuredClone(context), prepared = prepareDecisionPrompt(context);
  assert.ok(prepared.text.length <= 2000); assert.match(prepared.text, /公告概况/);
  assert.equal(prepared.references['@M1'], 'offer_own'); assert.equal(prepared.references['@M2'], 'offer_gift');
  for (const [alias, original] of Object.entries(baseline.references)) assert.equal(prepared.references[alias], original, alias);
  assert.deepEqual(expand({ type: 'adventure_plan', payload: { intent: 'hunt', monster_id: 'M2' } }, prepared),
    { type: 'adventure_plan', payload: { intent: 'hunt', monster_id: 'forest_boar' } });
  assert.deepEqual(expand({ type: 'peer_market', payload: { intent: 'decline', offer_id: '@M2', revision: 1 } }, prepared),
    { type: 'peer_market', payload: { intent: 'decline', offer_id: 'offer_gift', revision: 1 } });
  assert.deepEqual(expand({ type: 'say', payload: { channel: 'group', group_id: 'H', text: '收到' } }, prepared),
    { type: 'say', payload: { channel: 'group', group_id: 'group_previous', text: '收到' } });
  assert.ok(prepared.text.includes(context.ownerGoal)); assert.ok(prepared.text.includes(context.events[0].payload.text));
  assert.deepEqual(context, before);
});

test('v031 current quote and gift recipient/item aliases round-trip without altering the selected trade terms', () => {
  const context = combatContext(); context.rules.allowed_actions.push('peer_market'); context.rules.peer_market = PEER_MARKET_RULES;
  context.observation.self.scene_id = 'plaza'; context.observation.self.adventure.in_field = false;
  context.observation.adventure.monsters = []; context.observation.cooperation = null;
  context.observation.peer_market = { version: 1, place: PEER_MARKET_RULES.place, catalog: PEER_MARKET_RULES.catalog, page: 0, total_pages: 1, total_open: 1, at_market: true,
    offers: [{ offer_id: 'offer_current', revision: 1, kind: 'gift', owner_agent_id: 'agent_original', target_agent_id: 'agent_friend', status: 'open',
      give: { items: { ruins_leaf_medallion: 1, wheat_bread: 2 }, gold: 7 }, want: { items: {}, gold: 0 }, expires_at: 1600000 }],
    opportunities: [], own_offer: null, pending_return: null, incoming_gifts: [] };
  const before = structuredClone(context), part = peerMarketPromptPart(context, { compact: true }), row = part.data.offers[0];
  assert.ok(Object.keys(part.references).every(alias => /^@M\d+$/.test(alias)));
  assert.deepEqual(expand({ type: 'peer_market', payload: { intent: 'post', kind: 'gift', target_agent_id: row[4], give: { items: row[5][0], gold: row[5][1] } } }, part),
    { type: 'peer_market', payload: { intent: 'post', kind: 'gift', target_agent_id: 'agent_friend', give: { items: { ruins_leaf_medallion: 1, wheat_bread: 2 }, gold: 7 } } });
  assert.deepEqual(expand({ type: 'peer_market', payload: { intent: 'accept', offer_id: row[0], revision: row[1] } }, part),
    { type: 'peer_market', payload: { intent: 'accept', offer_id: 'offer_current', revision: 1 } });
  assert.deepEqual(context, before);
});

test('v031 focused reading retains the real partly burnt last torch after lighting consumed its inventory item', t => {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const actor = name => {
    const id = world.createAgent({ name }).agent_id, ctl = world.createController(id);
    world.ownerControl(id, 'start', { controller_id: ctl.controller_id, max_calls: 1000, duration_minutes: 60, goal: '自主生活' });
    const auth = world.authenticate(ctl.token); world.callTool(auth, 'join_world');
    const raw = world.agent(id); raw.position = { ...PEER_MARKET_RULES.place.interaction_position };
    raw.life.inventory = Object.fromEntries(PEER_MARKET_RULES.catalog.map(item => [item.id, item.kind === 'relic' ? 1 : 500]));
    const observe = () => world.callTool(auth, 'observe', { run_id: raw.run.run_id, session_epoch: raw.session_epoch });
    return { raw, observe, act(type, payload) {
      const o = observe(), r = world.callTool(auth, 'act', { run_id: o.run_id, session_epoch: o.session_epoch, action_id: o.next_action_id, type, payload });
      assert.equal(r.status, 'applied', JSON.stringify(r)); return r;
    } };
  };
  const reader = actor('带着最后一支火把的读者'), sellers = [actor('第一位报价者'), actor('第二位报价者')];
  const ids = PEER_MARKET_RULES.catalog.map(item => item.id);
  for (let n = 0; n < sellers.length; n++) sellers[n].act('peer_market', { intent: 'post', kind: 'exchange',
    give: { items: Object.fromEntries(ids.slice(n * 8, n * 8 + 4).map(id => [id, 99])) },
    want: { items: Object.fromEntries(ids.slice(n * 8 + 4, n * 8 + 8).map(id => [id, 99])) } });
  reader.raw.life.inventory.torch = 1;
  reader.act('survival', { intent: 'torch', lit: true });
  assert.equal(reader.raw.life.inventory.torch, 0, 'the lit torch is no longer an unused inventory item');
  const initialFuel = reader.raw.survival.torch.fuel_seconds;
  now += 7000; world.tick();
  assert.ok(reader.raw.survival.torch.fuel_seconds > 0 && reader.raw.survival.torch.fuel_seconds < initialFuel);
  reader.raw.adventure.hp = 20; reader.raw.fatigue.energy = 50; reader.raw.survival.satiety = 20;
  reader.act('peer_market', { intent: 'browse', page: 0 });
  const observation = reader.observe(), context = { observation, rules: world.getRules(), ownerGoal: '🐟'.repeat(170),
    events: [{ type: 'message', payload: { agent_id: sellers[0].raw.agent_id, channel: 'nearby', text: '🌱'.repeat(90) } }],
    lastActionFeedback: { type: 'peer_market', status: 'applied', requested: { intent: 'browse', page: 0 } } };
  const before = structuredClone(world.state), snapshot = structuredClone(context), prepared = prepareDecisionPrompt(context);
  assert.ok(prepared.text.length <= 2000); assert.equal(prepared.marketReadingDeferred, undefined);
  const data = JSON.parse(prepared.text.split('公开数据：')[1]);
  assert.ok(data.body, 'exercise the focused market reading frame');
  assert.deepEqual(data.torch, { lit: true, fuel_seconds: observation.self.survival.torch.fuel_seconds });
  assert.deepEqual(data.body, [20, observation.self.adventure.max_hp, 50, 20, observation.self.survival.light.lit, observation.self.survival.danger_in_seconds]);
  assert.ok(prepared.text.includes(JSON.stringify(context.ownerGoal))); assert.ok(prepared.text.includes(context.events[0].payload.text));
  assert.deepEqual(context, snapshot); assert.deepEqual(world.state, before, 'formatting facts cannot trigger actions, consume fuel, or alter the original world');
});
