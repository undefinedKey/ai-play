import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {PLAZA_PROPS,PLAZA_SERVICES,PLAZA_COMMUNITY_VENUES,PLAZA_ROADS,PLAZA_LAYOUT_VERSION} from '../shared/plaza-layout.js';
import {SCENES,isWalkable} from '../shared/world-layout.js';
import {plazaPropArtwork,plazaPropIds,communitySeatFacing} from '../src/plaza-state.js';
import {communityUseState} from '../src/community-state.js';
import {renderSpace,spriteRenderPacket} from '../src/render-packet.js';
import {PixelGrid,Q_PALETTE} from '../art/q-world/scenery.mjs';
import {plazaGround} from '../art/q-world/plaza.mjs';
const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('public/pixel-world/manifest.json',root)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function source(def){const f=def.animations.idle.frames[0];return sharp(await readFile(new URL(`public${def.image}`,root))).extract({left:f.x,top:f.y,width:f.w,height:f.h}).ensureAlpha().raw().toBuffer();}

test('v036 plaza-specific artwork leaves every prior non-plaza texture byte-for-byte unchanged',async()=>{
  const baseline=JSON.parse(await readFile(new URL('tests/fixtures/v036-unchanged-textures.json',root)));
  for(const [file,hash] of Object.entries(baseline))assert.equal(digest(await readFile(new URL(`public/pixel-world/${file}`,root))),hash,file);
  assert.equal(manifest.scenes.plaza.geometry_source,'shared/plaza-layout.js');
  assert.equal(SCENES.find(s=>s.id==='plaza').layout_version,PLAZA_LAYOUT_VERSION);
});

test('v036 town buildings have distinct real source pixels and measured front-door anchors',async()=>{
  const hashes=[];
  for(const id of ['cottage','bookshop','tool_shed','supply_shop','kitchen_shelter']){
    const prop=PLAZA_PROPS.find(p=>p.id===id),def=plazaPropArtwork(manifest,'plaza',prop),facility=PLAZA_SERVICES[prop.service_id];
    assert.equal(def.image,'/pixel-world/q_plaza_props.png');assert.equal(def.native_scale,1);
    assert.ok(def.width>=160&&def.width<=192,'building has a room-sized silhouette');
    assert.deepEqual(def.anchor,{x:96,y:150});assert.equal(prop.position.x,facility.interaction_position.x);assert.equal(prop.position.y+1,facility.interaction_position.y);
    assert.ok(isWalkable('plaza',facility.interaction_position));
    const packet=spriteRenderPacket(def,def.animations.idle.frames[0],renderSpace(prop.position,{anchor:[def.anchor.x,def.anchor.y]}));
    assert.equal(packet.x,(prop.position.x+.5)*32);assert.equal(packet.y,(prop.position.y+.5)*32);assert.deepEqual(packet.anchor,[96,150]);
    const pixels=await source(def);assert.ok(pixels.filter((v,i)=>i%4===3&&v===255).length>10000);hashes.push(digest(pixels));
  }
  assert.equal(new Set(hashes).size,5);
});

test('v036 required town props cannot silently fall back to a misleading miniature',()=>{
  for(const id of plazaPropIds){const prop=PLAZA_PROPS.find(p=>p.id===id);assert.ok(plazaPropArtwork(manifest,'plaza',prop));const broken={...manifest,plaza_props:{...manifest.plaza_props,[id]:undefined}};assert.equal(plazaPropArtwork(broken,'plaza',prop),undefined);}
  const forest=SCENES.find(s=>s.id==='adventure');for(const prop of forest.props.filter(p=>p.kind!=='pond'))assert.equal(plazaPropArtwork(manifest,'adventure',prop),manifest.props[prop.kind]);
});

test('v036 directional public seats match the confirmed resident pose without starting activities',async()=>{
  const seatHashes=[];
  for(const facing of ['north','south','east','west'])seatHashes.push(digest(await source(manifest.plaza_services[`community_seat_${facing}`])));
  assert.equal(new Set(seatHashes).size,4);
  for(const venue of PLAZA_COMMUNITY_VENUES)for(const seat of venue.seats.filter(s=>!s.activities.includes('perform'))){
    const a={scene_id:'plaza',status:'active',position:{...seat.position},community_job:{kind:'use',phase:'using',venue_id:venue.id,seat_id:seat.id,activity:'sit',use_started_at:1,ends_at:10000}};
    const before=structuredClone(a),state=communityUseState(a,2000);assert.equal(state.facing,communitySeatFacing(venue,seat));assert.ok(state.using);assert.deepEqual(a,before);
    const approaching={...a,position:{x:24,y:16},community_job:{...a.community_job,phase:'approaching',use_started_at:null}};assert.equal(communityUseState(approaching,2000).using,false);
  }
});

test('v036 ground is deterministic, opaque and keeps three-tile streets and two-tile branches',()=>{
  const a=plazaGround(PixelGrid,Q_PALETTE),b=plazaGround(PixelGrid,Q_PALETTE);assert.equal(digest(a.data),digest(b.data));assert.equal(a.width,1536);assert.equal(a.height,1024);
  assert.ok(a.data.every((v,i)=>i%4!==3||v===255));assert.ok(PLAZA_ROADS.every(r=>[2,3].includes(r.width)));
  // Free main-ring segment: the full street remains visible either side of its
  // center. This catches accidentally returning to the old one-tile line art.
  for(const x of [16.5*32-40,16.5*32,16.5*32+40]){const i=(13*32*a.width+x)*4;assert.ok(a.data[i]>180&&a.data[i+1]>160,'broad ring surface');}
  for(const id of ['home','reading','play','tools','supply','kitchen','market','adventure','journey'])assert.ok(isWalkable('plaza',PLAZA_SERVICES[id].interaction_position),id);
});
