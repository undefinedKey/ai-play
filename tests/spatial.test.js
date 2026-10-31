import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.js';
import { WORLD_MAP, MAX_MOVE, isPositionInBounds, movementOptions, stepToward, isWalkable, findPath } from '../server/spatial.js';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function player(t) {
  const world = new World({ now: () => 1000000, actionIntervalMs: 0 });
  t.after(() => world.close());
  const a = world.createAgent({ name: '边界测试' }), controller = world.createController(a.agent_id);
  world.ownerControl(a.agent_id, 'start');
  const auth = world.authenticate(controller.token), joined = world.callTool(auth, 'join_world');
  const session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
  const observe = () => world.callTool(auth, 'observe', session);
  const act = payload => world.callTool(auth, 'act', { ...session, action_id: observe().next_action_id, type: 'move', payload });
  return { world, id: a.agent_id, observe, act };
}

test('每个地图格的候选落点都在边界内、非原地、唯一且不超曼哈顿步长', () => {
  for (let x = 0; x < WORLD_MAP.width; x++) for (let y = 0; y < WORLD_MAP.height; y++) {
    if (!isWalkable('plaza', {x,y})) continue;
    const origin = { x, y }, options = movementOptions(origin);
    assert.deepEqual(options.map, WORLD_MAP); assert.equal(options.max_step, MAX_MOVE);
    assert.ok(options.candidates.length >= 1 && options.candidates.length <= 8);
    assert.equal(new Set(options.candidates.map(p => `${p.x},${p.y}`)).size, options.candidates.length);
    for (const point of options.candidates) {
      assert.ok(isPositionInBounds(point)); assert.ok(distance(origin, point) > 0 && distance(origin, point) <= MAX_MOVE);
    }
  }
});

test('服务端路径步进在极端目标下也不会离开地图或越过单步长度', () => {
  for (const origin of [{ x: 0, y: 0 }, { x: 23, y: 15 }, { x: 11, y: 8 }]) {
    for (const target of [{ x: -100, y: 200 }, { x: 200, y: -100 }, { x: 23, y: 15 }, { x: 0, y: 0 }]) {
      const point = stepToward(origin, target);
      assert.ok(isPositionInBounds(point)); assert.ok(distance(origin, point) <= 1);
    }
  }
});

test('实际观察给出可执行候选；规则、公开地图与观察使用一致尺寸且不共享可变引用', t => {
  const p = player(t), rules = p.world.getRules();
  assert.deepEqual(rules.adventure.map, WORLD_MAP);
  assert.deepEqual(p.world.publicSnapshot().adventure.map, WORLD_MAP);
  for (const origin of [{ x: 0, y: 0 }, { x: 23, y: 15 }, { x: 11, y: 8 }]) {
    p.world.agent(p.id).position = origin;
    const observation = p.observe();
    assert.deepEqual(observation.adventure.map, observation.movement.map);
    for (const point of observation.movement.candidates) {
      p.world.agent(p.id).position = { ...origin };
      const result = p.act(point); assert.equal(result.status, 'applied'); assert.deepEqual(result.position, {x:point.x,y:point.y}); assert.deepEqual(result.path,point.path); assert.deepEqual(result.path,findPath('plaza',origin,point));
    }
    observation.movement.map.width = 999; observation.adventure.map.width = 999;
    assert.equal(p.observe().movement.map.width, WORLD_MAP.width);
  }
  rules.adventure.map.height = 999;
  assert.equal(p.world.getRules().adventure.map.height, WORLD_MAP.height);
});

test('第三方客户端越界、超步、非法坐标仍被权威校验拒绝，并返回可用纠错候选', t => {
  const p = player(t), origin = { x: 11, y: 8 };
  p.world.agent(p.id).position = { ...origin };
  for (const payload of [{ x: 30, y: 20 }, { x: -1, y: 8 }, { x: 11, y: 16 }, { x: 15, y: 8 }, { x: 13, y: 10 }, { x: 11.5, y: 8 }, { x: '12', y: 8 }, { x: null, y: 8 }]) {
    const result = p.act(payload);
    assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'INVALID_ACTION');
    assert.deepEqual(result.error.movement, movementOptions(origin));
    assert.deepEqual(p.world.agent(p.id).position, origin);
  }
  assert.equal(p.act({ x: 13, y: 9 }).status, 'applied', '合法精细移动不局限于候选列表');
});

test('重启修复旧持久化非法位置并保存，保留成长和身份凭证', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-spatial-')), dbPath = join(directory, 'world.sqlite');
  let world;
  try {
    world = new World({ dbPath });
    const agent = world.createAgent({ name: '旧角色' }), controller = world.createController(agent.agent_id);
    world.agent(agent.agent_id).position = { x: 99, y: -4 };
    world.agent(agent.agent_id).adventure.gold = 19;
    world.state.room.width = 999; world.close(); world = undefined;
    world = new World({ dbPath });
    assert.deepEqual(world.agent(agent.agent_id).position, { x: 23, y: 0 });
    assert.equal(world.agent(agent.agent_id).adventure.gold, 19);
    assert.equal(world.authenticate(controller.token).agent_id, agent.agent_id);
    assert.equal(world.state.room.width, WORLD_MAP.width);
    const saved = JSON.parse(world.db.prepare('SELECT payload FROM world_state WHERE id=1').get().payload);
    assert.deepEqual(saved.agents[agent.agent_id].position, { x: 23, y: 0 });
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});
