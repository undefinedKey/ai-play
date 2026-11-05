import assert from 'node:assert/strict';
import { SCENES } from '../../shared/world-layout.js';

// Explicit test-user travel, never an implicit fallback for a failed action.
// Use authored terrain to choose a route; all movement still goes through MCP.
export async function walkFixture(actor, target, until, getRaw = () => actor.raw) {
  const raw = getRaw(), scene = SCENES.find(s => s.id === raw.scene_id);
  assert.ok(scene && !raw.home_presence && !raw.movement);
  const blocked = new Set(scene.blocked.map(p => `${p.x},${p.y}`));
  const key = p => `${p.x},${p.y}`, start = { ...raw.position };
  assert.ok(Number.isInteger(start.x) && Number.isInteger(start.y));
  const queue = [start], previous = new Map([[key(start), null]]);
  for (let i = 0; i < queue.length && !previous.has(key(target)); i++) {
    const p = queue[i];
    for (const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]) {
      const q = {x:p.x+dx,y:p.y+dy}, k = key(q);
      if (q.x<0 || q.y<0 || q.x>=48 || q.y>=32 || blocked.has(k) || previous.has(k)) continue;
      previous.set(k,p); queue.push(q);
    }
  }
  assert.ok(previous.has(key(target)), 'requested test station is reachable');
  const path=[]; for (let p=target; previous.get(key(p)); p=previous.get(key(p))) path.unshift(p);
  // Each explicit command is at most three connected cells.
  for (let i=0;i<path.length;i+=3) {
    const end=path[Math.min(i+2,path.length-1)];
    await actor.act('move',end); await until(()=>!getRaw().movement);
    assert.deepEqual(getRaw().position,end);
  }
}
