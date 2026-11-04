import React from 'react';

export function CharacterHeldProp({ value, facing }) {
  if(!value)return null;
  return <svg className="home-held-prop" viewBox="-10 -8 20 16" shapeRendering="crispEdges" aria-hidden="true" data-home-prop={value.kind}
    style={{left:`calc((24px + ${value.x}px) * var(--pixel-scale))`,top:`calc((43px + ${value.y}px) * var(--pixel-scale))`,zIndex:facing==='north'?-100:100}}>
    {value.kind==='writing'?<><path fill="#b97742" d="M-8-5H8V7H-8z"/><path fill="#fff9e8" d="M-7-4H7V5H-7z"/><path fill="#bda779" d="M-5-2H4v1h-9zM-5 1h7v1h-7z"/><path fill="#426849" d="M5-7h2v4H5zM3-3h2v4H3zM1 1h2v4H1z"/></>
      :value.kind==='book'?<><path fill="#426849" d="M-9-5h7v1h4v-1h7V6H2v1h-4V6h-7z"/><path fill="#fff3ce" d="M-8-4h6v1h1v8h-7zM1-3h1v-1h6v9H1z"/><path fill="#bda779" d="M-6-1h4v1h-4zM2-1h4v1H2zM-6 2h4v1h-4zM2 2h4v1H2z"/></>
      :<><path fill="#634632" d="M-8-2H8v5H6v3H3v1h-6V6h-3V3h-2z"/><path fill="#fff3ce" d="M-7 0H7v2H5v3H-5V2h-2z"/><path fill="#e5a85b" d="M-7-1H7v2H-7z"/><path fill="#fff9e8" d="M-6 2h3v2h-3z"/></>}
  </svg>;
}
