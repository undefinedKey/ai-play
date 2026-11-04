import React, { useId } from 'react';
import { HOME_PIXEL_ART } from './home-pixel-manifest.js';
import { homeCottagePixels, homeFurniturePixels, homeRoomPixels, homeSouvenirPixels } from './home-pixel-drawing.js';

export const furnitureArtSpec = kind => HOME_PIXEL_ART[kind];
const PixelRects = ({drawing}) => drawing.rects.map((rect,index)=><rect key={index} {...rect}/>);

export function CottageArt({ small=false }) {
  const drawing=homeCottagePixels();
  return <svg viewBox="0 0 120 97" shapeRendering="crispEdges" aria-hidden="true" data-art-release="0.34.0" className={small?'cottage-art small':'cottage-art'}><PixelRects drawing={drawing}/></svg>;
}

export function RoomArt({ grid=false, phase='day' }) {
  return <svg className="home-room-art" viewBox="0 0 640 540" shapeRendering="crispEdges" aria-hidden="true" data-art-release="0.34.0">
    <PixelRects drawing={homeRoomPixels(phase)}/>
    {grid&&<g fill="#634632" opacity=".3">{Array.from({length:9},(_,i)=><rect key={`v${i}`} x={120+i*50} y="135" width="1" height="336"/>)}{Array.from({length:7},(_,i)=><rect key={`h${i}`} x="70" y={177+i*42} width="500" height="1"/>)}</g>}
  </svg>;
}

export function FurnitureArt({ kind, rotation=0, layer='base', item }) {
  const id=useId().replace(/:/g,''),spec=HOME_PIXEL_ART[kind];
  if(!spec)return null;
  const normal=((Number(rotation)||0)%360+360)%360,art=spec.variants[normal]||spec.variants[0];
  const {width:w,height:h}=art,foreground=layer==='foreground',drawing=homeFurniturePixels(kind,normal,layer);
  if(foreground&&!art.foreground)return null;
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" shapeRendering="crispEdges" className={`home-furniture-art furniture-${kind}`} aria-hidden="true" data-art-release="0.34.0" data-art-kind={kind} data-art-rotation={normal} data-art-layer={layer}>
    {foreground&&<defs><clipPath id={`${id}-front`}>{art.foreground.rects.map(([x,y,width,height],i)=><rect key={i} x={x} y={y} width={width} height={height}/>)}</clipPath></defs>}
    <g clipPath={foreground?`url(#${id}-front)`:undefined}><svg width={w} height={h} viewBox={`0 0 ${drawing.width} ${drawing.height}`} preserveAspectRatio="none"><PixelRects drawing={drawing}/></svg></g>
    {!foreground&&kind==='display_shelf'&&item&&normal===0&&<svg x={w*.16} y={h*.22} width={w*.27} height={h*.33} viewBox="0 0 24 24"><PixelRects drawing={homeSouvenirPixels(item)}/></svg>}
  </svg>;
}

export function SouvenirArt({ item }) {return <svg className="home-souvenir-art" viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden="true"><PixelRects drawing={homeSouvenirPixels(item)}/></svg>;}

export function BookArt({className=''}){return <svg className={className} viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden="true"><path fill="#426849" d="M4 2h16v20H4z"/><path fill="#73ab65" d="M7 3h12v16H7z"/><path fill="#fff3ce" d="M7 20h12v1H7zM10 7h6v2h-6zM10 11h6v1h-6z"/><path fill="#acd88a" d="M5 3h2v16H5z"/></svg>;}

export function WritingArt({className='',...props}){return <svg className={className} viewBox="0 0 42 26" shapeRendering="crispEdges" aria-hidden="true" {...props}><path fill="#b97742" d="M3 3h31v21H3z"/><path fill="#fff9e8" d="M5 4h27v18H5z"/><path fill="#bda779" d="M9 8h17v1H9zM9 12h14v1H9zM9 16h16v1H9z"/><g className="table-pen" fill="#426849"><path d="M30 2h4v4h-4zM28 6h4v4h-4zM26 10h4v4h-4zM24 14h4v4h-4z"/><path fill="#efbd57" d="M23 18h3v3h-3z"/></g></svg>;}

export function HomeSignArt(){return <svg viewBox="0 0 27 34" shapeRendering="crispEdges" aria-hidden="true"><path fill="#426849" d="M5 31h17v2H5z"/><path fill="#634632" d="M7 11h4v21H7zM2 3h18v2h3v3h3v5h-3v3h-3v2H2z"/><path fill="#b97742" d="M8 18h2v13H8z"/><path fill="#ffcd7a" d="M3 5h17v2h3v7h-3v2H3z"/><path fill="#426849" d="M5 10h2V8h2V6h2v2h2v2h2v2h-2v3H7v-3H5zM17 9h4v2h-4zM20 7h2v2h-2zM20 11h2v2h-2z"/><path fill="#fff3ce" d="M9 12h2v3H9z"/></svg>;}
