import assert from 'node:assert/strict';
import {findPath} from '../../server/spatial.js';

// Explicit test-controller choice, invoked by a scenario before a service.
// This is never an action wrapper: rejected service calls stay rejected.
export async function walkHomesTo(f,p,target){
  for(let i=0;i<60&&(p.raw.position.x!==target.x||p.raw.position.y!==target.y);i++){
    const path=findPath(p.raw.scene_id,p.raw.position,target);assert.ok(path?.length>1,'chosen destination has an actual legal route');
    const next=path[Math.min(3,path.length-1)];await p.act('move',{x:next.x,y:next.y});await f.until(()=>!p.raw.movement);
  }
  assert.deepEqual(p.raw.position,target);
}
