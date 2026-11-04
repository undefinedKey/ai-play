import React from 'react';

export function CharacterHeldProp({ value, facing }) {
  if (!value) return null;
  return <svg className="home-held-prop" viewBox="-10 -8 20 16" aria-hidden="true" data-home-prop={value.kind}
    style={{ left: `calc((24px + ${value.x}px) * var(--pixel-scale))`, top: `calc((43px + ${value.y}px) * var(--pixel-scale))`, zIndex: facing === 'north' ? -100 : 100, rotate: `${value.tilt || 0}rad` }}>
    {value.kind === 'writing' ? <g stroke="#624b34" strokeWidth=".8" strokeLinejoin="round"><path d="m-8-5 14 1 2 10-16-1Z" fill="#efdeb6"/><path d="m-5-2 7 .5m-7 2 9 .5m-8 2 5 .4" fill="none" opacity=".6"/><path d="m2 1 4-9 1 1-4 9Z" fill="#66533a" transform={`translate(${value.stroke || 0},0)`}/></g>
      : value.kind === 'book' ? <g stroke="#624b34" strokeWidth=".8" strokeLinejoin="round"><path d="M-9-5q4-2 9 1 5-3 9-1v10Q4 3 0 6q-5-3-9-1Z" fill="#e8d5a0"/><path d="M0-4V6M-7-2l5 1M2-1l5-1M-7 1l5 1M2 2l5-1" fill="none" opacity=".8"/></g>
      : <g stroke="#77523c" strokeWidth=".8"><ellipse cx="0" cy="5" rx="8" ry="2" fill="#7d665344" stroke="none"/><path d="M-8-1q1 8 8 8t8-8Z" fill="#e9d3a3"/><ellipse cx="0" cy="-1" rx="8" ry="3" fill="#b9894c"/><circle cx="-3" cy="-1" r="1" fill="#84955c"/><circle cx="3" cy="0" r="1.2" fill="#d3a759"/></g>}
  </svg>;
}
