// Deterministic, original artwork authored as editable Pixelbolt grid recipes.
// Pixelbolt is a build-time art tool, never a dependency of the live game server.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sceneGround, sceneProp } from '../art/pixel-world/scenes.mjs';
import { SCENES } from '../shared/world-layout.js';
const ROOT = resolve(import.meta.dirname, '..');
const TOOL = resolve(process.env.PIXELBOLT_ROOT || join(ROOT, 'data/tools/Pixelbolt'));
const PIN = 'ce12f75cc524e63e90d4bd183aecc3a46a6b44ee';
const SOURCE = join(ROOT, 'art/pixel-world/recipes'), PUBLIC = join(ROOT, 'public/pixel-world');
const REVIEW = join(ROOT, 'artifacts/pixel-world');
for (const dir of [SOURCE, PUBLIC, REVIEW]) mkdirSync(dir, { recursive: true });
if (!existsSync(join(TOOL, 'bin/pixelbolt.js'))) throw Error('Clone the pinned Pixelbolt checkout into data/tools/Pixelbolt first.');
if (execFileSync('git', ['-C', TOOL, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== PIN) throw Error('Pixelbolt checkout differs from the reviewed commit.');
const CLI = join(TOOL, 'bin/pixelbolt.js');
const only = process.argv.find(x => x.startsWith('--only='))?.slice(7);
const inspect = process.argv.includes('--inspect');
function publish(path,data){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
 if(existsSync(path)&&readFileSync(path).equals(bytes))return;
 const staging=`${path}.building`;
 writeFileSync(staging,bytes);
 renameSync(staging,path);
}
// Grid palettes use one BMP codepoint per color; the world shares more colors
// than a small sprite, so retain exact colors with additional letter keys.
const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$%^&*()_+=[]{};:,<>?/|~' + Array.from({length:256},(_,i)=>String.fromCharCode(0x100+i)).join('');
const outline = '#293f3f', skin = '#e9b98b', skinLight = '#ffe0ae', skinShade = '#b87f62';
class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.p = Array.from({ length: h }, () => Array(w).fill(null)); }
  dot(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y][x] = c; }
  rect(x, y, w, h, c) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.dot(xx, yy, c); }
  line(x, y, x2, y2, c, thick = 1) { const n = Math.max(Math.abs(x2 - x), Math.abs(y2 - y)); for (let i = 0; i <= n; i++) this.rect(Math.round(x + (x2 - x) * i / (n || 1)), Math.round(y + (y2 - y) * i / (n || 1)), thick, thick, c); }
  ellipse(x, y, w, h, c) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (((xx + .5 - x - w / 2) / (w / 2)) ** 2 + ((yy + .5 - y - h / 2) / (h / 2)) ** 2 <= 1) this.dot(xx, yy, c); }
  poly(points, c) { const xs = points.map(p => p[0]), ys = points.map(p => p[1]); for (let y = Math.min(...ys); y <= Math.max(...ys); y++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++) { let inside = false; for (let i = 0, j = points.length - 1; i < points.length; j = i++) { const a = points[i], b = points[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } if (inside) this.dot(x, y, c); } }
  borderedRect(x, y, w, h, fill, border = outline) { this.rect(x, y, w, h, border); this.rect(x + 1, y + 1, w - 2, h - 2, fill); }
  paste(other, x, y) { other.p.forEach((row, yy) => row.forEach((c, xx) => { if (c) this.dot(x + xx, y + yy, c); })); }
}
const specs = [
  ['moss', '#587b56', '#88a56c', '#385b48', '#7b503a', '#ba8150', 'leaf'],
  ['amber', '#b17c48', '#dbb56e', '#74533b', '#6c4140', '#a8684b', 'hat'],
  ['tide', '#548d98', '#8bc2c5', '#365c78', '#3b6079', '#6e9aa9', 'whale'],
  ['lilac', '#817398', '#b6a4bd', '#5a526e', '#4b3e53', '#806277', 'point'],
  ['ember', '#b36d58', '#df9b70', '#774d4a', '#493f3d', '#8b5a47', 'ponytail'],
  ['sky', '#668caa', '#a4c4c7', '#49657e', '#d6bf8a', '#f2dcaa', 'cap'],
  ['rose', '#aa758b', '#d4a6ad', '#724e68', '#805747', '#b98059', 'buns'],
  ['slate', '#6c8580', '#a2b3a1', '#455b5a', '#c3c7bc', '#f0e7cd', 'hood'],
];
const motionNames = ['idle','walk','walk_south','walk_north','walk_east','attack','hurt','till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat','rest','tired'];
const poses = [];
for (const action of motionNames) for (let frame = 0; frame < (action === 'hurt' ? 2 : 4); frame++) poses.push({ action, frame, name: `${action}_${frame}`, duration: action === 'idle' ? [700,180,700,140][frame] : action === 'rest' ? 500 : action === 'tired' ? 340 : action === 'attack' ? [180,100,140,240][frame] : 180 });
function pose(action, i) {
  const walking = action.startsWith('walk');
  return { bob: action === 'idle' && i === 1 ? -1 : walking && i % 2 ? -1 : action === 'tired' ? 2 : action === 'rest' ? 6 : action === 'gather' ? [1,5,3,0][i] : action === 'cook' ? [0,1,1,0][i] : action === 'till' ? [0,-1,3,1][i] : ['plant','water','harvest','craft','repair','upgrade'].includes(action) && i % 3 ? 3 : action === 'attack' && i === 2 ? 1 : 0,
    stride: walking ? [-2,0,2,0][i] : 0, back: action === 'walk_north', side: action === 'walk_east', seated: action === 'rest', blink: action === 'idle' && i === 3 || action === 'rest' || action === 'tired' && i % 2 === 0,
    hand: action === 'gather' ? [[32,34],[35,36],[32,33],[28,31]][i] : action === 'cook' ? [[35,27],[32,30],[36,30],[34,27]][i] : action === 'eat' ? [[32,33],[28,27],[27,25],[30,30]][i] : action === 'attack' ? [[31,29],[29,20],[38,31],[32,33]][i] : action === 'till' ? [[30,28],[28,19],[34,35],[31,32]][i] : action === 'water' ? [34,34] : action === 'plant' ? [30+i,37] : action === 'harvest' ? [32,33-(i%2)*3] : ['craft','repair','upgrade'].includes(action) ? [[32,32],[32,25],[35,34],[32,33]][i] : [32,34] };
}
function character(s, action, i) {
  const g = new Grid(48,48), p = pose(action,i), b = p.bob, [,coat,light,shade,hair,hairLight,feature] = s;
  g.ellipse(12,41,25,5,'#203d382e');
  // Feet stay on the ground while the body compresses; alternate planted legs.
  if (p.seated) { g.borderedRect(15,37,9,6,shade); g.borderedRect(25,37,9,6,shade); g.rect(16,41,8,2,'#61483e'); g.rect(26,41,8,2,'#61483e'); }
  else { g.borderedRect(18,34+p.stride,5,9-p.stride,'#54635e'); g.borderedRect(26,34-p.stride,5,9+p.stride,'#54635e'); g.rect(17,41+p.stride/2,7,3,'#58443b'); g.rect(26,41-p.stride/2,7,3,'#58443b'); g.rect(18,41+p.stride/2,5,1,'#a17a55'); g.rect(27,41-p.stride/2,5,1,'#a17a55'); }
  // Back hair / cloak and chest.
  if (feature === 'ponytail') { g.poly([[30,13+b],[37,17+b],[36,30+b],[31,25+b]],outline); g.poly([[31,15+b],[35,18+b],[34,27+b],[32,23+b]],hair); }
  if (feature === 'hood') { g.ellipse(12,10+b,25,29,outline); g.ellipse(14,12+b,21,25,shade); }
  g.poly([[18,26+b],[29,26+b],[34,35+b],[30,38+b],[17,38+b],[14,34+b]],outline);
  g.poly([[19,27+b],[28,27+b],[31,35+b],[28,37+b],[18,37+b],[16,34+b]],coat);
  g.rect(18,28+b,6,7,light); g.rect(28,30+b,3,6,shade); g.rect(17,35+b,14,2,shade);
  g.rect(23,28+b,2,8,'#e6d2a4'); g.dot(24,31+b,'#b69562'); g.dot(24,34+b,'#b69562');
  // Arms and hands, unique contact/release poses.
  g.line(17,28+b,14,34+b,outline,3); g.line(17,28+b,15,33+b,coat,2); g.borderedRect(13,33+b,4,4,skin);
  const hy = Math.min(42,p.hand[1]+(p.seated?3:b)); g.line(29,28+b,p.hand[0],hy,outline,4); g.line(29,28+b,p.hand[0],hy,light,2); g.borderedRect(p.hand[0]-1,hy-1,4,4,skinLight);
  // Rounded, stepped head with shadow plane.
  g.ellipse(13,8+b,23,22,outline); g.ellipse(15,10+b,19,18,hair); g.ellipse(16,14+b,17,14,skinShade); g.ellipse(16,13+b,16,13,skin); g.rect(18,14+b,9,7,skinLight);
  g.rect(14,17+b,3,7,hair); g.rect(32,16+b,3,8,hair); g.ellipse(15,8+b,19,10,hair); g.rect(17,9+b,11,3,hairLight); g.rect(16,12+b,5,5,hair); g.rect(23,12+b,4,3,hair); g.rect(29,12+b,4,6,hair);
  if (p.back) { g.ellipse(15,11+b,19,17,hair); g.rect(17,12+b,9,3,hairLight); g.rect(20,25+b,12,2,shade); }
  else { const eyeX=p.side?25:20; if(p.blink){g.line(eyeX,21+b,eyeX+2,21+b,outline);if(!p.side)g.line(28,21+b,30,21+b,outline);}else{g.rect(eyeX,19+b,2,3,outline);g.dot(eyeX,19+b,'#fff5d7');g.rect(p.side?31:28,19+b,2,3,outline);g.dot(p.side?31:28,19+b,'#fff5d7');} g.rect(18,23+b,3,1,'#d98e78'); g.rect(29,23+b,3,1,'#d98e78'); g.rect(24,25+b,3,1,skinShade); }
  if(feature==='leaf'){g.poly([[18,10+b],[12,8+b],[13,3+b],[20,7+b]],outline);g.poly([[17,8+b],[14,7+b],[14,4+b],[19,7+b]],'#a6c77b');g.poly([[21,9+b],[24,3+b],[28,4+b],[25,9+b]],'#8eaf63');}
  if(feature==='hat'){g.borderedRect(15,6+b,20,8,'#bb9254');g.rect(17,7+b,16,3,'#ebcd87');g.rect(11,13+b,28,3,outline);g.rect(12,13+b,26,2,'#dcb367');g.rect(15,11+b,20,2,shade);}
  if(feature==='whale'){g.ellipse(12,4+b,25,14,outline);g.ellipse(13,5+b,23,11,coat);g.ellipse(15,6+b,14,5,light);g.rect(14,14+b,21,3,'#dfebd7');g.poly([[12,11+b],[7,15+b],[13,16+b]],shade);g.poly([[36,10+b],[41,14+b],[36,16+b]],shade);g.rect(29,9+b,2,2,outline);g.poly([[24,5+b],[21,1+b],[18,1+b],[22,6+b]],light);g.poly([[24,5+b],[26,0+b],[29,1+b],[26,6+b]],light);}
  if(feature==='point'){g.poly([[12,13+b],[18,6+b],[28,1+b],[28,7+b],[35,13+b]],outline);g.poly([[15,12+b],[20,7+b],[27,3+b],[26,8+b],[32,12+b]],coat);g.rect(12,13+b,24,3,shade);g.dot(24,8+b,'#f2d78b');}
  if(feature==='cap'){g.ellipse(14,7+b,22,10,outline);g.ellipse(15,8+b,20,8,coat);g.rect(13,14+b,25,3,shade);g.rect(15,14+b,16,1,light);}
  if(feature==='buns'){g.ellipse(10,10+b,8,8,outline);g.ellipse(11,11+b,6,6,hair);g.ellipse(32,10+b,8,8,outline);g.ellipse(33,11+b,6,6,hair);g.rect(10,16+b,7,2,light);g.rect(33,16+b,7,2,light);}
  if(feature==='hood'){g.poly([[14,16+b],[14,9+b],[20,5+b],[29,6+b],[36,13+b],[35,22+b],[32,17+b],[30,12+b],[18,12+b],[16,18+b]],outline);g.poly([[15,15+b],[16,10+b],[21,7+b],[28,8+b],[34,13+b],[34,18+b],[30,11+b],[18,11+b]],coat);g.line(17,10+b,22,8+b,light);}
  if(action==='water'){g.line(43,33+b,44,37+b,'#a8d5d3');if(i%2)g.dot(43,40,'#d5ece1');}
  if(action==='till'&&i===2){g.rect(39,43,3,2,'#b99163');g.dot(44,40,'#e0b97e');g.dot(37,42,'#b99163');}
  if(action==='plant'){g.rect(33,40,2,2,'#e3c482');if(i===2)g.dot(37,42,'#dec19a');}
  if(action==='harvest'){g.borderedRect(29,35+b,10,7,'#ad8055');g.rect(30,37+b,8,2,'#dbb978');g.ellipse(32,31+b,5,7,'#f4e9bf');g.line(34,32+b,32,29+b,'#74a160',2);}
  // Bare hands reach down, close, and return. No pickaxe is implied.
  if(action==='gather'){g.borderedRect(13,36+b,7,5,'#b89261');g.rect(14,37+b,5,1,'#dfc28a');if(i===2){g.line(34,40,36,39,'#cfba83');g.dot(38,41,'#a79971');}}
  // Cooking is a short confirmation pose, not a second timed job.
  if(action==='cook'){g.ellipse(27,35,17,8,outline);g.ellipse(28,34,15,7,'#799b9d');g.ellipse(29,34,13,3,'#d4b878');g.line(p.hand[0],hy,p.hand[0]-2,37,'#ae7950',2);g.rect(28,37,13,2,'#a8beb0');}
  if(action==='eat'){g.poly([[p.hand[0]-3,hy],[p.hand[0]+5,hy],[p.hand[0]+3,hy+5],[p.hand[0]-1,hy+5]],'#e0c48f');g.line(p.hand[0]-3,hy,p.hand[0]+4,hy,'#fff0c7');}
  if(['craft','repair','upgrade'].includes(action)){g.line(p.hand[0]+1,hy,p.hand[0]+3,hy-5,'#956b4d',2);g.borderedRect(p.hand[0],hy-8,8,4,action==='upgrade'?'#d9bd76':'#9aada4');if(action==='upgrade'&&i===2){g.line(8,20,8,24,'#f0d992');g.line(6,22,10,22,'#f0d992');}}
  if(action==='hurt'){g.line(35,7,38,4,'#e4b175');g.line(39,9,43,8,'#e4b175');}
  if(action==='rest'&&i%2){g.line(36,13,40,13,'#e7ddbb');g.line(40,13,36,17,'#e7ddbb');g.line(36,17,40,17,'#e7ddbb');}
  if(action==='tired'&&i%2){g.rect(35,23+b,1,3,'#a0d5d1');g.dot(34,26+b,'#a0d5d1');}
  return g;
}
function overlay(kind,action,i){
  const g=new Grid(48,48),p=pose(action,i),b=p.bob,hy=Math.min(42,p.hand[1]+(p.seated?3:b));
  if(kind==='hunter_bow'){
    const x=Math.min(39,p.hand[0]+1),y=hy-6;
    g.poly([[x-1,y-12],[x+5,y-9],[x+8,y-3],[x+8,y+4],[x+4,y+12],[x-2,y+15],[x+2,y+7],[x+3,y-2]],outline);
    g.line(x,y-10,x+5,y-4,'#e0b77b',2);g.line(x+5,y-4,x+5,y+4,'#b18b56',2);g.line(x+5,y+4,x,y+12,'#cfaa70',2);
    const pull=action==='attack'&&i===1?x-7:x;
    g.line(x,y-10,pull,y+2,'#e5dfbc');g.line(pull,y+2,x,y+12,'#e5dfbc');g.rect(x+2,y+1,4,4,'#63876a');
    if(action==='attack'){const end=i===2?46:x+9;g.line(Math.max(1,pull-4),y+2,end,y+2,'#d6bf8d');g.poly([[end,y-1],[end+1,y+2],[end,y+5],[end-3,y+2]],'#e3e9d0');}
  }else if(kind==='heavy_hammer'){
    const start=[p.hand[0]+1,hy],tip=action==='attack'&&i===2?[40,hy-2]:action==='attack'&&i===1?[31,8]:[39,hy-14];
    g.line(...start,...tip,outline,4);g.line(start[0],start[1],tip[0],tip[1],'#b38960',2);g.line(start[0],start[1]-1,tip[0],tip[1],'#e0be86');
    g.borderedRect(tip[0]-7,tip[1]-5,15,10,'#677f88');g.rect(tip[0]-6,tip[1]-4,12,3,'#b6c9c7');g.rect(tip[0]-5,tip[1],10,3,'#4d6676');g.rect(tip[0]-1,tip[1]-4,3,8,'#aa9667');g.dot(tip[0],tip[1]-3,'#e9d59b');
  }else if(kind==='heavy_armor'){
    g.poly([[14,26+b],[21,28+b],[26,28+b],[33,26+b],[36,33+b],[32,37+b],[28,40+b],[18,40+b],[13,36+b],[11,31+b]],outline);
    g.poly([[16,28+b],[21,30+b],[26,30+b],[31,28+b],[33,34+b],[28,38+b],[18,38+b],[14,34+b]],'#637984');g.rect(17,30+b,5,6,'#9db6b5');g.rect(25,31+b,4,5,'#4a626f');g.line(16,37+b,29,37+b,'#b5a67a',2);
    g.borderedRect(10,26+b,9,7,'#7c9296');g.rect(11,27+b,7,2,'#c4cebb');g.borderedRect(29,26+b,9,7,'#647d88');g.rect(30,27+b,7,2,'#a8beb8');g.rect(22,30+b,3,7,'#baaa73');
  }else if(kind==='wooden_sword'||kind==='iron_sword'){
    const metal=kind==='iron_sword',dark=metal?'#4f747d':'#78543b',mid=metal?'#a7c7c5':'#bd9560',lit=metal?'#e5e8ca':'#ebc884';
    const start=[p.hand[0]+1,hy],tip=action==='attack'&&i===2?[44,hy-1]:action==='attack'&&i===1?[32,8]:[39,hy-13];
    g.line(...start,...tip,outline,3);g.line(...start,...tip,mid,2);g.line(start[0],start[1]-1,tip[0],tip[1],lit);g.line(start[0]-3,start[1]-3,start[0]+4,start[1]-1,dark,2);g.rect(start[0],start[1],2,4,'#765541');
    if(action==='attack'&&i===2){g.line(39,18,44,23,'#f2dc9c');g.line(44,23,45,29,'#f2dc9c');}
  }else if(kind==='wooden_shield'){
    g.poly([[10,29+b],[17,28+b],[19,36+b],[14,40+b],[9,36+b]],outline);g.poly([[11,30+b],[16,29+b],[17,35+b],[14,38+b],[10,35+b]],'#aa7d4c');g.line(13,30+b,13,36+b,'#dfb879');g.dot(14,33+b,'#e9d297');
  }else if(kind==='iron_armor'){
    g.poly([[18,27+b],[22,29+b],[27,29+b],[30,27+b],[32,34+b],[28,37+b],[18,37+b],[16,33+b]],outline);g.poly([[19,28+b],[22,30+b],[27,30+b],[29,29+b],[30,34+b],[27,36+b],[18,35+b]],'#91a7aa');g.rect(19,30+b,3,4,'#ced5c3');g.rect(24,31+b,5,1,'#e3dfbc');g.line(24,32+b,24,35+b,'#546f7a');
  }else if(kind==='leaf'){g.poly([[19,29+b],[24,29+b],[23,33+b],[18,34+b]],'#315b49');g.poly([[20,30+b],[23,30+b],[21,33+b],[19,33+b]],'#bad786');}
  else if(kind==='star'){g.poly([[20,28+b],[22,30+b],[25,30+b],[23,32+b],[24,35+b],[21,33+b],[18,35+b],[19,32+b],[17,30+b],[20,30+b]],'#946f3b');g.rect(20,30+b,3,3,'#f1d486');g.dot(20,30+b,'#fff1b0');}
  else if(kind==='ribbon'){g.poly([[17,28+b],[22,30+b],[26,28+b],[26,33+b],[22,31+b],[17,33+b]],'#c7889c');g.rect(21,30+b,3,3,'#f0bdba');g.line(22,32+b,24,36+b,'#b36583',2);}
  else if(kind==='scarf'){g.rect(17,26+b,15,3,'#d8aa68');g.rect(18,26+b,12,1,'#f1d49b');g.rect(27,29+b,3,7,'#b78051');g.rect(27,34+b,4,2,'#e6bf79');}
  return g;
}
const toolPalette = level => level===3 ? {body:'#c6a45d',light:'#f3dc91',shade:'#876d43',edge:'#4f5a4c'} : level===2 ? {body:'#829ea6',light:'#d2e0d1',shade:'#4d707d',edge:'#304e58'} : {body:'#a17b57',light:'#dfbc82',shade:'#6d5640',edge:'#34483e'};
function toolOverlay(id,level,action,i){
 const g=new Grid(48,48),p=pose(action,i),b=p.bob,c=toolPalette(level),maintenance=['repair','upgrade'].includes(action);
 const hy=Math.min(42,p.hand[1]+(p.seated?3:b));
 if(id==='hoe'){
  const hand=maintenance?[12,35+b]:[p.hand[0]+1,hy];
  const tip=maintenance?[6,20+b]:action==='till'?[[39,14],[35,5],[44,40],[40,19]][i]:[40,hy-15];
  g.line(...hand,...tip,outline,3);g.line(...hand,...tip,'#ae8357',2);g.line(hand[0],hand[1],tip[0],tip[1],'#e0bd82');
  const blade=level+4;g.borderedRect(tip[0]-blade+1,tip[1]-1,blade+2,6,c.shade,c.edge);g.rect(tip[0]-blade+2,tip[1],blade,2,c.light);g.rect(tip[0]-blade+2,tip[1]+2,blade-1,2,c.body);
  if(level===3)g.dot(tip[0]-2,tip[1]+2,'#fff3c4');
 }else{
  const x=maintenance?4:31,y=maintenance?31+b:32+b;
  g.borderedRect(x,y,10,8,c.body,c.edge);g.rect(x+1,y+1,7,2,c.light);g.rect(x+7,y+3,2,4,c.shade);
  g.line(x+2,y,x+2,y-3,c.edge,2);g.line(x+2,y-3,x+6,y-3,c.edge,2);g.line(x+6,y-3,x+6,y,c.edge,2);
  g.line(x+9,y+3,x+13,y-1,c.edge,3);g.line(x+10,y+3,x+13,y,c.light,2);g.rect(x+12,y-2,3,2,c.body);
  if(level>1)g.rect(x+2,y+4,2+level,1,c.light);
 }
 return g;
}
function toolIcon(id,level){
 const g=new Grid(32,32),c=toolPalette(level);
 g.ellipse(5,27,23,3,'#203d382e');
 if(id==='hoe'){
  g.line(10,27,22,7,outline,4);g.line(11,27,22,7,'#ac8052',2);g.line(11,26,21,8,'#e4c38b');
  g.poly([[8,4],[25,5],[27,9],[23,15],[16,12],[9,11]],c.edge);g.poly([[10,5],[24,6],[25,9],[22,13],[17,11],[10,10]],c.body);g.line(10,6,23,7,c.light,2);g.line(18,11,23,13,c.shade,2);
 }else{
  g.borderedRect(7,12,17,15,c.body,c.edge);g.rect(9,14,11,4,c.light);g.rect(19,18,3,7,c.shade);
  g.borderedRect(11,5,10,9,c.edge,c.edge);g.rect(14,7,5,6,null);g.rect(13,7,6,5,'#00000000');g.line(12,6,19,6,c.light);
  g.poly([[23,17],[28,9],[31,10],[29,20],[24,24]],c.edge);g.poly([[24,18],[28,12],[29,13],[27,20],[24,22]],c.body);g.line(25,18,28,12,c.light);g.borderedRect(26,8,6,3,c.light,c.edge);
 }
 // Tier markings are deliberate pixels, not text baked at fractional scale.
 for(let n=0;n<level;n++)g.rect(3+n*4,29,3,2,c.light);
 return g;
}
function monster(id,action,i){
 const g=new Grid(48,48),b=(action==='walk'||action==='idle')&&i%2?-1:action==='attack'&&i===2?2:0;g.ellipse(6,39,36,7,'#203d383a');
 if(id==='forest_slime'){
  g.ellipse(7,18+b,34,25-b,outline);g.ellipse(8,19+b,32,22-b,'#568f6c');g.ellipse(9,19+b,27,18-b,'#8aba83');g.ellipse(12,20+b,17,7,'#c0d69b');g.rect(14,29+b,3,4,outline);g.rect(30,29+b,3,4,outline);g.dot(14,29+b,'#e8e9b4');g.dot(30,29+b,'#e8e9b4');g.rect(22,34+b,5,2,'#416a54');g.rect(10,35+b,3,2,'#add299');g.poly([[23,19+b],[19,13+b],[22,12+b],[25,17+b],[29,11+b],[32,14+b],[27,19+b]],'#547b50');
 } else if(id==='forest_boar'){
  g.borderedRect(11,34,6,8,'#634e44');g.borderedRect(30,34,6,8,'#634e44');g.poly([[10,19+b],[8,8+b],[18,13+b],[31,13+b],[40,8+b],[38,21+b]],outline);g.poly([[11,17+b],[10,11+b],[17,15+b],[32,15+b],[38,11+b],[37,19+b]],'#b88759');g.ellipse(7,15+b,35,25,outline);g.ellipse(8,16+b,33,22,'#9c7152');g.ellipse(11,16+b,24,10,'#c79a69');g.poly([[17,16+b],[22,10+b],[25,16+b],[29,10+b],[32,18+b]],'#635246');g.rect(14,26+b,3,3,outline);g.rect(31,26+b,3,3,outline);g.ellipse(17,29+b,19,11,'#d7ae7b');g.rect(22,33+b,2,3,'#785643');g.rect(29,33+b,2,3,'#785643');g.poly([[12,31+b],[10,27+b],[10,36+b],[16,38+b]],'#efdfaf');g.poly([[37,31+b],[40,27+b],[39,36+b],[34,38+b]],'#efdfaf');
 } else {
  g.borderedRect(13,34,8,10,'#596e6c');g.borderedRect(27,34,8,10,'#596e6c');g.borderedRect(12,19+b,25,18,'#718b80');g.rect(14,20+b,9,12,'#a2b59a');g.borderedRect(5,20+b,8,17,'#718b80');g.rect(6,21+b,5,5,'#a2b59a');g.borderedRect(36,20+b,8,17,'#718b80');g.rect(37,21+b,5,5,'#a2b59a');g.poly([[12,6+b],[32,4+b],[37,11+b],[35,24+b],[12,25+b],[10,14+b]],outline);g.poly([[13,7+b],[31,6+b],[35,12+b],[33,22+b],[13,23+b],[12,14+b]],'#91a68e');g.poly([[13,7+b],[29,7+b],[22,11+b],[13,13+b]],'#c1c6a3');g.rect(15,16+b,6,3,'#e9d888');g.rect(27,16+b,6,3,'#e9d888');g.poly([[24,25+b],[29,30+b],[24,36+b],[19,30+b]],outline);g.poly([[24,27+b],[27,30+b],[24,34+b],[21,30+b]],'#cbbd71');g.line(25,8+b,22,12+b,'#54766b');g.line(22,12+b,26,14+b,'#54766b');g.rect(13,8+b,3,4,'#66895a');
 }
 if(action==='attack'&&i===2){g.line(37,20,44,27,'#efcf8b',2);g.line(41,29,45,31,'#fff0c2',2);}if(action==='hurt'){g.line(8,9,4,5,'#f1cf95',2);g.line(39,9,44,6,'#f1cf95',2);}return g;
}
function crop(id,stage){const g=new Grid(32,32);if(stage==='untilled'){g.borderedRect(0,9,32,22,'#8b8460','#636747');for(const[x,y]of[[5,17],[14,24],[25,17],[27,28]]){g.line(x,y,x-2,y-5,'#60774d',2);g.line(x,y,x+3,y-4,'#a1ae6b',2);}g.poly([[17,13],[22,12],[24,15],[21,18],[16,16]],'#b6b393');g.dot(5,27,'#d2c48d');return g;}const wet=['growing','ready'].includes(stage);g.borderedRect(0,9,32,22,wet?'#71573f':'#967046','#514a36');g.rect(2,10,28,3,wet?'#92734e':'#bd915a');for(let y=16;y<31;y+=6){g.line(2,y,29,y,wet?'#4d4939':'#6d5238',2);g.line(2,y-1,27,y-1,wet?'#8c7651':'#b48a55');}if(wet){g.line(4,24,10,24,'#73958a');g.line(20,29,26,29,'#8aab98');}if(stage==='empty'||stage==='tilled')return g;for(const x of [7,16,25]){if(stage==='seeded'){g.dot(x,22,'#dbc38c');g.line(x,22,x,19,'#82a35a');g.dot(x-1,20,'#b3c67b');}else if(id==='turnip'){g.ellipse(x-4,stage==='ready'?17:21,8,stage==='ready'?10:6,stage==='ready'?'#f0e4b9':'#b1bc7c');g.line(x,24,x-1,28,'#d2c18f');g.poly([[x,21],[x-6,15],[x-4,12],[x,17],[x+4,11],[x+6,15]],'#668e4a');g.line(x,21,x,12,'#a9c67c');}else{g.line(x,27,x,9,'#a7a85c');for(const y of [12,17,22]){g.poly([[x,y+3],[x-4,y],[x-3,y-4],[x,y-1]],stage==='ready'?'#dfb85d':'#8da563');g.poly([[x,y+1],[x+4,y-3],[x+3,y-6],[x,y-2]],stage==='ready'?'#f0d27e':'#b4be73');}}}return g;}
function seedRandom(seed=7340){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function scene(){
 const g=new Grid(768,512),rand=seedRandom();g.rect(0,0,768,512,'#91a985');
 // Broad connected land forms, then short grass clusters rather than full-field noise.
 g.poly([[0,246],[98,226],[171,248],[245,294],[285,410],[286,512],[0,512]],'#618775');g.poly([[0,324],[106,304],[170,338],[201,445],[143,512],[0,512]],'#557a6d');
 g.poly([[575,0],[768,0],[768,389],[668,377],[568,271]],'#a3a38b');g.poly([[590,151],[704,131],[768,187],[768,300],[667,302],[568,271]],'#b6b09a');
 for(let i=0;i<720;i++){const x=Math.floor(rand()*768),y=Math.floor(rand()*512);g.line(x,y,x+3,y-1,rand()>.5?'#a3b594':'#7c9979');if(i%4===0)g.dot(x+5,y,'#b6c49a');}
 // Roads are broad, winding connected planes.
 const road=[[128,368],[190,337],[274,327],[330,291],[368,272],[472,259],[550,249],[624,240]];
 for(let i=1;i<road.length;i++){const [x,y]=road[i-1],[x2,y2]=road[i];g.line(x-16,y-16,x2-16,y2-16,'#758164',33);}
 for(let i=1;i<road.length;i++){const [x,y]=road[i-1],[x2,y2]=road[i];g.line(x-14,y-14,x2-14,y2-14,'#c5b787',29);}
 g.line(368-10,272,368-10,432,'#c5b787',24);g.line(624-11,240,624-11,128,'#c5b787',23);g.line(176,144,352,256,'#c5b787',18);
 for(let i=0;i<200;i++){const t=rand(),p=road[Math.min(road.length-2,Math.floor(t*road.length))];g.rect(p[0]+Math.floor(rand()*26)-13,p[1]+Math.floor(rand()*20)-10,2,1,'#dfcfa4');}
 // Pond banks, stepping stones and reeds.
 g.ellipse(47,49,170,120,'#4f7560');g.ellipse(53,53,158,110,'#7b9870');g.ellipse(60,60,145,96,'#527f82');g.ellipse(65,63,135,87,'#6b9ea0');g.ellipse(72,67,116,74,'#83b8ae');g.ellipse(83,70,87,57,'#9cc9b6');
 for(const [x,y]of[[91,91],[141,77],[162,121],[108,134],[75,113]]){g.rect(x,y,12,2,'#c0dec3');g.rect(x+13,y+3,6,1,'#a8d5bc');}
 for(const[x,y]of[[54,96],[71,145],[191,124],[183,59]]){g.line(x,y,x-2,y-13,'#426b47',2);g.line(x+3,y,x+5,y-18,'#547e4c',2);g.rect(x+4,y-22,3,6,'#ab8a4d');}
 // Camp clearing, tent, ring stones, small warehouse.
 g.ellipse(278,190,190,143,'#b5a17b');g.ellipse(285,195,180,132,'#dfcda3');g.ellipse(298,206,154,112,'#eddeb6');
 tent(g,302,164);building(g,455,190,'#8b7650','#bda271',false);
 g.borderedRect(449,239,16,15,'#a98250');g.line(450,240,463,252,'#69573d');g.line(463,240,450,252,'#69573d');
 // Farming has its own close-up scene; no field is baked into the shared map.
 // East ruins: carved stone foreground steps and broken columns.
 ruins(g,572,167);
 // Library and play spot preserve social locations.
 building(g,579,62,'#795e65','#bba185',true);g.borderedRect(594,114,12,14,'#d1b479');g.rect(596,116,8,2,'#f0db9b');g.rect(596,120,8,2,'#8b7651');
 g.ellipse(581,366,97,63,'#c2b98b');g.borderedRect(606,386,38,17,'#af8155');g.rect(608,388,34,2,'#dfb879');g.rect(612,404,4,8,'#6e573e');g.rect(635,404,4,8,'#6e573e');g.rect(616,390,12,8,'#4e7568');g.dot(619,393,'#e8d79c');g.dot(624,394,'#e8d79c');
 // Woods frame paths instead of covering the camp or destination centres.
 const trees=[[21,32],[77,14],[250,17],[310,13],[350,36],[410,11],[482,31],[535,8],[726,36],[762,14],[17,178],[50,220],[15,280],[54,302],[18,370],[48,430],[19,489],[97,488],[162,486],[220,467],[282,491],[308,400],[288,356],[243,288],[232,205],[257,121],[305,100],[432,48],[497,103],[528,163],[698,172],[739,230],[752,299],[703,337],[754,401],[714,466],[651,491],[538,480],[482,433],[432,487],[393,415],[523,398],[695,83],[678,16]];
 trees.sort((a,b)=>a[1]-b[1]).forEach(([x,y],i)=>tree(g,x,y,i%3));
 for(const[x,y]of[[93,315],[215,392],[513,328],[562,304],[702,280],[270,177],[672,424]]){rock(g,x,y);if(x%2){rock(g,x+21,y+10);g.ellipse(x-12,y+10,14,4,'#6b8d62');}else{g.poly([[x+22,y+8],[x+25,y+1],[x+34,y+3],[x+36,y+10]],'#8b9784');g.line(x+26,y+3,x+32,y+4,'#c9c8ae');}}
 // Small flowers, mushrooms and fence accents.
 for(let i=0;i<75;i++){const x=Math.floor(rand()*768),y=Math.floor(rand()*512);if(g.p[y][x]!=='#91a985')continue;g.line(x,y,x,y-3,'#557948');g.dot(x-1,y-4,'#dcc98d');g.dot(x+1,y-4,'#dcc98d');g.dot(x,y-5,'#efe0a7');}
 return g;
}
function tree(g,x,y,variant){
 g.ellipse(x-23,y+13,49,13,'#496958');g.borderedRect(x-3,y-7,9,28,'#805b43','#405848');g.rect(x-1,y-7,2,25,'#b68a59');
 if(variant===1){ // Rounded deciduous crown: asymmetrical masses and a forked trunk.
  g.line(x+1,y+7,x-12,y-12,'#805b43',4);g.line(x+1,y+6,x+15,y-15,'#805b43',4);
  g.poly([[x-26,y-7],[x-30,y-24],[x-22,y-40],[x-9,y-44],[x-3,y-53],[x+15,y-49],[x+21,y-38],[x+31,y-29],[x+28,y-10],[x+15,y+2],[x-8,y+3]],'#375d4c');
  g.ellipse(x-27,y-42,48,40,'#597d59');g.ellipse(x-9,y-39,36,35,'#597d59');g.ellipse(x-22,y-44,32,23,'#84a16a');g.ellipse(x-6,y-47,25,23,'#a1b87a');g.poly([[x-23,y-19],[x-13,y-24],[x-3,y-18],[x+8,y-21],[x+17,y-12],[x+6,y-8],[x-8,y-11]],'#6e905e');g.line(x-13,y-35,x-4,y-39,'#bbca8c',2);
  return;
 }
 if(variant===2){ // Slender silver birch, with separated leaf fans.
  g.rect(x-2,y-31,6,49,'#d2cbb0');g.rect(x+2,y-30,2,47,'#8c9980');for(const yy of[-22,-10,1,12])g.line(x-2,y+yy,x+1,y+yy,'#69765f');
  for(const[dx,dy,w]of[[-8,-42,34],[9,-29,39],[-7,-16,34]]){g.ellipse(x+dx-w/2,y+dy-12,w,26,'#4b7259');g.ellipse(x+dx-w/2+2,y+dy-13,w-7,19,'#7fa175');g.ellipse(x+dx-w/2+5,y+dy-14,w-14,10,'#b3c58d');}return;
 }
 for(let k=0;k<3;k++){const yy=y-40+k*15,w=18+k*8;g.poly([[x,yy-15],[x-w,yy+15],[x-w+7,yy+14],[x-w-2,yy+22],[x+w+5,yy+22],[x+w-4,yy+12],[x+w+1,yy+13]],'#315947');g.poly([[x,yy-13],[x-w+2,yy+15],[x-4,yy+13],[x-8,yy+20],[x+w+1,yy+20],[x+w-5,yy+11]],'#426f50');g.poly([[x,yy-11],[x-w+5,yy+12],[x-4,yy+8],[x+6,yy+13]],'#648d5b');g.line(x-4,yy+9,x-11,yy+14,'#8cab72');}
}
function rock(g,x,y){g.ellipse(x-12,y+7,32,7,'#537759');g.poly([[x-12,y+7],[x-9,y-7],[x+4,y-12],[x+15,y-3],[x+18,y+9],[x,y+13]],'#627b6d');g.poly([[x-10,y+5],[x-7,y-6],[x+4,y-10],[x+11,y-3],[x+6,y+6]],'#b0b69a');g.poly([[x+6,y+6],[x+11,y-3],[x+16,y+8],[x,y+11]],'#8a9d88');g.line(x-6,y-5,x+1,y-7,'#d1cba7');}
function tent(g,x,y){g.ellipse(x-10,y+38,86,19,'#ad9a6d');g.poly([[x+30,y-17],[x-9,y+43],[x+69,y+43]],'#5f644d');g.poly([[x+30,y-15],[x-6,y+41],[x+35,y+41]],'#e4c47c');g.poly([[x+30,y-15],[x+35,y+41],[x+66,y+41]],'#b58c55');g.line(x+28,y-8,x+1,y+37,'#f5dca0',2);g.poly([[x+30,y+6],[x+15,y+41],[x+43,y+41]],'#5c5d47');g.poly([[x+30,y+8],[x+18,y+40],[x+29,y+35]],'#8b7851');g.line(x-15,y+43,x+9,y+4,'#8c7952');g.line(x+74,y+44,x+51,y+4,'#8c7952');g.rect(x-16,y+40,3,8,'#786345');g.rect(x+74,y+41,3,7,'#786345');}
function building(g,x,y,roof,wall,library){g.ellipse(x-8,y+49,92,17,'#647e60');g.borderedRect(x+3,y+19,63,38,wall,'#59654e');for(let yy=y+28;yy<y+55;yy+=7)g.line(x+5,yy,x+64,yy,'#987c59');g.poly([[x-6,y+21],[x+15,y-4],[x+57,y-4],[x+76,y+21],[x+74,y+25],[x-5,y+25]],'#4a5549');g.poly([[x-3,y+20],[x+16,y-2],[x+56,y-2],[x+72,y+20]],roof);for(let yy=y+3;yy<y+20;yy+=6)g.line(x+13-(yy-y)/2,yy,x+59+(yy-y)/2,yy,'#c09b73');g.borderedRect(x+13,y+30,14,15,'#b7cbac');g.line(x+20,y+31,x+20,y+43,'#5a6d55');g.line(x+14,y+37,x+25,y+37,'#5a6d55');g.borderedRect(x+40,y+29,17,28,'#655a43');g.rect(x+42,y+32,13,23,'#8d7650');g.dot(x+44,y+44,'#dfc98a');g.rect(x+39,y+57,20,3,'#c5b587');if(library){g.rect(x+53,y-12,8,12,'#818b76');g.rect(x+52,y-13,10,3,'#b1b197');}}
function ruins(g,x,y){g.ellipse(x-15,y+73,120,22,'#71886e');g.borderedRect(x-12,y+73,121,8,'#9ca38a','#6b8270');g.borderedRect(x-5,y+66,106,8,'#bac0a0','#6b8270');g.borderedRect(x+6,y+18,18,48,'#8eaa92','#566f63');g.rect(x+8,y+20,5,43,'#c0c7a6');g.borderedRect(x+70,y+18,18,48,'#8eaa92','#566f63');g.rect(x+72,y+20,5,43,'#c0c7a6');g.borderedRect(x+1,y+8,92,14,'#9fb59a','#566f63');g.rect(x+4,y+10,85,3,'#d0d0aa');g.line(x+45,y+9,x+40,y+17,'#657d6b');g.line(x+40,y+17,x+48,y+21,'#657d6b');for(const yy of[y+33,y+48]){g.line(x+7,yy,x+22,yy,'#657d6b');g.line(x+71,yy,x+86,yy,'#657d6b');}g.borderedRect(x+34,y+31,27,35,'#516e65','#6f8774');g.rect(x+39,y+37,3,18,'#8ca78d');g.rect(x+51,y+37,3,18,'#8ca78d');g.rect(x+41,y+42,12,2,'#c8cb88');g.ellipse(x+7,y+56,10,5,'#6e925d');g.ellipse(x+80,y+19,8,4,'#7a9c65');}
function farmScene(){
 const g=new Grid(640,400),random=seedRandom(11003);
 g.rect(0,0,640,400,'#87a378');
 g.poly([[0,250],[110,236],[184,320],[153,400],[0,400]],'#71936c');
 g.poly([[476,133],[640,114],[640,400],[562,400],[521,291]],'#77976d');
 for(let i=0;i<600;i++){const x=Math.floor(random()*640),y=Math.floor(random()*400);g.line(x,y,x+2,y-1,i%2?'#a1b982':'#6f9167');}
 // A sheltered courtyard, with soil on the two reserved plots only.
 g.rect(291,118,58,282,'#c6b583');g.rect(300,118,5,282,'#dac89a');
 g.rect(75,178,490,30,'#c6b583');g.rect(77,180,485,3,'#e2cfa3');
 for(const x of [70,390]){g.borderedRect(x,219,180,101,'#79654e','#4c5c42');g.rect(x+4,223,172,93,'#a29270');g.line(x+3,222,x+175,222,'#dac79d',2);g.line(x+4,318,x+178,318,'#665d48',2);for(const xx of[x+2,x+175]){g.rect(xx,223,3,94,'#ba9e71');g.line(xx,225,xx,312,'#e0c996');}}
 // Back fence and a small storage shed, not a second warehouse inventory.
 for(let x=10;x<640;x+=31){g.borderedRect(x,55,6,38,'#b59766','#5c704c');g.rect(x+1,56,2,34,'#e0c58d');}
 g.rect(0,66,640,5,'#a88a5e');g.rect(0,80,640,5,'#b99a67');g.line(0,66,639,66,'#e0c58d');
 building(g,280,51,'#8d6c59','#c0a574',false);
 // Stone well: dark water, a pulley, and a roof with readable masonry planes.
 g.ellipse(61,142,83,20,'#617f5f');g.borderedRect(70,110,63,39,'#97a48b','#506b5b');g.ellipse(70,101,63,25,'#aeb89b');g.ellipse(77,105,49,15,'#436c6c');g.ellipse(81,108,40,7,'#80b4a6');
 for(const y of [128,139]){g.line(71,y,132,y,'#637b65');for(const x of [84,103,123])g.line(x,y-9,x,y,'#637b65');}
 g.borderedRect(67,68,7,52,'#92704d','#4d604b');g.borderedRect(129,68,7,52,'#92704d','#4d604b');g.poly([[56,71],[75,48],[126,48],[146,71],[145,77],[56,77]],'#4b6150');g.poly([[60,70],[77,51],[124,51],[141,70]],'#b8905e');g.line(77,55,126,55,'#dfbb7c',2);g.rect(99,74,2,42,'#b69761');g.borderedRect(91,108,16,13,'#9b8056','#53634f');g.rect(93,110,12,3,'#d1b887');
 // Tool rack with fixed decorative silhouettes, outside the private status UI.
 g.ellipse(475,152,104,16,'#637f5e');g.borderedRect(481,87,8,71,'#98734b','#526648');g.borderedRect(562,87,8,71,'#98734b','#526648');g.borderedRect(478,91,94,32,'#ad8c57','#526648');g.rect(482,95,86,3,'#dbc08a');g.rect(482,117,86,3,'#785d3f');
 for(const x of [497,520,545])g.rect(x,104,2,36,'#c6a273');g.borderedRect(492,103,13,6,'#8fa49a','#425b52');g.rect(494,104,8,2,'#d2d9bc');g.borderedRect(515,133,12,14,'#a4b2a0','#425b52');g.rect(518,133,1,10,'#697e6e');g.rect(522,133,1,10,'#697e6e');g.borderedRect(537,128,20,15,'#5e8a8b','#425b52');g.rect(539,130,13,4,'#a1c5b7');g.line(556,132,562,126,'#5e8a8b',3);
 // Border foliage stays clear of the two plot overlays and the centre walkway.
 for(const[x,y,v]of[[15,43,0],[190,25,1],[405,27,2],[625,45,1],[17,370,2],[622,366,0]])tree(g,x,y,v);
 for(const[x,y]of[[47,267],[590,245],[168,356],[474,364]])rock(g,x,y);
 for(const[x,y]of[[207,122],[236,151],[411,129],[444,164],[53,337],[589,329]]){g.line(x,y,x,y-8,'#567447',2);g.ellipse(x-4,y-11,8,7,'#ead49a');g.rect(x-1,y-9,2,2,'#b98b53');}
 return g;
}
function itemIcon(id){
 const g=new Grid(32,32);g.ellipse(4,27,25,3,'#203d382e');
 if(id==='wood'){
  for(const[x,y]of[[7,21],[13,25],[8,14]]){g.line(x,y,x+15,y-10,outline,5);g.line(x+1,y,x+15,y-9,'#af8053',3);g.line(x+2,y,x+15,y-9,'#e3bb77');g.ellipse(x-1,y-1,5,5,'#d9b178');g.dot(x+1,y+1,'#8b6043');}g.line(16,18,15,12,'#b28b5c',2);
 }else if(id==='ore'){
  g.poly([[3,24],[7,12],[15,7],[25,12],[29,25],[20,29]],outline);g.poly([[5,23],[9,13],[15,9],[23,13],[20,21]],'#a6bbc0');g.poly([[20,21],[23,13],[27,24],[20,27],[6,25]],'#657e8e');g.line(10,14,16,12,'#e4e2c6',2);g.line(13,24,17,18,'#bed6d0',2);
 }else if(id==='turnip_soup'){
  g.ellipse(3,13,27,17,outline);g.ellipse(4,13,25,14,'#628d90');g.ellipse(4,10,25,12,'#e1ddbb');g.ellipse(6,12,21,7,'#ce9c58');g.ellipse(9,13,6,4,'#f6e8bc');g.ellipse(19,12,5,4,'#ede0aa');g.line(15,16,19,14,'#70935a',2);g.line(6,23,13,25,'#a7cbc1',2);g.line(27,14,30,5,'#a57f50',2);
 }else if(id==='wheat_bread'){
  g.poly([[3,21],[6,12],[12,8],[23,9],[29,16],[27,25],[22,28],[7,27]],outline);g.ellipse(4,9,25,18,'#b98342');g.ellipse(5,8,22,15,'#e0b66b');g.ellipse(8,9,14,5,'#f3d895');for(const x of[10,17,23])g.line(x,12,x-3,17,'#98693b',2);g.line(7,24,21,25,'#eed093');
 }else if(id==='gold'){
  for(const[x,y]of[[3,19],[11,22],[17,16]]){g.ellipse(x,y,13,9,'#8e7147');g.ellipse(x,y-1,13,7,'#e6bc64');g.ellipse(x+2,y,9,4,'#f8d98d');g.line(x+5,y,x+5,y+2,'#b28c4d');}
 }else if(id.endsWith('_seed')){
  g.poly([[9,5],[22,5],[20,11],[26,24],[23,29],[7,29],[4,24],[11,11]],outline);g.poly([[10,6],[21,6],[18,12],[24,23],[22,27],[8,27],[6,23],[13,12]],'#d1b783');g.rect(10,10,11,3,'#8a7951');g.borderedRect(9,17,13,7,'#f0e1b5','#ae9161');g.line(15,23,15,18,'#6b8c51',2);g.line(15,20,12,18,'#9db577',2);
 }else if(id==='turnip'){
  g.ellipse(7,13,19,14,outline);g.ellipse(8,13,17,12,'#e5d9b2');g.ellipse(9,14,10,7,'#fff0c7');g.line(16,25,14,29,'#d9c69b',2);g.poly([[15,16],[6,8],[8,3],[16,10],[22,2],[27,8],[19,16]],'#50794d');g.line(15,14,12,6,'#accb7f',2);g.line(17,12,23,5,'#85a866',2);
 }else{for(const x of[11,18,24]){g.line(x-3,28,x,7,'#ab9153',2);for(const y of[10,16,22]){g.poly([[x,y+2],[x-5,y-1],[x-4,y-5],[x,y-2]],'#cfad62');g.poly([[x,y],[x+5,y-4],[x+4,y-7],[x,y-3]],'#efd48c');}}g.line(9,25,23,26,'#a37e48',2);}
 return g;
}
function landmark(id){
 const g=new Grid(64,64);g.ellipse(5,48,54,12,'#203d3838');
 if(id==='wood'){
  g.poly([[5,48],[11,38],[49,37],[58,49],[53,56],[11,56]],'#a69c74');
  for(const[x,y,dx]of[[13,44,29],[17,49,29],[17,36,27],[26,42,19]]){g.line(x,y,x+dx,y-13,outline,5);g.line(x+1,y,x+dx,y-12,'#ab7b51',3);g.line(x+2,y,x+dx,y-12,'#dab57a');g.ellipse(x-1,y-1,5,5,'#e0bd87');g.dot(x+1,y+1,'#936a47');}g.line(32,30,26,20,'#99724f',3);g.line(36,32,43,20,'#99724f',3);g.poly([[43,21],[44,15],[51,15],[48,20]],'#6c9560');
 }else if(id==='ore'){
  g.poly([[5,51],[11,36],[27,29],[47,36],[58,50],[50,57],[13,57]],'#9b9f86');
  for(const[x,y,w]of[[10,40,17],[25,29,24],[39,43,17]]){g.poly([[x,y+12],[x+3,y],[x+w-7,y-4],[x+w,y+5],[x+w-2,y+14]],outline);g.poly([[x+2,y+10],[x+5,y+1],[x+w-8,y-2],[x+w-3,y+5],[x+w-9,y+11]],'#aabec0');g.poly([[x+w-9,y+11],[x+w-3,y+5],[x+w-1,y+12]],'#647f8b');g.line(x+6,y+3,x+w-8,y+1,'#e2e1c8',2);}
 }else if(id==='kitchen'){
  g.borderedRect(7,33,50,21,'#9d805c');g.rect(9,35,46,4,'#d1b283');g.rect(10,49,6,9,'#6b5744');g.rect(49,49,6,9,'#6b5744');g.borderedRect(5,29,54,8,'#d9bd8b');g.rect(7,30,49,2,'#efdab0');
  g.borderedRect(11,17,25,15,'#6f8587');g.ellipse(9,13,29,13,outline);g.ellipse(11,14,25,9,'#b8cbc3');g.ellipse(14,16,19,5,'#8e9a88');g.rect(8,21,4,4,'#526e72');g.rect(36,21,4,4,'#526e72');g.line(29,19,35,7,'#bd996b',2);
  g.borderedRect(42,22,12,8,'#c5ab77');g.ellipse(43,19,10,8,'#d1a766');g.line(46,20,46,24,'#916c42');g.rect(13,39,37,1,'#7f684c');
 }else{
  g.borderedRect(8,18,47,39,'#9b7b56');g.rect(10,20,8,34,'#c7a77a');g.rect(48,20,5,34,'#725d47');g.borderedRect(14,24,34,13,'#655c4a');g.rect(13,38,36,4,'#d8ba85');g.rect(13,52,36,3,'#d8ba85');
  for(const[x,y,c]of[[17,26,'#d7b57d'],[30,26,'#aab9af'],[18,43,'#bd9560'],[35,44,'#d5c18c']]){g.borderedRect(x,y,9,9,c);g.rect(x+2,y+2,5,2,'#e9d8aa');}
  g.poly([[4,18],[10,8],[52,8],[60,18],[58,22],[5,22]],outline);g.rect(7,17,50,4,'#82624e');for(let x=8;x<56;x+=12)g.poly([[x,10],[x+9,10],[x+12,18],[x-2,18]],'#b88961');g.line(11,10,51,10,'#e3bc81',2);
 }
 return g;
}
function discovery(id,resolved=false,i=0){
 const g=new Grid(48,48);g.ellipse(5,36,39,8,'#203d3838');
 if(id==='supply_cache'){
  g.borderedRect(8,24,32,17,'#9c724f');g.rect(10,27,28,3,'#c8a16c');g.rect(11,36,26,2,'#775b43');g.rect(13,25,3,15,'#637a70');g.rect(33,25,3,15,'#637a70');
  if(resolved){g.borderedRect(9,11,31,13,'#b69460');g.rect(11,13,27,8,'#5a5b47');g.ellipse(12,23,25,7,'#514e3b');g.rect(17,23,5,4,'#dfbf7c');g.poly([[27,22],[32,23],[32,27],[25,27]],'#aabcb4');}
  else {g.poly([[8,24],[11,16],[35,16],[40,24]],outline);g.poly([[10,23],[13,18],[34,18],[37,23]],'#c3a06d');g.rect(13,18,3,7,'#7b8974');g.rect(33,18,3,7,'#7b8974');g.borderedRect(21,25,7,8,'#d6be7c');g.dot(24,29,'#705d40');}
 }else if(id==='wild_garden'){
  g.ellipse(5,31,38,11,'#608053');g.ellipse(9,29,30,8,'#8a9e62');
  for(const[x,y]of[[14,29],[29,32],[23,21]]){g.ellipse(x-4,y,8,9,'#eee0b9');g.line(x,y+7,x-2,y+10,'#bcaa7c');g.poly([[x,y+3],[x-8,y-4],[x-5,y-8],[x,y-3],[x+5,y-10],[x+8,y-6]],'#4e754e');g.line(x,y+2,x+5,y-7,'#b0c77a',2);}
  g.line(7,33,5,26,'#769957');g.line(38,35,42,29,'#b5bd78',2);
 }else{
  g.ellipse(3,27,42,16,'#5e776a');g.ellipse(5,26,38,14,'#a5b59e');g.ellipse(8,27,32,10,'#578b94');g.ellipse(11,28,25,7,'#90c8c1');g.line(14,29,29,29,'#d3e9d1',2);
  g.poly([[28,28],[29,12],[35,8],[41,15],[41,30]],outline);g.poly([[30,27],[31,14],[35,11],[39,16],[39,28]],'#94aca2');g.line(32,15,35,13,'#d5d6b8',2);g.rect(30,21,6,4,'#4b776e');g.line(32,24,29,29,'#b5dfd2',2);g.ellipse(5,23,8,5,'#8b9e84');
 }
 if(resolved&&i>0){const y=12-i*2;g.line(9,y-2,9,y+2,'#eee0a4');g.line(7,y,11,y,'#eee0a4');if(i===2){g.line(40,y+6,40,y+10,'#f3e8b6');g.line(38,y+8,42,y+8,'#f3e8b6');}}
 return g;
}
function recipe(name,frames,w=48,h=48){
 const palette={},index=new Map();
 for(const f of frames)for(const row of f.g.p)for(const c of row)if(c&&!index.has(c)){
   if(index.size>=symbols.length)throw Error(`Too many palette colours ${name}`);
   const key=symbols[index.size];index.set(c,key);palette[key]=c;
 }
 const animations={};
 for(const f of frames){const a=f.action||f.name;(animations[a]??={frames:[],loop:!['attack','hurt','till','plant','water','harvest','craft','repair','upgrade','cook','eat','resolved'].includes(a)}).frames.push(f.name);}
 const sourceFrames=frames.map(f=>{
   const ops=[];
   // A still may exceed 256px, but each editable Pixelbolt grid is at most 256².
   for(let y=0;y<h;y+=256)for(let x=0;x<w;x+=256)ops.push({op:'grid',x,y,rows:f.g.p.slice(y,y+256).map(row=>row.slice(x,x+256).map(c=>c?index.get(c):'.').join(''))});
   return {name:f.name,duration:f.duration||200,anchor:[w/2,h===48?43:h],ops};
 });
 return {version:1,name,width:w,height:h,palette,frames:sourceFrames,animations,sheet:{columns:Math.min(8,frames.length),padding:0}};
}
const manifest={version:1,release:'0.17.1',tool:{name:'Pixelbolt',version:'0.10.0',commit:PIN},tile_size:32,map:{width:24,height:16},scene:{image:'/pixel-world/scene.png',width:768,height:512},scenes:{plaza:{image:'/pixel-world/scene_plaza.png',width:768,height:512},adventure:{image:'/pixel-world/scene_adventure.png',width:768,height:512}},props:{},farm_scene:{image:'/pixel-world/farm_scene.png',width:640,height:400},characters:{},monsters:{},crops:{},equipment:{},accessories:{},tools:{},tool_icons:{},items:{},landmarks:{},discoveries:{},effects:{},placements:{campfire:{x:11,y:8}}};
function cli(args){return JSON.parse(execFileSync(process.execPath,[CLI,...args],{encoding:'utf8',maxBuffer:16*1024*1024}));}
function exportRecipe(r,group,id=r.name){
 const path=join(SOURCE,`${r.name}.pixel.json`);
 writeFileSync(path,JSON.stringify(r,null,2)+'\n');
 if(only&&only!==r.name)return;
 const checked=cli(['validate',path]);
 const run=join(REVIEW,`${r.name}-${Date.now()}`);
 // Pixelbolt's expect.frames means frames per animation, not sheet frame count.
 // Our short hurt and longer idle sequences intentionally have different sizes.
 const result=cli(['render',path,'--out',run,'--expect',JSON.stringify({width:r.width,height:r.height})]);
 if(!result.check?.ok)throw Error(`Pixelbolt export failed ${id}: ${JSON.stringify(result.check)}`);
 const atlas=JSON.parse(readFileSync(join(run,`${r.name}.atlas.json`),'utf8'));
 if(Object.keys(atlas.frames).length!==r.frames.length)throw Error(`Incomplete atlas: ${id}`);
 const animations={};
 for(const[name,a]of Object.entries(r.animations))animations[name]={loop:a.loop??true,frames:a.frames.map(n=>{
   const f=atlas.frames[n];
   if(!f||f.frame.w!==r.width||f.frame.h!==r.height)throw Error(`Invalid frame ${id}/${n}`);
   return {...f.frame,duration:f.duration??r.frames.find(frame=>frame.name===n).duration};
 })};
 // Deterministic rebuilds keep identical published images untouched.
 publish(join(PUBLIC,`${id}.png`),readFileSync(join(run,`${r.name}.png`)));
 // Renamed public assets must remain usable from their atlas outside this UI.
 atlas.meta.image=`${id}.png`;
 publish(join(PUBLIC,`${id}.atlas.json`),JSON.stringify(atlas,null,2)+'\n');
 if(group)manifest[group][id]={image:`/pixel-world/${id}.png`,width:r.width,height:r.height,sheet_width:atlas.meta.size.w,sheet_height:atlas.meta.size.h,anchor:{x:r.width/2,y:r.height===48?43:r.height},animations};
 if(inspect&&r.width<=256)cli(['inspect',path,'--out',join(REVIEW,`${id}-contact.png`),'--native','--diagnostics','--force']);
 writeFileSync(join(REVIEW,`${id}-validation.json`),JSON.stringify({validation:checked,render:result},null,2));
 console.log(`${id}: ${r.width}x${r.height}, ${r.frames.length} frames`);
}
for(let i=0;i<8;i++)exportRecipe(recipe(`wanderer_${i+1}`,poses.map(p=>({...p,g:character(specs[i],p.action,p.frame)}))),'characters');
for(const id of ['forest_slime','forest_boar','ruins_guardian'])exportRecipe(recipe(id,poses.filter(p=>['idle','walk','attack','hurt'].includes(p.action)).map(p=>({...p,g:monster(id,p.action,p.frame)}))),'monsters');
for(const id of ['wooden_sword','iron_sword','wooden_shield','iron_armor','hunter_bow','heavy_hammer','heavy_armor'])exportRecipe(recipe(id,poses.map(p=>({...p,g:overlay(id,p.action,p.frame)}))),'equipment');
for(const id of ['supply_cache','wild_garden','spring'])exportRecipe(recipe(`discovery_${id}`,[{name:'idle',action:'idle',duration:1000,g:discovery(id)},...Array.from({length:4},(_,i)=>({name:`resolved_${i}`,action:'resolved',duration:300,g:discovery(id,true,i)}))]),'discoveries',id);
for(const id of ['leaf','scarf','ribbon','star'])exportRecipe(recipe(id,poses.map(p=>({...p,g:overlay(id,p.action,p.frame)}))),'accessories');
for(const id of ['turnip','wheat'])exportRecipe(recipe(id,['untilled','tilled','empty','seeded','growing','ready'].map(stage=>({name:stage,action:stage,duration:1000,g:crop(id,stage)})),32,32),'crops');
for(const id of ['wood','ore','turnip','wheat','turnip_seed','wheat_seed','turnip_soup','wheat_bread','gold'])exportRecipe(recipe(`item_${id}`,[{name:'idle',action:'idle',duration:1000,g:itemIcon(id)}],32,32),'items',`item_${id}`);
for(const id of ['wood','ore','kitchen','supply'])exportRecipe(recipe(`landmark_${id}`,[{name:'idle',action:'idle',duration:1000,g:landmark(id)}],64,64),'landmarks',id);
for(const id of ['hoe','watering_can'])for(const level of [1,2,3]){
 exportRecipe(recipe(`${id}_${level}`,poses.map(p=>({...p,g:toolOverlay(id,level,p.action,p.frame)}))),'tools');
 exportRecipe(recipe(`${id}_${level}_icon`,[{name:'idle',action:'idle',duration:1000,g:toolIcon(id,level)}],32,32),'tool_icons');
}
exportRecipe(recipe('scene',[{name:'world',action:'idle',g:sceneGround(Grid,'plaza')}],768,512),null,'scene');
for(const scene of SCENES)exportRecipe(recipe(`scene_${scene.id}`,[{name:'world',action:'idle',g:sceneGround(Grid,scene.id)}],768,512),null);
for(const kind of new Set(SCENES.flatMap(scene=>scene.props.map(prop=>prop.kind)).filter(kind=>kind!=='pond'))){
 const source=recipe(`prop_${kind}`,[{name:'idle',action:'idle',g:sceneProp(Grid,kind)}],128,128);source.frames[0].anchor=[64,120];
 exportRecipe(source,'props',kind);
 if(manifest.props[kind])manifest.props[kind].anchor={x:64,y:120};
}
exportRecipe(recipe('farm_scene',[{name:'farm',action:'idle',g:farmScene()}],640,400),null,'farm_scene');
if(!only||only==='campfire'){
 const source=JSON.parse(readFileSync(join(TOOL,'examples/campfire.fluid.json'),'utf8'));source.name='campfire';writeFileSync(join(SOURCE,'campfire.fluid.json'),JSON.stringify(source,null,2)+'\n');
 const compiled=join(REVIEW,`campfire-${Date.now()}.pixel.json`);cli(['compile',join(SOURCE,'campfire.fluid.json'),'--out',compiled]);exportRecipe(JSON.parse(readFileSync(compiled,'utf8')),'effects','campfire');
 // Public app uses the common idle key for an environmental loop.
 manifest.effects.campfire.animations.idle=Object.values(manifest.effects.campfire.animations)[0];
}
if(!only){publish(join(PUBLIC,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(SOURCE,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');}
