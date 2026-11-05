import React from 'react';
import { PixelSprite,usePixelManifest } from './PixelWorld.jsx';
import { RenderSpace } from './world-render-context.jsx';
import { projectMapPoint } from './map-projection.js';
import { plazaDistricts,plazaFacility,plazaFacilityDescriptions,PLAZA_LAYOUT_VERSION } from './plaza-state.js';
import './plaza.css';

// Observer labels describe the published town. They never send a game action.
export default function PlazaLandmarks({world,map}){
  const assets=usePixelManifest(),journey=plazaFacility('journey'),definition=assets?.plaza_services?.journey;
  const anchor=definition?[definition.anchor.x,definition.anchor.y]:[52,146];
  return <div className="plaza-landmarks" data-testid="plaza-landmarks" data-layout-version={PLAZA_LAYOUT_VERSION}>
    {plazaDistricts.map(d=><span key={d.id} className={`plaza-district district-${d.id}`} style={projectMapPoint(d.position,map)} data-testid={`plaza-district-${d.id}`} aria-hidden="true">{d.name}</span>)}
    {Object.entries(plazaFacilityDescriptions).map(([id,description])=>{const facility=plazaFacility(id),p=facility.position;return <span key={id} className={`plaza-facility facility-${id}`} tabIndex={0} role="img" aria-label={`${facility.name}：${description}。真实站位 ${facility.interaction_position.x}, ${facility.interaction_position.y}；旁观不会移动 AI。`} data-testid={`plaza-facility-${id}`} data-service-id={id} data-interaction-x={facility.interaction_position.x} data-interaction-y={facility.interaction_position.y} style={{...projectMapPoint(p,map),zIndex:100+p.y*10}}>
      <span className="plaza-facility-name">{facility.name}<small>{description}</small></span>
    </span>;})}
    {definition&&<RenderSpace position={journey.position} depth={100+journey.position.y*10} anchor={anchor}><span className="plaza-journey-art" data-testid="plaza-journey-gate" data-foot-x={journey.position.x} data-foot-y={journey.position.y} style={{...projectMapPoint(journey.position,map),zIndex:100+journey.position.y*10,'--plaza-anchor-x':`${anchor[0]}px`,'--plaza-anchor-y':`${anchor[1]}px`}} aria-hidden="true"><PixelSprite definition={definition}/></span></RenderSpace>}
  </div>;
}
