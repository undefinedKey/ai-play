import Phaser from 'phaser';
import {WORLD_MAP} from '../shared/world-layout.js';
import {terrainDrawing} from './wilderness-art.js';
import {rendererSampling,rendererResolution,isSoftwareRenderer,requiredSpriteImages,sameRenderPacket} from './render-packet.js';
import {stableTextureSampler} from './texture-sampling.js';

// Public render-node extension, scoped to this game's images. No engine patch,
// single-texture fallback, or per-sprite flush: transformed atlases still batch.
class WorldQuadBatch extends Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad {
  constructor(manager){super(manager,{name:'WorldQuadBatch'});}
  finalizeTextureCount(count){
    super.finalizeTextureCount(count);
    const source=this.programManager.getAdditionsByTag('TEXTURE')[0];
    if(source)this.programManager.replaceAddition(source.name,stableTextureSampler(this.renderOptions.lighting?1:count));
  }
}

// Retained Phaser objects: React sends confirmed geometry/atlas frames. No DOM
// measurements in the render loop and no independent copy of world simulation.
export function createWorldRenderer({parent,assets,registry,sceneId,phase='day',lights=[],onReady,onPartial,onError}) {
  let game,disposed=false,scene,dirty=true,ready=false,scheduled,daylight,lightTexture,terrainGraphics,idleFrames=0,appliedPackets=0;
  let softwareRendering=false,resolution=rendererResolution(assets,window.innerWidth);
  const logicalWidth=WORLD_MAP.width*32,logicalHeight=WORLD_MAP.height*32;
  const images=new Map(),pendingTextures=new Set(),failedTextures=new Set();
  const key=image=>`world:${image}`;
  const fail=()=>{if(!disposed){onError();destroy();}};
  function detectBackend(){
    const gl=scene?.sys?.game?.renderer?.gl;
    if(!gl)return;
    let description='';
    try{const info=gl.getExtension('WEBGL_debug_renderer_info');description=gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER);}catch{
      try{description=gl.getParameter(gl.RENDERER);}catch{/* unavailable means unknown */}
    }
    // Keep the device string local: DOM diagnostics expose only the policy.
    softwareRendering=isSoftwareRenderer(description);
  }
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
    for(const[id,entry]of images)if(!registry.entries.has(id)){entry.root.destroy();images.delete(id);}
    for(const[id,packet]of registry.entries){
      const textureKey=key(packet.frame.image||packet.definition.image);
      let entry=images.get(id);
      if(!scene.textures.exists(textureKey)||(packet.attachmentImage&&!scene.textures.exists(key(packet.attachmentImage)))){
        // Late arrivals keep the last complete body/tool pose while its next
        // source sheet loads. Translate it by the confirmed foot displacement,
        // never by the new (unavailable) frame's hand or padding coordinates.
        if(entry?.packet){const prior=entry.packet;entry.root.setPosition((prior.x+packet.originX-prior.originX)*resolution,(prior.y+packet.originY-prior.originY)*resolution);entry.sprite.setScale(prior.scale*resolution);entry.pending=true;}
        continue;
      }
      // Static scenery retains its texture and transform while actors animate.
      // A resize still reapplies every object's drawing-buffer coordinates.
      if(entry&&!entry.pending&&entry.resolution===resolution&&sameRenderPacket(entry.packet,packet))continue;
      const texture=scene.textures.get(textureKey),frame=packet.frame;
      const frameKey=`${frame.x||0},${frame.y||0},${frame.w},${frame.h}`;
      if(!texture.has(frameKey))texture.add(frameKey,0,frame.x||0,frame.y||0,frame.w,frame.h);
      if(!entry){const sprite=scene.add.image(0,0,textureKey,frameKey).setRenderNodeRole('BatchHandler','WorldQuadBatch'),root=scene.add.container(0,0,[sprite]);entry={root,sprite};images.set(id,entry);}
      const {root,sprite}=entry;
      // Separate the shared body pose from an item's own rotation. Flattening
      // these would skew or detach tools during nonuniform squash/recoil.
      root.setVisible(true).setPosition(packet.x*resolution,packet.y*resolution).setScale(packet.poseScaleX??1,packet.poseScaleY??1).setRotation(packet.poseRotation||0).setDepth(packet.depth);
      sprite.setTexture(textureKey,frameKey).setOrigin(packet.anchor[0]/frame.w,packet.anchor[1]/frame.h).setScale(packet.scale*resolution).setAlpha(packet.alpha).setFlipX(packet.flip).setRotation(packet.rotation||0);
      sprite.setData({packet_id:id,action:packet.action,source:packet.frame.image||packet.definition.image});
      entry.packet=packet;entry.resolution=resolution;entry.pending=false;appliedPackets++;
    }
    parent.dataset.renderedObjects=String(images.size);
    parent.dataset.registeredObjects=String(registry.entries.size);
    parent.dataset.textureCount=String(scene.textures.getTextureKeys().length);
    parent.dataset.appliedPackets=String(appliedPackets);
  }
  function invalidate(){dirty=true;idleFrames=0;if(disposed||!ready||document.hidden||game.loop.running)return;if(!scheduled)scheduled=requestAnimationFrame(()=>{scheduled=null;if(disposed||document.hidden)return;game.loop.wake();});}
  const visibility=()=>{if(document.hidden){game?.loop.sleep();if(scheduled)cancelAnimationFrame(scheduled);scheduled=null;}else invalidate();};
  function resizeDrawingBuffer(){
    if(disposed||!ready)return;
    const next=rendererResolution(assets,window.innerWidth,softwareRendering);
    if(next!==resolution){resolution=next;game.scale.resize(logicalWidth*resolution,logicalHeight*resolution);terrainGraphics?.setScale(resolution);daylight?.setScale(resolution);invalidate();}
    const renderBackend=softwareRendering?'software':'hardware-or-unknown';
    Object.assign(game.canvas.dataset,{renderResolution:String(resolution),renderBackend,logicalWidth:String(logicalWidth),logicalHeight:String(logicalHeight)});
    Object.assign(parent.dataset,{renderResolution:String(resolution),renderBackend});
  }
  function destroy(){if(disposed)return;disposed=true;cancelAnimationFrame(scheduled);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resizeDrawingBuffer);if(game){game.destroy(true,false);if(game.loop.started)game.loop.wake();}images.clear();}
  try {
    game=new Phaser.Game({type:Phaser.AUTO,parent,width:logicalWidth*resolution,height:logicalHeight*resolution,transparent:true,...rendererSampling(assets),banner:false,loader:{imageLoadType:'HTMLImageElement'},audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},render:{preserveDrawingBuffer:true,renderNodes:{WorldQuadBatch}},fps:{target:60},scene:{
      preload(){scene=this;this.load.on('loaderror',file=>{pendingTextures.delete(file.key);failedTextures.add(file.key);if(file.key===key(assets.scenes?.[sceneId]?.image))fail();else if(!disposed)onPartial();});this.load.on('filecomplete',textureKey=>{pendingTextures.delete(textureKey);invalidate();});this.load.on('complete',()=>invalidate());requestTextures();},
      create(){if(disposed)return;if(!this.textures.exists(key(assets.scenes?.[sceneId]?.image))){fail();return;}detectBackend();terrain();ready=true;resizeDrawingBuffer();this.game.canvas.setAttribute('data-testid','phaser-canvas');this.game.canvas.setAttribute('aria-hidden','true');this.game.canvas.addEventListener('webglcontextlost',fail);draw();this.game.events.once('postrender',()=>{if(!disposed)onReady();});},
      update(){if(dirty){idleFrames=0;draw();}else idleFrames++;if(idleFrames>=2)this.game.events.once('postrender',()=>{if(!disposed&&!dirty)this.game.loop.sleep();});}
    }});
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('resize',resizeDrawingBuffer);
  }catch{fail();}
  return{invalidate,destroy,setPhase,setLighting};
}
