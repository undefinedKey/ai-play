import { SCENES } from '../../shared/world-layout.js';

// Native pixels; all vertical pieces share the bottom contact anchor. Terrain
// is painted separately so no tree canopy can masquerade as walkable ground.
export function sceneGround(Grid, id) {
  const g = new Grid(768, 512), village = id === 'plaza';
  const grass = village ? '#98a36a' : '#416b61';
  g.rect(0, 0, 768, 512, grass);
  const patches = village
    ? [[[0,0],[250,0],[223,157],[0,203]],[[480,280],[768,260],[768,512],[555,512]],[[0,365],[196,342],[240,512],[0,512]]]
    : [[[0,0],[305,0],[287,180],[160,234],[0,220]],[[451,0],[768,0],[768,270],[572,280]],[[0,340],[217,302],[318,512],[0,512]]];
  patches.forEach((p,i)=>g.poly(p,village?['#87945d','#a1a66e','#7f9564'][i]:['#31554f','#526d69','#355e51'][i]));
  let seed=713;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<850;i++) {const x=Math.floor(random()*768),y=Math.floor(random()*512);g.line(x,y,x+3,y-1,village?'#b6b681':'#5b8070'); if(i%3===0)g.dot(x+4,y+1,village?'#7c8e58':'#365a53');}
  const roads=village?[[[4,4],[6,5],[11,8],[22,8]],[[11,8],[16,8],[19,4]],[[11,8],[16,11],[19,12]],[[7,4],[7,6],[11,8]]]:[[[11,8],[9,9],[7,10],[4,11]],[[11,8],[14,8],[16,7],[19,7]],[[19,7],[19,4]]];
  // Paint whole road networks per plane: connected paths have no segment seams.
  for(const[offset,width,color]of[[18,37,village?'#788665':'#354e48'],[15,31,village?'#c0ad7d':'#8a9072'],[12,25,village?'#d4c294':'#a2a184']])for(const line of roads)for(let i=1;i<line.length;i++){
    const [x,y]=line[i-1].map(n=>n*32+16),[xx,yy]=line[i].map(n=>n*32+16);
    g.line(x-offset,y-offset,xx-offset,yy-offset,color,width);
  }
  if(village){
    // Service court remains entirely walkable, unlike house/pond footprints.
    g.ellipse(273,199,196,152,'#a69872');g.ellipse(279,205,184,140,'#d4c49b');
    for(let y=211;y<341;y+=12)for(let x=284+(y%24?0:7);x<455;x+=17)if(((x-371)/83)**2+((y-275)/61)**2<1)g.borderedRect(x,y,15,10,'#c6bb95','#b3aa86');
    // The painted water follows the same footprint as server collision. Rebuild
    // ground images after editing the Tiled map; no second hand-written location.
    const cells=SCENES.find(s=>s.id===id).props.find(p=>p.kind==='pond')?.footprint;
    if(cells?.length){
      const x=Math.min(...cells.map(p=>p.x))*32,y=Math.min(...cells.map(p=>p.y))*32;
      const w=(Math.max(...cells.map(p=>p.x))*32-x)+32,h=(Math.max(...cells.map(p=>p.y))*32-y)+32;
      if(cells.length!==w*h/1024)throw Error('Painted pond footprint must be rectangular.');
      g.rect(x-4,y-4,w+8,h+8,'#ccb98c');g.rect(x,y,w,h,'#466b70');g.rect(x+3,y+3,w-6,h-6,'#67979c');g.rect(x+6,y+6,w-12,h-12,'#80b1ad');
      for(const[dx,dy]of[[14,14],[49,24],[27,47],[73,51]])if(dx+14<w&&dy+4<h){g.rect(x+dx,y+dy,14,2,'#c6d8bf');g.rect(x+dx+4,y+dy+3,5,1,'#9bc5b7');}
      g.rect(x+w-1,y+15,17,34,'#9f7d53');for(let yy=y+16;yy<y+49;yy+=6)g.line(x+w,yy,x+w+15,yy,'#cba56e');
    }
  }else{
    g.ellipse(310,224,117,105,'#506e60');g.ellipse(317,231,103,89,'#a2a48a');
    for(let y=134;y<304;y+=22)for(let x=558;x<696;x+=25){g.borderedRect(x,y,23,19,(x+y)%3?'#7d8a7d':'#929a85','#526b62');if((x+y)%2)g.line(x+5,y+3,x+12,y+12,'#596f63');}
    // Low moss/leaf litter is traversable; rocks and trunks are separate props.
    for(const[x,y]of[[112,348],[161,376],[627,242],[591,257],[352,288]]){g.ellipse(x-17,y-5,35,10,'#688668');g.line(x-9,y,x+8,y-2,'#94a27b');}
  }
  // Every obstacle gets a restrained base contact on precisely its blocked cells.
  for(const p of SCENES.find(s=>s.id===id).props)if(p.kind!=='pond')for(const cell of p.footprint)g.ellipse(cell.x*32+3,cell.y*32+8,27,20,village?'#7c845a':'#304f49');
  return g;
}

export function sceneProp(Grid, kind) {
  const g=new Grid(128,128),x=64,y=120;
  const line=(...args)=>g.line(...args),rect=(...args)=>g.rect(...args);
  if(['oak','birch','apple','pine','pine_tall','dead_tree'].includes(kind)){
    g.ellipse(x-24,y-7,49,13,'#253f3b55');
    rect(x-5,y-45,10,44,kind==='birch'?'#d8d1af':'#644b3f');rect(x-3,y-43,3,40,kind==='birch'?'#efe4bf':'#9f7951');
    if(kind==='dead_tree'){line(x,y-20,x-21,y-55,'#6c6a56',5);line(x,y-38,x+19,y-67,'#817e66',4);line(x-21,y-55,x-28,y-54,'#a3a083',2);return g;}
    if(kind.startsWith('pine'))for(let i=0;i<4;i++){
      const yy=y-90+i*17,w=16+i*8;
      g.poly([[x,yy-20],[x-w,yy+12],[x-w+8,yy+10],[x-w-2,yy+22],[x+w+4,yy+22],[x+w-7,yy+9],[x+w,yy+12]],'#253f3e');
      g.poly([[x,yy-17],[x-w+4,yy+12],[x-6,yy+8],[x-11,yy+18],[x+w,yy+18],[x+w-9,yy+7]],kind==='pine_tall'?'#3b675e':'#426c58');
      g.poly([[x,yy-14],[x-w+8,yy+10],[x-8,yy+5],[x+7,yy+11]],kind==='pine_tall'?'#648878':'#6a8a60');
    }else{
      line(x,y-25,x-21,y-53,'#755642',5);line(x,y-29,x+22,y-61,'#755642',5);
      const colors=kind==='apple'?['#3c6044','#698453','#92a86a']:kind==='birch'?['#54785f','#89a57d','#b6bf8e']:['#405d42','#71874e','#a4ac6b'];
      for(const[dx,dy,w,h]of[[-26,-78,47,46],[0,-89,42,43],[16,-65,40,43],[-15,-48,46,30]]){g.ellipse(x+dx-w/2,y+dy-h/2,w,h,colors[0]);g.ellipse(x+dx-w/2+2,y+dy-h/2+1,w-6,h-9,colors[1]);g.ellipse(x+dx-w/2+5,y+dy-h/2+2,w-16,13,colors[2]);}
      if(kind==='apple')for(const[dx,dy]of[[-26,-77],[7,-88],[27,-57],[-4,-50]]){g.ellipse(x+dx,y+dy,6,6,'#b76c4f');g.dot(x+dx+1,y+dy+1,'#e6a26c');}
      if(kind==='birch')for(let yy=y-35;yy<y;yy+=10)line(x-4,yy,x,yy,'#5c6955');
    }
  }else if(['bookshop','cottage','shed'].includes(kind)){
    const wide=kind!=='shed',w=wide?94:62,left=x-w/2,top=y-62;
    g.ellipse(left-5,y-9,w+11,17,'#3f4c3c55');
    g.borderedRect(left,top,w,61,'#d3bf92','#5c5140');rect(left+3,top+3,w-6,13,'#f0d8a4');rect(left+3,y-15,w-6,13,'#ad9266');
    for(let xx=left+7;xx<left+w-4;xx+=14)rect(xx,top+16,2,44,'#baa378');
    const roof=kind==='bookshop'?'#7e6572':kind==='shed'?'#6b7c6a':'#a05f48';
    g.poly([[left-7,top+4],[left+15,top-40],[left+w-17,top-40],[left+w+8,top+4]],'#4e4941');
    g.poly([[left-4,top],[left+17,top-37],[left+w-18,top-37],[left+w+4,top]],roof);
    for(let yy=top-30;yy<top;yy+=8)line(left+12+(top-yy)/5,yy,left+w-11-(top-yy)/5,yy,kind==='bookshop'?'#a78d91':'#c2825c',2);
    rect(left+2,top+2,w-4,5,'#e0b578');g.borderedRect(x-11,y-29,22,29,'#5b5146');rect(x-8,y-26,16,26,'#876c4e');g.dot(x+6,y-13,'#e5c480');
    for(const xx of wide?[left+10,left+w-26]:[left+5]){g.borderedRect(xx,top+18,16,17,'#426974');rect(xx+2,top+20,12,4,'#8dafab');rect(xx+7,top+19,2,15,'#d8ba7e');}
    if(kind==='bookshop'){g.borderedRect(left+5,top+40,20,14,'#e0c795');rect(left+8,top+43,6,8,'#9c685c');rect(left+15,top+43,6,8,'#608075');}
  }else if(kind.startsWith('portal')){
    const cool=kind==='portal_adventure';
    g.ellipse(x-29,y-9,58,15,cool?'#668078':'#bbaa7c');
    for(const xx of[x-25,x+20]){g.borderedRect(xx,y-63,6,63,cool?'#8d9d8e':'#98734c');rect(xx+1,y-59,2,54,cool?'#c2cbb1':'#c7a56a');}
    g.borderedRect(x-30,y-69,61,15,cool?'#405f5a':'#7c6045');rect(x-27,y-67,55,3,cool?'#779585':'#c7a56a');
    const dir=cool?-1:1;line(x-12*dir,y-61,x+13*dir,y-61,'#f1deb0',2);line(x+13*dir,y-61,x+6*dir,y-66,'#f1deb0',2);line(x+13*dir,y-61,x+6*dir,y-56,'#f1deb0',2);
    for(const xx of[x-27,x+22]){g.borderedRect(xx-3,y-43,12,15,'#554d3d');rect(xx,y-40,6,9,cool?'#a5c9b8':'#f2ce7e');}
  }else if(kind.startsWith('ruin')){
    const column=(xx,yy,h)=>{g.borderedRect(xx,yy-h,16,h,'#81928a','#354e4d');rect(xx+2,yy-h+2,5,h-4,'#adb6a1');rect(xx-3,yy-h-5,22,7,'#84998e');rect(xx-3,yy-5,22,5,'#718377');line(xx+9,yy-22,xx+5,yy-13,'#4b6b60');};
    if(kind==='ruin_arch'){column(x-36,y,70);column(x+21,y,70);g.borderedRect(x-39,y-84,79,14,'#83928a','#344d4b');rect(x-36,y-82,73,3,'#b1b9a6');}
    else if(kind==='ruin_wall'){g.borderedRect(x-47,y-39,63,39,'#72887c','#354f4d');for(let yy=y-36;yy<y;yy+=11)for(let xx=x-44;xx<x+11;xx+=18)g.borderedRect(xx,yy,17,10,'#8d9e8a','#506f60');}
    else column(x-8,y,61);
    g.ellipse(x-20,y-3,35,5,'#65856a');
  }else if(kind.startsWith('rock')){
    g.poly([[x-15,y-2],[x-13,y-18],[x-3,y-29],[x+12,y-23],[x+19,y-10],[x+17,y],[x-7,y+2]],'#3a5351');g.poly([[x-13,y-5],[x-11,y-17],[x-2,y-26],[x+10,y-21],[x+4,y-8]],'#a0aba0');g.poly([[x+4,y-8],[x+10,y-21],[x+16,y-9],[x+14,y-2],[x-6,y]],'#72897e');line(x-8,y-17,x-1,y-22,'#c9cdb4');
  }else if(kind==='well'){
    g.ellipse(x-15,y-18,30,22,'#5c6452');g.ellipse(x-12,y-20,25,12,'#c8c4a4');g.ellipse(x-8,y-17,17,6,'#354f51');rect(x-17,y-43,4,40,'#886a4b');rect(x+14,y-43,4,40,'#886a4b');g.poly([[x-24,y-40],[x,y-57],[x+25,y-40]],'#a87251');line(x,y-40,x,y-17,'#cab887');
  }else if(kind==='bench'||kind==='game_table'){
    const w=kind==='game_table'?57:37;for(const xx of[x-w/2+4,x+w/2-7])g.borderedRect(xx,y-19,5,19,'#76583e');g.borderedRect(x-w/2,y-25,w,13,'#b88d59');rect(x-w/2+2,y-23,w-4,3,'#e0bd82');if(kind==='game_table'){g.borderedRect(x-12,y-23,24,9,'#536e5c');g.dot(x-6,y-19,'#f1ddb0');g.dot(x+4,y-18,'#d6a563');}
  }
  return g;
}
