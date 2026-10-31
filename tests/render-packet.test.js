import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSpace,sameRenderPacket} from '../src/render-packet.js';
test('native foot coordinates and crowded offsets retain screen-space separation at desktop/mobile edges',()=>{
  assert.deepEqual(renderSpace({x:5,y:6},{depth:160,anchor:[64,120]}),{x:176,y:208,depth:160,anchor:[64,120],alpha:1,scale:1});
  for(const viewportScale of[390/768,1,1006/768]){
    const middle=renderSpace({x:12,y:8},{offset:{x:22,y:4},viewportScale});
    assert.equal(Math.round((middle.x-400)*viewportScale),22);assert.equal(Math.round((middle.y-272)*viewportScale),4);
    const left=renderSpace({x:0,y:8},{offset:{x:-40},viewportScale});assert.ok(left.x*viewportScale>=12-1e-8);
    const right=renderSpace({x:23,y:8},{offset:{x:40},viewportScale});assert.ok(right.x*viewportScale<=768*viewportScale-12+1e-8);
  }
});
test('unchanged packets sleep, while actual position, frame, depth and equipment changes redraw',()=>{
  const definition={image:'/pixel-world/wanderer_1.png'},frame={x:0,y:0,w:48,h:48};
  const a={definition,frame,x:400,y:272,depth:181,scale:1,alpha:1,flip:false,action:'idle',anchor:[24,43]};
  assert.equal(sameRenderPacket(a,{...a,frame:{...frame},anchor:[24,43]}),true);
  for(const patch of[{x:401},{frame:{...frame,x:48}},{depth:182},{definition:{image:'/pixel-world/wood_sword.png'}},{alpha:.3},{flip:true}])assert.equal(sameRenderPacket(a,{...a,...patch}),false);
});
