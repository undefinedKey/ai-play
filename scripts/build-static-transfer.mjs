import {readFile,writeFile,readdir,stat,rename} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import sharp from 'sharp';

// Deployment encodings only: source PNGs and the source atlas coordinates never
// change. WebP uses lossy RGB at quality 90 and an exactly preserved alpha plane.
const WEBP_OPTIONS={quality:90,alphaQuality:100,effort:6};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const round=value=>Math.round(value*1e6)/1e6;
const portable=path=>path.split(sep).join('/');
const check=(condition,message)=>{if(!condition)throw new Error(message);};

async function filesBelow(directory){
  const entries=await readdir(directory,{withFileTypes:true}),files=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(directory,entry.name);
    if(entry.isDirectory())files.push(...await filesBelow(path));
    else if(entry.isFile())files.push(path);
  }
  return files;
}
async function publish(path,bytes){
  const temporary=`${path}.transfer-tmp`;await writeFile(temporary,bytes);await rename(temporary,path);
}

export async function verifyWebpPixels(source,encoded){
  const original=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const decoded=await sharp(encoded).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height,channels}=original.info;
  check(width===decoded.info.width&&height===decoded.info.height&&channels===4&&decoded.info.channels===4,'WebP dimensions or RGBA channels changed');
  let alphaDifferences=0,rgbMax=0,rgbSum=0,visibleMax=0,visibleSum=0,visibleSamples=0,weightedSum=0,alphaWeight=0;
  for(let i=0;i<original.data.length;i+=4){
    const alpha=original.data[i+3];if(alpha!==decoded.data[i+3])alphaDifferences++;
    alphaWeight+=alpha/255;
    for(let channel=0;channel<3;channel++){
      const difference=Math.abs(original.data[i+channel]-decoded.data[i+channel]);rgbMax=Math.max(rgbMax,difference);rgbSum+=difference;
      if(alpha){visibleMax=Math.max(visibleMax,difference);visibleSum+=difference;visibleSamples++;weightedSum+=difference*alpha/255;}
    }
  }
  check(alphaDifferences===0,`WebP alpha changed at ${alphaDifferences} pixels`);
  return {width,height,alpha_identical:true,alpha_differing_pixels:alphaDifferences,rgb_max_error:rgbMax,rgb_mean_error:round(rgbSum/(width*height*3)),visible_rgb_max_error:visibleMax,visible_rgb_mean_error:round(visibleSum/Math.max(1,visibleSamples)),alpha_weighted_rgb_mean_error:round(weightedSum/Math.max(1,alphaWeight*3))};
}

export async function buildStaticTransfer({root=process.cwd(),dist=resolve(root,'dist'),publicDirectory=resolve(root,'public'),log=console.log}={}){
  root=resolve(root);dist=resolve(dist);
  check((await stat(dist)).isDirectory(),'Build dist first');
  sharp.concurrency(1);sharp.cache({memory:32,files:0,items:8});
  const paths=await filesBelow(dist),images=[],gzip=[];
  for(const path of paths){
    const name=portable(relative(dist,path));
    if(!/^pixel-world\/ink_[a-z0-9_]+\.png$/.test(name))continue;
    const source=await readFile(path),sourceHash=hash(source),reference=await readFile(resolve(publicDirectory,name));
    check(sourceHash===hash(reference),`${name}: dist PNG differs from original public PNG`);
    const encoded=await sharp(source).webp(WEBP_OPTIONS).toBuffer(),pixels=await verifyWebpPixels(source,encoded);
    check(hash(await readFile(path))===sourceHash,`${name}: source PNG changed during encoding`);
    check(encoded.length<source.length,`${name}: WebP must reduce transfer bytes`);
    const sidecar=`${path}.webp`;await publish(sidecar,encoded);
    images.push({source:name,sidecar:`${name}.webp`,source_sha256:sourceHash,source_public_identical:true,source_bytes:source.length,encoded_sha256:hash(encoded),encoded_bytes:encoded.length,...pixels});
    log(`${name}: ${source.length} → ${encoded.length} bytes; alpha exact; visible RGB MAE ${pixels.visible_rgb_mean_error}`);
  }
  check(images.length>0,'No ink PNGs found in dist/pixel-world');
  for(const path of paths){
    const name=portable(relative(dist,path));
    if(!/\.(?:js|css|json)$/.test(name)||name==='static-transfer-manifest.json')continue;
    const source=await readFile(path),encoded=gzipSync(source,{level:9});
    check(gunzipSync(encoded).equals(source),`${name}: gzip round-trip changed content`);
    await publish(`${path}.gz`,encoded);
    gzip.push({source:name,sidecar:`${name}.gz`,source_sha256:hash(source),source_bytes:source.length,encoded_sha256:hash(encoded),encoded_bytes:encoded.length,round_trip_identical:true});
  }
  const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  const total=(entries,key)=>entries.reduce((sum,entry)=>sum+entry[key],0);
  const manifest={schema_version:1,release:pkg.version,encoder:{sharp:sharp.versions.sharp,webp:sharp.versions.webp,options:WEBP_OPTIONS,description:'Lossy RGB deployment encoding, exact alpha, unchanged original PNGs; no resize or crop'},images,gzip,totals:{image_count:images.length,image_source_bytes:total(images,'source_bytes'),image_webp_bytes:total(images,'encoded_bytes'),gzip_count:gzip.length,text_source_bytes:total(gzip,'source_bytes'),text_gzip_bytes:total(gzip,'encoded_bytes')}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await publish(resolve(dist,'static-transfer-manifest.json'),manifestBytes);
  await publish(resolve(dist,'static-transfer-manifest.json.gz'),gzipSync(manifestBytes,{level:9}));
  log(`Static transfer: ${images.length} images ${manifest.totals.image_source_bytes} → ${manifest.totals.image_webp_bytes} bytes; ${gzip.length} text encodings`);
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await buildStaticTransfer();
