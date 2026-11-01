import React from 'react';

// Original ink-and-timber artwork. These fixed architectural details are not
// furniture inventory, resource nodes, or pretend player-created objects.
export function CottageArt({ small = false }) {
  return <svg viewBox="0 0 240 170" aria-hidden="true" className={small ? 'cottage-art small' : 'cottage-art'}>
    <ellipse cx="120" cy="152" rx="96" ry="13" fill="#5e5639" opacity=".16"/>
    <g stroke="#493b32" strokeWidth="3" strokeLinejoin="round">
      <path d="M55 71 122 30 186 71 181 145 58 145Z" fill="#b18a59"/>
      <path d="M181 76 211 87 207 139 181 145Z" fill="#927044"/>
      <path d="M38 77 119 16 196 71 181 81 121 39 53 88Z" fill="#5a6659"/>
      <path d="m119 16 35 7 68 58-26-10Z" fill="#46544b"/>
      <path d="M160 32V9h17v36" fill="#9e785a"/>
      <path d="M153 12h29V4h-29Z" fill="#ba9970"/>
      <path d="m66 92 31-4 1 31-31 1Z" fill="#f4ce78"/>
      <path d="M81 90v29M66 104h32" fill="none"/>
      <path d="M122 144v-42q12-18 29-3v45" fill="#655344"/>
      <path d="m114 145 45-1 6 9h-57Z" fill="#d3b488"/>
      <circle cx="143" cy="122" r="2" fill="#e6c574" stroke="none"/>
      <path d="m62 129 48-1m48-9 20-1M62 138h47m49-7h20M64 80l39-3m53 11 22 4" strokeWidth="1.5" opacity=".55"/>
      <path d="m50 143-15-9m14 8-1-21m140 25 16-16m-13 15 1-23" stroke="#66764c"/>
    </g>
    <path d="m54 69 68-44 62 43m-53-28 9-10m0 17 10-9m0 17 10-8M74 62l-5-7m23-6-5-7" stroke="#c1c3a0" opacity=".35" fill="none"/>
  </svg>;
}

export function RoomArt({ grid = false }) {
  return <svg className="home-room-art" viewBox="0 0 640 540" aria-hidden="true">
    <defs>
      <pattern id="home-planks" x="70" y="135" width="100" height="42" patternUnits="userSpaceOnUse"><rect width="100" height="42" fill="#c49a68"/><path d="M0 0h100M0 1v40M48 8l39-1M8 29l31 1M67 34l21-1" fill="none" stroke="#805d3e" strokeWidth="1.2" opacity=".6"/><path d="M3 3h94" stroke="#e3bd83" opacity=".7"/></pattern>
      <linearGradient id="home-wall" x2="0" y2="1"><stop stopColor="#b3986a"/><stop offset="1" stopColor="#dbc394"/></linearGradient>
      <radialGradient id="home-lamplight"><stop stopColor="#ffe5a3" stopOpacity=".32"/><stop offset="1" stopColor="#ffe5a3" stopOpacity="0"/></radialGradient>
    </defs>
    <rect width="640" height="540" fill="#e2d9ba"/>
    <path d="M34 502q274-32 570-8" stroke="#b4b38e" strokeWidth="35" opacity=".35"/>
    <path d="m53 67 533-4 12 430-536 10Z" fill="#4e4238" opacity=".16"/>
    <path d="M70 135V50h500v85" fill="url(#home-wall)" stroke="#4d4034" strokeWidth="5"/>
    <path d="M70 135h500v336H70Z" fill="url(#home-planks)" stroke="#614d39" strokeWidth="4"/>
    <path d="M70 137 49 117v359l21-5M570 135l20-18v358l-20-4" fill="#92704d" stroke="#4e4033" strokeWidth="4"/>
    <path d="M58 50h523v12H58Z" fill="#69513b" stroke="#4e4033" strokeWidth="3"/>
    <path d="M73 123h494v13H73Z" fill="#805e40"/>
    <path d="m118 68 73-1-1 48-73 1Z" fill="#6c8178" stroke="#5b4935" strokeWidth="5"/>
    <path d="M123 72h61v38h-61Z" fill="#c8d5bc"/><path d="m126 103 22-23 13 18 20-11v23h-55Z" fill="#7f997e"/><path d="M154 70v43M120 91h68" stroke="#6f5338" strokeWidth="4"/>
    <path d="M112 64h85l-5 18-12-10-6 5-17-6-17 7-15-6-11 12Z" fill="#ae6c4b" stroke="#634637" strokeWidth="2"/>
    <path d="M116 117h78" stroke="#644c35" strokeWidth="6"/>
    <path d="M452 69h31v40h-31Z" fill="#e9c26d" stroke="#554431" strokeWidth="3"/><path d="m447 69 20-14 21 14Zm5 40h31l-5 8h-21Z" fill="#6c5940" stroke="#554431" strokeWidth="2"/>
    <ellipse cx="467" cy="140" rx="125" ry="112" fill="url(#home-lamplight)"/>
    <path d="M66 471h254m50 0h205" stroke="#614b35" strokeWidth="13"/>
    <path d="M320 466h50v16h-50Z" fill="#dabc89" stroke="#614b35" strokeWidth="3"/><path d="M315 485h60l10 15h-80Z" fill="#c4b494" stroke="#88775c" strokeWidth="2"/>
    <path d="m82 150 8 2m432 301 13 2m-412-16 22-2m194-264 8 1" stroke="#654d32" opacity=".5" fill="none"/>
    {grid && <g stroke="#634b34" strokeWidth=".8" opacity=".35">{Array.from({ length: 9 }, (_, i) => <path key={`v${i}`} d={`M${120 + i * 50} 135v336`}/>)}{Array.from({ length: 7 }, (_, i) => <path key={`h${i}`} d={`M70 ${177 + i * 42}h500`}/>)}</g>}
  </svg>;
}

export function FurnitureArt({ kind, vertical = false, item }) {
  return <svg viewBox="0 0 140 110" className={`home-furniture-art furniture-${kind}`} preserveAspectRatio="none" aria-hidden="true">
    <g stroke="#503d30" strokeWidth="3" strokeLinejoin="round">
      {kind === 'chair' && <><ellipse cx="70" cy="101" rx="42" ry="7" fill="#4d3522" stroke="none" opacity=".2"/><path d="M34 25 99 22l4 53-68 2Z" fill="#9b6d42"/><path d="m42 31 49-2 1 29-49 3Z" fill="#c29a61"/><path d="M34 71v28m67-30v30M31 66l71-4 8 19-80 5Z" fill="#b78852"/><path d="m40 73 59-3M65 31v28" strokeWidth="1.4"/></>}
      {kind === 'table' && <><ellipse cx="70" cy="99" rx="63" ry="8" fill="#4d3522" stroke="none" opacity=".2"/><path d="M22 52 17 96h12l8-42m66-3 9 45h11l-5-44" fill="#86613d"/><path d={vertical ? 'M43 13 99 15l20 64-97 1Z' : 'M14 35 123 30l12 34-130 5Z'} fill="#ca9d5d"/><path d={vertical ? 'm70 16 1 61m-20-49 44 1m-49 20 55 1' : 'm18 43 104-5M14 57l114-5M47 38l-2 22m45-24 2 22'} strokeWidth="1.6" opacity=".65"/></>}
      {kind === 'rug' && <><path d="m9 10 120-3 6 91-126 5Z" fill="#8c5e42" strokeWidth="2"/><path d="m18 20 101-2 7 70-107 5Z" fill="#c4a86b" strokeWidth="1.5"/><path d="m70 26 39 29-36 30-38-29Z" fill="#697b64" strokeWidth="1.5"/><path d="m70 41 17 15-15 14-18-14Z" fill="#dabd82" strokeWidth="1.5"/><path d="M4 16h9M3 28h9M3 42h9M3 55h9M3 69h9M4 83h9M5 95h9m115-79h9m-8 13h9m-8 13h9m-7 13h8m-8 14h8m-8 14h8m-8 12h8" stroke="#81603e" strokeWidth="2"/></>}
      {kind === 'display_shelf' && <><ellipse cx="70" cy="100" rx="63" ry="7" fill="#4d3522" stroke="none" opacity=".2"/><path d="M12 13h116v86H12Z" fill="#85613e"/><path d="M20 21h100v58H20Z" fill="#584537"/><path d="M7 13h126v11H7Zm3 67h121v12H10Z" fill="#c19a62"/><path d="M32 92v11m76-11v11" strokeWidth="6"/><path d="m25 86 89-1" strokeWidth="1" opacity=".55"/>{item && <g transform="translate(42 30) scale(.5)"><SouvenirShape item={item}/></g>}</>}
    </g>
  </svg>;
}

function SouvenirShape({ item }) {
  if (item === 'pine_cone') return <g stroke="#624630" strokeWidth="2"><path d="M54 5q-31 14-32 58 18 31 39 22 31-16 29-39Q79 17 54 5Z" fill="#a57b48"/><path d="m40 23 15 14 15-13M29 43l24 12 28-13M26 62l24 12 36-13M40 82l14-11" fill="none"/></g>;
  if (item === 'ore') return <g stroke="#4e554f" strokeWidth="2.5"><path d="m15 68 10-35 30-25 32 13 14 51-39 17Z" fill="#9bada4"/><path d="m25 33 38 13 24-25M63 46l-1 43M15 68l48-22" fill="none"/><path d="m50 14 5 17-14 7" stroke="#d3dcc8" fill="none"/></g>;
  return <g stroke="#62472e" strokeWidth="3"><path d="m19 42 58-27 22 44-61 29Z" fill="#a77b47"/><ellipse cx="29" cy="64" rx="20" ry="27" transform="rotate(-22 29 64)" fill="#d2ad70"/><ellipse cx="29" cy="64" rx="10" ry="16" transform="rotate(-22 29 64)" fill="none" strokeWidth="1.5"/><path d="m49 44 37-17m-31 33 35-16" strokeWidth="1.5"/></g>;
}
export function SouvenirArt({ item }) { return <svg className="home-souvenir-art" viewBox="0 0 110 100" aria-hidden="true"><SouvenirShape item={item}/></svg>; }
