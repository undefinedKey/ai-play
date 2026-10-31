import {sceneDefinition} from '../shared/world-layout.js';

export function terrainPalette(ink,sceneId){
 return ink?{wash:['#596044',.05],camp:[sceneId==='plaza'?'#9a8658':'#6a7050',.18],trails:[[31,'#3c3828',.055],[24,'#b39b6f',.15]],bank:'#645d43',bankLine:'#30392c',water:'#465649',waterLine:'#6b7861',ripple:'#a1aa86',reeds:'#303c28'}:
 {wash:['#d6ccae',.34],camp:[sceneId==='plaza'?'#d9c5a2':'#a8aa8c',.5],trails:[[31,'#736749',.18],[24,'#d0bd97',.52],[2,'#817552',.2]],bank:'#817f62',bankLine:'#535d4e',water:'#7b9790',waterLine:'#abb6a2',ripple:'#d1d5bc',reeds:'#4c5a3e'};
}

// The same ground geometry is consumed by Phaser and the fallback SVG.
export function wildernessGround(sceneId){
 const trails=sceneId==='plaza'?[
  [[4,5],[8,7],[11,8],[22,8],[27,10],[35,6]],
  [[11,8],[13,14],[19,23],[30,21],[34,25]],
  [[11,8],[7,15],[6,23],[3,28]],
 ]:[[[11,8],[18,8],[24,11],[29,12],[36,9],[40,7]],[[11,8],[8,14],[12,22],[21,22],[34,22],[41,24]],[[29,12],[31,17],[34,22]]];
 return {trails:trails.map(points=>points.map(([x,y])=>({x:x*32+16,y:y*32+16}))),pond:sceneDefinition(sceneId)?.props.find(p=>p.kind==='pond')?.footprint||[],camp:{x:368,y:272}};
}

// Chaikin subdivision keeps every point inside the original convex outline.
// Both renderers use these sampled points, so SVG and WebGL show one shoreline.
function softened(points,passes=2){
 let result=points;
 for(let pass=0;pass<passes;pass++)result=result.flatMap((p,i)=>{const q=result[(i+1)%result.length];return[{x:p.x*.75+q.x*.25,y:p.y*.75+q.y*.25},{x:p.x*.25+q.x*.75,y:p.y*.25+q.y*.75}];});
 return result;
}
const stroke=(points,color,width,alpha)=>({points,color,width,alpha});
const fill=(points,color,alpha)=>({points,color,alpha});

// Water and bank stay within the authoritative blocked footprint. Quiet, broken
// contours replace the old geometric double outline without adding water cells.
export function pondGeometry(cells){
 if(!cells?.length)return null;
 const xs=cells.map(p=>p.x),ys=cells.map(p=>p.y),x=Math.min(...xs)*32,y=Math.min(...ys)*32,w=(Math.max(...xs)-Math.min(...xs)+1)*32,h=(Math.max(...ys)-Math.min(...ys)+1)*32;
 const shape=[[.04,.37],[.13,.12],[.30,.04],[.46,.17],[.63,.06],[.81,.15],[.93,.31],[.83,.49],[.91,.65],[.73,.84],[.48,.96],[.24,.92],[.06,.77],[.08,.56]];
 const bank=softened(shape.map(([u,v])=>({x:x+u*w,y:y+v*h}))),water=softened(shape.map(([u,v],i)=>({x:x+5+u*(w-10)+Math.sin(i*2.1),y:y+5+v*(h-10)+Math.cos(i*1.7)})));
 const ripples=[[.23,.29,.12],[.58,.36,.13],[.31,.59,.18],[.62,.69,.09],[.48,.81,.12]].map(([u,v,length],row)=>Array.from({length:7},(_,i)=>({x:x+(u+length*i/6)*w,y:y+v*h+Math.sin(i/6*Math.PI)*1.6+Math.sin(i*1.9+row)*.45})));
 const edges=[3,17,29,43].map((from,i)=>water.slice(from,from+(i%2?6:9)));
 const reeds=[[.13,.27],[.1,.69],[.78,.85],[.89,.26]].flatMap(([u,v],group)=>[-2,1,4].map((dx,i)=>Array.from({length:5},(_,step)=>{const t=step/4;return{x:x+u*w+dx*t+(i-1)*t*t*2,y:y+v*h-t*(6+Math.abs(dx)+group%2)};})));
 return {bank,water,ripples,edges,reeds};
}

// Road centerlines are unchanged. Only their paint boundary varies within the
// former 31px visual width; this is neither collision nor an alternate path.
export function trailGeometry(path,seed=0){
 const samples=[];let travelled=0;
 for(let segment=0;segment<path.length-1;segment++){
  const a=path[segment],b=path[segment+1],length=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.max(1,Math.ceil(length/8));
  for(let i=0;i<steps;i++){const t=i/steps;samples.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,d:travelled+length*t});}travelled+=length;
 }
 samples.push({...path.at(-1),d:travelled});
 const left=[],right=[];
 for(let i=0;i<samples.length;i++){
  const p=samples[i],a=samples[Math.max(0,i-1)],b=samples[Math.min(samples.length-1,i+1)],length=Math.hypot(b.x-a.x,b.y-a.y)||1,nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length;
  const width=10.5+Math.sin(p.d*.039+seed)*2.2+Math.sin(p.d*.113+seed*2)*1.3,drift=Math.sin(p.d*.083+seed)*.8;
  left.push({x:p.x+nx*(width+drift),y:p.y+ny*(width+drift)});right.push({x:p.x-nx*(width-drift),y:p.y-ny*(width-drift)});
 }
 const edges=[];
 for(let i=8+seed;i<samples.length-4;i+=11){const edge=(i+seed)%2?left:right;edges.push(edge.slice(i,i+3+(i%3)));}
 return {surface:[...left,...right.toReversed()],edges};
}

// Small shared paint primitives keep the two renderers visually identical.
const drawingCache=new Map();
export function terrainDrawing(sceneId,ink=true){
 const key=`${sceneId}:${ink}`;if(drawingCache.has(key))return drawingCache.get(key);
 const data=wildernessGround(sceneId),palette=terrainPalette(ink,sceneId),fills=[],strokes=[];
 for(const[pathIndex,path]of data.trails.entries()){
  const trail=trailGeometry(path,pathIndex+1);fills.push(fill(trail.surface,ink?'#b29b70':'#c7b38e',ink ? .18 : .4));
  for(const edge of trail.edges)strokes.push(stroke(edge,ink?'#514932':'#817552',.7,ink ? .20 : .3));
 }
 const pond=pondGeometry(data.pond);
 if(pond){
  fills.push(fill(pond.bank,palette.bank,.58),fill(pond.water,palette.water,.97));
  // Subtle darker shallows remain a patch, not a second enclosing ring.
  const patch=pond.water.slice(2,19);fills.push(fill(patch,'#2d3b31',.14));
  for(const line of pond.edges)strokes.push(stroke(line,palette.bankLine,1.05,.65));
  for(const line of pond.ripples)strokes.push(stroke(line,palette.ripple,.75,.40));
  for(const line of pond.reeds)strokes.push(stroke(line,palette.reeds,.85,.82));
 }
 const drawing={wash:palette.wash,fills,strokes};drawingCache.set(key,drawing);return drawing;
}
