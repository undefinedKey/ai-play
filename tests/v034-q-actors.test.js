import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {buildActorAssets,Q_ACTOR_IDS,Q_MONSTER_IDS,Q_EQUIPMENT_IDS} from '../art/q-world/actors.mjs';
import {Q_ACTOR_ACTIONS,Q_DIRECTIONS,qActorPose,qCharacterPixels,qAccessoryPixels,qGearPixels,qMonsterPixels} from '../src/q-actor-art.js';
import {actorVisualPose,STILL_POSE} from '../src/actor-motion.js';
import {animationFrame,actionFrame,actionPose,characterAction} from '../src/pixel-state.js';
import {renderSpace,spriteGeometry,spriteRenderPacket,rendererSampling,rendererResolution} from '../src/render-packet.js';

let dir,assets;
test.before(async()=>{dir=await mkdtemp(join(tmpdir(),'plaza-q-actors-'));assets=await buildActorAssets({outputDir:dir});});
test.after(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
const signature=pixels=>JSON.stringify(pixels);

test('all eight saved identities have original opaque integer pixel drawings and genuinely different front/back/side views',()=>{
  const identities=[];
  for(const id of Q_ACTOR_IDS){
    const directions=Q_DIRECTIONS.map(direction=>qCharacterPixels(id,{action:'idle',direction,frame:0}));
    assert.equal(new Set(directions.map(signature)).size,3,id);
    assert.ok(directions[0].some(p=>p.part==='eyes'));assert.ok(!directions[1].some(p=>p.part==='eyes'),'a back view must not retain front eyes');
    identities.push(signature(directions[0]));
    for(const action of Q_ACTOR_ACTIONS)for(const direction of Q_DIRECTIONS)for(let frame=0;frame<4;frame++){
      const pixels=qCharacterPixels(id,{action,direction,frame});
      for(const p of pixels){assert.ok([p.x,p.y,p.w,p.h].every(Number.isInteger));assert.ok(p.x>=1&&p.y>=1&&p.x+p.w<=47&&p.y+p.h<=47,`${id}/${action}/${direction} gutter`);assert.match(p.color,/^#[a-f\d]{6}$/i);}
    }
  }
  assert.equal(new Set(identities).size,8);
  const feiyu=qCharacterPixels('wanderer_3',{action:'idle',direction:'east'});
  assert.ok(feiyu.some(p=>p.part==='hair'&&p.color==='#294b70'&&p.y===3));
  assert.ok(feiyu.some(p=>p.color==='#36a3af'));
  assert.deepEqual(qCharacterPixels('wanderer_3',{action:'idle',direction:'east'}),feiyu,'reload does not reroll identity');
});

test('walking and running change actual legs/arms in every direction; three distinct monsters have four real gait drawings',()=>{
  for(const id of Q_ACTOR_IDS)for(const action of ['walk','run'])for(const direction of Q_DIRECTIONS){
    const poses=[0,1,2,3].map(frame=>qCharacterPixels(id,{action,direction,frame}));
    assert.equal(new Set(poses.map(signature)).size,4,`${id}/${action}/${direction}`);
    assert.ok(new Set(poses.map(p=>signature(p.filter(px=>px.part.includes('leg'))))).size>=3,`${id}/${action}/${direction}: legs`);
    assert.ok(new Set(poses.map(p=>signature(p.filter(px=>px.part.includes('arm'))))).size>=3,`${id}/${action}/${direction}: arms`);
  }
  for(const id of Q_MONSTER_IDS)for(const direction of Q_DIRECTIONS){
    assert.equal(new Set([0,1,2,3].map(frame=>signature(qMonsterPixels(id,{action:'walk',direction,frame})))).size,4,`${id}/${direction}`);
    assert.ok(qMonsterPixels(id,{action:'idle',direction:'south'}).some(p=>p.part==='eyes'));
    assert.ok(!qMonsterPixels(id,{action:'idle',direction:'north'}).some(p=>p.part==='eyes'));
  }
  assert.equal(new Set(Q_MONSTER_IDS.map(id=>signature(qMonsterPixels(id,{action:'idle',direction:'south'})))).size,3);
});

test('generated PNGs are crisp and every frame has transparent gutters, bounded source anchors and matching atlas metadata',async()=>{
  for(const section of Object.values(assets))for(const definition of Object.values(section)){
    assert.equal(definition.render_style,'q-pixel');assert.equal(definition.native_scale,1);assert.equal(definition.anchor_mode,'source');assert.deepEqual(definition.anchor,{x:24,y:43});
    const filename=definition.image.split('/').at(-1),meta=JSON.parse(await readFile(join(dir,filename.replace('.png','.atlas.json')),'utf8'));
    const {data,info}=await sharp(join(dir,filename)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,definition.sheet_width);assert.equal(info.height,definition.sheet_height);assert.equal(meta.meta.render_style,'q-pixel');
    assert.deepEqual(meta.meta.size,{w:info.width,h:info.height});
    let opaque=0;
    for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
      const alpha=data[(y*info.width+x)*4+3];assert.ok(alpha===0||alpha===255,'no resampled antialiased edges');
      if(x%48===0||x%48===47||y%48===0||y%48===47)assert.equal(alpha,0,`${filename} transparent frame gutter at ${x},${y}`);
      opaque+=alpha===255?1:0;
    }
    assert.ok(opaque>0,filename);
    for(const animation of Object.values(definition.animations))for(const frame of animation.frames){assert.deepEqual(frame.anchor,{x:24,y:43});assert.equal(frame.w,48);assert.equal(frame.h,48);assert.ok(frame.x+48<=info.width&&frame.y+48<=info.height);}
  }
});

test('every real equipment, tool and accessory frame stays registered to the same body hand without a second attachment transform',()=>{
  const body=assets.characters.wanderer_3,space=renderSpace({x:11,y:10});
  for(const section of [assets.equipment,assets.tools,assets.accessories])for(const gear of Object.values(section))for(const action of Q_ACTOR_ACTIONS)for(const facing of [...Q_DIRECTIONS,'west'])for(let index=0;index<4;index++){
    assert.equal(gear.overlay_mode,'registered-canvas');
    const b=actionFrame(body,action,facing,index),g=actionFrame(gear,action,facing,index);
    assert.deepEqual(g.attachments,b.attachments);
    const bp=spriteRenderPacket(body,b,space,{facing}),gp=spriteRenderPacket(gear,g,space,{facing});
    assert.deepEqual([bp.x,bp.y,bp.anchor,bp.scale],[gp.x,gp.y,gp.anchor,gp.scale]);
    assert.equal(bp.flip,facing==='west');
    assert.deepEqual(spriteGeometry(body,b,[24,43],facing).target,[24,43]);
  }
  assert.deepEqual(Object.keys(assets.equipment),Q_EQUIPMENT_IDS);
  assert.deepEqual(qGearPixels('unowned_or_unknown',{action:'attack',direction:'east',frame:2}),[]);
  assert.ok(!qCharacterPixels('wanderer_3',{action:'attack',direction:'east',frame:2}).some(p=>['weapon','tool'].includes(p.part)),'base actor never invents a sword');
  assert.ok(qGearPixels('wooden_shield',{action:'idle'}).every(p=>p.part==='shield'));
  assert.notEqual(signature(qGearPixels('iron_armor',{})),signature(qGearPixels('heavy_armor',{})));
  assert.notEqual(signature(qGearPixels('axe',{action:'gather',frame:0})),signature(qGearPixels('pickaxe',{action:'gather',frame:0})));
  assert.notEqual(signature(qGearPixels('hoe',{},1)),signature(qGearPixels('hoe',{},3)));
});

test('Q frames preserve real attack receipts, bounded damage, stale movement and exact world positions',()=>{
  const definition=assets.characters.wanderer_3;
  const actor={agent_id:'actual',scene_id:'plaza',status:'active',position:{x:11,y:10},position_at:1000,facing:'east',action:{action_id:'one',scene_id:'plaza',type:'attack',facing:'east',started_at:1000,impact_at:1200,ends_at:1800,outcome:null}};
  const saved=structuredClone(actor),opts={definition,facing:'east'};
  assert.equal(actionPose(actor,'attack',1250).frame,1,'a passed impact deadline is still anticipation');
  assert.equal(actorVisualPose(actor,'attack',1250,opts).x,-1);
  const hit={...actor,action:{...actor.action,outcome:'hit',resolved_at:1300}};
  assert.equal(actionPose(hit,'attack',1320).frame,2);assert.equal(actorVisualPose(hit,'attack',1320,opts).x,3);
  assert.deepEqual(actorVisualPose(hit,'attack',1800,opts),STILL_POSE);
  assert.deepEqual(actorVisualPose(hit,'attack',1320,{...opts,enabled:false}),STILL_POSE);
  const hurt={...actor,hurt:{action_id:'real-hit',damage:5,started_at:1300,ends_at:1600}};
  assert.equal(actorVisualPose(hurt,'hurt',1300,opts).x,-3);assert.deepEqual(actorVisualPose(hurt,'hurt',1600,opts),STILL_POSE);
  assert.deepEqual(actorVisualPose({...hurt,hurt:{...hurt.hurt,damage:0}},'hurt',1400,opts),STILL_POSE);
  const moving={...actor,action:null,movement:{version:2,movement_id:'one',scene_id:'plaza',started_at:1000,ends_at:3000,speed:2,mode:'walk',path:[{x:11,y:10},{x:15,y:10}]}};
  assert.equal(characterAction(moving,[],1100),'walk');assert.equal(characterAction(moving,[],1500),'idle');
  for(const facing of ['north','south','east','west']){const pose=actorVisualPose(hit,'attack',1320,{...opts,facing}),space=renderSpace(actor.position),frame=actionFrame(definition,'attack',facing,2),packet=spriteRenderPacket(definition,frame,space,{facing,pose});assert.deepEqual([packet.originX,packet.originY],[space.x,space.y]);assert.equal(packet.poseRotation,0);assert.equal(packet.poseScaleX,1);assert.ok([pose.x,pose.y].every(Number.isInteger));}
  assert.deepEqual(actor,saved);
  assert.deepEqual(rendererSampling({render_style:'q-pixel'}),{pixelArt:true,antialias:false,roundPixels:false});assert.equal(rendererResolution({render_style:'q-pixel'},1536,false),1);
});

test('seated furniture and four bed orientations expose exact hips while source foot remains fixed',()=>{
  for(const direction of [...Q_DIRECTIONS,'west'])for(const action of ['sit','read','write','rest','sleep','home_eat']){
    const frame=animationFrame(assets.characters.wanderer_3,action,0,true,direction),pose=qActorPose(action,direction,0);
    assert.deepEqual(frame.anchor,{x:24,y:43});
    assert.deepEqual(pose.hip,{x:24,y:action==='sleep'&&direction==='north'?12:36});
    assert.ok(!qGearPixels('iron_sword',{action,direction,frame:0}).length,'resting hands do not brandish a sword');
    assert.ok(qAccessoryPixels('scarf',{action,direction:direction==='west'?'east':direction}).every(p=>p.y+p.h<=47));
  }
  const north=qCharacterPixels('wanderer_3',{action:'sleep',direction:'north'}),south=qCharacterPixels('wanderer_3',{action:'sleep',direction:'south'});
  assert.deepEqual(north,south.map(p=>({...p,x:48-p.x-p.w,y:48-p.y-p.h})));assert.ok(qCharacterPixels('wanderer_3',{action:'read',direction:'south'}).some(p=>p.part==='book'));
});
