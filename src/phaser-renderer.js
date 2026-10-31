import Phaser from 'phaser';
import {WORLD_MAP} from '../shared/world-layout.js';
import {terrainDrawing} from './wilderness-art.js';
import {rendererSampling,rendererResolution,requiredSpriteImages} from './render-packet.js';

// Retained Phaser objects: React sends confirmed geometry/atlas frames. No DOM
// measurements in the render loop and no independent copy of world simulation.
export function createWorldRenderer({parent,assets,registry,sceneId,phase='day',lights=[],onReady,onPartial,onError}) {
  let game,disposed=false,scene,dirty=true,ready=false,scheduled,daylight,lightTexture,terrainGraphics;
  let resolution=rendererResolution(assets,window.innerWidth);
  const logicalWidth=WORLD_MAP.width*32,logicalHeight=WORLD_MAP.height*32;
  const images=new Map(),pendingTextures=new Set(),failedTextures=new Set();
  const key=image=>`world:${image}`;
  const fail=()=>{if(!disposed){onError();destroy();}};
  function requestTextures(start=false){
    if(disposed||!scene)return;
    let added=false;
    for(const image of requiredSpriteImages(assets,sceneId,registry.entries.values())){
      const textureKey=key(image);
      if(scene.textures.exists(textureKey)||pendingTextures.has(textureKey)||failedTextures.has(textureKey))continue;
      pendingTextures.add(textureKey);scene.load.image(textureKey,image);added=true;
    }
    if(start&&added&&!scene.load.isLoading())scene.load.start();
  }
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
    const data=terrainDrawing(sceneId,assets.render_style==='ink'),g=scene.add.graphics().setDepth(-90).setScale(resolution),color=value=>parseInt(value.slice(1),16);terrainGraphics=g;
    if(assets.scenes?.[sceneId]?.terrain_overlay!==false){
      g.fillStyle(color(data.wash[0]),data.wash[1]).fillRect(0,0,logicalWidth,logicalHeight);
      for(const paint of data.fills)g.fillStyle(color(paint.color),paint.alpha).fillPoints(paint.points,true);
      for(const line of data.strokes){g.lineStyle(line.width,color(line.color),line.alpha);g.beginPath();g.moveTo(line.points[0].x,line.points[0].y);for(const point of line.points.slice(1))g.lineTo(point.x,point.y);g.strokePath();}
    }
    lightTexture=scene.textures.createCanvas('authoritative-night-lighting',logicalWidth,logicalHeight);daylight=scene.add.image(0,0,'authoritative-night-lighting').setOrigin(0,0).setDepth(10000).setScale(resolution);redrawLighting();
  }
  function draw(){
    if(disposed||!scene||!dirty)return;
    dirty=false;
    requestTextures(true);
    for(const[id,sprite]of images)if(!registry.entries.has(id)){sprite.destroy();images.delete(id);}
    for(const[id,packet]of registry.entries){
      const textureKey=key(packet.frame.image||packet.definition.image);
      if(!scene.textures.exists(textureKey)){images.get(id)?.setVisible(false);continue;}
      const texture=scene.textures.get(textureKey),frame=packet.frame;
      const frameKey=`${frame.x||0},${frame.y||0},${frame.w},${frame.h}`;
      if(!texture.has(frameKey))texture.add(frameKey,0,frame.x||0,frame.y||0,frame.w,frame.h);
      let sprite=images.get(id);
      if(!sprite){sprite=scene.add.image(0,0,textureKey,frameKey);images.set(id,sprite);}
      sprite.setVisible(true).setTexture(textureKey,frameKey).setOrigin(packet.anchor[0]/frame.w,packet.anchor[1]/frame.h).setPosition(packet.x*resolution,packet.y*resolution).setScale(packet.scale*resolution).setDepth(packet.depth).setAlpha(packet.alpha).setFlipX(packet.flip).setRotation(packet.rotation||0);
      sprite.setData({packet_id:id,action:packet.action,source:packet.frame.image||packet.definition.image});
    }
    parent.dataset.renderedObjects=String(images.size);
    parent.dataset.registeredObjects=String(registry.entries.size);
    parent.dataset.textureCount=String(scene.textures.getTextureKeys().length);
  }
  function invalidate(){dirty=true;if(disposed||!ready||document.hidden)return;if(!scheduled)scheduled=requestAnimationFrame(()=>{scheduled=null;if(disposed)return;game.loop.wake();});}
  const visibility=()=>{if(document.hidden){game?.loop.sleep();if(scheduled)cancelAnimationFrame(scheduled);scheduled=null;}else invalidate();};
  function resizeDrawingBuffer(){
    if(disposed||!ready)return;
    const next=rendererResolution(assets,window.innerWidth);
    if(next!==resolution){resolution=next;game.scale.resize(logicalWidth*resolution,logicalHeight*resolution);terrainGraphics?.setScale(resolution);daylight?.setScale(resolution);invalidate();}
    Object.assign(game.canvas.dataset,{renderResolution:String(resolution),logicalWidth:String(logicalWidth),logicalHeight:String(logicalHeight)});
    parent.dataset.renderResolution=String(resolution);
  }
  function destroy(){if(disposed)return;disposed=true;cancelAnimationFrame(scheduled);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resizeDrawingBuffer);if(game){game.destroy(true,false);if(game.loop.started)game.loop.wake();}images.clear();}
  try {
    game=new Phaser.Game({type:Phaser.AUTO,parent,width:logicalWidth*resolution,height:logicalHeight*resolution,transparent:true,...rendererSampling(assets),banner:false,loader:{imageLoadType:'HTMLImageElement'},audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},render:{preserveDrawingBuffer:true},fps:{target:30},scene:{
      preload(){scene=this;this.load.on('loaderror',file=>{pendingTextures.delete(file.key);failedTextures.add(file.key);if(file.key===key(assets.scenes?.[sceneId]?.image))fail();else if(!disposed)onPartial();});this.load.on('filecomplete',textureKey=>{pendingTextures.delete(textureKey);invalidate();});this.load.on('complete',()=>invalidate());requestTextures();},
      create(){if(disposed)return;if(!this.textures.exists(key(assets.scenes?.[sceneId]?.image))){fail();return;}terrain();ready=true;resizeDrawingBuffer();this.game.canvas.setAttribute('data-testid','phaser-canvas');this.game.canvas.setAttribute('aria-hidden','true');this.game.canvas.addEventListener('webglcontextlost',fail);draw();this.game.events.once('postrender',()=>{if(!disposed)onReady();});},
      update(){draw();if(!dirty)this.game.events.once('postrender',()=>{if(!disposed)this.game.loop.sleep();});}
    }});
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('resize',resizeDrawingBuffer);
  }catch{fail();}
  return{invalidate,destroy,setPhase,setLighting};
}
