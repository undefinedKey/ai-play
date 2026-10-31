import {realpathSync} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,extname} from 'node:path';

// Wildcards do not opt clients into a different image format or wire encoding.
// An explicit denial (including an invalid/duplicate q parameter) wins when a
// malformed header repeats the same token with contradictory preferences.
function explicitlyAccepts(header,token){
  let accepted=false;
  for(const value of String(header||'').split(',')){
    const [name,...parameters]=value.trim().split(';');
    if(name.trim().toLowerCase()!==token)continue;
    const weights=parameters.map(p=>p.trim()).filter(p=>/^q(?:\s*=|$)/i.test(p));
    if(weights.length>1)return false;
    const weight=weights.length?weights[0].split('=').slice(1).join('=').trim():'1';
    if(!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight)||Number(weight)===0)return false;
    accepted=true;
  }
  return accepted;
}
const within=(root,path)=>{const part=relative(root,path);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..\\')&&!part.startsWith('../');};
const missing=error=>error.code==='ENOENT'||error.code==='ENOTDIR';
const cacheControl='public, max-age=0, must-revalidate';

/** Negotiates prebuilt sidecars only; never compresses API/SSE responses. */
export function staticTransfer(directory){
  const root=realpathSync(resolve(directory));
  async function file(path){
    try{
      const real=await realpath(path);
      if(!within(root,real))return{outside:true};
      const info=await stat(real);
      return info.isFile()?{real,info}:null;
    }catch(error){if(missing(error))return null;throw error;}
  }
  return async function transfer(req,res,next){
    if(req.method!=='GET'&&req.method!=='HEAD')return next();
    const raw=req.url.split('?')[0];
    // Reserved endpoints and HTML remain wholly owned by their existing routes.
    if(/^\/(?:api|mcp|events)(?:\/|$)/i.test(raw))return next();
    let path;
    try{path=decodeURIComponent(raw);}catch{return next();}
    if(/^\/(?:api|mcp|events)(?:\/|$)/i.test(path))return next();
    const image=/^\/pixel-world\/[a-z0-9_-]+\.png$/i.test(path);
    const extension=extname(path).toLowerCase();
    const text=['.js','.css','.json'].includes(extension);
    if(!image&&!text)return next();
    // Refuse encoded traversal, Windows separators/ADS, hidden paths, controls,
    // and second-decoding tricks before touching any filesystem path.
    if(!/^\/[a-z0-9_.\/-]+$/i.test(path)||path.slice(1).split('/').some(part=>!part||part.startsWith('.'))){
      return res.status(400).type('text/plain').send('Invalid static asset path');
    }
    const originalPath=resolve(root,path.slice(1));
    if(!within(root,originalPath))return res.status(400).type('text/plain').send('Invalid static asset path');
    try{
      const original=await file(originalPath);
      if(original?.outside)return res.status(403).type('text/plain').send('Forbidden');
      if(!original)return next();
      res.vary(image?'Accept':'Accept-Encoding');
      res.set('Cache-Control',cacheControl);
      // Ranges always use the original representation and its normal validators.
      if(req.get('Range'))return next();
      if(!explicitlyAccepts(req.get(image?'Accept':'Accept-Encoding'),image?'image/webp':'gzip'))return next();
      const sidecar=await file(originalPath+(image?'.webp':'.gz'));
      if(!sidecar||sidecar.outside||sidecar.info.mtimeMs<original.info.mtimeMs)return next();
      const representation=image?'webp':'gzip';
      // Namespace validators by representation, even when size/mtime coincide.
      const etag=`W/"${representation}-${sidecar.info.size.toString(16)}-${sidecar.info.mtimeMs.toString(16)}"`;
      const headers={'Content-Type':image?'image/webp':extension==='.js'?'text/javascript; charset=utf-8':extension==='.css'?'text/css; charset=utf-8':'application/json; charset=utf-8','Cache-Control':cacheControl,ETag:etag};
      if(!image)headers['Content-Encoding']='gzip';
      res.sendFile(sidecar.real,{dotfiles:'deny',acceptRanges:false,cacheControl:false,headers},error=>{
        if(!error||req.aborted||res.destroyed)return;
        if(res.headersSent){res.destroy(error);return;}
        if(missing(error)){
          // Atomic releases can replace a sidecar between stat and sendFile.
          for(const header of ['Content-Type','Content-Encoding','Content-Length','Content-Range','Accept-Ranges','Last-Modified','ETag'])res.removeHeader(header);
          return next();
        }
        next(error);
      });
    }catch(error){next(error);}
  };
}
