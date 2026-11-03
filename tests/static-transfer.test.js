import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {request} from 'node:http';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import {staticTransfer} from '../server/static-transfer.js';
import {buildStaticTransfer,verifyWebpPixels} from '../scripts/build-static-transfer.mjs';

const PNG=Buffer.from('89504e470d0a1a0a000102030405060708090a0b0c0d0e0f','hex');
const WEBP=Buffer.from('RIFFtest-sidecar-WEBP');
const JS=Buffer.from('export const message = "original script";\n');
const CSS=Buffer.from('body { color: #222; }\n');
const JSON_BYTES=Buffer.from('{"release":"test","private":false}\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const temporary=mkdtempSync(join(tmpdir(),'plaza-static-transfer-')),directory=join(temporary,'dist');
  const write=(name,value)=>{const file=join(directory,name);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,value);return file;};
  write('pixel-world/sprite.png',PNG);write('pixel-world/sprite.png.webp',WEBP);
  write('pixel-home/v028/chair.png',PNG);write('pixel-home/v028/chair.png.webp',WEBP);
  write('pixel-world/fallback.png',PNG);write('pixel-world/orphan.png.webp',WEBP);
  for(const[name,value]of [['assets/app.js',JS],['assets/app.css',CSS],['pixel-world/manifest.json',JSON_BYTES]]){write(name,value);write(name+'.gz',gzipSync(value));}
  write('index.html','<!doctype html><title>Original page</title>');write('index.html.gz',gzipSync('DO NOT USE HTML SIDECAR'));
  write('assets/fallback.js',JS);write('assets/orphan.js.gz',gzipSync('missing original'));
  for(const name of ['api/probe.json','mcp/probe.js','events/probe.json']){write(name,JSON_BYTES);write(name+'.gz',gzipSync('STATIC TRAP'));}
  const app=express();app.disable('x-powered-by');
  app.use(staticTransfer(directory));
  app.all(['/api/probe.json','/mcp/probe.js','/events/probe.json'],(req,res)=>{
    if(req.path.startsWith('/events'))return res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store'}).send('data: live event\n\n');
    res.set('Cache-Control','no-store').json({dynamic:true});
  });
  app.use(express.static(directory));
  app.use((_req,res)=>res.status(404).send('missing'));
  app.use((error,_req,res,_next)=>res.status(error.status||500).send('error'));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // Only remove the exact directory created for this fixture.
    assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('plaza-static-transfer-'));
    rmSync(temporary,{recursive:true,force:true});
  });
  const call=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,headers,method},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
    });req.on('error',reject);req.end();
  });
  return{directory,temporary,write,call};
}
function vary(response,token){assert.ok(response.headers.vary?.toLowerCase().split(/\s*,\s*/).includes(token.toLowerCase()),`missing Vary: ${token}`);}

test('PNG uses WebP only after explicit positive acceptance; originals keep their exact bytes',async t=>{
  const {call}=await fixture(t);
  for(const accept of [undefined,'*/*','image/*','image/png','image/webp;q=0','image/webp;q=0.000, */*;q=1','image/webp;q=0, image/webp;q=1','image/webp;q=2','image/webp;q=oops','image/webp;q=1;q=0']){
    const result=await call('/pixel-world/sprite.png?v=one',accept?{Accept:accept}:{});
    assert.equal(result.status,200,accept);assert.equal(sha(result.body),sha(PNG),accept);
    assert.match(result.headers['content-type'],/^image\/png/);assert.equal(result.headers['content-encoding'],undefined);vary(result,'Accept');
  }
  for(const accept of ['image/webp','image/png, image/webp;q=0.5','IMAGE/WEBP;Q=1.000']){
    const result=await call('/pixel-world/sprite.png',{Accept:accept});
    assert.equal(result.status,200);assert.deepEqual(result.body,WEBP);assert.equal(result.headers['content-type'],'image/webp');
    assert.equal(result.headers['content-encoding'],undefined);vary(result,'Accept');assert.match(result.headers['cache-control'],/max-age=0.*must-revalidate/);
  }
});

test('versioned home sprites negotiate WebP and retain PNG fallback without widening other image paths',async t=>{
  const {call,write}=await fixture(t),path='/pixel-home/v028/chair.png';
  for(const accept of [undefined,'*/*','image/png','image/webp;q=0','image/webp;q=0, image/webp;q=1']){
    const result=await call(path+'?v=0.28.0',accept?{Accept:accept}:{});
    assert.equal(result.status,200);assert.deepEqual(result.body,PNG);assert.match(result.headers['content-type'],/^image\/png/);vary(result,'Accept');
  }
  const accepted=await call(path,{Accept:'image/png, image/webp;q=0.8'});
  assert.equal(accepted.status,200);assert.deepEqual(accepted.body,WEBP);assert.equal(accepted.headers['content-type'],'image/webp');vary(accepted,'Accept');
  const head=await call(path,{Accept:'image/webp'},'HEAD');assert.equal(head.body.length,0);assert.equal(head.headers.etag,accepted.headers.etag);
  const unchanged=await call(path,{Accept:'image/webp','If-None-Match':accepted.headers.etag});assert.equal(unchanged.status,304);
  const range=await call(path,{Accept:'image/webp',Range:'bytes=0-7'});assert.equal(range.status,206);assert.deepEqual(range.body,PNG.subarray(0,8));
  write('pixel-home/v028/bed.png',PNG);
  const missing=await call('/pixel-home/v028/bed.png',{Accept:'image/webp'});assert.deepEqual(missing.body,PNG);assert.match(missing.headers['content-type'],/^image\/png/);
  for(const name of ['pixel-home/v029/chair.png','pixel-home/chair.png','pixel-home/v028/nested/chair.png','other/chair.png']){
    write(name,PNG);write(name+'.webp',WEBP);
    const result=await call('/'+name,{Accept:'image/webp'});assert.deepEqual(result.body,PNG);assert.match(result.headers['content-type'],/^image\/png/);assert.equal(result.headers.vary,undefined);
  }
});

test('home PNG build sidecars preserve original pixels and alpha through the real HTTP negotiation',async t=>{
  const {call,write,temporary,directory}=await fixture(t),input=Buffer.alloc(64*64*4);
  for(let pixel=0;pixel<64*64;pixel++){const i=pixel*4;input[i]=pixel%251;input[i+1]=pixel*7%251;input[i+2]=pixel*13%251;input[i+3]=pixel%256;}
  const png=await sharp(input,{raw:{width:64,height:64,channels:4}}).png({compressionLevel:0}).toBuffer();
  const name='pixel-home/v028/chair.png',publicFile=join(temporary,'public',name);
  mkdirSync(dirname(publicFile),{recursive:true});writeFileSync(publicFile,png);write(name,png);
  writeFileSync(join(temporary,'package.json'),'{"version":"0.28.0"}');
  for(const excluded of ['pixel-home/v029/chair.png','pixel-home/chair.png','pixel-home/v028/nested/chair.png'])write(excluded,png);
  const manifest=await buildStaticTransfer({root:temporary,log:()=>{}});
  assert.equal(manifest.images.length,1);assert.equal(manifest.images[0].source,name);assert.equal(manifest.images[0].alpha_differing_pixels,0);
  assert.deepEqual(readFileSync(join(directory,name)),png);assert.deepEqual(readFileSync(publicFile),png);
  for(const excluded of ['pixel-home/v029/chair.png','pixel-home/chair.png','pixel-home/v028/nested/chair.png'])assert.equal(existsSync(join(directory,excluded+'.webp')),false);
  const compressed=await call('/'+name,{Accept:'image/webp'}),original=await call('/'+name,{Accept:'image/png'});
  assert.equal(compressed.headers['content-type'],'image/webp');assert.deepEqual(original.body,png);
  const pixels=await verifyWebpPixels(png,compressed.body);assert.equal(pixels.alpha_identical,true);assert.equal(pixels.width,64);assert.equal(pixels.height,64);
});

test('gzip sidecars retain the original text type and bytes after decompression, without wildcard opt-in',async t=>{
  const {call}=await fixture(t);
  for(const[path,original,type]of [['/assets/app.js',JS,'text/javascript'],['/assets/app.css',CSS,'text/css'],['/pixel-world/manifest.json',JSON_BYTES,'application/json']]){
    const result=await call(path,{'Accept-Encoding':'br, gzip;q=0.7'});
    assert.equal(result.status,200);assert.equal(result.headers['content-encoding'],'gzip');assert.ok(result.headers['content-type'].startsWith(type));
    assert.deepEqual(gunzipSync(result.body),original);vary(result,'Accept-Encoding');assert.match(result.headers['cache-control'],/max-age=0.*must-revalidate/);
    for(const encoding of [undefined,'*','br','gzip;q=0, *;q=1','gzip;q=0.000','gzip;q=invalid','gzip;q=0, gzip;q=1']){
      const fallback=await call(path,encoding?{'Accept-Encoding':encoding}:{});
      assert.equal(fallback.headers['content-encoding'],undefined,encoding);assert.deepEqual(fallback.body,original,encoding);vary(fallback,'Accept-Encoding');
    }
  }
});

test('HEAD and conditional requests use representation-specific validators',async t=>{
  const {call}=await fixture(t);
  for(const[path,header,bytes]of [['/pixel-world/sprite.png',{Accept:'image/webp'},WEBP],['/assets/app.js',{'Accept-Encoding':'gzip'},gzipSync(JS)]]){
    const get=await call(path,header),head=await call(path,header,'HEAD');
    assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),bytes.length);assert.equal(head.headers.etag,get.headers.etag);
    const fresh=await call(path,{...header,'If-None-Match':get.headers.etag});
    assert.equal(fresh.status,304);assert.equal(fresh.body.length,0);assert.equal(fresh.headers.etag,get.headers.etag);assert.ok(fresh.headers.vary);
    const original=await call(path,{'If-None-Match':get.headers.etag});
    assert.equal(original.status,200,'sidecar validator must not validate original representation');assert.notEqual(original.headers.etag,get.headers.etag);
    const switched=await call(path,{...header,'If-None-Match':original.headers.etag});
    assert.equal(switched.status,200,'original validator must not validate sidecar');
  }
});

test('Range requests use the original bytes and validators rather than compressed/image sidecars',async t=>{
  const {call}=await fixture(t);
  for(const[path,headers,original]of [['/pixel-world/sprite.png',{Accept:'image/webp'},PNG],['/assets/app.js',{'Accept-Encoding':'gzip'},JS]]){
    const result=await call(path,{...headers,Range:'bytes=0-7'});
    assert.equal(result.status,206);assert.deepEqual(result.body,original.subarray(0,8));assert.equal(result.headers['content-range'],`bytes 0-7/${original.length}`);
    assert.equal(result.headers['content-encoding'],undefined);assert.notEqual(result.headers['content-type'],'image/webp');
  }
});

test('missing, stale, and orphaned sidecars fall back safely; only GET/HEAD static assets participate',async t=>{
  const {call,write}=await fixture(t);
  const image=await call('/pixel-world/fallback.png',{Accept:'image/webp'});assert.deepEqual(image.body,PNG);assert.match(image.headers['content-type'],/^image\/png/);
  const script=await call('/assets/fallback.js',{'Accept-Encoding':'gzip'});assert.deepEqual(script.body,JS);assert.equal(script.headers['content-encoding'],undefined);
  for(const path of ['/pixel-world/orphan.png','/assets/orphan.js'])assert.equal((await call(path,{Accept:'image/webp','Accept-Encoding':'gzip'})).status,404);
  const source=write('assets/stale.js',JS),side=write('assets/stale.js.gz',gzipSync('stale output'));
  utimesSync(side,new Date(1000),new Date(1000));utimesSync(source,new Date(2000),new Date(2000));
  const stale=await call('/assets/stale.js',{'Accept-Encoding':'gzip'});assert.deepEqual(stale.body,JS);assert.equal(stale.headers['content-encoding'],undefined);
  assert.equal((await call('/pixel-world/sprite.png',{Accept:'image/webp'},'POST')).status,404);
  const html=await call('/index.html',{'Accept-Encoding':'gzip'});assert.match(html.body.toString(),/Original page/);assert.equal(html.headers['content-encoding'],undefined);assert.equal(html.headers.vary,undefined);
  for(const path of ['/api/probe.json','/mcp/probe.js','/events/probe.json']){
    const live=await call(path,{'Accept-Encoding':'gzip'});assert.equal(live.status,200);assert.equal(live.headers['content-encoding'],undefined);assert.equal(live.headers.vary,undefined);assert.equal(live.headers['cache-control'],'no-store');
    assert.ok(live.body.toString().includes(path.startsWith('/events')?'data: live event':'"dynamic":true'));
  }
});

test('encoded traversal, backslashes, hidden paths and second decoding never expose outside bytes',async t=>{
  const {call,temporary}=await fixture(t);const secret=Buffer.from('OUTSIDE STATIC ROOT');
  writeFileSync(join(temporary,'secret.js'),secret);writeFileSync(join(temporary,'secret.js.gz'),gzipSync(secret));
  writeFileSync(join(temporary,'secret.png'),secret);writeFileSync(join(temporary,'secret.png.webp'),secret);
  for(const path of ['/assets/../../secret.js','/assets/%2e%2e/%2e%2e/secret.js','/assets/%2e%2e%2f%2e%2e%2fsecret.js','/assets/%5c..%5c..%5csecret.js','/assets/%252e%252e/secret.js','/assets/app.js%00.js','/assets/.hidden.js','/pixel-world/../../secret.png','/pixel-world/%2e%2e/%2e%2e/secret.png','/pixel-world/%5c..%5c..%5csecret.png','/pixel-world/%252e%252e/secret.png']){
    const result=await call(path,{'Accept-Encoding':'gzip',Accept:'image/webp'});assert.ok(result.status>=400,path);assert.equal(result.headers['content-encoding'],undefined,path);assert.notEqual(result.headers['content-type'],'image/webp',path);assert.ok(!result.body.includes(secret),path);
  }
});

test('realpath checks reject directory junctions that lead outside the static root',async t=>{
  const {call,directory,temporary}=await fixture(t),outside=join(temporary,'outside');
  mkdirSync(outside);writeFileSync(join(outside,'secret.js'),'OUTSIDE ROOT');writeFileSync(join(outside,'secret.js.gz'),gzipSync('OUTSIDE ROOT'));
  symlinkSync(outside,join(directory,'assets/escaped'),'junction');
  const rejected=await call('/assets/escaped/secret.js',{'Accept-Encoding':'gzip'});
  assert.equal(rejected.status,403);assert.ok(!rejected.body.includes(Buffer.from('OUTSIDE ROOT')));assert.equal(rejected.headers['content-encoding'],undefined);
});

test('realpath checks reject file symlink originals and ignore sidecars outside root',async t=>{
  const {call,write,directory,temporary}=await fixture(t),outside=join(temporary,'outside.js');writeFileSync(outside,'OUTSIDE ROOT');
  const escaped=join(directory,'assets/escaped.js'),inside=write('assets/safe.js',JS);
  try{symlinkSync(outside,escaped,'file');symlinkSync(outside,inside+'.gz','file');}
  catch(error){if(error.code==='EPERM'||error.code==='EACCES'){t.skip('Host does not permit creating symlinks');return;}throw error;}
  const rejected=await call('/assets/escaped.js',{'Accept-Encoding':'gzip'});assert.equal(rejected.status,403);assert.ok(!rejected.body.includes(Buffer.from('OUTSIDE ROOT')));
  const fallback=await call('/assets/safe.js',{'Accept-Encoding':'gzip'});assert.equal(fallback.status,200);assert.deepEqual(fallback.body,JS);assert.equal(fallback.headers['content-encoding'],undefined);
});
