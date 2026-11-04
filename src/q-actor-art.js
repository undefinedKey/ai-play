// Original 48px pixel drawings. Coordinates are authored cells, not traced or
// downsampled illustrations. The build and presentation tests share this source.
import { journeyIdentity } from './journey-pixel-art.js';

export const Q_ACTOR_GEOMETRY = Object.freeze({ width:48,height:48,foot:{x:24,y:43},hip:{x:24,y:36},hipHeight:7 });
export const Q_ACTOR_ACTIONS = Object.freeze(['idle','walk','run','attack','hurt','till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat','rest','tired','fish','sit','read','sleep','write','listen','perform','home_eat','stand_read','stand_write']);
export const Q_DIRECTIONS = Object.freeze(['south','north','east']);
const seatedActions=new Set(['sit','read','rest','sleep','write','listen','home_eat']);
const workActions=new Set(['attack','till','gather','repair','upgrade']);
const pickActions=new Set(['plant','harvest','craft','cook']);
const ink='#30394b', metal='#bad6d9', wood='#a97845', lightWood='#e1b76b';
function drawing(){const pixels=[];return {pixels,r(x,y,w,h,color,part='body'){if(w>0&&h>0)pixels.push({x,y,w,h,color,part});}};}
const frameOf=frame=>Math.max(0,Math.min(3,Math.trunc(frame||0)));

/** One geometry sample for body and every overlay, with no world displacement. */
export function qActorPose(action='idle',direction='south',frame=0){
  frame=frameOf(frame);direction=direction==='west'?'east':direction;
  const moving=['walk','run'].includes(action),seated=seatedActions.has(action),sleep=action==='sleep';
  const stride=moving?(action==='run'?[-4,0,4,0]:[-2,0,2,0])[frame]:0;
  const bob=moving&&frame%2?-1:pickActions.has(action)&&frame===1?2:workActions.has(action)&&frame===2?1:0;
  const by=bob+(seated?5:0),side=direction==='east';
  let hand={x:side?33:32,y:35+by},farHand={x:side?16:13,y:35+by};
  if(moving){hand.x+=Math.round(stride/2);hand.y-=frame===1?2:0;farHand.x-=Math.round(stride/2);farHand.y-=frame===3?2:0;}
  if(workActions.has(action))hand=frame<2?{x:side?31:32,y:frame===0?25:23}:{x:side?36:34,y:frame===2?32:35};
  if(pickActions.has(action)){hand={x:side?35:29,y:37+Math.min(1,frame%2)};farHand={x:side?27:18,y:37+Math.min(1,frame%2)};}
  if(action==='water')hand={x:side?34:32,y:32+frame%2};
  if(action==='eat'||action==='home_eat')hand={x:side?32:29,y:27+by+frame%2};
  if(['read','write','stand_read','stand_write'].includes(action)){hand={x:side?32:30,y:35+by};farHand={x:side?21:17,y:35+by};}
  if(action==='perform'){hand={x:side?34:34,y:frame%2?25:30};farHand={x:side?15:12,y:frame%2?30:25};}
  if(action==='fish')hand={x:side?32:31,y:32+frame%2};
  if(sleep){hand=direction==='east'?{x:31,y:37}:direction==='north'?{x:19,y:12}:{x:29,y:36};farHand={...hand};}
  return {action,direction,frame,moving,seated,sleep,stride,bob,by,hand,farHand,head:sleep?(direction==='east'?{x:16,y:31}:direction==='north'?{x:24,y:26}:{x:24,y:22}):{x:24,y:17+by},hip:{x:24,y:sleep&&direction==='north'?12:seated?36:34+by}};
}
function arm(d,p,x,y,color,part){d.r(x-2,y-6,5,7,p.outline,part);d.r(x-1,y-5,3,5,color,part);d.r(x-2,y,5,4,p.outline,part);d.r(x-1,y,3,3,p.skin,part);}
function boot(d,p,x,y,part){d.r(x,y,5,6,p.outline,part);d.r(x+1,y,3,4,p.pants,part);d.r(x,y+4,7,3,p.outline,part);d.r(x+1,y+4,5,2,p.boots,part);}
function head(d,p,s){
  const r=d.r,b=s.by,north=s.direction==='north',side=s.direction==='east';
  r(16,7+b,15,2,ink,'head');r(13,9+b,21,3,ink,'head');r(12,12+b,23,11,ink,'head');r(15,23+b,18,3,ink,'head');r(19,26+b,11,1,ink,'head');
  if(north){
    r(14,11+b,19,12,p.hair,'hair');r(16,9+b,15,4,p.hair,'hair');r(16,23+b,15,3,p.hair,'hair');
    r(16,11+b,7,3,p.hairLight,'hair');r(15,15+b,2,6,p.hairLight,'hair');r(27,18+b,3,6,p.hairLight,'hair');r(20,23+b,2,3,p.hairLight,'hair');
  }else{
    r(side?17:15,12+b,side?17:18,11,p.skin,'face');r(18,23+b,13,3,p.skin,'face');r(side?21:17,14+b,11,3,p.skinLight,'face');
    r(13,10+b,6,13,p.hair,'hair');r(15,8+b,16,6,p.hair,'hair');r(14,12+b,19,3,p.hair,'hair');r(16,9+b,10,2,p.hairLight,'hair');r(18,14+b,4,3,p.hair,'hair');r(27,14+b,3,2,p.hair,'hair');
    if(!side){r(31,13+b,3,11,p.hair,'hair');r(13,20+b,3,5,p.hair,'hair');}
    const eyes=side?[24,30]:[18,28],closed=['rest','sleep'].includes(s.action)||['idle','read','stand_read','sit','listen'].includes(s.action)&&s.frame===3;
    for(const x of eyes){
      if(closed)r(x,20+b,3,1,ink,'eyes');
      else if(s.action==='hurt'){r(x,19+b,3,1,ink,'eyes');r(x+2,20+b,1,2,ink,'eyes');}
      else{r(x,18+b,3,4,ink,'eyes');r(x,18+b,1,1,'#fffced','eyes');}
    }
    r(side?20:16,22+b,3,1,'#e8957a','face');r(30,22+b,2,1,'#e8957a','face');r(side?27:23,24+b,2,1,'#a26555','face');
    if(side){r(34,18+b,2,4,ink,'face');r(34,19+b,1,2,p.skin,'face');}
  }
  if(p.variant===2){r(17,5+b,5,4,p.hair,'hair');r(20,3+b,4,3,p.hair,'hair');r(21,4+b,2,3,p.hairLight,'hair');}
  if(p.variant===3){r(14,5+b,3,5,p.hair,'hair');r(28,5+b,3,5,p.hair,'hair');}
  if(p.variant===4||p.variant===6){const x=north?21:9;r(x,10+b,5,13,p.hair,'hair');r(x+1,11+b,2,10,p.hairLight,'hair');}
  if(p.variant===7){r(12,7+b,4,18,p.coat,'hood');r(14,6+b,17,3,p.coat,'hood');if(north)r(14,9+b,19,15,p.coat,'hood');}
  if(p.variant===1){r(14,5+b,17,7,'#9d723e','hat');r(16,6+b,13,5,'#e4bb68','hat');r(10,11+b,26,3,ink,'hat');r(11,11+b,24,2,'#f0d285','hat');}
}
export function qCharacterPixels(id,state={}){
  const actor={agent_id:id,appearance:{sprite_id:id,seed:id}},p=journeyIdentity(actor),s=qActorPose(state.action,state.direction,state.frame),d=drawing(),r=d.r;
  if(s.sleep){
    if(s.direction!=='east'){
      const pixels=qCharacterPixels(id,{action:'rest',direction:'south',frame:state.frame}).filter(px=>!['far-arm','near-arm','legs'].includes(px.part));
      pixels.push({x:18,y:39,w:5,h:4,color:p.boots,part:'legs'},{x:27,y:39,w:5,h:4,color:p.boots,part:'legs'},{x:18,y:35,w:13,h:3,color:p.coatLight,part:'near-arm'},{x:24,y:35,w:5,h:3,color:p.skin,part:'near-arm'});
      return s.direction==='north'?pixels.map(px=>({...px,x:48-px.x-px.w,y:48-px.y-px.h})):pixels;
    }
    // Head remains readable while the small body lies across the real bed.
    r(15,34,26,8,ink,'body');r(17,35,15,6,p.coat,'body');r(29,36,10,4,p.pants,'legs');r(38,35,5,7,p.boots,'legs');
    const face=qCharacterPixels(id,{action:'rest',direction:state.direction,frame:state.frame}).filter(px=>['head','face','eyes','hair','hat','hood'].includes(px.part));
    for(const px of face)d.pixels.push({...px,x:px.x-8,y:px.y+9});
    r(23,36,9,3,p.coatLight,'near-arm');r(30,36,4,3,p.skin,'near-arm');return d.pixels;
  }
  if(s.seated){r(16,38,17,4,ink,'legs');r(17,38,14,2,p.pants,'legs');r(s.direction==='east'?28:17,40,7,3,p.boots,'legs');r(s.direction==='east'?29:27,40,7,3,p.boots,'legs');}
  else{const side=s.direction==='east';boot(d,p,18-(side?s.stride:0),36+(s.moving&&s.frame===1?-2:0),'far-leg');boot(d,p,25+(side?s.stride:0),36+(s.moving&&s.frame===3?-2:0),'near-leg');if(!side&&s.moving){r(18,40+(s.frame===1?-2:0),6,2,p.boots,'far-leg');r(25,40+(s.frame===3?-2:0),6,2,p.boots,'near-leg');}}
  arm(d,p,s.farHand.x,s.farHand.y,p.coat,'far-arm');
  r(17,27+s.by,14,11,ink);r(18,28+s.by,12,8,p.coat);r(19,28+s.by,4,8,p.coatLight);r(18,35+s.by,12,2,p.coat);
  if(s.direction!=='north'){r(22,26+s.by,7,3,p.skin);r(21,28+s.by,9,2,p.coatLight);r(25,30+s.by,2,6,'#fff0b0');}
  else{r(18,28+s.by,12,2,p.coatLight);r(23,31+s.by,2,5,p.coatLight);}
  head(d,p,s);arm(d,p,s.hand.x,s.hand.y,p.coatLight,'near-arm');
  if(['read','write','stand_read','stand_write'].includes(s.action)&&s.direction!=='north'){
    r(18,34+s.by,15,5,ink,'book');r(19,34+s.by,6,4,'#fff0bf','book');r(26,34+s.by,6,4,'#ead89c','book');r(25,34+s.by,1,5,'#b78c58','book');
    r(s.frame===2?24:20,35+s.by,s.frame===2?2:3,1,'#bea477','book');r(28,36+s.by,3,1,'#bea477','book');
    if(['write','stand_write'].includes(s.action)){r(31,s.hand.y-3,1,5,'#745039','pen');r(31,s.hand.y-4,1,2,'#fff0bf','pen');}
  }
  return d.pixels;
}

export function qAccessoryPixels(id,state={}){
  if(state.action==='sleep'&&state.direction!=='east'){
    const pixels=qAccessoryPixels(id,{...state,action:'rest',direction:'south'});
    return state.direction==='north'?pixels.map(px=>({...px,x:48-px.x-px.w,y:48-px.y-px.h})):pixels;
  }
  const s=qActorPose(state.action,state.direction,state.frame),d=drawing(),r=d.r,by=s.sleep?s.by+9:s.by,dx=s.sleep?-8:0,x=(s.direction==='north'?27:13)+dx;
  if(id==='leaf'){r(x,9+by,4,2,'#a8d55f','accessory');r(x-2,7+by,4,3,'#5fa64e','accessory');r(x-1,8+by,2,1,'#cbe78c','accessory');}
  if(id==='ribbon'){r(x-1,10+by,4,3,'#dc7d93','accessory');r(x+3,11+by,2,2,'#ffe39d','accessory');r(x+5,10+by,4,3,'#dc7d93','accessory');}
  if(id==='star'){r(x+1,9+by,2,6,'#ffe482','accessory');r(x-1,11+by,6,2,'#f0bd48','accessory');}
  if(id==='scarf'){if(s.sleep){r(17,34,3,7,'#ed9f50','accessory');r(19,39,7,2,'#ed9f50','accessory');}else{r(18+dx,27+by,13,3,'#ed9f50','accessory');r(17+dx,29+by,4,6,'#ed9f50','accessory');r(18+dx,33+by,2,1,'#ffe9ae','accessory');}}
  return d.pixels;
}

/** Full-canvas gear shares the authored hand and foot of its body frame. */
export function qGearPixels(id,state={},level=1){
  if(state.action==='sleep'){
    if(!['iron_armor','heavy_armor','wooden_shield'].includes(id))return [];
    const pixels=qGearPixels(id,{...state,action:'rest',direction:'south'},level);
    if(state.direction==='north')return pixels.map(px=>({...px,x:48-px.x-px.w,y:48-px.y-px.h}));
    return state.direction==='east'?pixels.map(px=>({...px,y:Math.min(41-px.h,px.y),h:Math.min(px.h,6)})):pixels;
  }
  const s=qActorPose(state.action,state.direction,state.frame),d=drawing(),r=d.r,h=s.hand,b=s.by,north=s.direction==='north',side=s.direction==='east';
  const tier=level===3?'#e4bb5e':level===2?'#8acbd0':metal,edge=level===3?'#997037':'#537785';
  if(id==='wooden_shield'){const x=side?9:10;r(x,29+b,10,9,ink,'shield');r(x+2,28+b,6,12,ink,'shield');r(x+1,30+b,8,7,wood,'shield');r(x+3,29+b,4,10,lightWood,'shield');r(x+4,29+b,1,10,'#997042','shield');r(x+3,33+b,4,2,'#efe0a6','shield');return d.pixels;}
  if(id==='iron_armor'||id==='heavy_armor'){
    const heavy=id==='heavy_armor';r(heavy?17:19,29+b,heavy?14:10,8,heavy?'#3f5266':'#647f94','armor');r(heavy?18:20,30+b,heavy?12:8,5,heavy?'#708b9d':'#bed8de','armor');
    if(heavy){r(15,28+b,7,5,'#a7bac6','armor');r(27,28+b,7,5,'#a7bac6','armor');r(18,35+b,12,2,'#b19663','armor');}else r(24,30+b,4,1,'#e1ecdc','armor');
    if(north)r(23,30+b,2,6,'#53697d','armor');return d.pixels;
  }
  if(s.seated||s.sleep)return d.pixels;
  const strike=workActions.has(s.action)&&s.frame===2,raised=workActions.has(s.action)&&s.frame<2;
  if(id==='hunter_bow'){r(h.x+2,h.y-10,2,17,wood,'weapon');r(h.x+4,h.y-7,2,11,lightWood,'weapon');r(h.x+1,h.y-9,1,15,'#eee2b5','weapon');if(strike&&side){r(h.x-3,h.y,10,1,wood,'weapon');r(h.x+6,h.y-1,2,3,metal,'weapon');}return d.pixels;}
  if(id==='watering_can'){r(h.x-2,h.y+1,8,7,ink,'tool');r(h.x-1,h.y+2,6,5,level===3?'#e4bb5e':'#69b7bd','tool');r(h.x-4,h.y+2,3,3,edge,'tool');r(h.x+5,h.y+1,4,2,tier,'tool');r(h.x+8,h.y-1,2,3,tier,'tool');return d.pixels;}
  if(id==='fishing_rod'){r(h.x,h.y-17,1,20,wood,'tool');r(h.x+1,h.y-16,1,16,lightWood,'tool');r(h.x+2,h.y-17,8,1,'#d8dfc2','tool');r(h.x+9,h.y-16,1,13,'#d8dfc2','tool');return d.pixels;}
  if(['wooden_sword','iron_sword'].includes(id)){
    const blade=id==='wooden_sword'?lightWood:'#d6e9de',border=id==='wooden_sword'?'#95663c':'#7495a5';
    if(strike&&side){r(h.x-1,h.y-1,10,4,border,'weapon');r(h.x,h.y-1,10,2,blade,'weapon');r(h.x-2,h.y-3,2,8,'#dfae49','weapon');}
    else{const y=h.y-15;r(h.x,y+2,3,12,border,'weapon');r(h.x+1,y,2,12,blade,'weapon');r(h.x-2,y+13,7,2,'#dfae49','weapon');r(h.x,h.y-1,2,4,'#674d3a','weapon');}
    return d.pixels;
  }
  if(['axe','pickaxe','hoe','heavy_hammer'].includes(id)){
    let x=h.x,y=h.y-(raised?15:10);if(strike&&side){x=h.x+1;y=h.y-2;}
    r(x,y,2,raised?17:13,'#654936','tool');r(x+1,y,1,raised?16:11,lightWood,'tool');
    if(id==='pickaxe'){r(x-5,y,11,2,edge,'tool');r(x-5,y+2,3,3,tier,'tool');r(x+4,y+2,3,3,tier,'tool');}
    else if(id==='hoe'){r(x-1,y,8,2,edge,'tool');r(x+3,y+1,4,5,tier,'tool');r(x+4,y+1,2,2,'#f2f4ce','tool');}
    else{r(x-1,y,id==='heavy_hammer'?10:8,6,edge,'tool');r(x+1,y+1,id==='heavy_hammer'?7:5,4,tier,'tool');r(x+4,y+1,2,2,'#eff5d8','tool');}
  }
  return d.pixels;
}

export function qMonsterPixels(id,state={}){
  const s=qActorPose(state.action,state.direction,state.frame),d=drawing(),r=d.r,north=s.direction==='north',side=s.direction==='east',hurt=s.action==='hurt',attack=s.action==='attack',moving=s.moving;
  if(id==='forest_slime'){
    const low=attack&&s.frame<2,y=low?27:moving?(s.action==='run'?[24,21,25,22]:[24,22,25,23])[s.frame]:24;
    r(12,41,25,2,'#315a4f');r(9,y+6,31,41-y-5,'#315a4f');r(12,y+2,25,5,'#315a4f');r(17,y,16,3,'#315a4f');r(11,y+7,27,41-y-7,'#67bb77');r(14,y+3,21,8,'#8ad78b');r(18,y+1,13,4,'#b8ec9b');r(13,38,23,3,'#58a66e');r(15,y+6,5,2,'#e4f6be');r(23,y-3,2,4,'#3a7953');r(19,y-5,5,3,'#6eb85b');r(25,y-4,5,2,'#91cf67');
    if(!north){for(const x of side?[25,33]:[17,29]){r(x,y+9,3,hurt?1:4,'#294d49','eyes');if(!hurt)r(x,y+9,1,1,'#fffceb','eyes');}r(side?29:23,y+15,3,1,'#46755a','face');}else{r(24,y+8,6,2,'#a1dc8e','back');r(29,y+11,3,2,'#78c985','back');}
  }else if(id==='forest_boar'){
    const b=moving&&s.frame%2?-1:attack&&s.frame<2?1:0,stride=moving?[-2,0,2,0][s.frame]:0;
    for(const[x,o]of(side?[[13,-stride],[20,stride],[29,-stride],[35,stride]]:[[15,0],[29,0]])){const lift=moving&&((s.frame===1||s.frame===0)&&x<24||(s.frame===3||s.frame===2)&&x>=24)?s.frame%2?2:1:0;r(x+o,35+b,4,7-b-lift,'#553f3a','legs');r(x+o,40-lift,5,3,'#353b43','legs');}
    r(side?9:13,25+b,side?30:23,12,'#513f39');r(side?12:16,21+b,side?24:17,7,'#513f39');r(side?11:15,25+b,side?26:19,11,'#aa7750');r(side?14:17,23+b,side?19:14,6,'#ca925e');r(side?13:16,26+b,10,2,'#dfb27d');
    if(side){r(12,18+b,5,6,'#654c3e');r(18,18+b,4,6,'#73513c');r(29,20+b,8,7,'#664b3e');r(31,21+b,3,4,'#d69b76');r(32,26+b,9,10,'#b78358');r(38,29+b,7,7,'#654b42');r(39,30+b,5,5,'#d99c7e');r(40,32+b,1,2,'#79594d');r(43,32+b,1,2,'#79594d');r(33,27+b,3,hurt?1:3,ink,'eyes');r(36,34+b,2,5,'#faf0c7');r(38,32+b,2,4,'#faf0c7');r(7,29+b,4,2,'#73513c');}
    else{r(13,19+b,6,8,'#664b3e');r(30,19+b,6,8,'#664b3e');r(15,20+b,3,5,'#d69b76');r(31,20+b,3,5,'#d69b76');if(!north){r(18,30+b,14,8,'#654b42');r(19,31+b,12,6,'#d99c7e');r(21,33+b,2,2,'#79594d');r(27,33+b,2,2,'#79594d');r(17,27+b,3,hurt?1:3,ink,'eyes');r(29,27+b,3,hurt?1:3,ink,'eyes');r(16,34+b,2,5,'#faf0c7');r(32,34+b,2,5,'#faf0c7');}else{r(22,22+b,5,14,'#73513c','back');r(23,34+b,2,5,'#d5a476','tail');r(24,38+b,3,2,'#d5a476','tail');}}
  }else if(id==='ruins_guardian'){
    const b=moving&&s.frame%2?-1:attack&&s.frame<2?1:0;
    const leftLift=moving&&(s.frame===0||s.frame===1)?s.frame===1?2:1:0,rightLift=moving&&(s.frame===2||s.frame===3)?s.frame===3?2:1:0;
    r(14,34,8,9-leftLift,ink,'legs');r(27,34,8,9-rightLift,ink,'legs');r(15,35,6,6-leftLift,'#859b91','legs');r(28,35,6,6-rightLift,'#859b91','legs');r(11,22+b,27,16,ink);r(13,23+b,23,13,'#849d92');r(15,24+b,7,3,'#bfd0b0');r(16,8+b,17,3,ink,'head');r(12,11+b,25,15,ink,'head');r(14,12+b,21,12,'#a5b9a1','head');r(17,9+b,15,4,'#bccbaf','head');r(14,14+b,5,2,'#d8ddbb','head');
    const handY=attack&&s.frame<2?19:attack&&s.frame===2?31:31+b;
    r(side?7:7,25+b,7,12,'#596e69','far-arm');r(side?34:35,handY-7,8,12,ink,'near-arm');r(side?35:36,handY-6,6,10,'#a3b6a0','near-arm');
    if(!north){r(side?24:17,17+b,4,hurt?1:4,'#4a6b65','eyes');r(side?31:28,17+b,3,hurt?1:4,'#4a6b65','eyes');r(side?25:18,17+b,2,2,'#e8e897','eyes');r(side?32:29,17+b,1,2,'#e8e897','eyes');r(23,29+b,5,5,'#e6ce76','core');r(24,30+b,3,3,'#fff1b0','core');}else{r(24,13+b,2,10,'#819e8c','back');r(18,29+b,13,2,'#5e7e70','back');}
    r(15,7+b,7,3,'#76a86a','moss');r(13,10+b,4,3,'#9bc574','moss');r(30,23+b,6,4,'#74a66d','moss');
  }
  return d.pixels;
}
