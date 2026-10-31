import React,{useContext,useEffect,useRef,useState} from 'react';
import {Minus,Plus,Expand,Minimize,LocateFixed,Volume2,VolumeX,Map as MapIcon} from 'lucide-react';
import {CameraContext} from './camera-context.js';
import {usePixelNow} from './PixelWorld.jsx';
import {confirmedPosition} from './scene-state.js';
import {SpeechBubbles} from './SpeechOverlay.jsx';
import {cameraView,zoomCamera,panCamera,cameraTransform} from './camera-state.js';
import {WORLD_MAP} from '../shared/world-layout.js';
const campView=()=>cameraView({x:11.5/WORLD_MAP.width,y:8.5/WORLD_MAP.height},2);

export default function WorldCamera({children,speech,status}){
  const camera=useContext(CameraContext),frame=useRef(null),pointers=useRef(new Map()),gesture=useRef(null),suppressClick=useRef(false);
  const[scale,setScale]=useState(1),[view,setView]=useState(campView),[fullscreen,setFullscreen]=useState(false),[notice,setNotice]=useState('');
  const now=usePixelNow(camera?.now||0,!!camera?.live&&camera?.agent?.status==='active');
  const point=camera?.agent?confirmedPosition(camera.agent,now,!!camera.live):camera?.point;
  const map=camera?.map||WORLD_MAP;
  const rendered=point?cameraView({x:(point.x+.5)/map.width,y:(point.y+.5)/map.height},view.zoom):view;
  const state=useRef();state.current={view:rendered,camera};
  useEffect(()=>{const observer=new ResizeObserver(entries=>setScale(entries[0].contentRect.width/(WORLD_MAP.width*32)));observer.observe(frame.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(camera?.mode==='following'||camera?.mode==='located')setView(v=>cameraView(v.center,Math.max(2,v.zoom)));},[camera?.mode,camera?.agent?.agent_id,camera?.point]);
  useEffect(()=>{setView(camera?.resetZoom===1?cameraView():campView());},[camera?.resetKey]);
  useEffect(()=>{const changed=()=>setFullscreen(document.fullscreenElement===(frame.current?.closest('.map-scene-frame')||frame.current));document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);},[]);
  const manual=next=>{state.current.camera?.onManual?.();setView(next);};
  const zoom=(amount,anchor)=>manual(zoomCamera(state.current.view,state.current.view.zoom*amount,anchor));
  useEffect(()=>{
    const element=frame.current;
    const wheel=event=>{if(event.target.closest('button,.head-speech-cloud'))return;event.preventDefault();const rect=element.getBoundingClientRect();const old=state.current.view;state.current.camera?.onManual?.();setView(zoomCamera(old,old.zoom*Math.exp(-Math.max(-120,Math.min(120,event.deltaY))*.003),{x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height}));};
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[]);
  function down(event){
    if(event.button!==0||event.target.closest('.camera-hud,.head-speech-cloud'))return;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const values=[...pointers.current.values()];
    gesture.current=values.length===2?{kind:'pinch',distance:Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y),view:state.current.view}:{kind:'pan',x:event.clientX,y:event.clientY,view:state.current.view};
    suppressClick.current=false;
  }
  function move(event){
    if(!pointers.current.has(event.pointerId)||!gesture.current)return;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const g=gesture.current,rect=frame.current.getBoundingClientRect(),values=[...pointers.current.values()];
    if(g.kind==='pinch'&&values.length===2){
      const distance=Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y);
      const anchor={x:((values[0].x+values[1].x)/2-rect.left)/rect.width,y:((values[0].y+values[1].y)/2-rect.top)/rect.height};
      suppressClick.current=true;manual(zoomCamera(g.view,g.view.zoom*distance/Math.max(1,g.distance),anchor));
    }else if(g.kind==='pan'){
      const dx=event.clientX-g.x,dy=event.clientY-g.y;
      if(Math.hypot(dx,dy)<5&&!suppressClick.current)return;
      suppressClick.current=true;frame.current.setPointerCapture(event.pointerId);manual(panCamera(g.view,dx/rect.width,dy/rect.height));
    }
  }
  function up(event){if(event.type==='pointercancel')suppressClick.current=false;pointers.current.delete(event.pointerId);if(frame.current.hasPointerCapture(event.pointerId))frame.current.releasePointerCapture(event.pointerId);gesture.current=null;}
  function key(event){
    if(event.target!==event.currentTarget)return;
    const directions={ArrowLeft:[.08,0],ArrowRight:[-.08,0],ArrowUp:[0,.08],ArrowDown:[0,-.08]};
    if(directions[event.key]){event.preventDefault();manual(panCamera(rendered,...directions[event.key]));}
    else if(['+','=','-'].includes(event.key)){event.preventDefault();zoom(event.key==='-'?1/1.25:1.25);}
    else if(event.key==='Home'){event.preventDefault();camera?.onReset?.();setView(campView());}
  }
  async function toggleFullscreen(){try{if(document.fullscreenElement===(frame.current?.closest('.map-scene-frame')||frame.current))await document.exitFullscreen();else if(frame.current.requestFullscreen)await (frame.current.closest('.map-scene-frame')||frame.current).requestFullscreen();else setNotice('当前浏览器不支持全屏，仍可使用缩放');}catch{setNotice('未能进入全屏，仍可使用缩放');}}
  return <div ref={frame} className={`world-camera ${rendered.zoom>1?'focused':''}`} role="region" aria-label="世界镜头，方向键平移，加减缩放，Home返回营地" tabIndex={0} data-testid="world-camera" data-camera-mode={point?camera?.mode:rendered.zoom>1?'manual':'overview'} data-camera-zoom={rendered.zoom.toFixed(2)} data-camera-x={rendered.center.x.toFixed(5)} data-camera-y={rendered.center.y.toFixed(5)} style={{'--world-scale':scale,'--camera-zoom':rendered.zoom}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onClickCapture={event=>{if(suppressClick.current){event.preventDefault();event.stopPropagation();suppressClick.current=false;}}}>
    <div className="world-camera-layer" style={{transformOrigin:'0 0',transform:cameraTransform(rendered)}}>{children}</div>
    {status}
    {speech&&<SpeechBubbles {...speech}/>}
    <div className="camera-hud" role="group" aria-label="镜头工具"><button aria-label="缩小地图" disabled={rendered.zoom<=1} onClick={()=>zoom(1/1.25)}><Minus size={17}/></button><output aria-label="当前缩放">{Math.round(rendered.zoom*100)}%</output><button aria-label="放大地图" disabled={rendered.zoom>=4} onClick={()=>zoom(1.25)}><Plus size={17}/></button><button aria-label="查看全景" onClick={()=>manual(cameraView())}><MapIcon size={17}/></button><button aria-label="镜头复位" onClick={()=>{camera?.onReset?.();setView(campView());}}><LocateFixed size={17}/></button><button aria-label={fullscreen?'退出全屏':'全屏观看'} onClick={toggleFullscreen}>{fullscreen?<Minimize size={17}/>:<Expand size={17}/>}</button><button aria-label={camera?.sound?'关闭游戏音效':'开启游戏音效'} aria-pressed={!!camera?.sound} onClick={()=>camera?.onSound?.()}>{camera?.sound?<Volume2 size={17}/>:<VolumeX size={17}/>}</button></div>
    {notice&&<span className="camera-notice" role="status">{notice}</span>}
  </div>;
}
