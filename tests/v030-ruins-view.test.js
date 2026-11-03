import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUINS_RULES, RUINS_OBJECTS, RUINS_ITEMS } from '../shared/ruins-layout.js';
import { sceneDefinition } from '../shared/world-layout.js';
import { ruinsObjectState, ruinsArtwork, ruinsExecution } from '../src/ruins-state.js';
import { observerExecution, observerActionResult } from '../src/world-services-state.js';
import { actorScene, sceneActors } from '../src/scene-state.js';
import { terrainDrawing, wildernessGround } from '../src/wilderness-art.js';
import { souvenirNames } from '../src/home-state.js';

const object = id => RUINS_OBJECTS.find(item => item.id === id);
const initial = () => ({ gate: { open: false }, bridge: { repaired: false, job: null }, runes: { solved: false, orientations: ['leaf', 'leaf', 'leaf'] }, key: { ...object('key_cache'), claimed_by: null }, relics: RUINS_RULES.relics.map(item => ({ ...item, claimed_by: null })), objects: RUINS_OBJECTS });

test('v030 public ruin states control actual gate bridge dial and relic atlas frames', () => {
  const ruins = initial();
  const visual = id => ruinsArtwork(object(id), ruinsObjectState(ruins, object(id), 2000));
  for (const [id, mutate] of [
    ['main_gate', () => { ruins.gate.open = true; }],
    ['archive_gate', () => { ruins.runes.solved = true; }],
    ['broken_bridge', () => { ruins.bridge.repaired = true; }],
    ['dial_west', () => { ruins.runes.orientations[0] = 'moon'; }],
    ['relic_leaf', () => { ruins.relics[0].claimed_by = 'real-actor'; }],
    ['key_cache', () => { ruins.key.claimed_by = 'real-actor'; }],
  ]) {
    const before = visual(id); mutate(); const after = visual(id);
    assert.notDeepEqual(before.animations.idle.frames, after.animations.idle.frames, id);
    assert.match(after.image, /ruins-mechanisms\.svg/);
  }
  assert.equal(ruinsObjectState(ruins, object('relic_leaf'), 2000).claimant, 'real-actor');
  assert.equal(ruinsObjectState(null, object('main_gate'), 2000).key, 'unknown');
});

test('v030 repair clock cannot grant passage and observation does not mutate public state', () => {
  const ruins = initial(); ruins.bridge.job = { agent_id: 'a', started_at: 1000, ends_at: 13000 };
  const before = structuredClone(ruins);
  assert.equal(ruinsObjectState(ruins, object('broken_bridge'), 7000).progress, .5);
  const overdue = ruinsObjectState(ruins, object('broken_bridge'), 20000);
  assert.equal(overdue.key, 'repairing'); assert.match(overdue.label, /等待确认/); assert.ok(overdue.progress < 1);
  assert.deepEqual(ruins, before);
  const agent = { status: 'active', scene_id: 'ruins', ruins_job: { intent: 'repair', phase: 'repairing', scene_id: 'ruins', object_id: 'broken_bridge', ends_at: 13000 } };
  assert.match(observerExecution({ ruins }, agent, 20000).text, /等待服务器确认/);
  assert.equal(ruinsExecution({ ruins }, { ...agent, scene_id: 'adventure' }, 10000), null);
  assert.equal(observerExecution({ ruins }, { ...agent, status: 'paused' }, 10000).kind, 'paused');
  assert.equal(observerActionResult({action_status:{type:'ruins',status:'rejected',at:1000,error_code:'UNREACHABLE'}}).text,'遗迹操作未执行 · 道路尚未接通');
});

test('v030 independent ruin scene neither copies outdoor actors nor infers a home occupant outdoors', () => {
  const agents = [
    { agent_id: 'ruin', status: 'active', scene_id: 'ruins' },
    { agent_id: 'wood', status: 'active', scene_id: 'adventure' },
    { agent_id: 'plaza', status: 'paused', scene_id: 'plaza' },
    { agent_id: 'house', status: 'active', scene_id: 'ruins', home_presence: { home_id: 'house' } },
  ];
  assert.deepEqual(sceneActors(agents, 'ruins').map(agent => agent.agent_id), ['ruin']);
  assert.equal(actorScene(agents[3]), null);
  assert.equal(wildernessGround('ruins').trails.length, 0);
  assert.notDeepEqual(terrainDrawing('ruins'), terrainDrawing('adventure'));
  const walls = terrainDrawing('ruins').fills.filter(paint => paint.color === '#8f8b72');
  assert.equal(walls.length, sceneDefinition('ruins').blocked.length);
  assert.ok(walls.some(paint => paint.points[0].x === 17 * 32 && paint.points[0].y === 10 * 32));
  assert.ok(!walls.some(paint => paint.points[0].x === 17 * 32 && paint.points[0].y === 9 * 32), 'bridge passage has no permanent painted wall');
});

test('v030 three genuine relics have home display names and original distinct shapes', () => {
  const source = readFileSync(new URL('../src/home-art.jsx', import.meta.url), 'utf8');
  for (const item of RUINS_ITEMS.filter(item => item.kind === 'relic')) {
    assert.equal(souvenirNames[item.id], item.name); assert.ok(source.includes(`item==='${item.id}'`));
  }
  const atlas = readFileSync(new URL('../public/pixel-world/ruins-mechanisms.svg', import.meta.url), 'utf8');
  assert.match(atlas, /Original ink-and-paper mechanism atlas/);
});
