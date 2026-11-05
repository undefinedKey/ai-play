import test from 'node:test';
import assert from 'node:assert/strict';
import plaza from '../shared/maps/plaza.json' with { type: 'json' };
import adventure from '../shared/maps/adventure.json' with { type: 'json' };
import ruins from '../shared/maps/ruins.json' with { type: 'json' };
import { RUINS_RULES, RUINS_OBJECTS } from '../shared/ruins-layout.js';
import { compileWorldMaps } from '../shared/tiled-map.js';
import { SCENES, isWalkable, isWorldWalkable, findPath, findWorldPath, movementOptions, recordMovement, publicMovement, publicPath, sameScene } from '../server/spatial.js';

const world = state => ({ state: { ruins: state } });
const exit = RUINS_RULES.exit.position;
const court = RUINS_RULES.runes.interaction_position;
const key = point => `${point.x},${point.y}`;

test('v030 forest and plaza retain their primary portals; separate ruins exit returns to its real forest entrance', () => {
  const [village, forest, ruin] = SCENES;
  assert.deepEqual(village.portal, { position: { x:46,y:13 }, to_scene_id:'adventure', to_position:{ x:11,y:8 } });
  assert.deepEqual(forest.portal, { position: { x:11,y:8 }, to_scene_id:'plaza', to_position:{ x:46,y:13 } });
  assert.deepEqual(ruin.portal, { position: exit, to_scene_id:'adventure', to_position:RUINS_RULES.entrance.position });
  assert.ok(findWorldPath(world({}), 'adventure', forest.portal.position, RUINS_RULES.entrance.position));
  assert.equal(sameScene({scene_id:'ruins'}, {scene_id:'adventure'}), false);
  assert.equal(sameScene({scene_id:'ruins'}, {scene_id:'ruins'}), true);
  const badExit = structuredClone(ruins);
  badExit.layers[1].objects.find(object => object.name === 'portal').x += 32;
  assert.throws(() => compileWorldMaps([plaza,adventure,badExit]), /invalid ruins exit/);
  const badLink = structuredClone(ruins);
  badLink.properties.find(property => property.name === 'destination_scene').value = 'plaza';
  assert.throws(() => compileWorldMaps([plaza,adventure,badLink]), /invalid ruins exit/);
});

test('v030 no perimeter or wall shortcut reaches the court when both entrances are closed', () => {
  const closed = world({});
  assert.ok(findPath('ruins', exit, court), 'static authoring has an all-open connected topology');
  assert.equal(findWorldPath(closed, 'ruins', exit, court), null);
  for (let y=1; y<31; y++) {
    assert.equal(findWorldPath(closed, 'ruins', exit, {x:18,y}), null, `crossing sealed outer wall at y=${y}`);
    assert.equal(findWorldPath(closed, 'ruins', court, {x:35,y}), null, `crossing sealed archive wall at y=${y}`);
  }
  assert.equal(findWorldPath(world({archive_open:true}), 'ruins', exit, RUINS_RULES.relics[0].interaction_position), null, 'inner gate alone cannot bypass the first wall');
});

test('v030 key gate and repaired bridge are independent physical paths; archive remains a second barrier', () => {
  for (const [flag, entrance] of [['gate_open', RUINS_RULES.gate], ['bridge_repaired', RUINS_RULES.bridge]]) {
    const opened = world({[flag]:true});
    const route = findWorldPath(opened, 'ruins', exit, court);
    assert.ok(route?.some(point => key(point) === key(entrance.position)), flag);
    const unused = flag === 'gate_open' ? RUINS_RULES.bridge : RUINS_RULES.gate;
    assert.ok(route.every(point => key(point) !== key(unused.position)), 'only the actually opened passage is used');
    for (const relic of RUINS_RULES.relics) {
      assert.equal(findWorldPath(opened, 'ruins', exit, relic.interaction_position), null);
      const solved = world({[flag]:true,archive_open:true});
      const inside = findWorldPath(solved, 'ruins', exit, relic.interaction_position);
      assert.ok(inside?.some(point => key(point) === key(RUINS_RULES.archive_gate.position)));
      assert.ok(findWorldPath(solved, 'ruins', relic.interaction_position, exit), 'return trip remains physically available');
    }
  }
});

test('v030 fractional edges and findPath shortcut cannot enter a closed gate', () => {
  for (const [flag, gate] of [['gate_open',RUINS_RULES.gate],['bridge_repaired',RUINS_RULES.bridge],['archive_open',RUINS_RULES.archive_gate]]) {
    const left = {x:gate.position.x-1,y:gate.position.y}, halfway = {x:gate.position.x-.5,y:gate.position.y};
    assert.ok(isWalkable('ruins',halfway));
    assert.equal(isWorldWalkable(world({}), 'ruins', halfway), false);
    assert.equal(findWorldPath(world({}), 'ruins', left, halfway), null);
    assert.equal(findWorldPath(world({}), 'ruins', halfway, left), null);
    assert.deepEqual(findWorldPath(world({[flag]:true}), 'ruins', left, halfway), [left,halfway]);
  }
  assert.equal(isWorldWalkable(world({gate_open:true}), 'ruins', {x:16.5,y:24.5}), false, 'no diagonal fractional positions');
});

test('v030 movement choices and public movement use the same current gate state', () => {
  const start = {x:16,y:24}, target = {x:18,y:24}, closed = world({}), opened = world({gate_open:true});
  assert.ok(movementOptions(start,'ruins',closed).candidates.every(candidate => candidate.x<17));
  const legal = movementOptions(start,'ruins',opened).candidates;
  assert.ok(legal.some(candidate => candidate.x>17));
  for (const candidate of legal) assert.deepEqual(candidate.path,findWorldPath(opened,'ruins',start,candidate,{maxSteps:3}));
  const path = findWorldPath(opened,'ruins',start,target), actor = {scene_id:'ruins',position:start};
  recordMovement(actor,path,1000,'walk');
  assert.ok(publicMovement(actor,opened)); assert.equal(publicMovement(actor,closed),null);
  assert.deepEqual(publicPath('ruins',path,opened),path); assert.equal(publicPath('ruins',path,closed),null);
  assert.equal(findWorldPath(opened,'ruins',start,target,{allowed:p=>p.x<17}),null,'caller constraints compose with dynamic gates');
});

test('v030 every authored interaction cell is reachable in its appropriate progression state', () => {
  for (const object of RUINS_OBJECTS) {
    assert.ok(isWalkable('ruins',object.interaction_position), object.id);
    assert.ok(findWorldPath(world({gate_open:true,bridge_repaired:true,archive_open:true}), 'ruins', exit, object.interaction_position), object.id);
  }
  for (const object of [RUINS_RULES.key,RUINS_RULES.gate,RUINS_RULES.bridge]) assert.ok(findWorldPath(world({}), 'ruins', exit, object.interaction_position), `${object.id} is available before either route opens`);
});
