import React, { useContext, useEffect, useRef } from 'react';
import { Fish, Clock3, X } from 'lucide-react';
import { ResourceSelection } from './Wilderness.jsx';
import { projectMapPoint } from './map-projection.js';
import { publicName, recordTime } from './observer-state.js';
import { fishingState, fishingReceipts, fishingReel } from './fishing-view-state.js';
import { usePixelNow } from './PixelWorld.jsx';
import './leisure.css';

const fishNames = { silver_fish: '银鳞鱼', river_fish: '河鱼', golden_fish: '金鳞鱼', pond_fish: '池塘鱼' };

function FishingLine({ agent, spot, map, now, live }) {
  const state = fishingState(agent, now);
  if (!state?.working) return null;
  const shore = state.interaction_position, water = spot.position, x = (shore.x + .5) * 32, y = (shore.y + .5) * 32;
  const east = water.x < shore.x, hand = { x: x + (east ? -7 : 2), y: y - 18 };
  const tip = { x: hand.x + (east ? -25 : -2), y: hand.y - 35 };
  const float = { x: (water.x + .5) * 32 + (east ? 0 : 13), y: (water.y + .5) * 32 - (east ? 0 : 7) };
  const playing = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && agent.status === 'active' && state.remaining > 0;
  return <svg className={`fishing-line ${playing ? 'fishing-live' : ''}`} data-testid={`fishing-line-${agent.agent_id}`} data-fishing-phase="fishing" data-playing={playing} viewBox={`0 0 ${map.width * 32} ${map.height * 32}`} aria-hidden="true">
    <g className="fishing-rod" style={{ transformOrigin: `${hand.x}px ${hand.y}px`, animationDelay: `-${state.elapsed}ms` }}><path d={`M${hand.x} ${hand.y} Q${tip.x + 5} ${tip.y + 10} ${tip.x} ${tip.y}`} stroke="#4f4936" strokeWidth="3" fill="none"/><path d={`M${hand.x} ${hand.y} Q${tip.x + 5} ${tip.y + 10} ${tip.x} ${tip.y}`} stroke="#aa8b58" strokeWidth="1" fill="none"/>
    <path d={`M${tip.x} ${tip.y} Q${tip.x - 3} ${float.y - 7} ${float.x} ${float.y}`} stroke="#e7e3bd" strokeOpacity=".85" strokeWidth=".8" fill="none"/></g>
    <g className="fishing-float" style={{ transformOrigin: `${float.x}px ${float.y}px` }}><ellipse cx={float.x} cy={float.y + 2} rx="7" ry="2" fill="none" stroke="#d4dfb8" strokeWidth=".8"/><ellipse className="fishing-ripple" cx={float.x} cy={float.y + 2} rx="12" ry="4" fill="none" stroke="#d4dfb8" strokeWidth=".6"/>
      <path d={`M${float.x} ${float.y - 6}v8`} stroke="#574a35" strokeWidth="1"/><path d={`M${float.x - 1.5} ${float.y - 4}h3v5h-3Z`} fill="#b76143"/><path d={`M${float.x - 1.5} ${float.y + 1}h3v2h-3Z`} fill="#eee0b6"/>
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
  return <svg className="fishing-line fishing-reel" data-testid={`fishing-reel-${agent.agent_id}`} viewBox={`0 0 ${map.width * 32} ${map.height * 32}`} aria-hidden="true"><path d={`M${endX} ${endY}l-5-30M${endX - 5} ${endY - 30}Q${x - 2} ${y - 10} ${x} ${y}`} fill="none" stroke="#b8ab7b" strokeWidth="1"/><g transform={`translate(${x},${y}) rotate(${-35 * t})`} opacity={1 - t}><path d="M-4 0Q0-5 5 0 0 5-4 0L-7-3v6Z" fill="#c1d0b8" stroke="#4a5f4f" strokeWidth=".8"/><circle cx="3" cy="-.4" r=".5" fill="#425340"/></g></svg>;
}

export function FishingLayer({ world, sceneId, map, now, live }) {
  const selection = useContext(ResourceSelection), spots = (world.fishing?.spots || []).filter(spot => spot.scene_id === sceneId);
  return <div className={`fishing-layer ${!live ? 'fishing-disconnected' : ''}`} role="group" aria-label="池边钓点">{spots.map(spot => {
    const agents = (world.agents || []).filter(agent => agent.fishing?.spot_id === spot.id && fishingState(agent, now));
    const reels = (world.agents || []).filter(agent => fishingReel(agent, spot, world.events || [], now));
    return <React.Fragment key={spot.id}><button className={`fishing-spot ${selection.selected === `fish:${spot.id}` ? 'selected' : ''}`} data-testid={`fishing-spot-${spot.id}`} style={{ ...projectMapPoint(spot.interaction_position, map), zIndex: 900 }} aria-label={`查看钓点：${spot.name}，只读`} aria-pressed={selection.selected === `fish:${spot.id}`} onClick={() => selection.select(`fish:${spot.id}`)}>
      <svg viewBox="0 0 34 42" aria-hidden="true"><ellipse cx="17" cy="39" rx="13" ry="3" fill="#354d3438"/><path d="m15 17 2 22h3l-1-22" fill="#866940" stroke="#55442e"/><path d="m3 5 27-2 1 21-27-1Z" fill="#d2bd88" stroke="#5b5139" strokeWidth="1.5"/><path d="M8 13q7-8 14 0-7 8-14 0m14 0 5-4v8Z" fill="#718b80" stroke="#505d4a" strokeWidth="1"/><circle cx="11" cy="12" r="1" fill="#403b2f"/></svg>
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
