import React from 'react';
import { CharacterSprite, PixelSprite, usePixelManifest } from './PixelWorld.jsx';
import { usePaperDollReady } from './PaperDollCharacter.jsx';
import { paperDollLayers, selectPaperDoll } from './paper-doll-render.js';
import { sampleHomeUsePose } from './home-use-pose.js';
import { homeSeatAnchor, homeUsePresentationStyle } from './home-state.js';

function HeldProp({ value, facing }) {
  if (!value) return null;
  return <svg className="home-held-prop" viewBox="-10 -8 20 16" aria-hidden="true" data-home-prop={value.kind}
    style={{ left: `calc((24px + ${value.x}px) * var(--pixel-scale))`, top: `calc((43px + ${value.y}px) * var(--pixel-scale))`, zIndex: facing === 'north' ? -100 : 100, rotate: `${value.tilt || 0}rad` }}>
    {value.kind === 'book' ? <g stroke="#624b34" strokeWidth=".8" strokeLinejoin="round"><path d="M-9-5q4-2 9 1 5-3 9-1v10Q4 3 0 6q-5-3-9-1Z" fill="#e8d5a0"/><path d="M0-4V6M-7-2l5 1M2-1l5-1M-7 1l5 1M2 2l5-1" fill="none" opacity=".8"/></g>
      : <g stroke="#77523c" strokeWidth=".8"><ellipse cx="0" cy="5" rx="8" ry="2" fill="#7d665344" stroke="none"/><path d="M-8-1q1 8 8 8t8-8Z" fill="#e9d3a3"/><ellipse cx="0" cy="-1" rx="8" ry="3" fill="#b9894c"/><circle cx="-3" cy="-1" r="1" fill="#84955c"/><circle cx="3" cy="0" r="1.2" fill="#d3a759"/></g>}
  </svg>;
}

/** This renderer only replaces a confirmed using pose. Walking continues to
 * use the shared distance-driven game rig, including its original identity. */
export function HomeCharacter({ agent, activity, furniture, now, live, presentationStyle }) {
  const assets = usePixelManifest(), selection = selectPaperDoll(assets, agent), ready = usePaperDollReady(selection);
  const using = activity?.phase === 'using';
  const seat = homeSeatAnchor(agent, furniture), facing = seat?.facing || agent.facing || 'south';
  const enabled = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!using) return <CharacterSprite agent={agent} now={now} live={live}/>;
  const sample = sampleHomeUsePose(agent, activity, now, { facing, enabled, furnitureKind: furniture?.kind, rig: selection?.rig });
  const seatStyle = presentationStyle || homeUsePresentationStyle(agent, furniture, now, enabled, sample.dimensions.hipHeight);
  const layers = ready ? paperDollLayers(selection.rig, sample, assets, agent, { facing, handsBusy: true }) : [];
  if (!ready) return <span className="home-use-fallback" data-home-use={activity.kind}><CharacterSprite agent={agent} now={now} live={false}/><HeldProp value={sample.homeProp} facing={facing}/></span>;
  return <span className="pixel-character home-use-character" style={seatStyle} data-sprite-id={agent.appearance?.sprite_id || 'unassigned'} data-render-rig={selection.id} data-action={activity.kind} data-facing={facing} data-home-use={activity.kind}>
    <span className="paper-doll-rig" data-rig-id={selection.id} data-facing={facing} data-action={activity.kind} data-playing={sample.playing ? 'true' : 'false'} style={{ display: 'contents' }}>
      {layers.map(layer => <PixelSprite key={layer.key} definition={layer.definition} sourceFrame={layer.frame} visualPose={layer.pose} sourceRotation={layer.sourceRotation} layer={layer.layer} rigPart={layer.part} attachmentSlot={layer.slot} textureDependency={layer.textureDependency} className={layer.className} itemId={layer.itemId} action={activity.kind} facing={facing}/>) }
    </span><HeldProp value={sample.homeProp} facing={facing}/>
  </span>;
}
