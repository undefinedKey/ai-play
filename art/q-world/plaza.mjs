import { PLAZA_MAP, PLAZA_ROADS, PLAZA_PAVING, PLAZA_PROPS } from '../../shared/plaza-layout.js';

// Original town artwork drawn at source resolution. Geometry comes from the
// portable world contract; this module never invents interaction locations.
export function plazaArtwork(Grid,P){
  const grid=(w,h)=>new Grid(w,h), foot={x:96,y:150};
  const shadow=(g,x,y,w)=>g.blob(x-w/2,y-5,w,9,'#35584544');
  const stone=(g,x,y,w,h)=>{g.box(x,y,w,h,'#bbbc9b','#7e9279',2);g.rect(x+3,y+2,w-6,3,'#e0dbb7');};
  const window=(g,x,y,w=26,h=30)=>{g.box(x,y,w,h,P.woodDark,P.ink);g.box(x+3,y+3,w-6,h-6,P.blueLight,P.woodLight,2);g.rect(x+5,y+5,w-10,5,'#c8efdf');g.rect(x+w/2-1,y+4,2,h-8,P.cream);g.rect(x+3,y+h/2,w-6,2,P.cream);g.rect(x-2,y+h, w+4,4,P.woodLight);};
  const flowerbox=(g,x,y,w)=>{g.box(x,y,w,10,P.wood,P.woodDark,2);g.rect(x+3,y+2,w-6,2,P.woodLight);for(let xx=x+5;xx<x+w-3;xx+=8){g.rect(xx,y-5,3,7,P.leafDark);g.rect(xx-2,y-7,7,4,xx%3?P.red:P.goldLight);}};
  const roof=(g,x,y,w,h,main,light)=>{g.poly([[x+15,y],[x+w-15,y],[x+w,y+h],[x,y+h]],P.woodDark);for(let yy=3;yy<h-2;yy+=7){const inset=Math.ceil((h-yy)/h*15);g.rect(x+inset,y+yy,w-inset*2,5,main);g.rect(x+inset+2,y+yy,w-inset*2-4,2,light);for(let xx=x+inset+8+(yy%2)*7;xx<x+w-inset;xx+=22)g.rect(xx,y+yy+3,2,2,P.woodDark);}g.box(x-3,y+h-2,w+6,8,main,P.woodDark,2);g.rect(x,y+h,w,2,light);};
  const door=(g,x,y)=>{g.box(x-13,y-43,26,43,P.woodDark,P.ink,2);g.rect(x-9,y-39,18,36,P.wood);g.rect(x-7,y-36,3,30,P.woodLight);g.box(x-6,y-35,12,13,'#6f9a9e',P.woodDark,1);g.rect(x+6,y-19,3,3,P.goldLight);stone(g,x-19,y,38,6);};
  const icon=(g,kind,x,y)=>{
    if(kind==='book'){g.box(x-13,y-10,26,19,P.cream,P.woodDark,2);g.rect(x-10,y-7,8,12,P.red);g.rect(x+2,y-7,8,12,P.pine);g.rect(x-1,y-8,2,16,P.white);}
    if(kind==='home'){g.poly([[x-12,y-2],[x,y-13],[x+12,y-2]],P.cream);g.rect(x-9,y-3,18,14,P.cream);g.rect(x-3,y+2,6,9,P.wood);}
    if(kind==='supply'){g.box(x-12,y-8,24,18,P.gold,P.woodDark,2);g.rect(x-9,y-5,18,3,P.goldLight);g.rect(x-2,y-7,4,16,P.woodLight);}
    if(kind==='tool'){g.line(x-8,y+10,x+8,y-9,P.woodBright,4);g.line(x-9,y-8,x+5,y+7,P.stoneDark,5);g.box(x-12,y-11,9,8,P.stoneLight,P.stoneDark,1);}
    if(kind==='pot'){g.box(x-12,y-5,24,16,P.stone,P.ink,2);g.rect(x-15,y-3,5,5,P.ink);g.rect(x+10,y-3,5,5,P.ink);g.box(x-14,y-8,28,5,P.stoneLight,P.ink,1);g.rect(x-3,y-11,6,3,P.woodDark);}
  };
  function building(id){
    const g=grid(192,160),x=foot.x,y=foot.y,left=19,w=154;
    const types={cottage:['#d97e62','#f6ae80','home'],bookshop:['#478ca5','#7fc5c9','book'],tool_shed:['#608b65','#a3ba72','tool'],supply_shop:['#c99a4f','#eed18b','supply'],kitchen_shelter:['#cb735c','#f5aa72','pot']};
    const [main,light,sign]=types[id];shadow(g,x,y,174);
    stone(g,left-3,y-7,w+6,10);g.box(left,66,w,80,'#efddac',P.woodDark,3);g.rect(left+4,70,w-8,12,P.cream);g.rect(left+4,132,w-8,10,'#c49c68');
    for(const xx of[left+3,left+48,left+w-51,left+w-7]){g.rect(xx,72,4,68,P.wood);g.rect(xx+1,73,1,62,P.woodLight);}
    if(id==='kitchen_shelter'){
      g.rect(left+8,86,w-16,41,'#697d65');for(const xx of[left+4,left+w-10])g.box(xx,76,6,68,P.wood,P.woodDark,1);
      g.box(28,105,52,34,P.stone,P.stoneDark,2);g.box(34,115,15,19,P.woodDark,P.ink,2);g.rect(37,119,8,12,'#454e43');g.rect(55,112,19,3,P.stoneLight);icon(g,'pot',55,104);
      g.box(113,119,50,24,P.woodLight,P.woodDark,2);g.rect(116,122,44,3,P.cream);g.box(119,101,19,16,P.cream,P.woodDark,1);g.rect(141,110,13,7,P.leaf);g.rect(145,105,4,9,P.leafDark);g.rect(153,111,5,5,P.red);
      g.box(141,15,16,49,P.stone,P.stoneDark,2);g.rect(144,18,9,42,P.stoneLight);g.box(138,12,22,7,P.stoneLight,P.stoneDark,2);
    }else{
      door(g,x,y-4);window(g,31,90,29,31);window(g,132,90,29,31);
      if(id==='bookshop'){for(let i=0;i<5;i++)g.rect(135+i*4,104-(i%2)*3,3,13+(i%2)*3,[P.red,P.gold,P.pine,P.blue,P.purple][i]);}
      if(id==='tool_shed'){g.line(150,130,155,105,P.woodDark,3);g.box(151,101,10,6,P.stoneLight,P.stoneDark,1);g.box(28,130,19,16,P.wood,P.woodDark,2);g.rect(31,133,13,3,P.woodLight);}
      else{flowerbox(g,29,124,33);flowerbox(g,130,124,33);}
    }
    roof(g,11,27,170,45,main,light);
    if(id==='cottage'){g.box(142,13,14,28,P.stoneLight,P.stoneDark,2);g.box(139,11,20,6,P.stone,P.stoneDark,2);roof(g,76,15,40,24,main,light);g.box(87,25,18,17,P.cream,P.woodDark,2);g.box(91,28,10,10,P.blueLight,P.woodDark,1);}
    g.box(75,71,42,28,main,P.woodDark,2);g.rect(78,73,36,2,light);icon(g,sign,96,84);
    if(id==='supply_shop'){for(let i=0;i<6;i++){g.rect(25+i*24,98,24,11,i%2?P.cream:light);g.rect(25+i*24,107,24,4,i%2?'#d4c5a0':main);}g.box(23,95,146,5,P.woodLight,P.woodDark,1);}
    return {id,g,anchor:[x,y]};
  }
  function games(){const g=grid(112,96),x=56,y=86;shadow(g,x,y,94);for(const xx of[16,89])g.box(xx,58,7,29,P.wood,P.woodDark,2);g.box(8,42,96,29,P.wood,P.woodDark,2);g.rect(11,45,90,5,P.woodBright);g.rect(11,50,90,15,P.woodLight);g.box(32,44,48,20,P.cream,P.woodDark,2);for(let yy=0;yy<3;yy++)for(let xx=0;xx<7;xx++)if((xx+yy)%2)g.rect(35+xx*6,47+yy*5,6,5,P.pine);g.box(42,46,5,5,P.red,P.redDark,1);g.box(64,54,5,5,P.blue,P.ink,1);g.box(13,50,13,10,P.woodBright,P.woodDark,1);g.rect(18,53,3,3,P.red);return{id:'games',g,anchor:[x,y]};}
  function gate(id='portal'){const g=grid(104,154),x=52,y=114;shadow(g,x,y,98);for(const xx of[10,85]){stone(g,xx-4,90,16,24);g.box(xx,21,8,78,P.wood,P.woodDark,2);g.rect(xx+2,24,2,65,P.woodBright);}g.box(7,19,90,13,P.wood,P.woodDark,2);g.rect(10,21,84,3,P.woodBright);roof(g,2,3,100,14,id==='portal'?P.pine:P.blue,id==='portal'?P.pineLight:P.blueLight);g.box(34,30,36,24,P.cream,P.woodDark,2);if(id==='portal'){g.poly([[52,33],[62,45],[58,45],[65,49],[39,49],[46,43],[42,43]],P.pine);g.rect(50,45,4,7,P.wood);}else{g.line(42,42,61,42,P.blue,3);g.line(61,42,55,36,P.blue,3);g.line(61,42,55,48,P.blue,3);}return{id,g,anchor:[x,y+32]};}
  function market(){const g=grid(176,140),x=88,y=132;shadow(g,x,y,160);for(const xx of[16,154])g.box(xx,42,7,90,P.woodLight,P.woodDark,2);g.box(14,75,148,51,'#c79b61',P.woodDark,2);g.rect(18,78,140,7,P.woodBright);g.rect(18,88,140,3,P.woodDark);for(let xx=20;xx<155;xx+=17)g.rect(xx,94,2,27,P.wood);g.box(27,51,42,23,P.woodLight,P.woodDark,2);g.box(30,55,35,15,P.cream,P.wood,1);g.rect(35,59,22,2,P.blue);g.rect(35,64,15,2,P.blue);g.box(105,57,34,17,P.wood,P.woodDark,2);g.rect(109,60,26,3,P.woodBright);g.rect(112,64,3,7,P.gold);g.rect(131,64,3,7,P.gold);for(let i=0;i<8;i++){g.poly([[12+i*19,19],[31+i*19,19],[36+i*19,48],[7+i*19,48]],i%2?P.cream:P.pine);g.rect(9+i*19,47,22,9,i%2?'#dbd2ad':P.leafDark);}g.box(10,15,156,6,P.woodLight,P.woodDark,2);g.rect(12,18,152,2,P.woodBright);return{id:'market_stall',g,anchor:[x,y]};}
  function dining(){const g=grid(68,68);shadow(g,34,58,62);for(const xx of[9,53])g.box(xx,39,5,22,P.wood,P.woodDark,1);g.box(3,25,62,23,P.woodLight,P.woodDark,2);g.rect(6,28,56,4,P.woodBright);g.rect(27,28,14,17,P.cream);g.blob(10,31,14,7,P.stoneDark);g.blob(12,31,10,5,P.white);g.blob(45,31,14,7,P.stoneDark);g.blob(47,31,10,5,P.white);g.box(31,29,7,11,P.blue,P.woodDark,1);g.rect(33,31,3,3,P.blueLight);return{id:'community_table',g,anchor:[34,50]};}
  function seat(facing){const g=grid(30,30);for(const xx of[6,22])g.rect(xx,18,3,10,P.woodDark);g.box(3,15,24,7,P.woodLight,P.woodDark,1);g.rect(5,16,20,2,P.woodBright);if(facing==='south'){g.box(3,3,24,7,P.woodLight,P.woodDark,1);g.rect(5,9,2,7,P.woodDark);g.rect(23,9,2,7,P.woodDark);}else if(facing==='north'){g.box(3,19,24,8,P.woodLight,P.woodDark,1);g.rect(5,20,20,2,P.woodBright);}else{const xx=facing==='east'?3:23;g.box(xx,4,4,20,P.woodLight,P.woodDark,1);}return{id:`community_seat_${facing}`,g,anchor:[15,23]};}
  return {props:[...['cottage','bookshop','tool_shed','supply_shop','kitchen_shelter'].map(building),games(),gate()],services:[market(),dining(),gate('journey'),...['north','south','east','west'].map(seat)]};
}

export function plazaGround(Grid,P){
  const g=new Grid(PLAZA_MAP.width*32,PLAZA_MAP.height*32);g.rect(0,0,g.width,g.height,P.grass);
  let seed=3601;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<75;i++){const x=Math.floor(random()*g.width/8)*8,y=Math.floor(random()*g.height/8)*8;g.blob(x,y,64+Math.floor(random()*8)*16,32+Math.floor(random()*5)*16,'#8bc361',8);}
  for(let i=0;i<1200;i++){const x=Math.floor(random()*g.width/2)*2,y=Math.floor(random()*g.height/2)*2;g.rect(x,y,4,2,P.grassLight);if(i%4===0){g.rect(x+4,y-3,2,5,P.grassDark);g.rect(x-2,y-2,2,4,P.grassDark);}}
  // Broad connected dirt lanes; the widths are authoritative world tiles.
  const lanes=(color,inset=0)=>{for(const road of PLAZA_ROADS)for(let i=1;i<road.points.length;i++){const a=road.points[i-1],b=road.points[i];g.line((a.x+.5)*32,(a.y+.5)*32,(b.x+.5)*32,(b.y+.5)*32,color,road.width*32-inset);}};
  lanes('#79ad56',-8);lanes('#c2aa74',-2);lanes(P.sand,2);lanes('#efd99f',12);
  // Weathered stone meeting court, softly stepped corners rather than zone boxes.
  for(const p of PLAZA_PAVING){const x=p.x*32,y=p.y*32,w=p.width*32,h=p.height*32;g.poly([[x+24,y],[x+w-24,y],[x+w,y+24],[x+w,y+h-24],[x+w-24,y+h],[x+24,y+h],[x,y+h-24],[x,y+24]],'#b9b895');for(let yy=y+4;yy<y+h-4;yy+=16)for(let xx=x+4+(Math.floor((yy-y)/16)%2)*12;xx<x+w-8;xx+=24){if((xx<x+24||xx>x+w-28)&&(yy<y+24||yy>y+h-28))continue;g.rect(xx,yy,21,13,(xx+yy)%7?'#d6cda6':'#ddd5b1');g.rect(xx+1,yy+1,18,2,'#e8dfbc');g.rect(xx+2,yy+11,17,1,'#a9aa8b');}}
  // Small landing aprons connect doors to their lane without masking occupancy.
  for(const p of PLAZA_PROPS.filter(p=>['cottage','bookshop','shed'].includes(p.kind))){const x=(p.position.x+.5)*32,y=(p.position.y+.5)*32;g.rect(x-42,y+9,84,24,'#b9b895');for(let xx=x-39;xx<x+39;xx+=20)g.box(xx,y+12,18,18,'#dfd2ab','#a7a487',1);}
  // Sparse native-pixel grit breaks up the road surfaces. Sample the painted
  // lane first so grit cannot spill into grass, door landings or court stones.
  for(let i=0;i<5800;i++){
    const x=Math.floor(random()*g.width/2)*2,y=Math.floor(random()*g.height/2)*2,index=(y*g.width+x)*4;
    const road=(g.data[index]===239&&g.data[index+1]===217)||(g.data[index]===232&&g.data[index+1]===206);
    if(road){g.rect(x,y,i%5===0?6:2,2,i%3?'#e6cd92':'#f5e3b3');if(i%13===0)g.rect(x+4,y+3,3,1,'#d8bd85');}
  }
  const pond=PLAZA_PROPS.find(p=>p.kind==='pond'),cells=pond.footprint;const minX=Math.min(...cells.map(p=>p.x))*32,minY=Math.min(...cells.map(p=>p.y))*32,w=(Math.max(...cells.map(p=>p.x))*32-minX)+32,h=(Math.max(...cells.map(p=>p.y))*32-minY)+32;
  g.rect(minX-8,minY-8,w+16,h+16,P.grassDark);g.rect(minX-4,minY-4,w+8,h+8,'#bbcc8b');g.rect(minX,minY,w,h,P.water);g.rect(minX,minY,w,6,P.waterDeep);g.rect(minX,minY,6,h,P.waterDeep);g.rect(minX+6,minY+h-6,w-6,6,P.waterLight);
  for(let i=0;i<34;i++){const x=minX+12+Math.floor(random()*(w-34)/2)*2,y=minY+14+Math.floor(random()*(h-28)/2)*2;g.rect(x,y,10+(i%3)*6,2,i%2?P.waterLight:'#7dcbdb');}
  for(const [x,y]of[[minX+25,minY+24],[minX+w-45,minY+h-33],[minX+52,minY+h-23]]){g.blob(x,y,19,9,P.leafDark);g.blob(x+2,y,15,6,P.leafLight);g.rect(x+7,y-3,5,5,P.cream);}
  const deck=(x,y,w,h)=>{g.box(x,y,w,h,P.wood,P.woodDark,2);for(let yy=y+3;yy<y+h-2;yy+=7){g.rect(x+3,yy,w-6,5,P.woodLight);g.rect(x+5,yy+1,Math.max(1,w-10),1,P.woodBright);}};
  deck(6*32+3,8*32+3,3*32-6,32-6);deck(11*32+3,4*32+3,32-6,3*32-6);
  // Low flowers at map margins never impersonate seats, light sources or loot.
  for(const [tx,ty]of[[17,4],[28,4],[6,14],[12,13],[7,26],[39,11],[39,17],[34,28],[21,25],[26,30],[43,10]])for(let i=0;i<5;i++){const x=tx*32+3+(i%3)*9,y=ty*32+7+Math.floor(i/3)*8;g.rect(x,y,2,6,P.leafDark);g.rect(x-2,y-2,6,4,i%2?P.cream:'#edd184');}
  return g;
}
