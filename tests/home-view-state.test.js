import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedHome, homeActors, homeActorProxy, homePosition, furnitureSize } from '../src/home-state.js';
import { sceneActors } from '../src/scene-state.js';
import { activeSpeeches } from '../src/speech-state.js';
import { survivalStatus } from '../src/survival-state.js';

const homes = [{ home_id: 'one', owner_agent_id: 'host' }, { home_id: 'two', owner_agent_id: 'guest' }];
const host = { agent_id: 'host', name: '屋主', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'one', position: { x: 2, y: 3 } } };
const guest = { agent_id: 'guest', name: '朋友', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'one', position: { x: 5, y: 7 } } };
const other = { agent_id: 'other', status: 'active', scene_id: 'plaza', position: { x: 9, y: 8 }, home_presence: { home_id: 'two', position: { x: 2, y: 3 } } };

test('home observation selects explicit room or current visit, without borrowing another home', () => {
  assert.equal(selectedHome(homes, [host, guest], 'guest').home_id, 'one');
  assert.equal(selectedHome(homes, [host, guest], 'guest', 'two').home_id, 'two');
  assert.equal(selectedHome(homes, [], 'new'), null);
  assert.equal(selectedHome(homes, [host], 'host', 'missing'), null);
  assert.deepEqual(homeActors([host, guest, other], 'one').map(a => a.agent_id), ['host', 'guest']);
  assert.deepEqual(sceneActors([host, guest, other], 'plaza'), []);
});

test('home rendering preserves identity and equipment but never uses outdoor motion/action', () => {
  const source = { ...host, appearance: { sprite_id: 'original' }, life: { equipment: { weapon: 'sword' }, gathering: { phase: 'working' } }, movement: { path: [{ x: 12, y: 10 }] }, action: { type: 'attack' }, home_presence: { ...host.home_presence, facing: 'west' } };
  const proxy = homeActorProxy(source);
  assert.deepEqual(proxy.appearance, source.appearance);
  assert.deepEqual(proxy.life.equipment, source.life.equipment);
  assert.deepEqual(proxy.position, { x: 2, y: 3 });
  assert.equal(proxy.movement, null); assert.equal(proxy.action, null); assert.equal(proxy.life.gathering, null);
  assert.equal(proxy.facing, 'west'); assert.equal(source.action.type, 'attack');
  assert.deepEqual(homePosition(source, 90000, false), { x: 2, y: 3 });
  assert.deepEqual(furnitureSize({ kind: 'table', rotation: 90 }), [1, 2]);
});

test('live speech stays in the exact room and old room speech cannot follow an actor outdoors', () => {
  const events = [{ event_id: 1, type: 'message', occurred_at: 900, payload: { agent_id: 'host', scene_id: 'plaza', home_id: 'one', channel: 'nearby', text: '屋内的话' } }];
  assert.equal(activeSpeeches({ events, agents: [host], now: 1000, sceneId: 'plaza' }).length, 1);
  assert.equal(activeSpeeches({ events, agents: [{ ...host, home_presence: null }], now: 1000, sceneId: 'plaza' }).length, 0);
  assert.equal(activeSpeeches({ events, agents: [{ ...host, home_presence: other.home_presence }], now: 1000, sceneId: 'plaza' }).length, 0);
});

test('interior movement samples its own clock and freezes the confirmed position on disconnect', () => {
  const actor = { ...host, home_presence: { home_id: 'one', position: { x: 2, y: 3 }, position_at: 1000,
    movement: { version: 2, scene_id: 'home', speed: 2, path: [{ x: 2, y: 3 }, { x: 3, y: 3 }], started_at: 1000, ends_at: 1500, duration_ms: 500, mode: 'walk' } } };
  assert.deepEqual(homePosition(actor, 1100, true), { x: 2.2, y: 3 });
  assert.deepEqual(homePosition(actor, 1100, false), { x: 2, y: 3 });
  assert.deepEqual(homePosition(actor, 10000, true), { x: 2.5, y: 3 });
  assert.equal(survivalStatus({ ...actor, survival: { light: { lit: true, kind: 'indoor' }, satiety: 80, satiety_state: 'fed' } }, 'night').light, '小屋灯光照亮');
});
