import React, { useEffect, useId, useState } from 'react';
import { aquariumGeometry, aquariumFishPixels, aquariumDecorationPixels, aquariumFishTrack, publicAquarium } from './aquarium-art.js';
import { homeFurniturePixels } from './home-pixel-drawing.js';
import './aquarium.css';

const Rects = ({ drawing }) => drawing.rects.map((rect, index) => <rect key={index} {...rect}/>);
function useSwimming(live) {
  const [allowed, setAllowed] = useState(() => !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowed(!document.hidden && !media.matches);
    document.addEventListener('visibilitychange', update); media.addEventListener('change', update); update();
    return () => { document.removeEventListener('visibilitychange', update); media.removeEventListener('change', update); };
  }, []);
  return !!live && allowed;
}

export default function AquariumArt({ item, rotation = 0, live = false, preview = false }) {
  const clip = `aquarium-${useId().replace(/:/g, '')}`, playing = useSwimming(live);
  const { fish, decorations } = publicAquarium(item), geometry = aquariumGeometry(rotation), { water } = geometry;
  return <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} shapeRendering="crispEdges" aria-hidden="true"
    className="home-furniture-art furniture-aquarium" data-testid={`aquarium-${preview?'preview':'art'}-${item?.instance_id || 'unplaced'}`}
    data-art-release="0.35.0" data-art-kind="aquarium" data-art-rotation={geometry.rotation} data-art-layer="base"
    data-fish-count={fish.length} data-decoration-count={decorations.length} data-playing={playing}>
    <Rects drawing={homeFurniturePixels('aquarium', rotation)}/>
    <defs><clipPath id={clip}><rect {...water}/></clipPath></defs>
    <g clipPath={`url(#${clip})`}>
      {decorations.map(decoration => <g key={decoration.slot} data-decoration-id={decoration.decoration_id} data-decoration-slot={decoration.slot}
        transform={`translate(${water.x + Math.round((water.width - 16) * decoration.slot / 2)} ${water.y + water.height - 18})`}>
        <Rects drawing={aquariumDecorationPixels(decoration.decoration_id)}/>
      </g>)}
      {fish.map((row, index) => {
        const track = aquariumFishTrack(row, index, rotation);
        return <g key={row.fish_id} transform={`translate(${track.x} ${track.y})`} data-fish-id={row.fish_id} data-fish-item-id={row.item_id} data-fish-name={row.name}>
          <g className="aquarium-swimmer" style={{ '--swim-distance': `${track.travel}px`, '--swim-duration': `${track.duration}s`, '--swim-delay': `${track.delay}s`, '--swim-steps': track.steps }}>
            <g className="aquarium-fish-facing"><Rects drawing={aquariumFishPixels(row.item_id)}/></g>
          </g>
        </g>;
      })}
    </g>
    <rect x={water.x + 2} y={water.y + 2} width="2" height={water.height - 5} fill="#c9eeee"/>
    <rect x={water.x + 5} y={water.y + 2} width={Math.min(18, water.width - 8)} height="1" fill="#ddf4e9"/>
  </svg>;
}

export function AquariumDetails({ item }) {
  const { fish, decorations } = publicAquarium(item);
  return <div className="home-aquarium-detail" data-testid="home-aquarium-detail" data-aquarium-id={item.instance_id}>
    <p>{fish.length ? `${fish.length} / 4 条鱼，来自屋主真实的鱼获。` : '水族箱还是空的，等待屋主放入自己的鱼获。'}</p>
    {!!fish.length && <ul aria-label="水族箱里的鱼">{fish.map(row => <li key={row.fish_id} data-fish-id={row.fish_id}>
      <svg viewBox="0 0 13 9" shapeRendering="crispEdges" aria-hidden="true"><Rects drawing={aquariumFishPixels(row.item_id)}/></svg>
      <span><strong>{row.name || row.species}</strong>{row.name && <small>{row.species}</small>}</span>
    </li>)}</ul>}
    <small>布景：{decorations.length ? [...decorations].sort((a,b) => a.slot - b.slot).map(row => `${['左','中','右'][row.slot]}·${row.name}`).join(' / ') : '尚未布置'}</small>
  </div>;
}
