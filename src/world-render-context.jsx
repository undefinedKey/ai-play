import React, {createContext, useContext, useId, useLayoutEffect} from 'react';
import {renderSpace} from './render-packet.js';

// Rendering packets contain only observed positions and selected atlas frames.
// They do not advance simulation, combat, travel or AI decisions.
export const WorldRenderContext=createContext(null);
const SpaceContext=createContext(null);
export function RenderSpace({position,depth=0,anchor=[24,43],offset={x:0,y:0},alpha=1,screenSize,children}) {
  const renderer=useContext(WorldRenderContext);
  return <SpaceContext.Provider value={renderSpace(position,{depth,anchor,offset,alpha,screenSize,viewportScale:renderer?.scale})}>{children}</SpaceContext.Provider>;
}
export function useRenderSprite(definition,frame,{facing='south',action='idle',layer=0,ground=false}={}) {
  const renderer=useContext(WorldRenderContext),space=useContext(SpaceContext),id=useId();
  const registry=renderer?.registry;
  useLayoutEffect(()=>{
    if(!registry)return;
    if(!definition||!frame||(!ground&&!space)){registry.delete(id);return;}
    registry.set(id,{definition,frame,x:ground?0:space.x,y:ground?0:space.y,depth:ground?-100:space.depth+layer,anchor:ground?[0,0]:space.anchor,scale:ground?1:space.scale,alpha:ground?1:space.alpha,flip:facing==='west'&&action==='walk',action});
  },[registry,id,definition,frame,space,ground,layer,facing,action]);
  useLayoutEffect(()=>()=>registry?.delete(id),[registry,id]);
}
