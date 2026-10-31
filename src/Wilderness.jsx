import React,{createContext,useContext,useEffect,useRef} from 'react';
import {Moon,Sun,Sunrise,Sunset,TreePine,X,Pickaxe,Clock3} from 'lucide-react';
import {PixelSprite,usePixelManifest} from './PixelWorld.jsx';
import {RenderSpace} from './world-render-context.jsx';
import {projectMapPoint} from './map-projection.js';
import {resourceState,cycleState,phaseNames} from './wilderness-state.js';

export const ResourceSelection=createContext({selected:null,select:()=>{}});
const tools={axe:'斧头',pickaxe:'镐',hoe:'锄头',watering_can:'水壶'};
const art={tree:'pine',ore_vein:'ore',berry_bush:'berries',herb:'herb',branches:'stump',stones:'ore'};
export function ResourceLayer({world,sceneId,map,now,live}){
  const assets=usePixelManifest(),selection=useContext(ResourceSelection);
  const nodes=(world.resources?.nodes||[]).filter(n=>n.scene_id===sceneId);
  const time=live?now:Number(world.server_time)||now;
  return <div className="resource-layer" aria-label="真实荒野资源">{nodes.map(node=>{
    const state=resourceState(node,world.agents,time),definition=assets?.wilderness?.[node.kind==='tree'&&state.key==='depleted'?'stump':art[node.kind]],scale=definition?.native_scale||1,anchor=definition?[definition.anchor.x*scale,definition.anchor.y*scale]:[64,120],chosen=selection.selected===node.id;
    return <button key={node.id} className={`world-resource resource-${state.key} ${chosen?'selected':''} resource-kind-${node.kind}`} data-testid={`resource-${node.id}`} data-resource-state={state.key} data-stock={node.stock} aria-label={`查看${node.name}，${state.label}，剩余${node.stock}份，只读`} aria-pressed={chosen} onClick={()=>selection.select(node.id)} style={{...projectMapPoint(node.position,map),zIndex:100+node.position.y*10,'--resource-height':`${anchor[1]}px`,'--resource-anchor-x':`${anchor[0]}px`,'--resource-anchor-y':`${anchor[1]}px`}}>
      <RenderSpace position={node.position} depth={100+node.position.y*10} anchor={anchor} alpha={state.key==='dormant'?.5:state.key==='depleted'&&node.kind!=='tree'?.38:1}><span className="resource-art"><PixelSprite definition={definition}/></span></RenderSpace>
      <span className="resource-ring"/><span className="resource-state-mark" aria-hidden="true">{state.key==='working'?'…':state.key==='reserved'?'↗':state.key==='depleted'?'·':state.key==='dormant'?'☾':'◇'}</span>
      <span className="resource-label">{node.name}<small>{state.key==='available'?`${node.stock}/${node.max_stock}`:state.label}</small></span>
    </button>;
  })}</div>;
}

export function ResourceInspector({world,selected,onClose,now,live}){
  const title=useRef(null),node=world.resources?.nodes?.find(n=>n.id===selected);
  useEffect(()=>{if(node)title.current?.focus();},[node?.id]);
  if(!node)return null;
  const time=live?now:Number(world.server_time)||now,state=resourceState(node,world.agents,time);
  return <section className="resource-inspector" data-testid="resource-inspector" aria-labelledby="resource-heading" onKeyDown={e=>{if(e.key==='Escape'){onClose();document.querySelector(`[data-testid="resource-${node.id}"]`)?.focus();}}}>
    <div className="resource-inspector-title"><TreePine size={20}/><div><h3 id="resource-heading" ref={title} tabIndex={-1}>{node.name}</h3><span>{node.scene_id==='plaza'?'生活广场':'林地冒险'} · ({node.position.x}, {node.position.y})</span></div><button aria-label="关闭资源详情" onClick={onClose}><X size={18}/></button></div>
    <div className="resource-facts"><span><strong>{node.stock} / {node.max_stock}</strong> 剩余储量</span><span><Pickaxe size={14}/>{node.tool_id?`需要${tools[node.tool_id]||node.tool_id}`:'可徒手采集'}</span><span><Clock3 size={14}/>{node.duration_seconds} 秒基础工作</span></div>
    <p role="status">{!live?'最近记录 · ':''}{state.label}{state.worker?` · ${state.worker.name}`:''}{state.key==='depleted'?(state.seconds>0?` · 约 ${state.seconds} 秒后恢复`:' · 等待服务器确认恢复'):''}</p>
    {node.available_phases?.length<4&&<p className="resource-availability">可采时段：{node.available_phases.map(p=>phaseNames[p]||p).join('、')}</p>}
    <small>这里只查看公开资源，是否前往与采集由 AI 决定。</small>
  </section>;
}

export function DayCycle({world,live,now}){
  const cycle=cycleState(world.day_cycle,live?now:Number(world.server_time)||now);
  if(!cycle)return <div className="world-time unavailable" role="status">世界时间暂不可用</div>;
  const Icon={day:Sun,dusk:Sunset,night:Moon,dawn:Sunrise}[cycle.phase];
  return <div className={`world-time phase-${cycle.phase}`} data-testid="world-time" data-phase={cycle.phase}>
    <Icon size={18}/><strong>{cycle.label}</strong><span>第 {Math.max(1,Number(cycle.day)||1)} 天</span><span className="time-separator"/><span>{!live?'最近记录 · 等待重连':cycle.seconds?`约 ${Math.floor(cycle.seconds/60)}:${String(cycle.seconds%60).padStart(2,'0')} 后变化`:'等待世界时段更新'}</span>{cycle.phase==='night'&&<small>夜间工作更费体力，AI 可自行决定休息</small>}
  </div>;
}
