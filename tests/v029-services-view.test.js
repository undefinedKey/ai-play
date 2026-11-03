import test from 'node:test';
import assert from 'node:assert/strict';
import { observerExecution, observerActionResult, observerConditions, worldFoodServices, foodEffects } from '../src/world-services-state.js';
import { resourceArtwork } from '../src/scene-art.js';
import { publicGame } from '../server/games.js';

const time = 2000;
const actor = { agent_id: 'resident', status: 'active', scene_id: 'plaza', position: { x: 10, y: 9 } };
const world = { agents: [actor], life: { items: [{ id: 'berry', kind: 'food', name: '野生浆果', satiety_restore: 12, energy_restore: 2 }] }, resources: { nodes: [] } };

test('an unsuccessful request remains a dated receipt, never an invented current intention or blocker', () => {
  const resident = { ...actor, action_status: { type: 'gather', status: 'rejected', at: 1000, error_code: 'FATIGUE_EXHAUSTED', message: 'PRIVATE_MODEL_THOUGHT', payload: { ownerGoal: 'PRIVATE_OWNER_GOAL' } } };
  assert.equal(observerExecution(world, resident, time).text, '暂无执行中的行动');
  assert.deepEqual(observerActionResult(resident), { status: 'rejected', at: 1000, text: '采集未执行 · 体力不足' });
  resident.movement = { scene_id: 'plaza', mode: 'run', ends_at: 5000 };
  assert.match(observerExecution(world, resident, time).text, /正在奔跑/);
  assert.match(observerActionResult(resident).text, /未执行/, 'old failure is distinct from the newer current motion');
  resident.action_status = { type: 'wait', status: 'applied', at: time };
  assert.equal(observerActionResult(resident).text, '等待已受理');
  assert.equal(observerActionResult({ action_status: { type: 'PRIVATE_TYPE', status: 'rejected', at: time, error_code: 'PRIVATE_ERROR' } }).text, '操作未执行');
  assert.equal(observerActionResult({ action_status: { type: 'gather', status: 'pending', at: time } }), null);
});

test('gathering uses only its actual scene and receipt phase; an elapsed clock cannot produce a completion', () => {
  const job = { phase: 'approaching', scene_id: 'plaza', item_id: 'berry', node_id: 'fruit', ends_at: null };
  const resident = { ...actor, life: { gathering: job } };
  const snapshot = { ...world, resources: { nodes: [{ id: 'fruit', name: '公开落果处' }] } };
  assert.equal(observerExecution(snapshot, resident, time).text, '正在前往公开落果处');
  job.phase = 'working'; job.ends_at = 6000;
  assert.match(observerExecution(snapshot, resident, time).text, /正在采集 · 公开落果处 · 4 秒/);
  assert.match(observerExecution(snapshot, resident, 7000).text, /等待服务器确认/);
  assert.equal(job.phase, 'working');
  assert.equal(observerExecution(snapshot, { ...resident, scene_id: 'adventure' }, time).kind, 'idle');
});

test('indoor work excludes stale outdoor tasks and distinguishes approaching, use, and waiting', () => {
  const resident = { ...actor, movement: { scene_id: 'plaza', mode: 'run', ends_at: 5000 }, life: { gathering: { phase: 'working', scene_id: 'plaza', ends_at: 6000 } }, home_presence: { home_id: 'one', activity: { kind: 'read', phase: 'approaching', started_at: 1000 } } };
  assert.equal(observerExecution(world, resident, time).text, '正在走向家具 · 阅读');
  resident.home_presence.activity = { kind: 'read', phase: 'using', started_at: 1000, ends_at: 6000 };
  assert.match(observerExecution(world, resident, time).text, /正在阅读/);
  assert.match(observerExecution(world, resident, 7000).text, /等待服务器确认/);
  resident.home_presence.activity = null;
  assert.equal(observerExecution(world, resident, time).kind, 'idle');
  resident.home_presence.movement = { ends_at: 5000 };
  assert.equal(observerExecution(world, resident, time).kind, 'home_move');
  assert.equal(observerExecution(world, { ...resident, status: 'paused' }, time).text, '活动已暂停');
  assert.equal(observerExecution(world, { ...resident, status: 'offline' }, time).kind, 'inactive');
});

test('plaza rest, portal trips, actual fishing and activities retain their own public execution state', () => {
  const plan = { intent: 'rest', phase: 'resting', destination_scene_id: 'plaza', expires_at: 90000 };
  assert.match(observerExecution(world, { ...actor, adventure: { plan } }, time).text, /正在营地休息/);
  assert.equal(observerExecution(world, { ...actor, adventure: { plan: { intent: 'hunt', phase: 'to_portal', destination_scene_id: 'adventure' } } }, time).text, '正在前往场景入口');
  const fishing = { phase: 'fishing', scene_id: 'plaza', interaction_position: actor.position, started_at: 1000, ends_at: 5000 };
  assert.match(observerExecution(world, { ...actor, fishing }, time).text, /正在垂钓/);
  assert.equal(observerExecution(world, { ...actor, scene_id: 'adventure', fishing }, time).kind, 'idle');
  assert.match(observerExecution(world, { ...actor, activity: { name: '数列挑战', ends_at: 5000 } }, time).text, /正在参加数列挑战/);
  assert.equal(observerExecution(world, { ...actor, scene_id: 'adventure', activity: { name: '数列挑战' } }, time).kind, 'idle');
});

test('conditions describe zero resources and darkness without assigning a remedy or guessing cognition', () => {
  const resident = { ...actor, fatigue: { energy: 0 }, survival: { satiety: 0, light: { lit: false } } };
  assert.deepEqual(observerConditions({ day_cycle: { phase: 'night' } }, resident), ['体力为 0', '饱食度为 0', '夜间当前位置无光源']);
  assert.deepEqual(observerConditions(world, { ...actor, fatigue: { energy: 1 }, survival: { satiety: 1 } }), []);
});

test('public multiplayer participation is an execution state without revealing a hidden choice or inventing a turn', () => {
  const game = { game_id: 'match', game_type: 'word_chain', status: 'active', participants: [actor.agent_id, 'other'], current_agent_id: actor.agent_id, deadline: 6000 };
  const state = () => ({ ...world, game: publicGame(game, { spectator: true }) });
  assert.equal(observerExecution(state(), actor, time).text, '正在参加词语接龙 · 当前为该角色的回合');
  game.current_agent_id = 'other';
  assert.match(observerExecution(state(), actor, time).text, /等待其他参与者的回合/);
  game.game_type = 'rock_paper_scissors'; game.current_agent_id = null; game.pending_choices = { [actor.agent_id]: 'scissors' }; game.submitted_agent_ids = [actor.agent_id];
  assert.equal(observerExecution(state(), actor, time).text, '正在参加石头剪刀布 · 本轮已提交，等待揭晓');
  assert.ok(!JSON.stringify(observerExecution(state(), actor, time)).includes('scissors'));
  game.submitted_agent_ids = [];
  assert.match(observerExecution(state(), actor, time).text, /本轮尚未提交/);
  game.status = 'recruiting';
  assert.equal(observerExecution(state(), actor, time).text, '已报名石头剪刀布 · 等待开始');
  assert.equal(observerExecution(state(), { ...actor, scene_id: 'adventure' }, time).kind, 'idle');
  assert.equal(observerExecution(state(), { ...actor, home_presence: { home_id: 'one' } }, time).kind, 'idle');
  game.status = 'finished'; assert.equal(observerExecution(state(), actor, time).kind, 'idle');
});

test('fallen berries use the low ground item without changing bush art, coordinates or cached neighbors', () => {
  const assets = { items: { item_berry: { sprite_id: 'berry_item', native_scale: 1, anchor: { x: 8, y: 14 } } }, wilderness: { berries: { sprite_id: 'berry_bush', anchor: { x: 16, y: 40 } } } };
  const bush = { id: 'orchard_berries', kind: 'berry_bush', position: { x: 27, y: 11 } }, fallen = { id: 'camp_fallen_berries', kind: 'berry_bush', position: { x: 9, y: 9 } };
  const original = structuredClone(fallen);
  assert.equal(resourceArtwork(assets, bush).sprite_id, 'berry_bush');
  assert.equal(resourceArtwork(assets, fallen).sprite_id, 'berry_item');
  assert.ok(resourceArtwork(assets, fallen).anchor.y * resourceArtwork(assets, fallen).native_scale < resourceArtwork(assets, bush).anchor.y);
  assert.equal(resourceArtwork(assets, bush).sprite_id, 'berry_bush');
  assert.deepEqual(fallen, original);
});

test('food services use live public catalog prices and zero-cost resources, preserving 0 and excluding private state', () => {
  const snapshot = { ...world, life: { items: [...world.life.items, { id: 'bread', kind: 'food', name: '面包', satiety_restore: 40 }, { id: 'wood', kind: 'material' }], market: { items: [{ item_id: 'bread', buy_price: 17 }, { item_id: 'berry', buy_price: 0 }, { item_id: 'wood', buy_price: 1 }, { item_id: 'bread', buy_price: null }] } }, resources: { nodes: [{ id: 'free', item_id: 'berry', energy_cost: 0, stock: 1, duration_seconds: 6 }, { id: 'costly', item_id: 'berry', energy_cost: 3 }, { id: 'material', item_id: 'wood', energy_cost: 0 }] } };
  const services = worldFoodServices(snapshot);
  assert.deepEqual(services.offers.map(item => item.price), [17, 0]);
  assert.deepEqual(services.forage.map(item => item.node.id), ['free']);
  assert.equal(services.forage[0].node.duration_seconds, 6);
  snapshot.life.market.items[0].buy_price = 20;
  assert.equal(worldFoodServices(snapshot).offers[0].price, 20, 'no client price table');
  assert.equal(foodEffects(snapshot.life.items[0]), '饱食 +12 · 体力 +2');
  assert.deepEqual(worldFoodServices({}).offers, []);
});
