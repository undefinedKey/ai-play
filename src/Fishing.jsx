import React, { useContext, useEffect, useRef } from 'react';
import { Fish, Clock3, X } from 'lucide-react';
import { ResourceSelection } from './Wilderness.jsx';
import { projectMapPoint } from './map-projection.js';
import { publicName, recordTime } from './observer-state.js';
import { fishingState, fishingReceipts, fishingReel } from './fishing-view-state.js';
import { usePixelNow } from './PixelWorld.jsx';
import './leisure.css';

const fishNames = { silver_fish: '银鳞鱼', river_fish: '河鱼', golden_fish: '金鳞鱼', pond_fish: '池塘鱼' };

function PixelStroke({from,to,color,width=1}){
  const dx=to.x-from.x,dy=to.y-from.y,steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))));
  return Array.from({length:steps+1},(_,i)=><rect key={i} x={Math.round(from.x+dx*i/steps)} y={Math.round(from.y+dy*i/steps)} width={width} height={width} fill={color}/>);
}

function FishingLine({ agent, spot, map, now, live }) {
  const state = fishingState(agent, now);
  if (!state?.working) return null;
  const shore = state.interaction_position, water = spot.position, x = (shore.x + .5) * 32, y = (shore.y + .5) * 32;
  const east = water.x < shore.x, hand = { x: x + (east ? -7 : 2), y: y - 18 };
  const tip = { x: hand.x + (east ? -25 : -2), y: hand.y - 35 };
  const float = { x: (water.x + .5) * 32 + (east ? 0 : 13), y: (water.y + .5) * 32 - (east ? 0 : 7) };
  const playing = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && agent.status === 'active' && state.remaining > 0;
  return <svg className={`fishing-line ${playing ? 'fishing-live' : ''}`} data-testid={`fishing-line-${agent.agent_id}`} data-fishing-phase="fishing" data-playing={playing} shapeRendering="crispEdges" viewBox={`0 0 ${map.width * 32} ${map.height * 32}`} aria-hidden="true">
    <g className="fishing-rod" style={{ transformOrigin: `${hand.x}px ${hand.y}px`, animationDelay: `-${state.elapsed}ms` }}><PixelStroke from={hand} to={tip} color="#634632" width={3}/><PixelStroke from={hand} to={tip} color="#e5a85b"/>
    <PixelStroke from={tip} to={float} color="#fff9e8"/></g>
    <g className="fishing-float" style={{ transformOrigin: `${float.x}px ${float.y}px` }} transform={`translate(${Math.round(float.x)} ${Math.round(float.y)})`}>
      <path fill="#a9dce0" d="M-7 3h14v1h-14z"/><path className="fishing-ripple" fill="#a9dce0" d="M-10 1h4v1h-4zM6 1h4v1H6zM-6 5H6v1H-6z"/>
      <path fill="#634632" d="M0-7h1V3H0z"/><path fill="#df7f61" d="M-1-5h3v5h-3z"/><path fill="#fff9e8" d="M-1 0h3v3h-3z"/>
    </g>
  </svg>;
}

function FishingReelVisual({ agent, spot, world, map, now, live }) {
  const enabled = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clock = usePixelNow(now, enabled, agent), state = fishingReel(agent, spot, world.events || [], clock);
  if (!enabled || !state) return null;
  const t = state.progress, endX = (agent.position.x + .5) * 32, endY = (agent.position.y + .5) * 32 - 20;
  const waterX = (spot.position.x + .5) * 32 + (agent.facing === 'north' ? 13 : 0), waterY = (spot.position.y + .5) * 32;
  const x = waterX + (endX - waterX) * t, y = waterY + (endY - waterY) * t - Math.sin(Math.PI * t) * 15;
  return <svg className="fishing-line fishing-reel" data-testid={`fishing-reel-${agent.agent_id}`} viewBox={`0 0 ${map.width * 32} ${map.height * 32}`} shapeRendering="crispEdges" aria-hidden="true"><PixelStroke from={{x:endX,y:endY}} to={{x:endX-5,y:endY-30}} color="#b97742" width={2}/><PixelStroke from={{x:endX-5,y:endY-30}} to={{x,y}} color="#fff9e8"/><g transform={`translate(${Math.round(x)},${Math.round(y)})`} opacity={1-t}><path fill="#426849" d="M-4-2h8v1h2v3H4v1h-8V1h-2V3h-2v-6h2v2h2z"/><path fill="#a9dce0" d="M-3-1h6v3h-6z"/><path fill="#fff9e8" d="M-2-1h4v1h-4z"/><path fill="#304d3b" d="M2 0h1v1H2z"/></g></svg>;
}

export function FishingLayer({ world, sceneId, map, now, live }) {
  const selection = useContext(ResourceSelection), spots = (world.fishing?.spots || []).filter(spot => spot.scene_id === sceneId);
  return <div className={`fishing-layer ${!live ? 'fishing-disconnected' : ''}`} role="group" aria-label="池边钓点">{spots.map(spot => {
    const agents = (world.agents || []).filter(agent => agent.fishing?.spot_id === spot.id && fishingState(agent, now));
    const reels = (world.agents || []).filter(agent => fishingReel(agent, spot, world.events || [], now));
    return <React.Fragment key={spot.id}><button className={`fishing-spot ${selection.selected === `fish:${spot.id}` ? 'selected' : ''}`} data-testid={`fishing-spot-${spot.id}`} style={{ ...projectMapPoint(spot.interaction_position, map), zIndex: 900 }} aria-label={`查看钓点：${spot.name}，只读`} aria-pressed={selection.selected === `fish:${spot.id}`} onClick={() => selection.select(`fish:${spot.id}`)}>
      <svg viewBox="0 0 26 32" shapeRendering="crispEdges" aria-hidden="true"><path fill="#426849" d="M4 29h18v2H4z"/><path fill="#634632" d="M11 14h4v16h-4zM2 2h22v17H2z"/><path fill="#b97742" d="M12 19h2v10h-2z"/><path fill="#ffcd7a" d="M4 4h18v13H4z"/><path fill="#426849" d="M7 8h9v1h2V7h2v7h-2v-2h-2v1H7v-1H5V9h2z"/><path fill="#73b8c9" d="M7 9h8v3H7z"/><path fill="#304d3b" d="M8 9h1v1H8z"/></svg>
      <span>{spot.name}<small>{agents.some(agent => fishingState(agent, now)?.working) ? '正在垂钓' : agents.length ? '有人正走来' : '岸边空闲'}</small></span>
    </button>{agents.map(agent => <FishingLine key={agent.agent_id} agent={agent} spot={spot} map={map} now={now} live={live}/>)}{reels.map(agent => <FishingReelVisual key={`reel-${agent.agent_id}`} agent={agent} spot={spot} world={world} map={map} now={now} live={live}/>)}</React.Fragment>;
  })}</div>;
}

export function FishingInspector({ world, selected, onClose, now, live }) {
  const title = useRef(null), id = selected?.startsWith('fish:') ? selected.slice(5) : null, spot = world.fishing?.spots?.find(value => value.id === id);
  useEffect(() => { if (spot) title.current?.focus(); }, [id]);
  if (!spot) return null;
  const worker = world.agents.find(agent => agent.fishing?.spot_id === id && fishingState(agent, now)), state = fishingState(worker, now), receipts = fishingReceipts(world, id);
  return <section className="resource-inspector fishing-inspector" data-testid="fishing-inspector" aria-labelledby="fishing-heading" onKeyDown={event => { if (event.key === 'Escape') { onClose(); document.querySelector(`[data-testid="fishing-spot-${id}"]`)?.focus(); } }}>
    <div className="resource-inspector-title"><Fish size={22}/><div><h3 id="fishing-heading" ref={title} tabIndex={-1}>{spot.name}</h3><span>池塘岸边 · ({spot.interaction_position.x}, {spot.interaction_position.y})</span></div><button aria-label="关闭钓点详情" onClick={onClose}><X size={18}/></button></div>
    <div className="resource-facts"><span>钓竿 · 鱼饵</span><span><Clock3 size={14}/>到岸后约 {spot.duration_seconds} 秒</span></div>
    <p role="status">{!live ? '最近记录 · ' : ''}{worker ? `${publicName(worker, world.agents)}${state.working ? state.remaining ? '正在安静等鱼' : '等待服务器确认结果' : '正沿小路走向岸边'}` : '此刻岸边空闲。'}</p>
    {state?.working && <progress aria-label="本次垂钓进度" value={state.progress} max="1"/>}
    {receipts.length > 0 && <div className="fishing-receipts"><h4>最近的垂钓记录</h4><ol>{receipts.map(event => <li key={event.event_id}><span>{event.payload.name || world.agents.find(agent => agent.agent_id === event.payload.agent_id)?.name || '一位 AI'} · {event.payload.item_id ? `钓到${fishNames[event.payload.item_id] || event.payload.item_name || '一条鱼'}` : '这次没有钓到鱼'}</span><time>{recordTime(event.occurred_at, now)}</time></li>)}</ol></div>}
    <small>这里只看真实公开记录。是否钓鱼、何时离开以及鱼获用途，由 AI 自己决定。</small>
  </section>;
}
