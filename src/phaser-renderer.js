import Phaser from 'phaser';
import {WORLD_MAP} from '../shared/world-layout.js';
import {wildernessGround,pondGeometry} from './wilderness-art.js';

// Retained Phaser objects: React sends confirmed geometry/atlas frames. No DOM
// measurements in the render loop and no independent copy of world simulation.
export function createWorldRenderer({parent,assets,registry,sceneId,phase='day',lights=[],onReady,onPartial,onError}) {
  let game,disposed=false,scene,dirty=true,ready=false,scheduled,daylight,lightTexture;
  const images=new Map(),definitions=new Map();
  function visit(value){if(!value||typeof value!=='object')return;if(value.image)definitions.set(value.image,value);for(const child of Object.values(value))visit(child);}
  visit(assets);
  const key=image=>`world:${image}`;
  const fail=()=>{if(!disposed){onError();destroy();}};
  function redrawLighting(){
    if(disposed||!lightTexture)return;const g=lightTexture.getContext(),w=WORLD_MAP.width*32,h=WORLD_MAP.height*32;
    g.clearRect(0,0,w,h);g.globalCompositeOperation='source-over';g.fillStyle={day:'rgba(0,0,0,0)',dusk:'rgba(135,92,64,.16)',night:'rgba(18,31,47,.48)',dawn:'rgba(173,157,139,.1)'}[phase]||'transparent';g.fillRect(0,0,w,h);
    if(phase==='night'){
      g.globalCompositeOperation='destination-out';for(const l of lights){const glow=g.createRadialGradient(l.x,l.y,0,l.x,l.y,l.radius);glow.addColorStop(0,'rgba(0,0,0,1)');glow.addColorStop(.7,'rgba(0,0,0,.8)');glow.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=glow;g.beginPath();g.arc(l.x,l.y,l.radius,0,Math.PI*2);g.fill();}
      g.globalCompositeOperation='source-over';g.strokeStyle='rgba(233,196,126,.55)';g.lineWidth=1.5;for(const l of lights){g.beginPath();g.arc(l.x,l.y,l.radius,0,Math.PI*2);g.stroke();}
    }
    lightTexture.refresh();invalidate();
  }
  function setPhase(next){phase=next;redrawLighting();}
  function setLighting(next){lights=next;redrawLighting();}
  function terrain(){
    const data=wildernessGround(sceneId),g=scene.add.graphics().setDepth(-90);
    g.fillStyle(0xd6ccae,.34).fillRect(0,0,WORLD_MAP.width*32,WORLD_MAP.height*32);
    g.fillStyle(sceneId==='plaza'?0xd9c5a2:0xa8aa8c,.5).fillEllipse(data.camp.x,data.camp.y,174,120);
    for(const[width,color,alpha]of[[31,0x736749,.18],[24,0xd0bd97,.52],[2,0x817552,.2]])for(const path of data.trails){g.lineStyle(width,color,alpha);g.beginPath();g.moveTo(path[0].x,path[0].y);for(const p of path.slice(1))g.lineTo(p.x,p.y);g.strokePath();}
    const pond=pondGeometry(data.pond);
    if(pond){
      g.fillStyle(0x817f62,.85).fillPoints(pond.bank,true);g.lineStyle(2,0x535d4e,.7).strokePoints(pond.bank,true);
      g.fillStyle(0x7b9790,1).fillPoints(pond.water,true);g.lineStyle(2,0xabb6a2,.75).strokePoints(pond.water,true);
      g.lineStyle(1.4,0xd1d5bc,.65);for(const line of pond.ripples){g.beginPath();g.moveTo(line[0].x,line[0].y);g.lineTo(line[1].x,line[1].y);g.strokePath();}
      g.lineStyle(1.4,0x4c5a3e,.9);for(const p of pond.reeds){for(const dx of[-3,0,4]){g.beginPath();g.moveTo(p.x,p.y);g.lineTo(p.x+dx,p.y-6-Math.abs(dx));g.strokePath();}}
    }
    lightTexture=scene.textures.createCanvas('authoritative-night-lighting',WORLD_MAP.width*32,WORLD_MAP.height*32);daylight=scene.add.image(0,0,'authoritative-night-lighting').setOrigin(0,0).setDepth(10000);redrawLighting();
  }
  function draw(){
    if(disposed||!scene||!dirty)return;
    dirty=false;
    for(const[id,sprite]of images)if(!registry.entries.has(id)){sprite.destroy();images.delete(id);}
    for(const[id,packet]of registry.entries){
      const textureKey=key(packet.definition.image);
      if(!scene.textures.exists(textureKey))continue;
      const texture=scene.textures.get(textureKey),frame=packet.frame;
      const frameKey=`${frame.x||0},${frame.y||0},${frame.w},${frame.h}`;
      if(!texture.has(frameKey))texture.add(frameKey,0,frame.x||0,frame.y||0,frame.w,frame.h);
      let sprite=images.get(id);
      if(!sprite){sprite=scene.add.image(0,0,textureKey,frameKey);images.set(id,sprite);}
      sprite.setTexture(textureKey,frameKey).setOrigin(packet.anchor[0]/frame.w,packet.anchor[1]/frame.h).setPosition(packet.x,packet.y).setScale(packet.scale).setDepth(packet.depth).setAlpha(packet.alpha).setFlipX(packet.flip);
      sprite.setData({packet_id:id,action:packet.action,source:packet.definition.image});
    }
    parent.dataset.renderedObjects=String(images.size);
    parent.dataset.registeredObjects=String(registry.entries.size);
    parent.dataset.textureCount=String(scene.textures.getTextureKeys().length);
  }
  function invalidate(){dirty=true;if(disposed||!ready||document.hidden)return;if(!scheduled)scheduled=requestAnimationFrame(()=>{scheduled=null;if(disposed)return;game.loop.wake();});}
  const visibility=()=>{if(document.hidden){game?.loop.sleep();if(scheduled)cancelAnimationFrame(scheduled);scheduled=null;}else invalidate();};
  function destroy(){if(disposed)return;disposed=true;cancelAnimationFrame(scheduled);document.removeEventListener('visibilitychange',visibility);if(game){game.destroy(true,false);if(game.loop.started)game.loop.wake();}images.clear();}
  try {
    game=new Phaser.Game({type:Phaser.AUTO,parent,width:WORLD_MAP.width*32,height:WORLD_MAP.height*32,transparent:true,pixelArt:true,antialias:false,roundPixels:false,banner:false,loader:{imageLoadType:'HTMLImageElement'},audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},render:{preserveDrawingBuffer:true},fps:{target:30},scene:{
      preload(){scene=this;this.load.on('loaderror',file=>{if(file.key===key(assets.scenes?.[sceneId]?.image))fail();else onPartial();});for(const image of definitions.keys())this.load.image(key(image),image);},
      create(){if(disposed)return;if(!this.textures.exists(key(assets.scenes?.[sceneId]?.image))){fail();return;}if(this.textures.getTextureKeys().length<definitions.size)onPartial();terrain();ready=true;this.game.canvas.setAttribute('data-testid','phaser-canvas');this.game.canvas.setAttribute('aria-hidden','true');this.game.canvas.addEventListener('webglcontextlost',fail);draw();this.game.events.once('postrender',()=>{if(!disposed)onReady();});},
      update(){draw();if(!dirty)this.game.events.once('postrender',()=>{if(!disposed)this.game.loop.sleep();});}
    }});
    document.addEventListener('visibilitychange',visibility);
  }catch{fail();}
  return{invalidate,destroy,setPhase,setLighting};
}
