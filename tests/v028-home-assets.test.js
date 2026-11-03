import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { checkHomeArt } from '../deploy/check-home-art.mjs';
test('pixel cottage originals keep transparent backgrounds and every measured source frame stays in bounds',async()=>{
  const manifest=checkHomeArt(['public']);
  for(const entry of manifest.assets){
    const path=new URL(`../public/pixel-home/v028/${entry.file}`,import.meta.url);
    const image=sharp(await import('node:fs/promises').then(fs=>fs.readFile(path)));
    const metadata=await image.metadata(),stats=await image.stats();
    assert.equal(metadata.width,entry.width);assert.equal(metadata.height,entry.height);
    if(entry.transparent){assert.equal(metadata.hasAlpha,true);assert.equal(stats.isOpaque,false);assert.equal(stats.channels.at(-1).min,0);assert.ok(stats.channels.at(-1).max>240);}
  }
});
