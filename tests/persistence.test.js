import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { World } from '../server/world.js';

test('心跳和模拟变更合并落盘，关闭刷新，关键授权立即持久化', t => {
  const directory = mkdtempSync(join(tmpdir(), 'plaza-checkpoint-'));
  const dbPath = join(directory, 'world.sqlite');
  let now = 1000000;
  const world = new World({ dbPath, now: () => now });
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  let closed = false;
  t.after(() => { if (!closed) world.close(); readDb.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = () => JSON.parse(readDb.prepare('SELECT payload FROM world_state WHERE id=1').get().payload);
  const a = world.createAgent({ name: '存档测试' });
  const controller = world.createController(a.agent_id), auth = world.authenticate(controller.token);
  world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id });
  const joined = world.callTool(auth, 'join_world');
  const previousContact = read().agents[a.agent_id].last_contact_at;
  for (let i = 0; i < 20; i++) { now += 100; world.callTool(auth, 'observe', joined); }
  assert.equal(read().agents[a.agent_id].last_contact_at, previousContact);
  assert.ok(world.saveTimer);
  world.ownerControl(a.agent_id, 'pause');
  assert.equal(read().agents[a.agent_id].run.status, 'paused');
  assert.equal(world.saveTimer, null);
  world.state.agents[a.agent_id].position = { x: 3, y: 5 }; world.commit({ deferred: true });
  world.close(); closed = true;
  assert.deepEqual(read().agents[a.agent_id].position, { x: 3, y: 5 });
});
