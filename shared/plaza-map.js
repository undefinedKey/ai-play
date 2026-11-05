import { PLAZA_LAYOUT_VERSION, PLAZA_MAP, PLAZA_PROPS } from './plaza-layout.js';
// This scene is generated from the portable spatial contract. Do not author a
// second set of coordinates in Tiled; edit plaza-layout.mjs and regenerate.
export function createPlazaMap() {
  const kinds=[...new Set(PLAZA_PROPS.filter(p=>p.kind!=='pond').map(p=>p.kind))];
  const objects=PLAZA_PROPS.map((p,i)=>({id:i+1,name:p.id,type:p.kind,rotation:0,visible:true,
    ...(p.kind==='pond'?{point:true,x:(p.position.x+.5)*32,y:(p.position.y+.5)*32,width:0,height:0}:
      {gid:kinds.indexOf(p.kind)+1,x:(p.position.x+.5)*32-64,y:(p.position.y+.5)*32+8,width:128,height:128}),
    properties:[{name:'footprint',type:'string',value:JSON.stringify(p.footprint.map(q=>[q.x-p.position.x,q.y-p.position.y]))}]}));
  return {type:'map',version:'1.10',tiledversion:'1.12.2',orientation:'orthogonal',renderorder:'right-down',infinite:false,
    ...PLAZA_MAP,tilewidth:32,tileheight:32,nextlayerid:3,nextobjectid:objects.length+1,
    properties:[['scene_id','plaza'],['scene_name','生活广场'],['destination_scene','adventure'],['layout_version',PLAZA_LAYOUT_VERSION]].map(([name,value])=>({name,type:'string',value})),
    layers:[{id:1,name:'Ground',type:'imagelayer',visible:true,opacity:1,x:0,y:0,image:'../../public/pixel-world/ground_ink.png',imagewidth:1536,imageheight:1024,locked:true},
      {id:2,name:'World props and footprints',type:'objectgroup',visible:true,opacity:1,draworder:'topdown',x:0,y:0,objects}],
    tilesets:[{firstgid:1,name:'world_props',tilewidth:128,tileheight:128,tilecount:kinds.length,columns:0,objectalignment:'bottomleft',
      tiles:kinds.map((kind,id)=>({id,type:kind,image:'../../public/pixel-world/'+kind+'.png',imagewidth:128,imageheight:128}))}]};
}
