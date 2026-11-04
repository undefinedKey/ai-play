import test from 'node:test';
import assert from 'node:assert/strict';
import {HOME_ARCHIVE_ART,HOME_PIXEL_ART} from '../src/home-pixel-manifest.js';
import {homeCottagePixels,homeFurniturePixels,homeRoomPixels,homeSouvenirPixels} from '../src/home-pixel-drawing.js';
import {homePixelAction,homePixelContactHeight} from '../src/home-pixel-pose.js';
import {homeFurnitureLayout,homeRoomFoot,homeActorDepth} from '../src/home-pixel-layout.js';
import {homeActorProxy,homeSeatAnchor,homeUsePresentationStyle} from '../src/home-state.js';
import {qActorPose,qCharacterPixels} from '../src/q-actor-art.js';

function validPixels(drawing){
  assert.ok(drawing.rects.length>0);
  for(const rect of drawing.rects){
    for(const key of ['x','y','width','height'])assert.ok(Number.isInteger(rect[key]),key);
    assert.ok(rect.x>=0&&rect.y>=0&&rect.width>0&&rect.height>0);
    assert.ok(rect.x+rect.width<=drawing.width&&rect.y+rect.height<=drawing.height);
    assert.match(rect.fill,/^#[0-9a-f]{6}$/i);
  }
}
test('new native home drawings preserve every saved rotation, foot, seat and clipping envelope',()=>{
  for(const [kind,spec] of Object.entries(HOME_PIXEL_ART)){
    const paintings=[];
    for(const rotation of [0,90,180,270]){
      const art=spec.variants[rotation],old=HOME_ARCHIVE_ART[kind].variants[rotation];
      for(const key of ['width','height','anchor','seat','foreground','facing'])assert.deepEqual(art[key],old[key],`${kind}/${rotation}/${key}`);
      const placed=Object.freeze({instance_id:'saved-original',kind,x:3,y:4,rotation});
      assert.deepEqual(homeFurnitureLayout(placed,undefined,spec),homeFurnitureLayout(placed,undefined,HOME_ARCHIVE_ART[kind]));
      const drawing=homeFurniturePixels(kind,rotation);validPixels(drawing);paintings.push(JSON.stringify(drawing));
      if(art.foreground)validPixels(homeFurniturePixels(kind,rotation,'foreground'));
    }
    assert.equal(new Set(paintings).size,kind==='rug'?2:4,`${kind} has real directional artwork`);
  }
  validPixels(homeCottagePixels());validPixels(homeRoomPixels());
  assert.notDeepEqual(homeRoomPixels('night'),homeRoomPixels('day'));
});

test('Q seated/sleeping contact meets the original furniture anchor in every heading without moving identity or world state',()=>{
  for(const kind of ['chair','bed'])for(const rotation of [0,90,180,270]){
    const furniture={instance_id:'original',kind,x:3,y:3,rotation};
    const activity={instance_id:'original',kind:kind==='bed'?'rest':'sit',phase:'using',started_at:1000,ends_at:61000};
    const actor={agent_id:'original-agent',appearance:{sprite_id:'original-skin'},status:'active',position:{x:99,y:99},home_presence:{home_id:'original-home',position:{x:2,y:3},activity}};
    const before=JSON.stringify(actor),proxy=homeActorProxy(actor),spec=HOME_PIXEL_ART[kind];
    const layout=homeFurnitureLayout(furniture,undefined,spec),seat=homeSeatAnchor(proxy,furniture,spec);
    assert.ok(seat);const foot=homeRoomFoot(proxy.position),height=homePixelContactHeight(activity,furniture,seat.facing);
    assert.equal(foot.x+seat.x,layout.seat.x);assert.equal(foot.y+seat.y,layout.seat.y);
    assert.equal(height,kind==='bed'&&rotation===180?31:7);
    const staticStyle=homeUsePresentationStyle(proxy,furniture,6000,false,undefined,spec,height);
    assert.ok(staticStyle.translate.includes(`${height}px * var(--pixel-scale)`));
    assert.deepEqual(staticStyle,homeUsePresentationStyle(proxy,furniture,20000,false,undefined,spec,height));
    assert.ok(layout.depth<homeActorDepth(proxy.position,layout)&&homeActorDepth(proxy.position,layout)<layout.foregroundDepth);
    assert.equal(JSON.stringify(actor),before);
    for(const phase of ['approaching','ended']){
      const pending={...proxy,home_presence:{...proxy.home_presence,activity:{...activity,phase}}};
      assert.equal(homeSeatAnchor(pending,furniture,spec),null);
      assert.equal(homeUsePresentationStyle(pending,furniture,6000,true,undefined,spec,height),undefined);
    }
  }
});

test('bed foreground contains only its near blanket/rail, so the rear headboard cannot repaint the Q sleeper',()=>{
  for(const rotation of [0,90,180,270]){
    const base=homeFurniturePixels('bed',rotation),front=homeFurniturePixels('bed',rotation,'foreground');
    assert.ok(front.rects.length<base.rects.length);
    assert.ok(!front.rects.some(rect=>rect.width>=front.width-2&&rect.height>front.height*.5),'a full mattress/body rectangle must not occlude the sleeper');
    assert.ok(front.rects.some(rect=>rect.fill==='#73ab65'),'the near blanket remains visible');
  }
});

test('native backrests and blankets retain a readable Q head at the real seat in all eight contact views',()=>{
  const contains=(rect,x,y)=>x>=rect.x&&y>=rect.y&&x<rect.x+rect.width&&y<rect.y+rect.height;
  for(const kind of ['chair','bed'])for(const rotation of [0,90,180,270]){
    const art=HOME_PIXEL_ART[kind].variants[rotation],drawing=homeFurniturePixels(kind,rotation,'foreground');
    const action=kind==='bed'?'sleep':'sit',pose=qActorPose(action,art.facing),scale=640/460;
    const cells=new Set();
    for(const rect of qCharacterPixels('wanderer_1',{action,direction:art.facing,frame:0}).filter(rect=>['head','hair','face','eyes','hat','hood'].includes(rect.part)))
      for(let y=rect.y;y<rect.y+rect.h;y++)for(let x=rect.x;x<rect.x+rect.w;x++)cells.add(`${x},${y}`);
    let visible=0;
    for(const cell of cells){
      let [x,y]=cell.split(',').map(Number);if(art.facing==='west')x=47-x;
      const rx=art.seat.x+(x+.5-24)*scale,ry=art.seat.y+(y+.5-pose.hip.y)*scale;
      const clipped=art.foreground.rects.some(([x,y,width,height])=>contains({x,y,width,height},rx,ry));
      if(!clipped||!drawing.rects.some(rect=>contains(rect,rx*drawing.width/art.width,ry*drawing.height/art.height)))visible++;
    }
    assert.ok(visible/cells.size>.45,`${kind}/${rotation}: only ${Math.round(visible/cells.size*100)}% of the head visible`);
  }
});

test('home poses distinguish an actual seat from a standing table/bookshelf activity, and souvenirs remain keyed to actual inventory',()=>{
  assert.equal(homePixelAction({kind:'read'},{kind:'chair'}),'read');
  assert.equal(homePixelAction({kind:'read'},{kind:'bookshelf'}),'stand_read');
  assert.equal(homePixelAction({kind:'write'},{kind:'table'}),'stand_write');
  assert.equal(homePixelAction({kind:'eat'},{kind:'table'}),'eat');
  const drawings=['pine_cone','wood','ore','ruins_leaf_medallion','ruins_stone_bird','ruins_star_lens'].map(item=>{const drawing=homeSouvenirPixels(item);validPixels(drawing);return JSON.stringify(drawing);});
  assert.equal(new Set(drawings).size,6);assert.ok(!drawings.includes(JSON.stringify(homeSouvenirPixels('unknown-saved-item'))));
});
