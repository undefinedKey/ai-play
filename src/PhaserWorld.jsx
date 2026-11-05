import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {WorldRenderContext} from './world-render-context.jsx';
import {usePixelManifest} from './PixelWorld.jsx';
import {plazaPropArtwork} from './plaza-state.js';
import {sceneDefinition,WORLD_MAP} from '../shared/world-layout.js';
import {sameRenderPacket} from './render-packet.js';
import {NightLighting} from './Survival.jsx';
import {sceneFireLights} from './survival-state.js';

let rendererRequest;
const requestRenderer=()=>rendererRequest??=import('./phaser-renderer.js');

export default function PhaserWorld({sceneId,live,children,cycle,survival}) {
  const host=useRef(null),engine=useRef(null),assets=usePixelManifest();
  const [status,setStatus]=useState('loading'),[retry,setRetry]=useState(0),[scale,setScale]=useState(1),[partial,setPartial]=useState(false),[importFailed,setImportFailed]=useState(false);
  const registry=useMemo(()=>{const entries=new Map();return{entries,set(id,value){if(sameRenderPacket(entries.get(id),value))return;entries.set(id,value);engine.current?.invalidate();},delete(id){if(entries.delete(id))engine.current?.invalidate();}};},[]);
  const context=useMemo(()=>({registry,scale}),[registry,scale]);
  // Start the critical renderer in parallel with the manifest, before CSS
  // sprites enqueue the larger atlases. The same promise is reused below.
  useEffect(()=>{void requestRenderer().catch(()=>{});},[]);
  useEffect(()=>{const observer=new ResizeObserver(entries=>{setScale(entries[0].contentRect.width/(WORLD_MAP.width*32));engine.current?.invalidate();});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!assets)return;
    let cancelled=false,instance;
    setStatus('loading');setImportFailed(false);setPartial(sceneDefinition(sceneId)?.props.some(prop=>prop.kind!=='pond'&&!plazaPropArtwork(assets,sceneId,prop)));
    // Phaser stays outside the initial React bundle and owns only the visible main map.
    requestRenderer().then(module=>{
      if(cancelled)return;
      instance=module.createWorldRenderer({parent:host.current,assets,registry,sceneId,phase:cycle?.phase,lights:sceneFireLights(survival,sceneId),onReady:()=>{if(!cancelled)setStatus('ready');},onPartial:()=>{if(!cancelled)setPartial(true);},onError:()=>{if(!cancelled)setStatus('fallback');}});
      engine.current=instance;
    }).catch(()=>{if(!cancelled){setImportFailed(true);setStatus('fallback');}});
    return()=>{cancelled=true;instance?.destroy();if(engine.current===instance)engine.current=null;};
  },[assets,sceneId,registry,retry]);
  useEffect(()=>{engine.current?.invalidate();},[live]);
  useEffect(()=>{engine.current?.setPhase(cycle?.phase||'day');},[cycle?.phase,status]);
  const lights=JSON.stringify(sceneFireLights(survival,sceneId));
  useEffect(()=>{engine.current?.setLighting(JSON.parse(lights));},[lights,status]);
  const phase=['day','dusk','night','dawn'].includes(cycle?.phase)?cycle.phase:'day';
  const notice=status==='loading'?<span className="renderer-notice" role="status">游戏画布载入中…</span>:status==='fallback'?<div className="renderer-notice renderer-fallback" role="status"><span>游戏画布暂不可用 · 当前为兼容图层显示</span><button onClick={()=>importFailed?location.reload():setRetry(value=>value+1)}>重试游戏画布</button></div>:partial?<span className="renderer-notice" role="status">部分场景素材未载入 · 已保留可用画面和真实位置</span>:null;
  const camera=host.current?.closest('.world-camera');
  return <WorldRenderContext.Provider value={context}><div className={`phaser-world renderer-${status} wilderness-phase-${phase}`} data-art-style={assets?.render_style||'pixel'} data-testid="phaser-world" data-renderer-state={status} data-renderer-scene={sceneId} data-day-phase={cycle?.phase||'unknown'}>
    <div ref={host} className="phaser-canvas-host" aria-hidden="true"/>
    {children}
    <NightLighting phase={phase} survival={survival} sceneId={sceneId}/>
    {notice&&(camera?createPortal(notice,camera):notice)}
  </div></WorldRenderContext.Provider>;
}
