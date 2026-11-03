import React, { useId } from 'react';
import { HOME_PIXEL_ART, HOME_ROOM_ART, HOME_COTTAGE_ART } from './home-pixel-manifest.js';

export const furnitureArtSpec = kind => HOME_PIXEL_ART[kind];

// Select atlas regions at render time; keep source PNGs and sprite aspect.
function SourceRegion({ src, sheet, rect, x=0, y=0, width, height, preserve='xMidYMid meet' }) {
  return <svg x={x} y={y} width={width} height={height} viewBox={`${rect.x} ${rect.y} ${rect.w} ${rect.h}`} preserveAspectRatio={preserve} overflow="hidden" data-source-rect={`${rect.x},${rect.y},${rect.w},${rect.h}`}>
    <image href={src} width={sheet.width} height={sheet.height}/>
  </svg>;
}

export function CottageArt({ small=false }) {
  const art=HOME_COTTAGE_ART;
  return <svg viewBox="0 0 240 194" aria-hidden="true" className={small?'cottage-art small':'cottage-art'}>
    <SourceRegion src={art.src} sheet={art} rect={art.sourceRect} width={240} height={194}/>
  </svg>;
}

export function RoomArt({ grid=false, phase='day' }) {
  const id=useId().replace(/:/g,''), art=HOME_ROOM_ART;
  const region=(rect,x,y,width,height,preserve='xMidYMid meet')=><SourceRegion src={art.src} sheet={art} rect={rect} x={x} y={y} width={width} height={height} preserve={preserve}/>;
  return <svg className="home-room-art" viewBox="0 0 640 540" aria-hidden="true" data-art-release="0.28.0">
    <defs><pattern id={`${id}-floor`} patternUnits="userSpaceOnUse" x="70" y="135" width="500" height="200">
      {region({x:180,y:480,w:1000,h:400},0,0,500,200)}
    </pattern></defs>
    <rect width="640" height="540" fill="#f4e6d2"/>
    <rect x="57" y="18" width="526" height="477" fill="#52341f"/>
    {/* Architectural slices fit the unchanged grid; floor planks repeat at one scale. */}
    {region({x:140,y:167,w:1080,h:289},70,25,500,110,'none')}
    <rect x="70" y="135" width="500" height="336" fill={`url(#${id}-floor)`}/>
    {region({x:77,y:132,w:62,h:800},49,6,21,465,'none')}
    {region({x:1229,y:132,w:62,h:800},570,6,21,465,'none')}
    {region({x:98,y:112,w:1170,h:55},52,0,536,25,'none')}
    {region({x:132,y:938,w:426,h:117},60,471,260,31,'none')}
    {region({x:810,y:938,w:428,h:117},370,471,210,31,'none')}
    {region({x:610,y:944,w:146,h:119},320,471,50,41)}
    {phase==='night' && <rect x="70" y="25" width="500" height="110" fill="#1a285a" opacity=".24"/>}
    {(phase==='dusk'||phase==='dawn') && <rect x="70" y="25" width="500" height="110" fill="#e9aa6b" opacity=".12"/>}
    {grid && <g stroke="#4e3321" strokeWidth=".8" opacity=".4">{Array.from({length:9},(_,i)=><path key={`v${i}`} d={`M${120+i*50} 135v336`}/>)}{Array.from({length:7},(_,i)=><path key={`h${i}`} d={`M70 ${177+i*42}h500`}/>)}</g>}
  </svg>;
}

export function FurnitureArt({ kind, rotation=0, layer='base', item }) {
  const id=useId().replace(/:/g,''), spec=HOME_PIXEL_ART[kind];
  if (!spec) return null;
  const normal=((Number(rotation)||0)%360+360)%360;
  const art=spec.variants[normal] || spec.variants[0], {width:w,height:h}=art;
  const foreground=layer==='foreground';
  if (foreground && !art.foreground) return null;
  const sprite=art.planeRotation
    ? <g transform={`translate(${w} 0) rotate(90)`}><SourceRegion src={art.src} sheet={art.sheet} rect={art.sourceRect} width={h} height={w}/></g>
    : <SourceRegion src={art.src} sheet={art.sheet} rect={art.sourceRect} width={w} height={h}/>;
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className={`home-furniture-art furniture-${kind}`} aria-hidden="true" data-art-kind={kind} data-art-rotation={normal} data-art-layer={layer}>
    {foreground && <defs><clipPath id={`${id}-front`}>{art.foreground.rects.map(([x,y,width,height],i)=><rect key={i} x={x} y={y} width={width} height={height}/>)}</clipPath></defs>}
    <g clipPath={foreground?`url(#${id}-front)`:undefined}>{sprite}</g>
    {!foreground && kind==='display_shelf' && item && normal===0 && <svg x={w*.16} y={h*.35} width={w*.27} height={h*.33} viewBox="0 0 110 100"><SouvenirShape item={item}/></svg>}
  </svg>;
}

// Existing inventory symbols remain keyed to the real displayed item.
function SouvenirShape({ item }) {
  if(item==='ruins_leaf_medallion')return <g stroke="#4d5c3e" strokeWidth="3"><circle cx="55" cy="49" r="36" fill="#bca367"/><path d="M33 69C22 37 50 23 79 27 77 59 59 77 33 69Z" fill="#92a274"/><path d="m34 69 34-32m-21 19 15 1m-18 3-1-16" fill="none"/></g>;
  if(item==='ruins_stone_bird')return <g stroke="#535644" strokeWidth="3"><ellipse cx="55" cy="82" rx="35" ry="7" fill="#c2b58c"/><path d="m18 66 22-30 21 10 18-28 15 8-12 16 12 8-26 4-16 27Z" fill="#a5a48a"/><path d="m42 45 17 12-21 9m18 13 4 5m9-18 5 18" fill="none"/><circle cx="82" cy="27" r="2.5" fill="#333c30"/></g>;
  if(item==='ruins_star_lens')return <g strokeWidth="4"><circle cx="55" cy="46" r="32" fill="#819d98" stroke="#b09a5e"/><circle cx="55" cy="46" r="26" fill="none" stroke="#4b625b"/><path d="m37 50 22-23m-12 36 24-27" stroke="#d4e0ce" fill="none"/><path d="m40 77-9 13h49L69 77" stroke="#5b6049" fill="#b3a87e"/></g>;
  if(item==='pine_cone')return <g stroke="#624630" strokeWidth="2"><path d="M54 5q-31 14-32 58 18 31 39 22 31-16 29-39Q79 17 54 5Z" fill="#a57b48"/><path d="m40 23 15 14 15-13M29 43l24 12 28-13M26 62l24 12 36-13M40 82l14-11" fill="none"/></g>;
  if(item==='ore')return <g stroke="#4e554f" strokeWidth="2.5"><path d="m15 68 10-35 30-25 32 13 14 51-39 17Z" fill="#9bada4"/><path d="m25 33 38 13 24-25M63 46l-1 43M15 68l48-22" fill="none"/><path d="m50 14 5 17-14 7" stroke="#d3dcc8" fill="none"/></g>;
  return <g stroke="#62472e" strokeWidth="3"><path d="m19 42 58-27 22 44-61 29Z" fill="#a77b47"/><ellipse cx="29" cy="64" rx="20" ry="27" transform="rotate(-22 29 64)" fill="#d2ad70"/><ellipse cx="29" cy="64" rx="10" ry="16" transform="rotate(-22 29 64)" fill="none" strokeWidth="1.5"/><path d="m49 44 37-17m-31 33 35-16" strokeWidth="1.5"/></g>;
}
export function SouvenirArt({ item }) {return <svg className="home-souvenir-art" viewBox="0 0 110 100" aria-hidden="true"><SouvenirShape item={item}/></svg>;}
