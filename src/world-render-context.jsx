import React, {createContext, useContext, useId, useLayoutEffect} from 'react';
import {renderSpace,spriteGeometry,spriteRenderPacket} from './render-packet.js';

// Rendering packets contain only observed positions and selected atlas frames.
// They do not advance simulation, combat, travel or AI decisions.
export const WorldRenderContext=createContext(null);
const SpaceContext=createContext(null);
export function RenderSpace({position,depth=0,anchor=[24,43],offset={x:0,y:0},alpha=1,screenSize,children}) {
  const renderer=useContext(WorldRenderContext);
  return <SpaceContext.Provider value={renderSpace(position,{depth,anchor,offset,alpha,screenSize,viewportScale:renderer?.scale})}>{children}</SpaceContext.Provider>;
}
export function useRenderSprite(definition,frame,{facing='south',action='idle',layer=0,ground=false,attachment}={}) {
  const renderer=useContext(WorldRenderContext),space=useContext(SpaceContext),id=useId();
  const registry=renderer?.registry;
  useLayoutEffect(()=>{
    if(!registry)return;
    const packet=spriteRenderPacket(definition,frame,space,{facing,action,layer,ground,attachment});
    if(packet)registry.set(id,packet);else registry.delete(id);
  },[registry,id,definition,frame,space,ground,layer,facing,action,attachment]);
  useLayoutEffect(()=>()=>registry?.delete(id),[registry,id]);
  return space&&!ground&&frame?spriteGeometry(definition,frame,space.anchor,facing,attachment):null;
}
