import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import sharp from 'sharp';
import {buildStaticTransfer,verifyWebpPixels} from '../scripts/build-static-transfer.mjs';

test('deployment sidecars preserve source PNGs, exact alpha, dimensions and gzip contents',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-plaza-transfer-'));
 t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.ok(basename(root).startsWith('ai-plaza-transfer-'));await rm(root,{recursive:true,force:true});});
 const input=Buffer.alloc(64*64*4);
 for(let pixel=0;pixel<64*64;pixel++){const i=pixel*4;input[i]=pixel%251;input[i+1]=pixel*7%251;input[i+2]=pixel*13%251;input[i+3]=pixel%256;}
 const png=await sharp(input,{raw:{width:64,height:64,channels:4}}).png({compressionLevel:0}).toBuffer();
 for(const directory of ['public/pixel-world','dist/pixel-world','dist/assets'])await mkdir(join(root,directory),{recursive:true});
 const name='pixel-world/ink_fixture.png';
 await writeFile(join(root,'public',name),png);await writeFile(join(root,'dist',name),png);
 await writeFile(join(root,'package.json'),'{"version":"test"}');
 const text='export const example = '+JSON.stringify('real content '.repeat(1000))+';';
 await writeFile(join(root,'dist/assets/app.js'),text);await writeFile(join(root,'dist/pixel-world/manifest.json'),'{"release":"test"}');
 const result=await buildStaticTransfer({root,log:()=>{}}),image=result.images[0];
 assert.equal(image.source,name);assert.equal(image.sidecar,name+'.webp');assert.equal(image.width,64);assert.equal(image.height,64);assert.equal(image.alpha_differing_pixels,0);assert.ok(image.encoded_bytes<image.source_bytes);
 assert.equal(image.source_sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual(await readFile(join(root,'dist',name)),png);
 assert.equal(gunzipSync(await readFile(join(root,'dist/assets/app.js.gz'))).toString(),text);
 const metadata=await readFile(join(root,'dist/static-transfer-manifest.json'));assert.deepEqual(gunzipSync(await readFile(join(root,'dist/static-transfer-manifest.json.gz'))),metadata);
 const changed=Buffer.from(input);changed[3]=255;
 const changedWebp=await sharp(changed,{raw:{width:64,height:64,channels:4}}).webp({quality:90,alphaQuality:100}).toBuffer();
 await assert.rejects(verifyWebpPixels(png,changedWebp),/alpha changed/);
 await writeFile(join(root,'dist',name),Buffer.from('source tampered'));
 await assert.rejects(buildStaticTransfer({root,log:()=>{}}),/differs from original public PNG/);
});
