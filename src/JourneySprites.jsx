import React from 'react';
import { usePixelNow } from './PixelWorld.jsx';
import { journeyCharacterPixels, journeyIdentity, journeyMonsterPixels } from './journey-pixel-art.js';
import { journeySpriteState } from './journey-combat-motion.js';
import { visibleWardrobe } from './wardrobe-state.js';

function Sprite({ actor, world, now, live, monster = false }) {
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = typeof document === 'undefined' || !document.hidden;
  const clock = usePixelNow(now, live && visible && !reducedMotion && (monster ? actor.status === 'alive' : actor.status === 'active'), actor);
  const state = journeySpriteState(actor, clock, { live, reducedMotion: reducedMotion || !visible, events: world?.events || [], monster });
  const pixels = monster ? journeyMonsterPixels(actor, state) : journeyCharacterPixels(actor, state);
  const identity = monster ? actor.monster_id : journeyIdentity(actor).seed;
  const wardrobe=monster?null:visibleWardrobe(actor);
  return <span className="journey-pixel-sprite pixel-character" aria-hidden="true" data-art-style="original-pixel" data-identity={identity} data-sprite-id={actor.appearance?.sprite_id || (monster ? actor.monster_id : 'unassigned')}
    data-action={state.action} data-state={state.phase} data-frame={state.frame} data-facing={state.facing}
    data-hairstyle={wardrobe?.hairstyle} data-wardrobe-outfit={wardrobe?.wearing.outfit?.style_id} data-wardrobe-head={wardrobe?.wearing.head?.style_id} data-wardrobe-back={wardrobe?.wearing.back?.style_id}
    data-motion-x={state.x} data-motion-y={state.y} data-playing={state.playing ? 'true' : 'false'} data-action-key={state.key} data-item={state.itemId || undefined}
    style={{ display: 'block', width: 'calc(48px * var(--pixel-scale, 1))', height: 'calc(48px * var(--pixel-scale, 1))', pointerEvents: 'none' }}>
    <svg viewBox="0 0 48 48" width="100%" height="100%" shapeRendering="crispEdges" style={{ overflow: 'visible', imageRendering: 'pixelated' }}>
      <g transform={`translate(${state.x} ${state.y})`}><g transform={state.facing === 'west' ? 'translate(48 0) scale(-1 1)' : undefined}>
        {pixels.map((p, i) => <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill={state.flash ? '#fff6c6' : p.color} data-part={p.part}/>)}</g></g>
      {state.spark && <g fill="#ffe98a"><rect x="36" y="14" width="2" height="7"/><rect x="33" y="17" width="8" height="2"/><rect x="40" y="11" width="2" height="3"/></g>}
      {state.damage !== null && <text className="journey-pixel-damage" x="24" y={5 + state.damageY} textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="bold" fill="#fff4a6" stroke="#67452f" strokeWidth="1.4" paintOrder="stroke" data-damage={state.damage}>−{state.damage}</text>}
    </svg>
  </span>;
}
export function JourneyCharacterSprite({ actor, world, now, live }) { return <Sprite actor={actor} world={world} now={now} live={live}/>; }
export function JourneyMonsterSprite({ monster, world, now, live }) { return <Sprite actor={monster} world={world} now={now} live={live} monster/>; }
