import React, { useEffect, useRef, useState } from 'react';
import { DoorOpen, Landmark, X } from 'lucide-react';
import { RUINS_RULES } from '../shared/ruins-layout.js';
import { PixelScene, PixelSprite, SceneProps, WorldActor } from './PixelWorld.jsx';
import PhaserWorld from './PhaserWorld.jsx';
import { RenderSpace } from './world-render-context.jsx';
import { MapCamera } from './Observer.jsx';
import SpeechOverlay from './SpeechOverlay.jsx';
import { sceneActors } from './scene-state.js';
import { nearbySlots, publicName, recordTime } from './observer-state.js';
import { projectMapPoint } from './map-projection.js';
import { ruinsArtwork, ruinsObjectState } from './ruins-state.js';
import './ruins.css';

export function RuinsEntrance({ map, onView }) {
  return <button type="button" className="ruins-view-entrance" data-testid="ruins-entrance" style={projectMapPoint(RUINS_RULES.entrance.position, map)} onClick={onView} aria-label="旁观林间遗迹，只切换画面"><Landmark size={15}/><span>旁观遗迹</span></button>;
}

function RuinsObjects({ ruins, map, now, live, selected, onSelect }) {
  return <div className="ruins-objects" role="group" aria-label="遗迹中的真实机关与遗物">{ruins.objects.map(object => {
    const state = ruinsObjectState(ruins, object, now), chosen = selected === object.id;
    return <button key={object.id} type="button" className={`ruins-object ruins-object-${object.kind} ruins-state-${state.key} ${chosen ? 'selected' : ''}`} style={{ ...projectMapPoint(object.position, map), zIndex: 100 + object.position.y * 10 }} data-testid={`ruins-object-${object.id}`} data-ruins-state={state.key} data-rune-symbol={state.symbol} data-scene-id="ruins" aria-label={`查看${object.name}，${state.label}，只读`} aria-pressed={chosen} onClick={() => onSelect(object.id)}>
      <RenderSpace position={object.position} depth={100 + object.position.y * 10} anchor={[32, 52]}><span className="ruins-object-art"><PixelSprite definition={ruinsArtwork(object, state)}/></span></RenderSpace>
      <span className="ruins-object-ring" aria-hidden="true"/>
      {state.key === 'repairing' && <span className={`ruins-repair-progress ${live ? 'live' : ''}`} aria-hidden="true"><i style={{ width: `${state.progress * 100}%` }}/></span>}
      <span className="ruins-object-label">{object.name}<small>{state.label}</small></span>
    </button>;
  })}</div>;
}

function RuinsInspector({ world, object, now, live, onClose }) {
  const heading = useRef(null);
  useEffect(() => { if (object) heading.current?.focus(); }, [object?.id]);
  if (!object) return null;
  const state = ruinsObjectState(world.ruins, object, now), claimant = world.agents.find(agent => agent.agent_id === state.claimant);
  const close = () => { onClose(); document.querySelector(`[data-testid="ruins-object-${object.id}"]`)?.focus(); };
  return <section className="ruins-inspector" data-testid="ruins-inspector" aria-labelledby="ruins-object-heading" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <div className="ruins-inspector-heading"><Landmark size={20}/><div><h3 id="ruins-object-heading" ref={heading} tabIndex={-1}>{object.name}</h3><span>林间遗迹 · ({object.position.x}, {object.position.y})</span></div><button type="button" aria-label="关闭遗迹详情" onClick={close}><X size={18}/></button></div>
    <p data-testid="ruins-object-status">{!live ? '最近记录 · ' : ''}{state.label}{claimant ? ` · ${publicName(claimant, world.agents)}` : ''}{state.at ? ` · ${recordTime(state.at, now)}` : ''}</p>
    {object.kind === 'bridge' && <p>修复需要木材 {RUINS_RULES.bridge_cost.wood}、矿石 {RUINS_RULES.bridge_cost.ore}，工作 {RUINS_RULES.repair_seconds} 秒。只有服务器确认修复完成后，桥面才通行。</p>}
    {object.kind === 'gate' && <p>苔纹铜钥匙用于开启正门；打开后，所有到访者共享这条通路。</p>}
    {object.kind === 'mural' && <blockquote>{world.ruins.runes?.clue || '尚未收到壁画文字。'}</blockquote>}
    {object.kind === 'dial' && <p>这里只显示石盘目前朝向。转动、组合与是否检验，由原 AI 自行决定。</p>}
    {object.kind === 'runes' && <p>{world.ruins.runes?.last_attempt ? `最近一次检验：${world.ruins.runes.last_attempt.success ? '已通过' : '未通过'}。` : '尚无检验记录。'}检验结果决定内室石门是否打开。</p>}
    {object.kind === 'relic' && <p>这是世界中唯一的一件实物。取走后展台留空，持有者可自行决定带回小屋展示。</p>}
    <small>旁观者只查看记录。走近、操作机关和拾取物品，都由 AI 发起。</small>
  </section>;
}

export default function RuinsMap({ world, selected, onSelect, grid, live, now, onView }) {
  const [objectId, setObjectId] = useState(null), ruins = world.ruins;
  const map = RUINS_RULES.map, present = sceneActors(world.agents, 'ruins'), slots = nearbySlots(present);
  const time = live ? now : Number(world.server_time) || now;
  const object = ruins?.objects?.find(item => item.id === objectId);
  const claimed = ruins?.relics?.filter(item => item.claimed_by).length || 0;
  return <><div className="map-scene-frame"><MapCamera status={!present.length && <div className="scene-empty" data-testid="ruins-empty-banner" role="status">此刻遗迹里没有 AI · 机关与遗物状态仍然保留</div>} speech={{ events: world.events, agents: present, selected, now: time, live, sceneId: 'ruins' }}><div className="ruins-map pixel-map" data-testid="ruins-map" style={{ aspectRatio: `${map.width} / ${map.height}` }}>
    <PhaserWorld sceneId="ruins" live={live} cycle={world.day_cycle} survival={world.survival}>
      <PixelScene sceneId="ruins" grid={grid} map={map} live={live}/><SceneProps sceneId="ruins" map={map}/>
      <div className="scene-caption"><strong>林间遗迹</strong><span>{present.length} 位在场 · 已取走 {claimed} / {ruins?.relics?.length || 3} 件遗物</span></div>
      {ruins?.objects && <RuinsObjects ruins={ruins} map={map} now={time} live={live} selected={objectId} onSelect={setObjectId}/>}
      {!ruins && <span className="ruins-awaiting" role="status">遗迹状态尚未收到，等待同步</span>}
      <button type="button" className="ruins-view-entrance ruins-exit-view" style={projectMapPoint(RUINS_RULES.exit.position, map)} data-testid="ruins-exit-view" onClick={() => onView('adventure')} aria-label="旁观林地，只切换画面"><DoorOpen size={15}/><span>查看林地</span></button>
      {present.map(agent => <WorldActor key={agent.agent_id} agent={agent} agents={world.agents} events={world.events} now={time} live={live} selected={selected} onSelect={onSelect} map={map} slot={slots.get(agent.agent_id)}/>)}
    </PhaserWorld>
  </div></MapCamera><SpeechOverlay events={world.events} agents={world.agents} selected={selected} now={time} live={live}/></div>
  <div className="ruins-route-status" data-testid="ruins-route-status" aria-label="遗迹通路状态"><span>{!live ? '最近记录 · ' : ''}正门：{ruins ? ruins.gate?.open ? '已打开' : '上锁' : '未收到'}</span><span>侧桥：{ruins ? ruins.bridge?.repaired ? '已修复' : ruins.bridge?.job ? '修复中' : '断裂' : '未收到'}</span><span>内室：{ruins ? ruins.runes?.solved ? '已打开' : '封闭' : '未收到'}</span></div>
  <RuinsInspector world={world} object={object} now={time} live={live} onClose={() => setObjectId(null)}/></>;
}
