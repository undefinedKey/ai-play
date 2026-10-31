import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSpace,sameRenderPacket,spriteGeometry,spriteRenderPacket,spriteAttachment,spriteNativeScale,rendererSampling,rendererResolution,requiredSpriteImages} from '../src/render-packet.js';
test('native foot coordinates and crowded offsets retain screen-space separation at desktop/mobile edges',()=>{
  assert.deepEqual(renderSpace({x:5,y:6},{depth:160,anchor:[64,120]}),{x:176,y:208,depth:160,anchor:[64,120],alpha:1,scale:1});
  for(const viewportScale of[390/1536,1,1006/1536]){
    const middle=renderSpace({x:12,y:8},{offset:{x:22,y:4},viewportScale});
    assert.equal(Math.round((middle.x-400)*viewportScale),22);assert.equal(Math.round((middle.y-272)*viewportScale),4);
    const left=renderSpace({x:0,y:8},{offset:{x:-40},viewportScale});assert.ok(left.x*viewportScale>=12-1e-8);
    const right=renderSpace({x:47,y:8},{offset:{x:40},viewportScale});assert.ok(right.x*viewportScale<=1536*viewportScale-12+1e-8);
  }
});
test('high-resolution source feet agree between CSS fallback and Phaser, including flipped asymmetric padding',()=>{
  const definition={image:'/ink/body.png',native_scale:.25,anchor_mode:'source',anchor:{x:90,y:172}},frame={x:0,y:0,w:192,h:192};
  const space=renderSpace({x:5,y:6},{anchor:[24,43],depth:160});
  for(const facing of['south','west']){
    const geometry=spriteGeometry(definition,frame,space.anchor,facing),packet=spriteRenderPacket(definition,frame,space,{facing});
    const renderedFoot=(facing==='west'?frame.w-definition.anchor.x:definition.anchor.x)*geometry.unit;
    assert.equal(geometry.offset.x+geometry.domAnchor[0]*geometry.unit,space.anchor[0]);
    assert.equal(geometry.offset.y+definition.anchor.y*geometry.unit,space.anchor[1]);
    assert.equal(packet.anchor[0]*packet.scale,renderedFoot);
    assert.equal(packet.x,176);assert.equal(packet.y,208);assert.equal(packet.scale,.25);
  }
  const paddedFrame={...frame,anchor:{x:96,y:180}};
  assert.deepEqual(spriteGeometry(definition,paddedFrame,space.anchor).offset,{x:0,y:-2});
  assert.equal(sameRenderPacket(spriteRenderPacket(definition,frame,space),spriteRenderPacket(definition,paddedFrame,space)),false);
});
test('independent held cutouts follow measured hand, chest and hair anchors in every facing',()=>{
 const body={native_scale:.25,anchor_mode:'source'},frame={w:180,h:200,anchor:{x:90,y:190},attachments:{hand:{x:150,y:110,rotation:.5}}};
 const item={image:'/ink/tools.png',native_scale:.1,anchor_mode:'source',anchor:{x:80,y:120}},itemFrame={x:0,y:0,w:150,h:200};
 const space=renderSpace({x:5,y:6});
 for(const facing of['east','west']){
  const attachment=spriteAttachment(body,frame,'hand',facing),packet=spriteRenderPacket(item,itemFrame,space,{facing,attachment}),geometry=spriteGeometry(item,itemFrame,space.anchor,facing,attachment);
  assert.equal(packet.x,space.x+(facing==='west'?-15:15));assert.equal(packet.y,space.y-20);
  assert.equal(geometry.offset.x+geometry.domAnchor[0]*geometry.unit,attachment.x);
  assert.equal(geometry.offset.y+geometry.domAnchor[1]*geometry.unit,attachment.y);
  assert.equal(packet.rotation,facing==='west'?-.5:.5);
 }
 assert.equal(spriteNativeScale(body,{...frame,native_scale:.1}),.1);
});
test('only visible packet textures are requested, including a later independent source-frame image',()=>{
 const assets={scenes:{plaza:{image:'/ink/ground.png'}},characters:{unused:{image:'/ink/not-here.png'}},items:{unused:{image:'/ink/inventory.png'}}};
 const actor={definition:{image:'/ink/actor.png'},frame:{x:0,y:0,w:48,h:48}};
 assert.deepEqual(requiredSpriteImages(assets,'plaza',[actor,actor]),['/ink/ground.png','/ink/actor.png']);
 assert.deepEqual(requiredSpriteImages(assets,'plaza',[{...actor,frame:{...actor.frame,image:'/ink/preparation.png'}}]),['/ink/ground.png','/ink/preparation.png']);
});

test('desktop ink supersampling is capped at two while phones and legacy art keep one native world buffer',()=>{
 assert.equal(rendererResolution({render_style:'ink'},1440),2);
 assert.equal(rendererResolution({render_style:'ink'},390),1);
 assert.equal(rendererResolution({render_style:'ink'},3840),2);
 assert.equal(rendererResolution({},1440),1);
 const before=renderSpace({x:12,y:8});
 rendererResolution({render_style:'ink'},1440);
 assert.deepEqual(renderSpace({x:12,y:8}),before);
});
test('legacy layered art and ground packets retain their positions while ink atlases use smooth sampling',()=>{
  const frame={x:0,y:0,w:48,h:48},definition={image:'/pixel/body.png'},space=renderSpace({x:2,y:3});
  assert.deepEqual(spriteGeometry(definition,frame,space.anchor).offset,{x:0,y:0});
  assert.equal(spriteRenderPacket(definition,frame,space,{layer:.03}).depth,.03);
  const ground=spriteRenderPacket({image:'/ink/ground.png'},{x:0,y:0,w:1536,h:1024},null,{ground:true});
  assert.deepEqual([ground.x,ground.y,ground.scale,ground.depth,...ground.anchor],[0,0,1,-100,0,0]);
  assert.equal(spriteRenderPacket({image:'/ink/ground@2x.png',native_scale:.5},{x:0,y:0,w:3072,h:2048},null,{ground:true}).scale,.5);
  assert.deepEqual(rendererSampling({render_style:'ink'}),{pixelArt:false,antialias:true,roundPixels:false});
  assert.deepEqual(rendererSampling({}),{pixelArt:true,antialias:false,roundPixels:false});
});
test('unchanged packets sleep, while actual position, frame, depth and equipment changes redraw',()=>{
  const definition={image:'/pixel-world/wanderer_1.png'},frame={x:0,y:0,w:48,h:48};
  const a={definition,frame,x:400,y:272,depth:181,scale:1,alpha:1,flip:false,action:'idle',anchor:[24,43]};
  assert.equal(sameRenderPacket(a,{...a,frame:{...frame},anchor:[24,43]}),true);
  for(const patch of[{x:401},{frame:{...frame,x:48}},{depth:182},{definition:{image:'/pixel-world/wood_sword.png'}},{alpha:.3},{flip:true}])assert.equal(sameRenderPacket(a,{...a,...patch}),false);
});
