import { HOME_PIXEL_ART } from './home-pixel-manifest.js';

export const HOME_PALETTE = Object.freeze({
  ink:'#634632', wood:'#b97742', woodLight:'#e5a85b', woodTop:'#ffcd7a', woodShade:'#915731',
  cream:'#fff3ce', paper:'#fff9e8', green:'#73ab65', greenLight:'#acd88a', greenDark:'#426849',
  blue:'#73b8c9', blueLight:'#a9dce0', red:'#df7f61', gold:'#efbd57', stone:'#849e96', stoneLight:'#bfd1b3',
});

// Rectangles are source pixels, never paths reduced from large illustrations.
function canvas(width, height) {
  const rects=[];
  const rect=(x,y,w,h,fill)=>{
    const left=Math.max(0,Math.round(x)), top=Math.max(0,Math.round(y));
    const right=Math.min(width,Math.round(x+w)), bottom=Math.min(height,Math.round(y+h));
    if(right>left&&bottom>top)rects.push({x:left,y:top,width:right-left,height:bottom-top,fill});
  };
  return {width,height,rects,rect};
}

export function homeFurniturePixels(kind, rotation=0, layer='base') {
  const normal=((Number(rotation)||0)%360+360)%360;
  const art=HOME_PIXEL_ART[kind]?.variants[normal]||HOME_PIXEL_ART[kind]?.variants[0];
  if(!art)return null;
  const {width:w,height:h}=art.native, c=canvas(w,h),r=c.rect,p=HOME_PALETTE;
  const side=normal===90||normal===270, west=normal===90, back=normal===180;
  const box=(x,y,bw,bh,fill,edge=p.ink)=>{r(x,y,bw,bh,edge);r(x+2,y+2,bw-4,bh-4,fill);};
  const leg=(x,y,bh)=>{r(x,y,5,bh,p.ink);r(x+1,y,3,bh-2,p.wood);};
  if(kind==='chair'){
    const sy=Math.round(h*.57), seatLeft=side?3:2, seatW=w-5;
    leg(4,sy+9,h-sy-10);leg(w-9,sy+9,h-sy-10);
    // Back posts and slats rotate with the saved heading, not the entire actor.
    if(side){
      const x=west?w-10:3;box(x,26,7,sy-18,p.woodLight);
      r(west?x-3:x+5,28,5,5,p.woodTop);
    }else{
      box(3,26,w-6,sy-20,p.woodLight);r(7,29,w-14,5,p.woodTop);
    }
    box(seatLeft,sy,seatW,12,p.woodLight);r(seatLeft+3,sy+2,seatW-6,4,p.woodTop);
    if(back){box(3,26,w-6,sy-16,p.woodLight);r(7,29,w-14,5,p.woodTop);r(7,39,w-14,3,p.woodShade);}
  }else if(kind==='table'){
    const sy=Math.round(h*.16), bottom=Math.round(h*.57);
    leg(5,bottom,h-bottom-1);leg(w-10,bottom,h-bottom-1);
    if(side)leg(west?w*.3:w*.7-4,bottom-1,h-bottom-10);
    box(1,sy,w-2,bottom-sy+7,p.woodLight);r(4,sy+3,w-8,7,p.woodTop);
    r(4,bottom,w-8,5,p.woodShade);
    if(side){r(Math.round(w*.5),sy+4,2,bottom-sy-6,p.wood);}
    else{r(5,sy+14,w-10,2,p.wood);r(5,sy+26,w-10,2,p.wood);}
    r(back?w-16:8,sy+8,7,2,p.cream);
  }else if(kind==='bed'){
    const y=Math.round(h*.12), bh=Math.round(h*.78);
    leg(4,y+bh-3,h-y-bh+2);leg(w-9,y+bh-3,h-y-bh+2);
    box(1,y,w-2,bh,p.woodLight);box(5,y+5,w-10,bh-11,p.cream);
    if(side){
      const head=west?w-18:3,pillow=Math.round(w*(west?.43:.26));
      box(head,2,15,h-10,p.woodLight);r(head+3,5,9,6,p.woodTop);
      box(pillow,y+9,Math.round(w*.31),bh-23,p.paper,p.gold);
      const left=west?7:Math.round(w*.56),rw=west?Math.round(w*.43)-7:w-left-7;
      box(left,y+8,rw,bh-20,p.green);r(left+2,y+10,rw-4,7,p.greenLight);
      r(left+5,y+21,rw-10,3,p.greenDark);r(left+5,y+29,rw-10,3,p.greenLight);
    }else{
      const head=back?h-20:2;
      box(1,head,w-2,18,p.woodLight);r(5,head+3,w-10,5,p.woodTop);
      const py=back?h-38:y+7, by=back?y+4:y+29, blanketHeight=back?bh-28:bh-34;
      box(11,py,w-22,17,p.paper,p.gold);r(15,py+4,w-30,3,p.cream);
      box(7,by,w-14,blanketHeight,p.green);r(9,by+2,w-18,8,p.greenLight);
      r(13,by+18,w-26,3,p.greenDark);r(13,by+27,w-26,3,p.greenLight);
      if(!back){box(1,h-16,w-2,12,p.woodLight);r(5,h-13,w-10,3,p.woodTop);}
    }
  }else if(kind==='bookshelf'||kind==='display_shelf'){
    const inset=kind==='bookshelf'?6:5;box(1,2,w-2,h-3,p.woodLight);r(4,5,w-8,5,p.woodTop);
    if(back||side){
      r(5,12,w-10,h-18,p.wood);r(8,15,3,h-24,p.woodLight);
      if(!side){r(Math.round(w/2),12,2,h-18,p.woodShade);r(5,h*.54,w-10,3,p.woodShade);}
      else{r(west?3:w-6,15,3,h-22,p.cream);r(west?3:w-6,h*.5,3,5,p.woodShade);}
      r(w-7,7,3,h-12,p.woodShade);
    }else{
      r(inset,13,w-inset*2,h-23,p.woodShade);
      const levels=kind==='bookshelf'?3:2;
      for(let row=0;row<levels;row++){
        const top=14+row*Math.floor((h-24)/levels), bottom=14+(row+1)*Math.floor((h-24)/levels);
        if(kind==='bookshelf')for(let j=0;j<Math.floor((w-16)/9);j++){
          const x=8+j*9, height=12+((j+row)%3)*3;
          r(x,bottom-height-4,7,height,[p.green,p.red,p.blue,p.gold][(j+row)%4]);
          r(x+1,bottom-height-2,5,2,p.cream);r(x+1,bottom-7,5,1,p.cream);
        }
        r(3,bottom-3,w-6,6,p.ink);r(5,bottom-3,w-10,3,p.woodTop);
      }
    }
  }else if(kind==='rug'){
    box(1,2,w-2,h-4,p.green,p.greenDark);r(4,5,w-8,h-10,p.cream);r(7,8,w-14,h-16,p.greenLight);
    const cx=Math.floor(w/2),cy=Math.floor(h/2);
    r(cx-5,cy-2,10,4,p.greenDark);r(cx-2,cy-5,4,10,p.greenDark);
    for(let x=4;x<w-4;x+=7){r(x,0,3,2,p.gold);r(x,h-2,3,2,p.gold);}
    if(side){r(9,12,3,5,p.gold);r(w-12,h-17,3,5,p.gold);}else{r(13,10,5,3,p.gold);r(w-18,h-13,5,3,p.gold);}
  }
  if(kind==='bed'&&layer==='foreground'){
    // The original clipping envelope is retained; only the near blanket and
    // foot rail occlude a sleeper. The far headboard stays behind their head.
    c.rects.length=0;
    const y=Math.round(h*.12),bh=Math.round(h*.78);
    if(side){
      const left=west?7:Math.round(w*.56),rw=west?Math.round(w*.43)-7:w-left-7;
      box(left,y+8,rw,bh-20,p.green);r(left+2,y+10,rw-4,7,p.greenLight);
      r(left+5,y+21,rw-10,3,p.greenDark);r(left+5,y+29,rw-10,3,p.greenLight);
    }else{
      const by=back?y+4:y+29,blanketHeight=back?bh-28:bh-34;
      box(7,by,w-14,blanketHeight,p.green);r(9,by+2,w-18,8,p.greenLight);
      r(13,by+18,w-26,3,p.greenDark);r(13,by+27,w-26,3,p.greenLight);
      if(!back){box(1,h-16,w-2,12,p.woodLight);r(5,h-13,w-10,3,p.woodTop);}
    }
  }
  return {width:w,height:h,rects:c.rects};
}

export function homeSouvenirPixels(item) {
  const c=canvas(24,24),r=c.rect,p=HOME_PALETTE;
  if(item==='ruins_leaf_medallion'){
    r(6,2,12,2,p.ink);r(3,4,18,16,p.ink);r(6,20,12,2,p.ink);r(5,5,14,14,p.gold);
    r(7,8,10,7,p.green);r(9,5,8,4,p.greenLight);r(7,15,6,3,p.greenDark);r(10,9,2,8,p.cream);r(12,7,2,5,p.cream);
  }else if(item==='ruins_stone_bird'){
    r(3,20,18,3,p.ink);r(5,18,14,2,p.stoneLight);r(6,9,11,9,p.stone);r(12,4,7,8,p.stone);
    r(17,7,5,3,p.gold);r(15,5,2,2,p.ink);r(3,12,5,5,p.stone);r(7,10,4,4,p.stoneLight);r(10,18,2,2,p.ink);
  }else if(item==='ruins_star_lens'){
    r(6,2,12,2,p.ink);r(3,5,18,12,p.ink);r(6,4,12,14,p.gold);r(5,6,14,10,p.gold);
    r(8,5,8,12,p.blue);r(6,8,12,6,p.blue);r(9,7,3,6,p.paper);r(12,6,3,3,p.paper);
    r(10,18,4,3,p.wood);r(5,21,14,2,p.ink);
  }else if(item==='pine_cone'){
    r(10,2,5,3,p.ink);r(7,5,11,15,p.ink);r(4,9,17,8,p.ink);r(8,20,9,2,p.ink);
    r(9,5,6,14,p.wood);r(6,9,12,8,p.wood);for(let y=7;y<20;y+=4){r(y%8===7?8:11,y,5,2,p.woodTop);r(y%8===7?14:6,y,4,2,p.woodShade);}
  }else if(item==='ore'){
    r(6,4,12,17,p.ink);r(3,10,18,10,p.ink);r(7,5,9,13,p.stoneLight);r(4,11,15,7,p.stone);
    r(7,7,5,4,p.paper);r(12,12,6,6,p.greenDark);
  }else if(item==='wood'){
    r(3,7,18,12,p.ink);r(5,5,14,16,p.ink);r(5,7,14,12,p.wood);r(6,9,5,9,p.woodTop);
    r(7,11,3,5,p.woodShade);r(12,8,7,2,p.woodTop);r(12,16,7,2,p.woodShade);
  }else{
    // Unknown real objects receive a neutral display token, never invented loot.
    r(5,5,14,14,p.ink);r(7,7,10,10,p.cream);r(10,10,4,4,p.gold);
  }
  return {width:24,height:24,rects:c.rects};
}

export function homeRoomPixels(phase='day'){
  const c=canvas(640,540),r=c.rect,p=HOME_PALETTE;
  const night=phase==='night', warm=phase==='dusk'||phase==='dawn';
  r(0,0,640,540,night?'#a5b4a1':'#dae8ad');r(49,6,542,497,p.ink);
  r(70,25,500,110,night?'#b8c7ac':warm?'#f7d6a4':'#fff0c3');
  for(let x=74;x<570;x+=32){r(x,29,2,97,night?'#a4b69a':'#ebd5a1');r(x+9,53,6,6,night?'#bdcbb3':'#f8dfad');}
  r(70,124,500,11,p.woodShade);r(70,124,500,4,p.woodTop);
  r(70,135,500,336,p.woodLight);
  for(let row=0;row<8;row++){
    const y=135+row*42;r(70,y,500,3,p.wood);r(70,y+3,500,3,p.woodTop);
    for(let col=0;col<5;col++){
      const x=70+col*100+(row%2?50:0);if(x<570)r(x,y,2,42,p.wood);
      r(Math.min(x+15,545),y+18,16,2,'#e9ae63');
    }
  }
  r(52,3,536,22,p.woodShade);r(56,7,528,10,p.woodLight);r(60,7,520,4,p.woodTop);
  for(const x of [49,570]){r(x,25,21,446,p.woodShade);r(x+4,25,10,446,p.woodLight);r(x+4,25,3,446,p.woodTop);}
  // Window is architectural decoration; daylight follows the server phase.
  r(421,42,105,71,p.woodShade);r(425,46,97,63,p.cream);r(430,51,87,53,night?'#4d7194':warm?'#e6b77f':'#91d7df');
  r(430,89,87,15,night?'#6c9474':'#a9d78a');r(469,48,8,58,p.cream);r(427,74,93,6,p.cream);
  if(night){r(497,55,8,8,p.cream);r(493,59,8,8,p.cream);}else{r(440,58,18,6,p.paper);r(444,54,10,4,p.paper);}
  r(416,108,115,8,p.woodTop);r(421,116,105,4,p.woodShade);
  r(132,47,63,58,p.woodShade);r(136,51,55,50,p.gold);r(141,56,45,40,p.cream);
  r(148,78,30,11,p.greenLight);r(156,64,14,20,p.green);r(160,88,6,8,p.wood);r(162,60,6,6,p.gold);
  for(const [x,w] of [[60,260],[370,210]]){r(x,471,w,31,p.ink);r(x+2,473,w-4,22,p.woodLight);r(x+3,473,w-6,6,p.woodTop);r(x+3,493,w-6,3,p.woodShade);}
  r(320,471,50,41,p.woodShade);r(324,473,42,31,p.woodTop);r(328,479,34,23,p.woodLight);r(324,506,42,6,p.cream);
  return {width:640,height:540,rects:c.rects};
}

export function homeCottagePixels(){
  const c=canvas(120,97),r=c.rect,p=HOME_PALETTE;
  r(8,83,104,7,p.green);r(13,79,95,8,p.greenLight);r(23,40,76,44,p.ink);r(27,43,68,37,p.cream);
  r(84,14,10,24,p.ink);r(86,16,6,19,p.woodLight);r(82,12,14,5,p.woodShade);
  for(let row=0;row<8;row++){const x=11+row*5,y=41-row*4;r(x,y,98-row*10,6,p.ink);r(x+3,y,92-row*10,3,row%2?p.red:'#f3a174');}
  r(17,44,86,5,p.woodShade);r(26,48,4,32,p.woodLight);r(91,48,4,32,p.woodLight);
  r(51,53,22,31,p.ink);r(54,56,16,25,p.wood);r(57,58,10,3,p.woodTop);r(65,69,3,3,p.gold);
  for(const x of [33,77]){r(x,54,15,17,p.woodShade);r(x+2,56,11,13,p.blue);r(x+7,56,2,13,p.cream);r(x+2,62,11,2,p.cream);r(x-1,71,17,4,p.woodLight);}
  r(48,84,28,5,p.woodTop);r(44,89,36,4,p.cream);
  for(const x of [15,98]){r(x,69,9,15,p.greenDark);r(x-3,73,15,8,p.green);r(x+1,70,5,5,p.greenLight);r(x+2,75,3,3,p.gold);}
  return {width:120,height:97,rects:c.rects};
}
