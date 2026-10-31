import {sceneDefinition} from '../shared/world-layout.js';

// The same ground geometry is consumed by Phaser and the fallback SVG.
export function wildernessGround(sceneId){
 const trails=sceneId==='plaza'?[
  [[4,5],[8,7],[11,8],[22,8],[27,10],[35,6]],
  [[11,8],[13,14],[19,23],[30,21],[34,25]],
  [[11,8],[7,15],[6,23],[3,28]],
 ]:[[[11,8],[18,8],[24,11],[29,12],[36,9],[40,7]],[[11,8],[8,14],[12,22],[21,22],[34,22],[41,24]],[[29,12],[31,17],[34,22]]];
 return {trails:trails.map(points=>points.map(([x,y])=>({x:x*32+16,y:y*32+16}))),pond:sceneDefinition(sceneId)?.props.find(p=>p.kind==='pond')?.footprint||[],camp:{x:368,y:272}};
}

// Irregular water stays within the authoritative blocked pond footprint. The
// unused corners are soft bank, never decorative water over a walkable cell.
export function pondGeometry(cells){
 if(!cells?.length)return null;
 const xs=cells.map(p=>p.x),ys=cells.map(p=>p.y),x=Math.min(...xs)*32,y=Math.min(...ys)*32,w=(Math.max(...xs)-Math.min(...xs)+1)*32,h=(Math.max(...ys)-Math.min(...ys)+1)*32;
 const shape=[[.03,.35],[.11,.12],[.29,.03],[.48,.08],[.69,.02],[.88,.15],[.98,.37],[.93,.56],[.98,.72],[.82,.91],[.59,.98],[.38,.9],[.17,.98],[.03,.75],[.08,.53]];
 const bank=shape.map(([u,v])=>({x:x+u*w,y:y+v*h})),water=shape.map(([u,v])=>({x:x+7+u*(w-14),y:y+7+v*(h-14)}));
 const ripples=[[.22,.32,.42],[.5,.47,.77],[.19,.63,.5],[.55,.77,.75]].map(([u,v,u2])=>[{x:x+u*w,y:y+v*h},{x:x+u2*w,y:y+v*h-2}]);
 const reeds=[[.14,.24],[.1,.72],[.8,.86],[.88,.23]].map(([u,v])=>({x:x+u*w,y:y+v*h}));
 return {bank,water,ripples,reeds};
}
