import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSpace,sameRenderPacket,spriteGeometry,spriteRenderPacket,spriteAttachment,spriteNativeScale,spriteVisualPose,rendererSampling,rendererResolution,isSoftwareRenderer,requiredSpriteImages} from '../src/render-packet.js';
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
 assert.deepEqual(requiredSpriteImages(assets,'plaza',[{...actor,frame:{...actor.frame,image:'/ink/preparation.png'}}]),['/ink/ground.png','/ink/actor.png','/ink/preparation.png']);
});

test('motion sheets prefetch only for visible identities and equipment waits for its exact body sheet',()=>{
 const visible={image:'/ink/one.png',motion_images:['/ink/one-motion.png']},unseen={image:'/ink/two.png',motion_images:['/ink/two-motion.png']};
 const assets={scenes:{plaza:{image:'/ink/ground.png'}},characters:{one:visible,two:unseen}},frame={x:0,y:0,w:48,h:48,anchor:{x:24,y:43},attachments:{hand:{x:34,y:30}}};
 const space=renderSpace({x:9,y:10}),actor=spriteRenderPacket(visible,frame,space);
 assert.deepEqual(requiredSpriteImages(assets,'plaza',[actor]),['/ink/ground.png','/ink/one.png','/ink/one-motion.png']);
 const nextFrame={...frame,image:'/ink/one-motion.png'},attachment=spriteAttachment(visible,nextFrame,'hand');
 const sword=spriteRenderPacket({image:'/ink/sword.png'},frame,space,{attachment});
 assert.equal(sword.attachmentImage,'/ink/one-motion.png');assert.equal(sword.originX,space.x);assert.equal(sword.originY,space.y);
 assert.ok(!requiredSpriteImages(assets,'plaza',[actor,sword]).includes('/ink/two-motion.png'));
 assert.equal(sameRenderPacket(sword,{...sword,attachmentImage:'/ink/one.png'}),false);
});

test('hardware desktop ink supersampling is capped at two while software, phones and legacy art keep native resolution',()=>{
 assert.equal(rendererResolution({render_style:'ink'},1440),2);
 assert.equal(rendererResolution({render_style:'ink'},390),1);
 assert.equal(rendererResolution({render_style:'ink'},3840),2);
 assert.equal(rendererResolution({},1440),1);
 assert.equal(rendererResolution({render_style:'ink'},1440,true),1);
 assert.equal(rendererResolution({render_style:'ink'},3840,true),1);
 assert.equal(rendererResolution({render_style:'ink'},390,true),1);
 assert.equal(rendererResolution({},1440,true),1);
 const before=renderSpace({x:12,y:8});
 rendererResolution({render_style:'ink'},1440);
 assert.deepEqual(renderSpace({x:12,y:8}),before);
});
test('only explicit software rasterizer names lower rendering resolution, never a generic or hidden renderer',()=>{
 for(const description of['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)','llvmpipe (LLVM 15.0.7, 256 bits)','softpipe','Software Rasterizer','Microsoft Basic Render Driver'])assert.equal(isSoftwareRenderer(description),true,description);
 for(const description of['ANGLE (NVIDIA GeForce RTX 4060)','ANGLE (Intel UHD Graphics 630)','Apple M2','AMD Radeon RX 580','WebKit WebGL','Google Inc.','',null,undefined])assert.equal(isSoftwareRenderer(description),false,String(description));
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

test('a shared body pose preserves the ground foot and exactly carries rotated tools through nonuniform recoil',()=>{
  const body={native_scale:.25,anchor_mode:'source'},bodyFrame={w:190,h:210,anchor:{x:83,y:197},attachments:{hand:{x:146,y:119,rotation:.73}}};
  const item={image:'/ink/pickaxe.png',native_scale:.12,anchor_mode:'source',anchor:{x:71,y:132}},itemFrame={x:0,y:0,w:168,h:202};
  const space=renderSpace({x:14.25,y:8.7},{depth:73,screenSize:.8,viewportScale:.5});
  const before=structuredClone(space),pose={x:0,y:0,rotation:.19,scaleX:1.08,scaleY:.93};
  const rotate=([x,y],angle)=>[Math.cos(angle)*x-Math.sin(angle)*y,Math.sin(angle)*x+Math.cos(angle)*y];
  const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} differs from ${b}`);
  for(const facing of['south','north','east','west']){
    const bodyPacket=spriteRenderPacket(body,bodyFrame,space,{facing,pose});
    close(bodyPacket.x,space.x);close(bodyPacket.y,space.y);assert.equal(bodyPacket.depth,space.depth);
    const attachment=spriteAttachment(body,bodyFrame,'hand',facing),packet=spriteRenderPacket(item,itemFrame,space,{facing,attachment,pose});
    const localGrip=[attachment.x-space.anchor[0],attachment.y-space.anchor[1]];
    const transformedGrip=rotate([localGrip[0]*pose.scaleX,localGrip[1]*pose.scaleY],pose.rotation);
    close(packet.x,space.x+transformedGrip[0]*space.scale);close(packet.y,space.y+transformedGrip[1]*space.scale);
    // A point away from the grip detects incorrect rotation/scale order. CSS
    // and the retained Phaser parent/child hierarchy must project it equally.
    const sourceDelta=[13,-21],geometry=spriteGeometry(item,itemFrame,space.anchor,facing,attachment,pose);
    const local=rotate([sourceDelta[0]*(packet.flip?-1:1),sourceDelta[1]],packet.rotation);
    const canvas=rotate([local[0]*packet.poseScaleX,local[1]*packet.poseScaleY],packet.poseRotation);
    const[a,b,c,d]=geometry.matrix;
    close(a*sourceDelta[0]+c*sourceDelta[1],canvas[0]);close(b*sourceDelta[0]+d*sourceDelta[1],canvas[1]);
    close(geometry.offset.x+geometry.domAnchor[0]*geometry.unit,space.anchor[0]+transformedGrip[0]);
    close(geometry.offset.y+geometry.domAnchor[1]*geometry.unit,space.anchor[1]+transformedGrip[1]);
  }
  assert.deepEqual(space,before,'rendering must not change the confirmed world position or depth');
});

test('bounded visual offsets are scaled with the same world plane while ground never inherits actor poses',()=>{
  const definition={image:'/ink/actor.png',native_scale:.2,anchor_mode:'source',anchor:{x:90,y:170}},frame={x:0,y:0,w:180,h:190};
  const pose={x:1.3,y:-.8,rotation:.02,scaleX:1.01,scaleY:1.01};
  for(const scale of[.4,1,2]){
    const space={...renderSpace({x:9,y:8}),scale},packet=spriteRenderPacket(definition,frame,space,{pose});
    assert.ok(Math.abs(packet.x-space.x-pose.x*scale)<1e-9);assert.ok(Math.abs(packet.y-space.y-pose.y*scale)<1e-9);
    const ground=spriteRenderPacket(definition,frame,null,{ground:true,pose});
    assert.deepEqual([ground.x,ground.y,ground.poseRotation,ground.poseScaleX,ground.poseScaleY],[0,0,0,1,1]);
  }
});

test('pose-only changes invalidate retained sprites, while equivalent poses sleep and malformed values cannot poison transforms',()=>{
  const definition={image:'/ink/actor.png'},frame={x:0,y:0,w:48,h:48},space=renderSpace({x:4,y:5});
  const a=spriteRenderPacket(definition,frame,space);
  assert.equal(sameRenderPacket(a,spriteRenderPacket(definition,{...frame},space,{pose:{x:0,y:0,rotation:0,scaleX:1,scaleY:1}})),true);
  for(const pose of[{rotation:.01},{scaleX:.99},{scaleY:1.01},{x:.25},{y:-.25}])assert.equal(sameRenderPacket(a,spriteRenderPacket(definition,frame,space,{pose})),false);
  assert.deepEqual(spriteVisualPose({x:NaN,y:Infinity,rotation:-Infinity,scaleX:0,scaleY:-1}),{x:0,y:0,rotation:0,scaleX:1,scaleY:1});
  const invalid=spriteRenderPacket(definition,frame,space,{pose:{x:NaN,scaleX:Infinity}});
  assert.equal(sameRenderPacket(a,invalid),true);
});
