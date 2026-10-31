import test from 'node:test';
import assert from 'node:assert/strict';
import {fireArtwork,artworkAnchor,resourceArtwork} from '../src/scene-art.js';

test('fire uses a separately authored extinguished sprite without sampling the flame sheet',()=>{
  const flame={image:'/ink/fire.png',native_scale:.25,anchor:{x:64,y:172}},ashes={image:'/ink/ashes.png',native_scale:.25,anchor:{x:64,y:36}};
  const assets={effects:{campfire:flame,campfire_ashes:ashes}};
  assert.equal(fireArtwork(assets,true),flame);assert.equal(fireArtwork(assets,false),ashes);
  assert.deepEqual(artworkAnchor(flame),[16,43]);assert.deepEqual(artworkAnchor(ashes),[16,9]);
});
test('legacy extinguished fire is cropped relative to its frame and keeps its true foot',()=>{
  const source={image:'/pixel/fire.png',anchor:{x:16,y:43},animations:{idle:{frames:[{x:32,y:48,w:32,h:48}]}}};
  const logs=fireArtwork({effects:{campfire:source}},false);
  assert.deepEqual(logs.animations.idle.frames[0],{x:32,y:86,w:32,h:10,anchor:{x:16,y:5}});
  assert.deepEqual(artworkAnchor(logs),[16,5]);
  assert.equal(source.animations.idle.frames[0].h,48);
});
test('resource icons multiply native artwork scale, and dedicated tree stages avoid scaling mature trees',()=>{
  const assets={items:{item_wood:{native_scale:.25},item_grass:{native_scale:.125}},wilderness:{pine:{native_scale:.5},tree_sapling:{image:'/ink/sapling.png',native_scale:.25}}};
  assert.equal(resourceArtwork(assets,{kind:'branches'}).native_scale,.275);
  assert.equal(resourceArtwork(assets,{kind:'grass'}).native_scale,.15625);
  const sapling=resourceArtwork(assets,{kind:'tree',ecology:{stage:'sapling'}});
  assert.equal(sapling.native_scale,.25);assert.equal(sapling.image,'/ink/sapling.png');
  assert.equal(resourceArtwork(assets,{kind:'tree',ecology:{stage:'young'}}).native_scale,.29);
  assert.equal(resourceArtwork(assets,{kind:'tree',ecology:{stage:'sapling'}}),sapling);
});
