import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { animationFrame, characterAction, characterActionKey, movementFacing, actionPose, actionFrame, actorFacing } from './pixel-state.js';
import { mapDimensions, projectMapPoint } from './map-projection.js';
import { sceneDefinition } from '../shared/world-layout.js';
import { confirmedPosition } from './scene-state.js';
import { publicName } from './observer-state.js';
import { RenderSpace, useRenderSprite } from './world-render-context.jsx';
import {terrainDrawing} from './wilderness-art.js';
import {RESOURCE_NODES} from '../shared/resources-layout.js';
import {spriteAttachment,spriteGeometry,spriteNativeScale} from './render-packet.js';
import {sampleGait,animationDuration,gatheringFrameTime,actorAnimationAction,actorVisualPose,settlePose,STILL_POSE} from './actor-motion.js';
import {samplePresentationClock} from './presentation-clock.js';
import {PaperDollCharacter,usePaperDollReady} from './PaperDollCharacter.jsx';
import {selectPaperDoll} from './paper-doll-render.js';

let manifest, manifestRequest;
const manifestListeners = new Set();
function requestManifest() {
  if (!manifestRequest) manifestRequest = fetch('/pixel-world/manifest.json?v=0.30.0').then(response => {
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
const frameListeners = new Set();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function scheduleFrames() {
  cancelAnimationFrame(frameTimer);frameTimer=null;
  if (!frameListeners.size) return;
  frameClock = document.hidden || reducedMotion() ? 0 : Date.now();
  for (const listener of frameListeners) listener();
  if (frameClock&&frameListeners.size) frameTimer = requestAnimationFrame(scheduleFrames);
}
function subscribeFrames(listener) {
  frameListeners.add(listener);
  if (!motionListening) {
    document.addEventListener('visibilitychange', scheduleFrames);
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', scheduleFrames);
    motionListening = true;
  }
  if(!frameTimer)scheduleFrames();
  return () => { frameListeners.delete(listener); if (!frameListeners.size){cancelAnimationFrame(frameTimer);frameTimer=null;} };
}
const noSubscribe = () => () => {};

// Action phases must advance between server ticks as well as atlas frames.
// Only map units subscribe: the rest of the app keeps its one-second clock.
export function usePixelNow(serverNow, enabled, actor) {
  // A corrected snapshot can legitimately repeat an earlier timestamp. Reusing
  // a process-wide timestamp cache adds the old elapsed time a second time and
  // can skip a short real hurt/attack phase after a clock correction.
  const anchor=useRef({serverNow,localNow:Date.now()}),presentation=useRef(null);
  if(anchor.current.serverNow!==serverNow)anchor.current={serverNow,localNow:Date.now()};
  const clock = useSyncExternalStore(enabled ? subscribeFrames : noSubscribe, () => enabled ? frameClock : 0, () => 0);
  if(clock<=0){presentation.current=null;return serverNow;}
  presentation.current=samplePresentationClock(presentation.current,{serverTime:serverNow,receivedAt:anchor.current.localNow,localTime:clock,actor});
  return presentation.current.time;
}

// One pose sample is shared by body, clothes and held tools. Neither the local
// gait odometer nor the small body transforms can move the actor's world point.
export function useActorMotion(actor,action,now,{enabled=false,facing='south',definition,events=[],animationAction=action}={}){
  const gait=useRef(null),transition=useRef(null);
  const playing=enabled&&!document.hidden&&!reducedMotion();
  const timeline=actionPose(actor,action,now,events);
  const actionElapsed=timeline.elapsed;
  let phase=0;
  if(playing&&['walk','run'].includes(action)){
    const sampled=sampleGait(actor,now,gait.current);gait.current=sampled.state;phase=sampled.phase;
    if(sampled.moving)timeline.elapsed=phase*animationDuration(definition,animationAction,facing);
  }
  const job=actor.life?.gathering;
  if((action==='gather'||action==='plant'&&job?.intent==='plant')&&Number.isFinite(timeline.elapsed))timeline.elapsed=gatheringFrameTime(actor,timeline.elapsed,definition,animationAction,facing);
  const frame=Number.isInteger(timeline.frame)?actionFrame(definition,animationAction,facing,timeline.frame):animationFrame(definition,animationAction,timeline.elapsed??0,playing,facing);
  const target=actorVisualPose(actor,action,now,{facing,gaitPhase:phase,enabled:playing,definition,frame});
  if(!playing){transition.current=null;return {...timeline,actionElapsed,gaitPhase:0,playing:false,pose:STILL_POSE};}
  const settled=settlePose(transition.current,action,target,now);transition.current=settled.state;
  return {...timeline,actionElapsed,gaitPhase:phase,playing:true,pose:settled.pose};
}

export function PixelSprite({ definition, action = 'idle', animationAction=action, animate = false, facing = 'south', startedAt, sampledElapsed, poseFrame, visualPose, className = '', itemId, toolLevel, attachTo,sourceFrame,layer:explicitLayer,rigPart,attachmentSlot,textureDependency,sourceRotation }) {
  const clock = useSyncExternalStore(animate ? subscribeFrames : noSubscribe, () => animate ? frameClock : 0, () => 0);
  const started = useRef(Date.now());
  const prior = useRef(action);
  if (prior.current !== action) { prior.current = action; started.current = Date.now(); }
  const selectFrame=source=>Number.isInteger(poseFrame)?actionFrame(source,animationAction,facing,poseFrame):animationFrame(source, animationAction, sampledElapsed??Math.max(0, clock - (startedAt ?? started.current)), sampledElapsed!==undefined?!reducedMotion():animate && clock > 0, facing);
  const frame=sourceFrame||selectFrame(definition),attachment=attachTo&&definition?.render_style==='ink'?spriteAttachment(attachTo.definition,selectFrame(attachTo.definition),definition.attachment_slot||attachTo.slot,facing):textureDependency||Number.isFinite(sourceRotation)?{image:textureDependency,rotation:sourceRotation||0}:null;
  const layer=Number.isFinite(explicitLayer)?explicitLayer:className.includes('pixel-tool')?(facing==='north'?-.03:.04):className.includes('pixel-weapon')?(facing==='north'?-.02:.03):className.includes('pixel-armor')?.01:className.includes('pixel-accessory')?.02:0;
  const worldGeometry=useRenderSprite(definition,frame,{facing,action,layer,attachment,pose:visualPose});
  if (!definition || !frame) return <span className={`pixel-sprite pixel-placeholder ${className}`} aria-hidden="true" data-asset-missing="true"/>;
  const unit=spriteNativeScale(definition,frame),ink=definition.render_style==='ink'||definition.native_scale;
  const logical=definition.logical_anchor,anchored=!!logical||!!rigPart||!!attachmentSlot||!!worldGeometry&&['pixel-landmark','pixel-discovery'].includes(className),geometry=worldGeometry||(attachment||logical||visualPose?spriteGeometry(definition,frame,logical?[logical.x,logical.y]:[24,43],facing,attachment,visualPose):null);
  return <span aria-hidden="true" className={`pixel-sprite ${ink?'ink-sprite':''} ${className}`} data-art-style={ink?'ink':'pixel'} data-pixel-action={action} data-animation-action={animationAction} data-facing={facing} data-pose-frame={Number.isInteger(poseFrame)?poseFrame:undefined} data-playing={animate && clock > 0 ? 'true' : 'false'} data-item={itemId} data-tool-level={toolLevel} data-rig-part={rigPart} data-source-rotation={rigPart?sourceRotation:undefined} data-attachment-slot={attachmentSlot} data-rig-x={rigPart||attachmentSlot?visualPose?.x:undefined} data-rig-y={rigPart||attachmentSlot?visualPose?.y:undefined} data-rig-rotation={rigPart||attachmentSlot?visualPose?.rotation:undefined} style={{ zIndex:Number.isFinite(explicitLayer)?Math.round(explicitLayer*10000):undefined,position:anchored?'absolute':undefined,left:anchored?0:undefined,top:anchored?0:undefined,'--frame-w': `${frame.w*unit}px`, '--frame-h': `${frame.h*unit}px`, backgroundImage: `url("${frame.image||definition.image}")`, backgroundSize: `calc(${(frame.sheet_width||definition.sheet_width)*unit}px * var(--pixel-scale, 1)) calc(${(frame.sheet_height||definition.sheet_height)*unit}px * var(--pixel-scale, 1))`, backgroundPosition: `calc(${-frame.x*unit}px * var(--pixel-scale, 1)) calc(${-frame.y*unit}px * var(--pixel-scale, 1))`,translate:geometry?`calc(${geometry.offset.x}px * var(--pixel-scale,1)) calc(${geometry.offset.y}px * var(--pixel-scale,1))`:undefined,transformOrigin:geometry?`calc(${geometry.domAnchor[0]*unit}px * var(--pixel-scale,1)) calc(${geometry.domAnchor[1]*unit}px * var(--pixel-scale,1))`:undefined,transform:geometry?.matrix?`matrix(${geometry.matrix.join(',')},0,0)`:`scaleX(${facing==='west'?-1:1})` }}/>
}

export function CharacterSprite({ agent, events = [], now = Date.now(), live = false, className = '', portrait = false }) {
  const assets = usePixelManifest();
  const path=agent.movement?.scene_id===agent.scene_id?agent.movement.path:null;
  const active = live && agent.status === 'active' && !portrait;
  const actionNow = usePixelNow(now, active, agent);
  const sceneEvents=events.filter(event=>(event.payload?.scene_id??event.scene_id)===agent.scene_id || (agent.scene_id==='plaza'&&event.type==='cooperation_completed'&&event.payload?.template_id==='camp_meal'));
  const walking=path?.length>1&&actionNow>=agent.movement.started_at&&actionNow<agent.movement.started_at+agent.movement.duration_ms;
  const action = !portrait ? characterAction(agent, sceneEvents, actionNow, walking) : 'idle';
  const facing=portrait?'south':actorFacing(agent,action,actionNow,path?.length>1?movementFacing(path.at(-2),path.at(-1)):'south');
  const id = agent.appearance?.sprite_id;
  const sprite = assets?.characters?.[id];
  const selectedRig=selectPaperDoll(assets,agent),rigReady=usePaperDollReady(selectedRig);
  const animationAction=actorAnimationAction(agent,action);
  const timeline=useActorMotion(agent,action,actionNow,{enabled:active,facing,definition:sprite,events:sceneEvents,animationAction});
  const key = characterActionKey(agent, sceneEvents, action);
  const pose = useRef({ key, at: Date.now() });
  if (pose.current.key !== key) pose.current = { key, at: Date.now() };
  const equipment = agent.life?.equipment || {};
  const maintenance = ['repair','upgrade'].includes(action) && [...sceneEvents].reverse().find(event => event.payload?.agent_id === agent.agent_id && event.type === (action === 'repair' ? 'life_tool_repaired' : 'life_tool_upgraded'));
  const requestedTool = action === 'gather'?agent.life?.gathering?.tool_id:action === 'till' ? 'hoe' : action === 'water' ? 'watering_can' : maintenance?.payload?.tool_id || maintenance?.payload?.item_id;
  const tool = ['hoe','watering_can','axe','pickaxe'].includes(requestedTool) ? requestedTool : null;
  const toolLevel = tool ? Math.max(1,Math.min(3,agent.life?.tools?.[tool]?.level || 1)) : null;
  const handsBusy = ['till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat','fish'].includes(action);
  return <span className={`pixel-character ${className}`} data-render-rig={rigReady?selectedRig.id:undefined} data-sprite-id={id || 'unassigned'} data-action={action} data-facing={facing} data-action-phase={agent.action?.phase||undefined} data-action-outcome={agent.action?.outcome||undefined} style={{ '--character-accent': agent.appearance?.accent || agent.color || '#63825b' }}>
    {rigReady?<PaperDollCharacter selection={selectedRig} agent={agent} assets={assets} action={action} now={actionNow} facing={facing} timeline={timeline} tool={tool} toolLevel={toolLevel} handsBusy={handsBusy} portrait={portrait} Sprite={PixelSprite}/>:<>
    <PixelSprite definition={sprite} action={action} animationAction={animationAction} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} visualPose={timeline.pose} facing={facing} animate={active && action !== 'idle'}/>
    {agent.appearance?.accessory_id && <PixelSprite className="pixel-layer pixel-accessory" attachTo={{definition:sprite,slot:'head'}} itemId={agent.appearance.accessory_id} definition={assets?.accessories?.[agent.appearance.accessory_id]} action={action} animationAction={animationAction} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} visualPose={timeline.pose} facing={facing} animate={active && action !== 'idle'}/>}
    {['armor', 'weapon'].map(slot => equipment[slot] && !(slot === 'weapon' && handsBusy) && <PixelSprite key={slot} className={`pixel-layer pixel-${slot}`} attachTo={{definition:sprite,slot:slot==='armor'?'chest':'hand'}} itemId={equipment[slot]} definition={assets?.equipment?.[equipment[slot]]} action={action} animationAction={animationAction} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} visualPose={timeline.pose} facing={facing} animate={active && action !== 'idle'}/>)}
    {tool && <PixelSprite className="pixel-layer pixel-tool" attachTo={{definition:sprite,slot:'hand'}} itemId={tool} toolLevel={toolLevel} definition={assets?.tools?.[`${tool}_${toolLevel}`]} action={action} animationAction={animationAction} startedAt={pose.current.at} sampledElapsed={timeline.elapsed} poseFrame={timeline.frame} visualPose={timeline.pose} facing={facing} animate={active}/>}
    </>}
  </span>;
}

export function PixelScene({ grid, map, sceneId='plaza', live = false, label }) {
  const assets = usePixelManifest();
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[sceneId]);
  const dimensions = mapDimensions(map);
  const scene=assets?.scenes?.[sceneId];
  useRenderSprite(scene,scene&&{x:0,y:0,w:scene.width,h:scene.height},{ground:true});
  const terrain=terrainDrawing(sceneId,assets?.render_style==='ink'),svgPoints=points=>points.map(p=>p.x+','+p.y).join(' ');
  return <div className="pixel-scene" role="img" aria-label={label||`${sceneDefinition(sceneId)?.name}，真实场景地形`} data-testid="pixel-scene" data-scene-id={sceneId} style={{ '--grid-columns': dimensions.width, '--grid-rows': dimensions.height }}>
    {scene?.image && <img src={scene.image} alt="" className="pixel-scene-image" draggable="false" onError={()=>setFailed(true)}/>}
    {scene?.terrain_overlay!==false&&<svg className="wilderness-terrain" viewBox={`0 0 ${dimensions.width*32} ${dimensions.height*32}`} aria-hidden="true">
      <rect width="100%" height="100%" fill={terrain.wash[0]} opacity={terrain.wash[1]}/>
      {terrain.fills.map((paint,i)=><polygon key={i} points={svgPoints(paint.points)} fill={paint.color} fillOpacity={paint.alpha}/>)}
      {terrain.strokes.map((line,i)=><polyline key={i} points={svgPoints(line.points)} fill="none" stroke={line.color} strokeWidth={line.width} opacity={line.alpha}/>)}
    </svg>}
    {!assets && <span className="pixel-scene-loading">荒野场景载入中…</span>}
    {assets&&!scene&&<span className="pixel-scene-loading" role="status">当前场景素材暂不可用</span>}
    {assets&&(failed||sceneDefinition(sceneId)?.props.some(prop=>prop.kind!=='pond'&&!assets.props?.[prop.kind]))&&<span className="scene-asset-warning" role="status">部分场景素材未载入 · 角色位置仍按服务器记录显示</span>}
    {grid && <span className="pixel-grid"/>}
  </div>;
}

export function SceneProps({sceneId,map}){
  const assets=usePixelManifest();
  const scene=sceneDefinition(sceneId);
  const inkKinds={pine:'pine',pine_tall:'pine',oak:'oak',birch:'oak',apple:'oak',dead_tree:assets?.wilderness?.dead_tree?'dead_tree':'stump',rock:assets?.wilderness?.stones?'stones':'ore',rock_large:'ore'};
  return <>{scene?.props.filter(prop=>!(sceneId==='ruins'&&prop.id.startsWith('fixture_'))&&prop.kind!=='pond'&&!RESOURCE_NODES.some(n=>n.kind==='tree'&&n.scene_id===sceneId&&n.position.x===prop.position.x&&n.position.y===prop.position.y)).map(prop=>{const kind=['pine','pine_tall','oak','birch','apple'].includes(prop.kind)?'dead_tree':prop.kind;const definition=assets?.wilderness?.[inkKinds[kind]]||assets?.props?.[prop.kind],unit=definition?.native_scale||1,anchor=definition?.native_scale?[definition.anchor.x*unit,definition.anchor.y*unit]:[64,120];return <RenderSpace key={prop.id} position={prop.position} depth={100+prop.position.y*10} anchor={anchor}><span className={`scene-prop ${definition?.native_scale?'ink-prop':''}`} data-prop-id={prop.id} data-prop-kind={prop.kind} data-foot-y={prop.position.y} style={{...projectMapPoint(prop.position,map),zIndex:100+prop.position.y*10,'--prop-anchor-x':`${anchor[0]}px`,'--prop-anchor-y':`${anchor[1]}px`}} aria-hidden="true"><PixelSprite definition={definition}/></span></RenderSpace>;})}{scene&&<span className="scene-portal-label" style={projectMapPoint({...scene.portal.position,y:scene.portal.position.y-2.7},map)} role="img" aria-label={`场景入口，通往${sceneDefinition(scene.portal.to_scene_id)?.name||'其他场景'}，仅由 AI 旅行计划通过`}>{sceneId==='plaza'?'林地 →':sceneId==='ruins'?'← 林地':'← 广场'}</span>}</>;
}

export function WorldActor({agent,agents,events,now,live,selected,onSelect,map,slot,adventure=false}){
  const clock=usePixelNow(now,live&&agent.status==='active',agent);
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
  return <div className="pixel-farm-backdrop" data-art-style={assets?.farm_scene?.render_style||assets?.render_style||'pixel'} role="img" aria-label="营地农作区近景，木篱笆与工具棚">
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
  return <PixelSprite definition={assets?.items?.[`item_${id}`]||assets?.tool_icons?.[`${id}_1_icon`]||assets?.equipment?.[id]} className="pixel-item" itemId={id}/>;
}

export function PixelLandmark({id}){
  const assets=usePixelManifest();
  return <PixelSprite definition={assets?.landmarks?.[id]} className="pixel-landmark"/>;
}

export function PixelDiscovery({id,resolved=false,animate=false}){
  const assets=usePixelManifest();
  return <PixelSprite definition={assets?.discoveries?.[id]} action={resolved?'resolved':'idle'} animate={animate} className="pixel-discovery"/>;
}
