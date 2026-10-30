import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { animationFrame, characterAction, characterActionKey, movementFacing } from './pixel-state.js';
import { mapDimensions, projectMapPoint } from './map-projection.js';

let manifest, manifestRequest;
const manifestListeners = new Set();
function requestManifest() {
  if (!manifestRequest) manifestRequest = fetch('/pixel-world/manifest.json?v=0.11.0').then(response => {
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
  clearTimeout(frameTimer);
  if (!frameListeners.size) return;
  frameClock = document.hidden || reducedMotion() ? 0 : Date.now();
  for (const listener of frameListeners) listener();
  if (frameClock) frameTimer = setTimeout(scheduleFrames, 100);
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
  const anchor = useRef({ serverNow, localNow: Date.now() });
  if (anchor.current.serverNow !== serverNow) anchor.current = { serverNow, localNow: Date.now() };
  const clock = useSyncExternalStore(enabled ? subscribeFrames : noSubscribe, () => enabled ? frameClock : 0, () => 0);
  return clock > 0 ? anchor.current.serverNow + Math.max(0, clock - anchor.current.localNow) : serverNow;
}

export function PixelSprite({ definition, action = 'idle', animate = false, facing = 'south', startedAt, className = '', itemId, toolLevel }) {
  const clock = useSyncExternalStore(animate ? subscribeFrames : noSubscribe, () => animate ? frameClock : 0, () => 0);
  const started = useRef(Date.now());
  const prior = useRef(action);
  if (prior.current !== action) { prior.current = action; started.current = Date.now(); }
  const frame = animationFrame(definition, action, Math.max(0, clock - (startedAt ?? started.current)), animate && clock > 0, facing);
  if (!definition || !frame) return <span className={`pixel-sprite pixel-placeholder ${className}`} aria-hidden="true" data-asset-missing="true"/>;
  return <span aria-hidden="true" className={`pixel-sprite ${className}`} data-pixel-action={action} data-playing={animate && clock > 0 ? 'true' : 'false'} data-item={itemId} data-tool-level={toolLevel} style={{ '--frame-w': `${frame.w}px`, '--frame-h': `${frame.h}px`, backgroundImage: `url("${definition.image}")`, backgroundSize: `calc(${definition.sheet_width}px * var(--pixel-scale, 1)) calc(${definition.sheet_height}px * var(--pixel-scale, 1))`, backgroundPosition: `calc(${-frame.x}px * var(--pixel-scale, 1)) calc(${-frame.y}px * var(--pixel-scale, 1))`, transform: facing === 'west' && action === 'walk' ? 'scaleX(-1)' : undefined }}/>
}

export function CharacterSprite({ agent, events = [], now = Date.now(), live = false, className = '', portrait = false }) {
  const assets = usePixelManifest();
  const previous = useRef(agent.position);
  const [movement, setMovement] = useState({ at: 0, facing: 'south' });
  useEffect(() => {
    const old = previous.current, next = agent.position;
    if (old && next && (old.x !== next.x || old.y !== next.y)) setMovement({ at: Date.now(), facing: movementFacing(old, next) });
    previous.current = next;
  }, [agent.position?.x, agent.position?.y]);
  const active = live && agent.status === 'active' && !portrait;
  const actionNow = usePixelNow(now, active);
  const action = active ? characterAction(agent, events, actionNow, Date.now() - movement.at < 900) : 'idle';
  const key = characterActionKey(agent, events, action);
  const pose = useRef({ key, at: Date.now() });
  if (pose.current.key !== key) pose.current = { key, at: Date.now() };
  const id = agent.appearance?.sprite_id;
  const sprite = assets?.characters?.[id];
  const equipment = agent.life?.equipment || {};
  const maintenance = ['repair','upgrade'].includes(action) && [...events].reverse().find(event => event.payload?.agent_id === agent.agent_id && event.type === (action === 'repair' ? 'life_tool_repaired' : 'life_tool_upgraded'));
  const requestedTool = action === 'till' ? 'hoe' : action === 'water' ? 'watering_can' : maintenance?.payload?.tool_id || maintenance?.payload?.item_id;
  const tool = ['hoe','watering_can'].includes(requestedTool) ? requestedTool : null;
  const toolLevel = tool ? Math.max(1,Math.min(3,agent.life?.tools?.[tool]?.level || 1)) : null;
  const handsBusy = ['till','plant','water','harvest','craft','repair','upgrade'].includes(action);
  return <span className={`pixel-character ${className}`} data-sprite-id={id || 'unassigned'} data-action={action} style={{ '--character-accent': agent.appearance?.accent || agent.color || '#63825b' }}>
    <PixelSprite definition={sprite} action={action} startedAt={pose.current.at} facing={movement.facing} animate={active && action !== 'idle'}/>
    {agent.appearance?.accessory_id && <PixelSprite className="pixel-layer pixel-accessory" itemId={agent.appearance.accessory_id} definition={assets?.accessories?.[agent.appearance.accessory_id]} action={action} startedAt={pose.current.at} facing={movement.facing} animate={active && action !== 'idle'}/>}
    {['armor', 'weapon'].map(slot => equipment[slot] && !(slot === 'weapon' && handsBusy) && <PixelSprite key={slot} className={`pixel-layer pixel-${slot}`} itemId={equipment[slot]} definition={assets?.equipment?.[equipment[slot]]} action={action} startedAt={pose.current.at} facing={movement.facing} animate={active && action !== 'idle'}/>)}
    {tool && <PixelSprite className="pixel-layer pixel-tool" itemId={tool} toolLevel={toolLevel} definition={assets?.tools?.[`${tool}_${toolLevel}`]} action={action} startedAt={pose.current.at} facing={movement.facing} animate={active}/>}
  </span>;
}

export function PixelScene({ grid, map, live = false, label = '像素世界，营地、森林与遗迹' }) {
  const assets = usePixelManifest();
  const dimensions = mapDimensions(map);
  return <div className="pixel-scene" role="img" aria-label={label} data-testid="pixel-scene" style={{ '--grid-columns': dimensions.width, '--grid-rows': dimensions.height }}>
    {assets?.scene?.image && <img src={assets.scene.image} alt="" className="pixel-scene-image" draggable="false"/>}
    {!assets && <span className="pixel-scene-loading">像素场景载入中…</span>}
    {assets?.effects?.campfire && assets.placements?.campfire && <span className="pixel-campfire" style={projectMapPoint(assets.placements.campfire,map)}><PixelSprite definition={assets.effects.campfire} animate={live}/></span>}
    {grid && <span className="pixel-grid"/>}
  </div>;
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
  return <PixelSprite definition={assets?.equipment?.[id]} className="pixel-item" itemId={id}/>;
}
