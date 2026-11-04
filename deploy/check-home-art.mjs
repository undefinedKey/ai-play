import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HOME_PIXEL_ART, HOME_ARCHIVE_ART } from '../src/home-pixel-manifest.js';
import { homeFurniturePixels, homeRoomPixels, homeCottagePixels, homeSouvenirPixels } from '../src/home-pixel-drawing.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function checkHomeArt(directories=['public','dist']) {
  const source=JSON.parse(readFileSync(resolve(root,'public/pixel-home/v028/manifest.json')));
  assert.equal(source.style,'C-clear-pixel');
  assert.equal(source.assets.length,8);
  for(const directory of directories) {
    const prefix=resolve(root,directory,'pixel-home/v028');
    assert.deepEqual(JSON.parse(readFileSync(resolve(prefix,'manifest.json'))),source);
    for(const entry of source.assets) {
      const bytes=readFileSync(resolve(prefix,entry.file));
      assert.equal(hash(bytes),entry.sha256,`${directory}/${entry.file}: source PNG changed`);
      assert.equal(bytes.readUInt32BE(16),entry.width);assert.equal(bytes.readUInt32BE(20),entry.height);
      assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    }
  }
  for(const [kind,art] of Object.entries(HOME_ARCHIVE_ART)) {
    assert.deepEqual(Object.keys(art.variants),['0','90','180','270']);
    const regions=new Set();
    for(const frame of Object.values(art.variants)) {
      const entry=source.assets.find(value=>frame.src.endsWith('/'+value.file));assert.ok(entry);
      assert.equal(frame.sheet.width,entry.width);assert.equal(frame.sheet.height,entry.height);
      const r=frame.sourceRect;assert.ok([r.x,r.y,r.w,r.h].every(Number.isInteger));
      assert.ok(r.x>=0&&r.y>=0&&r.w>0&&r.h>0&&r.x+r.w<=entry.width&&r.y+r.h<=entry.height);
      const ratio=frame.planeRotation?r.h/r.w:r.w/r.h;
      assert.ok(Math.abs(frame.width/frame.height-ratio)<.0001,`${kind}: stretched image`);
      assert.ok(frame.width>0&&frame.height>0&&frame.anchor.x>=0&&frame.anchor.x<=frame.width&&frame.anchor.y<=frame.height);
      if(frame.seat)assert.ok(frame.seat.x>=0&&frame.seat.x<=frame.width&&frame.seat.y>=0&&frame.seat.y<=frame.height);
      for(const [x,y,w,h] of frame.foreground?.rects||[])assert.ok(x>=0&&y>=0&&w>0&&h>0&&x+w<=frame.width+.001&&y+h<=frame.height+.001&&w*h<frame.width*frame.height*.98);
      regions.add(JSON.stringify(r));
    }
    if(kind!=='rug')assert.equal(regions.size,4,`${kind}: missing real views`);
  }
  function native(drawing,label) {
    assert.ok(Number.isInteger(drawing.width)&&Number.isInteger(drawing.height)&&drawing.width>0&&drawing.height>0,label);
    assert.ok(drawing.rects.length>0,`${label}: missing native drawing`);
    for(const r of drawing.rects){
      assert.ok([r.x,r.y,r.width,r.height].every(Number.isInteger),`${label}: noninteger source pixels`);
      assert.ok(r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=drawing.width&&r.y+r.height<=drawing.height,`${label}: drawing exceeds source`);
      assert.match(r.fill,/^#[0-9a-f]{6}$/i,`${label}: nonpixel color`);
    }
  }
  for(const [kind,art] of Object.entries(HOME_PIXEL_ART)) {
    assert.equal(art.format,'native-pixel');
    assert.deepEqual(Object.keys(art.variants),['0','90','180','270']);
    const views=new Set();
    for(const [rotation,frame] of Object.entries(art.variants)) {
      assert.equal(frame.format,'native-pixel');assert.equal(frame.src,undefined);
      const drawing=homeFurniturePixels(kind,Number(rotation));native(drawing,`${kind}/${rotation}`);
      assert.deepEqual(frame.native,{width:drawing.width,height:drawing.height});
      // New art cannot move a saved furniture footprint or contact plane.
      const old=HOME_ARCHIVE_ART[kind].variants[rotation];
      for(const key of ['width','height','anchor','seat','foreground'])assert.deepEqual(frame[key],old[key],`${kind}/${rotation}.${key}`);
      views.add(JSON.stringify(drawing));
    }
    if(kind!=='rug')assert.equal(views.size,4,`${kind}: four authored directions required`);
  }
  for(const phase of ['day','dusk','night','dawn'])native(homeRoomPixels(phase),`room/${phase}`);
  native(homeCottagePixels(),'cottage');
  for(const id of ['pine_cone','wood','ore','turnip','wheat_bread'])native(homeSouvenirPixels(id),`souvenir/${id}`);
  return source;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){checkHomeArt();console.log('Pixel home: native drawings, four views, saved contacts and archival originals verified');}
