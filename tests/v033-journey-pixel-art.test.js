import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyIdentity, journeyCharacterPixels, journeyMonsterPixels, JOURNEY_SPRITE_GEOMETRY } from '../src/journey-pixel-art.js';
import { journeySpriteState } from '../src/journey-combat-motion.js';

const actor = () => ({ agent_id: 'tide', status: 'active', scene_id: 'journey', facing: 'east', position: { x: 17, y: 16 }, position_at: 1000,
  appearance: { version: 1, sprite_id: 'wanderer_3', seed: '1234567890abcdef', accessory_id: 'scarf', accent: '#6677aa' }, life: { equipment: {} } });
const attack = (outcome = null) => ({ action_id: 'swing-1', type: 'attack', scene_id: 'journey', target_id: 'journey_slime', target_kind: 'monster', facing: 'east',
  started_at: 1000, impact_at: 1350, ends_at: 2000, phase: outcome ? 'recovery' : 'prepare', outcome, damage: outcome === 'hit' ? 6 : 0, resolved_at: outcome ? 1350 : null });

test('original pixel clusters keep a fixed foot anchor and stable saved appearance without mutation', () => {
  const a = actor(), original = structuredClone(a), identity = journeyIdentity(a), state = journeySpriteState(a, 1000);
  assert.deepEqual(JOURNEY_SPRITE_GEOMETRY, { width: 48, height: 48, foot: { x: 24, y: 43 } });
  assert.deepEqual(journeyIdentity(structuredClone(a)), identity); assert.equal(identity.hair, '#294b70'); assert.equal(identity.coat, '#36a3af');
  assert.equal(identity.accent, a.appearance.accent); assert.equal(identity.accessory, 'scarf');
  const first = journeyCharacterPixels(a, state), again = journeyCharacterPixels(structuredClone(a), state); assert.deepEqual(first, again);
  assert.deepEqual(a, original); assert.ok(first.some(r => r.part === 'hair' && r.y === 3), 'Tide retains its blue fin-shaped hair tuft');
  assert.equal(Math.max(...first.map(r => r.y + r.h)), 43); assert.equal(first.some(r => r.part === 'tool'), false, 'an empty hand never invents a sword');
  assert.notDeepEqual(journeyCharacterPixels({ ...a, appearance: { ...a.appearance, sprite_id: 'wanderer_4' } }, state), first);
  assert.notDeepEqual(journeyCharacterPixels({ ...a, appearance: { ...a.appearance, accessory_id: 'leaf' } }, state), first);
});

test('all actor and monster frames are hand-authored integer-grid clusters inside the sprite canvas', () => {
  for (let variant = 1; variant <= 8; variant++) for (const action of ['idle', 'walk', 'run', 'attack', 'gather', 'rest', 'hurt', 'eat']) for (let frame = 0; frame < 4; frame++) {
    const a = actor(); a.appearance.sprite_id = `wanderer_${variant}`; a.life.equipment.weapon = 'iron_sword'; a.life.gathering = { tool_id: 'axe' };
    const state = { action, frame }, art = journeyCharacterPixels(a, state);
    for (const r of art) { assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger)); assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 48 && r.y + r.h <= 48, JSON.stringify(r)); assert.match(r.color, /^#[0-9a-f]{6}$/i); }
    for (const monster_id of ['journey_slime', 'journey_boar']) for (const r of journeyMonsterPixels({ monster_id }, state)) assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger) && r.x >= 0 && r.y >= 0 && r.x + r.w <= 48 && r.y + r.h <= 48);
  }
});

test('walk and run alternate real feet and arms only inside a live confirmed movement interval', () => {
  const a = actor(); a.movement = { version: 2, movement_id: 'move-1', scene_id: 'journey', mode: 'walk', speed: 2, path: [{ x: 17, y: 16 }, { x: 18, y: 16 }], started_at: 1000, ends_at: 1500, duration_ms: 500 };
  const first = journeySpriteState(a, 1000), second = journeySpriteState(a, 1140); assert.equal(first.action, 'walk'); assert.equal(second.frame, 1);
  assert.notDeepEqual(journeyCharacterPixels(a, first).filter(r => r.part.endsWith('leg')), journeyCharacterPixels(a, second).filter(r => r.part.endsWith('leg')));
  a.movement.mode = 'run'; a.movement.speed = 3.5; assert.equal(journeySpriteState(a, 1090).frame, 1); assert.equal(journeySpriteState(a, 1090).action, 'run');
  assert.equal(journeySpriteState(a, 1251).action, 'idle', 'prediction cannot animate a stale path indefinitely');
  assert.equal(journeySpriteState(a, 999).action, 'idle'); assert.equal(journeySpriteState(a, 1500).action, 'idle');
  assert.equal(journeySpriteState(a, 1140, { live: false }).frame, 0); assert.equal(journeySpriteState(a, 1140, { live: false }).action, 'idle');
});

test('attack anticipation never predicts a hit; dash/swing follows a real resolved action and resets per action timestamp', () => {
  const a = actor(); a.action = attack();
  assert.equal(journeySpriteState(a, 999).action, 'idle'); assert.equal(journeySpriteState(a, 1000).frame, 0);
  assert.equal(journeySpriteState(a, 1200).phase, 'anticipation'); assert.equal(journeySpriteState(a, 1500).phase, 'anticipation');
  assert.equal(journeySpriteState(a, 1500).damage, null); assert.equal(journeySpriteState(a, 1500).spark, false);
  a.action = attack('hit'); const hit = journeySpriteState(a, 1350); assert.equal(hit.frame, 2); assert.equal(hit.x, 5); assert.equal(hit.phase, 'swing');
  assert.equal(hit.damage, null, 'outgoing damage is not drawn over the attacker'); assert.equal(hit.flash, false);
  assert.equal(journeySpriteState(a, 1490).phase, 'recovery'); assert.equal(journeySpriteState(a, 2000).action, 'idle');
  a.action = { ...attack(), action_id: 'swing-2', started_at: 2100, impact_at: 2450, ends_at: 3100 };
  assert.equal(journeySpriteState(a, 2100).key, 'swing-2'); assert.equal(journeySpriteState(a, 2100).frame, 0);
  a.action.outcome = 'cancelled'; assert.equal(journeySpriteState(a, 2200).action, 'idle');
});

test('hurt reaction, spark and digits require a confirmed positive server hurt window', () => {
  const a = actor(); a.hurt = { action_id: 'hit-1', started_at: 1200, ends_at: 1560, damage: 3 };
  assert.equal(journeySpriteState(a, 1199).damage, null); const hurt = journeySpriteState(a, 1200);
  assert.equal(hurt.action, 'hurt'); assert.equal(hurt.damage, 3); assert.equal(hurt.x, -3); assert.equal(hurt.flash, true); assert.equal(hurt.spark, true);
  assert.equal(journeySpriteState(a, 1320).spark, false); assert.equal(journeySpriteState(a, 1560).damage, null);
  assert.equal(journeySpriteState(a, 1250, { live: false }).damage, null); assert.equal(journeySpriteState({ ...a, status: 'paused' }, 1250).damage, null);
  const reduced = journeySpriteState(a, 1250, { reducedMotion: true }); assert.equal(reduced.x, 0); assert.equal(reduced.flash, false); assert.equal(reduced.spark, false); assert.equal(reduced.frame, 0);
});

test('gathering, resting and eating are finite observed activities with the actual held tool', () => {
  const a = actor(); a.life.gathering = { job_id: 'gather-1', scene_id: 'journey', phase: 'working', work_started_at: 1000, ends_at: 4000, tool_id: 'pickaxe' };
  const state = journeySpriteState(a, 1400); assert.equal(state.action, 'gather'); assert.equal(state.frame, 2); assert.ok(journeyCharacterPixels(a, state).some(r => r.part === 'tool'));
  a.life.gathering.tool_id = null; assert.equal(journeyCharacterPixels(a, state).some(r => r.part === 'tool'), false);
  assert.equal(journeySpriteState(a, 4000).action, 'idle'); a.life.gathering = null;
  a.journey_job = { job_id: 'rest-1', phase: 'resting', started_at: 1000, ends_at: 16000, expires_at: 20000 };
  assert.equal(journeySpriteState(a, 2000).action, 'rest'); assert.equal(journeySpriteState(a, 16000).action, 'idle');
  const events = [{ event_id: 'meal-1', type: 'life_consumed', occurred_at: 1500, payload: { agent_id: a.agent_id, scene_id: 'journey', item_id: 'berry' } }];
  assert.equal(journeySpriteState(a, 1600, { events }).action, 'eat'); assert.equal(journeySpriteState(a, 2700, { events }).action, 'rest');
  assert.equal(journeySpriteState(a, 1600, { events: [{ ...events[0], payload: { ...events[0].payload, agent_id: 'other' } }] }).action, 'rest');
});

test('monster sprites use original distinct bodies, real side-facing attacks and defeated/stale stillness', () => {
  const m = { ...actor(), agent_id: undefined, monster_id: 'journey_boar', status: 'alive', facing: 'west', action: { ...attack('hit'), facing: 'west', target_kind: 'agent' } };
  const sample = journeySpriteState(m, 1350, { monster: true }); assert.equal(sample.x, -5); assert.equal(sample.action, 'attack');
  assert.notDeepEqual(journeyMonsterPixels(m, sample), journeyMonsterPixels({ ...m, monster_id: 'journey_slime' }, sample));
  assert.equal(journeySpriteState({ ...m, status: 'respawning' }, 1350, { monster: true }).action, 'idle');
  assert.equal(journeySpriteState(m, 1350, { monster: true, live: false }).x, 0);
  const before = structuredClone(m); journeyMonsterPixels(m, sample); assert.deepEqual(m, before);
});

test('actual wooden shield, iron armor and heavy armor have distinct physical equipment silhouettes', () => {
  const a = actor(), pixels = armor => journeyCharacterPixels({ ...a, life: { equipment: { armor } } }, { action: 'idle', frame: 0 }).filter(p => p.part.startsWith('armor-'));
  const wood = pixels('wooden_shield'), iron = pixels('iron_armor'), heavy = pixels('heavy_armor');
  assert.ok(wood.length && wood.every(p => p.part === 'armor-shield')); assert.ok(wood.some(p => p.x < 17), 'shield is carried beside the body, not painted as a breastplate');
  assert.ok(wood.some(p => p.color === '#b17d43')); assert.ok(iron.length && iron.every(p => p.part === 'armor-iron'));
  assert.ok(heavy.some(p => p.x < 19 && p.y < 30), 'heavy armor includes its real bulk and shoulder plates');
  assert.notDeepEqual(iron, heavy); assert.deepEqual(pixels(null), []); assert.deepEqual(pixels('invented_armor'), []);
});

test('meal art follows the public consumed item and never relabels a berry or turnip as bread', () => {
  const a = actor(), food = item_id => {
    const events = [{ event_id: `meal-${item_id}`, type: 'life_consumed', occurred_at: 1000, payload: { agent_id: a.agent_id, scene_id: 'journey', item_id } }];
    const state = journeySpriteState(a, 1100, { events }); assert.equal(state.itemId, item_id);
    return journeyCharacterPixels(a, state).filter(p => p.part === 'food');
  };
  const bread = food('wheat_bread'), berry = food('berry'), roasted = food('roasted_berry'), turnip = food('turnip');
  assert.ok(bread.some(p => p.color === '#edc37a')); assert.ok(berry.some(p => p.color === '#d96b9c')); assert.ok(turnip.some(p => p.color === '#fff0c9'));
  assert.notDeepEqual(berry, bread); assert.notDeepEqual(roasted, berry); assert.notDeepEqual(turnip, bread); assert.notDeepEqual(food('unknown_food'), bread);
});
