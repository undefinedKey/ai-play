import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { animationFrame, characterAction, characterActionKey, movementFacing, actionPose, actionFrame } from './pixel-state.js';
import { mapDimensions, projectMapPoint } from './map-projection.js';
import { sceneDefinition } from '../shared/world-layout.js';
import { sampleMotion } from '../shared/motion.js';
import { confirmedPosition } from './scene-state.js';
import { publicName } from './observer-state.js';
import { RenderSpace, useRenderSprite } from './world-render-context.jsx';

let manifest, manifestRequest;
const manifestListeners = new Set();
function requestManifest() {
  if (!manifestRequest) manifestRequest = fetch('/pixel-world/manifest.json?v=0.19.0').then(response => {
    if (!response.ok) throw new Error('Pixel assets unavailable');
    return response.json();
  }).then(value => { manifest = value; for (const listener of manifestListeners) listener(); }).catch(() => {
    manifestRequest = null;
    setTimeout(() => { if (manifestListeners.size && !manifest) requestManifest(); }, 3000);
  });
}
const subscribeManifest = listener => { manifestListeners.add(listener); requestManifest(); return () => manifestListeners.delete(listener); };
export function usePixelManifest() { return useSyncExternalStore(subscribeManifest, () => manifest, () => undefined); }

// One shared clock for all visible sprite layers. Hidden tabs do no frame work.
let frameClock = 0, frameTimer, motionListening = false;
const serverAnchors=new Map();
const frameListeners = new Set();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function scheduleFrames() {
  clearTimeout(frameTimer);
  if (!frameListeners.size) return;
  frameClock = document.hidden || reducedMotion() ? 0 : Date.now();
  for (const listener of frameListeners) listener();
  if (frameClock) frameTimer = setTimeout(scheduleFrames, 33);
}
function subscribeFrames(listener) {
  frameListeners.add(listener);
  if (!motionListening) {
    document.addEventListener('visibilitychange', scheduleFrames);
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', scheduleFrames);
    motionListening = true;
  }
  scheduleFrames();
  return () => { frameListeners.delete(listener); if (!frameListeners.size) clearTimeout(frameTimer); };
}
const noSubscribe = () => () => {};

// Action phases must advance between server ticks as well as atlas frames.
// Only map units subscribe: the rest of the app keeps its one-second clock.
export function usePixelNow(serverNow, enabled) {
  if(!serverAnchors.has(serverNow)){serverAnchors.set(serverNow,Date.now());if(serverAnchors.size>12)serverAnchors.delete(serverAnchors.keys().next().value);}
  const localNow=serverAnchors.get(serverNow);
  const clock = useSyncExternalStore(enabled ? subscribeFrames : noSubscribe, () => enabled ? frameClock : 0, () => 0);
  return clock > 0 ? serverNow + Math.max(0, clock - localNow) : serverNow;
}

export function PixelSprite({ definition, action = 'idle', animate = false, facing = 'south', startedAt, sampledElapsed, poseFrame, className = '', itemId, toolLevel }) {
  const clock = useSyncExternalStore(animate ? subscribeFrames : noSubscribe, () => animate ? frameClock : 0, () => 0);
  const started = useRef(Date.now());
  const prior = useRef(action);
  if (prior.current !== action) { prior.current = action; started.current = Date.now(); }
  const frame = Number.isInteger(poseFrame)?actionFrame(definition,action,facing,poseFrame):animationFrame(definition, action, sampledElapsed??Math.max(0, clock - (startedAt ?? started.current)), sampledElapsed!==undefined?!reducedMotion():animate && clock > 0, facing);
  const layer=className.includes('pixel-tool')?(facing==='north'?-.03:.04):className.includes('pixel-weapon')?(facing==='north'?-.02:.03):className.includes('pixel-armor')?.01:className.includes('pixel-accessory')?.02:0;
  useRenderSprite(definition,frame,{facing,action,layer});
  if (!definition || !frame) return <span className={`pixel-sprite pixel-placeholder ${className}`} aria-hidden="true" data-asset-missing="true"/>;
  return <span aria-hidden="true" className={`pixel-sprite ${className}`} data-pixel-action={action} data-facing={facing} data-pose-frame={Number.isInteger(poseFrame)?poseFrame:undefined} data-playing={animate && clock > 0 ? 'true' : 'false'} data-item={itemId} data-tool-level={toolLevel} style={{ '--frame-w': `${frame.w}px`, '--frame-h': `${frame.h}px`, backgroundImage: `url("${definition.image}")`, backgroundSize: `calc(${definition.sheet_width}px * var(--pixel-scale, 1)) calc(${definition.sheet_height}px * var(--pixel-scale, 1))`, backgroundPosition: `calc(${-frame.x}px * var(--pixel-scale, 1)) calc(${-frame.y}px * var(--pixel-scale, 1))`, transform: facing === 'west' ? 'scaleX(-1)' : undefined }}/>
}

export function CharacterSprite({ agent, events = [], now = Date.now(), live = false, className = '', portrait = false }) {
  const assets = usePixelManifest();
  const path=agent.movement?.scene_id===agent.scene_id?agent.movement.path:null;
  const active = live && agent.status === 'active' && !portrait;
  const actionNow = usePixelNow(now, active);
  const sampled=sampleMotion(agent,actionNow);
  const facing=agent.action&&['prepare','recovery'].includes(agent.action.phase)?agent.action.facing||sampled.facing:agent.movement?.version===2?sampled.facing:agent.facing||(path?.length>1?movementFacing(path.at(-2),path.at(-1)):'south');
  const sceneEvents=events.filter(event=>(event.payload?.scene_id??event.scene_id)===agent.scene_id || (agent.scene_id==='plaza'&&event.type==='cooperation_completed'&&event.payload?.template_id==='camp_meal'));
  const walking=path?.length>1&&actionNow>=agent.movement.started_at&&actionNow<agent.movement.started_at+agent.movement.duration_ms;
  const action = !portrait ? characterAction(agent, sceneEvents, actionNow, walking) : 'idle';
  const timeline=actionPose(agent,action,actionNow);
  const key = characterActionKey(agent, sceneEvents, action);
  const pose = useRef({ key, at: Date.now() });
  if (pose.current.key !== key) pose.current = { key, at: Date.now() };
  const id = agent.appearance?.sprite_id;
  const sprite = assets?.characters?.[id];
  const equipment = agent.life?.equipment || {};
  const maintenance = ['repair','upgrade'].includes(action) && [...sceneEvents].reverse().find(event => event.payload?.agent_id === agent.agent_id && event.type === (action === 'repair' ? 'life_tool_repaired' : 'life_tool_upgraded'));
  const requestedTool = action === 'till' ? 'hoe' : action === 'water' ? 'watering_can' : maintenance?.payload?.tool_id || maintenance?.payload?.item_id;
  const tool = ['hoe','watering_can'].includes(requestedTool) ? requestedTool : null;
  const toolLevel = tool ? Math.max(1,Math.min(3,agent.life?.tools?.[tool]?.level || 1)) : null;
  const handsBusy = ['till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat'].includes(action);
  return <span className={`pixel-character ${className}`} data-sprite-id={id || 'unassigned'} data-action={action} data-facing={facing} data-action-phase={agent.action?.phase||undefined} data-action-outcome={agent.action?.outcome||undefined} style={{ '--character-accent': agent.appearance?.accent || agent.color || '#63825b' }}>
    <PixelSprite definition={sprite} action={action} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} facing={facing} animate={active && action !== 'idle'}/>
    {agent.appearance?.accessory_id && <PixelSprite className="pixel-layer pixel-accessory" itemId={agent.appearance.accessory_id} definition={assets?.accessories?.[agent.appearance.accessory_id]} action={action} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} facing={facing} animate={active && action !== 'idle'}/>}
    {['armor', 'weapon'].map(slot => equipment[slot] && !(slot === 'weapon' && handsBusy) && <PixelSprite key={slot} className={`pixel-layer pixel-${slot}`} itemId={equipment[slot]} definition={assets?.equipment?.[equipment[slot]]} action={action} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} facing={facing} animate={active && action !== 'idle'}/>)}
    {tool && <PixelSprite className="pixel-layer pixel-tool" itemId={tool} toolLevel={toolLevel} definition={assets?.tools?.[`${tool}_${toolLevel}`]} action={action} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} facing={facing} animate={active}/>}
  </span>;
}

export function PixelScene({ grid, map, sceneId='plaza', live = false, label }) {
  const assets = usePixelManifest();
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[sceneId]);
  const dimensions = mapDimensions(map);
  const scene=assets?.scenes?.[sceneId];
  useRenderSprite(scene,scene&&{x:0,y:0,w:scene.width,h:scene.height},{ground:true});
  return <div className="pixel-scene" role="img" aria-label={label||`${sceneDefinition(sceneId)?.name}，真实场景地形`} data-testid="pixel-scene" data-scene-id={sceneId} style={{ '--grid-columns': dimensions.width, '--grid-rows': dimensions.height }}>
    {scene?.image && <img src={scene.image} alt="" className="pixel-scene-image" draggable="false" onError={()=>setFailed(true)}/>}
    {!assets && <span className="pixel-scene-loading">像素场景载入中…</span>}
    {assets&&!scene&&<span className="pixel-scene-loading" role="status">当前场景素材暂不可用</span>}
    {assets&&(failed||sceneDefinition(sceneId)?.props.some(prop=>prop.kind!=='pond'&&!assets.props?.[prop.kind]))&&<span className="scene-asset-warning" role="status">部分场景素材未载入 · 角色位置仍按服务器记录显示</span>}
    {grid && <span className="pixel-grid"/>}
  </div>;
}

export function SceneProps({sceneId,map}){
  const assets=usePixelManifest();
  const scene=sceneDefinition(sceneId);
  return <>{scene?.props.filter(prop=>prop.kind!=='pond').map(prop=><RenderSpace key={prop.id} position={prop.position} depth={100+prop.position.y*10} anchor={[64,120]}><span className="scene-prop" data-prop-id={prop.id} data-prop-kind={prop.kind} data-foot-y={prop.position.y} style={{...projectMapPoint(prop.position,map),zIndex:100+prop.position.y*10}} aria-hidden="true"><PixelSprite definition={assets?.props?.[prop.kind]}/></span></RenderSpace>)}{scene&&<span className="scene-portal-label" style={projectMapPoint({...scene.portal.position,y:scene.portal.position.y-2.7},map)} role="img" aria-label={`场景入口，通往${sceneId==='plaza'?'林地冒险':'生活广场'}，仅由 AI 旅行计划通过`}>{sceneId==='plaza'?'林地 →':'← 广场'}</span>}</>;
}

export function WorldActor({agent,agents,events,now,live,selected,onSelect,map,slot,adventure=false}){
  const clock=usePixelNow(now,live&&agent.status==='active');
  const position=confirmedPosition(agent,clock,live&&!reducedMotion());
  const name=publicName(agent,agents);
  const crowded=agents.filter(a=>a.scene_id===agent.scene_id&&['active','paused'].includes(a.status)&&a.position?.x===agent.position?.x&&a.position?.y===agent.position?.y).length>1;
  return <button className={`world-actor ${adventure?'adventure-agent':'map-agent'} ${selected===agent.agent_id?'selected':''} ${agent.status==='paused'?'paused':''}`} data-speech-agent={agent.agent_id} data-testid={`${adventure?'adventure-agent':'map-agent'}-${agent.agent_id}`} data-scene-id={agent.scene_id} data-foot-x={position.x} data-foot-y={position.y} data-crowded={crowded} style={{...projectMapPoint(position,map),'--unit-map-x':`${(position.x+.5)/map.width*100}cqw`,'--unit-offset':`${slot?.x||0}px`,'--unit-row':`${slot?.y||0}px`,zIndex:101+position.y*10}} onClick={()=>onSelect(agent.agent_id)} aria-label={`查看${name}${adventure?'的冒险档案':''}，${agent.status==='paused'?'已暂停':'活动中'}`}>
    <RenderSpace position={position} depth={101+position.y*10} offset={{x:(slot?.x||0)*.55,y:(slot?.y||0)*.2}}><CharacterSprite agent={agent} events={events} now={now} live={live}/></RenderSpace><span className={adventure?'adventure-agent-name':'map-agent-name'}>{name}</span>
    {agent.hurt&&clock>=agent.hurt.started_at&&clock<agent.hurt.ends_at&&<span className="combat-number" aria-hidden="true">−{agent.hurt.damage}</span>}
    {adventure&&agent.adventure&&<span className="unit-health"><i style={{width:`${Math.max(0,Math.min(100,agent.adventure.hp/agent.adventure.max_hp*100))}%`}}/></span>}
    {agent.activity&&agent.status==='active'&&<span className="map-agent-activity">{agent.activity.name}</span>}
  </button>;
}

export function PixelFarmBackdrop() {
  const assets = usePixelManifest();
  return <div className="pixel-farm-backdrop" role="img" aria-label="营地农作区近景，水井、木篱笆与工具架">
    {assets?.farm_scene?.image ? <img className="pixel-scene-image" src={assets.farm_scene.image} alt="" draggable="false"/> : <span className="pixel-scene-loading">农作区载入中…</span>}
  </div>;
}

export function PixelTool({ id, level = 1 }) {
  const assets = usePixelManifest();
  const tier = Math.max(1,Math.min(3,level));
  return <PixelSprite definition={assets?.tool_icons?.[`${id}_${tier}_icon`]} className="pixel-tool-icon" itemId={id} toolLevel={tier}/>;
}

export function PixelCrop({ crop, state }) {
  const assets = usePixelManifest();
  return <PixelSprite definition={assets?.crops?.[crop || 'turnip']} action={state} className="pixel-crop"/>;
}

export function PixelItem({ id }) {
  const assets = usePixelManifest();
  return <PixelSprite definition={assets?.items?.[`item_${id}`]||assets?.equipment?.[id]} className="pixel-item" itemId={id}/>;
}

export function PixelLandmark({id}){
  const assets=usePixelManifest();
  return <PixelSprite definition={assets?.landmarks?.[id]} className="pixel-landmark"/>;
}

export function PixelDiscovery({id,resolved=false,animate=false}){
  const assets=usePixelManifest();
  return <PixelSprite definition={assets?.discoveries?.[id]} action={resolved?'resolved':'idle'} animate={animate} className="pixel-discovery"/>;
}
