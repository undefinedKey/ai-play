import React from 'react';
import { CharacterSprite, PixelSprite, usePixelManifest } from './PixelWorld.jsx';
import { usePaperDollReady } from './PaperDollCharacter.jsx';
import { paperDollLayers, selectPaperDoll } from './paper-doll-render.js';
import { sampleHomeUsePose } from './home-use-pose.js';
import { CharacterHeldProp } from './CharacterHeldProp.jsx';
import { homeConfirmedFurnitureUse, homeSeatAnchor, homeUsePresentationStyle } from './home-state.js';


/** This renderer only replaces a confirmed using pose. Walking continues to
 * use the shared distance-driven game rig, including its original identity. */
export function HomeCharacter({ agent, activity, furniture, artSpec, now, live, presentationStyle }) {
  const assets = usePixelManifest(), selection = selectPaperDoll(assets, agent), ready = usePaperDollReady(selection);
  const using = activity?.phase === 'using' && homeConfirmedFurnitureUse(agent, furniture);
  const seat = homeSeatAnchor(agent, furniture, artSpec), facing = seat?.facing || agent.facing || 'south';
  const enabled = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!using) return <CharacterSprite agent={agent} now={now} live={live}/>;
  const sample = sampleHomeUsePose(agent, activity, now, { facing, enabled, furnitureKind: furniture?.kind, rig: selection?.rig });
  const seatStyle = presentationStyle || homeUsePresentationStyle(agent, furniture, now, enabled, sample.dimensions.hipHeight, artSpec);
  const layers = ready ? paperDollLayers(selection.rig, sample, assets, agent, { facing, handsBusy: true }) : [];
  if (!ready) return <span className="home-use-fallback" data-home-use={activity.kind}><CharacterSprite agent={agent} now={now} live={false}/><CharacterHeldProp value={sample.homeProp} facing={facing}/></span>;
  return <span className="pixel-character home-use-character" style={seatStyle} data-sprite-id={agent.appearance?.sprite_id || 'unassigned'} data-render-rig={selection.id} data-action={activity.kind} data-facing={facing} data-home-use={activity.kind}>
    <span className="paper-doll-rig" data-rig-id={selection.id} data-facing={facing} data-action={activity.kind} data-playing={sample.playing ? 'true' : 'false'} style={{ display: 'contents' }}>
      {layers.map(layer => <PixelSprite key={layer.key} definition={layer.definition} sourceFrame={layer.frame} visualPose={layer.pose} sourceRotation={layer.sourceRotation} layer={layer.layer} rigPart={layer.part} attachmentSlot={layer.slot} textureDependency={layer.textureDependency} className={layer.className} itemId={layer.itemId} action={activity.kind} facing={facing}/>) }
    </span><CharacterHeldProp value={sample.homeProp} facing={facing}/>
  </span>;
}
